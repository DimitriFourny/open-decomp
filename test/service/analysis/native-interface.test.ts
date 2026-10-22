import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createOperationContext,
  type AbiLocation,
  type AbiProfile,
  type AbiType,
  type RegisterDescriptor,
} from '../../../src/core/index.js';
import { darwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { windowsX64Abi } from '../../../src/abi/windows-x64/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { analyzeCalls } from '../../../src/analysis/calls/index.js';
import { recoverTypes } from '../../../src/analysis/types/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { simplifySSA } from '../../../src/analysis/values/index.js';
import { floating, integer, vector } from '../../../src/ir/index.js';
import type { SourceEvidence } from '../../../src/reconstruction/source-model.js';
import { X86Lifter } from '../../../src/lifters/x86_64/index.js';
import { Arm64Lifter } from '../../../src/lifters/arm64/index.js';
import {
  nativeVariadicFootprint,
  nativeVariadicInterface,
} from '../../../src/service/analysis/native-variadic.js';
import {
  createNativeInterfaceIndex,
  nativeEntryRegisters,
} from '../../../src/service/analysis/native-entry.js';
import { specializeNativeSSA } from '../../../src/service/analysis/native-context.js';
import {
  inheritGenericResult,
  nativeReturnInterface,
  nativeTypeSlices,
} from '../../../src/service/analysis/native-transfer.js';
import type { NativeInterface } from '../../../src/service/analysis/native-worklist.js';
import { loadFunctionGraph, loadFunctionScope } from '../../../src/service/queries/scope.js';
import { emit, emittedFormals, execute } from '../../emitters/c/support.js';
import { builder, image, register, slice } from '../../ir/support.js';
import { nativeOracleSkip } from '../../support/host-tools.js';
import { compileContextResultFixture } from './native-context-result-fixture.js';
import { project } from './support.js';

const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');
const rsi = register('rsi', 64, 0, 'replace_root', 'x86_64:rsi');
const rdx = register('rdx', 64, 0, 'replace_root', 'x86_64:rdx');
const rax = register('rax', 64, 0, 'replace_root', 'x86_64:rax');
const x0 = register('x0', 64, 0, 'replace_root', 'arm64:x0');
const xmm0 = {
  ...register('xmm0', 128, 0, 'replace_root', 'x86_64:xmm0', 128),
  bank: 'vector' as const,
};

test('prepared native interfaces re-evaluate changing callee input, write and FP carrier contracts', () => {
  const input = builder('native changing interfaces'),
    block = input.block('entry');
  block.readRegister(rdi);
  block.readRegister(rsi);
  block.call(
    { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
    [],
    [],
    { registers: [rax, xmm0], flags: [], memory: 'unknown_read_write' },
  );
  block.readRegister(rax);
  block.readRegister(xmm0);
  block.return();
  const ir = constructSSA(input.finish(block)).value;
  if (ir.form !== 'ssa') throw new TypeError('Expected SSA');
  const call = ir.blocks[0]!.instructions.find((node) => node.kind === 'call')!;
  const context = createOperationContext(),
    index = createNativeInterfaceIndex(ir, sysvAMD64Abi, context);
  const interfaces = new Map<string, NativeInterface>();
  const inputs = () =>
    nativeEntryRegisters(ir, [rdi, rsi], interfaces, [], context, index).map((item) => item.root);
  const returns = () =>
    nativeReturnInterface(ir, sysvAMD64Abi, null, interfaces, context, false, [], false, index);
  assert.deepEqual(inputs(), []);
  assert.deepEqual(returns().returns, []);
  const low = { ...rax, width_bits: 32 };
  interfaces.set(call.id, {
    parameters: [rdi],
    returns: [low],
    return_types: [integer(32)],
    written_result: { registers: [low], types: [integer(32)] },
    parameter_state: 'observed',
    argument_list_complete: false,
  });
  assert.deepEqual(inputs(), [rdi.root]);
  assert.deepEqual(
    returns().returns.map((item) => [item.root, item.width_bits]),
    [[rax.root, 32]],
  );
  interfaces.set(call.id, {
    parameters: [rsi],
    returns: [rax],
    return_types: [integer(64)],
    written_result: { registers: [rax], types: [integer(64)] },
    parameter_state: 'observed',
    argument_list_complete: false,
  });
  assert.deepEqual(inputs(), [rsi.root]);
  assert.deepEqual(
    returns().returns.map((item) => [item.root, item.width_bits]),
    [[rax.root, 64]],
  );
  for (const type of [floating(64), vector(integer(32), 4)]) {
    interfaces.set(call.id, {
      parameters: [],
      returns: [xmm0],
      return_types: [type],
      parameter_state: 'observed',
      argument_list_complete: false,
    });
    const slices = nativeTypeSlices(ir, interfaces, context, index);
    assert.ok(slices.length > 0);
    assert.ok(slices.every(([, slice]) => slice.written && slice.type === type));
  }
  interfaces.clear();
  assert.deepEqual(inputs(), []);
  assert.deepEqual(returns().returns, []);
  assert.deepEqual(nativeTypeSlices(ir, interfaces, context, index), []);
  assert.throws(
    () => nativeEntryRegisters({ ...ir }, [rdi], interfaces, [], context, index),
    TypeError,
  );
  assert.throws(
    () =>
      nativeReturnInterface(
        ir,
        {
          ...sysvAMD64Abi,
          classifyCall: sysvAMD64Abi.classifyCall.bind(sysvAMD64Abi),
        },
        null,
        interfaces,
        context,
        false,
        [],
        false,
        index,
      ),
    TypeError,
  );
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () =>
      nativeEntryRegisters(
        ir,
        [rdi],
        interfaces,
        [],
        createOperationContext({ signal: controller.signal }),
        index,
      ),
    { code: 'cancelled' },
  );
});

test('prepared store ancestry excludes private spills but retains externally stored payloads', () => {
  const input = builder('native store ancestry'),
    block = input.block('entry');
  const sp = {
    ...register('rsp', 64, 0, 'replace_root', 'x86_64:rsp'),
    role: 'stack_pointer' as const,
  };
  block.store(
    block.int('add', block.readRegister(sp), block.constant(integer(64), 8n)),
    block.readRegister(rsi),
  );
  block.store(block.readRegister(rdi), block.readRegister(rdx));
  block.return();
  const ir = constructSSA(input.finish(block)).value;
  if (ir.form !== 'ssa') throw new TypeError('Expected SSA');
  const context = createOperationContext(),
    index = createNativeInterfaceIndex(ir, sysvAMD64Abi, context);
  assert.deepEqual(
    nativeEntryRegisters(ir, [rdi, rsi, rdx], new Map(), [], context, index).map(
      (item) => item.root,
    ),
    [rdi.root, rdx.root],
  );
});

test('secondary aggregate return storage remains demand-specific on the same prepared stage', () => {
  const input = builder('native secondary demand'),
    block = input.block('entry');
  block.writeRegister(rax, block.constant(integer(64), 3n));
  block.writeRegister(rdx, block.constant(integer(64), 7n));
  block.return();
  const ir = constructSSA(input.finish(block)).value;
  if (ir.form !== 'ssa') throw new TypeError('Expected SSA');
  const context = createOperationContext(),
    index = createNativeInterfaceIndex(ir, sysvAMD64Abi, context);
  const query = (demand: readonly (typeof rax)[]) =>
    nativeReturnInterface(
      ir,
      sysvAMD64Abi,
      null,
      new Map(),
      context,
      false,
      demand,
      false,
      index,
    ).returns.map((item) => [item.root, item.width_bits]);
  assert.deepEqual(query([]), [[rax.root, 64]]);
  assert.deepEqual(query([rdx]), [
    [rax.root, 64],
    [rdx.root, 64],
  ]);
  assert.deepEqual(query([]), [[rax.root, 64]]);
});

test(
  'a literal-zero FP exit keeps the callee result root of the whole body in its context',
  { skip: nativeOracleSkip(), timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'native-context-result-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const p = await project(t, await readFile(await compileContextResultFixture(root)));
    const fn = p.functions.find((item) => item.original_name === 'r3_sum');
    assert.ok(fn);
    const scope = { store: p.state.store, context: createOperationContext() };
    const graph = loadFunctionGraph(scope, 2, loadFunctionScope(scope, 2, fn.id));
    const constructed = constructSSA(
      new X86Lifter().lift(graph, sysvAMD64Abi, scope.context).ir,
    ).value;
    if (constructed.form !== 'ssa') throw new TypeError('Expected SSA');
    const baseline = simplifySSA(constructed).value;
    const context = createOperationContext();
    const returns = (ir: typeof baseline, untypedFloatWrites: boolean) =>
      nativeReturnInterface(
        ir,
        sysvAMD64Abi,
        null,
        new Map(),
        context,
        false,
        [],
        false,
        createNativeInterfaceIndex(ir, sysvAMD64Abi, context),
        untypedFloatWrites,
      );
    const summary = (found: Pick<NativeInterface, 'returns' | 'return_types'>) =>
      found.returns.map((register, index) => [
        register.root,
        register.width_bits,
        found.return_types?.[index],
      ]);
    const f64 = [['x86_64:zmm0', 64, floating(64)]];
    // The `count == 0` exit writes xmm0 with a literal zero, which has no IEEE
    // type, so typing each exit on its own cannot classify xmm0 on every exit.
    assert.notDeepEqual(summary(returns(baseline, false)), f64);
    // The whole body: every exit writes xmm0, the loop exit types it f64.
    const generic = returns(baseline, true);
    assert.deepEqual(summary(generic), f64);
    const observed = (bits: bigint, untypedFloatWrites = false): NativeInterface => ({
      ...returns(
        specializeNativeSSA(
          baseline,
          { constants: [{ register: rdi, bits }], aliases: [], type_evidence_scope: 'scope' },
          context,
        ),
        untypedFloatWrites,
      ),
      parameters: [rdi],
      parameter_state: 'observed',
      argument_list_complete: false,
    });
    // Untyped writes alone never make an FP result: some exit must type it.
    assert.deepEqual(summary(observed(0n, true)), [['x86_64:rax', 64, integer(64)]]);
    // Only the xorpd exit survives `count = 0`; alone it claims the rax the
    // `va_list`-like setup writes. The generic root replaces it.
    const zero = observed(0n);
    assert.deepEqual(summary(zero), [['x86_64:rax', 64, integer(64)]]);
    const inherited = inheritGenericResult(zero, generic);
    assert.deepEqual(summary(inherited), f64);
    assert.deepEqual(
      inherited.written_result?.registers.map((register) => register.root),
      ['x86_64:zmm0'],
    );
    // `count = 2` already proves the same root: its own width and type stay.
    const two = observed(2n);
    assert.equal(inheritGenericResult(two, generic), two);
    assert.deepEqual(summary(two), f64);
    // Negatives: an empty generic result adds nothing, an empty context result
    // (a context that writes no result) never acquires one.
    assert.equal(inheritGenericResult(zero, { returns: [], return_types: [] }), zero);
    assert.equal(inheritGenericResult(zero, undefined), zero);
    const empty: NativeInterface = { ...zero, returns: [], return_types: [] };
    assert.equal(inheritGenericResult(empty, generic), empty);
  },
);

const u64 = integer(64),
  f64 = floating(64),
  word: AbiType = { kind: 'integer', bits: 64, signed: false };
const bits64 = (value: number): bigint => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, true);
  return view.getBigUint64(0, true);
};
const fromBits = (value: bigint): number => {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, value, true);
  return view.getFloat64(0, true);
};
const registerOf = (location: AbiLocation | undefined): RegisterDescriptor => {
  assert.equal(location?.kind, 'register');
  if (location?.kind !== 'register') throw new TypeError('register location required');
  return location.register;
};
const lowLane = (fp: RegisterDescriptor): RegisterDescriptor => ({
  ...fp,
  id: `${fp.root}:0:64`,
  width_bits: 64,
  write_rule: 'preserve_other_bits',
});

/** Unoptimized `double acc(double a, uint64_t n)`: the running sum lives in a
 * frame slot, starts as the literal 0.0 and gains `a` on each of three trips;
 * the loop counter is the integer result register on SysV. The result is a
 * reload of the slot into the FP result register on the only exit. `stored`
 * 'integer' stores the integer argument `n` in the slot instead of the sum,
 * 'literal' stores only literal bits (the width of the slot is no type), and
 * 'escaped' stores the sum but passes the slot's address to a call. */
function slotAccumulator(abi: AbiProfile, stored: 'sum' | 'integer' | 'literal' | 'escaped') {
  const layout = abi.classifyCall({
    returns: f64,
    parameters: [f64, word],
    variadic: false,
    fixed_parameter_count: 2,
  });
  const a = lowLane(registerOf(layout.parameters[0]!.locations[0])),
    n = registerOf(layout.parameters[1]!.locations[0]),
    fp = registerOf(layout.returns[0]);
  const counter = registerOf(
    abi.classifyCall({ returns: word, parameters: [], variadic: false, fixed_parameter_count: 0 })
      .returns[0],
  );
  // AAPCS64 has no scratch result register to count in: x9 stands for a
  // callee-saved-free temporary the function never returns.
  const index =
    abi.id === 'darwin-arm64'
      ? abi.unknown_call_clobbers.registers.find(
          (item) => item.root === 'arm64:x9' && item.width_bits === 64,
        )!
      : counter;
  const b = builder(`slot-accumulator-${abi.id}-${stored}`),
    entry = b.block('entry'),
    loop = b.block('loop'),
    done = b.block('done');
  const slot = entry.int('sub', entry.readRegister(abi.stack_pointer), entry.constant(u64, 16n));
  entry.store(slot, entry.constant(u64, 0n));
  entry.writeRegister(index, entry.constant(u64, 0n));
  entry.jump(loop);
  const sum = loop.fp(
    'add',
    loop.cast('bitcast', f64, loop.load(u64, slot)),
    loop.cast('bitcast', f64, loop.readRegister(a)),
  );
  loop.store(
    slot,
    stored === 'integer'
      ? loop.readRegister(n)
      : stored === 'literal'
        ? loop.constant(u64, bits64(1.5))
        : loop.cast('bitcast', u64, sum),
  );
  if (stored === 'escaped')
    loop.call(
      { kind: 'direct', address: { image_id: image, space: 'va', value: 0x3000n } },
      [slot],
      [],
      { registers: [], flags: [], memory: 'unknown_read_write' },
    );
  const next = loop.int('add', loop.readRegister(index), loop.constant(u64, 1n));
  loop.writeRegister(index, next);
  loop.branch(loop.compare('ult', next, loop.constant(u64, 3n)), loop.edge(loop), loop.edge(done));
  done.writeRegister(lowLane(fp), done.load(u64, slot));
  done.return([]);
  const ir = constructSSA(b.finish(entry, [])).value;
  if (ir.form !== 'ssa') throw new TypeError('Expected SSA');
  return { ir, a, n, fp, counter };
}

const interfaceOf = (
  abi: AbiProfile,
  fixture: { readonly ir: ReturnType<typeof slotAccumulator>['ir'] },
) => {
  const context = createOperationContext();
  const analysis = analyzeCalls(fixture.ir, abi, context);
  assert.equal(analysis.state, 'complete');
  return nativeReturnInterface(
    fixture.ir,
    abi,
    analysis,
    new Map(),
    context,
    false,
    [],
    false,
    createNativeInterfaceIndex(fixture.ir, abi, context),
  );
};

for (const abi of [sysvAMD64Abi, darwinArm64Abi])
  test(`${abi.id} an unoptimized result reloaded from a slot of FP stores types the FP root`, () => {
    const fixture = slotAccumulator(abi, 'sum');
    const result = interfaceOf(abi, fixture);
    assert.deepEqual(
      result.returns.map((register) => [register.root, register.width_bits]),
      [[fixture.fp.root, 64]],
    );
    assert.deepEqual(result.return_types, [f64]);
    assert.deepEqual(result.written_result?.types, [f64]);
  });

for (const abi of [sysvAMD64Abi, darwinArm64Abi])
  for (const stored of ['integer', 'literal', 'escaped'] as const)
    test(`${abi.id} a slot holding ${stored === 'integer' ? 'an integer store' : stored === 'literal' ? 'only literal bits' : 'an address-taken FP sum'} keeps the integer result`, () => {
      const fixture = slotAccumulator(abi, stored);
      const result = interfaceOf(abi, fixture);
      assert.ok(!result.return_types?.some((type) => type?.kind === 'float'));
      assert.ok(!result.returns.some((register) => register.root === fixture.fp.root));
      // SysV counts in rax, which stays the written result; AAPCS64 writes no
      // integer result register at all.
      assert.deepEqual(
        result.returns.map((register) => [register.root, register.width_bits]),
        abi.id === 'darwin-arm64' ? [] : [[fixture.counter.root, 64]],
      );
    });

/** `double r = acc(a, n); return r;` unoptimized: the callee's result register
 * is spilled to a frame slot and reloaded into the result register. */
function slotCaller(abi: AbiProfile, callee: ReturnType<typeof slotAccumulator>) {
  const b = builder(`slot-caller-${abi.id}`),
    entry = b.block('entry');
  const slot = entry.int('sub', entry.readRegister(abi.stack_pointer), entry.constant(u64, 16n));
  entry.readRegister(callee.a);
  entry.readRegister(callee.n);
  const clobbered = [callee.fp, ...(abi.id === 'darwin-arm64' ? [] : [callee.counter])];
  entry.call(
    { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
    [],
    [],
    { registers: clobbered, flags: [], memory: 'unknown_read_write' },
  );
  entry.store(slot, entry.readRegister(lowLane(callee.fp)));
  entry.writeRegister(lowLane(callee.fp), entry.load(u64, slot));
  entry.return([]);
  const ir = constructSSA(b.finish(entry, [])).value;
  if (ir.form !== 'ssa') throw new TypeError('Expected SSA');
  return ir;
}

for (const abi of [sysvAMD64Abi, darwinArm64Abi])
  test(`${abi.id} a caller of a slot-typed FP callee prints and executes double r = callee(...); return r;`, () => {
    const callee = slotAccumulator(abi, 'sum');
    const returned = interfaceOf(abi, callee);
    const ir = slotCaller(abi, callee);
    const call = ir.blocks[0]!.instructions.find((node) => node.kind === 'call')!;
    const observed = {
      call_id: call.id,
      parameters: [callee.a],
      returns: returned.returns,
      return_types: returned.return_types ?? [],
      evidence_ids: [],
    };
    // The caller's own result is the callee's, spilled to a slot and reloaded.
    const context = createOperationContext();
    const function_returns = nativeReturnInterface(
      ir,
      abi,
      analyzeCalls(ir, abi, context),
      new Map<string, NativeInterface>([
        [
          call.id,
          {
            ...observed,
            ...(returned.written_result ? { written_result: returned.written_result } : {}),
            parameter_state: 'observed',
            argument_list_complete: false,
          },
        ],
      ]),
      context,
    ).written_result;
    assert.deepEqual(function_returns?.types, [f64]);
    const source: SourceEvidence = {
      abi,
      addresses: [],
      callees: [observed],
      ...(function_returns ? { function_returns } : {}),
    };
    const types = recoverTypes(ir, abi, createOperationContext(), {
      image_id: image,
      slice_id: slice,
      revision: 0,
    });
    for (const language of ['c-like', 'python-like'] as const) {
      const { emission } = emit(ir, { source, types }, language);
      assert.match(emission.text, language === 'c-like' ? /^double fn_/m : /-> double:/);
      assert.doesNotMatch(emission.text, /physical_return|unknown_value/);
      const formals = emittedFormals(emission);
      for (const input of [1.5, -4.25]) {
        const observed = execute(
          emission,
          new Map(formals.map((formal) => [formal.statement_id, bits64(input)])),
          new Map(),
          0n,
          new Map(),
          new Map(),
          new Map([
            ['sub_2000', (args: readonly bigint[]) => bits64(fromBits(args[0]!) * 3 + 0.5)],
          ]),
        );
        assert.deepEqual(observed.values, [bits64(input * 3 + 0.5)]);
        assert.deepEqual(observed.source_calls, [{ name: 'sub_2000', arguments: [bits64(input)] }]);
      }
    }
  });

// S8: a variadic callee publishes its `va_start` footprint, the same
// classification its own source view prints `...` from.
for (const [fixture, entry, abi, named] of [
  ['elf-x86_64-symbols', 0x4019c0n, sysvAMD64Abi, 'x86_64:rdi'],
  ['corpus-symbols.dll', 0x1800011b0n, windowsX64Abi, 'x86_64:rcx'],
  ['macho-arm64-symbols', 0x1000006d0n, darwinArm64Abi, null],
] as const)
  test(`${fixture}: fixture_variadic publishes one named integer register and no named stack bytes`, async (t) => {
    const p = await project(t, fixture);
    const scope = { store: p.state.store, context: createOperationContext() };
    const footprint = (address: bigint) => {
      const fn = p.functions.find((candidate) => candidate.entry.value === address);
      assert.ok(fn);
      const graph = loadFunctionGraph(scope, 2, loadFunctionScope(scope, 2, fn.id));
      const lifter = abi === darwinArm64Abi ? new Arm64Lifter() : new X86Lifter();
      const constructed = constructSSA(lifter.lift(graph, abi, scope.context).ir).value;
      if (constructed.form !== 'ssa') throw new TypeError('Expected SSA');
      const ir = simplifySSA(constructed).value;
      const context = createOperationContext();
      const types = recoverTypes(ir, abi, context, {
        image_id: image,
        slice_id: slice,
        revision: 0,
      });
      return nativeVariadicFootprint(ir, types, abi, types.calls ?? null, context);
    };
    const found = footprint(entry);
    assert.ok(found);
    // Darwin leaves the named registers to the observed prefix.
    assert.deepEqual(
      found.named?.map((register) => register.root) ?? null,
      named === null ? null : [named],
    );
    assert.equal(found.named_stack_bytes, 0n);
    const published = nativeVariadicInterface(found, [{ ...x0, width_bits: 32 }]);
    assert.deepEqual(
      [published.named_integer, published.named_vector, published.named.length],
      [1, 0, 1],
    );
    // Negative: no other function of the corpus has a footprint.
    for (const other of p.functions)
      if (other.entry.value !== entry && !/variadic/.test(other.original_name ?? ''))
        assert.equal(footprint(other.entry.value), null, other.original_name ?? other.id);
  });

const variadicCallee = (named: RegisterDescriptor, result: RegisterDescriptor) => ({
  parameters: [{ ...named, width_bits: 32 }],
  parameter_types: [integer(32)],
  returns: [result],
  return_types: [f64],
  parameter_state: 'ambiguous' as const,
  argument_list_complete: false,
  variadic: { named_integer: 1, named_vector: 0, named_stack_bytes: 0n, named: [named] },
  evidence_ids: [],
});

/** `double caller(uint32_t count, double a, double b)` calling a variadic
 * `double sum(uint32_t count, ...)` (a stub at 0x2000) the way each ABI's
 * compiler sets it up:
 * - SysV: rsi = 7 (written), rdx untouched (ends the integer prefix), rcx = 9
 *   (written, but after the gap), al = 2: a and b forwarded in xmm0/xmm1;
 * - Win64: rdx = the bits of a (forwarded in xmm1 as well: one double),
 *   r8 = 5 (xmm2 holds b: not the same bits, so an integer), r9 untouched;
 * - Darwin: the bits of a and the constant 11 stored to SP+0 and SP+8.
 * `variant` 'clobbered' leaves a prior call's clobber in the first anonymous
 * integer register and (SysV) a non-constant al. */
function variadicCaller(abi: AbiProfile, variant: 'complete' | 'clobbered') {
  const layout = abi.classifyCall({
    returns: f64,
    parameters: [word, f64, f64],
    variadic: false,
    fixed_parameter_count: 3,
  });
  const count = registerOf(layout.parameters[0]!.locations[0]),
    a = lowLane(registerOf(layout.parameters[1]!.locations[0])),
    b = lowLane(registerOf(layout.parameters[2]!.locations[0])),
    result = lowLane(registerOf(layout.returns[0]));
  const integers = abi
    .classifyCall({
      returns: { kind: 'void' },
      parameters: Array.from({ length: 4 }, () => word),
      variadic: false,
      fixed_parameter_count: 4,
    })
    .parameters.map((parameter) => registerOf(parameter.locations[0]));
  const target = {
    kind: 'direct' as const,
    address: { image_id: image, space: 'va' as const, value: 0x2000n },
  };
  const b_ = builder(`variadic-caller-${abi.id}-${variant}`),
    entry = b_.block('entry');
  const sp = entry.readRegister(abi.stack_pointer);
  entry.readRegister(count);
  entry.readRegister(a);
  entry.readRegister(b);
  const clobber = () =>
    entry.call(
      { kind: 'direct', address: { image_id: image, space: 'va', value: 0x3000n } },
      [],
      [],
      { registers: [integers[1]!], flags: [], memory: 'unknown_read_write' },
    );
  if (variant === 'clobbered' && abi.id !== 'darwin-arm64') clobber();
  if (abi.id === 'sysv-amd64') {
    if (variant === 'complete') entry.writeRegister(integers[1]!, entry.constant(u64, 7n));
    entry.writeRegister(integers[3]!, entry.constant(u64, 9n));
    const al = abi
      .classifyCall({
        returns: { kind: 'void' },
        parameters: [],
        variadic: true,
        fixed_parameter_count: 0,
      })
      .implicit_register_inputs.find(
        (input) => input.purpose === 'vector_argument_register_upper_bound',
      )!.register;
    if (variant === 'complete') entry.writeRegister(al, entry.constant(integer(8), 2n));
  } else if (abi.id === 'windows-x64') {
    if (variant === 'complete') entry.writeRegister(integers[1]!, entry.readRegister(a));
    entry.writeRegister(integers[2]!, entry.constant(u64, 5n));
  } else {
    const area = entry.int('sub', sp, entry.constant(u64, 16n));
    entry.writeRegister(abi.stack_pointer, area);
    entry.store(area, entry.readRegister(a));
    entry.store(entry.int('add', area, entry.constant(u64, 8n)), entry.constant(u64, 11n));
    // A barrier between the stores and the call: the slots are no arguments.
    if (variant === 'clobbered') clobber();
  }
  entry.call(target, [], [], {
    registers: [
      result,
      ...abi.unknown_call_clobbers.registers.filter(
        (register) =>
          register.root !== result.root &&
          register.root !== abi.stack_pointer.root &&
          register.bank === 'integer',
      ),
    ],
    flags: [],
    memory: 'unknown_read_write',
  });
  if (abi.id === 'darwin-arm64') entry.writeRegister(abi.stack_pointer, sp);
  entry.return([]);
  const ir = constructSSA(b_.finish(entry, [])).value;
  if (ir.form !== 'ssa') throw new TypeError('Expected SSA');
  const call = ir.blocks[0]!.instructions.filter((node) => node.kind === 'call').at(-1)!;
  return { ir, call, count, result };
}

const sum = (args: readonly bigint[]) => args.reduce((total, bits) => total + bits, 0n);

for (const abi of [sysvAMD64Abi, windowsX64Abi, darwinArm64Abi])
  for (const variant of ['complete', 'clobbered'] as const)
    test(`${abi.id} ${variant === 'complete' ? 'a caller of a published variadic callee prints and executes the anonymous arguments it sets up' : 'a clobbered or unbounded anonymous location is no argument'}`, () => {
      const fixture = variadicCaller(abi, variant);
      const types = recoverTypes(fixture.ir, abi, createOperationContext(), {
        image_id: image,
        slice_id: slice,
        revision: 0,
      });
      const source: SourceEvidence = {
        abi,
        addresses: [],
        callees: [{ call_id: fixture.call.id, ...variadicCallee(fixture.count, fixture.result) }],
      };
      const a = 1.25,
        b = -6.5;
      // The values each ABI's caller sets up (see variadicCaller).
      const expected =
        variant === 'clobbered'
          ? [3n]
          : abi.id === 'sysv-amd64'
            ? [3n, 7n, bits64(a), bits64(b)]
            : abi.id === 'windows-x64'
              ? [3n, bits64(a), 5n]
              : [3n, bits64(a), 11n];
      for (const language of ['c-like', 'python-like'] as const) {
        const { emission } = emit(fixture.ir, { source, types }, language);
        const rules = emission.local_validation?.map((record) => record.rule) ?? [];
        assert.ok(rules.includes('variadic_call_arguments'), emission.text);
        // Every formal is a named or anonymous argument the call prints.
        const formals = emittedFormals(emission);
        // Darwin's clobbered variant still stores a to the (now ordinary) slot.
        assert.equal(
          formals.length,
          abi.id === 'sysv-amd64' && variant === 'complete'
            ? 3
            : variant === 'complete' || abi.id === 'darwin-arm64'
              ? 2
              : 1,
          emission.text,
        );
        const observed = execute(
          emission,
          new Map(
            formals.map((formal, index) => [
              formal.statement_id,
              [3n, bits64(a), bits64(b)][index]!,
            ]),
          ),
          new Map(),
          0n,
          new Map(),
          new Map(),
          new Map([
            ['sub_2000', sum],
            ['sub_3000', () => 0n],
          ]),
        );
        assert.deepEqual(
          (observed.source_calls ?? []).filter((call) => call.name === 'sub_2000'),
          [{ name: 'sub_2000', arguments: expected }],
          emission.text,
        );
      }
      // The checked view keeps the physical call interface.
      const checked = emit(fixture.ir, { source, types }, 'c-like', 'checked').emission;
      assert.ok(
        !checked.local_validation?.some((record) => record.rule === 'variadic_call_arguments'),
      );
    });

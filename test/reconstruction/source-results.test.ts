import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationContext,
  type AbiLocation,
  type AbiProfile,
  type AbiType,
  type RegisterDescriptor,
} from '../../src/core/index.js';
import { darwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../src/abi/sysv-amd64/index.js';
import { windowsX64Abi } from '../../src/abi/windows-x64/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { recoverTypes } from '../../src/analysis/types/index.js';
import { integer, type SSAForm } from '../../src/ir/index.js';
import { structureControlFlow } from '../../src/presentation/index.js';
import { reconstruct } from '../../src/reconstruction/index.js';
import type { SourceEvidence } from '../../src/reconstruction/source-model.js';
import { builder, image, slice } from '../ir/support.js';
import { emit, emittedFormals, execute } from '../emitters/c/support.js';

const u64 = integer(64),
  f64 = { kind: 'float', bits: 64 } as const,
  word: AbiType = { kind: 'integer', bits: 64, signed: false };
const bits = (value: number): bigint => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, true);
  return view.getBigUint64(0, true);
};
const register = (location: AbiLocation | undefined): RegisterDescriptor => {
  assert.equal(location?.kind, 'register');
  if (location?.kind !== 'register') throw new Error('register location required');
  return location.register;
};

/** `double f(double a, uint64_t n) { if (!n) return 0.0; for (i = 0; i < n; i++)
 * a += a; return a; }` as lifted machine code: no explicit IR result, and the
 * early exit writes literal FP bits. The loop index lives in the integer result
 * register (a scratch register on Darwin). On the early exit that register holds
 * its unknown entry value, a literal zero, or the count argument. `fpLast`
 * increments the index before the FP write in the loop body. */
function loop(
  abi: AbiProfile,
  early: 'entry' | 'literal' | 'count' = 'entry',
  evidence: Partial<SourceEvidence> = {},
  fpLast = false,
) {
  const layout = abi.classifyCall({
    returns: f64,
    parameters: [f64, word],
    variadic: false,
    fixed_parameter_count: 2,
  });
  const fp = register(layout.parameters[0]!.locations[0]),
    count = register(layout.parameters[1]!.locations[0]);
  const low: RegisterDescriptor = {
    ...fp,
    id: `${fp.root}:0:64`,
    width_bits: 64,
    write_rule: 'preserve_other_bits',
  };
  const intResult = register(
    abi.classifyCall({ returns: word, parameters: [], variadic: false, fixed_parameter_count: 0 })
      .returns[0],
  );
  const index: RegisterDescriptor =
    abi.id === 'darwin-arm64'
      ? abi.unknown_call_clobbers.registers.find(
          (item) => item.root === 'arm64:x9' && item.width_bits === 64,
        )!
      : intResult;
  const b = builder(`primary-result-${abi.id}-${early}-${fpLast}`),
    entry = b.block('entry'),
    zero = b.block('zero'),
    init = b.block('init'),
    body = b.block('body'),
    done = b.block('done');
  const n = entry.readRegister(count);
  if (early !== 'entry')
    entry.writeRegister(index, early === 'count' ? n : entry.constant(u64, 0n));
  entry.branch(entry.compare('eq', n, entry.constant(u64, 0n)), entry.edge(zero), entry.edge(init));
  zero.writeRegister(low, zero.constant(u64, 0n));
  zero.return([]);
  init.writeRegister(index, init.constant(u64, 0n));
  init.jump(body);
  const i = body.readRegister(index);
  const next = body.int('add', i, body.constant(u64, 1n));
  if (fpLast) body.writeRegister(index, next);
  const a = body.cast('bitcast', f64, body.readRegister(low));
  body.writeRegister(low, body.cast('bitcast', u64, body.fp('add', a, a)));
  if (!fpLast) body.writeRegister(index, next);
  body.branch(
    body.compare('ult', next, body.readRegister(count)),
    body.edge(body),
    body.edge(done),
  );
  done.return([]);
  const ir = constructSSA(b.finish(entry, [])).value as SSAForm;
  const source: SourceEvidence = { abi, callees: [], addresses: [], ...evidence };
  const view = (kind: 'source' | 'checked') =>
    reconstruct(
      { function: structureControlFlow(ir, createOperationContext()).value!, source },
      createOperationContext(),
      kind,
    );
  return { ir, source, view, fp: low, intResult, index };
}

for (const abi of [sysvAMD64Abi, windowsX64Abi, darwinArm64Abi])
  for (const early of ['entry', 'literal'] as const)
    test(`${abi.id} FP result wins over a loop index that is ${early === 'entry' ? 'undefined on a path' : 'written before it on every path'}`, () => {
      const fixture = loop(abi, early, {}, early === 'literal');
      const source = fixture.view('source');
      for (const projection of source.returns.values()) {
        assert.equal(projection.results.length, 1);
        assert.deepEqual(projection.results[0]!.type, f64);
        assert.equal(projection.outputs.length, 0);
      }
      const rejected =
        abi.id === 'darwin-arm64'
          ? 'is never written'
          : early === 'entry'
            ? 'is undefined on some exit'
            : 'is written after';
      assert.ok(
        source.local_validation?.some(
          (record) =>
            record.rule === 'primary_result' &&
            record.reason?.includes(`${fixture.fp.root} float64 selected`) &&
            record.reason.includes(rejected),
        ),
      );
      assert.ok(
        source.local_validation_session?.abiConformance.some(
          (site) => site.rule === 'primary_result',
        ),
      );
      // The rejected loop index stays in exit metadata, never a second result.
      if (abi.id !== 'darwin-arm64')
        assert.ok(
          [...source.returns.values()].some((projection) =>
            projection.exit_scratch?.some((slice) => slice.register.root === fixture.index.root),
          ),
        );
      // Without the rule, the literal exit leaves FP untyped there: no FP result.
      assert.ok(
        [...fixture.view('checked').returns.values()].every(
          (projection) => !projection.results.some((value) => value.type.kind === 'float'),
        ),
      );
      for (const language of ['c-like', 'python-like'] as const) {
        const { emission } = emit(fixture.ir, { source: fixture.source }, language);
        assert.match(emission.text, language === 'c-like' ? /^double fn_/m : /-> double:/);
        assert.doesNotMatch(emission.text, /physical_return/);
        const formals = emittedFormals(emission);
        assert.equal(formals.length, 2);
        for (const [n, expected] of [
          [0n, 0],
          [1n, 3],
          [3n, 12],
        ] as const) {
          const observed = execute(
            emission,
            new Map([
              [formals[0]!.statement_id, n],
              [formals[1]!.statement_id, bits(1.5)],
            ]),
          );
          assert.deepEqual(observed.values, [bits(expected)]);
        }
      }
    });

test('mixed last-write order between qualifying registers keeps the explicit exit form', () => {
  // The FP write is last on the early exit, the index increment last in the loop.
  const fixture = loop(sysvAMD64Abi, 'literal');
  const source = fixture.view('source');
  for (const projection of source.returns.values()) {
    assert.equal(projection.results.length, 0);
    for (const root of [fixture.fp.root, fixture.intResult.root])
      assert.ok(projection.outputs.some((binding) => binding.register.root === root));
  }
  assert.ok(
    source.local_validation?.some(
      (record) =>
        record.rule === 'primary_result' &&
        record.reason?.includes('no consistent last write on every exit path'),
    ),
  );
  assert.ok(
    !source.local_validation_session?.abiConformance.some((site) => site.rule === 'primary_result'),
  );
  for (const language of ['c-like', 'python-like'] as const) {
    const { emission } = emit(fixture.ir, { source: fixture.source }, language);
    assert.match(emission.text, /physical_return\(/);
    assert.doesNotMatch(emission.text, language === 'c-like' ? /^double fn_/m : /-> double:/);
  }
});

test('positive caller demand resolves two qualifying primary registers', () => {
  const plain = loop(sysvAMD64Abi, 'count');
  const demandedFloat = loop(sysvAMD64Abi, 'count', { function_return_demands: [plain.fp] });
  for (const projection of demandedFloat.view('source').returns.values())
    assert.deepEqual(projection.results[0]?.type, f64);
  const demandedInteger = loop(sysvAMD64Abi, 'count', {
    function_return_demands: [plain.intResult],
  });
  for (const projection of demandedInteger.view('source').returns.values()) {
    assert.equal(projection.results.length, 1);
    assert.equal(projection.results[0]!.type.kind, 'integer');
  }
});

/** `int count_if(const double *a, uint64_t n) { c = 0; i = 0; do { x = a[i] * 2.0;
 * if (x > 1.0) c++; } while (++i < n); return c; }`. The FP result register holds
 * the typed product on every exit, while the counter is built from 0/+1 only.
 * `slot` keeps the counter in a frame slot and reloads it in the return block. */
function countIf(abi: AbiProfile, style: 'register' | 'slot') {
  const layout = abi.classifyCall({
    returns: word,
    parameters: [{ kind: 'pointer' }, word],
    variadic: false,
    fixed_parameter_count: 2,
  });
  const pointer = register(layout.parameters[0]!.locations[0]),
    count = register(layout.parameters[1]!.locations[0]),
    result = register(layout.returns[0]);
  const fp = register(
    abi.classifyCall({ returns: f64, parameters: [], variadic: false, fixed_parameter_count: 0 })
      .returns[0],
  );
  const low: RegisterDescriptor = {
    ...fp,
    id: `${fp.root}:0:64`,
    width_bits: 64,
    write_rule: 'preserve_other_bits',
  };
  const index = abi.unknown_call_clobbers.registers.find(
    (item) =>
      item.root === (abi.id === 'darwin-arm64' ? 'arm64:x9' : 'x86_64:r10') &&
      item.width_bits === 64,
  )!;
  const b = builder(`count-if-${abi.id}-${style}`),
    entry = b.block('entry'),
    body = b.block('body'),
    done = b.block('done');
  const base = entry.readRegister(pointer),
    n = entry.readRegister(count);
  const slot =
    style === 'slot'
      ? entry.int('sub', entry.readRegister(abi.stack_pointer), entry.constant(u64, 16n))
      : undefined;
  if (slot) entry.store(slot, entry.constant(u64, 0n));
  else entry.writeRegister(result, entry.constant(u64, 0n));
  entry.writeRegister(index, entry.constant(u64, 0n));
  entry.jump(body);
  const i = body.readRegister(index);
  const element = body.load(u64, body.int('add', base, body.int('shl', i, body.constant(u64, 3n))));
  const product = body.fp('mul', body.cast('bitcast', f64, element), body.constant(f64, bits(2)));
  body.writeRegister(low, body.cast('bitcast', u64, product));
  const counter = slot ? body.load(u64, slot) : body.readRegister(result);
  const updated = body.select(
    body.fpCompare('gt', product, body.constant(f64, bits(1))),
    body.int('add', counter, body.constant(u64, 1n)),
    counter,
  );
  if (slot) body.store(slot, updated);
  else body.writeRegister(result, updated);
  const next = body.int('add', i, body.constant(u64, 1n));
  body.writeRegister(index, next);
  body.branch(body.compare('ult', next, n), body.edge(body), body.edge(done));
  if (slot) done.writeRegister(result, done.load(u64, slot));
  done.return([]);
  const ir = constructSSA(b.finish(entry, [])).value as SSAForm;
  return { ir, source: { abi, callees: [], addresses: [] } satisfies SourceEvidence };
}

for (const abi of [sysvAMD64Abi, darwinArm64Abi])
  for (const style of ['register', 'slot'] as const)
    test(`${abi.id} ${style} count_if keeps the integer counter written after the FP temporary`, () => {
      const fixture = countIf(abi, style);
      const program = reconstruct(
        {
          function: structureControlFlow(fixture.ir, createOperationContext()).value!,
          source: fixture.source,
        },
        createOperationContext(),
        'source',
      );
      for (const projection of program.returns.values()) {
        assert.equal(projection.results.length, 1);
        assert.equal(projection.results[0]!.type.kind, 'integer');
      }
      for (const language of ['c-like', 'python-like'] as const) {
        const { emission } = emit(fixture.ir, { source: fixture.source }, language);
        assert.doesNotMatch(emission.text, /physical_return|\bdouble fn_|-> double:/);
        const formals = emittedFormals(emission);
        assert.equal(formals.length, 2);
        const values = [0.25, 0.75, 3, -1];
        const memory = new Map<bigint, number>();
        values.forEach((value, element) => {
          const encoded = bits(value);
          for (let byte = 0; byte < 8; byte++)
            memory.set(
              0x2000n + BigInt(element * 8 + byte),
              Number((encoded >> BigInt(byte * 8)) & 255n),
            );
        });
        const inputs = new Map([
          [formals[0]!.statement_id, 0x2000n],
          [formals[1]!.statement_id, BigInt(values.length)],
        ]);
        const observed = execute(emission, inputs, memory);
        assert.equal(BigInt.asUintN(32, observed.values[0]!), 2n);
      }
    });

/** `void zero(uint64_t *a, uint64_t n) { for (i = 0; i < n; i++) a[i] = 0; }`
 * with the stale loop index left in the integer result register (`index`), or
 * `uint64_t zero_count(...)` whose result register holds a counter that only
 * the exit consumes while a scratch register indexes the array (`count`). */
function zeroFill(
  abi: AbiProfile,
  mode: 'index' | 'count',
  evidence: Partial<SourceEvidence> = {},
) {
  const layout = abi.classifyCall({
    returns: word,
    parameters: [{ kind: 'pointer' }, word],
    variadic: false,
    fixed_parameter_count: 2,
  });
  const pointer = register(layout.parameters[0]!.locations[0]),
    count = register(layout.parameters[1]!.locations[0]),
    result = register(layout.returns[0]);
  const scratch = abi.unknown_call_clobbers.registers.find(
    (item) =>
      item.root === (abi.id === 'darwin-arm64' ? 'arm64:x9' : 'x86_64:r10') &&
      item.width_bits === 64,
  )!;
  const index = mode === 'index' ? result : scratch;
  const b = builder(`zero-fill-${abi.id}-${mode}`),
    entry = b.block('entry'),
    body = b.block('body'),
    done = b.block('done');
  const base = entry.readRegister(pointer),
    n = entry.readRegister(count);
  entry.writeRegister(index, entry.constant(u64, 0n));
  if (mode === 'count') entry.writeRegister(result, entry.constant(u64, 0n));
  entry.branch(entry.compare('eq', n, entry.constant(u64, 0n)), entry.edge(done), entry.edge(body));
  const i = body.readRegister(index);
  body.store(
    body.int('add', base, body.int('shl', i, body.constant(u64, 3n))),
    body.constant(u64, 0n),
  );
  if (mode === 'count')
    body.writeRegister(result, body.int('add', body.readRegister(result), body.constant(u64, 1n)));
  const next = body.int('add', i, body.constant(u64, 1n));
  body.writeRegister(index, next);
  body.branch(body.compare('ult', next, n), body.edge(body), body.edge(done));
  done.return([]);
  const ir = constructSSA(b.finish(entry, [])).value as SSAForm;
  const source: SourceEvidence = { abi, callees: [], addresses: [], ...evidence };
  const view = (kind: 'source' | 'checked') =>
    reconstruct(
      { function: structureControlFlow(ir, createOperationContext()).value!, source },
      createOperationContext(),
      kind,
    );
  return { ir, source, view, result };
}

/** Emits the fixture, zero-fills three elements and returns text and results. */
const runZeroFill = (
  fixture: { ir: SSAForm; source: SourceEvidence },
  language: 'c-like' | 'python-like',
) => {
  const { emission } = emit(fixture.ir, { source: fixture.source }, language);
  const formals = emittedFormals(emission);
  assert.equal(formals.length, 2);
  const memory = new Map<bigint, number>();
  for (let byte = 0n; byte < 32n; byte++) memory.set(0x2000n + byte, 0xff);
  const observed = execute(
    emission,
    new Map([
      [formals[0]!.statement_id, 0x2000n],
      [formals[1]!.statement_id, 3n],
    ]),
    memory,
  );
  for (let byte = 0n; byte < 32n; byte++)
    assert.equal(observed.memory.get(0x2000n + byte), byte < 24n ? 0 : 0xff);
  return { text: emission.text, values: observed.values };
};

for (const abi of [sysvAMD64Abi, windowsX64Abi, darwinArm64Abi])
  test(`${abi.id} a stale loop index in the integer result register is void-like`, () => {
    const fixture = zeroFill(abi, 'index');
    const source = fixture.view('source');
    for (const projection of source.returns.values()) {
      assert.equal(projection.results.length, 0);
      assert.equal(projection.outputs.length, 0);
      assert.ok(
        projection.exit_scratch?.some((slice) => slice.register.root === fixture.result.root),
      );
    }
    assert.ok(
      source.local_validation?.some(
        (record) =>
          record.rule === 'incidental_result' &&
          record.reason?.includes('a value that also addresses memory or feeds calls or branches'),
      ),
    );
    assert.ok(
      source.local_validation_session?.abiConformance.some(
        (site) => site.rule === 'incidental_result',
      ),
    );
    // The checked view keeps the exact physical exit state.
    for (const projection of fixture.view('checked').returns.values())
      assert.equal(projection.exit_scratch, undefined);
    for (const language of ['c-like', 'python-like'] as const) {
      const { text, values } = runZeroFill(fixture, language);
      assert.match(text, language === 'c-like' ? /^void fn_/m : /-> void:/);
      assert.doesNotMatch(text, /physical_return|\breturn [^;\n]/);
      assert.deepEqual(values, []);
    }
  });

test('caller demand keeps a stale-looking integer result register', () => {
  const plain = zeroFill(sysvAMD64Abi, 'index');
  const demanded = zeroFill(sysvAMD64Abi, 'index', { function_return_demands: [plain.result] });
  const source = demanded.view('source');
  for (const projection of source.returns.values()) {
    assert.equal(projection.results.length, 1);
    assert.equal(projection.results[0]!.type.kind, 'integer');
  }
  assert.ok(!source.local_validation?.some((record) => record.rule === 'incidental_result'));
  const { text, values } = runZeroFill(demanded, 'c-like');
  assert.match(text, /^uint64_t fn_/m);
  assert.deepEqual(values, [3n]);
});

for (const abi of [sysvAMD64Abi, darwinArm64Abi])
  test(`${abi.id} a counter consumed only by the exit stays the result`, () => {
    const fixture = zeroFill(abi, 'count');
    const source = fixture.view('source');
    for (const projection of source.returns.values()) {
      assert.equal(projection.results.length, 1);
      assert.equal(projection.results[0]!.type.kind, 'integer');
    }
    assert.ok(!source.local_validation?.some((record) => record.rule === 'incidental_result'));
    for (const language of ['c-like', 'python-like'] as const) {
      const { text, values } = runZeroFill(fixture, language);
      assert.doesNotMatch(text, /physical_return|^void fn_|-> void:/m);
      assert.deepEqual(values, [3n]);
    }
  });

/** Darwin `x = f(p); [*p = 0;] return x;` with `f` returning in x0: the call is
 * the final action, or a store follows it (`void g(p) { f(p); *p = 0; }`). */
function callResult(trailingStore: boolean) {
  const abi = darwinArm64Abi;
  const x0 = register(
    abi.classifyCall({
      returns: word,
      parameters: [word],
      variadic: false,
      fixed_parameter_count: 1,
    }).returns[0],
  );
  const x19 = abi.preserved.find((item) => item.root === 'arm64:x19' && item.width_bits === 64)!;
  const b = builder(`call-result-${trailingStore}`),
    block = b.block('entry');
  block.writeRegister(x19, block.readRegister(x0));
  block.call(
    { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
    [],
    [],
    abi.unknown_call_clobbers,
  );
  if (trailingStore) block.store(block.readRegister(x19), block.constant(u64, 0n));
  block.return([]);
  const ir = constructSSA(b.finish(block, [])).value as SSAForm;
  const call = ir.blocks[0]!.instructions.find((node) => node.kind === 'call')!;
  const source: SourceEvidence = {
    abi,
    addresses: [],
    callees: [
      {
        call_id: call.id,
        parameters: [x0],
        returns: [x0],
        argument_list_complete: true,
        evidence_ids: [],
      },
    ],
  };
  const types = recoverTypes(ir, abi, createOperationContext(), {
    image_id: image,
    slice_id: slice,
    revision: 0,
  });
  const program = reconstruct(
    { function: structureControlFlow(ir, createOperationContext()).value!, types, source },
    createOperationContext(),
    'source',
  );
  return { ir, source, types, program, x0 };
}

test('a callee result passed through as the final action stays the result', () => {
  const fixture = callResult(false);
  for (const projection of fixture.program.returns.values()) {
    assert.equal(projection.results.length, 1);
    assert.equal(projection.results[0]!.type.kind, 'integer');
  }
  assert.ok(
    !fixture.program.local_validation?.some((record) => record.rule === 'incidental_result'),
  );
});

test('a callee result left in place before a later store is void-like', () => {
  const fixture = callResult(true);
  for (const projection of fixture.program.returns.values()) {
    assert.equal(projection.results.length, 0);
    assert.ok(projection.exit_scratch?.some((slice) => slice.register.root === fixture.x0.root));
  }
  assert.ok(
    fixture.program.local_validation?.some(
      (record) =>
        record.rule === 'incidental_result' &&
        record.reason?.includes('a call result left in place before later effects'),
    ),
  );
  const { emission } = emit(fixture.ir, { types: fixture.types, source: fixture.source }, 'c-like');
  assert.match(emission.text, /^void fn_/m);
  assert.doesNotMatch(emission.text, /physical_return/);
});

/** Darwin `struct big f(const struct big *in)`: x8 carries the caller's
 * indirect result location; a 128-bit copy also leaves bits in v0. With
 * `store: false` x8 is only read into the integer result register. */
function indirectResult(store: boolean) {
  const abi = darwinArm64Abi;
  const x = (n: number) =>
    abi.unknown_call_clobbers.registers.find(
      (item) => item.root === `arm64:x${n}` && item.width_bits === 64,
    )!;
  const fp = register(
    abi.classifyCall({ returns: f64, parameters: [], variadic: false, fixed_parameter_count: 0 })
      .returns[0],
  );
  const v0: RegisterDescriptor = { ...fp, id: `${fp.root}:0:64`, width_bits: 64 };
  const b = builder(`indirect-result-${store}`),
    block = b.block('entry');
  const input = block.readRegister(x(0)),
    output = block.readRegister(x(8));
  const low = block.load(u64, input);
  if (store) {
    block.store(output, low);
    block.store(
      block.int('add', output, block.constant(u64, 8n)),
      block.load(u64, block.int('add', input, block.constant(u64, 8n))),
    );
    block.writeRegister(v0, low);
  } else block.writeRegister(x(0), block.int('add', output, low));
  block.return([]);
  const ir = constructSSA(b.finish(block, [])).value as SSAForm;
  const source: SourceEvidence = { abi, callees: [], addresses: [] };
  const view = (kind: 'source' | 'checked') =>
    reconstruct(
      { function: structureControlFlow(ir, createOperationContext()).value!, source },
      createOperationContext(),
      kind,
    );
  return { ir, source, view, v0 };
}

test('darwin-arm64 a stored-through x8 entry value is the indirect result formal', () => {
  const fixture = indirectResult(true);
  const source = fixture.view('source');
  assert.ok(
    source.parameters.some(
      (value) => source.parameter_registers.get(value.id)?.root === 'arm64:x8',
    ),
  );
  for (const projection of source.returns.values()) {
    assert.equal(projection.results.length, 0);
    assert.equal(projection.outputs.length, 0);
    assert.ok(projection.exit_scratch?.some((slice) => slice.register.root === fixture.v0.root));
  }
  assert.ok(source.local_validation?.some((record) => record.rule === 'indirect_result'));
  assert.ok(
    source.local_validation_session?.abiConformance.some((site) => site.rule === 'indirect_result'),
  );
  // The checked view keeps x8 an entry value, not a formal.
  const checked = fixture.view('checked');
  assert.ok(
    !checked.parameters.some(
      (value) => checked.parameter_registers.get(value.id)?.root === 'arm64:x8',
    ),
  );
  for (const language of ['c-like', 'python-like'] as const) {
    const { emission } = emit(fixture.ir, { source: fixture.source }, language);
    assert.match(emission.text, language === 'c-like' ? /^void fn_/m : /-> void:/);
    assert.doesNotMatch(emission.text, /physical_return|unknown_value|non-argument entry register/);
    assert.equal(emittedFormals(emission).length, 2);
  }
});

test('an x8 entry value that addresses no store stays an unknown entry value', () => {
  const source = indirectResult(false).view('source');
  assert.ok(
    !source.parameters.some(
      (value) => source.parameter_registers.get(value.id)?.root === 'arm64:x8',
    ),
  );
  assert.ok(!source.local_validation?.some((record) => record.rule === 'indirect_result'));
});

// `u64 fixture_memory(u64 *p, u64 d) { *p += d; return *p; }`: the sum is both
// stored and returned; storing a value is no evidence that it is incidental.
for (const abi of [sysvAMD64Abi, darwinArm64Abi])
  test(`${abi.id} a value both stored and returned stays the result`, () => {
    const layout = abi.classifyCall({
      returns: word,
      parameters: [{ kind: 'pointer' }, word],
      variadic: false,
      fixed_parameter_count: 2,
    });
    const pointer = register(layout.parameters[0]!.locations[0]),
      delta = register(layout.parameters[1]!.locations[0]),
      result = register(layout.returns[0]);
    const b = builder(`stored-result-${abi.id}`),
      block = b.block('entry');
    const address = block.readRegister(pointer);
    const sum = block.int('add', block.load(u64, address), block.readRegister(delta));
    block.writeRegister(result, sum);
    block.store(address, sum);
    block.return([]);
    const ir = constructSSA(b.finish(block, [])).value as SSAForm;
    const source: SourceEvidence = { abi, callees: [], addresses: [] };
    const program = reconstruct(
      { function: structureControlFlow(ir, createOperationContext()).value!, source },
      createOperationContext(),
      'source',
    );
    for (const projection of program.returns.values()) {
      assert.equal(projection.results.length, 1);
      assert.equal(projection.results[0]!.type.kind, 'integer');
    }
    assert.ok(!program.local_validation?.some((record) => record.rule === 'incidental_result'));
    const { emission } = emit(ir, { source }, 'c-like');
    const formals = emittedFormals(emission);
    const memory = new Map<bigint, number>();
    for (let byte = 0n; byte < 8n; byte++) memory.set(0x2000n + byte, byte === 0n ? 7 : 0);
    const observed = execute(
      emission,
      new Map([
        [formals[0]!.statement_id, 0x2000n],
        [formals[1]!.statement_id, 11n],
      ]),
      memory,
    );
    assert.deepEqual(observed.values, [18n]);
    assert.equal(observed.memory.get(0x2000n), 18);
  });

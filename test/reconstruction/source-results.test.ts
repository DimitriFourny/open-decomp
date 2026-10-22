import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationContext,
  entityIdentity,
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
import { integer, type Provenance, type SSAForm } from '../../src/ir/index.js';
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

/** Unoptimized `double scaled_or_zero(const double *a, uint64_t n)`: the result
 * is spilled, copied slot to slot by plain reloads and reloaded into the FP
 * result register just before returning, after the integer result register
 * received `n << 1` (or `n` on the zero path). `typed` false spills the raw
 * element bits instead of `a[0] * 2.0`: then nothing types the FP register. */
function slotChain(abi: AbiProfile, typed: boolean) {
  const layout = abi.classifyCall({
    returns: f64,
    parameters: [{ kind: 'pointer' }, word],
    variadic: false,
    fixed_parameter_count: 2,
  });
  const pointer = register(layout.parameters[0]!.locations[0]),
    count = register(layout.parameters[1]!.locations[0]),
    fp = register(layout.returns[0]);
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
  const b = builder(`slot-chain-${abi.id}-${typed}`),
    entry = b.block('entry'),
    zero = b.block('zero'),
    nonzero = b.block('nonzero'),
    done = b.block('done');
  const sp = entry.readRegister(abi.stack_pointer);
  const slot = (offset: bigint) => entry.int('sub', sp, entry.constant(u64, offset));
  const spilled = slot(16n),
    copied = slot(24n),
    returned = slot(8n);
  const n = entry.readRegister(count);
  entry.branch(
    entry.compare('eq', n, entry.constant(u64, 0n)),
    entry.edge(zero),
    entry.edge(nonzero),
  );
  zero.store(returned, zero.constant(u64, 0n));
  zero.writeRegister(intResult, n);
  zero.jump(done);
  const element = nonzero.load(u64, nonzero.readRegister(pointer));
  nonzero.store(
    spilled,
    typed
      ? nonzero.cast(
          'bitcast',
          u64,
          nonzero.fp('mul', nonzero.cast('bitcast', f64, element), nonzero.constant(f64, bits(2))),
        )
      : element,
  );
  nonzero.writeRegister(intResult, nonzero.int('shl', n, nonzero.constant(u64, 1n)));
  nonzero.store(copied, nonzero.load(u64, spilled));
  nonzero.store(returned, nonzero.load(u64, copied));
  nonzero.jump(done);
  done.writeRegister(low, done.load(u64, returned));
  done.return([]);
  const ir = constructSSA(b.finish(entry, [])).value as SSAForm;
  const source: SourceEvidence = { abi, callees: [], addresses: [] };
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
  return { ir, source, types, program };
}

for (const abi of [sysvAMD64Abi, windowsX64Abi, darwinArm64Abi])
  test(`${abi.id} an FP result copied between frame slots before its final reload is the result`, () => {
    const fixture = slotChain(abi, true);
    for (const projection of fixture.program.returns.values()) {
      assert.equal(projection.results.length, 1);
      assert.deepEqual(projection.results[0]!.type, f64);
    }
    for (const language of ['c-like', 'python-like'] as const) {
      const { emission } = emit(
        fixture.ir,
        { source: fixture.source, types: fixture.types },
        language,
      );
      assert.match(emission.text, language === 'c-like' ? /^double fn_/m : /-> double:/);
      assert.doesNotMatch(emission.text, /physical_return/);
      const formals = emittedFormals(emission);
      assert.equal(formals.length, 2);
      const memory = new Map<bigint, number>();
      for (let byte = 0; byte < 8; byte++)
        memory.set(0x2000n + BigInt(byte), Number((bits(1.5) >> BigInt(byte * 8)) & 255n));
      for (const [n, expected] of [
        [0n, 0],
        [1n, 3],
      ] as const) {
        const observed = execute(
          emission,
          new Map([
            [formals[0]!.statement_id, 0x2000n],
            [formals[1]!.statement_id, n],
          ]),
          new Map(memory),
        );
        assert.deepEqual(observed.values, [bits(expected)]);
      }
    }
  });

for (const abi of [sysvAMD64Abi, windowsX64Abi])
  test(`${abi.id} an untyped FP register written after the integer result keeps the explicit exit form`, () => {
    const { program, ir, source, types } = slotChain(abi, false);
    for (const projection of program.returns.values())
      assert.ok(!projection.results.some((value) => value.type.kind === 'integer'));
    assert.ok(
      program.local_validation?.some(
        (record) =>
          record.rule === 'primary_result' &&
          record.reason?.includes('without typed IEEE evidence'),
      ),
    );
    for (const language of ['c-like', 'python-like'] as const) {
      const { emission } = emit(ir, { source, types }, language);
      assert.match(emission.text, /physical_return\(/);
      assert.doesNotMatch(emission.text, language === 'c-like' ? /^uint64_t fn_/m : /-> uint64_t:/);
    }
  });

const site = (address: bigint): Provenance => ({
  instruction_ids: [entityIdentity(slice, 'instruction', address)],
  ranges: [{ start: { image_id: image, space: 'va', value: address }, size: 4n }],
  evidence_ids: [],
  synthetic: [],
});
const isFloatingIncidental = (record: { rule?: string; reason?: string }): boolean =>
  record.rule === 'incidental_result' && record.reason?.includes('vector store') === true;

/** Darwin `void reset(struct reader *r) { release(r->owner); memset(r, 0, 32); }`:
 * `release` leaves its result in x0, then `movi v0.2d, #0` fills v0 for two
 * 128-bit stores. As after constant folding, each 64-bit cell of v0 holds its
 * own constant; only the `movi` instruction links them to the stored zero. */
function vectorFill() {
  const abi = darwinArm64Abi;
  const x0 = abi.unknown_call_clobbers.registers.find(
    (item) => item.root === 'arm64:x0' && item.width_bits === 64,
  )!;
  const x19 = abi.preserved.find((item) => item.root === 'arm64:x19' && item.width_bits === 64)!;
  const fp = register(
    abi.classifyCall({ returns: f64, parameters: [], variadic: false, fixed_parameter_count: 0 })
      .returns[0],
  );
  const cell = (offset: number): RegisterDescriptor => ({
    ...fp,
    id: `${fp.root}:${offset}:64`,
    offset_bits: offset,
    width_bits: 64,
    write_rule: 'preserve_other_bits',
  });
  const b = builder('vector-fill'),
    block = b.block('entry');
  const reader = block.readRegister(x0);
  block.writeRegister(x19, reader);
  block.writeRegister(x0, block.load(u64, reader));
  block.call(
    { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
    [],
    [],
    abi.unknown_call_clobbers,
  );
  block.source(site(0x1010n));
  const zero = block.constant(integer(128), 0n);
  block.writeRegister(cell(0), block.constant(u64, 0n));
  block.writeRegister(cell(64), block.constant(u64, 0n));
  block.source(site(0x1014n));
  const base = block.readRegister(x19);
  block.store(base, zero);
  block.store(block.int('add', base, block.constant(u64, 16n)), zero);
  block.return([]);
  const ir = constructSSA(b.finish(block, [])).value as SSAForm;
  const callId = ir.blocks[0]!.instructions.find((node) => node.kind === 'call')!.id;
  const source: SourceEvidence = {
    abi,
    addresses: [],
    callees: [
      {
        call_id: callId,
        parameters: [x0],
        returns: [x0],
        argument_list_complete: true,
        evidence_ids: [],
      },
    ],
  };
  const view = (kind: 'source' | 'checked') =>
    reconstruct(
      { function: structureControlFlow(ir, createOperationContext()).value!, source },
      createOperationContext(),
      kind,
    );
  return { ir, source, view, fp };
}

test('darwin-arm64 a vector zero-fill temporary in v0 is no result', () => {
  const fixture = vectorFill();
  const source = fixture.view('source');
  for (const projection of source.returns.values()) {
    assert.equal(projection.results.length, 0);
    assert.equal(projection.outputs.length, 0);
    for (const root of ['arm64:x0', fixture.fp.root])
      assert.ok(projection.exit_scratch?.some((slice) => slice.register.root === root));
  }
  assert.ok(source.local_validation?.some(isFloatingIncidental));
  assert.ok(
    source.local_validation?.some(
      (record) =>
        record.rule === 'incidental_result' &&
        record.reason?.includes('a call result left in place before later effects'),
    ),
  );
  assert.ok(
    source.local_validation_session?.abiConformance.some(
      (site) =>
        site.rule === 'incidental_result' && site.explanation.includes('floating-point result'),
    ),
  );
  // The checked view keeps the exact physical exit state.
  const checked = fixture.view('checked');
  assert.ok(!checked.local_validation?.some(isFloatingIncidental));
  for (const projection of checked.returns.values()) {
    assert.equal(projection.exit_scratch, undefined);
    assert.ok(projection.outputs.some((binding) => binding.register.root === fixture.fp.root));
  }
  for (const language of ['c-like', 'python-like'] as const) {
    const { emission } = emit(fixture.ir, { source: fixture.source }, language);
    assert.match(emission.text, language === 'c-like' ? /^void fn_/m : /-> void:/);
    assert.doesNotMatch(emission.text, /physical_return|\breturn [^;\n]/);
    const formals = emittedFormals(emission);
    assert.equal(formals.length, 1);
    const memory = new Map<bigint, number>();
    for (let byte = 0n; byte < 40n; byte++) memory.set(0x3000n + byte, Number(byte) + 1);
    const released: bigint[][] = [];
    const observed = execute(
      emission,
      new Map([[formals[0]!.statement_id, 0x3000n]]),
      memory,
      0n,
      new Map(),
      new Map(),
      new Map([
        [
          'sub_2000',
          (arguments_: readonly bigint[]) => {
            released.push([...arguments_]);
            return 0x55n;
          },
        ],
      ]),
    );
    assert.deepEqual(released, [[0x0807060504030201n]]);
    for (let byte = 0n; byte < 40n; byte++)
      assert.equal(observed.memory.get(0x3000n + byte), byte < 32n ? 0 : Number(byte) + 1);
    assert.deepEqual(observed.values, []);
  }
});

/** `struct big copy(const struct big *in)` through the hidden result pointer
 * (SysV rdi, Win64 rcx), which the ABI echoes in rax (moved there first, as
 * compilers schedule it): a 128-bit `movups` copy
 * through xmm0 plus a 64-bit tail move. `scalar` instead moves the first u64
 * through the low FP lane and stores it at its own width; `vector` packs the
 * two u64 halves into a written vector of two lanes before the 128-bit store. */
function hiddenResultCopy(abi: AbiProfile, mode: 'copy' | 'scalar' | 'vector') {
  const layout = abi.classifyCall({
    returns: word,
    parameters: [{ kind: 'pointer' }, { kind: 'pointer' }],
    variadic: false,
    fixed_parameter_count: 2,
  });
  const out = register(layout.parameters[0]!.locations[0]),
    input = register(layout.parameters[1]!.locations[0]),
    result = register(layout.returns[0]);
  const xmm0 = register(
    abi.classifyCall({ returns: f64, parameters: [], variadic: false, fixed_parameter_count: 0 })
      .returns[0],
  );
  const b = builder(`hidden-result-copy-${abi.id}-${mode}`),
    block = b.block('entry');
  const destination = block.readRegister(out),
    from = block.readRegister(input);
  block.writeRegister(result, destination);
  const offset = (base: typeof from, bytes: bigint) =>
    block.int('add', base, block.constant(u64, bytes));
  if (mode === 'scalar') {
    const head = block.load(u64, from);
    block.writeRegister({ ...xmm0, id: `${xmm0.root}:0:64`, width_bits: 64 }, head);
    block.store(destination, head);
    block.store(offset(destination, 8n), block.load(u64, offset(from, 8n)));
  } else {
    const copy =
      mode === 'vector'
        ? block.pack({ kind: 'vector', element: u64, lanes: 2 }, [
            block.load(u64, from),
            block.load(u64, offset(from, 8n)),
          ])
        : block.load(integer(128), from);
    block.writeRegister(xmm0, copy);
    block.store(destination, copy);
  }
  block.store(offset(destination, 16n), block.load(u64, offset(from, 16n)));
  block.return([]);
  const ir = constructSSA(b.finish(block, [])).value as SSAForm;
  const source: SourceEvidence = { abi, callees: [], addresses: [] };
  const view = (kind: 'source' | 'checked') =>
    reconstruct(
      { function: structureControlFlow(ir, createOperationContext()).value!, source },
      createOperationContext(),
      kind,
    );
  return { ir, source, view, xmm0, result };
}

/** Executes a hidden-result copy of 24 patterned bytes from 0x3000 to 0x4000. */
const runCopy = (
  fixture: { ir: SSAForm; source: SourceEvidence },
  language: 'c-like' | 'python-like',
) => {
  const { emission } = emit(fixture.ir, { source: fixture.source }, language);
  const formals = emittedFormals(emission);
  assert.equal(formals.length, 2);
  const memory = new Map<bigint, number>();
  for (let byte = 0n; byte < 24n; byte++) {
    memory.set(0x3000n + byte, Number(byte) * 7 + 3);
    memory.set(0x4000n + byte, 0);
  }
  const observed = execute(
    emission,
    new Map([
      [formals[0]!.statement_id, 0x4000n],
      [formals[1]!.statement_id, 0x3000n],
    ]),
    memory,
  );
  for (let byte = 0n; byte < 24n; byte++)
    assert.equal(observed.memory.get(0x4000n + byte), Number(byte) * 7 + 3);
  return { text: emission.text, values: observed.values, formals };
};

for (const abi of [sysvAMD64Abi, windowsX64Abi])
  test(`${abi.id} a 128-bit copy temporary in xmm0 leaves the echoed hidden result pointer`, () => {
    const fixture = hiddenResultCopy(abi, 'copy');
    const source = fixture.view('source');
    for (const projection of source.returns.values()) {
      assert.equal(projection.results.length, 1);
      assert.equal(projection.outputs.length, 0);
      assert.ok(
        projection.exit_scratch?.some((slice) => slice.register.root === fixture.xmm0.root),
      );
    }
    assert.ok(source.local_validation?.some(isFloatingIncidental));
    assert.ok(
      source.local_validation_session?.abiConformance.some(
        (site) => site.rule === 'incidental_result',
      ),
    );
    const checked = fixture.view('checked');
    assert.ok(!checked.local_validation?.some(isFloatingIncidental));
    for (const projection of checked.returns.values()) {
      assert.equal(projection.exit_scratch, undefined);
      assert.ok(projection.outputs.some((binding) => binding.register.root === fixture.xmm0.root));
    }
    for (const language of ['c-like', 'python-like'] as const) {
      const { text, values, formals } = runCopy(fixture, language);
      assert.doesNotMatch(text, /physical_return|^void fn_|-> void:/m);
      assert.match(text, new RegExp(`\\breturn ${formals[0]!.name}\\b`));
      assert.deepEqual(values, [0x4000n]);
    }
  });

test('a 64-bit untyped FP value stored at its own width and returned keeps the explicit form', () => {
  const fixture = hiddenResultCopy(sysvAMD64Abi, 'scalar');
  const source = fixture.view('source');
  assert.ok(!source.local_validation?.some(isFloatingIncidental));
  assert.ok(
    source.local_validation?.some(
      (record) =>
        record.rule === 'primary_result' && record.reason?.includes('without typed IEEE evidence'),
    ),
  );
  for (const language of ['c-like', 'python-like'] as const) {
    const { text } = runCopy(fixture, language);
    assert.match(text, /physical_return\(/);
  }
});

// The test oracle executes no vector memory; the typed path is checked on the plan.
test('a vector-typed 128-bit copy in xmm0 keeps the typed vector path', () => {
  const fixture = hiddenResultCopy(sysvAMD64Abi, 'vector');
  const source = fixture.view('source');
  assert.ok(!source.local_validation?.some(isFloatingIncidental));
  for (const projection of source.returns.values()) {
    assert.equal(projection.results.length, 1);
    assert.equal(projection.results[0]!.type.kind, 'vector');
  }
});

/** AAPCS64 `double from_bits(uint64_t m, uint64_t p, uint64_t *out)` that builds
 * its result in integer registers like `sqlite3Fp10Convert2`: `p == 0` returns
 * `movi v0.2d, #0`; otherwise x0 first receives the scratch value `p + 1`, then
 * `fmov d0, x8` moves `m ^ p` into the FP result register (zeroing the upper
 * lane). `float` moves the low 32 bits with `fmov s0, w8`. The negatives also
 * store the value through `out`, pass it to a call, write literal bits
 * instead, set a non-zero literal upper lane, or record caller demand for x0
 * (which then also holds 0 on the early exit: a demanded x0 left unchanged on
 * some exit fails the source return invariant, also without this rule). */
type IntegerBuilt = 'double' | 'float' | 'stored' | 'call' | 'literal' | 'upper' | 'demanded';
function integerBuiltFloat(variant: IntegerBuilt) {
  const abi = darwinArm64Abi;
  const layout = abi.classifyCall({
    returns: word,
    parameters: [word, word, { kind: 'pointer' }],
    variadic: false,
    fixed_parameter_count: 3,
  });
  const [x0, x1, x2] = layout.parameters.map((parameter) => register(parameter.locations[0]));
  const v0 = register(
    abi.classifyCall({ returns: f64, parameters: [], variadic: false, fixed_parameter_count: 0 })
      .returns[0],
  );
  const v0Slice = (
    id: string,
    offset: number,
    width: number,
    rule: RegisterDescriptor['write_rule'],
  ): RegisterDescriptor => ({
    ...v0,
    id,
    offset_bits: offset,
    width_bits: width,
    root_width_bits: 128,
    write_rule: rule,
  });
  const b = builder(`integer-built-float-${variant}`),
    entry = b.block('entry'),
    zero = b.block('zero'),
    build = b.block('build');
  const m = entry.readRegister(x0!),
    p = entry.readRegister(x1!);
  entry.branch(
    entry.compare('eq', p, entry.constant(u64, 0n)),
    entry.edge(zero),
    entry.edge(build),
  );
  if (variant === 'demanded') zero.writeRegister(x0!, zero.constant(u64, 0n));
  zero.writeRegister(v0Slice('arm64:q0', 0, 128, 'replace_root'), zero.constant(integer(128), 0n));
  zero.return([]);
  const value = build.int('xor', m, p);
  if (variant === 'stored') build.store(build.readRegister(x2!), value);
  if (variant === 'call')
    build.call(
      { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
      [value],
      [],
      abi.unknown_call_clobbers,
    );
  build.writeRegister(x0!, build.int('add', p, build.constant(u64, 1n)));
  if (variant === 'float')
    build.writeRegister(
      v0Slice('arm64:s0', 0, 32, 'zero_extend_root'),
      build.cast('truncate', integer(32), value),
    );
  else
    build.writeRegister(
      v0Slice('arm64:d0', 0, 64, 'zero_extend_root'),
      variant === 'literal' ? build.constant(u64, bits(1.5)) : value,
    );
  if (variant === 'upper')
    build.writeRegister(
      v0Slice('arm64:v0:64:64', 64, 64, 'preserve_other_bits'),
      build.constant(u64, 1n),
    );
  build.return([]);
  const ir = constructSSA(b.finish(entry, [])).value as SSAForm;
  const source: SourceEvidence = {
    abi,
    callees: [],
    addresses: [],
    ...(variant === 'demanded' ? { function_return_demands: [x0!] } : {}),
  };
  const view = (kind: 'source' | 'checked') =>
    reconstruct(
      { function: structureControlFlow(ir, createOperationContext()).value!, source },
      createOperationContext(),
      kind,
    );
  return { ir, source, view };
}

const isUntypedScalar = (record: { rule?: string; reason?: string }): boolean =>
  record.rule === 'primary_result' &&
  record.reason?.includes('untyped scalar FP value consumed only by exits') === true;

for (const [variant, type, targets] of [
  [
    'double',
    f64,
    [
      0x7ff8000000000123n, // quiet NaN with payload
      0x7ff0000000000001n, // signaling NaN
      0xfff8dead0000beefn, // negative NaN with payload
      0x8000000000000000n, // -0.0
      0x7ff0000000000000n, // +inf
      0xfff0000000000000n, // -inf
      bits(-2.75),
    ],
  ],
  [
    'float',
    { kind: 'float', bits: 32 } as const,
    [0x7fc00123n, 0x7f800001n, 0xffc0beefn, 0x80000000n, 0x7f800000n, 0xff800000n],
  ],
] as const)
  test(`darwin-arm64 an integer-built ${variant} in the FP register written after x0 is the ${variant} result`, () => {
    const fixture = integerBuiltFloat(variant);
    const source = fixture.view('source');
    for (const projection of source.returns.values()) {
      assert.equal(projection.results.length, 1);
      assert.deepEqual(projection.results[0]!.type, type);
      assert.equal(projection.outputs.length, 0);
    }
    assert.ok(source.local_validation?.some(isUntypedScalar));
    assert.ok(
      source.local_validation_session?.abiConformance.some(
        (site) =>
          site.rule === 'primary_result' &&
          site.explanation.includes(
            'a scalar FP-bank result is IEEE; callers read no integer result',
          ),
      ),
    );
    // The checked view keeps the exact physical exit state.
    const checked = fixture.view('checked');
    assert.ok(!checked.local_validation?.some(isUntypedScalar));
    for (const projection of checked.returns.values())
      assert.ok(!projection.results.some((value) => value.type.kind === 'float'));
    for (const language of ['c-like', 'python-like'] as const) {
      const { emission } = emit(fixture.ir, { source: fixture.source }, language);
      assert.match(
        emission.text,
        language === 'c-like' ? new RegExp(`^${variant} fn_`, 'm') : new RegExp(`-> ${variant}:`),
      );
      assert.doesNotMatch(emission.text, /physical_return/);
      const formals = emittedFormals(emission);
      assert.equal(formals.length, 2);
      const mask = (1n << BigInt(type.bits)) - 1n;
      for (const [m, p, expected] of [
        [0x1234n, 0n, 0n],
        ...targets.map((target) => [target ^ 0x5a5a00000001n, 0x5a5a00000001n, target] as const),
      ] as const) {
        const observed = execute(
          emission,
          new Map([
            [formals[0]!.statement_id, m],
            [formals[1]!.statement_id, p],
          ]),
        );
        assert.deepEqual(observed.values, [expected & mask]);
      }
    }
  });

for (const variant of ['stored', 'call', 'literal', 'upper', 'demanded'] as const)
  test(`darwin-arm64 an integer-built FP value that is ${variant === 'stored' ? 'also stored' : variant === 'call' ? 'also passed to a call' : variant === 'literal' ? 'a literal on every exit' : variant === 'upper' ? 'below a non-zero upper lane' : 'beside a demanded x0'} is no FP result`, () => {
    const fixture = integerBuiltFloat(variant);
    const source = fixture.view('source');
    assert.ok(!source.local_validation?.some(isUntypedScalar));
    for (const projection of source.returns.values())
      assert.ok(!projection.results.some((value) => value.type.kind === 'float'));
    for (const language of ['c-like', 'python-like'] as const) {
      const { emission } = emit(fixture.ir, { source: fixture.source }, language);
      assert.doesNotMatch(emission.text, /^(double|float) fn_|-> (double|float):/m);
      // Without the rule the FP register written after x0 stays explicit;
      // caller demand for x0 makes x0 the result instead.
      if (variant === 'demanded') assert.match(emission.text, /^uint64_t fn_|-> uint64_t:/m);
      else assert.match(emission.text, /physical_return\(/);
    }
  });

/** Darwin `g(p) { if (!p) return 7; return h(p); }` where `h` is a tail whose callee
 * interface has no result types. Caller demand on w0 types the tail result. */
function demandedTail(demand: boolean) {
  const abi = darwinArm64Abi;
  const x0 = register(
    abi.classifyCall({
      returns: word,
      parameters: [word],
      variadic: false,
      fixed_parameter_count: 1,
    }).returns[0],
  );
  const b = builder(`demanded-tail-${demand}`),
    entry = b.block('entry'),
    literal = b.block('literal'),
    tail = b.block('tail');
  const p = entry.readRegister(x0);
  entry.branch(
    entry.compare('eq', p, entry.constant(u64, 0n)),
    entry.edge(literal),
    entry.edge(tail),
  );
  literal.writeRegister(x0, literal.constant(u64, 7n));
  literal.return([]);
  tail.terminate({
    kind: 'indirect',
    target: tail.address({ image_id: image, space: 'va', value: 0x2000n }),
    tail_call: true,
    reason: 'Discovered tail-call exit',
  });
  const ir = constructSSA(b.finish(entry, [])).value as SSAForm;
  const control = ir.blocks.find((block) => block.terminator.kind === 'indirect')!.terminator;
  const source: SourceEvidence = {
    abi,
    addresses: [],
    callees: [
      {
        call_id: control.id,
        target: { image_id: image, space: 'va', value: 0x2000n },
        parameters: [x0],
        returns: [],
        argument_list_complete: true,
        evidence_ids: [],
      },
    ],
    ...(demand
      ? {
          caller_result_demands: () => ({
            registers: [{ ...x0, width_bits: 32 }],
            sites: [{ image_id: image, space: 'va' as const, value: 0x3000n }],
          }),
        }
      : {}),
  };
  const view = (kind: 'source' | 'checked') =>
    reconstruct(
      { function: structureControlFlow(ir, createOperationContext()).value!, source },
      createOperationContext(),
      kind,
    );
  return { ir, source, view };
}

test('caller demand types a tail whose callee has no result types', () => {
  const plain = demandedTail(false).view('source');
  assert.equal(plain.source?.return_type ?? null, null);
  const fixture = demandedTail(true);
  const program = fixture.view('source');
  assert.equal(program.source?.return_type?.kind, 'integer');
  assert.ok(program.local_validation?.some((record) => record.rule === 'tail_result_width'));
  assert.equal(fixture.view('checked').source?.caller_result_demands, undefined);
  for (const language of ['c-like', 'python-like'] as const) {
    const { emission } = emit(fixture.ir, { source: fixture.source }, language);
    assert.doesNotMatch(emission.text, /unknown_result|^void /m);
    const formals = emittedFormals(emission);
    for (const [input, expected] of [
      [0n, 7n],
      [5n, 0x1234n],
    ] as const) {
      const observed = execute(
        emission,
        new Map([[formals[0]!.statement_id, input]]),
        new Map(),
        0n,
        new Map(),
        new Map(),
        new Map([
          ['sub_2000', (args: readonly bigint[]) => (assert.deepEqual(args, [input]), 0x1234n)],
          ['0x2000', (args: readonly bigint[]) => (assert.deepEqual(args, [input]), 0x1234n)],
        ]),
      );
      assert.deepEqual(observed.values, [expected]);
    }
  }
});

/** The `caller-result-use-source.c` V2 cases through the IR-builder path. Darwin
 * `static void g(p) { *p = 5; h(p); }` compiled as a tail transfer to `h` (an observed
 * callee with no result types), so the body alone reads as `return h(p);`.
 * `recursive`: `if (p[1]) { g(p[1]); return; } h(p);`, the self-call result left in x0.
 * `table` and `exported` are the same body whose closed-world consensus abstains (its
 * address is stored, or it is exported): no `function_result_use` answer. */
function consensusTail(variant: 'ignored' | 'recursive' | 'table' | 'exported') {
  const abi = darwinArm64Abi;
  const x0 = register(
    abi.classifyCall({
      returns: word,
      parameters: [word],
      variadic: false,
      fixed_parameter_count: 1,
    }).returns[0],
  );
  const target = { image_id: image, space: 'va' as const, value: 0x2000n };
  const b = builder(`consensus-tail-${variant}`),
    entry = b.block('entry'),
    tail = b.block('tail');
  const p = entry.readRegister(x0);
  entry.store(p, entry.constant(u64, 5n));
  if (variant === 'recursive') {
    const again = b.block('again');
    const x19 = abi.preserved.find((item) => item.root === 'arm64:x19' && item.width_bits === 64)!;
    const next = entry.load(u64, entry.int('add', p, entry.constant(u64, 8n)));
    entry.writeRegister(x19, next);
    entry.branch(
      entry.compare('eq', next, entry.constant(u64, 0n)),
      entry.edge(tail),
      entry.edge(again),
    );
    again.writeRegister(x0, again.readRegister(x19));
    again.call(
      { kind: 'direct', address: { image_id: image, space: 'va', value: 0x1000n } },
      [],
      [],
      abi.unknown_call_clobbers,
    );
    again.return([]);
  } else entry.jump(tail);
  tail.terminate({
    kind: 'indirect',
    target: tail.address(target),
    tail_call: true,
    reason: 'Discovered tail-call exit',
  });
  const ir = constructSSA(b.finish(entry, [])).value as SSAForm;
  const control = ir.blocks.find((block) => block.terminator.kind === 'indirect')!.terminator;
  const self = ir.blocks.flatMap((block) => block.instructions).find((node) => node.kind === 'call');
  const asked: boolean[] = [];
  const source: SourceEvidence = {
    abi,
    addresses: [],
    callees: [
      {
        call_id: control.id,
        target,
        parameter_state: 'observed',
        parameters: [x0],
        returns: [],
        argument_list_complete: true,
        evidence_ids: [],
      },
      ...(self
        ? [
            {
              call_id: self.id,
              target: { image_id: image, space: 'va' as const, value: 0x1000n },
              parameter_state: 'observed' as const,
              parameters: [x0],
              returns: [],
              argument_list_complete: true,
              evidence_ids: [],
            },
          ]
        : []),
    ],
    function_result_use: (_context, floating) => {
      asked.push(floating);
      return variant === 'ignored' || variant === 'recursive'
        ? {
            consensus: 'ignored',
            sites: [{ image_id: image, space: 'va', value: 0x3000n }],
          }
        : undefined;
    },
  };
  const view = (kind: 'source' | 'checked') =>
    reconstruct(
      { function: structureControlFlow(ir, createOperationContext()).value!, source },
      createOperationContext(),
      kind,
    );
  return { ir, source, view, asked };
}

for (const variant of ['ignored', 'recursive', 'table', 'exported'] as const)
  test(`caller consensus: ${variant} tail-only void function`, () => {
    const fixture = consensusTail(variant);
    const program = fixture.view('source');
    const consensus = variant === 'ignored' || variant === 'recursive';
    // The observed tail callee writes no FP result and the FP carrier is untouched:
    // only the integer result register is followed into callers.
    assert.deepEqual(fixture.asked, [false]);
    assert.equal(program.source?.return_type ?? null, null);
    assert.equal(program.source?.void_like_result, consensus ? 'caller_consensus' : undefined);
    assert.equal(
      program.local_validation?.some((record) => record.rule === 'caller_consensus') ?? false,
      consensus,
    );
    assert.equal(
      program.local_validation_session?.abiConformance.some(
        (site) => site.rule === 'caller_consensus',
      ) ?? false,
      consensus,
    );
    for (const tail of program.tails.values()) assert.equal(tail.result_void === true, consensus);
    // The checked view never reads the consensus.
    const { function_result_use: _unused, ...plain } = fixture.source;
    for (const language of ['c-like', 'python-like'] as const)
      assert.equal(
        emit(fixture.ir, { source: fixture.source }, language, 'checked').emission.text,
        emit(fixture.ir, { source: plain }, language, 'checked').emission.text,
      );
    for (const language of ['c-like', 'python-like'] as const) {
      const { emission } = emit(fixture.ir, { source: fixture.source }, language);
      if (consensus)
        assert.match(emission.text, language === 'c-like' ? /^void \w+\(/m : /\) -> void:$/m);
      else assert.doesNotMatch(emission.text, /^void \w+\(|\) -> void:$/m);
      const formals = emittedFormals(emission);
      const pointer = 0x4000n;
      for (const next of variant === 'recursive' ? [0n, 0x5000n] : [0n]) {
        const memory = new Map<bigint, number>();
        for (let byte = 0n; byte < 8n; byte++) {
          memory.set(pointer + byte, 0);
          memory.set(pointer + 8n + byte, Number((next >> (8n * byte)) & 0xffn));
        }
        const calls: string[] = [];
        const oracle =
          (name: string) =>
          (args: readonly bigint[]): bigint => {
            calls.push(`${name}(${args.map((arg) => `0x${arg.toString(16)}`).join(', ')})`);
            return 0x77n;
          };
        const observed = execute(
          emission,
          new Map([[formals[0]!.statement_id, pointer]]),
          memory,
          0n,
          new Map(),
          new Map(),
          new Map([
            ['sub_2000', oracle('h')],
            ['0x2000', oracle('h')],
            ['sub_1000', oracle('g')],
            ['0x1000', oracle('g')],
          ]),
        );
        // `*p = 5`, then `h(p)` or the recursive `g(p[1])`; a void function yields nothing.
        assert.equal(observed.memory.get(pointer), 5);
        assert.deepEqual(calls, next ? ['g(0x5000)'] : ['h(0x4000)']);
        if (consensus) assert.deepEqual(observed.values, []);
      }
    }
  });

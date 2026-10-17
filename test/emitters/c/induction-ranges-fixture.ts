import assert from 'node:assert/strict';
import { createOperationContext, entityIdentity } from '../../../src/core/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { IRBuilder, integer, type SSAForm, type Value } from '../../../src/ir/index.js';
import { structureControlFlow } from '../../../src/presentation/index.js';
import { reconstruct } from '../../../src/reconstruction/index.js';
import { builder, provenance, register, slice } from '../../ir/support.js';
import { emit, execute } from './support.js';

const i32 = integer(32), i64 = integer(64);
const source = { abi: new DarwinArm64Abi(), callees: [], addresses: [] };
type Mode = 'guarded' | 'unsigned-guard' | 'signed-guard' | 'unguarded' | 'wrong-backedge' | 'extra-phi';
const root = (index: number) => register(`arm64:x${index}`, 64, 0, 'replace_root', `arm64:x${index}`);
const word = (index: number) => register(`arm64:w${index}`, 32, 0, 'zero_extend_root', `arm64:x${index}`);

/** Independent source algorithm, using uint64_t modulo arithmetic:
 * if (guarded && n==0) return 0; // signed variant instead tests (int32_t)n>=0
 * counter=(uint32_t)n + (extra_entry ? 2^32 : 0); iteration=0;
 * for (;;) {
 *   *journal=counter;
 *   if (iteration==limit) return counter;
 *   counter--; iteration++;
 *   if (guarded_backedge && counter==0) return 0;
 * }
 * Limit gives an independent early exit, allowing UINT32_MAX to be exercised
 * without billions of iterations. Unguarded/backedge/extra-entry variants are
 * counterexamples to inferring a zero high cell from initialization alone.
 */
function countdown(mode: Mode): { ir: SSAForm; high: Value } {
  const b = builder(`guarded-range-${mode}`), entry = b.block('entry');
  const initialize = b.block('initialize'), header = b.block('header');
  const step = b.block('step'), early = b.block('early'), done = b.block('done');
  const initial = entry.readRegister(word(0));
  entry.readRegister(root(1));
  if (mode === 'unguarded') entry.jump(initialize);
  else if (mode === 'unsigned-guard' || mode === 'signed-guard')
    entry.branch(entry.compare(mode === 'unsigned-guard' ? 'ugt' : 'sge', initial, entry.constant(i32, 0n)),
      entry.edge(initialize), entry.edge(done));
  else entry.branch(entry.compare('eq', initial, entry.constant(i32, 0n)), entry.edge(done), entry.edge(initialize));
  const seed = (block: typeof entry, high: boolean) => {
    block.writeRegister(word(9), block.readRegister(word(0)));
    if (high) block.writeRegister(root(9), block.int('add', block.readRegister(root(9)), block.constant(i64, 1n << 32n)));
    block.writeRegister(root(10), block.constant(i64, 0n));
    block.jump(header);
  };
  if (mode === 'extra-phi') {
    const low = b.block('low-entry'), high = b.block('high-entry');
    initialize.branch(initialize.compare('eq', initialize.readRegister(root(2)), initialize.constant(i64, 0n)),
      initialize.edge(low), initialize.edge(high));
    seed(low, false); seed(high, true);
  } else seed(initialize, false);
  header.store(header.constant(i64, 0x1000n), header.readRegister(root(9)));
  header.branch(header.compare('eq', header.readRegister(root(10)), header.readRegister(root(1))),
    header.edge(early), header.edge(step));
  const next = step.int('sub', step.readRegister(root(9)), step.constant(i64, 1n));
  step.writeRegister(root(9), next);
  step.writeRegister(root(10), step.int('add', step.readRegister(root(10)), step.constant(i64, 1n)));
  if (mode === 'wrong-backedge') step.jump(header);
  else step.branch(step.compare('ne', next, step.constant(i64, 0n)), step.edge(header), step.edge(done));
  early.return([early.readRegister(root(9))]);
  done.return([done.constant(i64, 0n)]);
  const converted = constructSSA(b.finish(entry, [i64]));
  assert.equal(converted.state, 'complete'); assert.equal(converted.value.form, 'ssa');
  if (converted.value.form !== 'ssa') assert.fail('Expected SSA');
  const ir = converted.value;
  const loop = ir.blocks.find((block) => block.instructions.some((node) => node.kind === 'store'))!;
  const high = ir.register_states.find((state) => state.block === loop.id)!.entry.find((binding) =>
    binding.register.root === 'arm64:x9' && binding.register.offset_bits === 32)!.value;
  return { ir, high };
}
function oracle(mode: Mode, count: bigint, limit: number, selected: bigint) {
  if (mode === 'signed-guard') {
    if (BigInt.asIntN(32, count) < 0n) return { value: 0n, journal: 0n, stores: 0 };
  } else if (mode !== 'unguarded' && count === 0n) return { value: 0n, journal: 0n, stores: 0 };
  let counter = count + (mode === 'extra-phi' && selected !== 0n ? 1n << 32n : 0n);
  let stores = 0, journal = 0n;
  for (let iteration = 0; ; iteration++) {
    journal = counter; stores++;
    if (iteration === limit) return { value: counter, journal, stores };
    counter = BigInt.asUintN(64, counter - 1n);
    if (mode !== 'wrong-backedge' && counter === 0n) return { value: 0n, journal, stores };
  }
}
function constant(ir: SSAForm, value: Value): bigint | null {
  const structured = structureControlFlow(ir, createOperationContext()); assert.ok(structured.value);
  const program = reconstruct({ function: structured.value, source }, createOperationContext());
  const seen = new Set<string>();
  while (!seen.has(value.id)) {
    seen.add(value.id);
    const expression = program.expressions.get(value.id);
    if (expression?.kind === 'constant') return expression.bits;
    if (expression?.kind !== 'cast' || expression.op !== 'bitcast') return null;
    value = expression.value;
  }
  return null;
}

/** A singleton payload is not a proof of definedness. These incoming phi values
 * have mathematically zero high bits but strict unknown/undefined dependencies.
 */
function unknownCell(undefinedOperand: boolean): { ir: SSAForm; high: Value } {
  const b = new IRBuilder(slice, entityIdentity(slice, 'function', `range-unknown-cell-${undefinedOperand}`), provenance, 'ssa');
  const entry = b.block('entry'), joined = b.block('joined', [i32]);
  const input = undefinedOperand
    ? entry.int('udiv', entry.constant(i32, 1n), entry.constant(i32, 0n))
    : entry.indeterminate(i32, 'unknown', 'unknown counterexample operand');
  const extended = entry.cast('zero_extend', i64, input);
  entry.jump(joined, [entry.extract(extended, 32, 32)]);
  joined.return([joined.concat([joined.constant(i32, 0n), joined.parameters[0]!])]);
  return { ir: b.finish(entry, [i64]), high: joined.parameters[0]! };
}

export function checkGuardedRangeCounterexamples(): { observations: number; modes: number } {
  let observations = 0;
  for (const mode of ['guarded', 'unsigned-guard', 'signed-guard', 'unguarded', 'wrong-backedge', 'extra-phi'] as const) {
    const { ir, high } = countdown(mode);
    if (mode === 'guarded' || mode === 'unsigned-guard')
      assert.equal(constant(ir, high), 0n, 'Guarded countdown proves its high phi cell zero');
    else assert.notEqual(constant(ir, high), 0n, `${mode}: do not infer a zero high cell without all incoming edge proofs`);
    const entry = ir.blocks.find((block) => block.id === ir.entry)!;
    const bindings = ir.register_states.find((state) => state.block === ir.entry)!.entry;
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(ir, { source }, language);
      for (const count of [0n, 1n, 2n, 3n, 0xffffffffn]) for (const limit of [0, 1, 2, 3])
        for (const selected of mode === 'extra-phi' ? [0n, 1n] : [0n]) {
          const roots = new Map([['arm64:x0', count], ['arm64:x1', BigInt(limit)], ['arm64:x2', selected]]);
          const inputs = new Map(entry.parameters.map((value) => [value.id, 0n]));
          for (const binding of bindings)
            inputs.set(binding.value.id, BigInt.asUintN(binding.register.width_bits,
              (roots.get(binding.register.root) ?? 0n) >> BigInt(binding.register.offset_bits)));
          const memory = new Map(Array.from({ length: 8 }, (_, index) => [0x1000n + BigInt(index), 0]));
          const observed = execute(output.emission, inputs, memory), expected = oracle(mode, count, limit, selected);
          const label = `${language}/${mode}/${count}/${limit}/${selected}`;
          assert.equal(observed.exit, 'machine_return', label);
          assert.deepEqual(observed.values, [expected.value], label);
          assert.deepEqual(observed.events, Array.from({ length: expected.stores }, () => 'store'), label);
          let journal = 0n;
          for (let byte = 0; byte < 8; byte++) journal |= BigInt(observed.memory.get(0x1000n + BigInt(byte))!) << BigInt(byte * 8);
          assert.equal(journal, expected.journal, label); assert.deepEqual(observed.calls, []);
          observations++;
        }
    }
  }
  for (const undefinedOperand of [false, true]) {
    const { ir, high } = unknownCell(undefinedOperand);
    assert.notEqual(constant(ir, high), 0n, 'Singleton payload without definedness must remain explicit');
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(ir, { source }, language);
      assert.equal(execute(output.emission).exit, 'unknown'); observations++;
    }
  }
  return { observations, modes: 8 };
}

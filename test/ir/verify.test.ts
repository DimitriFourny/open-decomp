import assert from 'node:assert/strict';
import test from 'node:test';
import { entityIdentity } from '../../src/core/index.js';
import type { DecodedInstruction } from '../../src/core/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import {
  IRBuilder,
  IR_PROBLEM_MESSAGE,
  IRValidationError,
  assertValidIR,
  evaluateIR,
  floating,
  instructionProvenance,
  integer,
  mergeProvenance,
  syntheticProvenance,
  vector,
  verifyIR,
  withOrigins,
} from '../../src/ir/index.js';
import type { FunctionIR, Instruction, IRProblem, Value } from '../../src/ir/index.js';
import { builder, image, provenance, register, returned, slice } from './support.js';

const i1 = integer(1),
  i32 = integer(32),
  i64 = integer(64);
function baseProgram(): FunctionIR {
  const ir = builder('verification');
  const b = ir.block('entry');
  const a = b.constant(i32, 1n),
    c = b.constant(i32, 2n);
  b.return([b.int('add', a, c)]);
  return ir.finish(b, [i32]);
}
function replaceInstructions(ir: FunctionIR, instructions: readonly Instruction[]): FunctionIR {
  return { ...ir, blocks: [{ ...ir.blocks[0]!, instructions }, ...ir.blocks.slice(1)] };
}
function rejected(ir: FunctionIR, code: IRProblem['code']): void {
  assert.ok(verifyIR(ir).some((problem) => problem.code === code));
  assert.throws(() => assertValidIR(ir), IRValidationError);
  assert.throws(() => evaluateIR(ir), IRValidationError);
}

test('builders reject incompatible widths, malformed slices and vector lane shapes', () => {
  const ir = builder('types');
  const b = ir.block('entry');
  const a = b.constant(i32, 1n),
    c = b.constant(i64, 2n);
  assert.throws(() => b.int('add', a, c), TypeError);
  assert.throws(() => b.select(a, a, a), TypeError);
  assert.throws(() => b.extract(a, 31, 2), TypeError);
  assert.throws(() => b.insert(a, c, 0), TypeError);
  assert.throws(() => b.cast('truncate', i64, a), TypeError);
  assert.throws(() => b.cast('bitcast', floating(64), a), TypeError);
  assert.throws(() => b.pack(vector(i32, 4), [a, a]), TypeError);
  assert.throws(() => integer(0), RangeError);
  assert.throws(() => vector(i64, 100), RangeError);
  b.return([a]);
  const program = ir.finish(b, [i32]);
  const instructions = [...program.blocks[0]!.instructions];
  const first = instructions[0]!;
  assert.equal(first.kind, 'assign');
  if (first.kind !== 'assign') throw new TypeError('Expected definition');
  instructions[0] = { ...first, result: { ...first.result, type: integer(64) } };
  rejected(replaceInstructions(program, instructions), 'type');
});

test('verifier rejects missing, forward, nondominating and conflicting-type value references', () => {
  const ir = baseProgram();
  const nodes = [...ir.blocks[0]!.instructions];
  const first = nodes[0]!,
    last = nodes[2]!;
  if (first.kind !== 'assign' || last.kind !== 'assign' || last.expression.kind !== 'integer')
    throw new TypeError('Expected arithmetic definitions');
  const absent: Value = { id: entityIdentity(slice, 'absent', 'value'), type: i32 };
  rejected(
    replaceInstructions(ir, [
      ...nodes.slice(0, 2),
      { ...last, expression: { ...last.expression, left: absent } },
    ]),
    'reference',
  );
  rejected(replaceInstructions(ir, [last, ...nodes.slice(0, 2)]), 'reference');
  rejected(
    replaceInstructions(ir, [
      ...nodes.slice(0, 2),
      { ...last, expression: { ...last.expression, left: { ...first.result, type: i64 } } },
    ]),
    'type',
  );
  const dominated = builder('dominated-use');
  const top = dominated.block('entry'),
    below = dominated.block('successor');
  const available = top.constant(i32, 7n);
  top.jump(below);
  below.return([available]);
  assert.doesNotThrow(() => dominated.finish(top, [i32]), 'A dominating definition is available');
  const joined = builder('cross-block');
  const a = joined.block('entry'),
    left = joined.block('left'),
    right = joined.block('right'),
    b = joined.block('join');
  a.branch(a.constant(integer(1), 1n), a.edge(left), a.edge(right));
  const leaked = left.constant(i32, 7n);
  left.jump(b);
  right.jump(b);
  b.return([leaked]);
  assert.throws(() => joined.finish(a, [i32]), IRValidationError);
});

test('verifier rejects duplicate IDs, invalid origins, unknown targets and edge/return arity', () => {
  const ir = baseProgram();
  const block = ir.blocks[0]!;
  rejected({ ...ir, blocks: [block, block] }, 'identity');
  rejected(
    { ...ir, provenance: { instruction_ids: [], ranges: [], evidence_ids: [], synthetic: [] } },
    'provenance',
  );
  rejected({ ...ir, entry: entityIdentity(slice, 'missing', 1) }, 'control_flow');
  rejected({ ...ir, returns: [] }, 'control_flow');
  const graph = builder('arity');
  const entry = graph.block('entry'),
    target = graph.block('target', [i32]);
  entry.jump(target);
  target.return([target.parameters[0]!]);
  assert.throws(() => graph.finish(entry, [i32]), IRValidationError);
  const badTarget = {
    ...block.terminator,
    kind: 'jump' as const,
    edge: {
      target: entityIdentity(slice, 'missing', 2),
      arguments: [],
      effect: block.effect_parameter,
    },
  };
  rejected({ ...ir, blocks: [{ ...block, terminator: badTarget }] }, 'control_flow');
});

test('effect rewiring, reordering, stale edge tokens and SSA register operations are rejected', () => {
  const ir = builder('effects');
  const b = ir.block('entry');
  const pointer = b.constant(i64, 0n),
    value = b.constant(i32, 7n);
  b.store(pointer, value);
  const loaded = b.load(i32, pointer);
  b.return([loaded]);
  const program = ir.finish(b, [i32]);
  const block = program.blocks[0]!,
    nodes = [...block.instructions];
  const load = nodes.at(-1)!;
  if (load.kind !== 'load') throw new TypeError('Expected load');
  rejected(
    replaceInstructions(program, [
      ...nodes.slice(0, -1),
      { ...load, effect_in: block.effect_parameter },
    ]),
    'effect_order',
  );
  rejected(
    {
      ...program,
      blocks: [{ ...block, terminator: { ...block.terminator, effect: block.effect_parameter } }],
    },
    'effect_order',
  );
  const reg = builder('ssa-reg');
  const c = reg.block('entry');
  c.return([c.readRegister(register('rax', 64, 0, 'replace_root'))]);
  const registerProgram = reg.finish(c, [i64]);
  rejected(
    {
      ...registerProgram,
      form: 'ssa',
      register_states: registerProgram.blocks.map((block) => ({
        block: block.id,
        entry: [],
        exit: [],
      })),
    },
    'register',
  );
  const stale = builder('stale-edge');
  const entry = stale.block('entry'),
    exit = stale.block('exit');
  const edge = entry.edge(exit);
  entry.writeRegister(register('eax', 32, 0, 'zero_extend_root'), entry.constant(i32, 1n));
  entry.terminate({ kind: 'jump', edge });
  exit.return();
  assert.throws(() => stale.finish(entry), IRValidationError);
});

test('register root rules and unsupported optimistic call purity cannot pass validation', () => {
  const ir = builder('bad-register');
  const b = ir.block('entry');
  b.writeRegister(register('bad-eax', 32, 0, 'replace_root'), b.constant(i32, 1n));
  b.return();
  assert.throws(() => ir.finish(b), IRValidationError);
  const pure = builder('unproven-purity');
  const c = pure.block('entry');
  c.call({ kind: 'direct', address: { image_id: image, space: 'va', value: 0n } }, [], [], {
    registers: [],
    flags: [],
    memory: 'none',
  });
  c.return();
  assert.throws(() => pure.finish(c), IRValidationError);
  const memory = builder('nonbyte-load');
  const d = memory.block('entry');
  d.return([d.load(i1, d.constant(i64, 0n))]);
  assert.throws(() => memory.finish(d, [i1]), IRValidationError);
});

test('instruction/evidence provenance survives replacements and combinations with stable identity', () => {
  const make = (address: bigint): DecodedInstruction => ({
    id: entityIdentity(slice, 'instruction', address),
    address: { image_id: image, space: 'va', value: address },
    bytes: { start: { image_id: image, space: 'va', value: address }, size: 4n },
    size: 4,
    validity: 'valid',
    payload: null,
    flow: { kind: 'return' },
    diagnostics: [],
    evidence_ids: [`evidence_${'b'.repeat(64)}`],
  });
  const first = instructionProvenance(make(0x1000n)),
    second = instructionProvenance(make(0x1004n));
  const ir = new IRBuilder(slice, entityIdentity(slice, 'function', 'origin'), provenance);
  const b = ir.block('entry');
  b.source(first);
  const one = b.constant(i32, 1n);
  b.source(second);
  const two = b.constant(i32, 2n);
  const sum = b.int('add', one, two);
  b.return([sum]);
  const program = ir.finish(b, [i32]);
  const nodes = program.blocks[0]!.instructions;
  const replacement = withOrigins(
    { ...nodes[2]!, provenance: syntheticProvenance('Constant folding') },
    nodes[0]!,
    nodes[1]!,
  );
  assert.equal(replacement.id, nodes[2]!.id);
  assert.deepEqual(replacement.provenance.instruction_ids, [
    ...first.instruction_ids,
    ...second.instruction_ids,
  ]);
  assert.equal(replacement.provenance.ranges.length, 2);
  assert.equal(replacement.provenance.evidence_ids.length, 1);
  assert.deepEqual(mergeProvenance(first, second, first).instruction_ids, [
    ...first.instruction_ids,
    ...second.instruction_ids,
  ]);
  const rewritten = replaceInstructions(program, [nodes[0]!, nodes[1]!, replacement]);
  assert.deepEqual(returned(evaluateIR(rewritten)), [3n]);
  assert.deepEqual(program.provenance.instruction_ids, [
    ...first.instruction_ids,
    ...second.instruction_ids,
  ]);
});

test('block identities are stable across construction order; every block must terminate', () => {
  const functionId = entityIdentity(slice, 'function', 'identity-order');
  const first = new IRBuilder(slice, functionId, provenance),
    second = new IRBuilder(slice, functionId, provenance);
  const a = first.block(['address', 1n]);
  first.block(['address', 2n]);
  second.block(['address', 2n]);
  const b = second.block(['address', 1n]);
  assert.equal(a.id, b.id);
  assert.throws(() => first.block(['address', 1n]), TypeError);
  assert.throws(() => first.finish(a), TypeError);
});

test('shared provenance validation retains every origin-specific rejection and is invocation-local', () => {
  const program = baseProgram();
  const shared = { ...provenance, synthetic: [''] };
  const nodes = program.blocks[0]!.instructions.map((node) => ({ ...node, provenance: shared }));
  const broken = replaceInstructions(program, nodes);
  const problems = verifyIR(broken);
  const invalid = new Set(
    problems
      .filter(
        (problem) =>
          problem.code === 'provenance' && problem.message === IR_PROBLEM_MESSAGE.invalidProvenance,
      )
      .map((problem) => problem.node),
  );
  assert.deepEqual(invalid, new Set(nodes.map((node) => node.id)));
  assert.deepEqual(verifyIR(broken), problems);
  assert.deepEqual(verifyIR(program), []);
});

test('canonical binding layouts retain reordered, cloned and overlapping descriptor checks', () => {
  const ir = builder('canonical-binding-layout'),
    entry = ir.block('entry'),
    end = ir.block('end');
  entry.readRegister(register('r.low', 32, 0, 'preserve_other_bits', 'r'));
  entry.readRegister(register('r.high', 32, 32, 'preserve_other_bits', 'r'));
  entry.jump(end);
  end.return();
  const built = constructSSA(ir.finish(entry));
  if (built.value.form !== 'ssa') throw new TypeError('Expected SSA');
  const program = built.value;
  assert.deepEqual(verifyIR(program), []);
  const row = program.register_states[1]!;
  const replaceExit = (exit: typeof row.exit) => ({
    ...program,
    register_states: [program.register_states[0]!, { ...row, exit }],
  });
  assert.deepEqual(verifyIR(replaceExit([...row.exit].reverse())), []);
  assert.deepEqual(
    verifyIR(
      replaceExit(row.exit.map((binding) => ({ ...binding, register: { ...binding.register } }))),
    ),
    [],
  );
  const changed = row.exit.map((binding, index) =>
    index === 0 ? { ...binding, register: { ...binding.register, offset_bits: 16 } } : binding,
  );
  assert.ok(
    verifyIR(replaceExit(changed)).some(
      (problem) =>
        problem.code === 'register' && problem.message === IR_PROBLEM_MESSAGE.registerOverlap,
    ),
  );
  assert.ok(
    verifyIR(replaceExit(changed)).some(
      (problem) =>
        problem.code === 'register' && problem.message === IR_PROBLEM_MESSAGE.registerCoverage,
    ),
  );
  const overlapping = { ...program.register_states[0]!.entry[1]!.register, offset_bits: 16 };
  const overlap = {
    ...program,
    register_states: program.register_states.map((state) => ({
      ...state,
      entry: state.entry.map((binding, index) =>
        index === 1 ? { ...binding, register: overlapping } : binding,
      ),
      exit: state.exit.map((binding, index) =>
        index === 1 ? { ...binding, register: overlapping } : binding,
      ),
    })),
  };
  const reports = verifyIR(overlap).filter(
    (problem) =>
      problem.code === 'register' && problem.message === IR_PROBLEM_MESSAGE.registerOverlap,
  );
  assert.equal(reports.filter((problem) => problem.node === program.id).length, 1);
  // Each nonempty row naming the overlapping cell reports it once.
  for (const state of program.register_states)
    assert.equal(
      reports.filter((problem) => problem.node === state.block).length,
      Number(state.entry.length > 0) + Number(state.exit.length > 0),
    );
});

test('descriptor validation reuses only frozen flat cells and retains mutable clone diagnostics', () => {
  const low = register('mutable.low', 32, 0, 'preserve_other_bits', 'mutable'),
    high = register('mutable.high', 32, 32, 'preserve_other_bits', 'mutable');
  const ir = builder('descriptor-immutability'),
    entry = ir.block('entry'),
    end = ir.block('end');
  entry.readRegister(low);
  entry.readRegister(high);
  entry.jump(end);
  end.return();
  const built = constructSSA(ir.finish(entry));
  if (built.value.form !== 'ssa') throw new TypeError('Expected SSA');
  const program = built.value,
    first = program.register_states[0]!.entry[0]!.register;
  assert.ok(Object.isFrozen(first));
  assert.equal(Object.isFrozen(low), false);
  assert.equal(Reflect.set(first, 'offset_bits', 16), false);
  assert.deepEqual(verifyIR(program), []);
  const mutable = { ...first };
  const replace = (replacement: typeof first) => ({
    ...program,
    register_states: program.register_states.map((row) => ({
      ...row,
      entry: row.entry.map((binding) =>
        binding.register.id === first.id ? { ...binding, register: replacement } : binding,
      ),
      exit: row.exit.map((binding) =>
        binding.register.id === first.id ? { ...binding, register: replacement } : binding,
      ),
    })),
  });
  const mutableProgram = replace(mutable);
  assert.deepEqual(verifyIR(mutableProgram), []);
  assert.equal(Object.isFrozen(mutable), false);
  mutable.offset_bits = 16;
  const changed = verifyIR(mutableProgram).filter(
    (problem) =>
      problem.code === 'register' && problem.message === IR_PROBLEM_MESSAGE.registerOverlap,
  );
  assert.equal(changed.filter((problem) => problem.node === program.id).length, 1);
  for (const state of program.register_states)
    assert.equal(
      changed.filter((problem) => problem.node === state.block).length,
      Number(state.entry.length > 0) + Number(state.exit.length > 0),
    );
  const invalid = Object.freeze({ ...first, write_rule: 'replace_root' as const });
  const repeated = verifyIR(replace(invalid)).filter(
    (problem) =>
      problem.code === 'register' && problem.message === IR_PROBLEM_MESSAGE.replaceRootCoverage,
  );
  assert.equal(repeated.filter((problem) => problem.node === program.id).length, 1);
  for (const state of program.register_states)
    assert.equal(
      repeated.filter((problem) => problem.node === state.block).length,
      Number(state.entry.length > 0) + Number(state.exit.length > 0),
    );
});

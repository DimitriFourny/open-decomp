import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, entityIdentity, OperationError } from '../../src/core/index.js';
import { DarwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { IRBuilder, integer, type SSAForm } from '../../src/ir/index.js';
import { structureControlFlow } from '../../src/presentation/index.js';
import { reconstruct } from '../../src/reconstruction/index.js';
import { validateReconstruction, validateRenderedTransfers } from '../../src/reconstruction/validate.js';
import { builder, provenance, register, slice } from '../ir/support.js';
import { emit, execute } from '../emitters/c/support.js';

const i32 = integer(32), i64 = integer(64);
const context = createOperationContext;
function multiExit() {
  const b = new IRBuilder(slice, entityIdentity(slice, 'function', 'publication-multiple-exits'), provenance, 'ssa');
  const entry = b.block('entry', [i32]), loop = b.block('loop', [i32]), step = b.block('step', [i32]);
  const zero = b.block('zero'), mismatch = b.block('mismatch');
  entry.jump(loop, entry.parameters);
  loop.branch(loop.compare('eq', loop.parameters[0]!, loop.constant(i32, 0n)), loop.edge(zero), loop.edge(step, loop.parameters));
  step.branch(step.compare('eq', step.parameters[0]!, step.constant(i32, 2n)), step.edge(mismatch),
    step.edge(loop, [step.int('sub', step.parameters[0]!, step.constant(i32, 1n))]));
  zero.return([zero.constant(i32, 0n)]);
  mismatch.return([mismatch.constant(i32, 1n)]);
  return { ir: b.finish(entry, [i32]), parameter: entry.parameters[0]! };
}
function plan(ir: SSAForm) {
  const structured = structureControlFlow(ir, context());
  assert.ok(structured.value);
  return reconstruct({ function: structured.value }, context());
}
function invariant(error: unknown): boolean {
  return error instanceof OperationError && error.diagnostic.code === 'unavailable_semantics' &&
    error.diagnostic.evidence_ids.length === provenance.evidence_ids.length;
}

test('publication rejects the old multi-exit break interpretation and preserves executable alternatives', () => {
  const { ir, parameter } = multiExit();
  const program = plan(ir);
  for (const language of ['c-like', 'python-like'] as const) {
    assert.throws(() => validateRenderedTransfers(program.function, new Set(), language, context()), invariant);
    const result = emit(ir, {}, language);
    for (const [count, expected] of [[0n, 0n], [1n, 0n], [2n, 1n], [3n, 1n], [11n, 1n]])
      assert.deepEqual(execute(result.emission, new Map([[parameter.id, count!]])).values, [expected]);
  }
});

test('publication rejects missing synthesized definitions and edge-specific phi assignments', () => {
  const { ir } = multiExit(), program = plan(ir);
  const missing = { id: entityIdentity(slice, 'value', 'uninitialized-publication-value'), type: i32 };
  assert.throws(() => validateReconstruction({
    ...program, values: new Map([...program.values, [missing.id, missing]]), live: new Set([...program.live, missing.id]),
  }, context()), invariant);
  const transfer = [...program.transfers].find(([, copies]) => copies.some((copy) => program.live.has(copy.destination.id)));
  assert.ok(transfer);
  const broken = new Map(program.transfers);
  broken.set(transfer[0], []);
  assert.throws(() => validateReconstruction({ ...program, transfers: broken }, context()), invariant);
});

test('publication rejects projecting incoming caller bytes as an uninitialized private frame', () => {
  const b = builder('publication-incoming-storage'), entry = b.block('entry'), abi = new DarwinArm64Abi();
  const address = entry.readRegister(abi.stack_pointer), result = entry.load(i64, address);
  entry.return([result]);
  const ssa = constructSSA(b.finish(entry, [i64])).value;
  assert.equal(ssa.form, 'ssa');
  if (ssa.form !== 'ssa') assert.fail('Expected SSA');
  const structured = structureControlFlow(ssa, context());
  assert.ok(structured.value);
  const program = reconstruct({ function: structured.value, source: { abi, callees: [], addresses: [] } }, context());
  const source = program.source;
  assert.ok(source);
  const load = [...program.blocks.values()].flatMap((block) => block.statements).find((node) => node.kind === 'load');
  assert.ok(load && load.kind === 'load');
  assert.throws(() => validateReconstruction({ ...program, retained: new Set([...program.retained, load.id]), source: {
    ...source,
    stack: { kind: 'private', minimum_offset: 0n, size: 8n, alignment: 16 },
    stack_addresses: new Map([[load.address.id, 0n]]),
  } }, context()), invariant);
});

test('publication rejects a return projection from the wrong scalar register-bank interpretation', () => {
  const { ir } = multiExit(), program = plan(ir);
  assert.throws(() => validateReconstruction({ ...program, source: {
    inferred: true, parameter_names: new Map(), return_type: { kind: 'float', bits: 32 },
    locals: new Map(), stack: null, stack_addresses: new Map(), addresses: [],
  } }, context()), invariant);
});

test('publication rejects local promotion when a predecessor omits initialization', () => {
  const b = builder('publication-definite-local'), abi = new DarwinArm64Abi();
  const entry = b.block('entry'), initialized = b.block('initialized'), skipped = b.block('skipped'), join = b.block('join');
  const argument = entry.readRegister(register('x0', 64, 0, 'replace_root', 'arm64:x0'));
  entry.branch(entry.compare('eq', argument, entry.constant(i64, 0n)), entry.edge(initialized), entry.edge(skipped));
  const slot = initialized.int('sub', initialized.readRegister(abi.stack_pointer), initialized.constant(i64, 16n));
  initialized.store(slot, initialized.constant(i64, 7n));
  initialized.jump(join);
  skipped.jump(join);
  const loaded = join.load(i64, join.int('sub', join.readRegister(abi.stack_pointer), join.constant(i64, 16n)));
  join.return([loaded]);
  const ssa = constructSSA(b.finish(entry, [i64])).value;
  assert.equal(ssa.form, 'ssa');
  if (ssa.form !== 'ssa') assert.fail('Expected SSA');
  const structured = structureControlFlow(ssa, context());
  assert.ok(structured.value);
  const program = reconstruct({ function: structured.value, source: { abi, callees: [], addresses: [] } }, context());
  const source = program.source;
  assert.ok(source);
  const local = { id: entityIdentity(slice, 'stack', 'publication-not-definitely-initialized'), type: i64 };
  const locals = new Map([...program.blocks.values()].flatMap((block) => block.statements)
    .filter((node) => node.kind === 'load' || node.kind === 'store').map((node) => [node.id, local]));
  assert.throws(() => validateReconstruction({ ...program, source: { ...source, locals } }, context()), invariant);
});

test('publication rejects a synthesized result defined only on another branch', () => {
  const program = plan(multiExit().ir);
  const exits = [...program.blocks.values()].filter((block) => block.control.kind === 'return');
  assert.equal(exits.length, 2);
  const producer = exits[0]!, consumer = exits[1]!;
  const original = program.returns.get(producer.control.id)!.results[0]!;
  const expression = program.expressions.get(original.id);
  assert.ok(expression);
  const value = { id: entityIdentity(slice, 'value', 'branch-local-synthesized-result'), type: i32 };
  const definition = {
    kind: 'assign' as const, id: entityIdentity(slice, 'instruction', 'branch-local-synthesized-definition'),
    result: value, expression, provenance: producer.control.provenance,
  };
  const returns = new Map(program.returns);
  returns.set(consumer.control.id, { ...returns.get(consumer.control.id)!, results: [value] });
  assert.throws(() => validateReconstruction({
    ...program, returns,
    values: new Map([...program.values, [value.id, value]]),
    expressions: new Map([...program.expressions, [value.id, expression]]),
    live: new Set([...program.live, value.id]),
    source: {
      inferred: true, parameter_names: new Map(), return_type: i32,
      locals: new Map(), stack: null, stack_addresses: new Map(), addresses: [],
      definitions: new Map([[producer.control.id, [definition]]]),
    },
  }, context()), invariant);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, entityIdentity, OperationError } from '../../src/core/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import type { TypeRecoveryResult } from '../../src/analysis/types/index.js';
import {
  IRBuilder,
  evaluateExpression,
  evaluateIR,
  integer,
  type RuntimeValue,
  type SSAForm,
} from '../../src/ir/index.js';
import { structureControlFlow } from '../../src/presentation/index.js';
import { reconstruct } from '../../src/reconstruction/index.js';
import { builder, image, provenance, register, slice } from '../ir/support.js';

const i1 = integer(1),
  i8 = integer(8),
  i64 = integer(64);
function plan(input: SSAForm, types?: TypeRecoveryResult) {
  const structured = structureControlFlow(input, createOperationContext());
  assert.ok(structured.value);
  return reconstruct(
    { function: structured.value, ...(types ? { types } : {}) },
    createOperationContext(),
  );
}

test('folded subtraction flags preserve signed overflow, unsigned carry and unknown values', () => {
  const b = new IRBuilder(
    slice,
    entityIdentity(slice, 'function', 'reconstruction-flags'),
    provenance,
    'ssa',
  );
  const block = b.block('entry', [i8, i8]);
  const [a, c] = block.parameters,
    carry = block.constant(i1, 0n);
  const negative = block.flag('sub', 'negative', a!, c!, carry),
    overflow = block.flag('sub', 'overflow', a!, c!, carry);
  const signed = block.int('xor', negative, overflow),
    unsigned = block.flag('sub', 'carry', a!, c!, carry);
  const zero = block.flag('sub', 'zero', a!, c!, carry);
  block.return([signed, unsigned, zero]);
  const input = b.finish(block, [i1, i1, i1]),
    result = plan(input);
  assert.deepEqual(result.expressions.get(signed.id), {
    kind: 'compare',
    op: 'slt',
    left: a,
    right: c,
  });
  const rewritten: SSAForm = {
    ...input,
    blocks: input.blocks.map((item) => ({
      ...item,
      instructions: item.instructions.map((node) =>
        node.kind === 'assign'
          ? { ...node, expression: result.expressions.get(node.result.id)! }
          : node,
      ),
    })),
  };
  for (const left of [0n, 1n, 127n, 128n, 255n])
    for (const right of [0n, 1n, 127n, 128n, 255n]) {
      const options = { arguments: [left, right] };
      assert.deepEqual(evaluateIR(rewritten, options), evaluateIR(input, options));
    }
  const unknownResults: RuntimeValue[][] = [];
  for (const program of [input, rewritten]) {
    const values = new Map<string, RuntimeValue>([
      [a!.id, { kind: 'unknown', reason: 'entry unknown' }],
      [c!.id, { kind: 'bits', bits: 1n }],
    ]);
    for (const node of program.blocks[0]!.instructions)
      if (node.kind === 'assign')
        values.set(
          node.result.id,
          evaluateExpression(node.result.type, node.expression, (operand) =>
            values.get(operand.id)!,
          ),
        );
    unknownResults.push([signed, unsigned, zero].map((value) => values.get(value.id)!));
  }
  assert.deepEqual(unknownResults[0], unknownResults[1]);
});

test('constant folding wraps but never erases undefined integer operands', () => {
  const b = new IRBuilder(
    slice,
    entityIdentity(slice, 'function', 'reconstruction-width'),
    provenance,
    'ssa',
  );
  const block = b.block('entry');
  const wrapped = block.int('add', block.constant(i8, 255n), block.constant(i8, 2n));
  const unknown = block.indeterminate(i8, 'undefined', 'uninitialized byte');
  const masked = block.int('and', unknown, block.constant(i8, 0n));
  const division = block.int('udiv', wrapped, block.constant(i8, 0n));
  block.return([wrapped, masked, division]);
  const result = plan(b.finish(block, [i8, i8, i8]));
  assert.deepEqual(result.expressions.get(wrapped.id), { kind: 'constant', bits: 1n });
  assert.equal(result.expressions.get(masked.id)?.kind, 'integer');
  assert.equal(result.expressions.get(division.id)?.kind, 'integer');
  assert.ok(result.live.has(unknown.id));
});

test('unchanged physical forwarding through a diamond is ambient, changed fault state remains explicit', () => {
  const b = builder('reconstruction-snapshots'),
    entry = b.block('entry', [i1]),
    yes = b.block('yes'),
    no = b.block('no'),
    exit = b.block('exit');
  const rax = register('rax', 64, 0, 'replace_root'),
    rbx = register('rbx', 64, 0, 'replace_root', 'x86_64:rbx');
  entry.readRegister(rbx);
  entry.branch(entry.parameters[0]!, entry.edge(yes), entry.edge(no));
  yes.writeRegister(rax, yes.constant(i64, 17n));
  yes.jump(exit);
  no.writeRegister(rax, no.constant(i64, 23n));
  no.jump(exit);
  exit.load(i64, exit.constant(i64, 0x1000n));
  exit.return();
  const input = constructSSA(b.finish(entry)).value;
  assert.equal(input.form, 'ssa');
  if (input.form !== 'ssa') return;
  const result = plan(input),
    load = input.blocks
      .flatMap((block) => block.instructions)
      .find((node) => node.kind === 'load')!;
  assert.ok(result.retained.has(load.id), 'dead potentially faulting load must remain');
  assert.deepEqual(
    result.physical_inputs.get(load.id)!.map((binding) => binding.register.root),
    [rax.root],
  );
  const returned = result.returns.get(
    input.blocks.find((block) => block.id === exit.id)!.terminator.id,
  )!;
  assert.deepEqual(
    returned.outputs.map((binding) => binding.register.root),
    [rax.root],
  );
  assert.ok(
    !result.parameters.some((value) => result.parameter_registers.get(value.id)?.root === rbx.root),
  );
});

test('backedge swap remains simultaneous and loop snapshots are not inlined across a rebind', () => {
  const b = new IRBuilder(
    slice,
    entityIdentity(slice, 'function', 'reconstruction-loop'),
    provenance,
    'ssa',
  );
  const entry = b.block('entry'),
    loop = b.block('loop', [i8, i8, i8]),
    exit = b.block('exit', [i8, i8, i8]);
  entry.jump(loop, [entry.constant(i8, 7n), entry.constant(i8, 9n), entry.constant(i8, 1n)]);
  const snapshot = loop.int('add', loop.parameters[0]!, loop.constant(i8, 1n));
  loop.branch(
    loop.compare('eq', loop.parameters[2]!, loop.constant(i8, 0n)),
    loop.edge(exit, [loop.parameters[0]!, loop.parameters[1]!, snapshot]),
    loop.edge(loop, [loop.parameters[1]!, loop.parameters[0]!, loop.constant(i8, 0n)]),
  );
  exit.return(exit.parameters);
  const input = b.finish(entry, [i8, i8, i8]),
    result = plan(input);
  const control = result.blocks.get(loop.id)!.control;
  assert.equal(control.kind, 'if');
  if (control.kind !== 'if') return;
  const copies = result.transfers.get(control.when_false.transfer)!;
  const environment = new Map(
    loop.parameters.map((value, index) => [value.id, [7n, 9n, 1n][index]!]),
  );
  const reads = copies.map(
    (copy) => [copy.destination.id, environment.get(copy.source.id) ?? 0n] as const,
  );
  for (const [id, value] of reads) environment.set(id, value);
  assert.equal(environment.get(loop.parameters[0]!.id), 9n);
  assert.equal(environment.get(loop.parameters[1]!.id), 7n);
  assert.ok(
    result.transfers
      .get(control.when_true.transfer)!
      .some((copy) => copy.source.id === snapshot.id),
  );
  assert.deepEqual(evaluateIR(input).values, [
    { kind: 'bits', bits: 9n },
    { kind: 'bits', bits: 7n },
    { kind: 'bits', bits: 10n },
  ]);
});

test('ordered unused calls, loads and stores survive while their dead pure plumbing maps to origins', () => {
  const b = new IRBuilder(
    slice,
    entityIdentity(slice, 'function', 'reconstruction-effects'),
    provenance,
    'ssa',
  );
  const block = b.block('entry');
  const dead = block.int('add', block.constant(i64, 6n), block.constant(i64, 7n));
  const address = block.constant(i64, 0x1000n);
  block.load(i64, address, { endian: 'little', alignment: 8, volatile: true });
  block.call(
    { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
    [],
    [i64],
    { registers: [], flags: [], memory: 'unknown_read_write' },
  );
  block.store(address, block.constant(i64, 2n));
  block.return();
  const input = b.finish(block),
    result = plan(input);
  assert.ok(!result.live.has(dead.id));
  assert.deepEqual(
    input.blocks[0]!.instructions.filter((node) => result.retained.has(node.id)).map(
      (node) => node.kind,
    ),
    ['load', 'call', 'store'],
  );
  const origins = new Set([...result.origins.values()].flat().map((origin) => origin.id));
  for (const node of input.blocks[0]!.instructions)
    assert.ok(origins.has(node.id), 'hidden node keeps a mapped origin');
});

test('source interfaces require complete whole-value ABI bindings, not a name or fragment', () => {
  const b = builder('reconstruction-source'),
    block = b.block('entry');
  const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi'),
    rax = register('rax', 64, 0, 'replace_root');
  const scratch = register('r10', 64, 0, 'replace_root', 'x86_64:r10'),
    preserved = register('rbx', 64, 0, 'replace_root', 'x86_64:rbx');
  block.writeRegister(rax, block.readRegister(rdi));
  block.writeRegister(scratch, block.constant(i64, 123n));
  block.writeRegister(preserved, block.constant(i64, 456n));
  block.return();
  const input = constructSSA(b.finish(block)).value;
  assert.equal(input.form, 'ssa');
  if (input.form !== 'ssa') return;
  const facts: TypeRecoveryResult = {
    state: 'complete',
    work: 0,
    subjects: [],
    associations: [],
    shapes: [],
    conflicts: [],
    evidence: [],
    diagnostics: [],
    calls: null,
    types: [
      {
        id: 'type_integer',
        definition: { kind: 'integer', bits: 64, signed: false },
        source: 'debug',
        status: 'established',
        evidence_ids: [],
      },
    ],
    signatures: [
      {
        id: 'signature_exact',
        subject_id: input.id,
        source: 'debug',
        status: 'established',
        evidence_ids: [],
        abi_state: 'complete',
        implicit_register_inputs: [],
        signature: {
          abi: 'sysv-amd64',
          return_type: 'type_integer',
          parameters: [{ id: 'parameter_exact', name: 'not_a_proof', type_id: 'type_integer' }],
          variadic: false,
          noreturn: false,
          evidence_ids: [],
        },
      },
    ],
  };
  const exact = plan(input, facts);
  assert.equal(exact.signature?.id, 'signature_exact');
  assert.equal([...exact.returns.values()][0]!.kind, 'source');
  assert.deepEqual(
    [...exact.returns.values()][0]!.outputs.map((binding) => binding.register.root),
    [preserved.root],
    'a source ABI hides scratch results, never a corrupted callee-saved register',
  );
  const partial = plan(input, {
    ...facts,
    signatures: facts.signatures.map((signature) => ({ ...signature, abi_state: 'partial' })),
  });
  assert.equal(partial.signature, null);
  assert.equal([...partial.returns.values()][0]!.kind, 'physical');
  assert.ok(
    [...partial.returns.values()][0]!.outputs.some(
      (binding) => binding.register.root === scratch.root,
    ),
    'an unknown interface cannot discard scratch outputs',
  );
  const fragment = plan(input, {
    ...facts,
    types: [{ ...facts.types[0]!, definition: { kind: 'integer', bits: 32, signed: false } }],
  });
  assert.equal(fragment.signature, null);
});

test('repeated-operand DAG growth stays local and cancellation is checked before traversal', () => {
  const b = new IRBuilder(
    slice,
    entityIdentity(slice, 'function', 'reconstruction-budget'),
    provenance,
    'ssa',
  );
  const block = b.block('entry', [i64]);
  let value = block.parameters[0]!;
  for (let index = 0; index < 80; index++) value = block.int('add', value, value);
  block.return([value]);
  const input = b.finish(block, [i64]);
  const result = plan(input);
  assert.ok(result.retained.size >= 79, 'shared DAG nodes are not exponentially expanded');
  const abort = new AbortController();
  abort.abort();
  assert.throws(
    () =>
      reconstruct({ function: result.function }, createOperationContext({ signal: abort.signal })),
    (error) => error instanceof OperationError && error.code === 'cancelled',
  );
  assert.throws(
    () =>
      reconstruct({ function: result.function }, createOperationContext({ budget: { work: 4 } })),
    (error) => error instanceof OperationError && error.code === 'resource_limit',
  );
});

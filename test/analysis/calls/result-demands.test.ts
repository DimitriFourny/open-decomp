import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext } from '../../../src/core/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import {
  createCallResultDemandIndex,
  observeCallResultDemands,
} from '../../../src/analysis/calls/result-demands.js';
import { preparedCallArguments } from '../../../src/analysis/calls/argument-preparation.js';
import { integer, type SSAForm, type Value } from '../../../src/ir/index.js';
import { builder, image, register } from '../../ir/support.js';

function fixture() {
  const ir = builder('root-specific-result-demands'),
    block = ir.block('entry');
  const rax = register('rax', 64, 0, 'replace_root', 'x86_64:rax');
  const xmm0 = {
    ...register('xmm0', 128, 0, 'replace_root', 'x86_64:xmm0', 128),
    bank: 'vector' as const,
  };
  const target = (offset: bigint) => ({
    kind: 'direct' as const,
    address: { image_id: image, space: 'va' as const, value: 0x2000n + offset },
  });
  block.call(target(0n), [], [], { registers: [rax], flags: [], memory: 'unknown_read_write' });
  const first = block.readRegister(rax),
    firstLow = block.extract(first, 0, 32);
  block.call(target(4n), [], [], { registers: [rax], flags: [], memory: 'unknown_read_write' });
  const second = block.readRegister(rax),
    secondLow = block.extract(second, 0, 32);
  block.call(target(8n), [], [], { registers: [xmm0], flags: [], memory: 'unknown_read_write' });
  const vector = block.readRegister(xmm0),
    vectorLow = block.extract(vector, 0, 64);
  // Static roots do not consume any call result. Each query supplies its own
  // semantic roots; physical snapshots must not turn them into full-bank demand.
  block.return([block.constant(integer(64), 0n)]);
  const result = constructSSA(ir.finish(block, [integer(64)]));
  if (result.value.form !== 'ssa') throw new TypeError('Expected SSA');
  const program = result.value;
  const calls = program.blocks[0]!.instructions.filter((node) => node.kind === 'call');
  return { program, calls, first, firstLow, second, secondLow, vector, vectorLow };
}

function widths(
  result: ReadonlyMap<string, readonly { readonly bank: string; readonly width_bits: number }[]>,
  calls: readonly { readonly id: string }[],
) {
  return calls.map((call) =>
    (result.get(call.id) ?? []).map((register) => [register.bank, register.width_bits]),
  );
}

test('one structural index keeps independent 32/full64 and scalar/vector demand queries', () => {
  const f = fixture(),
    context = createOperationContext();
  const index = createCallResultDemandIndex(f.program, sysvAMD64Abi, context);
  const query = (roots: readonly Value[]) =>
    observeCallResultDemands(f.program, sysvAMD64Abi, context, roots, index).all;
  assert.deepEqual(widths(query([f.firstLow, f.second, f.vectorLow]), f.calls), [
    [['integer', 32]],
    [['integer', 64]],
    [['vector', 64]],
  ]);
  assert.deepEqual(widths(query([f.first, f.secondLow, f.vector]), f.calls), [
    [['integer', 64]],
    [['integer', 32]],
    [['vector', 128]],
  ]);
  assert.deepEqual(widths(query([f.firstLow, f.second, f.vectorLow]), f.calls), [
    [['integer', 32]],
    [['integer', 64]],
    [['vector', 64]],
  ]);
  assert.equal(query([]).size, 0);
  assert.deepEqual(
    query([f.firstLow]),
    observeCallResultDemands(f.program, sysvAMD64Abi, createOperationContext(), [f.firstLow]).all,
  );
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () =>
      index.query(
        f.program,
        sysvAMD64Abi,
        createOperationContext({ signal: controller.signal }),
        [],
      ),
    { code: 'cancelled' },
  );
});

test('context-specialized SSA identities require new indexes and do not reuse earlier demand facts', () => {
  const f = fixture();
  const view = (value: Value): SSAForm => ({
    ...f.program,
    returns: [value.type],
    blocks: f.program.blocks.map((block) =>
      block.terminator.kind === 'return'
        ? { ...block, terminator: { ...block.terminator, values: [value] } }
        : block,
    ),
  });
  const narrow = view(f.firstLow),
    full = view(f.first);
  const context = createOperationContext();
  const index = createCallResultDemandIndex(narrow, sysvAMD64Abi, context);
  assert.deepEqual(widths(index.query(narrow, sysvAMD64Abi, context).all, f.calls), [
    [['integer', 32]],
    [],
    [],
  ]);
  assert.throws(() => index.query(full, sysvAMD64Abi, context), TypeError);
  const preparation = index.preparation(narrow, sysvAMD64Abi, context);
  assert.throws(() => index.preparation(full, sysvAMD64Abi, context), TypeError);
  assert.throws(() => preparedCallArguments(full, context, preparation), TypeError);
  const other = createCallResultDemandIndex(full, sysvAMD64Abi, context);
  assert.deepEqual(widths(other.query(full, sysvAMD64Abi, context).all, f.calls), [
    [['integer', 64]],
    [],
    [],
  ]);
  assert.deepEqual(widths(index.query(narrow, sysvAMD64Abi, context).all, f.calls), [
    [['integer', 32]],
    [],
    [],
  ]);
});

test('demand reached only through the implicit return-exit snapshot is forwarded, not semantic', () => {
  const ir = builder('forwarded-result-demands');
  const entry = ir.block('entry'),
    left = ir.block('left'),
    right = ir.block('right'),
    tested = ir.block('tested'),
    stored = ir.block('stored');
  const rax = register('rax', 64, 0, 'replace_root', 'x86_64:rax');
  const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');
  const clobbers = { registers: [rax], flags: [], memory: 'unknown_read_write' as const };
  const target = (offset: bigint) => ({
    kind: 'direct' as const,
    address: { image_id: image, space: 'va' as const, value: 0x2000n + offset },
  });
  const zero = (block: typeof entry, bits: number) => block.constant(integer(bits), 0n);
  entry.call(target(0n), [], [], clobbers);
  entry.branch(
    entry.compare('ne', entry.readRegister(rdi), zero(entry, 64)),
    entry.edge(left),
    entry.edge(right),
  );
  // Forwarded only: the first result reaches nothing but this function's exit.
  left.return();
  right.call(target(4n), [], [], clobbers);
  const second = right.extract(right.readRegister(rax), 0, 32);
  // Reached from both: the branch consumes W0, the exit forwards all of X0.
  right.branch(
    right.compare('eq', second, zero(right, 32)),
    right.edge(tested),
    right.edge(stored),
  );
  tested.return();
  stored.call(target(8n), [], [], clobbers);
  // Reached from both at the same width: the store consumes all of X0.
  stored.store(stored.constant(integer(64), 0x3000n), stored.readRegister(rax));
  stored.return();
  const result = constructSSA(ir.finish(entry));
  if (result.value.form !== 'ssa') throw new TypeError('Expected SSA');
  const program = result.value;
  const calls = program.blocks.flatMap((block) =>
    block.instructions.filter((node) => node.kind === 'call'),
  );
  assert.equal(calls.length, 3);
  const demand = observeCallResultDemands(program, sysvAMD64Abi, createOperationContext());
  assert.deepEqual(widths(demand.all, calls), [
    [['integer', 64]],
    [['integer', 64]],
    [['integer', 64]],
  ]);
  assert.deepEqual(widths(demand.semantic, calls), [[], [['integer', 32]], [['integer', 64]]]);
  // A supplied root is semantic.
  const index = createCallResultDemandIndex(program, sysvAMD64Abi, createOperationContext());
  const firstOutput = calls[0]!.kind === 'call' ? calls[0]!.register_outputs[0]!.value : undefined;
  assert.ok(firstOutput);
  assert.deepEqual(
    widths(
      index.query(program, sysvAMD64Abi, createOperationContext(), [firstOutput]).semantic,
      calls,
    ),
    [[['integer', 64]], [['integer', 32]], [['integer', 64]]],
  );
});

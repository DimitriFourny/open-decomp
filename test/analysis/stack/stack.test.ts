import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext } from '../../../src/core/index.js';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { WindowsX64Abi } from '../../../src/abi/windows-x64/index.js';
import { recoverStack, inspectStackMemory } from '../../../src/analysis/stack/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { integer, type RegisterIR, type SSAForm } from '../../../src/ir/index.js';
import { builder, image, register } from '../../ir/support.js';

const darwin = new DarwinArm64Abi(),
  windows = new WindowsX64Abi();
const i1 = integer(1),
  i8 = integer(8),
  i32 = integer(32),
  i64 = integer(64);
function ssa(program: RegisterIR): SSAForm {
  const result = constructSSA(program);
  assert.equal(result.state, 'complete');
  assert.equal(result.value.form, 'ssa');
  if (result.value.form !== 'ssa') throw new Error('Expected SSA');
  return result.value;
}
const target = {
  kind: 'direct' as const,
  address: { image_id: image, space: 'va' as const, value: 0x2000n },
};

for (const abi of [darwin, windows])
  test(`${abi.id}: entry-relative frame and partial byte stores`, () => {
    const ir = builder(`stack-partial-${abi.id}`),
      b = ir.block('entry');
    const pointer = b.int('sub', b.readRegister(abi.stack_pointer), b.constant(i64, 16n));
    b.writeRegister(abi.stack_pointer, pointer);
    b.store(pointer, b.constant(i32, 0x44332211n));
    const partial = b.load(i64, pointer);
    b.store(b.int('add', pointer, b.constant(i64, 4n)), b.constant(i32, 0x88776655n));
    const full = b.load(i64, pointer);
    b.store(b.int('add', pointer, b.constant(i64, 1n)), b.constant(i8, 0xaan));
    const overlap = b.load(i64, pointer);
    b.return([partial, full, overlap]);
    const program = ssa(ir.finish(b, [i64, i64, i64]));
    const result = recoverStack(program, abi, createOperationContext());
    assert.equal(result.state, 'complete');
    assert.equal(result.frame.minimum_offset, -16n);
    const reads = result.accesses.filter((access) => access.kind === 'read');
    assert.equal(reads[0]!.value.initialization, 'maybe_initialized');
    assert.deepEqual(reads[1]!.value.value, { kind: 'constant', bits: 0x8877665544332211n });
    assert.deepEqual(reads[2]!.value.value, { kind: 'constant', bits: 0x887766554433aa11n });
    assert.equal(reads[2]!.value.initialization, 'initialized');
    assert.ok(reads.every((access) => access.region === 'local_candidate'));
  });

test('joins distinguish writes on all paths from a write on only one path', () => {
  for (const both of [false, true]) {
    const ir = builder(`stack-diamond-${both}`),
      entry = ir.block('entry', [i1]),
      yes = ir.block('yes'),
      no = ir.block('no'),
      end = ir.block('end');
    entry.writeRegister(
      darwin.stack_pointer,
      entry.int('sub', entry.readRegister(darwin.stack_pointer), entry.constant(i64, 16n)),
    );
    entry.branch(entry.parameters[0]!, entry.edge(yes), entry.edge(no));
    yes.store(yes.readRegister(darwin.stack_pointer), yes.constant(i64, 9n));
    yes.jump(end);
    if (both) no.store(no.readRegister(darwin.stack_pointer), no.constant(i64, 9n));
    no.jump(end);
    end.return([end.load(i64, end.readRegister(darwin.stack_pointer))]);
    const result = recoverStack(ssa(ir.finish(entry, [i64])), darwin, createOperationContext());
    assert.equal(result.state, 'complete');
    const access = result.accesses.find((access) => access.kind === 'read')!;
    assert.equal(access.value.initialization, both ? 'initialized' : 'maybe_initialized');
    assert.equal(access.value.value.kind, both ? 'constant' : 'unknown');
  }
});

test('loop-carried stack movement widens without publishing the first iteration offset', () => {
  const ir = builder('stack-moving-loop'),
    entry = ir.block('entry'),
    loop = ir.block('loop', [i1]),
    done = ir.block('done');
  entry.jump(loop, [entry.indeterminate(i1, 'unknown', 'Loop condition')]);
  loop.writeRegister(
    darwin.stack_pointer,
    loop.int('sub', loop.readRegister(darwin.stack_pointer), loop.constant(i64, 16n)),
  );
  loop.store(loop.readRegister(darwin.stack_pointer), loop.constant(i64, 7n));
  loop.branch(loop.parameters[0]!, loop.edge(loop, [loop.parameters[0]!]), loop.edge(done));
  done.return();
  const result = recoverStack(ssa(ir.finish(entry)), darwin, createOperationContext());
  assert.equal(result.state, 'complete');
  assert.equal(result.frame.dynamic, true);
  assert.equal(result.accesses[0]!.offset, null);
  assert.equal(result.frame.aliased, true);
});

test('escaped stack pointers survive partial overwrite, reload and unknown write barriers', () => {
  const ir = builder('stack-pointer-taint'),
    b = ir.block('entry');
  const sp = b.readRegister(darwin.stack_pointer),
    slot = b.int('sub', sp, b.constant(i64, 16n));
  const pointee = b.int('sub', sp, b.constant(i64, 32n));
  b.store(slot, pointee);
  b.store(slot, b.constant(i8, 0n));
  const damaged = b.load(i64, slot);
  b.store(b.constant(i64, 0x5000n), damaged);
  b.store(pointee, b.constant(i64, 99n));
  b.unknown('May write escaped memory', { registers: [], flags: [], memory: 'unknown_read_write' });
  const after = b.load(i64, pointee);
  b.return([damaged, after]);
  const result = recoverStack(ssa(ir.finish(b, [i64, i64])), darwin, createOperationContext());
  const reads = result.accesses.filter((access) => access.kind === 'read');
  assert.equal(reads[0]!.value.value.kind, 'dynamic_stack');
  assert.equal(reads[1]!.value.value.kind, 'unknown');
  assert.equal(reads[1]!.value.initialization, 'unknown');
  assert.equal(result.frame.escaped, true);
  assert.equal(result.frame.aliased, true);
});

test('call snapshots retain pre-call bytes and invalidate them only afterward', () => {
  const ir = builder('stack-call-time'),
    b = ir.block('entry');
  const slot = b.int('sub', b.readRegister(darwin.stack_pointer), b.constant(i64, 16n));
  b.store(slot, b.constant(i64, 0x55n));
  b.call(target, [slot], [], { registers: [], flags: [], memory: 'unknown_read_write' });
  const after = b.load(i64, slot);
  b.store(slot, b.constant(i64, 0x66n));
  b.return([after]);
  const program = ssa(ir.finish(b, [i64]));
  const call = program.blocks[0]!.instructions.find((node) => node.kind === 'call')!;
  const result = recoverStack(program, darwin, createOperationContext());
  assert.deepEqual(inspectStackMemory(result.snapshots.get(call.id)!, -16n, 8n).value, {
    kind: 'constant',
    bits: 0x55n,
  });
  assert.equal(
    result.accesses.find((access) => access.kind === 'read')!.value.initialization,
    'unknown',
  );
  assert.equal(result.frame.escaped, true);
});

test('Windows home space and return address are not Darwin incoming arguments or locals', () => {
  for (const abi of [darwin, windows]) {
    const ir = builder(`stack-regions-${abi.id}`),
      b = ir.block('entry'),
      sp = b.readRegister(abi.stack_pointer);
    const values = [0n, 8n, 32n, 40n].map((offset) =>
      b.load(i64, b.int('add', sp, b.constant(i64, offset))),
    );
    b.return(values);
    const result = recoverStack(
      ssa(
        ir.finish(
          b,
          values.map(() => i64),
        ),
      ),
      abi,
      createOperationContext(),
    );
    assert.deepEqual(
      result.accesses.map((access) => access.region),
      abi === windows
        ? ['return_address', 'shadow_space', 'shadow_space', 'incoming_candidate']
        : Array(4).fill('incoming_candidate'),
    );
    assert.ok(result.accesses.every((access) => access.before.initialization === 'unknown'));
  }
});

test('split canonical SP cells reassemble only when all original pointer bits survive', () => {
  const ir = builder('stack-split-sp'),
    b = ir.block('entry');
  const low = {
    ...darwin.stack_pointer,
    id: 'opaque-low-sp',
    width_bits: 32,
    write_rule: 'preserve_other_bits' as const,
  };
  b.readRegister(low);
  const sp = b.readRegister(darwin.stack_pointer);
  b.store(b.int('sub', sp, b.constant(i64, 8n)), b.constant(i64, 9n));
  b.writeRegister(low, b.constant(i32, 0n));
  b.load(i64, b.readRegister(darwin.stack_pointer));
  b.return();
  const result = recoverStack(ssa(ir.finish(b)), darwin, createOperationContext());
  assert.equal(result.accesses[0]!.offset, -8n);
  assert.equal(result.accesses[1]!.offset, null);
  assert.equal(result.frame.dynamic, true);
});

test('unknown writes on another join arm cannot leave stale initialized stack bytes', () => {
  const ir = builder('stack-join-alias'),
    entry = ir.block('entry', [i1]),
    yes = ir.block('yes'),
    no = ir.block('no'),
    end = ir.block('end');
  entry.writeRegister(
    darwin.stack_pointer,
    entry.int('sub', entry.readRegister(darwin.stack_pointer), entry.constant(i64, 16n)),
  );
  entry.store(entry.readRegister(darwin.stack_pointer), entry.constant(i64, 9n));
  entry.branch(entry.parameters[0]!, entry.edge(yes), entry.edge(no));
  yes.jump(end);
  no.store(no.readRegister(register('unknown-pointer', 64)), no.constant(i64, 8n));
  no.jump(end);
  end.return([end.load(i64, end.readRegister(darwin.stack_pointer))]);
  const result = recoverStack(ssa(ir.finish(entry, [i64])), darwin, createOperationContext());
  const load = result.accesses.find((access) => access.kind === 'read')!;
  assert.equal(load.value.initialization, 'unknown');
  assert.equal(load.value.value.kind, 'unknown');
});

test('exhaustion and cancellation clear unconverged stack facts', () => {
  const ir = builder('stack-budget'),
    b = ir.block('entry');
  b.store(b.readRegister(darwin.stack_pointer), b.constant(i64, 1n));
  b.return();
  const program = ssa(ir.finish(b));
  for (const options of [{ max_work: 0 }, { max_stack_bytes: 4 }]) {
    const result = recoverStack(program, darwin, createOperationContext(), options);
    assert.equal(result.state, 'partial');
    assert.equal(result.values.size, 0);
    assert.equal(result.snapshots.size, 0);
    assert.deepEqual(result.accesses, []);
  }
  const controller = new AbortController();
  controller.abort();
  const cancelled = recoverStack(
    program,
    darwin,
    createOperationContext({ signal: controller.signal }),
  );
  assert.equal(cancelled.state, 'partial');
  assert.equal(cancelled.diagnostics[0]!.code, 'cancelled');
});

test('stack-passed nested pointers escape without a guessed signature or returned pointer', () => {
  const ir = builder('stack-outgoing-escape'),
    b = ir.block('entry'),
    sp = b.readRegister(darwin.stack_pointer);
  const pointer = b.int('sub', sp, b.constant(i64, 32n)),
    outgoing = b.int('sub', sp, b.constant(i64, 16n));
  b.writeRegister(darwin.stack_pointer, outgoing);
  b.store(outgoing, pointer);
  b.call(target, [], [], { registers: [], flags: [], memory: 'read_only' }, [
    `evidence_${'c'.repeat(64)}`,
  ]);
  b.return();
  const result = recoverStack(ssa(ir.finish(b)), darwin, createOperationContext());
  assert.equal(result.frame.escaped, true);
  assert.equal(result.frame.aliased, false);
});

test('returned stack addresses escape without calls or outgoing stack stores', () => {
  const ir = builder('stack-return-escape'),
    b = ir.block('entry');
  b.return([b.int('sub', b.readRegister(darwin.stack_pointer), b.constant(i64, 32n))]);
  const result = recoverStack(ssa(ir.finish(b, [i64])), darwin, createOperationContext());
  assert.equal(result.frame.escaped, true);
  assert.equal(result.frame.aliased, false);
});

test('explicit undefined bytes dominate unknown bytes when reassembling a value', () => {
  const ir = builder('stack-undefined'),
    b = ir.block('entry'),
    slot = b.int('sub', b.readRegister(darwin.stack_pointer), b.constant(i64, 8n));
  b.store(slot, b.indeterminate(i8, 'undefined', 'Undefined machine byte'));
  b.return([b.load(i64, slot)]);
  const result = recoverStack(ssa(ir.finish(b, [i64])), darwin, createOperationContext());
  const read = result.accesses.find((access) => access.kind === 'read')!;
  assert.equal(read.value.value.kind, 'undefined');
  assert.equal(read.value.initialization, 'uninitialized');
});

test('replacing SP with an unrelated unknown value retains a dynamic stack boundary', () => {
  const ir = builder('stack-replaced-sp'),
    b = ir.block('entry');
  b.writeRegister(darwin.stack_pointer, b.readRegister(register('replacement-sp', 64)));
  b.store(b.readRegister(darwin.stack_pointer), b.constant(i64, 9n));
  b.return();
  const result = recoverStack(ssa(ir.finish(b)), darwin, createOperationContext());
  assert.equal(result.frame.dynamic, true);
  assert.equal(result.frame.aliased, true);
  assert.equal(result.accesses[0]!.region, 'dynamic');
  assert.equal(result.accesses[0]!.offset, null);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationContext,
  newIdentity,
  type AbiProfile,
  type Emission,
  type RegisterDescriptor,
} from '../../src/core/index.js';
import { darwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../src/abi/sysv-amd64/index.js';
import { windowsX64Abi } from '../../src/abi/windows-x64/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { recoverTypes } from '../../src/analysis/types/index.js';
import { integer, type RegisterIR, type SSAForm, type Value } from '../../src/ir/index.js';
import type { EmissionInput } from '../../src/emitters/model.js';
import { frameLayout } from '../../src/reconstruction/source-stack.js';
import { builder, image, slice } from '../ir/support.js';
import { emit, emittedFormals, execute, type Observation } from '../emitters/c/support.js';

const u64 = integer(64),
  u32 = integer(32);

test('frame layout: exact access sets are scalars; overlap, interior and indexed addresses are byte arrays', () => {
  const accesses = [
    // One exact access set: a scalar.
    { offset: -80n, end: -72n, id: 'a' },
    { offset: -80n, end: -72n, id: 'b' },
    // A wide store and the narrow halves read from it overlap: one byte array.
    { offset: -64n, end: -56n, id: 'c' },
    { offset: -64n, end: -60n, id: 'd' },
    { offset: -60n, end: -56n, id: 'e' },
    // An indexed base absorbs the accesses that continue it without a gap.
    { offset: -48n, end: -44n, id: 'f' },
    { offset: -44n, end: -40n, id: 'g' },
    { offset: -40n, end: -32n, id: 'h' },
    { offset: -28n, end: -24n, id: 'i' },
    // No scalar type has three bytes.
    { offset: -20n, end: -17n, id: 'j' },
    // An address taken strictly inside a member.
    { offset: -12n, end: -8n, id: 'k' },
  ];
  // Taken addresses in gaps start byte arrays that run to the next member;
  // offsets at or above the entry SP are not frame bytes.
  const taken = [-100n, -80n, -16n, -10n, 8n];
  const members = (returnAddressBytes: bigint) =>
    frameLayout(accesses, taken, new Set([-48n, 0n]), 16, returnAddressBytes);
  const expected = [
    { offset: -100n, size: 20n, scalar: false, access_ids: [] },
    { offset: -80n, size: 8n, scalar: true, access_ids: ['a', 'b'] },
    { offset: -64n, size: 8n, scalar: false, access_ids: ['d', 'c', 'e'] },
    { offset: -48n, size: 16n, scalar: false, access_ids: ['f', 'g', 'h'] },
    { offset: -28n, size: 4n, scalar: true, access_ids: ['i'] },
    { offset: -20n, size: 3n, scalar: false, access_ids: ['j'] },
    { offset: -16n, size: 4n, scalar: false, access_ids: [] },
    { offset: -12n, size: 4n, scalar: false, access_ids: ['k'] },
  ];
  // The object ends at the entry SP and starts at a stack-aligned address:
  // the entry SP itself on arm64, 8 bytes past alignment after an x86 call.
  assert.deepEqual(members(0n), { minimum_offset: -112n, size: 112n, members: expected });
  assert.deepEqual(members(8n), { minimum_offset: -104n, size: 104n, members: expected });
  // Members never overlap and stay below the entry SP.
  for (const [index, member] of expected.entries())
    assert.ok(member.offset + member.size <= (expected[index + 1]?.offset ?? 0n));
});

function firstArgument(abi: AbiProfile): RegisterDescriptor {
  const location = abi.classifyCall({
    returns: { kind: 'void' },
    parameters: [{ kind: 'integer', bits: 64, signed: false }],
    variadic: false,
    fixed_parameter_count: 1,
  }).parameters[0]!.locations[0]!;
  if (location.kind !== 'register') throw new Error('Expected register argument');
  return location.register;
}

interface Fixture {
  readonly ir: SSAForm;
  readonly extra: Omit<EmissionInput, 'function'>;
}

function prepare(input: RegisterIR, abi: AbiProfile): Fixture {
  const ir = constructSSA(input).value as SSAForm;
  const types = recoverTypes(ir, abi, createOperationContext(), {
    image_id: image,
    slice_id: slice,
    revision: 0,
  });
  const callees = ir.blocks.flatMap((block) =>
    block.instructions.flatMap((node) =>
      node.kind === 'call'
        ? [
            {
              call_id: node.id,
              parameters: [firstArgument(abi)],
              returns: [],
              argument_list_complete: false,
              argument_list_closure: 'callee_reads' as const,
              evidence_ids: [],
            },
          ]
        : [],
    ),
  );
  return { ir, extra: { types, source: { abi, callees, addresses: [] } } };
}

for (const abi of [darwinArm64Abi, sysvAMD64Abi, windowsX64Abi])
  test(`${abi.id}: an escaped, indexed and overlapping frame prints as one frame object with unchanged memory semantics`, () => {
    const b = builder(`frame-object-${abi.id}`),
      block = b.block('entry');
    const index = block.readRegister(firstArgument(abi));
    const entry = block.readRegister(abi.stack_pointer);
    const sp = block.int('sub', entry, block.constant(u64, 64n));
    block.writeRegister(abi.stack_pointer, sp);
    const at = (offset: bigint) => block.int('add', sp, block.constant(u64, 64n + offset));
    const base = at(-48n),
      wide = at(-24n),
      escaped = at(-8n);
    block.store(base, block.constant(u32, 1n));
    block.store(at(-44n), block.constant(u32, 2n));
    // Low half 4, high half 3, read back as two 32-bit halves.
    block.store(wide, block.constant(u64, 0x0000000300000004n));
    block.store(escaped, block.constant(u64, 7n));
    block.writeRegister(firstArgument(abi), escaped);
    block.call(
      { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
      [],
      [],
      abi.unknown_call_clobbers,
      [newIdentity('evidence')],
    );
    // A nonnegative index from the base may reach any later member.
    const scaled = block.int(
      'shl',
      block.cast('zero_extend', u64, block.extract(index, 0, 32)),
      block.constant(u64, 2n),
    );
    block.store(block.int('add', base, scaled), block.constant(u32, 9n));
    const read = (address: Value, type = u32) =>
      type === u32
        ? block.cast('zero_extend', u64, block.load(u32, address))
        : block.load(type, address);
    let sum = read(wide);
    for (const value of [read(at(-20n)), read(base), read(at(-44n)), read(escaped, u64)])
      sum = block.int('add', sum, value);
    block.return([sum]);
    const fixture = prepare(b.finish(block, [u64]), abi);
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(fixture.ir, fixture.extra, language).emission;
      assert.doesNotMatch(output.text, /\bentry_sp\b/, output.text);
      // The indexed run and the overlapped slot are byte arrays; the escaped
      // slot is a scalar member passed by address; padding fills the gaps.
      if (language === 'c-like') {
        assert.match(output.text, /uint8_t local_30\[8\];/, output.text);
        assert.match(output.text, /uint8_t pad_28\[16\];/, output.text);
        assert.match(output.text, /uint8_t local_18\[8\];/, output.text);
        assert.match(output.text, /uint64_t local_8;/, output.text);
        assert.match(output.text, /sub_2000\(&frame\.local_8\)/, output.text);
      } else {
        assert.match(output.text, /frame\.local_30: array<uint8_t, 8>/, output.text);
        assert.match(output.text, /frame\.local_8: uint64_t/, output.text);
        assert.match(output.text, /sub_2000\(address_of\(frame\.local_8\)\)/, output.text);
      }
      const formals = emittedFormals(output);
      assert.equal(formals.length, 1, output.text);
      // The indexed store lands on the base run, padding, either half of the
      // overlapped slot or the low half of the escaped slot.
      for (const [offset, expected] of [
        [0n, 9n + 2n + 4n + 3n + 7n],
        [1n, 1n + 9n + 4n + 3n + 7n],
        [2n, 1n + 2n + 4n + 3n + 7n],
        [6n, 1n + 2n + 9n + 3n + 7n],
        [7n, 1n + 2n + 4n + 9n + 7n],
        [10n, 1n + 2n + 4n + 3n + 9n],
      ] as const) {
        const addresses: bigint[] = [];
        const observation = execute(
          output,
          new Map([[formals[0]!.statement_id, offset]]),
          new Map(),
          0n,
          new Map(),
          new Map(),
          new Map([['sub_2000', (args: readonly bigint[]) => (addresses.push(args[0]!), [])]]),
        );
        assert.deepEqual(observation.values, [expected], `${language} index ${offset}`);
        assert.equal(addresses.length, 1);
        // Stores and loads stay in order; nothing is forwarded.
        assert.deepEqual(
          observation.events.filter((event) => event === 'store' || event === 'load'),
          ['store', 'store', 'store', 'store', 'store', 'load', 'load', 'load', 'load', 'load'],
        );
      }
    }
  });

const ENTRY_SP = 0x8000n;

/** A frame of 32 bytes below the entry SP; `at(k)` is the entry-SP address
 * `k` computed from the allocated SP, `incoming` the first incoming stack
 * argument slot (above the return address on x86). */
function entryFrame(abi: AbiProfile, name: string) {
  const b = builder(`frame-entry-${name}-${abi.id}`),
    block = b.block('entry');
  const argument = block.readRegister(firstArgument(abi));
  const sp = block.int('sub', block.readRegister(abi.stack_pointer), block.constant(u64, 32n));
  block.writeRegister(abi.stack_pointer, sp);
  const at = (offset: bigint) => block.int('add', sp, block.constant(u64, 32n + offset));
  const call = (address: Value) => {
    block.writeRegister(firstArgument(abi), address);
    block.call(
      { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
      [],
      [],
      abi.unknown_call_clobbers,
      [newIdentity('evidence')],
    );
  };
  const finish = () => prepare(b.finish(block, [u64]), abi);
  return { block, argument, at, incoming: abi.stack_return_address_bytes, call, finish };
}

/** The checked view names each register the call clobbers; none reaches the
 * explicit result, so any value serves. */
const clobbered = new (class extends Map<string, bigint> {
  override get(): bigint {
    return 0n;
  }
})();

/** Runs one view with the entry SP at `ENTRY_SP`, the 32 frame bytes below
 * it mapped (the checked view addresses them there) and `incoming` in the
 * first incoming stack slot; the callee leaves memory unchanged in both views.
 * A `stack_args` formal (S4) is the address of those incoming bytes. */
function run(emission: Emission, abi: AbiProfile, argument: bigint, incoming: bigint): Observation {
  const memory = new Map<bigint, number>();
  for (let offset = -32n; offset < abi.stack_return_address_bytes; offset++)
    memory.set(ENTRY_SP + offset, 0);
  for (let index = 0n; index < 8n; index++)
    memory.set(
      ENTRY_SP + abi.stack_return_address_bytes + index,
      Number((incoming >> (8n * index)) & 0xffn),
    );
  const formals = emittedFormals(emission);
  assert.equal(formals.length, 2, emission.text);
  return execute(
    emission,
    new Map(
      formals.map((formal) => [
        formal.statement_id,
        formal.name === 'entry_sp'
          ? ENTRY_SP
          : formal.name === 'stack_args'
            ? ENTRY_SP + abi.stack_return_address_bytes
            : argument,
      ]),
    ),
    memory,
    0n,
    new Map(),
    clobbered,
    new Map([['sub_2000', () => []]]),
  );
}

/** The source view prints every negative entry-SP offset through the frame
 * object and, `beside` it, either the entry SP only in nonnegative expressions
 * or (S4) the incoming bytes through the `stack_args` formal; its values and
 * event order equal the checked view's. */
function assertBeside(
  fixture: Fixture,
  abi: AbiProfile,
  cases: readonly (readonly [argument: bigint, incoming: bigint, expected: bigint])[],
  events: readonly string[],
  beside: 'entry_sp' | 'stack_args' = 'entry_sp',
): void {
  for (const language of ['c-like', 'python-like'] as const) {
    const output = emit(fixture.ir, fixture.extra, language).emission,
      checked = emit(fixture.ir, fixture.extra, language, 'checked').emission;
    const text = output.text;
    // The checked view keeps every frame byte in entry-SP form.
    assert.match(checked.text, /entry_sp - /, checked.text);
    assert.doesNotMatch(checked.text, /\bframe\b|\bstack_args\b/, checked.text);
    assert.match(text, language === 'c-like' ? /\} frame;/ : /frame = stack_frame\(/, text);
    assert.doesNotMatch(text, /\bentry_sp\s*-|-\s*\(?entry_sp\b/, text);
    if (beside === 'entry_sp') {
      assert.match(text, /\bentry_sp\b/, text);
      assert.ok(
        output.local_validation?.some((record) => record.rule === 'frame_object_beside_entry_sp'),
      );
    } else {
      assert.doesNotMatch(text, /\bentry_sp\b/, text);
      assert.match(
        text,
        language === 'c-like' ? /struct stack_args_\w+ stack_args\)/ : /stack_args: struct\{/,
        text,
      );
      assert.ok(output.local_validation?.some((record) => record.rule === 'incoming_object'));
    }
    for (const [argument, incoming, expected] of cases) {
      const source = run(output, abi, argument, incoming),
        machine = run(checked, abi, argument, incoming);
      assert.deepEqual(source.values, [expected], `${language} ${argument}\n${text}`);
      assert.deepEqual(machine.values, source.values, checked.text);
      assert.deepEqual(source.events, events, text);
      assert.deepEqual(machine.events, source.events, checked.text);
    }
  }
}

const mask64 = (1n << 64n) - 1n;
for (const abi of [darwinArm64Abi, sysvAMD64Abi, windowsX64Abi]) {
  test(`${abi.id}: an escaped negative slot prints as a frame member beside the incoming object`, () => {
    const f = entryFrame(abi, 'escaped');
    const slot = f.at(-16n),
      incoming = f.at(f.incoming);
    f.block.store(slot, f.block.constant(u64, 7n));
    // The incoming slot is stored and reloaded; no exposure can designate it
    // (the escaped address is a frame address), so it is the S4 incoming object.
    f.block.store(incoming, f.argument);
    f.call(slot);
    const sum = f.block.int('add', f.block.load(u64, slot), f.block.load(u64, incoming));
    f.block.return([sum]);
    assertBeside(
      f.finish(),
      abi,
      [0n, 5n, mask64, 1n << 63n].map((argument) => [argument, 0n, (argument + 7n) & mask64]),
      ['store', 'store', 'call', 'load', 'load'],
      'stack_args',
    );
  });

  test(`${abi.id}: an indexed negative base prints as a frame byte array beside the incoming object`, () => {
    const f = entryFrame(abi, 'indexed');
    const base = f.at(-32n);
    for (const index of [0n, 1n, 2n, 3n])
      f.block.store(f.at(-32n + 4n * index), f.block.constant(u32, index + 1n));
    f.block.store(f.at(f.incoming), f.argument);
    // Any index in 0..3 from the base reaches one of the four elements.
    const scaled = f.block.int(
      'shl',
      f.block.int('and', f.argument, f.block.constant(u64, 3n)),
      f.block.constant(u64, 2n),
    );
    f.block.store(f.block.int('add', base, scaled), f.block.constant(u32, 9n));
    let sum = f.block.load(u64, f.at(f.incoming));
    for (const index of [0n, 1n, 2n, 3n])
      sum = f.block.int(
        'add',
        sum,
        f.block.cast('zero_extend', u64, f.block.load(u32, f.at(-32n + 4n * index))),
      );
    f.block.return([sum]);
    assertBeside(
      f.finish(),
      abi,
      [0n, 1n, 2n, 3n, mask64].map((argument) => {
        const elements = [1n, 2n, 3n, 4n];
        elements[Number(argument & 3n)] = 9n;
        return [argument, 0n, (argument + elements.reduce((a, b) => a + b)) & mask64];
      }),
      [
        'store',
        'store',
        'store',
        'store',
        'store',
        'store',
        'load',
        'load',
        'load',
        'load',
        'load',
      ],
      'stack_args',
    );
  });

  test(`${abi.id}: an incoming-argument address stored in a frame slot and dereferenced keeps entry_sp`, () => {
    const f = entryFrame(abi, 'stored');
    const slot = f.at(-16n);
    f.block.store(slot, f.at(f.incoming));
    f.call(slot);
    const pointer = f.block.load(u64, slot);
    const sum = f.block.int('add', f.block.load(u64, pointer), f.argument);
    f.block.return([sum]);
    assertBeside(
      f.finish(),
      abi,
      [
        [0n, 0x1234n, 0x1234n],
        [mask64, 2n, 1n],
        [1n << 63n, 0x0123456789abcdefn, (1n << 63n) + 0x0123456789abcdefn],
      ],
      ['store', 'call', 'load', 'load'],
    );
  });

  test(`${abi.id}: without frame bytes below the entry SP there is no frame object`, () => {
    const f = entryFrame(abi, 'none');
    const incoming = f.at(f.incoming);
    f.block.store(incoming, f.argument);
    f.call(incoming);
    const value = f.block.load(u64, incoming);
    f.block.return([value]);
    const fixture = f.finish();
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(fixture.ir, fixture.extra, language).emission;
      assert.doesNotMatch(output.text, /\bframe\b/, output.text);
      assert.doesNotMatch(output.text, /\bentry_sp\s*-/, output.text);
      for (const argument of [0n, mask64]) {
        const source = run(output, abi, argument, 0n),
          machine = run(
            emit(fixture.ir, fixture.extra, language, 'checked').emission,
            abi,
            argument,
            0n,
          );
        assert.deepEqual(source.values, [argument], output.text);
        assert.deepEqual(machine.values, source.values);
        assert.deepEqual(source.events, ['store', 'call', 'load']);
        assert.deepEqual(machine.events, source.events);
      }
    }
  });
}

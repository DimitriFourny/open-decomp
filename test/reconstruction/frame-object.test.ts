import assert from 'node:assert/strict';
import test from 'node:test';
import { newIdentity, type AbiProfile, type Emission } from '../../src/core/index.js';
import { darwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../src/abi/sysv-amd64/index.js';
import { windowsX64Abi } from '../../src/abi/windows-x64/index.js';
import { integer, type Value } from '../../src/ir/index.js';
import { frameLayout } from '../../src/reconstruction/source-stack.js';
import { builder, image } from '../ir/support.js';
import { emit, emittedFormals, execute, type Observation } from '../emitters/c/support.js';
import {
  assertMatchesIR,
  firstArgument,
  prepare,
  runSource,
  savedFrame,
  sourcePlan,
  type Fixture,
  WRITTEN,
} from './frame-support.js';

const u64 = integer(64),
  u32 = integer(32);

test('frame layout: exact access sets are scalars; partial overlap, interior and indexed addresses are byte arrays', () => {
  const accesses = [
    // One exact access set: a scalar.
    { offset: -80n, end: -72n, id: 'a' },
    { offset: -80n, end: -72n, id: 'b' },
    // A wide store and the narrow halves read from it: two scalar members.
    { offset: -64n, end: -56n, id: 'c', transport: true },
    { offset: -64n, end: -60n, id: 'd' },
    { offset: -60n, end: -56n, id: 'e' },
    // Partially overlapping accesses: one byte array.
    { offset: -56n, end: -52n, id: 'm' },
    { offset: -54n, end: -50n, id: 'n' },
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
    { offset: -64n, size: 4n, scalar: true, access_ids: ['d'] },
    { offset: -60n, size: 4n, scalar: true, access_ids: ['e'] },
    { offset: -56n, size: 6n, scalar: false, access_ids: ['m', 'n'] },
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

test('frame layout: a wide access over whole narrower clusters keeps them as scalar members', () => {
  const layout = (
    accesses: readonly { offset: bigint; end: bigint; id: string }[],
    taken: readonly bigint[] = [],
    indexed: readonly bigint[] = [],
    direction: 'below' | 'above' = 'below',
    origin = 0n,
  ) => frameLayout(accesses, taken, new Set(indexed), 16, origin, direction);
  const shapes = (result: ReturnType<typeof frameLayout>) =>
    result.members.map((member) => [member.offset, member.size, member.scalar]);
  const wide = (id: string, offset: bigint, end: bigint) => ({
    offset,
    end,
    id,
    transport: true,
  });
  // Two u32 halves under a u64.
  assert.deepEqual(layout([wide('w', -32n, -24n), wide('a', -32n, -28n), wide('b', -28n, -24n)]), {
    minimum_offset: -32n,
    size: 32n,
    members: [
      { offset: -32n, size: 4n, scalar: true, access_ids: ['a'] },
      { offset: -28n, size: 4n, scalar: true, access_ids: ['b'] },
    ],
  });
  // A u32 and its padding under a u64 and under a u128: a padding member
  // fills the uncovered bytes, both wide accesses cast at the first member.
  assert.deepEqual(
    layout([wide('x', -32n, -16n), wide('w', -32n, -24n), wide('a', -32n, -28n)]).members,
    [
      { offset: -32n, size: 4n, scalar: true, access_ids: ['a'] },
      { offset: -28n, size: 12n, scalar: false, access_ids: [] },
    ],
  );
  // Padding before the first member (a u64 store over a later u32 member) and
  // between members.
  assert.deepEqual(shapes(layout([wide('w', -32n, -24n), wide('a', -28n, -24n)])), [
    [-32n, 4n, false],
    [-28n, 4n, true],
  ]);
  assert.deepEqual(
    shapes(layout([wide('w', -32n, -16n), wide('a', -32n, -28n), wide('b', -24n, -16n)])),
    [
      [-32n, 4n, true],
      [-28n, 4n, false],
      [-24n, 8n, true],
    ],
  );
  // A wide access that cuts a member, partially overlapping narrow accesses
  // and a narrow access of an odd width keep one byte array.
  for (const group of [
    [wide('w', -32n, -26n), wide('a', -32n, -28n), wide('b', -28n, -24n)],
    [wide('w', -32n, -24n), wide('a', -28n, -22n)],
    [wide('a', -32n, -28n), wide('b', -30n, -26n), wide('w', -32n, -24n)],
    [wide('w', -32n, -24n), wide('a', -32n, -29n)],
  ])
    assert.deepEqual(shapes(layout(group)), [
      [
        -32n,
        group.reduce((end, access) => (access.end > end ? access.end : end), -99n) + 32n,
        false,
      ],
    ]);
  // A wide access that is computed on or dereferenced is a slot of its own
  // width: one byte array, whichever way the narrow accesses go.
  assert.deepEqual(
    shapes(
      layout([
        { ...wide('w', -32n, -24n), transport: false },
        wide('a', -32n, -28n),
        wide('b', -28n, -24n),
      ]),
    ),
    [[-32n, 8n, false]],
  );
  assert.deepEqual(
    shapes(
      layout([
        wide('x', -32n, -24n),
        { ...wide('w', -32n, -24n), transport: false },
        wide('a', -32n, -28n),
      ]),
    ),
    [[-32n, 8n, false]],
  );
  const spanning = [wide('w', -32n, -24n), wide('a', -32n, -28n), wide('b', -28n, -24n)];
  // An address taken at a member start keeps the split; inside a member or
  // padding, or an indexed base inside the span, make one byte array.
  assert.deepEqual(shapes(layout(spanning, [-28n])), [
    [-32n, 4n, true],
    [-28n, 4n, true],
  ]);
  for (const [taken, indexed] of [
    [[-30n], []],
    [[], [-32n]],
    [[], [-28n]],
  ] as const)
    assert.deepEqual(shapes(layout(spanning, taken, indexed)), [[-32n, 8n, false]]);
  const padded = [wide('w', -32n, -24n), wide('a', -32n, -28n)];
  assert.deepEqual(shapes(layout(padded, [-28n])), [
    [-32n, 4n, true],
    [-28n, 4n, false],
  ]);
  assert.deepEqual(shapes(layout(padded, [-26n])), [[-32n, 8n, false]]);
  // The incoming object (above): the wide access's padding is a member, so the
  // object still ends at its last member.
  assert.deepEqual(
    layout([wide('w', 8n, 24n), wide('a', 8n, 16n), wide('b', 16n, 20n)], [], [], 'above', 8n),
    {
      minimum_offset: 8n,
      size: 16n,
      members: [
        { offset: 8n, size: 8n, scalar: true, access_ids: ['a'] },
        { offset: 16n, size: 4n, scalar: true, access_ids: ['b'] },
        { offset: 20n, size: 4n, scalar: false, access_ids: [] },
      ],
    },
  );
});

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
      // The indexed run is a byte array; the wide slot keeps its two 32-bit
      // halves as members and the wide access casts at the first; the escaped
      // slot is a scalar member passed by address; padding fills the gaps.
      if (language === 'c-like') {
        assert.match(output.text, /uint8_t local_30\[8\];/, output.text);
        assert.match(output.text, /uint8_t pad_28\[16\];/, output.text);
        assert.match(output.text, /uint32_t local_18;\s+uint32_t local_14;/, output.text);
        assert.match(output.text, /\*\(uint64_t \*\)&frame\.local_18 = /, output.text);
        assert.match(output.text, /uint64_t local_8;/, output.text);
        assert.match(output.text, /sub_2000\(&frame\.local_8\)/, output.text);
      } else {
        assert.match(output.text, /frame\.local_30: array<uint8_t, 8>/, output.text);
        assert.match(output.text, /frame\.local_18: uint32_t/, output.text);
        assert.match(output.text, /frame\.local_14: uint32_t/, output.text);
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
 * A `stack_args` formal (S4) is the address of those incoming bytes; a Darwin
 * `va_start` area starts at that slot (`va`, input `...`). */
function run(emission: Emission, abi: AbiProfile, argument: bigint, incoming: bigint): Observation {
  const memory = new Map<bigint, number>();
  for (let offset = -32n; offset < abi.stack_return_address_bytes; offset++)
    memory.set(ENTRY_SP + offset, 0);
  for (let index = 0n; index < 8n; index++)
    memory.set(
      ENTRY_SP + abi.stack_return_address_bytes + index,
      Number((incoming >> (8n * index)) & 0xffn),
    );
  const formals = emittedFormals(emission),
    variadic = /\bva_start\(/.test(emission.text);
  assert.equal(formals.length, variadic ? 1 : 2, emission.text);
  return execute(
    emission,
    new Map([
      ...formals.map((formal): [string, bigint] => [
        formal.statement_id,
        formal.name === 'entry_sp'
          ? ENTRY_SP
          : formal.name === 'stack_args'
            ? ENTRY_SP + abi.stack_return_address_bytes
            : argument,
      ]),
      ...(variadic ? [['...', ENTRY_SP + abi.stack_return_address_bytes] as [string, bigint]] : []),
    ]),
    memory,
    0n,
    new Map(),
    clobbered,
    new Map([['sub_2000', () => []]]),
  );
}

/** The source view prints every negative entry-SP offset through the frame
 * object and, beside it, the entry SP (or, for a Darwin `va_start` area, `va`)
 * only in nonnegative expressions, or (S4) the incoming bytes through the
 * `stack_args` formal; its values and event order equal the checked view's. */
function assertBeside(
  fixture: Fixture,
  abi: AbiProfile,
  cases: readonly (readonly [argument: bigint, incoming: bigint, expected: bigint])[],
  events: readonly string[],
  base: 'entry_sp' | 'va' | 'stack_args' = 'entry_sp',
): void {
  for (const language of ['c-like', 'python-like'] as const) {
    const output = emit(fixture.ir, fixture.extra, language).emission,
      checked = emit(fixture.ir, fixture.extra, language, 'checked').emission;
    const text = output.text;
    // The checked view keeps every frame byte in entry-SP form.
    assert.match(checked.text, /entry_sp - /, checked.text);
    assert.doesNotMatch(checked.text, /\bframe\b|\bstack_args\b/, checked.text);
    assert.match(text, language === 'c-like' ? /\} frame;/ : /frame = stack_frame\(/, text);
    assert.doesNotMatch(text, /\b(?:entry_sp|va)\s*-|-\s*\(?(?:entry_sp|va)\b/, text);
    if (base === 'stack_args') {
      assert.doesNotMatch(text, /\bentry_sp\b/, text);
      assert.match(
        text,
        language === 'c-like' ? /struct stack_args_\w+ stack_args\)/ : /stack_args: struct\{/,
        text,
      );
      assert.ok(output.local_validation?.some((record) => record.rule === 'incoming_object'));
    } else {
      if (base === 'va') {
        assert.match(text, /\bva_start\(/, text);
        assert.doesNotMatch(text, /\bentry_sp\b/, text);
      } else assert.match(text, /\bentry_sp\b/, text);
      assert.ok(
        output.local_validation?.some((record) => record.rule === 'frame_object_beside_entry_sp'),
      );
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

  test(`${abi.id}: wide copies over two u32 members and over a u32 plus padding keep the scalar members`, () => {
    const f = entryFrame(abi, 'spanning');
    const pair = f.at(-16n),
      padded = f.at(-32n),
      copies = [f.at(-24n), f.at(-8n)],
      incoming = f.at(f.incoming);
    const word = f.block.extract(f.argument, 0, 32);
    f.block.store(incoming, f.argument);
    // Two u32 members, copied as one u64.
    f.block.store(pair, word);
    f.block.store(f.at(-12n), f.block.constant(u32, 7n));
    // A u32 member over a u64 whose high half stays padding: a constant
    // initialization, a u32 update and a copy of the whole u64.
    f.block.store(padded, f.block.constant(u64, 0x1122334455667788n));
    f.block.store(padded, f.block.int('add', word, f.block.constant(u32, 1n)));
    f.call(pair);
    f.call(padded);
    f.block.store(copies[0]!, f.block.load(u64, pair));
    f.block.store(copies[1]!, f.block.load(u64, padded));
    f.call(copies[0]!);
    f.call(copies[1]!);
    const sum = f.block.int(
      'add',
      f.block.int('add', f.block.load(u64, copies[0]!), f.block.load(u64, copies[1]!)),
      f.block.load(u64, incoming),
    );
    f.block.return([sum]);
    const fixture = f.finish();
    const text = emit(fixture.ir, fixture.extra, 'c-like').emission.text;
    assert.match(text, /uint32_t local_10;\s+uint32_t local_c;/, text);
    assert.match(text, /\*\(uint64_t \*\)&frame\.local_10\b/, text);
    assert.match(text, /\*\(uint64_t \*\)&frame\.local_20 = /, text);
    // The padding under the u64 is an explicit byte-array member.
    assert.match(text, /uint32_t local_20;\s+uint8_t local_1c\[4\];/, text);
    const python = emit(fixture.ir, fixture.extra, 'python-like').emission.text;
    assert.match(python, /frame\.local_10: uint32_t/, python);
    assert.match(python, /frame\.local_c: uint32_t/, python);
    assert.match(python, /frame\.local_20: uint32_t/, python);
    assert.match(python, /frame\.local_1c: array<uint8_t, 4>/, python);
    assertBeside(
      fixture,
      abi,
      [0n, 5n, 0xffffffffn, mask64, 1n << 63n].map((argument) => {
        const low = argument & 0xffffffffn;
        return [
          argument,
          0n,
          (((7n << 32n) | low) + (0x1122334400000000n | ((low + 1n) & 0xffffffffn)) + argument) &
            mask64,
        ];
      }),
      [
        ...['store', 'store', 'store', 'store', 'store', 'call', 'call'],
        ...['load', 'store', 'load', 'store', 'call', 'call', 'load', 'load', 'load'],
      ],
      'stack_args',
    );
  });

  test(`${abi.id}: a pointer-width slot whose load is computed on keeps one byte array beside a narrow read`, () => {
    const f = entryFrame(abi, 'pointer-slot');
    const slot = f.at(-16n),
      incoming = f.at(f.incoming);
    f.block.store(incoming, f.argument);
    // A u64 spill, read back whole (arithmetic) and as its low half.
    f.block.store(slot, f.argument);
    f.call(slot);
    const sum = f.block.int(
      'add',
      f.block.int('add', f.block.load(u64, slot), f.block.load(u64, incoming)),
      f.block.cast('zero_extend', u64, f.block.load(u32, slot)),
    );
    f.block.return([sum]);
    const fixture = f.finish();
    const text = emit(fixture.ir, fixture.extra, 'c-like').emission.text;
    assert.match(text, /uint8_t local_10\[8\];/, text);
    assert.doesNotMatch(text, /uint32_t local_10;/, text);
    const python = emit(fixture.ir, fixture.extra, 'python-like').emission.text;
    assert.match(python, /frame\.local_10: array<uint8_t, 8>/, python);
    assertBeside(
      fixture,
      abi,
      [0n, 5n, 0xffffffffn, mask64, 1n << 63n].map((argument) => [
        argument,
        0n,
        (2n * argument + (argument & 0xffffffffn)) & mask64,
      ]),
      ['store', 'store', 'call', 'load', 'load', 'load'],
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

  test(`${abi.id}: an incoming-argument address stored in a frame slot and dereferenced keeps its entry base`, () => {
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
      // Darwin: an escaping pointer to the first incoming slot is a `va_start` area.
      abi.id === 'darwin-arm64' ? 'va' : 'entry_sp',
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
      assert.doesNotMatch(output.text, /\b(?:entry_sp|va)\s*-/, output.text);
      assert.equal(/\bva_start\(/.test(output.text), abi.id === 'darwin-arm64', output.text);
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

/** A3 fixtures over a frame whose top 8 bytes save a preserved register: a
 * u32 slot passed to `sub_2000`, which writes one byte through the pointer.
 * - `below-save`: the slot is entry-SP `[-12, -8)`, directly below the save;
 * - `array`: the slot `[-16, -8)` is indexed from its start (two u32 halves);
 * - `gap`: the slot is `[-16, -12)`, the bytes up to the save untouched;
 * - `two-members`: the escape at -16 reaches u32 slots at -16 and -12;
 * - `interior`: the slot's address + 2 escapes too;
 * - `indexed`: a byte store indexed from the slot's address + 1;
 * - `entry-live`: the first incoming slot's address escapes (live entry SP). */
type SlotShape =
  'below-save' | 'array' | 'gap' | 'two-members' | 'interior' | 'indexed' | 'entry-live';
function escapedSlot(abi: AbiProfile, shape: SlotShape) {
  const f = savedFrame(abi, `slot-${shape}`);
  const pair = shape === 'array' || shape === 'two-members',
    base = f.at(pair || shape === 'gap' ? -16n : -12n);
  f.block.store(base, f.block.constant(u32, 3n));
  if (pair) f.block.store(f.at(-12n), f.block.constant(u32, 4n));
  f.call(base);
  if (shape === 'interior') f.call(f.at(-10n));
  if (shape === 'entry-live') f.call(f.at(f.incoming));
  if (shape === 'indexed' || shape === 'array') {
    const index = f.block.int(
      'and',
      f.argument,
      f.block.constant(u64, shape === 'array' ? 7n : 1n),
    );
    f.block.store(
      f.block.int('add', shape === 'array' ? base : f.at(-11n), index),
      f.block.constant(integer(8), 9n),
    );
  }
  let sum = f.block.cast('zero_extend', u64, f.block.load(u32, base));
  if (pair)
    sum = f.block.int('add', sum, f.block.cast('zero_extend', u64, f.block.load(u32, f.at(-12n))));
  return f.finish(sum);
}

const ARGUMENTS = [0n, 1n, 2n, 5n, 7n, mask64] as const;
for (const abi of [darwinArm64Abi, sysvAMD64Abi, windowsX64Abi]) {
  test(`${abi.id}: an escaped slot directly below the save area is an independent local`, () => {
    const fixture = escapedSlot(abi, 'below-save');
    const plan = sourcePlan(fixture);
    const stack = plan.source?.stack;
    assert.equal(stack?.kind, 'object');
    if (stack?.kind !== 'object') return;
    assert.deepEqual(
      stack.members.map((member) => [member.offset, member.size, !!member.independent]),
      [[-12n, 4n, true]],
    );
    assert.ok(plan.local_validation?.some((record) => record.rule === 'escaped_slot_object'));
    const premises = new Set(
      plan.local_validation_session?.abiConformance.map((site) => site.rule),
    );
    assert.ok(premises.has('frame_object_base') && premises.has('frame_save'));
    for (const language of ['c-like', 'python-like'] as const) {
      const text = emit(fixture.ir, fixture.extra, language).emission.text;
      assert.doesNotMatch(text, /\bframe\b|stack_frame|entry_sp/, text);
      if (language === 'c-like') {
        assert.match(text, /^ {2}uint32_t local_c;$/m, text);
        assert.match(text, /sub_2000\(&local_c\b/, text);
      } else {
        assert.match(text, /^ {2}local_c: uint32_t$/m, text);
        assert.match(text, /sub_2000\(address_of\(local_c\)/, text);
      }
    }
    // The callee writes the slot's low byte through the pointer, and the
    // independent local reads it back, as in the IR.
    assertMatchesIR(fixture, abi, ARGUMENTS);
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(fixture.ir, fixture.extra, language).emission;
      const observed = runSource(output, abi, 0n);
      assert.deepEqual(observed.values, [WRITTEN]);
      assert.deepEqual(observed.events, ['store', 'call', 'load']);
    }
  });

  test(`${abi.id}: an escaped byte array indexed from its start below the save area is an independent local`, () => {
    const fixture = escapedSlot(abi, 'array');
    const stack = sourcePlan(fixture).source?.stack;
    assert.ok(stack?.kind === 'object');
    assert.deepEqual(
      stack.members.map((member) => [
        member.offset,
        member.size,
        member.scalar,
        !!member.independent,
      ]),
      [[-16n, 8n, false, true]],
    );
    const c = emit(fixture.ir, fixture.extra).emission.text,
      python = emit(fixture.ir, fixture.extra, 'python-like').emission.text;
    assert.match(c, /^ {2}uint8_t local_10\[8\];$/m, c);
    assert.doesNotMatch(c, /\bframe\b/, c);
    assert.match(python, /^ {2}local_10: array<uint8_t, 8>$/m, python);
    assert.doesNotMatch(python, /\bframe\b|stack_frame/, python);
    assertMatchesIR(fixture, abi, ARGUMENTS);
  });

  for (const shape of ['gap', 'two-members', 'interior', 'indexed', 'entry-live'] as const)
    test(`${abi.id}: ${shape} keeps an escaped slot in the frame object`, () => {
      const fixture = escapedSlot(abi, shape);
      const plan = sourcePlan(fixture);
      const stack = plan.source?.stack;
      assert.ok(stack?.kind === 'object');
      assert.ok(stack.members.length > 0);
      assert.ok(stack.members.every((member) => !member.independent));
      assert.ok(!plan.local_validation?.some((record) => record.rule === 'escaped_slot_object'));
      const text = emit(fixture.ir, fixture.extra).emission.text;
      assert.match(text, /\} frame;/, text);
      assertMatchesIR(fixture, abi, ARGUMENTS);
    });
}

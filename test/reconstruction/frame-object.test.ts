import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationContext,
  newIdentity,
  type AbiProfile,
  type RegisterDescriptor,
} from '../../src/core/index.js';
import { darwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../src/abi/sysv-amd64/index.js';
import { windowsX64Abi } from '../../src/abi/windows-x64/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { recoverTypes } from '../../src/analysis/types/index.js';
import { integer, type RegisterIR, type SSAForm, type Value } from '../../src/ir/index.js';
import { frameLayout } from '../../src/reconstruction/source-stack.js';
import { builder, image, slice } from '../ir/support.js';
import { emit, emittedFormals, execute } from '../emitters/c/support.js';

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

function prepare(input: RegisterIR, abi: AbiProfile) {
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

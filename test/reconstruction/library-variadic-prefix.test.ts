import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationContext,
  globalDataIdentity,
  newIdentity,
  type AbiProfile,
  type AbiSignature,
  type Address,
  type RegisterDescriptor,
} from '../../src/core/index.js';
import { darwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../src/abi/sysv-amd64/index.js';
import { windowsX64Abi } from '../../src/abi/windows-x64/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { recoverTypes } from '../../src/analysis/types/index.js';
import { integer, type SSAForm } from '../../src/ir/index.js';
import { structureControlFlow } from '../../src/presentation/index.js';
import { reconstruct, type Reconstruction } from '../../src/reconstruction/index.js';
import type { SourceAddress } from '../../src/reconstruction/source-model.js';
import { builder, image, slice } from '../ir/support.js';
import { emit, emittedFormals, execute } from '../emitters/c/support.js';

const u64 = integer(64);
const at = (value: bigint): Address => ({ image_id: image, space: 'va', value });
const fprintfAddress = at(0x2000n);
const streams = [0x7000n, 0x7008n] as const;
const formats = [
  [0x9000n, '%d B'],
  [0x9010n, '%0.3f KiB'],
] as const;
const streamPointers = [0xaaa0n, 0xbbb0n] as const;

const stringAt = (value: bigint, text: string): SourceAddress => ({
  address: at(value),
  string: text,
  string_byte_length: BigInt(Buffer.byteLength(text)),
  string_encoding: 'ascii',
  string_start: true,
  object: {
    address: at(value),
    entity_id: globalDataIdentity(slice, at(value)),
    byte_length: null,
    offset: 0n,
    mutable: false,
    kind: 'bytes',
    evidence_ids: [],
  },
});

/** `int fprintf(FILE*, const char*, ...)` as an established library contract. */
const fprintfSignature: AbiSignature = {
  returns: { kind: 'integer', bits: 32, signed: true },
  parameters: [{ kind: 'pointer' }, { kind: 'pointer' }],
  variadic: true,
  fixed_parameter_count: 2,
  argument_list_complete: false,
};

const argumentRegister = (abi: AbiProfile, index: number): RegisterDescriptor => {
  const location = abi.classifyCall({
    returns: { kind: 'void' },
    parameters: [
      { kind: 'integer', bits: 64, signed: false },
      { kind: 'integer', bits: 64, signed: false },
    ],
    variadic: false,
    fixed_parameter_count: 2,
  }).parameters[index]!.locations[0]!;
  assert.equal(location.kind, 'register');
  if (location.kind !== 'register') throw new Error('Expected register argument');
  return location.register;
};

/** `n` selects one of two `FILE*` loads and one of two literal formats that meet
 * in a join block; then `fprintf(stream, format)` with the anonymous tail unset. */
function fixture(abi: AbiProfile, withContract: boolean, conflicting = false) {
  const b = builder(`library-prefix-${abi.id}`),
    entry = b.block('entry'),
    left = b.block('left'),
    right = b.block('right'),
    join = b.block('join', [u64, u64]);
  const selector = entry.readRegister(argumentRegister(abi, 0));
  entry.branch(
    entry.compare('eq', selector, entry.constant(u64, 0n)),
    entry.edge(left),
    entry.edge(right),
  );
  for (const [block, index] of [
    [left, 0],
    [right, 1],
  ] as const)
    block.jump(join, [
      block.load(u64, block.constant(u64, streams[index])),
      block.constant(u64, formats[index]![0]),
    ]);
  join.writeRegister(argumentRegister(abi, 0), join.parameters[0]!);
  join.writeRegister(argumentRegister(abi, 1), join.parameters[1]!);
  join.call({ kind: 'direct', address: fprintfAddress }, [], [], abi.unknown_call_clobbers, [
    newIdentity('evidence'),
  ]);
  join.return([]);
  const ir = constructSSA(b.finish(entry, [])).value as SSAForm;
  const contract = (id: string, signature: AbiSignature) => ({
    id,
    target: { kind: 'address' as const, address: fprintfAddress },
    signature,
    evidence_ids: [],
  });
  const types = recoverTypes(ir, abi, createOperationContext(), {
    image_id: image,
    slice_id: slice,
    revision: 0,
    ...(withContract
      ? {
          contracts: [
            contract('fprintf', fprintfSignature),
            ...(conflicting
              ? [
                  contract('other', {
                    ...fprintfSignature,
                    parameters: [{ kind: 'pointer' as const }],
                  }),
                ]
              : []),
          ],
        }
      : {}),
  });
  const extra = {
    types,
    source: {
      abi,
      callees: [],
      addresses: [...formats.map(([value, text]) => stringAt(value, text))],
    },
  };
  const structured = structureControlFlow(ir, createOperationContext());
  assert.ok(structured.value);
  return {
    ir,
    extra,
    call: ir.blocks.flatMap((block) => block.instructions).find((node) => node.kind === 'call')!,
    view: (view: 'source' | 'checked') =>
      reconstruct({ function: structured.value!, ...extra }, createOperationContext(), view),
  };
}

const rules = (program: Reconstruction) =>
  program.local_validation
    ?.filter((record) => record.kind === 'presentation')
    .map((record) => record.rule) ?? [];

for (const abi of [darwinArm64Abi, sysvAMD64Abi, windowsX64Abi]) {
  test(`${abi.id}: an established variadic contract prints its fixed prefix with the list open`, () => {
    const { ir, extra, call, view } = fixture(abi, true);
    const source = view('source'),
      projection = source.calls.get(call.id)!;
    assert.equal(projection.kind, 'inferred');
    assert.equal(projection.argument_list_complete, false);
    assert.equal(projection.arguments.length, 2);
    assert.deepEqual(projection.results, []);
    assert.ok(rules(source).includes('library_fixed_prefix'));
    assert.ok(
      source.local_validation_session?.abiConformance.some(
        (site) => site.rule === 'library_fixed_prefix',
      ),
    );
    assert.ok(!rules(view('checked')).includes('library_fixed_prefix'));

    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(ir, extra, language).emission;
      assert.match(output.text, /sub_2000\(\w+, \w+\)/, output.text);
      assert.doesNotMatch(output.text, /sub_2000\(\.\.\.\)|entry_sp/, output.text);
      assert.ok(
        !emit(ir, extra, language, 'checked').emission.local_validation?.some(
          (record) => record.rule === 'library_fixed_prefix',
        ),
      );
      const formal = emittedFormals(output)[0]!;
      for (const [index, selector] of [0n, 1n].entries()) {
        const memory = new Map<bigint, number>();
        for (const slot of streams.keys())
          for (let byte = 0n; byte < 8n; byte++)
            memory.set(
              streams[slot]! + byte,
              Number((streamPointers[slot]! >> (8n * byte)) & 0xffn),
            );
        const observed: (readonly bigint[])[] = [];
        let open = false;
        execute(
          output,
          new Map([[formal.statement_id, selector]]),
          memory,
          0n,
          new Map(),
          new Map(),
          new Map([
            [
              'sub_2000',
              (args, context) => {
                observed.push(args);
                open = !context.arguments_complete;
                return 0n;
              },
            ],
          ]),
        );
        // The stream pointer is exact; the interpreter gives every string
        // literal one opaque address, so the formats are checked in the text.
        assert.equal(observed.length, 1, `${language} n=${selector}`);
        assert.equal(observed[0]!.length, 2);
        assert.equal(observed[0]![0], streamPointers[index]!, `${language} n=${selector}`);
        assert.ok(open, 'the argument list stays open');
      }
      for (const [, text] of formats) assert.ok(output.text.includes(`"${text}"`), output.text);
    }
  });
}

test('an unestablished or conflicting contract keeps the unresolved call', () => {
  for (const abi of [darwinArm64Abi, sysvAMD64Abi]) {
    for (const [withContract, conflicting] of [
      [false, false],
      [true, true],
    ] as const) {
      const { call, view } = fixture(abi, withContract, conflicting);
      const source = view('source');
      assert.ok(!rules(source).includes('library_fixed_prefix'), `${abi.id} ${withContract}`);
      assert.equal(source.calls.get(call.id)!.kind, 'physical');
    }
  }
});

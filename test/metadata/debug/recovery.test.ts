import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contentHash,
  createOperationContext,
  evidenceSchema,
  OperationError,
  type LoadedImage,
} from '../../../src/core/index.js';
import {
  recoverDebugInfo,
  selectDebugSections,
  type ExternalDebugInput,
} from '../../../src/metadata/debug/index.js';
import { parseDwarfSections } from '../../../src/metadata/dwarf/index.js';
import { abbreviation, Bytes, concat, macho } from '../dwarf/helpers.js';
import { fixtureDebug, fixtureImage } from './fixture.js';

function externalSections(
  image: LoadedImage,
  sections: Record<string, Uint8Array>,
): ExternalDebugInput {
  const slice = image.slices.find((candidate) => candidate.id === image.selected_slice_id)!;
  const header = selectDebugSections(
    image.bytes.read(slice.offset, Number(slice.size)),
    createOperationContext(),
  );
  const uuid = Uint8Array.from(
    header.uuid
      .replaceAll('-', '')
      .match(/../g)!
      .map((byte) => Number.parseInt(byte, 16)),
  );
  const bytes = new Uint8Array(macho(sections, header.subtype, uuid));
  return {
    bytes,
    artifact_id: `artifact_${contentHash(bytes)}`,
    expectedSha256: contentHash(bytes),
  };
}
function signatureSections(
  address: bigint,
  options: {
    name?: string;
    tag?: number;
    encoding?: number;
    language?: number;
    prototyped?: boolean;
    declaration?: boolean;
    convention?: number;
    parameters?: number;
  } = {},
): Record<string, Uint8Array> {
  const a = new Bytes();
  abbreviation(a, 1, 0x11, true, options.language === undefined ? [] : [[0x13, 5]]);
  abbreviation(a, 2, options.tag ?? 0x24, false, [
    [3, 8],
    [0xb, 0xb],
    ...(options.encoding === undefined ? [] : ([[0x3e, 0xb]] as [number, number][])),
  ]);
  abbreviation(a, 3, 0x2e, true, [
    [3, 8],
    [0x49, 0x13],
    [0x11, 1],
    [0x12, 6],
    [0x27, 0xc],
    [0x3c, 0xc],
    [0x36, 0xb],
  ]);
  abbreviation(a, 4, 5, false, [
    [3, 8],
    [0x49, 0x13],
  ]);
  a.byte(0);
  const b = new Bytes().uint(0).uint(4, 2).uint(0).byte(8, 1);
  if (options.language !== undefined) b.uint(options.language, 2);
  b.label('type')
    .byte(2)
    .string(options.name ?? 'int')
    .byte(4);
  if (options.encoding !== undefined) b.byte(options.encoding);
  b.byte(3)
    .string('identity')
    .ref('type')
    .uint(address, 8)
    .uint(4)
    .byte(options.prototyped ? 1 : 0, options.declaration ? 1 : 0, options.convention ?? 1);
  for (let index = 0; index < (options.parameters ?? 0); index++)
    b.byte(4).string(`parameter_${index}`).ref('type');
  b.byte(0, 0);
  const info = b.finish();
  new DataView(info.buffer).setUint32(0, info.length - 4, true);
  return { __debug_info: info, __debug_abbrev: a.finish() };
}

test('real linked DWARF recovers structural signatures, storage, inline scopes and source intervals', () => {
  const image = fixtureImage(),
    result = recoverDebugInfo(image, createOperationContext(), fixtureDebug());
  assert.ok(result.data);
  const sum = result.functions.find((fn) => fn.dwarf.name === 'debug_sum');
  assert.ok(sum?.signature);
  assert.deepEqual(
    sum.signature.parameters.map((parameter) => parameter.name),
    ['left', 'right'],
  );
  assert.deepEqual(
    result.types.find((type) => type.id === sum.signature?.return_type)?.definition,
    { kind: 'integer', bits: 32, signed: true },
  );
  const scale = result.functions.find((fn) => fn.dwarf.name === 'debug_scale');
  assert.ok(scale?.signature);
  assert.deepEqual(
    result.types.find((type) => type.id === scale.signature?.return_type)?.definition,
    { kind: 'float', bits: 64 },
  );
  const pair = result.functions.find((fn) => fn.dwarf.name === 'debug_pair');
  assert.ok(pair?.signature);
  assert.equal(
    result.types.find((type) => type.id === pair.signature?.parameters[0]?.type_id)?.definition
      .kind,
    'pointer',
  );
  assert.equal(pair.dwarf.signature?.parameters[0]?.type.pointeeConst, true);
  assert.equal(
    result.functions.find((fn) => fn.dwarf.name === 'debug_empty')?.signature?.parameters.length,
    0,
  );
  assert.ok(
    result.data.variables?.some(
      (variable) => variable.name === 'scoped' && variable.locations.length > 0,
    ),
  );
  assert.equal(result.data.inlineScopes?.length, 2);
  assert.ok(
    result.data.lines.every(
      (line) => line.endAddress !== undefined && line.address <= line.endAddress,
    ),
  );
  assert.equal(result.status, 'partial'); // Real fixture uses unsupported entry_value locations.
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'unavailable_semantics'));
  for (const evidence of result.evidence) {
    evidenceSchema.parse(evidence);
    assert.equal(evidence.origin.kind, 'debug');
    if (evidence.origin.kind === 'debug') assert.equal(evidence.origin.identity_verified, true);
  }
  assert.deepEqual(recoverDebugInfo(image, createOperationContext(), fixtureDebug()), result);
});

test('DWARF preserves known structure fields when alignment is not recorded', () => {
  const result = recoverDebugInfo(fixtureImage(), createOperationContext(), fixtureDebug());
  const structure = result.types.find((type) => type.display_name === 'Pair')?.definition;
  assert.ok(structure?.kind === 'structure');
  assert.equal(structure.size, 8n);
  assert.equal(structure.alignment, null);
  assert.deepEqual(
    structure.fields.map((field) => field.offset),
    [0n, 4n],
  );
  assert.deepEqual(
    structure.fields.map(
      (field) => result.types.find((type) => type.id === field.type_id)?.definition,
    ),
    [
      { kind: 'integer', bits: 32, signed: true },
      { kind: 'integer', bits: 32, signed: true },
    ],
  );
});

test('missing DWARF is explicit absence and leaves native loader facts unchanged', () => {
  const image = fixtureImage();
  const before = image.symbols;
  const result = recoverDebugInfo(image, createOperationContext());
  assert.equal(result.status, 'absent');
  assert.equal(result.data, null);
  assert.deepEqual(result.functions, []);
  assert.equal(image.symbols, before);
  assert.ok(image.symbols.some((symbol) => symbol.original_name === '_debug_sum'));
  assert.equal(parseDwarfSections(new Map(), createOperationContext()).status, 'absent');
});

test('external content, UUID and exact CPU/subtype conflicts reject before returning evidence', () => {
  const image = fixtureImage(),
    external = fixtureDebug();
  assert.throws(
    () =>
      recoverDebugInfo(image, createOperationContext(), {
        ...external,
        expectedSha256: '0'.repeat(64),
      }),
    (error: unknown) => error instanceof OperationError && error.code === 'conflicting_evidence',
  );
  for (const field of ['uuid', 'cpu', 'subtype'] as const) {
    const bytes = external.bytes.slice(),
      view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (field === 'cpu' || field === 'subtype')
      view.setUint32(field === 'cpu' ? 4 : 8, field === 'cpu' ? 0x1000007 : 2, true);
    else {
      let command = 32;
      for (let index = 0; index < view.getUint32(16, true); index++) {
        if (view.getUint32(command, true) === 0x1b) {
          bytes[command + 8] = bytes[command + 8]! ^ 255;
          break;
        }
        command += view.getUint32(command + 4, true);
      }
    }
    assert.throws(
      () =>
        recoverDebugInfo(image, createOperationContext(), {
          ...external,
          bytes,
          expectedSha256: contentHash(bytes),
        }),
      (error: unknown) => error instanceof OperationError && error.code === 'conflicting_evidence',
    );
  }
});

test('names cannot turn an aggregate or unspecified base encoding into an integer', () => {
  const image = fixtureImage(),
    address = image.symbols.find((symbol) => symbol.original_name === '_debug_sum')!.address!.value;
  for (const options of [
    { name: 'int', tag: 0x13 },
    { name: 'int' },
    { name: 'double', encoding: 5 },
  ]) {
    const result = recoverDebugInfo(
      image,
      createOperationContext(),
      externalSections(
        image,
        signatureSections(address, { ...options, prototyped: true, parameters: 1 }),
      ),
    );
    const fn = result.functions[0]!;
    assert.ok(fn.signature);
    const type = result.types.find(
      (candidate) => candidate.id === fn.signature?.parameters[0]?.type_id,
    )!;
    if (options.encoding === 5)
      assert.deepEqual(type.definition, { kind: 'integer', bits: 32, signed: true });
    else assert.notEqual(type.definition.kind, 'integer');
  }
});

test('concrete empty C definitions differ from unspecified declarations and alternative conventions', () => {
  const image = fixtureImage(),
    address = image.symbols.find((symbol) => symbol.original_name === '_debug_sum')!.address!.value;
  for (const [definition, language] of [
    [false, 0xc],
    [true, undefined],
    [true, 7],
    [true, 0xc],
  ] as const) {
    const options = {
      encoding: 5,
      declaration: !definition,
      ...(language === undefined ? {} : { language }),
    };
    const result = recoverDebugInfo(
      image,
      createOperationContext(),
      externalSections(image, signatureSections(address, options)),
    );
    assert.equal(result.functions[0]?.signature !== null, definition && language === 0xc);
  }
  const alternative = recoverDebugInfo(
    image,
    createOperationContext(),
    externalSections(
      image,
      signatureSections(address, { encoding: 5, prototyped: true, convention: 2 }),
    ),
  );
  assert.equal(alternative.functions[0]?.signature, null);
  assert.ok(
    alternative.diagnostics.some((diagnostic) => diagnostic.code === 'unavailable_semantics'),
  );
});

test('conflicting concrete definitions retain both evidence claims rather than choosing a name', () => {
  const image = fixtureImage(),
    address = image.symbols.find((symbol) => symbol.original_name === '_debug_sum')!.address!.value;
  const first = signatureSections(address, { encoding: 5, prototyped: true, parameters: 1 });
  const second = signatureSections(address, { encoding: 5, prototyped: true, parameters: 0 });
  const result = recoverDebugInfo(
    image,
    createOperationContext(),
    externalSections(image, {
      ...first,
      __debug_info: concat(first.__debug_info!, second.__debug_info!),
    }),
  );
  assert.equal(result.functions.length, 2);
  assert.ok(result.functions.every((fn) => fn.conflicting));
  assert.ok(
    result.evidence.filter((evidence) => evidence.conflicts_with.length === 1).length === 2,
  );
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'conflicting_evidence'));
});

test('unmapped debug ranges never become applicable native signatures', () => {
  const image = fixtureImage();
  const result = recoverDebugInfo(
    image,
    createOperationContext(),
    externalSections(
      image,
      signatureSections(0xf000000000000000n, { encoding: 5, prototyped: true }),
    ),
  );
  assert.equal(result.functions[0]?.signature, null);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'invalid_address'));
});

test('work, output and cancellation budgets propagate without partial publication', () => {
  const image = fixtureImage(),
    debug = fixtureDebug();
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => recoverDebugInfo(image, createOperationContext({ signal: controller.signal }), debug),
    (error: unknown) => error instanceof OperationError && error.code === 'cancelled',
  );
  for (const budget of [{ work: 1 }, { output_bytes: 1024 }]) {
    assert.throws(
      () => recoverDebugInfo(image, createOperationContext({ budget }), debug),
      (error: unknown) => error instanceof OperationError && error.code === 'resource_limit',
    );
  }
});

test('malformed command counts, unit lengths and reference contributions are bounded', () => {
  const image = fixtureImage(),
    debug = fixtureDebug();
  const bytes = debug.bytes.slice();
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(16, 0xffffffff, true);
  assert.throws(
    () =>
      recoverDebugInfo(image, createOperationContext(), {
        ...debug,
        bytes,
        expectedSha256: contentHash(bytes),
      }),
    (error: unknown) => error instanceof OperationError && error.code === 'malformed_image',
  );
  assert.throws(
    () =>
      parseDwarfSections(
        new Map([
          ['__debug_info', new Bytes().uint(0xfffffff0).finish()],
          ['__debug_abbrev', new Uint8Array([0])],
        ]),
        createOperationContext(),
      ),
    (error: unknown) => error instanceof OperationError && error.code === 'malformed_image',
  );
});

test('anonymous functions and nested arrays use DIE structure, not generated display labels', () => {
  const image = fixtureImage(),
    address = image.symbols.find((symbol) => symbol.original_name === '_debug_sum')!.address!.value;
  const a = new Bytes();
  abbreviation(a, 1, 0x11, true, []);
  abbreviation(a, 2, 0x24, false, [
    [3, 8],
    [0xb, 0xb],
    [0x3e, 0xb],
  ]);
  abbreviation(a, 3, 1, true, [[0x49, 0x13]]);
  abbreviation(a, 4, 0x21, false, [[0x37, 0xf]]);
  abbreviation(a, 5, 0x13, true, [
    [3, 8],
    [0xb, 0xb],
    [0x88, 0xb],
  ]);
  abbreviation(a, 6, 0xd, false, [
    [3, 8],
    [0x49, 0x13],
    [0x38, 0xb],
  ]);
  abbreviation(a, 7, 0x2e, true, [
    [0x49, 0x13],
    [0x11, 1],
    [0x12, 6],
    [0x27, 0x19],
  ]);
  abbreviation(a, 8, 5, false, [[0x49, 0x13]]);
  a.byte(0);
  const b = new Bytes().uint(0).uint(4, 2).uint(0).byte(8, 1);
  b.label('scalar').byte(2).string('not_a_contract').byte(4, 5);
  b.label('array').byte(3).ref('scalar').byte(4).uleb(2).byte(4).uleb(3).byte(0);
  b.label('structure')
    .byte(5)
    .string('int')
    .byte(24, 4)
    .byte(6)
    .string('matrix')
    .ref('array')
    .byte(0, 0);
  b.byte(7).ref('scalar').uint(address, 8).uint(4).byte(8).ref('structure').byte(0, 0);
  const info = b.finish();
  new DataView(info.buffer).setUint32(0, info.length - 4, true);
  const result = recoverDebugInfo(
    image,
    createOperationContext(),
    externalSections(image, { __debug_info: info, __debug_abbrev: a.finish() }),
  );
  assert.equal(result.functions.length, 1);
  const signature = result.functions[0]!.signature;
  assert.ok(signature);
  assert.equal(signature.parameters[0]?.name, null);
  const structure = result.types.find(
    (type) => type.id === signature.parameters[0]?.type_id,
  )?.definition;
  assert.ok(structure?.kind === 'structure');
  assert.equal(structure.size, 24n);
  assert.equal(structure.alignment, 4);
  const array = result.types.find((type) => type.id === structure.fields[0]?.type_id)?.definition;
  assert.ok(array?.kind === 'array');
  assert.equal(array.count, 2n);
  const nested = result.types.find((type) => type.id === array.element)?.definition;
  assert.ok(nested?.kind === 'array');
  assert.equal(nested.count, 3n);
  assert.deepEqual(result.types.find((type) => type.id === nested.element)?.definition, {
    kind: 'integer',
    bits: 32,
    signed: true,
  });
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import {
  contentHash,
  createOperationContext,
  imageIdentity,
  ImmutableBytes,
  OperationError,
  type LoadedImage,
} from '../../../src/core/index.js';
import { elfLoader } from '../../../src/loaders/elf/index.js';
import {
  companionSymbols,
  debuglinkCrc,
  frameVariableNames,
  recoverDebugInfo,
  type ExternalDebugInput,
} from '../../../src/metadata/debug/index.js';
import { inflateZlib } from '../../../src/metadata/debug/inflate.js';

// Built by fixtures/elf/build.sh from fixtures/elf/shapes.c (provenance.json).
const fixture = (name: string): Buffer =>
  readFileSync(new URL(`./fixtures/elf/${name}`, import.meta.url));
function image(name: string): LoadedImage {
  const input = fixture(name);
  const sha256 = contentHash(input),
    image_id = imageIdentity(sha256),
    bytes = new ImmutableBytes(input);
  const slice = elfLoader.inspect(bytes, image_id, createOperationContext()).slices[0]!;
  return elfLoader.load({ bytes, sha256, image_id, slice_id: slice.id }, createOperationContext());
}
function companion(name: string): ExternalDebugInput {
  const bytes = fixture(name);
  return { bytes, artifact_id: `artifact_${contentHash(bytes)}` };
}
const prototypes = (recovery: ReturnType<typeof recoverDebugInfo>) =>
  recovery.functions.map((fn) => `${fn.dwarf.prototype} ${fn.signature ? 'sig' : '-'}`).sort();

test('embedded GCC DWARF 5 recovers prototypes, named structures, globals and lines', () => {
  const recovery = recoverDebugInfo(image('shapes-g'), createOperationContext());
  assert.equal(recovery.status, 'partial'); // the union and the callback type are unrepresentable
  assert.equal(recovery.undecoded, false);
  assert.equal(recovery.matched_by, null);
  assert.match(recovery.build_id!, /^[0-9a-f]{40}$/);
  assert.deepEqual(prototypes(recovery), [
    'double number_sum(const number *values, int count, int as_real) sig',
    'int main(int argc, char **argv) sig',
    'int point_distance2(point a, point b) sig',
    'int print_shape(const shape *s, void *cookie) sig',
    'int registry_visit(registry_t *reg, void *cookie) sig',
    'long int shape_area(const shape *s) sig',
    'shape *shape_new(shape_kind kind, const char *name, int x, int y, unsigned int w, unsigned int h) sig',
    'void registry_add(registry_t *reg, shape *s) sig',
  ]);
  const visit = recovery.functions.find((fn) => fn.dwarf.name === 'registry_visit')!;
  assert.deepEqual(
    visit.signature!.parameters.map((parameter) => parameter.name),
    ['reg', 'cookie'],
  );
  const registry = recovery.types.find((type) => type.display_name === 'registry_t')!;
  assert.equal(registry.spelling, 'registry_t');
  assert.equal(registry.member_names, true);
  assert.equal(registry.definition.kind, 'structure');
  assert.deepEqual(
    registry.definition.kind === 'structure'
      ? registry.definition.fields.map((field) => [field.name, field.offset])
      : [],
    [
      ['head', 0n],
      ['count', 8n],
      ['total_area', 16n],
      ['visit', 24n],
    ],
  );
  // An enumeration is stored as its underlying integer; a union keeps its tag only.
  const kind = recovery.types.find((type) => type.display_name === 'shape_kind')!;
  assert.deepEqual(kind.definition, { kind: 'integer', bits: 32, signed: false });
  const number = recovery.types.find((type) => type.spelling === 'union number')!;
  assert.equal(number.definition.kind, 'unknown');
  const globals = (recovery.data?.variables ?? []).filter(
    (variable) => variable.functionAddress === undefined,
  );
  assert.deepEqual(globals.map((variable) => variable.name).sort(), [
    'global_registry',
    'kind_names',
    'verbose_level',
  ]);
  assert.ok(recovery.data!.lines.some((line) => line.file.endsWith('shapes.c')));
  // -O0 locals live at fixed CFA-relative homes; x86-64's CFA is the entry SP + 8.
  const names = frameVariableNames(
    recovery.data,
    visit.dwarf.address,
    8n,
    createOperationContext(),
  );
  assert.deepEqual([...names.values()].sort(), ['s', 'visited']);
  assert.ok([...names.keys()].every((offset) => offset < 0n));
});

test('DWARF 4, zlib-compressed sections and -O2 code decode the same declarations', () => {
  const plain = prototypes(recoverDebugInfo(image('shapes-g'), createOperationContext()));
  assert.deepEqual(
    prototypes(recoverDebugInfo(image('shapes-dwarf4'), createOperationContext())),
    plain,
  );
  const compressed = image('shapes-gz');
  assert.ok(compressed.sections.some((section) => section.flags & 0x800n));
  assert.deepEqual(prototypes(recoverDebugInfo(compressed, createOperationContext())), plain);
  const optimized = recoverDebugInfo(image('shapes-O2'), createOperationContext());
  assert.deepEqual(prototypes(optimized), plain);
  assert.equal(optimized.undecoded, false);
  // Value expressions (entry values, implicit values) stay symbolic and are reported once each.
  assert.ok(
    optimized.diagnostics.some((item) => /^DWARF location left symbolic/.test(item.message)),
  );
});

test('a separate debug file matches by GNU build ID, else by .gnu_debuglink CRC-32', () => {
  const stripped = image('shapes-stripped');
  assert.equal(recoverDebugInfo(stripped, createOperationContext()).status, 'absent');
  const matched = recoverDebugInfo(stripped, createOperationContext(), companion('shapes.debug'));
  assert.equal(matched.matched_by, 'build-id');
  assert.equal(matched.undecoded, false);
  assert.equal(matched.functions.length, 8);
  assert.ok(matched.evidence.every((item) => item.origin.kind === 'debug'));
  const crc = recoverDebugInfo(
    image('shapes-nobuildid'),
    createOperationContext(),
    companion('shapes-nobuildid.debug'),
  );
  assert.equal(crc.matched_by, 'debuglink');
  assert.equal(crc.build_id, null);
  assert.equal(crc.functions.length, 8);
  const mismatch = (target: string, debug: ExternalDebugInput, pattern: RegExp) =>
    assert.throws(
      () => recoverDebugInfo(image(target), createOperationContext(), debug),
      (error: unknown) =>
        error instanceof OperationError &&
        error.code === 'conflicting_evidence' &&
        pattern.test(error.message),
    );
  mismatch('shapes-stripped', companion('shapes-gz'), /build ID .* does not match/);
  mismatch('shapes-stripped', companion('shapes-nobuildid.debug'), /has no GNU build ID/);
  const corrupt = Buffer.from(fixture('shapes-nobuildid.debug'));
  corrupt[corrupt.length - 1]! ^= 1;
  mismatch(
    'shapes-nobuildid',
    { bytes: corrupt, artifact_id: `artifact_${contentHash(corrupt)}` },
    /CRC-32 .* does not match/,
  );
  assert.throws(
    () =>
      recoverDebugInfo(stripped, createOperationContext(), {
        bytes: new Uint8Array(64),
        artifact_id: `artifact_${'0'.repeat(64)}`,
      }),
    (error: unknown) => error instanceof OperationError && /not an ELF file/.test(error.message),
  );
});

test('companion symbols name a stripped image without replacing image symbols', () => {
  const stripped = image('shapes-stripped');
  const recovery = recoverDebugInfo(stripped, createOperationContext(), companion('shapes.debug'));
  const { symbols, evidence } = companionSymbols(stripped, recovery, createOperationContext());
  const named = new Map(symbols.map((symbol) => [symbol.original_name, symbol]));
  assert.equal(named.get('registry_add')?.kind, 'function');
  assert.equal(named.get('registry_add')?.size, 0x60n);
  assert.equal(named.get('global_registry')?.kind, 'object');
  assert.equal(named.get('global_registry')?.size, 32n);
  assert.ok(symbols.every((symbol) => symbol.evidence_ids.length === 1));
  assert.ok(evidence.length > 0);
  // The symbol-bearing image already names every function: nothing is added for those.
  const own = image('shapes-g');
  const embedded = recoverDebugInfo(own, createOperationContext());
  const added = companionSymbols(own, embedded, createOperationContext()).symbols;
  assert.ok(
    added.every(
      (symbol) => !own.symbols.some((item) => item.original_name === symbol.original_name),
    ),
  );
});

test('the debug CRC is zlib crc32 and the inflater is exact and bounded', () => {
  const bytes = fixture('shapes-nobuildid.debug');
  assert.equal(
    debuglinkCrc(new TextEncoder().encode('123456789'), createOperationContext()),
    0xcbf43926,
  );
  assert.ok(debuglinkCrc(bytes, createOperationContext()) > 0);
  const text = fixture('shapes.c');
  const random = Uint8Array.from({ length: 70000 }, (_, index) => (index * 2654435761) >>> 24);
  for (const input of [text, random, new Uint8Array(0), new Uint8Array(100000)])
    for (const level of [0, 1, 9]) {
      const compressed = deflateSync(input, { level });
      assert.deepEqual(
        inflateZlib(compressed, input.length, () => {}),
        new Uint8Array(input),
      );
    }
  const compressed = deflateSync(text);
  assert.throws(
    () => inflateZlib(compressed, text.length - 1, () => {}),
    /exceeds its declared size/,
  );
  assert.throws(() => inflateZlib(compressed, text.length + 1, () => {}), /shorter than/);
  const damaged = Buffer.from(compressed);
  damaged[damaged.length - 1]! ^= 0xff;
  assert.throws(() => inflateZlib(damaged, text.length, () => {}), /Adler-32/);
  assert.throws(() => inflateZlib(Buffer.from([0x78, 0x9c, 0xff]), 1, () => {}), /Truncated/);
});

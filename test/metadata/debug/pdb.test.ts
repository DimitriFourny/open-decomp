import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  contentHash,
  createOperationContext,
  imageIdentity,
  ImmutableBytes,
  OperationError,
  type LoadedImage,
} from '../../../src/core/index.js';
import { peLoader } from '../../../src/loaders/pe/index.js';
import {
  companionSymbols,
  debugContextAt,
  frameVariableNames,
  recoverDebugInfo,
  type ExternalDebugInput,
} from '../../../src/metadata/debug/index.js';
import { isPdb, parsePdb } from '../../../src/metadata/pdb/index.js';

// Built by fixtures/pe/build.sh from fixtures/pe/shapes.c (provenance.json): Zig 0.17.1's
// clang and lld-link, freestanding Windows x64 with CodeView and a PDB.
const fixture = (name: string): Buffer =>
  readFileSync(new URL(`./fixtures/pe/${name}`, import.meta.url));
function image(name: string): LoadedImage {
  const input = fixture(name);
  const sha256 = contentHash(input),
    image_id = imageIdentity(sha256),
    bytes = new ImmutableBytes(input);
  const slice = peLoader.inspect(bytes, image_id, createOperationContext()).slices[0]!;
  return peLoader.load({ bytes, sha256, image_id, slice_id: slice.id }, createOperationContext());
}
function pdb(name: string): ExternalDebugInput {
  const bytes = fixture(name);
  return { bytes, artifact_id: `artifact_${contentHash(bytes)}` };
}
const prototypes = (recovery: ReturnType<typeof recoverDebugInfo>) =>
  recovery.functions.map((fn) => `${fn.dwarf.prototype} ${fn.signature ? 'sig' : '-'}`).sort();

test('a PDB matched by GUID and age recovers prototypes, structures, globals and lines', () => {
  const pe = image('shapes-O0.exe');
  assert.equal(recoverDebugInfo(pe, createOperationContext()).status, 'absent');
  const recovery = recoverDebugInfo(pe, createOperationContext(), pdb('shapes-O0.pdb'));
  assert.equal(recovery.matched_by, 'guid-age');
  assert.match(
    recovery.pdb!.guid,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  assert.equal(recovery.pdb!.age, 1);
  assert.equal(recovery.undecoded, false);
  // The union, the bitfield structure and the callback type are unrepresentable.
  assert.equal(recovery.status, 'partial');
  assert.ok(recovery.evidence.every((item) => item.origin.kind === 'debug'));
  assert.deepEqual(prototypes(recovery), [
    'double number_sum(const number *values, int count, int as_real) sig',
    'int point_distance2(point a, point b) sig',
    'int print_shape(const shape *s, void *cookie) sig',
    'int registry_visit(registry *reg, void *cookie) sig',
    'int shapes_main(void) sig',
    'long long shape_area(const shape *s) sig',
    'shape *shape_new(shape_kind kind, const char *name, int x, int y, unsigned int w, unsigned int h) sig',
    'unsigned int flags_pack(flags *f, unsigned int layer) sig',
    'void copy_name(char *dst, const char *src, unsigned long long n) sig',
    'void registry_add(registry *reg, shape *s) sig',
  ]);
  const visit = recovery.functions.find((fn) => fn.dwarf.name === 'registry_visit')!;
  assert.equal(visit.dwarf.address, 0x140001290n);
  assert.deepEqual(
    visit.signature!.parameters.map((parameter) => parameter.name),
    ['reg', 'cookie'],
  );
  assert.equal(visit.signature!.abi, pe.target.abi);
  // CodeView has no typedef records: a C struct is named by its tag, a typedef by S_UDT.
  const registry = recovery.types.find((type) => type.display_name === 'registry')!;
  assert.equal(registry.spelling, 'registry');
  assert.equal(registry.member_names, true);
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
  assert.equal(registry.definition.kind === 'structure' && registry.definition.size, 32n);
  const typedef = recovery.types.find((type) => type.display_name === 'registry_t')!;
  assert.equal(typedef.spelling, 'registry_t');
  assert.deepEqual(typedef.definition, registry.definition);
  const kind = recovery.types.find((type) => type.display_name === 'shape_kind')!;
  assert.deepEqual(kind.definition, { kind: 'integer', bits: 32, signed: true });
  assert.equal(
    recovery.types.find((type) => type.spelling === 'union number')!.definition.kind,
    'unknown',
  );
  // A bitfield structure keeps its declaration but no structural layout, as with DWARF.
  assert.equal(
    recovery.types.find((type) => type.display_name === 'flags')!.definition.kind,
    'unknown',
  );
  const shape = recovery.types.find((type) => type.display_name === 'shape')!;
  assert.deepEqual(
    shape.definition.kind === 'structure'
      ? shape.definition.fields.map((field) => [field.name, field.offset])
      : [],
    [
      ['kind', 0n],
      ['name', 4n],
      ['bounds', 20n],
      ['scale', 40n],
      ['next', 48n],
    ],
  );
  const globals = (recovery.data?.variables ?? []).filter(
    (variable) => variable.functionAddress === undefined,
  );
  assert.deepEqual(globals.map((variable) => variable.name).sort(), [
    '_fltused',
    'global_registry',
    'kind_names',
    'log_buffer',
    'pool',
    'pool_used',
    'trace_hits',
    'verbose_level',
  ]);
  // C13 line rows: half-open intervals within each procedure.
  const area = recovery.functions.find((fn) => fn.dwarf.name === 'shape_area')!;
  const at = debugContextAt(recovery.data, area.dwarf.address, createOperationContext());
  assert.equal(at.sources.length, 1);
  assert.match(at.sources[0]!.file, /shapes\.c$/);
  assert.ok(at.sources[0]!.line > 0);
});

test('PDB frame variables become CFA-relative through the image unwind data', () => {
  const frames = (variant: string, name: string) => {
    const recovery = recoverDebugInfo(
      image(`shapes-${variant}.exe`),
      createOperationContext(),
      pdb(`shapes-${variant}.pdb`),
    );
    const fn = recovery.functions.find((item) => item.dwarf.name === name)!;
    const names = frameVariableNames(recovery.data, fn.dwarf.address, 8n, createOperationContext());
    return [...names].sort((a, b) => Number(a[0] - b[0]));
  };
  // Stack-pointer frames (as MSVC builds them): registry_visit is `sub rsp, 0x48`, with
  // visited at [rsp+0x34] and s at [rsp+0x28].
  assert.deepEqual(frames('O0', 'registry_visit'), [
    [-0x20n, 's'],
    [-0x14n, 'visited'],
  ]);
  // Frame-pointer frames: `push rbp; sub rsp, 0x30; lea rbp, [rsp+0x30]` (UWOP_SET_FPREG with
  // offset 0x30: rbp = entry - 8), visited at [rbp-0x14] and s at [rbp-0x20].
  assert.deepEqual(frames('O0-fp', 'registry_visit'), [
    [-0x28n, 's'],
    [-0x1cn, 'visited'],
  ]);
  // shape_area's frame pointer is 0x20 above its stack pointer: rbp = entry - 0x10.
  assert.deepEqual(frames('O0-fp', 'shape_area'), [
    [-0x28n, 'h'],
    [-0x20n, 'w'],
  ]);
  // -O2: push rsi; push rdi; sub rsp, 0x38; counter at [rsp+0x34] for the whole body.
  assert.deepEqual(frames('O2', 'shapes_main'), [[-0x14n, 'counter']]);
});

test('a stripped PE takes its function and global names from the PDB', () => {
  const pe = image('shapes-O0.exe');
  assert.equal(pe.symbols.filter((symbol) => symbol.kind === 'function').length, 0);
  const recovery = recoverDebugInfo(pe, createOperationContext(), pdb('shapes-O0.pdb'));
  const { symbols, evidence } = companionSymbols(pe, recovery, createOperationContext());
  const named = new Map(symbols.map((symbol) => [symbol.original_name, symbol]));
  assert.equal(named.get('shape_area')?.address?.value, 0x140001000n);
  assert.equal(named.get('shape_area')?.size, 0x9fn);
  assert.equal(named.get('global_registry')?.kind, 'object');
  assert.equal(named.get('global_registry')?.size, 32n);
  assert.equal(named.get('log_buffer')?.size, 128n);
  // Compiler-generated constant pools are not named after their mangled public symbols.
  assert.ok(![...named.keys()].some((name) => name?.startsWith('??_C@')));
  assert.ok(evidence.every((item) => item.origin.kind === 'debug'));
});

test('a PDB of another build is rejected; a PE has no embedded debug data', () => {
  const mismatch = (target: string, debug: ExternalDebugInput, pattern: RegExp) =>
    assert.throws(
      () => recoverDebugInfo(image(target), createOperationContext(), debug),
      (error: unknown) =>
        error instanceof OperationError &&
        error.code === 'conflicting_evidence' &&
        pattern.test(error.message),
    );
  mismatch('shapes-O0.exe', pdb('shapes-O2.pdb'), /does not match the image's PDB reference/);
  mismatch('shapes-O2.exe', pdb('shapes-O0.pdb'), /does not match the image's PDB reference/);
  assert.throws(
    () => recoverDebugInfo(image('shapes-O0.exe'), createOperationContext(), pdb('shapes.c')),
    (error: unknown) => error instanceof OperationError && /not a readable PDB/.test(error.message),
  );
});

test('-O2 code: register and ranged frame locations, the same prototypes', () => {
  const plain = recoverDebugInfo(
    image('shapes-O0.exe'),
    createOperationContext(),
    pdb('shapes-O0.pdb'),
  );
  const optimized = recoverDebugInfo(
    image('shapes-O2.exe'),
    createOperationContext(),
    pdb('shapes-O2.pdb'),
  );
  assert.equal(optimized.undecoded, false);
  assert.ok(prototypes(optimized).length > 0);
  for (const prototype of prototypes(optimized)) assert.ok(prototypes(plain).includes(prototype));
  assert.ok(
    (optimized.data?.variables ?? []).some((variable) =>
      variable.locations.some((entry) => entry.location.kind === 'register'),
    ),
  );
});

test('the PDB reader is bounded and refuses malformed containers', () => {
  const bytes = new Uint8Array(fixture('shapes-O0.pdb'));
  assert.ok(isPdb(bytes));
  const options = { sections: [], frame: () => null };
  // Truncated: the stream directory lies past the end.
  assert.throws(() => parsePdb(bytes.subarray(0, 4096), createOperationContext(), options));
  // A block size that is not a power of two between 512 and 32768.
  const odd = bytes.slice();
  new DataView(odd.buffer).setUint32(32, 1000, true);
  assert.throws(() => parsePdb(odd, createOperationContext(), options), /block size/);
  assert.throws(() => parsePdb(new Uint8Array(64), createOperationContext(), options), /MSF 7\.0/);
});

test('the PE/PDB fixtures are the ones provenance.json records', () => {
  const provenance = JSON.parse(fixture('provenance.json').toString('utf8')) as {
    sha256: Record<string, string>;
  };
  for (const [name, digest] of Object.entries(provenance.sha256))
    assert.equal(contentHash(fixture(name)), digest, name);
});

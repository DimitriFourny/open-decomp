import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contentHash,
  createOperationContext,
  imageIdentity,
  ImmutableBytes,
  type LoadedImage,
} from '../../src/core/index.js';
import { ELFLoader } from '../../src/loaders/elf/index.js';
import {
  archiveMembers,
  buildSignatureLibrary,
  decodeSignatureLibrary,
  encodeSignatureLibrary,
  matchSignatures,
  objectFunctions,
  SignatureFormatError,
  signatureHash,
  type MatchTarget,
} from '../../src/metadata/library-signatures/index.js';
import { fixtureBytes } from './fixture.js';

// libsigfix.a: sigfix1.o (sig_count, sig_twice, sig_dup, sig_mix) and sigfix2.o (sig_mix_copy,
// the body of sig_mix); sigfix-symbols links it into a program, sigfix-stripped is that program
// without symbols (fixtures/signatures: build.sh, provenance.json).
const archive = new Uint8Array(fixtureBytes('signatures/libsigfix.a'));
const functions = archiveMembers(archive).flatMap(objectFunctions);
const { library, stats } = buildSignatureLibrary(functions, {
  id: 'sigfix-test',
  title: 'sigfix',
  architecture: 'x86_64',
  contracts: 'libc.so.6',
  source: 'libsigfix.a',
});

function loadElf(name: string): LoadedImage {
  const data = new Uint8Array(fixtureBytes(name)),
    sha256 = contentHash(data);
  return new ELFLoader().load(
    { image_id: imageIdentity(sha256), sha256, bytes: new ImmutableBytes(data), slice_id: null },
    createOperationContext(),
  );
}
/** The functions of the symbols build (their entries are the stripped build's too). */
const symbols = loadElf('signatures/sigfix-symbols').symbols.filter(
  (symbol) => symbol.kind === 'function' && symbol.address && symbol.original_name,
);
const entryOf = (name: string) =>
  symbols.find((symbol) => symbol.original_name === name)!.address!.value;
function target(image: LoadedImage, known: Record<string, string> = {}): MatchTarget {
  const data = new Uint8Array(fixtureBytes('signatures/sigfix-stripped'));
  return {
    architecture: 'x86_64',
    format: 'elf',
    read(address, length) {
      const file = image.address_map.translate(
        { image_id: image.id, space: 'va', value: address },
        'file',
      );
      if (file.kind !== 'mapped') return new Uint8Array(0);
      const at = Number(file.address.value);
      return data.subarray(at, Math.min(data.length, at + length));
    },
    functions: symbols.map((symbol) => ({
      id: symbol.original_name!,
      entry: symbol.address!.value,
      name: known[symbol.original_name!] ?? null,
    })),
  };
}

test('relocatable objects: function bodies, relocated bytes masked, named calls', () => {
  assert.deepEqual(functions.map((fn) => fn.names.map((name) => name.name).join('=')).sort(), [
    'sig_count',
    'sig_dup',
    'sig_mix',
    'sig_mix_copy',
    'sig_twice',
  ]);
  const count = functions.find((fn) => fn.names[0]!.name === 'sig_count')!;
  // `counter` (PC32) and `strlen` (PLT32) are masked; the call names its callee.
  assert.ok(count.masked.some((byte) => byte === 1));
  assert.deepEqual(
    count.calls.map(([, name]) => name),
    ['strlen'],
  );
  const [offset] = count.calls[0]!;
  assert.equal(count.bytes[offset - 1], 0xe8);
  assert.deepEqual([...count.masked.subarray(offset, offset + 4)], [1, 1, 1, 1]);
  assert.deepEqual(count.place.offset, 0x0);
});

test('equal bodies share one signature; the file round-trips', () => {
  assert.equal(stats.bodies, 5);
  const mix = library.functions.find((fn) =>
    fn.alternatives.some((alternative) => alternative.names[0] === 'sig_mix'),
  )!;
  assert.deepEqual(
    mix.alternatives.map((alternative) => alternative.names[0]),
    ['sig_mix', 'sig_mix_copy'],
  );
  assert.equal(
    library.functions.some((fn) =>
      fn.alternatives.some((alternative) => alternative.names[0]!.endsWith('.cold')),
    ),
    false,
  );
  const decoded = decodeSignatureLibrary(encodeSignatureLibrary(library));
  assert.deepEqual(decoded, library);
  assert.equal(
    signatureHash(Uint8Array.of(1, 2, 3), [[1, 1]]),
    signatureHash(Uint8Array.of(1, 9, 3), [[1, 1]]),
  );
  assert.notEqual(
    signatureHash(Uint8Array.of(1, 2, 3), []),
    signatureHash(Uint8Array.of(1, 9, 3), []),
  );
});

test('a signature file is validated', () => {
  assert.throws(() => decodeSignatureLibrary('{'), SignatureFormatError);
  assert.throws(() => decodeSignatureLibrary('{"format":"other"}'), SignatureFormatError);
  const text = encodeSignatureLibrary(library);
  assert.throws(
    () =>
      decodeSignatureLibrary(text.replace(/\[(\d+),"/, (_, n: string) => `[${Number(n) + 1},"`)),
    SignatureFormatError,
  );
});

test('matching names the library functions of a stripped program, and no other', () => {
  const image = loadElf('signatures/sigfix-stripped');
  const report = matchSignatures([library], target(image));
  const named = new Map(report.matches.map((match) => [match.entry, match]));
  for (const name of ['sig_count', 'sig_dup', 'sig_mix'])
    assert.equal(named.get(entryOf(name))?.name, name, name);
  // Too short to name alone: placed by its neighbours of the same object.
  assert.equal(named.get(entryOf('sig_twice'))?.name, 'sig_twice');
  // Its body is sig_mix's too, and nothing places it: "one of" two, left unnamed.
  assert.equal(named.has(entryOf('sig_mix_copy')), false);
  assert.deepEqual(
    report.ambiguous
      .find((item) => item.entry === entryOf('sig_mix_copy'))
      ?.candidates.map((candidate) => candidate.name),
    ['sig_mix', 'sig_mix_copy'],
  );
  // No program function is named, and every name is right.
  for (const match of report.matches)
    assert.equal(
      symbols.find((symbol) => symbol.address!.value === match.entry)?.original_name,
      match.name,
    );
  assert.equal(named.has(entryOf('main')), false);
  // Calls to strlen (a PLT entry here, unnamed in this target) neither confirm nor refute.
  assert.equal(named.get(entryOf('sig_count'))?.confirmed_calls, 0);
  assert.equal(report.libraries[0]!.matched, 4);
});

test('a callee known by another name rules an alternative out', () => {
  const image = loadElf('signatures/sigfix-stripped');
  const plt = symbols.find((symbol) => symbol.original_name === 'sig_count')!;
  const strlenAt = (() => {
    const t = target(image);
    const fn = functions.find((item) => item.names[0]!.name === 'sig_count')!;
    const [offset] = fn.calls[0]!;
    const bytes = t.read(plt.address!.value, fn.bytes.length);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return plt.address!.value + BigInt(offset + 4) + BigInt(view.getInt32(offset, true));
  })();
  const t = target(image);
  const report = matchSignatures([library], {
    ...t,
    functions: [...t.functions, { id: 'plt', entry: strlenAt, name: 'puts' }],
  });
  assert.equal(
    report.matches.some((match) => match.name === 'sig_count'),
    false,
  );
  const confirmed = matchSignatures([library], {
    ...t,
    functions: [...t.functions, { id: 'plt', entry: strlenAt, name: 'strlen' }],
  });
  assert.equal(confirmed.matches.find((match) => match.name === 'sig_count')?.confirmed_calls, 1);
});

test('functions already named are evidence, not candidates', () => {
  const image = loadElf('signatures/sigfix-stripped');
  const report = matchSignatures([library], target(image, { sig_dup: 'my_dup' }));
  assert.equal(
    report.matches.some((match) => match.entry === entryOf('sig_dup')),
    false,
  );
});

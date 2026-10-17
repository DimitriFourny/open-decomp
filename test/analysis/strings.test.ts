import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OperationError, createOperationContext } from '../../src/core/index.js';
import { MachOLoader } from '../../src/loaders/macho/index.js';
import { PELoader } from '../../src/loaders/pe/index.js';
import { buildStringIndex, searchStrings } from '../../src/analysis/strings/index.js';
import { loadNavigationFixture, navigationBytes } from './navigation-fixture.js';

for (const name of [
  'macho-arm64-symbols',
  'macho-universal',
  'corpus-symbols.dll',
  'corpus-stripped.dll',
]) {
  test(`real ${name}: string decoding uses mapped container offsets and stable IDs`, () => {
    const image = loadNavigationFixture(
      `fixtures/bin/${name}`,
      name.includes('macho') ? new MachOLoader() : new PELoader(),
    );
    const index = buildStringIndex({ image, revision: 0 }, createOperationContext());
    const found = searchStrings(
      index,
      { text: 'open-decomp trusted fixture v1' },
      createOperationContext(),
    );
    assert.equal(found.items.length, 1);
    const string = found.items[0]!;
    const file = image.address_map.translate(string.address, 'file');
    assert.equal(file.kind, 'mapped');
    assert.equal(
      new TextDecoder().decode(image.bytes.read(file.address.value, Number(string.byte_length))),
      string.text,
    );
    const repeat = buildStringIndex({ image, revision: 0 }, createOperationContext());
    assert.deepEqual(
      repeat.strings.map((item) => item.id),
      index.strings.map((item) => item.id),
    );
  });
}

test('UTF-8, ASCII and positively identified UTF-16 preserve encoding and reject malformed records', () => {
  const data = Buffer.concat([
    Buffer.from('alpha\0héllo\0'),
    Buffer.from([0xff, 0x61, 0x62, 0x63, 0x64, 0, 0]),
    Buffer.from('wide text\0', 'utf16le'),
  ]);
  const image = navigationBytes(Uint8Array.of(0xc3), data);
  const strings = buildStringIndex({ image, revision: 0 }, createOperationContext()).strings;
  assert.deepEqual(
    strings.map((item) => [item.text, item.encoding]),
    [
      ['alpha', 'ascii'],
      ['héllo', 'utf8'],
      ['wide text', 'utf16le'],
    ],
  );
  assert.ok(strings.every((item) => item.terminated && item.status === 'candidate'));
  const unicode = navigationBytes(
    Uint8Array.of(0xc3),
    Buffer.from('ĀāĂă\0', 'utf16le'),
    'arm64',
    '__ustring',
  );
  assert.equal(
    buildStringIndex({ image: unicode, revision: 0 }, createOperationContext()).strings[0]?.text,
    'ĀāĂă',
  );
});

test('byte, record and candidate-length budgets are explicit; truncated candidates are never strings', () => {
  const image = navigationBytes(Uint8Array.of(0xc3), Buffer.from('alpha\0beta\0'));
  const bytes = buildStringIndex({ image, revision: 0, max_bytes: 4 }, createOperationContext());
  assert.equal(bytes.state, 'partial');
  assert.equal(bytes.scanned_bytes, 4);
  assert.deepEqual(bytes.strings, []);
  const records = buildStringIndex(
    { image, revision: 0, max_strings: 1 },
    createOperationContext(),
  );
  assert.equal(records.state, 'partial');
  assert.deepEqual(
    records.strings.map((item) => item.text),
    ['alpha'],
  );
  const length = buildStringIndex(
    { image, revision: 0, max_string_bytes: 4 },
    createOperationContext(),
  );
  assert.equal(length.state, 'partial');
  assert.deepEqual(
    length.strings.map((item) => item.text),
    ['beta'],
  );
  const empty = searchStrings(bytes, { text: 'absent' }, createOperationContext());
  assert.equal(empty.index_state, 'partial');
  assert.equal(empty.items.length, 0);
});

test('bounded filtering pages through nonmatches and rejects stale string continuations', () => {
  const image = navigationBytes(Uint8Array.of(0xc3), Buffer.from('alpha\0beta\0gamma\0'));
  const index = buildStringIndex({ image, revision: 0 }, createOperationContext());
  const first = searchStrings(index, { text: 'gamma', max_examined: 1 }, createOperationContext());
  assert.equal(first.search_state, 'partial');
  assert.equal(first.items.length, 0);
  assert.ok(first.next_cursor);
  const rest = searchStrings(
    index,
    { text: 'gamma', cursor: first.next_cursor! },
    createOperationContext(),
  );
  assert.deepEqual(
    rest.items.map((item) => item.text),
    ['gamma'],
  );
  assert.equal(rest.next_cursor, null);
  assert.throws(
    () =>
      searchStrings(
        { ...index, revision: 1 },
        { text: 'gamma', cursor: first.next_cursor! },
        createOperationContext(),
      ),
    (error: unknown) => error instanceof OperationError && error.code === 'stale_cursor',
  );
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () =>
      buildStringIndex(
        { image, revision: 0 },
        createOperationContext({ signal: controller.signal }),
      ),
    (error: unknown) => error instanceof OperationError && error.code === 'cancelled',
  );
  assert.throws(
    () => buildStringIndex({ image, revision: 0 }, createOperationContext({ budget: { work: 1 } })),
    (error: unknown) => error instanceof OperationError && error.code === 'resource_limit',
  );
});

test('search output bytes are bounded without silently dropping or truncating records', () => {
  const image = navigationBytes(
    Uint8Array.of(0xc3),
    Buffer.from(`${'a'.repeat(700)}\0${'b'.repeat(700)}\0`),
  );
  const index = buildStringIndex({ image, revision: 0 }, createOperationContext());
  const page = searchStrings(index, {}, createOperationContext({ budget: { output_bytes: 2048 } }));
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.text.length, 700);
  assert.equal(page.search_state, 'partial');
  assert.ok(page.next_cursor);
  const next = searchStrings(
    index,
    { cursor: page.next_cursor! },
    createOperationContext({ budget: { output_bytes: 2048 } }),
  );
  assert.equal(next.items.length, 1);
  assert.notEqual(page.items[0]?.id, next.items[0]?.id);
  const large = navigationBytes(Uint8Array.of(0xc3), Buffer.from(`${'c'.repeat(3000)}\0`));
  const largeIndex = buildStringIndex({ image: large, revision: 0 }, createOperationContext());
  assert.throws(
    () => searchStrings(largeIndex, {}, createOperationContext({ budget: { output_bytes: 2048 } })),
    (error: unknown) => error instanceof OperationError && error.code === 'resource_limit',
  );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OperationError, createOperationContext } from '../../src/core/index.js';
import { MachOLoader } from '../../src/loaders/macho/index.js';
import { PELoader } from '../../src/loaders/pe/index.js';
import { buildStringIndex, searchStrings } from '../../src/analysis/strings/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { recoverDataAddress } from '../../src/analysis/strings/source-data.js';
import type { LoadedImage } from '../../src/core/index.js';
import { integer, type SSAForm } from '../../src/ir/index.js';
import { sourceConstantValues } from '../../src/reconstruction/source-data.js';
import { constantCandidates } from '../../src/service/analysis/source-variadic.js';
import { registerConstantCandidates } from '../../src/service/analysis/source-literal-candidates.js';
import { builder, register } from '../ir/support.js';
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

/** `x1` is two 32-bit cells. Arm A writes the constant `0x2010` to them, arm B a loaded value;
 * the join exits through an `indirect` terminator (a tail call), so the cells reach it as phis. */
function partlyConstantTail(armB: 'load' | 'constant', first = 0x2010n, second = 0x2020n) {
  const b = builder(`partly-constant-${armB}`);
  const low = register('x1lo', 32, 0, 'preserve_other_bits', 'test:x1'),
    high = register('x1hi', 32, 32, 'preserve_other_bits', 'test:x1'),
    rdi = register('rdi', 64, 0, 'replace_root', 'test:rdi');
  const entry = b.block('entry'),
    constant = b.block('constant'),
    other = b.block('other'),
    join = b.block('join');
  const pointer = entry.readRegister(rdi);
  entry.branch(
    entry.compare('eq', pointer, entry.constant(integer(64), 0n)),
    entry.edge(constant),
    entry.edge(other),
  );
  constant.writeRegister(low, constant.constant(integer(32), first));
  constant.writeRegister(high, constant.constant(integer(32), 0n));
  constant.jump(join);
  if (armB === 'load') {
    other.writeRegister(low, other.load(integer(32), other.readRegister(rdi)));
    other.writeRegister(high, other.constant(integer(32), 0n));
  } else {
    other.writeRegister(low, other.constant(integer(32), second));
    other.writeRegister(high, other.constant(integer(32), 0n));
  }
  other.jump(join);
  join.terminate({
    kind: 'indirect',
    target: join.readRegister(register('tail', 64, 0, 'replace_root', 'test:tail')),
    reason: 'tail call',
    tail_call: true,
  });
  return constructSSA(b.finish(entry, [integer(64)])).value as SSAForm;
}

function candidatesOf(ir: SSAForm, image: LoadedImage): bigint[] {
  const context = createOperationContext();
  const expressions = new Map(
    ir.blocks.flatMap((block) =>
      block.instructions.flatMap((node) =>
        node.kind === 'assign' ? [[node.result.id, node.expression] as const] : [],
      ),
    ),
  );
  return registerConstantCandidates({
    ir,
    image,
    expressions,
    constant: sourceConstantValues(expressions, context, image.id),
    candidates: constantCandidates(ir, null, context),
    context,
  })
    .map((address) => address.value)
    .sort((left, right) => (left < right ? -1 : 1));
}

test('a tail exit and a phi of register cells make each constant edge a string candidate', () => {
  const image = navigationBytes(Uint8Array.of(0xc3), Buffer.from('alpha\0beta\0'));
  // One constant edge among unknown ones still contributes its own whole value.
  assert.deepEqual(candidatesOf(partlyConstantTail('load'), image), [0x2010n]);
  // Every edge of the same join is its own candidate.
  assert.deepEqual(candidatesOf(partlyConstantTail('constant'), image), [0x2010n, 0x2020n]);
});

test('a candidate only allows a fact: the bytes must be an immutable terminated string', () => {
  const writable = navigationBytes(Uint8Array.of(0xc3), Buffer.from('alpha\0beta\0'));
  const readOnly = {
    ...writable,
    mappings: writable.mappings.map((mapping) => ({ ...mapping, permissions: ['read'] as const })),
    sections: writable.sections.map((section) => ({ ...section, permissions: ['read'] as const })),
  };
  const ir = partlyConstantTail('constant', 0x2000n, 0x2006n);
  const recovered = (image: LoadedImage) =>
    candidatesOf(ir, image).map((value) =>
      recoverDataAddress(
        image,
        { image_id: image.id, space: 'va', value },
        createOperationContext(),
      ),
    );
  assert.deepEqual(
    recovered(readOnly).map((item) => [item?.string, item?.object?.mutable]),
    [
      ['alpha', false],
      ['beta', false],
    ],
  );
  assert.ok(recovered(writable).every((item) => item?.object?.mutable !== false));
});

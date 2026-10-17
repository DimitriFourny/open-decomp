import assert from 'node:assert/strict';
import test from 'node:test';
import { emittedFormals, execute } from './support.js';

for (const python of [false, true])
  test(`${python ? 'Python' : 'C'} formal identities survive nested types, commas, aliases and misleading comments`, () => {
    const first = python ? 'address: pointer[array<uint32_t, ?>]' : 'array<uint32_t, ?>* address';
    const second = python ? 'count: uint64_t' : 'uint64_t count';
    const text = python
      ? `# A comment may contain { or ): without ending the header.\ndef sample(${first}, ${second}) -> uint64_t:\n  return uint64(address + count)\n`
      : `/* A comment may contain { without opening the body. */\nuint64_t sample(${first}, ${second}) {\n  return ((uint64_t)(address + count));\n}\n`;
    const ids: string[] = [];
    const ref = (id: string) => {
      if (!ids.includes(id)) ids.push(id);
      return ids.indexOf(id);
    };
    const span = (declaration: string, id: string, semantic: string) => ({
      start: text.indexOf(declaration),
      end: text.indexOf(declaration) + declaration.length,
      semantic_refs: [ref(id), ref(semantic)],
    });
    const emission = {
      text,
      ids,
      mappings: [
        span(second, 'count-value', 'original-count'),
        span(first, 'address-value', 'original-address'),
        span(first, 'address-alias', 'address-semantic-alias'),
      ],
    };
    const formals = emittedFormals(emission);
    assert.deepEqual(
      formals.map((formal) => formal.name),
      ['address', 'count'],
    );
    assert.equal(formals.length, 2, 'overlapping alias mappings are one actual formal');
    assert.ok(formals[0]!.semantic_ids.includes('address-semantic-alias'));
    const observation = execute(
      emission,
      new Map([
        ['address-semantic-alias', 10n],
        ['original-count', 4n],
      ]),
    );
    assert.deepEqual(observation.values, [14n]);
  });

test('a repeated name in distinct parameter declarations is rejected rather than silently merged', () => {
  const text = 'uint64_t sample(uint64_t duplicate, uint64_t duplicate) { return 0; }';
  const first = text.indexOf('uint64_t duplicate'),
    second = text.indexOf('uint64_t duplicate', first + 1);
  assert.throws(() =>
    emittedFormals({
      text,
      ids: ['input-0', 'input-1'],
      mappings: [first, second].map((start, index) => ({
        start,
        end: start + 'uint64_t duplicate'.length,
        semantic_refs: [index],
      })),
    }),
  );
});

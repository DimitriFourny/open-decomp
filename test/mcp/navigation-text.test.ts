import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  NAVIGATION_TEXT_FORMAT,
  decodeNavigationText,
  navigationText,
} from '../../src/mcp/navigation.js';
import { QueryService } from '../../src/service/queries/index.js';

const fixtures = resolve('fixtures/bin');

test(
  'navigation text is a lossless, smaller projection of real navigation results',
  { timeout: 60000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-nav-text-')));
    const service = await QueryService.create({
      authorized_roots: [root, fixtures],
      max_workers: 1,
    });
    t.after(async () => {
      await service.close('cancel');
      await rm(root, { recursive: true, force: true });
    });
    const opened = await service.execute('project_open', {
      wait: true,
      source: {
        kind: 'import',
        input_path: join(fixtures, 'macho-arm64-symbols'),
        project_path: join(root, 'project'),
      },
    });
    assert.ok(opened.state === 'complete' && opened.project_id !== null && opened.data.image);
    const base = { project_id: opened.project_id, revision: opened.revision! };
    const image_id = opened.data.image.id;
    const functions = await service.execute('functions_find', { ...base, image_id });
    assert.ok('data' in functions && functions.data.items.length > 1);
    const fn = functions.data.items[0]!;
    const symbols = await service.execute('symbols_find', { ...base, image_id });
    const xrefs = await service.execute('xrefs_get', {
      ...base,
      target: { kind: 'entity', id: fn.id },
    });
    const closure = await service.execute('evidence_get', {
      ...base,
      evidence_ids: fn.evidence_ids,
      derivation: 'closure',
    });
    const others = [
      await service.execute('strings_find', { ...base, image_id }),
      await service.execute('binary_info', { ...base, image_id, view: 'sections' }),
      await service.execute('function_get', { ...base, function_id: fn.id }),
      await service.execute('function_get', { ...base, function_id: fn.id, view: 'cfg' }),
    ];
    const repeated = new Set<unknown>([functions, symbols, xrefs, closure]);
    for (const result of [functions, symbols, xrefs, closure, ...others]) {
      const plain = JSON.stringify(result);
      const text = navigationText(result);
      if (repeated.has(result))
        assert.ok(text !== undefined, `${result.state} result with repeated IDs must compact`);
      // Results without enough repetition are delivered as plain JSON, never lossy.
      const delivered = text ?? plain;
      assert.ok(Buffer.byteLength(delivered) <= Buffer.byteLength(plain));
      assert.deepEqual(decodeNavigationText(delivered), JSON.parse(plain));
      if (text !== undefined) assert.equal(JSON.parse(text).format, NAVIGATION_TEXT_FORMAT);
    }
  },
);

test('navigation text declines results it cannot project reversibly or smaller, and plain JSON decodes to itself', () => {
  const unique = { items: [{ a: 'x', b: 1 }], page: null };
  assert.equal(navigationText(unique), undefined);
  const reserved = {
    rows: [
      { $ref: 1, other: 'z'.repeat(40) },
      { $ref: 2, other: 'z'.repeat(40) },
    ],
  };
  assert.equal(navigationText(reserved), undefined);
  const table = { items: Array.from({ length: 6 }, (_, n) => ({ k: 'a'.repeat(40), n })) };
  const text = navigationText(table);
  assert.ok(text);
  assert.deepEqual(decodeNavigationText(text), table);
  assert.deepEqual(decodeNavigationText(JSON.stringify(unique)), unique);
  assert.throws(() =>
    decodeNavigationText(
      JSON.stringify({ format: NAVIGATION_TEXT_FORMAT, refs: [], result: { $ref: 0 } }),
    ),
  );
});

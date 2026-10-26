import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  entityIdentity,
  expandEmission,
  newIdentity,
  type AnnotationEdit,
  type RecoveredType,
} from '../../../src/core/index.js';
import { loadImage, project } from './support.js';

/** `elf-x86_64-stripped` with four functions rewritten to reach writable data no symbol
 * names (`.got.plt` reserved words 0x403f98/0x403f9c) and the exported `fixture_callback`. */
function patchedFixture(): Uint8Array {
  const raw = readFileSync('fixtures/bin/elf-x86_64-stripped');
  const image = loadImage(raw);
  const rip = (at: bigint, length: number, target: bigint): number[] => {
    const bytes = Buffer.alloc(4);
    bytes.writeInt32LE(Number(BigInt.asIntN(32, target - (at + BigInt(length)))));
    return [...bytes];
  };
  const patch = (va: bigint, bytes: readonly number[]): void => {
    const file = image.address_map.translate({ image_id: image.id, space: 'va', value: va }, 'file');
    assert.equal(file.kind, 'mapped');
    raw.set(bytes, Number(file.address.value));
  };
  // fixture_arithmetic: return *(u32 *)0x403f98
  patch(0x401870n, [0x8b, 0x05, ...rip(0x401870n, 6, 0x403f98n), 0xc3]);
  // fixture_maximum: *(u32 *)0x403f98 = edi
  patch(0x401880n, [0x89, 0x3d, ...rip(0x401880n, 6, 0x403f98n), 0xc3]);
  // fixture_width: return *(u32 *)0x403f9c + edi
  patch(0x401910n, [0x8b, 0x05, ...rip(0x401910n, 6, 0x403f9cn), 0x01, 0xf8, 0xc3]);
  // fixture_divide: return *(u64 *)fixture_callback
  patch(0x401900n, [0x48, 0x8b, 0x05, ...rip(0x401900n, 7, 0x403f80n), 0xc3]);
  return raw;
}

test('probe', { timeout: 120000 }, async (t) => {
  const p = await project(t, patchedFixture());
  const fn = (entry: bigint) => p.functions.find((row) => row.entry.value === entry)!;
  const text = async (entry: bigint) => {
    const r = await p.decompile(fn(entry).id);
    assert.ok('data' in r.result);
    const payload = p.payload(r.result);
    return { text: payload.result.data.emission.text, cache: r.result.data.cache, payload };
  };
  const a = await text(0x401870n);
  console.log(a.text);
  const data = a.payload.catalog.subjects.filter((s) => s.kind === 'data');
  console.log(JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString(16) : v)));
  const mappings = expandEmission(a.payload.result.data.emission).mappings;
  console.log(mappings.filter((m) => m.semantic_ids.some((id) => data.some((s) => s.id === id))).map((m) => [a.text.slice(m.start, m.end), m.semantic_ids]));
  const slice = p.image.selected_slice_id;
  const u32 = entityIdentity(slice, 'global-test-type', ['u32']),
    struct = entityIdentity(slice, 'global-test-type', ['config']);
  const definition: RecoveredType = {
    kind: 'structure',
    size: 8n,
    alignment: 4,
    fields: [
      { id: entityIdentity(slice, 'global-test-field', ['count']), name: 'count', offset: 0n, type_id: u32 },
      { id: entityIdentity(slice, 'global-test-field', ['limit']), name: 'limit', offset: 4n, type_id: u32 },
    ],
  };
  const edits: AnnotationEdit[] = [
    {
      operation: 'set',
      id: newIdentity('annotation'),
      address: { image_id: p.image.id, space: 'va', value: 0x403f98n },
      value: { kind: 'name', value: 'config' },
      status: 'asserted',
      evidence_ids: [],
    },
  ];
  const r1 = await p.annotate(edits);
  console.log(JSON.stringify(r1.result).slice(0, 600));
  for (const e of [0x401870n, 0x401880n, 0x401910n]) console.log((await text(e)).text);
  const r2 = await p.annotate([
    {
      operation: 'set',
      id: newIdentity('annotation'),
      entity_id: fn(0x401870n).id,
      value: { kind: 'type', type_id: u32, definition: { kind: 'integer', bits: 32, signed: false } },
      status: 'asserted',
      evidence_ids: [],
    },
    {
      operation: 'set',
      id: newIdentity('annotation'),
      address: { image_id: p.image.id, space: 'va', value: 0x403f98n },
      value: { kind: 'type', type_id: struct, definition },
      status: 'asserted',
      evidence_ids: [],
    },
  ]);
  console.log(JSON.stringify(r2.result).slice(0, 300));
  for (const e of [0x401870n, 0x401880n, 0x401910n]) console.log((await text(e)).text);
});

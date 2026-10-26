import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  expandEmission,
  globalDataIdentity,
  newIdentity,
  type AnnotationEdit,
} from '../../../src/core/index.js';
import { loadImage, project } from './support.js';

const ARITHMETIC = 0x401870n,
  MAXIMUM = 0x401880n,
  LOOP = 0x401890n,
  DIVIDE = 0x401900n,
  WIDTH = 0x401910n;
const CONFIG = 0x403f98n,
  LIMIT = 0x403f9cn,
  CALLBACK = 0x403f80n;

/** `elf-x86_64-stripped` with four functions rewritten to reach writable data no symbol
 * names (the reserved `.got.plt` words 0x403f98/0x403f9c) and the exported object
 * `fixture_callback`, so two functions share one unnamed global. */
function patchedFixture(): Uint8Array {
  const raw = readFileSync('fixtures/bin/elf-x86_64-stripped');
  const image = loadImage(raw);
  const rip = (at: bigint, length: number, target: bigint): number[] => {
    const bytes = Buffer.alloc(4);
    bytes.writeInt32LE(Number(BigInt.asIntN(32, target - (at + BigInt(length)))));
    return [...bytes];
  };
  const patch = (va: bigint, bytes: readonly number[]): void => {
    const file = image.address_map.translate(
      { image_id: image.id, space: 'va', value: va },
      'file',
    );
    assert.equal(file.kind, 'mapped');
    raw.set(bytes, Number(file.address.value));
  };
  // fixture_arithmetic: return *(u32 *)0x403f98
  patch(ARITHMETIC, [0x8b, 0x05, ...rip(ARITHMETIC, 6, CONFIG), 0xc3]);
  // fixture_maximum: *(u32 *)0x403f98 = edi
  patch(MAXIMUM, [0x89, 0x3d, ...rip(MAXIMUM, 6, CONFIG), 0xc3]);
  // fixture_width: return *(u32 *)0x403f9c + edi
  patch(WIDTH, [0x8b, 0x05, ...rip(WIDTH, 6, LIMIT), 0x01, 0xf8, 0xc3]);
  // fixture_divide: return *(u64 *)fixture_callback
  patch(DIVIDE, [0x48, 0x8b, 0x05, ...rip(DIVIDE, 7, CALLBACK), 0xc3]);
  return raw;
}

test(
  'global data entities name and type a global identically in every function that uses it',
  { timeout: 300_000 },
  async (t) => {
    const p = await project(t, patchedFixture());
    const slice = p.image.selected_slice_id;
    const va = (value: bigint) => ({ image_id: p.image.id, space: 'va' as const, value });
    const fn = (entry: bigint) => p.functions.find((row) => row.entry.value === entry)!;
    const decompile = async (entry: bigint) => {
      const { result } = await p.decompile(fn(entry).id);
      assert.ok('data' in result, JSON.stringify(result));
      const stored = p.payload(result);
      return { text: stored.result.data.emission.text, cache: result.data.cache, stored };
    };
    const text = async (entry: bigint) => (await decompile(entry)).text;
    const set = (
      subject: { readonly address: bigint } | { readonly entity_id: string },
      value: Extract<AnnotationEdit, { operation: 'set' }>['value'],
      id: string = newIdentity('annotation'),
    ): AnnotationEdit => ({
      operation: 'set',
      id,
      ...('address' in subject
        ? { address: va(subject.address) }
        : { entity_id: subject.entity_id }),
      value,
      status: 'asserted',
      evidence_ids: [],
    });
    const apply = async (edits: readonly AnnotationEdit[]) => {
      const { result } = await p.annotate(edits);
      assert.ok('data' in result, JSON.stringify(result));
      return result.data;
    };
    const rejected = async (edits: readonly AnnotationEdit[]) => {
      const revision = p.state.store.snapshot().revision;
      const { result } = await p.annotate(edits);
      assert.ok('error' in result, JSON.stringify(result));
      assert.equal(p.state.store.snapshot().revision, revision);
      return result.error.code;
    };

    // An unrelated function annotation keeps the decompiles of the globals' users.
    assert.equal((await decompile(MAXIMUM)).cache, 'computed');
    await apply([set({ entity_id: fn(LOOP).id }, { kind: 'name', value: 'loop_over' })]);
    const reused = await decompile(MAXIMUM);
    assert.equal(reused.cache, 'hit');

    const original = {
      arithmetic: await text(ARITHMETIC),
      maximum: reused.text,
      width: await decompile(WIDTH),
      divide: await text(DIVIDE),
    };
    assert.match(original.arithmetic, /^extern uint32_t data_403f98;$/m);
    assert.match(original.maximum, /data_403f98 = arg0;/);
    assert.match(original.divide, /^extern uint64_t fixture_callback;/m);

    // Code and unmapped addresses are not data storage.
    assert.equal(
      await rejected([set({ address: ARITHMETIC }, { kind: 'name', value: 'x' })]),
      'invalid_input',
    );
    assert.equal(
      await rejected([set({ address: 0x10n }, { kind: 'name', value: 'x' })]),
      'invalid_input',
    );

    // The data entity id is read from the global's declaration mapping and the catalog.
    const limitId = globalDataIdentity(slice, va(LIMIT));
    const declaration = expandEmission(original.width.stored.result.data.emission).mappings.find(
      (mapping) =>
        original.width.text.slice(mapping.start, mapping.end) === 'extern uint32_t data_403f9c;\n',
    );
    assert.ok(declaration?.semantic_ids.includes(limitId));
    assert.ok(
      original.width.stored.catalog.subjects.some(
        (subject) => subject.kind === 'data' && subject.id === limitId,
      ),
    );

    // A name given by address while reading one function reaches every other one.
    const named = set({ address: CONFIG }, { kind: 'name', value: 'config' });
    const applied = await apply([
      named,
      set({ entity_id: limitId }, { kind: 'name', value: 'limit' }),
    ]);
    assert.deepEqual(
      applied.applied.map((annotation) => annotation.entity_id),
      [globalDataIdentity(slice, va(CONFIG)), limitId],
    );
    const maximum = await decompile(MAXIMUM);
    assert.equal(maximum.cache, 'computed');
    assert.match(maximum.text, /^extern uint32_t config; \/\* VA 0x403f98 \*\/$/m);
    assert.match(maximum.text, /^ {2}config = arg0;$/m);
    assert.match(await text(ARITHMETIC), /return config;/);
    assert.match(await text(WIDTH), /return limit \+ arg0;/);
    // A global outside the named entity's reach keeps its decompile.
    assert.equal((await decompile(DIVIDE)).cache, 'hit');

    // A data-entity name overrides the symbol's; a type on the symbol declares the global.
    const declared = await p.declare(
      'struct Config { uint32_t count; uint32_t limit; }; struct Node { int32_t value; struct Node *next; };',
    );
    assert.ok('data' in declared, JSON.stringify(declared));
    const type = (name: string): string =>
      declared.data.types.find((item) => item.name === name || item.key === name)!.type_id;
    const symbol = p.image.symbols.find((item) => item.original_name === 'fixture_callback')!;
    await apply([set({ entity_id: symbol.id }, { kind: 'type', type_id: type('Node*') })]);
    assert.match(await text(DIVIDE), /^extern struct Node\* fixture_callback;/m);
    const head = set({ address: CALLBACK }, { kind: 'name', value: 'head' });
    await apply([head]);
    const divide = await text(DIVIDE);
    assert.match(divide, /^extern struct Node\* head; \/\* VA 0x403f80, 8 bytes \*\/$/m);
    assert.match(divide, /return \(uintptr_t\)head;/);
    assert.doesNotMatch(divide, /fixture_callback/);

    // A library structure bound to the global (no definition) is declared once, in full,
    // with its field names, and each function accesses its members.
    const typed = set({ address: CONFIG }, { kind: 'type', type_id: type('Config') });
    await apply([typed]);
    const config =
      'struct Config { uint32_t count; uint32_t limit; };\nextern struct Config config; /* VA 0x403f98, 8 bytes */\n';
    for (const [entry, access] of [
      [ARITHMETIC, /return config\.count;/],
      [MAXIMUM, /config\.count = arg0;/],
    ] as const) {
      const body = await text(entry);
      assert.ok(body.includes(config), body);
      assert.match(body, access);
    }
    // The typed global covers its second word: the entity at 0x403f9c no longer names it.
    const width = await text(WIDTH);
    assert.ok(width.includes(config), width);
    assert.match(width, /return config\.limit \+ arg0;/);

    // Retracting the annotations restores the original globals.
    await apply([
      { operation: 'retract', id: typed.id },
      { operation: 'retract', id: named.id },
      { operation: 'retract', id: head.id },
    ]);
    assert.equal(await text(ARITHMETIC), original.arithmetic);
    assert.equal(await text(MAXIMUM), original.maximum);
    assert.match(await text(WIDTH), /return limit \+ arg0;/);
    assert.match(await text(DIVIDE), /^extern struct Node\* fixture_callback;/m);
  },
);

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OperationError, createOperationContext } from '../../src/core/index.js';
import { MachOLoader } from '../../src/loaders/macho/index.js';
import { PELoader } from '../../src/loaders/pe/index.js';
import { buildStringIndex } from '../../src/analysis/strings/index.js';
import { buildReferenceIndex, searchReferences } from '../../src/analysis/references/index.js';
import { armWords, discoverNavigationFixture, loadNavigationFixture, navigationBytes } from './navigation-fixture.js';

for (const fixture of [
  { file: 'macho-arm64-symbols', loader: new MachOLoader(), function: 0x100000708n },
  { file: 'corpus-symbols.dll', loader: new PELoader(), function: 0x180001200n },
]) {
  test(`real ${fixture.file}: string bytes lead to the referencing function`, () => {
    const image = loadNavigationFixture(`fixtures/bin/${fixture.file}`, fixture.loader);
    const discovery = discoverNavigationFixture(image);
    const strings = buildStringIndex({ image, revision: 0 }, createOperationContext());
    const known = strings.strings.find(item => item.text === 'open-decomp trusted fixture v1');
    assert.ok(known);
    assert.equal(known.status, 'candidate');
    const index = buildReferenceIndex({ image, discovery, strings, revision: 0 }, createOperationContext());
    const functionId = discovery.graphs.find(graph => graph.function.entry.value === fixture.function)?.function.id;
    assert.ok(functionId);
    const incoming = searchReferences(index, { entity_id: known.id, statuses: ['established'] }, createOperationContext());
    assert.ok(incoming.items.some(item => item.from_function === functionId && item.kind === 'address'));
    assert.equal(index.strings?.strings.find(item => item.id === known.id)?.status, 'referenced');
    for (const reference of incoming.items) {
      assert.ok(reference.from_instruction);
      assert.ok(reference.evidence_ids.every(id => index.evidence.some(item => item.id === id)));
    }
  });
}
for (const fixture of [
  { file: 'macho-arm64-symbols', loader: new MachOLoader(), name: '_puts', instruction: 0x100000aa8n, role: 'callable_stub' },
  { file: 'pe-x86_64-symbols.exe', loader: new PELoader(), name: 'fixture_check', instruction: 0x140001004n, role: 'code' },
]) {
  test(`real ${fixture.file}: import follows executable stubs or IAT operands, not pointer storage as code`, () => {
    const image = loadNavigationFixture(`fixtures/bin/${fixture.file}`, fixture.loader);
    const discovery = discoverNavigationFixture(image);
    const imported = image.imports.find(item => item.original_name === fixture.name && (image.target.architecture === 'arm64' ? item.callable_entry !== null : item.slot !== null));
    assert.ok(imported);
    const slot = image.imports.find(item => item.original_name === fixture.name && item.slot !== null)?.slot;
    assert.ok(slot);
    const index = buildReferenceIndex({ image, discovery, revision: 0 }, createOperationContext());
    const incoming = searchReferences(index, { entity_id: imported.id, kinds: ['call'], statuses: ['established'] }, createOperationContext());
    const call = incoming.items.find(item => item.from.value === fixture.instruction);
    assert.ok(call);
    assert.ok(call.from_function && call.from_instruction);
    assert.equal(call.target_role, fixture.role);
    assert.notEqual(call.to?.value, slot.value);
    if (image.target.architecture === 'x86_64') {
      assert.equal(call.to, null);
      assert.ok(index.references.some(item => item.from.value === fixture.instruction && item.kind === 'read' && item.target_role === 'import_slot' && item.to?.value === slot.value));
      assert.ok(!index.references.some(item => item.from_instruction === call.from_instruction && item.kind === 'call' && item.status === 'unresolved'));
    }
  });
}

test('decoder operands distinguish reads, writes, candidate constants and unresolved runtime addresses', () => {
  // mov rax,0x2000; mov [rax],rcx; mov rdx,[rdi]; ret
  const image = navigationBytes(Uint8Array.from([0x48,0xb8,0,0x20,0,0,0,0,0,0, 0x48,0x89,0x08, 0x48,0x8b,0x17, 0xc3]), Buffer.from('message\0'));
  const index = buildReferenceIndex({ image, discovery: discoverNavigationFixture(image), revision: 0 }, createOperationContext());
  assert.ok(!index.references.some(item => item.from.value === 0x1000n));
  assert.ok(index.references.some(item => item.kind === 'write' && item.to?.value === 0x2000n && item.status === 'candidate'));
  assert.ok(index.references.some(item => item.kind === 'read' && item.to === null && item.status === 'unresolved'));
});

test('interior string addresses link the same string and unknown function ownership is not invented', () => {
  // lea rax,[rip+0xffc] -> 0x2003; ret
  const image = navigationBytes(Uint8Array.from([0x48,0x8d,0x05,0xfc,0x0f,0,0,0xc3]), Buffer.from('prefix-message\0'));
  const strings = buildStringIndex({ image, revision: 0 }, createOperationContext());
  const index = buildReferenceIndex({ image, discovery: discoverNavigationFixture(image), strings, revision: 0 }, createOperationContext());
  assert.equal(index.references.find(item => item.kind === 'address')?.to_entity, strings.strings[0]!.id);
  assert.equal(index.strings?.strings[0]?.status, 'referenced');
});

test('bounded reference search retains order, index incompleteness and revision/query-bound cursors', () => {
  const image = navigationBytes(armWords([0x90000000, 0x91400400, 0xf9400001, 0xf9000001, 0xd65f03c0]), Buffer.from('message\0'), 'arm64');
  const discovery = discoverNavigationFixture(image);
  const index = buildReferenceIndex({ image, discovery, revision: 0 }, createOperationContext());
  const all = searchReferences(index, { limit: 1000 }, createOperationContext());
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = searchReferences(index, { limit: 1, ...(cursor ? { cursor } : {}) }, createOperationContext());
    ids.push(...page.items.map(item => item.id));
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  assert.deepEqual(ids, all.items.map(item => item.id));
  assert.equal(new Set(ids).size, ids.length);
  const first = searchReferences(index, { limit: 1 }, createOperationContext());
  assert.ok(first.next_cursor);
  assert.throws(() => searchReferences({ ...index, revision: 1 }, { cursor: first.next_cursor! }, createOperationContext()), (error: unknown) => error instanceof OperationError && error.code === 'stale_cursor');
  assert.throws(() => searchReferences(index, { cursor: first.next_cursor!, kinds: ['write'] }, createOperationContext()), (error: unknown) => error instanceof OperationError && error.code === 'invalid_cursor');
  const bounded = searchReferences(index, { kinds: ['call'], max_examined: 1 }, createOperationContext());
  assert.equal(bounded.items.length, 0);
  assert.equal(bounded.search_state, 'partial');
  assert.ok(bounded.next_cursor);
  const partial = buildReferenceIndex({ image, discovery, revision: 0, max_references: 0 }, createOperationContext());
  assert.equal(searchReferences(partial, {}, createOperationContext()).index_state, 'partial');
});

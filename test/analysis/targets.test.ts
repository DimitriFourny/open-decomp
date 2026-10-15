import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOperationContext, entityIdentity, type LoadedImage } from '../../src/core/index.js';
import { recoverTargets } from '../../src/analysis/targets/index.js';
import { buildReferenceIndex } from '../../src/analysis/references/index.js';
import { armWords, discoverNavigationFixture, navigationBytes } from './navigation-fixture.js';

for (const architecture of ['x86_64', 'arm64'] as const) {
  test(`${architecture}: bounded absolute-u64 jump tables keep candidates and the unresolved runtime edge`, () => {
    const code = architecture === 'x86_64' ? Uint8Array.from([0xff,0x24,0xc5,0,0x20,0,0, 0xc3,0xc3])
      : armWords([0xb0000001, 0xf8607822, 0xd61f0040, 0xd65f03c0, 0xd65f03c0]); // adrp x1,0x2000; ldr x2,[x1,x0,lsl#3]; br x2; ret; ret
    const data = Buffer.alloc(16);
    const expected = architecture === 'x86_64' ? [0x1007n, 0x1008n] : [0x100cn, 0x1010n];
    expected.forEach((value, index) => data.writeBigUInt64LE(value, index * 8));
    const base = navigationBytes(code, data, architecture);
    const image: LoadedImage = { ...base, hints: [{ kind: 'data', encoding: 'jump_table', range: { start: { image_id: base.id, space: 'va', value: 0x2000n }, size: 16n }, evidence_ids: [] }] };
    const discovery = discoverNavigationFixture(image);
    const targets = recoverTargets({ image, discovery, revision: 0 }, createOperationContext());
    const candidates = targets.references.filter(item => item.kind === 'branch' && item.status === 'candidate');
    assert.deepEqual(candidates.map(item => item.to!.value).sort(), expected);
    assert.ok(candidates.every(item => item.from_instruction && item.from_function && item.evidence_ids.length));
    assert.ok(targets.references.some(item => item.kind === 'branch' && item.status === 'unresolved' && item.to === null));
    assert.equal(targets.state, 'partial');
    const limited = recoverTargets({ image, discovery, revision: 0, max_table_entries: 1 }, createOperationContext());
    assert.equal(limited.references.filter(item => item.kind === 'branch' && item.status === 'candidate').length, 1);
    assert.ok(limited.diagnostics.some(item => item.code === 'resource_limit'));
    const noExtent = recoverTargets({ image: base, discovery: discoverNavigationFixture(base), revision: 0 }, createOperationContext());
    assert.ok(!noExtent.references.some(item => item.kind === 'branch' && item.to !== null));
    assert.ok(noExtent.references.some(item => item.kind === 'branch' && item.status === 'unresolved'));
  });
}

test('immediate code-looking constants are values, and candidate indirect calls do not discharge unknown edges', () => {
  // mov rax,0x100c; call rax; ret
  const image = navigationBytes(Uint8Array.from([0x48,0xb8,0x0c,0x10,0,0,0,0,0,0,0xff,0xd0,0xc3]), Buffer.alloc(0));
  const discovery = discoverNavigationFixture(image);
  const index = buildReferenceIndex({ image, discovery, revision: 0 }, createOperationContext());
  assert.ok(!index.references.some(item => item.from.value === 0x1000n));
  assert.ok(index.references.some(item => item.from.value === 0x100an && item.kind === 'call' && item.status === 'candidate' && item.to?.value === 0x100cn));
  assert.ok(index.references.some(item => item.from.value === 0x100an && item.kind === 'call' && item.status === 'unresolved'));
});

test('RIP-relative writable pointer loads remain candidates and store/call boundaries kill prior state', () => {
  // mov rax,[rip+0xff9] -> [0x2000]; call rax; call rax; ret
  const data = Buffer.alloc(8); data.writeBigUInt64LE(0x100bn);
  const image = navigationBytes(Uint8Array.from([0x48,0x8b,0x05,0xf9,0x0f,0,0,0xff,0xd0,0xff,0xd0,0xc3]), data);
  const references = recoverTargets({ image, discovery: discoverNavigationFixture(image), revision: 0 }, createOperationContext()).references;
  assert.ok(references.some(item => item.from.value === 0x1007n && item.kind === 'call' && item.status === 'candidate' && item.to?.value === 0x100bn));
  assert.ok(!references.some(item => item.from.value === 0x1009n && item.to !== null));
  assert.ok(references.some(item => item.from.value === 0x1009n && item.status === 'unresolved'));
});

test('ARM64 ADRP is a page base, unsupported clobbers and authenticated slots do not invent targets', () => {
  const base = navigationBytes(armWords([0xb0000001, 0xd2800001, 0xf9400022, 0xd61f0040]), Buffer.alloc(8), 'arm64'); // adrp; mov x1,#0 (kills address); ldr; br
  const references = recoverTargets({ image: base, discovery: discoverNavigationFixture(base), revision: 0 }, createOperationContext()).references;
  assert.ok(!references.some(item => item.kind === 'address'));
  assert.ok(!references.some(item => item.kind === 'branch' && item.status === 'established'));
  const stub = navigationBytes(armWords([0xb0000010, 0xf9400210, 0xd61f0200]), Buffer.alloc(8), 'arm64');
  const slot = { image_id: stub.id, space: 'va' as const, value: 0x2000n };
  const imported = { id: entityIdentity(stub.selected_slice_id, 'import', 'test'), original_name: 'routine', display_name: 'routine', library: 'test', ordinal: null, slot, callable_entry: null, delayed: false, weak: false, evidence_ids: [] };
  const image: LoadedImage = { ...stub, imports: [imported], relocations: [{ id: entityIdentity(stub.selected_slice_id, 'relocation', 'auth'), address: slot, kind: 'chained_fixup', encoding: 'auth-bind', width_bits: 64, target: null, symbol_id: imported.id, addend: 0n, authenticated: true, evidence_ids: [] }] };
  const targets = recoverTargets({ image, discovery: discoverNavigationFixture(image), revision: 0 }, createOperationContext());
  assert.ok(targets.references.some(item => item.kind === 'branch' && item.status === 'unresolved'));
  assert.ok(!targets.references.some(item => item.kind === 'branch' && item.status === 'established'));
});

test('recovery instruction/record budgets and snapshot reuse are explicit', () => {
  const image = navigationBytes(Uint8Array.from([0x48,0x8d,0x05,0xf9,0x0f,0,0,0xc3]), Buffer.from('message\0'));
  const discovery = discoverNavigationFixture(image);
  const targets = recoverTargets({ image, discovery, revision: 0, max_instructions: 0 }, createOperationContext());
  assert.equal(targets.processed_instructions, 0);
  assert.equal(targets.state, 'partial');
  assert.deepEqual(targets.references, []);
  const capped = recoverTargets({ image, discovery, revision: 0, max_references: 0 }, createOperationContext());
  assert.equal(capped.state, 'partial');
  assert.throws(() => buildReferenceIndex({ image, discovery, revision: 1, targets }, createOperationContext()), /another snapshot/);
});

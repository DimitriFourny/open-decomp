import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationContext,
  entityIdentity,
  newIdentity,
  type AnnotationEdit,
} from '../../../src/core/index.js';
import { recoverDebugInfo, selectDebugSections } from '../../../src/metadata/debug/index.js';
import { fixtureImage, fixtureDebug } from '../../metadata/debug/fixture.js';
import { project } from './support.js';

/** Repackage genuine linked fixture code and its genuine linked DWARF into one
 * embedded-debug Mach-O. No synthetic declarations or external-debug artifact
 * handle enters the pipeline. Original code VAs and DWARF ranges are unchanged. */
function embeddedDebugImage(): Uint8Array {
  const image = fixtureImage(),
    external = fixtureDebug();
  const recovered = recoverDebugInfo(image, createOperationContext(), external);
  const fn = recovered.functions.find((fn) => fn.dwarf.name === 'debug_pair');
  assert.ok(fn?.signature);
  const text = image.sections.find((section) => section.name === '__text' && section.file_range);
  assert.ok(text?.file_range);
  const code = image.bytes.read(text.file_range.start.value, Number(text.file_range.size));
  const sections = [...selectDebugSections(external.bytes, createOperationContext()).sections];
  const dwarfCommandSize = 72 + sections.length * 80;
  const commandSize = 152 + dwarfCommandSize + 24;
  const codeOffset = (32 + commandSize + 15) & ~15;
  const dwarfOffset = codeOffset + code.length;
  const dwarfSize = sections.reduce((sum, [, bytes]) => sum + bytes.length, 0);
  const symbolOffset = dwarfOffset + dwarfSize,
    stringOffset = symbolOffset + 16;
  const strings = new TextEncoder().encode('\0_debug_pair\0');
  const bytes = new Uint8Array(stringOffset + strings.length),
    view = new DataView(bytes.buffer);
  const u32 = (offset: number, value: number): void => view.setUint32(offset, value, true);
  const u64 = (offset: number, value: bigint): void => view.setBigUint64(offset, value, true);
  const name = (offset: number, value: string): void =>
    bytes.set(new TextEncoder().encode(value), offset);
  u32(0, 0xfeedfacf);
  u32(4, 0x100000c);
  u32(8, 0);
  u32(12, 6);
  u32(16, 3);
  u32(20, commandSize);
  const textCommand = 32;
  u32(textCommand, 0x19);
  u32(textCommand + 4, 152);
  name(textCommand + 8, '__TEXT');
  assert.ok(text.virtual_range.start.value >= BigInt(codeOffset));
  u64(textCommand + 24, text.virtual_range.start.value - BigInt(codeOffset));
  u64(textCommand + 32, BigInt(dwarfOffset));
  u64(textCommand + 40, 0n);
  u64(textCommand + 48, BigInt(dwarfOffset));
  u32(textCommand + 56, 5);
  u32(textCommand + 60, 5);
  u32(textCommand + 64, 1);
  const textSection = textCommand + 72;
  name(textSection, '__text');
  name(textSection + 16, '__TEXT');
  u64(textSection + 32, text.virtual_range.start.value);
  u64(textSection + 40, BigInt(code.length));
  u32(textSection + 48, codeOffset);
  u32(textSection + 52, 2);
  u32(textSection + 64, 0x80000400);
  bytes.set(code, codeOffset);
  const dwarfCommand = textCommand + 152;
  u32(dwarfCommand, 0x19);
  u32(dwarfCommand + 4, dwarfCommandSize);
  name(dwarfCommand + 8, '__DWARF');
  const dwarfVA = text.virtual_range.start.value + BigInt(code.length) + 0x1000n;
  u64(dwarfCommand + 24, dwarfVA);
  u64(dwarfCommand + 32, BigInt(dwarfSize));
  u64(dwarfCommand + 40, BigInt(dwarfOffset));
  u64(dwarfCommand + 48, BigInt(dwarfSize));
  u32(dwarfCommand + 64, sections.length);
  let offset = dwarfOffset;
  for (let i = 0; i < sections.length; i++) {
    const [section, content] = sections[i]!,
      row = dwarfCommand + 72 + i * 80;
    name(row, section);
    name(row + 16, '__DWARF');
    u64(row + 40, BigInt(content.length));
    u32(row + 48, offset);
    u32(row + 64, 0x02000000);
    u64(row + 32, dwarfVA + BigInt(offset - dwarfOffset));
    bytes.set(content, offset);
    offset += content.length;
  }
  const symbols = dwarfCommand + dwarfCommandSize;
  u32(symbols, 2);
  u32(symbols + 4, 24);
  u32(symbols + 8, symbolOffset);
  u32(symbols + 12, 1);
  u32(symbols + 16, stringOffset);
  u32(symbols + 20, strings.length);
  u32(symbolOffset, 1);
  bytes[symbolOffset + 4] = 0x0f;
  bytes[symbolOffset + 5] = 1;
  u64(symbolOffset + 8, fn.dwarf.address);
  bytes.set(strings, stringOffset);
  return bytes;
}

test(
  'embedded real linked DWARF supplies a source signature through the complete Mach-O pipeline',
  { timeout: 60000 },
  async (t) => {
    const p = await project(t, embeddedDebugImage()),
      fn = p.functions.find((fn) => fn.original_name === '_debug_pair');
    assert.ok(fn);
    const result = p.payload((await p.decompile(fn.id)).result).result;
    assert.equal(result.data.signature?.parameters.length, 1);
    assert.equal(result.data.signature?.parameters[0]?.name, 'pair');
    assert.ok(
      result.evidence.some(
        (proof) =>
          proof.origin.kind === 'binary' && proof.origin.description.startsWith('Embedded DWARF'),
      ),
    );
    assert.equal(
      result.evidence.some((proof) => proof.origin.kind === 'debug'),
      false,
      'embedded bytes do not acquire a fabricated external artifact',
    );
    assert.ok(
      result.data.emission.mappings.some(
        (mapping) => mapping.semantic_ids.includes(fn.id) && mapping.evidence_ids.length,
      ),
    );
    assert.equal(
      p.state.store.readSignature(fn.id, 2),
      null,
      'recovered declarations remain derived, not immutable facts',
    );
  },
);

for (const fixture of [
  { file: 'macho-arm64-symbols', imported: '_puts', call: 0x100000aa8n, library: true },
  { file: 'pe-x86_64-symbols.exe', imported: 'fixture_check', call: 0x140001004n, library: false },
])
  test(
    `${fixture.file}: grounded imported and call-local signatures preserve source evidence without changing call semantics`,
    { timeout: 60000 },
    async (t) => {
      const p = await project(t, fixture.file);
      const imported = p.image.imports.find((item) => item.original_name === fixture.imported);
      assert.ok(imported);
      const reference = p.state.store
        .queryRecords({ kind: 'reference', revision: 2, image_id: p.image.id, limit: 1000 })
        .items.find(
          (reference) =>
            reference.from.value === fixture.call &&
            reference.kind === 'call' &&
            reference.to_entity === imported.id,
        );
      assert.ok(reference?.from_function && reference.from_instruction);
      const baseline = p.payload(
        (await p.decompile(reference.from_function, { budget: { work: 10000000 } })).result,
      );
      const call = baseline.catalog.subjects.find(
        (subject) =>
          subject.kind === 'call' &&
          baseline.result.data.emission.mappings.some(
            (mapping) =>
              mapping.statement_id === subject.id &&
              mapping.instruction_ids.includes(reference.from_instruction!),
          ),
      );
      assert.ok(call, 'call subjects must not be mislabeled as scalar values');
      if (fixture.library)
        assert.ok(baseline.result.evidence.some((proof) => proof.origin.kind === 'library'));
      const type = entityIdentity(p.image.selected_slice_id, 'import-source-type', imported.id),
        typeAnnotation = newIdentity('annotation'),
        declaration = newIdentity('annotation');
      const edits: AnnotationEdit[] = [
        {
          operation: 'set',
          id: typeAnnotation,
          entity_id: imported.id,
          value: {
            kind: 'type',
            type_id: type,
            definition: { kind: 'integer', bits: 32, signed: true },
          },
          status: 'asserted',
          evidence_ids: [],
        },
        {
          operation: 'set',
          id: declaration,
          entity_id: imported.id,
          value: {
            kind: 'signature',
            value: {
              abi: p.image.target.abi,
              return_type: type,
              parameters: [],
              variadic: false,
              noreturn: false,
              evidence_ids: [],
            },
          },
          status: 'asserted',
          evidence_ids: [],
        },
      ];
      assert.equal((await p.annotate(edits)).result.state, 'complete');
      const changed = p.payload(
        (await p.decompile(reference.from_function, { budget: { work: 10000000 } })).result,
      );
      const proof = changed.result.evidence.find(
        (proof) =>
          proof.origin.kind === 'analysis' && proof.origin.analyzer === 'pipeline-call-contracts',
      );
      assert.ok(proof);
      assert.ok(
        proof.derived_from.some((id) => reference.evidence_ids.includes(id)),
        'import use is grounded by target-resolution evidence',
      );
      assert.ok(
        proof.derived_from.some(
          (id) => p.state.store.readEvidence([id], 3)[0]?.origin.kind === 'assertion',
        ),
      );
      assert.ok(
        changed.result.data.emission.mappings.some(
          (mapping) =>
            mapping.semantic_ids.includes(call.id) && mapping.evidence_ids.includes(proof.id),
        ),
      );
      assert.equal(p.state.store.readSignature(imported.id, 3), null);
      assert.equal(p.state.store.readType(type, 3), null);
      if (fixture.library)
        assert.ok(
          changed.result.diagnostics.some(
            (diagnostic) => diagnostic.code === 'conflicting_evidence',
          ),
          'an incompatible assertion must not erase the grounded library prototype',
        );
      assert.equal(
        (
          await p.annotate([
            { operation: 'retract', id: declaration },
            { operation: 'remove', id: typeAnnotation },
          ])
        ).result.state,
        'complete',
      );
      const restored = p.payload(
        (await p.decompile(reference.from_function, { budget: { work: 10000000 } })).result,
      );
      assert.equal(
        restored.catalog.types.some((record) => record.id === type),
        false,
      );
      assert.equal(restored.result.data.emission.text, baseline.result.data.emission.text);
    },
  );

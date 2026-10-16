// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { z } from 'zod';
import { contentHash } from '../../src/core/index.js';
import { inspectELF } from '../../scripts/fixtures/inspect-elf.js';
import { evaluate, expectedSchema } from './oracle.js';
const artifact = z.object({ path: z.string(), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) });
const manifest = z.object({
  sourceFiles: z.array(artifact),
  images: z.array(artifact.extend({ facts: z.unknown(), symbolState: z.enum(['stripped', 'symbol-bearing']), metadataPath: z.string(), metadataSha256: z.string(), disassemblyPath: z.string(), disassemblySha256: z.string() })),
  codeRanges: z.array(artifact.extend({ format: z.literal('elf'), abi: z.literal('sysv-amd64'), image: z.string(), symbol: z.string(), address: z.string(), fileOffset: z.number().int().nonnegative() })),
  expected: z.string(),
}).parse(JSON.parse(readFileSync('fixtures/elf-manifest.json', 'utf8')));

test('ELF source, code, linked images and independent LLVM evidence remain hash-bound', () => {
  for (const record of [...manifest.sourceFiles, ...manifest.images, ...manifest.codeRanges]) {
    const bytes = readFileSync(record.path);
    assert.equal(bytes.length, record.size, record.path);
    assert.equal(contentHash(bytes), record.sha256, record.path);
  }
  for (const image of manifest.images) {
    assert.deepEqual(inspectELF(readFileSync(image.path)), image.facts);
    assert.equal(contentHash(readFileSync(image.metadataPath)), image.metadataSha256);
    assert.equal(contentHash(readFileSync(image.disassemblyPath)), image.disassemblySha256);
  }
});

test('real ELF executable/shared stripped variants preserve dynamic interfaces and backed function bytes', () => {
  for (const [symbolName, strippedName, type] of [['elf-x86_64-symbols', 'elf-x86_64-stripped', 2], ['libcorpus-elf-x86_64-symbols.so', 'libcorpus-elf-x86_64-stripped.so', 3]] as const) {
    const symbols = readFileSync(`fixtures/bin/${symbolName}`), stripped = readFileSync(`fixtures/bin/${strippedName}`);
    const before = inspectELF(symbols), after = inspectELF(stripped);
    assert.equal(symbols.readUInt16LE(16), type);
    assert.equal(stripped.readUInt16LE(16), type);
    assert.equal(before.entryAddress, after.entryAddress);
    assert.ok(before.symbols.includes('fixture_arithmetic'));
    assert.equal(after.symbols.includes('fixture_arithmetic'), false);
    assert.ok(after.exports.includes('fixture_arithmetic'));
    assert.ok(after.imports.includes('fixture_external'));
    assert.ok(after.needed.includes('libfixture-native.so'));
    assert.equal(after.needed.some(name => /libc|libgcc|libstdc/.test(name)), false);
    for (const name of ['fixture_arithmetic', 'fixture_float', 'fixture_vector', 'fixture_check']) {
      const original = before.functions.find(fn => fn.name === name), removed = after.functions.find(fn => fn.name === name);
      assert.ok(original && removed);
      assert.equal(original.address, removed.address);
      assert.deepEqual(symbols.subarray(original.fileOffset, original.fileOffset + original.size), stripped.subarray(removed.fileOffset, removed.fileOffset + removed.size));
    }
    assert.ok(before.sections.some(section => section.type === 8 && section.size >= 512), 'Real SHT_NOBITS zero-filled global');
  }
});

test('ELF raw ranges use symbol sizes, separate PE paths, and every existing independent source oracle', () => {
  const expected = expectedSchema.parse(JSON.parse(readFileSync(manifest.expected, 'utf8')));
  for (const fixture of expected.cases) {
    const range = manifest.codeRanges.find(range => range.symbol === fixture.function);
    assert.ok(range, fixture.function);
    assert.ok(range.path.startsWith('fixtures/code/elf-x86_64/'));
    const parent = readFileSync(range.image), facts = inspectELF(parent), fn = facts.functions.find(fn => fn.name === range.symbol);
    assert.ok(fn);
    assert.equal(range.address, fn.address);
    assert.equal(range.size, fn.size);
    assert.deepEqual(readFileSync(range.path), parent.subarray(fn.fileOffset, fn.fileOffset + fn.size));
    assert.deepEqual(evaluate(fixture), { result: fixture.result, ...(fixture.memoryAfter === undefined ? {} : { memoryAfter: fixture.memoryAfter }) });
  }
});

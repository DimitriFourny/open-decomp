import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Diagnostic, ResultEnvelope } from '../../src/core/index.js';
import { QueryService } from '../../src/service/queries/index.js';
import { objcBytes, swiftBytes } from '../metadata/fixture.js';

const fixtures = resolve('fixtures/bin');
const budget = { deadline_ms: 10000, work: 1_000_000 };
function data<T>(result: ResultEnvelope<T>): T {
  assert.ok('data' in result, JSON.stringify(result));
  return result.data;
}
async function setup(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-parser-')));
  const service = await QueryService.create({ authorized_roots: [root], max_workers: 1 });
  t.after(async () => { await service.close('cancel'); await rm(root, { recursive: true, force: true }); });
  return { root, service };
}
function machoCommand(bytes: Buffer, command: number): number {
  let offset = 32;
  for (let index = 0; index < bytes.readUInt32LE(16); index++) {
    if (bytes.readUInt32LE(offset) === command) return offset;
    offset += bytes.readUInt32LE(offset + 4);
  }
  assert.fail(`Fixture lacks Mach-O command ${command}`);
}
interface PEFields {
  readonly coff: number;
  readonly optional: number;
  directory(index: number): number;
  file(rva: number): number;
}
/** Resolve semantic fixture fields rather than depending on linker file offsets. */
function peFields(bytes: Buffer): PEFields {
  const coff = bytes.readUInt32LE(0x3c) + 4, optional = coff + 20;
  const section = optional + bytes.readUInt16LE(coff + 16);
  return { coff, optional, directory: index => optional + 112 + index * 8, file: rva => {
    for (let index = 0; index < bytes.readUInt16LE(coff + 2); index++) {
      const at = section + index * 40, start = bytes.readUInt32LE(at + 12), size = bytes.readUInt32LE(at + 16);
      if (rva >= start && rva < start + size) return bytes.readUInt32LE(at + 20) + rva - start;
    }
    assert.fail(`Fixture RVA ${rva.toString(16)} lacks backing`);
  } };
}
interface FailureCase {
  readonly name: string;
  readonly fixture: string;
  readonly code: Diagnostic['code'];
  mutate(bytes: Buffer): Buffer;
}
const failures: readonly FailureCase[] = [
  { name: 'Mach-O command count exceeds its table', fixture: 'macho-arm64-symbols', code: 'malformed_image', mutate: bytes => {
    bytes.writeUInt32LE(0xffffffff, 16); return bytes;
  } },
  { name: 'Mach-O virtual range overflows uint64', fixture: 'macho-arm64-symbols', code: 'malformed_image', mutate: bytes => {
    bytes.writeBigUInt64LE(0xfffffffffffffff0n, machoCommand(bytes, 25) + 24); return bytes;
  } },
  { name: 'Mach-O file offset exceeds safe integer arithmetic', fixture: 'macho-arm64-symbols', code: 'malformed_image', mutate: bytes => {
    bytes.writeBigUInt64LE(1n << 53n, machoCommand(bytes, 25) + 40); return bytes;
  } },
  { name: 'Mach-O backed nlist table exceeds 100000 records', fixture: 'macho-arm64-symbols', code: 'resource_limit', mutate: bytes => {
    const command = machoCommand(bytes, 2), offset = bytes.length;
    bytes = Buffer.concat([bytes, Buffer.alloc(100001 * 16)]);
    bytes.writeUInt32LE(offset, command + 8); bytes.writeUInt32LE(100001, command + 12); return bytes;
  } },
  { name: 'Mach-O backed load-command table exceeds 65536 records', fixture: 'macho-arm64-symbols', code: 'resource_limit', mutate: bytes => {
    const size = 65537 * 8;
    bytes = Buffer.concat([bytes, Buffer.alloc(Math.max(0, size + 32 - bytes.length))]);
    bytes.writeUInt32LE(65537, 16); bytes.writeUInt32LE(size, 20); return bytes;
  } },
  { name: 'PE preferred image range overflows uint64', fixture: 'corpus-symbols.dll', code: 'malformed_image', mutate: bytes => {
    const { optional } = peFields(bytes);
    bytes.writeBigUInt64LE(0xffffffffffff0000n, optional + 24); bytes.writeUInt32LE(0x20000, optional + 56); return bytes;
  } },
  { name: 'PE export table exceeds 100000 records', fixture: 'corpus-symbols.dll', code: 'resource_limit', mutate: bytes => {
    const fields = peFields(bytes), table = fields.file(bytes.readUInt32LE(fields.directory(0)));
    bytes.writeUInt32LE(100001, table + 20); return bytes;
  } },
  { name: 'PE unwind chain points back to itself', fixture: 'corpus-symbols.dll', code: 'malformed_image', mutate: bytes => {
    const fields = peFields(bytes), entry = fields.file(bytes.readUInt32LE(fields.directory(3)));
    const begin = bytes.readUInt32LE(entry), end = bytes.readUInt32LE(entry + 4), unwind = bytes.readUInt32LE(entry + 8), at = fields.file(unwind);
    bytes.set([0x21, 0, 0, 0], at); bytes.writeUInt32LE(begin, at + 4); bytes.writeUInt32LE(end, at + 8); bytes.writeUInt32LE(unwind, at + 12); return bytes;
  } },
  { name: 'PE debug directory ends inside a record', fixture: 'corpus-symbols.dll', code: 'malformed_image', mutate: bytes => {
    bytes.writeUInt32LE(27, peFields(bytes).directory(6) + 4); return bytes;
  } },
  { name: 'PE COFF name exceeds 4096 bytes', fixture: 'corpus-symbols.dll', code: 'resource_limit', mutate: bytes => {
    const { coff } = peFields(bytes), table = bytes.readUInt32LE(coff + 8), strings = table + 18 * bytes.readUInt32LE(coff + 12);
    bytes = Buffer.concat([bytes, Buffer.alloc(Math.max(0, strings + 4102 - bytes.length))]);
    bytes.writeUInt32LE(4102, strings); bytes.writeUInt32LE(0, table); bytes.writeUInt32LE(4, table + 4);
    bytes.fill(65, strings + 4, strings + 4101); bytes[strings + 4101] = 0; return bytes;
  } },
];
for (const scenario of failures) test(`actual child parser containment: ${scenario.name}`, { timeout: 60000 }, async t => {
  const { root, service } = await setup(t), project_path = join(root, 'project'), input_path = join(root, 'input');
  const original = await readFile(join(fixtures, scenario.fixture));
  await writeFile(input_path, scenario.mutate(Buffer.from(original)));
  const failed = await service.execute('project_open', { wait: true, source: { kind: 'import', input_path, project_path }, budget });
  assert.ok(failed.state === 'failed', JSON.stringify(failed));
  assert.equal(failed.error.code, scenario.code);
  assert.deepEqual(failed.artifacts, []);
  // Loader rejection must not publish even an immutable snapshot as loaded metadata.
  const resumed = await service.execute('project_open', { source: { kind: 'resume', project_path }, budget });
  assert.ok(resumed.state === 'partial'); assert.equal(resumed.reason, 'incomplete_index');
  assert.equal(resumed.revision, 0); assert.equal(resumed.data.image, null);
  const scope = { project_id: resumed.project_id!, revision: resumed.revision! };
  const absent = await service.execute('binary_info', scope);
  assert.ok(absent.state === 'failed'); assert.equal(absent.error.code, 'not_found');
  data(await service.execute('project_close', scope));
  assert.deepEqual(await readFile(join(fixtures, scenario.fixture)), original);
  // The same worker/service can still load the untouched compiler output.
  await writeFile(input_path, original);
  const legitimate = await service.execute('project_open', { wait: true, source: { kind: 'import', input_path, project_path: join(root, 'legitimate') }, budget });
  assert.equal(legitimate.state, 'complete'); assert.ok(data(legitimate).image); assert.equal(legitimate.revision, 2);
});

interface PartialCase {
  readonly name: string;
  readonly code: Diagnostic['code'];
  bytes(): Promise<Buffer> | Buffer;
}
const partials: readonly PartialCase[] = [
  { name: 'Mach-O nlist string index reaches the table end', code: 'malformed_image', bytes: async () => {
    const bytes = await readFile(join(fixtures, 'macho-arm64-symbols')), command = machoCommand(bytes, 2);
    const table = bytes.readUInt32LE(command + 8), count = bytes.readUInt32LE(command + 12);
    bytes.writeUInt32LE(bytes.readUInt32LE(command + 20), table + (count - 1) * 16); return bytes;
  } },
  { name: 'Mach-O export trie contains an ancestor cycle', code: 'malformed_image', bytes: async () => {
    const bytes = await readFile(join(fixtures, 'macho-arm64-symbols')), command = machoCommand(bytes, 0x80000033);
    const payload = bytes.readUInt32LE(command + 8); bytes.writeUInt32LE(5, command + 12); bytes.set([0, 1, 65, 0, 0], payload); return bytes;
  } },
  { name: 'Mach-O native symbol contains invalid UTF-8', code: 'malformed_image', bytes: async () => {
    const bytes = await readFile(join(fixtures, 'macho-arm64-symbols')), command = machoCommand(bytes, 2);
    const table = bytes.readUInt32LE(command + 8), strings = bytes.readUInt32LE(command + 16);
    bytes.writeUInt32LE(1, table); bytes.set([0xff, 0], strings + 1); return bytes;
  } },
  { name: 'Objective-C protocol recursively adopts itself', code: 'malformed_image', bytes: () => {
    const fixture = objcBytes(); fixture.pointer(0x2410, 0x2500); return fixture.bytes;
  } },
  { name: 'Swift field count exceeds the metadata entry limit', code: 'resource_limit', bytes: () => {
    const fixture = swiftBytes(); fixture.u32(0x110c, 0xffffffff); return fixture.bytes;
  } },
  { name: 'Swift field table crosses its declared section', code: 'malformed_image', bytes: () => {
    const fixture = swiftBytes(); fixture.u32(0x110c, 2); fixture.u32(0x111c, 2);
    fixture.relative(0x1120, 0x4800); fixture.relative(0x1124, fixture.string('outside')); return fixture.bytes;
  } },
  { name: 'Objective-C name terminates beyond its declared section', code: 'malformed_image', bytes: () => {
    const fixture = objcBytes(); fixture.pointer(0x2118, 0x4ffb); fixture.bytes.write('Other', 0x4ffb); return fixture.bytes;
  } },
];
for (const scenario of partials) test(`actual child metadata containment: ${scenario.name}`, { timeout: 60000 }, async t => {
  const { root, service } = await setup(t), project_path = join(root, 'project'), input_path = join(root, 'input');
  await writeFile(input_path, await scenario.bytes());
  const opened = await service.execute('project_open', { wait: true, source: { kind: 'import', input_path, project_path }, budget });
  assert.ok(opened.state === 'partial', JSON.stringify(opened)); assert.equal(opened.reason, 'incomplete_index');
  assert.ok(opened.diagnostics.some(diagnostic => diagnostic.code === scenario.code));
  const image = opened.data.image; assert.ok(image); assert.equal(opened.revision, 2);
  const scope = { project_id: opened.project_id!, revision: opened.revision!, image_id: image.id };
  const info = await service.execute('binary_info', scope);
  assert.ok(info.diagnostics.some(diagnostic => diagnostic.code === scenario.code));
  // An unmatched query cannot claim an exhausted complete index after metadata loss.
  const names = await service.execute('symbols_find', { ...scope, kinds: ['symbol', 'import', 'export'], query: { text: 'outside', match: 'exact', case_sensitive: true } });
  assert.ok(names.state === 'partial'); assert.equal(names.reason, 'incomplete_index');
  assert.equal(names.data.page.index_state, 'partial'); assert.deepEqual(names.data.items, []);
  data(await service.execute('project_close', { project_id: scope.project_id, revision: scope.revision }));
  const resumed = await service.execute('project_open', { source: { kind: 'resume', project_path } });
  assert.ok(resumed.state === 'partial'); assert.equal(resumed.revision, 2); assert.ok(resumed.data.image);
  assert.ok(resumed.diagnostics.some(diagnostic => diagnostic.code === scenario.code));
});

test('an unsupported nonselected universal slice leaves selected native indexes complete across resume', { timeout: 60000 }, async t => {
  const { root, service } = await setup(t), project_path = join(root, 'project'), input_path = join(root, 'input');
  await writeFile(input_path, await readFile(join(fixtures, 'macho-universal')));
  const opened = await service.execute('project_open', { wait: true, source: { kind: 'import', input_path, project_path }, budget });
  assert.equal(opened.state, 'complete', JSON.stringify(opened));
  assert.ok(opened.diagnostics.some(diagnostic => diagnostic.code === 'unsupported_target'));
  const image = data(opened).image; assert.ok(image);
  assert.equal(image.target.architecture, 'arm64');
  assert.ok(image.slices.some(slice => slice.architecture === 'x86_64' && !slice.supported));
  const scope = { project_id: opened.project_id!, revision: opened.revision!, image_id: image.id };
  const names = await service.execute('symbols_find', { ...scope, kinds: ['symbol', 'import', 'export'], query: { text: 'absent_native_name', match: 'exact', case_sensitive: true } });
  assert.equal(names.state, 'empty');
  assert.equal(data(names).page.index_state, 'complete'); assert.deepEqual(data(names).items, []);
  data(await service.execute('project_close', { project_id: scope.project_id, revision: scope.revision }));
  const resumed = await service.execute('project_open', { source: { kind: 'resume', project_path } });
  assert.equal(resumed.state, 'complete'); assert.equal(resumed.revision, scope.revision);
  assert.equal(data(resumed).image?.id, image.id);
  assert.ok(resumed.diagnostics.some(diagnostic => diagnostic.code === 'unsupported_target'));
});

for (const format of ['macho', 'pe'] as const) test(`actual child ${format} hostile native names remain inert searchable data`, { timeout: 60000 }, async t => {
  const { root, service } = await setup(t);
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('not a symbol provider'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const marker = join(root, 'must-not-exist'), url = `http://127.0.0.1:${address.port}/symbols`;
  const name = `$(touch '${marker}'); ${url}; ../target-library.js; "\\\n`;
  const encoded = Buffer.from(`${name}\0`);
  let bytes = await readFile(join(fixtures, format === 'macho' ? 'macho-arm64-symbols' : 'corpus-symbols.dll'));
  const nativeText = Buffer.from('open-decomp trusted fixture v1\0'), textOffset = bytes.indexOf(nativeText);
  assert.ok(textOffset >= 0); assert.ok(Buffer.byteLength(url) < nativeText.length);
  bytes.fill(0, textOffset, textOffset + nativeText.length); bytes.write(url, textOffset);
  if (format === 'macho') {
    const command = machoCommand(bytes, 2), table = bytes.readUInt32LE(command + 8), count = bytes.readUInt32LE(command + 12), strings = bytes.readUInt32LE(command + 16);
    let selected: number | undefined;
    for (let index = 0; index < count; index++) {
      const at = table + index * 16, start = strings + bytes.readUInt32LE(at), end = bytes.indexOf(0, start);
      if (bytes.toString('utf8', start, end) === '_fixture_arithmetic') selected = at;
      bytes.writeUInt32LE(0, at);
    }
    assert.notEqual(selected, undefined);
    const offset = bytes.length; bytes = Buffer.concat([bytes, Buffer.from([0]), encoded]);
    bytes.writeUInt32LE(offset, command + 16); bytes.writeUInt32LE(encoded.length + 1, command + 20); bytes.writeUInt32LE(1, selected!);
  } else {
    const { coff } = peFields(bytes), table = bytes.readUInt32LE(coff + 8), strings = table + 18 * bytes.readUInt32LE(coff + 12), size = bytes.readUInt32LE(strings);
    const offset = strings + size;
    bytes = Buffer.concat([bytes, Buffer.alloc(Math.max(0, offset + encoded.length - bytes.length))]); encoded.copy(bytes, offset);
    bytes.writeUInt32LE(size + encoded.length, strings); bytes.writeUInt32LE(0, table); bytes.writeUInt32LE(size, table + 4);
  }
  const input_path = join(root, 'input'); await writeFile(input_path, bytes);
  const opened = await service.execute('project_open', { wait: true, source: { kind: 'import', input_path, project_path: join(root, 'project') }, budget });
  const image = data(opened).image; assert.ok(image);
  const scope = { project_id: opened.project_id!, revision: opened.revision!, image_id: image.id };
  const names = data(await service.execute('symbols_find', { ...scope, kinds: ['symbol'], query: { text: name, match: 'exact', case_sensitive: true } }));
  assert.ok(names.items.some(item => item.kind === 'symbol' && item.symbol.original_name === name));
  const strings = data(await service.execute('strings_find', { ...scope, query: { text: url, match: 'exact', case_sensitive: true } }));
  assert.ok(strings.items.some(item => item.text === url && item.terminated));
  assert.equal(requests, 0);
  await assert.rejects(stat(marker), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  assert.deepEqual(await readFile(input_path), bytes);
});

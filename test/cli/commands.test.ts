import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openBinary } from '../../src/api/index.js';
import { toolSchemas } from '../../src/core/index.js';
import type { ToolResult } from '../../src/core/index.js';
import { runtimeBytes } from '../metadata/fixture.js';

interface CommandOutput { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
interface FunctionsOutput {
  project_path: string;
  reused: boolean;
  result: { pages: ToolResult<'functions_find'>[] };
}
interface DecompileOutput {
  project_path: string;
  reused: boolean;
  result: ToolResult<'function_decompile'>;
}
const runner = fileURLToPath(new URL('./run-command.ts', import.meta.url));
function run(args: readonly string[], options: { signalOnProgress?: NodeJS.Signals } = {}): Promise<CommandOutput> {
  // The real subprocess needs a kill deadline, not a guessed delay before an assertion.
  const child = spawn(process.execPath, ['--import', 'tsx', runner, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, killSignal: 'SIGKILL',
  });
  const closed = once(child, 'close');
  let stdout = '', stderr = '', sent = false;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => {
    stderr += chunk;
    if (!sent && options.signalOnProgress && stderr.includes('project_open:')) {
      sent = true;
      child.kill(options.signalOnProgress);
    }
  });
  return closed.then(([code, signal]) => ({ code, signal, stdout, stderr }));
}
async function directory(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-cli-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** Real Mach-O symbols and RET instructions force multiple CLI query pages and
 * duplicate-name selection without substituting a fake query service or SDK. */
async function manyFunctions(root: string): Promise<string> {
  const { bytes, u32, u64 } = runtimeBytes([]);
  const command = 32 + bytes.readUInt32LE(36);
  u32(16, 2); u32(20, bytes.readUInt32LE(20) + 24);
  u32(command, 2); u32(command + 4, 24);
  u32(command + 8, 0x5000); u32(command + 12, 205); u32(command + 16, 0x7000);
  let stringOffset = 1;
  for (let index = 0; index < 205; index++) {
    const name = index >= 203 ? 'duplicate' : `task_${index.toString().padStart(3, '0')}`;
    const symbol = 0x5000 + index * 16;
    u32(symbol, stringOffset);
    bytes[symbol + 4] = 0x0f; bytes[symbol + 5] = 3;
    u64(symbol + 8, 0x100006000n + BigInt(index * 4));
    stringOffset += bytes.write(name, 0x7000 + stringOffset, 'utf8') + 1;
    u32(0x6000 + index * 4, 0xd65f03c0);
  }
  u32(command + 20, stringOffset);
  const binary = join(root, 'many-functions');
  await writeFile(binary, bytes);
  return binary;
}
function functionPages(output: CommandOutput): FunctionsOutput {
  assert.equal(output.signal, null, output.stderr);
  const value = JSON.parse(output.stdout) as FunctionsOutput;
  assert.equal(typeof value.project_path, 'string');
  assert.equal(typeof value.reused, 'boolean');
  assert.ok(value.result.pages.length > 0);
  for (const page of value.result.pages) toolSchemas.functions_find.output.parse(page);
  return value;
}

test('functions exhausts real pages, preserves schema metadata, filters and reuses the default sidecar', { timeout: 180_000 }, async t => {
  const root = await directory(t), binary = await manyFunctions(root);
  const first = await run(['functions', binary, '--json']);
  assert.equal(first.code, 0, first.stderr);
  const listed = functionPages(first);
  assert.equal(listed.reused, false);
  assert.ok(listed.project_path.startsWith(`${binary}.open-decomp/`));
  assert.equal(listed.result.pages.length, 3);
  const items = listed.result.pages.flatMap(page => 'data' in page ? page.data.items : []);
  assert.equal(items.length, 205);
  assert.equal(new Set(items.map(item => item.id)).size, 205);
  assert.ok(listed.result.pages.slice(0, -1).every(page => 'data' in page && page.data.page.next_cursor !== null));
  const last = listed.result.pages.at(-1)!;
  assert.ok('data' in last && last.data.page.next_cursor === null && last.data.page.index_state === 'complete');
  const filtered = await run(['functions', binary, '--name', 'TASK_202', '--json']);
  assert.equal(filtered.code, 0, filtered.stderr);
  const reused = functionPages(filtered);
  assert.equal(reused.reused, true); assert.equal(reused.project_path, listed.project_path);
  const filteredItems = reused.result.pages.flatMap(page => 'data' in page ? page.data.items : []);
  assert.equal(filteredItems.length, 1);
  assert.equal(filteredItems[0]!.original_name, 'task_202');
  const human = await run(['functions', binary, '--name=task_202']);
  assert.equal(human.code, 0, human.stderr);
  assert.ok(human.stdout.includes(filteredItems[0]!.id));
  assert.ok(human.stdout.includes('va:0x100006328'));
  assert.ok(human.stdout.includes('task_202'));
  assert.ok(human.stderr.includes('Reusing project:'));
  const empty = await run(['functions', binary, '--name', 'definitely_absent', '--json']);
  assert.equal(empty.code, 0, empty.stderr);
  assert.equal(functionPages(empty).result.pages[0]!.state, 'empty');
});

test('decompile name, ID, VA, RVA and file address resolve the same real function and preserve exact text', { timeout: 240_000 }, async t => {
  const root = await directory(t), binary = join(root, 'corpus');
  await copyFile(resolve('fixtures/bin/macho-arm64-symbols'), binary);
  const cache = join(root, 'shared-cache');
  const listed = functionPages(await run(['functions', binary, '--cache', cache, '--name', 'fixture_arithmetic', '--json']));
  const items = listed.result.pages.flatMap(page => 'data' in page ? page.data.items : []);
  assert.equal(items.length, 1);
  const selected = items[0]!;
  const name = selected.original_name ?? selected.display_name;
  assert.ok(name);
  const namedRun = await run(['decompile', binary, '--function', name, '--cache', cache, '--json']);
  assert.ok(namedRun.code === 0 || namedRun.code === 2, namedRun.stderr);
  const named = JSON.parse(namedRun.stdout) as DecompileOutput;
  toolSchemas.function_decompile.output.parse(named.result);
  assert.ok('data' in named.result && named.result.data.delivery === 'inline', namedRun.stderr);
  if (!('data' in named.result) || named.result.data.delivery !== 'inline') assert.fail('Expected inline emission');
  assert.equal(named.result.data.function_id, selected.id);
  const text = named.result.data.emission.text;
  for (const selector of [
    ['--id', selected.id], ['--address', 'va:0x100000574'],
    ['--address', 'rva:0x574'], ['--address', 'file:0x574'],
  ]) {
    const output = await run(['decompile', binary, ...selector, '--cache', cache]);
    assert.equal(output.code, namedRun.code, output.stderr);
    assert.equal(output.stdout, text.endsWith('\n') ? text : `${text}\n`);
    assert.ok(!output.stdout.includes('Reusing project:'));
  }
  const pythonRun = await run(['decompile', binary, '--id', selected.id, '--language', 'python-like', '--cache', cache, '--json']);
  const python = JSON.parse(pythonRun.stdout) as DecompileOutput;
  toolSchemas.function_decompile.output.parse(python.result);
  assert.ok('data' in python.result && python.result.data.delivery === 'inline');
  if ('data' in python.result && python.result.data.delivery === 'inline') assert.equal(python.result.data.emission.language, 'python-like');
  const cachedRun = await run(['decompile', binary, '--id', selected.id, '--cache', cache, '--json']);
  const cached = JSON.parse(cachedRun.stdout) as DecompileOutput;
  assert.ok('data' in cached.result && cached.result.data.cache === 'hit');
  assert.equal(cached.reused, true);
});

test('ambiguous and missing names never select the first match', { timeout: 120_000 }, async t => {
  const root = await directory(t), binary = await manyFunctions(root);
  const listed = functionPages(await run(['functions', binary, '--name', 'duplicate', '--json']));
  const candidates = listed.result.pages.flatMap(page => 'data' in page ? page.data.items : []);
  assert.equal(candidates.length, 2);
  const ambiguous = await run(['decompile', binary, '--function', 'duplicate']);
  assert.equal(ambiguous.code, 1, ambiguous.stderr);
  assert.equal(ambiguous.stdout, '');
  assert.match(ambiguous.stderr, /ambiguous/i);
  for (const item of candidates) {
    assert.ok(ambiguous.stderr.includes(item.id));
    assert.ok(ambiguous.stderr.includes(item.entry.value));
    assert.ok(ambiguous.stderr.includes('duplicate'));
  }
  const absent = await run(['decompile', binary, '--function', 'not_present']);
  assert.equal(absent.code, 1, absent.stderr);
  assert.equal(absent.stdout, '');
  assert.match(absent.stderr, /no function matches/i);
});

test('partial indexes remain partial after exhausting available pages, including absent-name queries', { timeout: 120_000 }, async t => {
  const root = await directory(t), binary = await manyFunctions(root);
  const cache = join(root, 'partial-cache');
  const seeded = await openBinary(binary, { cachePath: cache, budget: { instructions: 1 } });
  await seeded.close();
  const output = await run(['functions', binary, '--cache', cache, '--name', 'absent', '--json']);
  assert.equal(output.code, 2, output.stderr);
  const pages = functionPages(output).result.pages;
  assert.equal(pages.at(-1)!.state, 'partial');
  assert.ok(pages.every(page => 'data' in page && page.data.page.index_state !== 'complete'));
  const incomplete = await run(['decompile', binary, '--cache', cache, '--function', 'absent']);
  assert.equal(incomplete.code, 2, incomplete.stderr);
  assert.equal(incomplete.stdout, '');
  assert.match(incomplete.stderr, /incomplete/i);
});

test('usage errors are bounded and terminal-safe before opening any binary', { timeout: 120_000 }, async () => {
  for (const args of [
    ['functions'], ['functions', 'one', 'two'], ['functions', 'missing', '--cache'],
    ['functions', 'missing', '--name', '--json'], ['functions', 'missing', '--json', '--json'],
    ['decompile', 'missing'], ['decompile', 'missing', '--function', 'x', '--id', `entity_${'a'.repeat(64)}`],
    ['decompile', 'missing', '--address', 'va:0x10000000000000000'],
    ['decompile', 'missing', '--address', '0x123'], ['decompile', 'missing', '--id', 'junk'],
    ['decompile', 'missing', '--function', 'x', '--language', 'assembly'],
    ['functions', 'missing', '--slice', '../escape'],
    ['functions', 'missing', `--unknown\u001b[2J\n${'x'.repeat(20_000)}`],
  ]) {
    const output = await run(args);
    assert.equal(output.code, 1, output.stderr);
    assert.equal(output.stdout, '');
    assert.ok(output.stderr.length < 10_000);
    assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(output.stderr));
  }
});

test('malformed input and corrupt sidecar report engine errors instead of silently rebuilding', { timeout: 120_000 }, async t => {
  const root = await directory(t), invalid = join(root, 'invalid');
  await writeFile(invalid, 'not a supported executable');
  const failed = await run(['functions', invalid, '--json']);
  assert.equal(failed.code, 1, failed.stderr);
  assert.match(failed.stderr, /error|unsupported|failed/i);
  if (failed.stdout) {
    const result = JSON.parse(failed.stdout) as { result: ToolResult<'project_open'> };
    toolSchemas.project_open.output.parse(result.result);
    assert.ok(result.result.state === 'failed' || result.result.state === 'unsupported');
  }
  const binary = await manyFunctions(root);
  const initial = functionPages(await run(['functions', binary, '--json']));
  const database = join(initial.project_path, 'project.sqlite');
  await writeFile(database, 'damaged sqlite database');
  const corrupt = await run(['functions', binary, '--json']);
  assert.equal(corrupt.code, 1, corrupt.stderr);
  assert.match(corrupt.stderr, /error|database|sqlite/i);
  assert.equal(await readFile(database, 'utf8'), 'damaged sqlite database');
});

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  test(`${signal} cancels foreground work and releases the sidecar for the next execution`, { timeout: 120_000 }, async t => {
    const root = await directory(t), binary = await manyFunctions(root);
    const interrupted = await run(['functions', binary, '--json'], { signalOnProgress: signal });
    assert.equal(interrupted.signal, null, interrupted.stderr);
    assert.equal(interrupted.code, code, interrupted.stderr);
    const next = await run(['functions', binary, '--json']);
    assert.equal(next.signal, null, next.stderr);
    assert.ok(!/locked|busy|already open/i.test(next.stderr), next.stderr);
    assert.ok(next.code === 0 || next.code === 2 || /unfinished|incomplete/i.test(next.stderr), next.stderr);
  });
}

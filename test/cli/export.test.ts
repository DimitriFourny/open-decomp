import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openBinary } from '../../src/api/index.js';
import type { BinarySession } from '../../src/api/index.js';
import { exportBinary } from '../../src/cli/export.js';

interface CommandOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}
const runner = fileURLToPath(new URL('./run-command.ts', import.meta.url));
const fixture = resolve('fixtures/bin/libcorpus-arm64-symbols.dylib');

async function run(args: readonly string[]): Promise<CommandOutput> {
  const child = spawn(process.execPath, ['--import', 'tsx', runner, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    killSignal: 'SIGKILL',
  });
  const closed = once(child, 'close');
  let stdout = '',
    stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const [code] = (await closed) as [number | null];
  return { code, stdout, stderr };
}
async function directory(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-export-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
interface IndexRow {
  address: string;
  name: string;
  file: string;
  state: string;
  reason: string;
  code_bytes: string;
  callers: string;
  callees: string;
}
async function table(path: string): Promise<{ header: string[]; rows: string[][] }> {
  const lines = (await readFile(path, 'utf8')).split('\n');
  assert.equal(lines.pop(), '');
  const [header, ...rows] = lines;
  return { header: header!.split('\t'), rows: rows.map((row) => row.split('\t')) };
}
async function indexRows(out: string): Promise<IndexRow[]> {
  const { header, rows } = await table(join(out, 'index.tsv'));
  assert.deepEqual(header, [
    'address',
    'name',
    'file',
    'state',
    'reason',
    'code_bytes',
    'callers',
    'callees',
  ]);
  return rows.map((fields) => {
    assert.equal(fields.length, header.length);
    return Object.fromEntries(
      header.map((key, index) => [key, fields[index]!]),
    ) as unknown as IndexRow;
  });
}
/** Every generated file, by relative path, for whole-directory comparison. */
async function snapshot(out: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(out, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files.set(path.slice(out.length), await readFile(path, 'utf8'));
    }
  return files;
}

test(
  'export writes one file per indexed function, matching index rows, pseudocode and supporting indexes',
  { timeout: 300_000 },
  async (t) => {
    const root = await directory(t),
      out = join(root, 'out'),
      cache = join(root, 'cache');
    const first = await run(['export', fixture, '--out', out, '--cache', cache, '--jobs', '2']);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stderr, /export: wrote \d+ files/);
    assert.equal(first.stdout, '');

    const rows = await indexRows(out);
    const session = await openBinary(fixture, { cachePath: cache });
    t.after(() => session.close());
    const listed = [];
    let cursor: string | undefined;
    do {
      const page = await session.findFunctions({
        page: { limit: 100, ...(cursor === undefined ? {} : { cursor }) },
      });
      assert.ok('data' in page);
      listed.push(...page.data.items);
      cursor = page.data.page.next_cursor ?? undefined;
    } while (cursor !== undefined);
    assert.ok(listed.length > 4);
    // Every indexed function is a row, in address order, and nothing else is.
    assert.deepEqual(
      rows.map((row) => BigInt(row.address)),
      listed.map((item) => BigInt(item.entry.value)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    const stored = new Set(await readdir(join(out, 'functions')));
    assert.equal(stored.size, rows.length);
    assert.equal(new Set(rows.map((row) => row.file)).size, rows.length);
    const stateCounts = { complete: 0, partial: 0, failed: 0 };
    for (const row of rows) {
      assert.ok(row.file.startsWith('functions/'));
      assert.ok(stored.has(row.file.slice('functions/'.length)), `${row.file} is missing`);
      assert.ok(row.file.includes(`@${row.address}.`), row.file);
      const text = await readFile(join(out, row.file), 'utf8');
      const [header, ...body] = text.split('\n');
      assert.ok(header!.includes(row.name) && header!.includes(row.address), header);
      if (row.state === 'complete' || row.state === 'partial') {
        assert.ok(/\.c$/.test(row.file));
        assert.equal(row.state === 'partial', row.reason !== '');
        stateCounts[row.state]++;
        // Pseudocode is exactly what decompile returns for the same function, structure
        // declarations external (they are written once, to types.h).
        const result = await session.decompile(
          { address: { space: 'va', value: row.address } },
          { structures: 'external' },
        );
        assert.ok('data' in result && result.data.delivery === 'inline');
        const expected = result.data.emission.text;
        assert.equal(body.join('\n'), expected.endsWith('\n') ? expected : `${expected}\n`);
      } else {
        // Nothing is silently missing: a failed function is disassembly plus the reason.
        stateCounts.failed++;
        assert.ok(/\.asm$/.test(row.file));
        assert.ok(row.reason.length > 0);
        assert.ok(header!.includes('no pseudocode') && header!.includes(row.reason));
        assert.ok(
          body.some((line) => /^0x[0-9a-f]+: \S/.test(line)),
          text,
        );
      }
      assert.ok(Number(row.code_bytes) > 0);
    }
    assert.equal(stateCounts.complete + stateCounts.partial + stateCounts.failed, rows.length);
    assert.ok(stateCounts.complete > 0);
    const readme = (await readFile(join(out, 'README.txt'), 'utf8')).trimEnd().split('\n');
    assert.ok(readme.length <= 10);
    assert.ok(readme.some((line) => line.includes('types.h')));
    // The merged image types header is valid C on its own.
    const types = await readFile(join(out, 'types.h'), 'utf8');
    assert.match(types, /^\/\* Open Decomp recovered image types/);
    const header = spawnSync('/usr/bin/clang', ['-x', 'c', '-fsyntax-only', '-std=c11', '-'], {
      input: types,
      encoding: 'utf8',
    });
    assert.equal(header.status, 0, header.stderr);
    for (const name of ['strings.tsv', 'imports.tsv', 'exports.tsv'])
      assert.ok((await table(join(out, name))).header.length >= 3, name);
    const exports = await table(join(out, 'exports.tsv'));
    assert.ok(exports.rows.some((fields) => fields[1]!.startsWith('fixture_')));
    // Callers and callees name functions of this export.
    const names = new Set(rows.map((row) => row.name));
    const callees = rows.flatMap((row) => (row.callees === '' ? [] : row.callees.split(',')));
    assert.ok(callees.some((name) => names.has(name)));
  },
);

test(
  'export is deterministic across worker counts, idempotent, selective and never deletes foreign files',
  { timeout: 300_000 },
  async (t) => {
    const root = await directory(t),
      cache = join(root, 'cache');
    const serial = join(root, 'serial'),
      parallel = join(root, 'parallel');
    assert.equal(
      (await run(['export', fixture, '--out', serial, '--cache', cache, '--jobs', '1'])).code,
      0,
    );
    const baseline = await snapshot(serial);
    assert.equal(
      (await run(['export', fixture, '--out', parallel, '--cache', cache, '--jobs', '3'])).code,
      0,
    );
    assert.deepEqual(await snapshot(parallel), baseline);
    // Worker copies live under the cache root only while exporting.
    assert.ok((await readdir(cache)).every((entry) => !entry.startsWith('.export-')));

    // Re-running over its own output (plus stale and foreign files) restores the same tree.
    await writeFile(join(serial, 'functions', 'stale@0xdead.c'), 'old');
    await writeFile(join(serial, 'functions', 'notes.txt'), 'keep');
    await writeFile(join(serial, 'index.tsv'), 'corrupt');
    assert.equal(
      (await run(['export', fixture, '--out', serial, '--cache', cache, '--jobs', '1'])).code,
      0,
    );
    const rerun = await snapshot(serial);
    assert.equal(rerun.get('/functions/notes.txt'), 'keep');
    rerun.delete('/functions/notes.txt');
    assert.deepEqual(rerun, baseline);

    const filtered = join(root, 'filtered');
    const only = await run([
      'export',
      fixture,
      '--out',
      filtered,
      '--cache',
      cache,
      '--language',
      'python-like',
      '--name',
      'FIXTURE_ARITH',
    ]);
    assert.equal(only.code, 0, only.stderr);
    const rows = await indexRows(filtered);
    assert.deepEqual(
      rows.map((row) => row.name),
      ['fixture_arithmetic'],
    );
    assert.ok(rows[0]!.file.endsWith('.py'));
    const text = await readFile(join(filtered, rows[0]!.file), 'utf8');
    assert.ok(text.startsWith('# fixture_arithmetic @ '));
    assert.match(text.split('\n')[1]!, /^# python-like\b/i);
  },
);

test('export reports usage errors without writing', async (t) => {
  const root = await directory(t);
  const missing = await run(['export', fixture]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /--out/);
  const jobs = await run(['export', fixture, '--out', join(root, 'x'), '--jobs', '0']);
  assert.equal(jobs.code, 1);
  assert.match(jobs.stderr, /--jobs/);
  assert.deepEqual(await readdir(root), []);
  const help = await run(['export', '--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: open-decomp export BINARY --out DIR/);
});

/** Forward to a real session, but make one function's decompilation fail with a stated reason. */
function failing(session: BinarySession, failedId: string, message: string): BinarySession {
  return new Proxy(session, {
    get(target, key) {
      if (key === 'decompileFunction')
        return async (id: string, options?: Parameters<BinarySession['decompileFunction']>[1]) => {
          const result = await target.decompileFunction(id, options);
          if (id !== failedId || !('data' in result)) return result;
          const { data: _data, ...envelope } = result;
          return {
            ...envelope,
            state: 'failed',
            error: { code: 'resource_limit', severity: 'error', message, evidence_ids: [] },
            current_revision: null,
          };
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test(
  'a function that fails to decompile is still written as disassembly with its reason, and the export succeeds',
  { timeout: 300_000 },
  async (t) => {
    const root = await directory(t),
      out = join(root, 'out');
    const session = await openBinary(fixture, { cachePath: join(root, 'cache') });
    t.after(() => session.close());
    const page = await session.findFunctions({
      query: { text: 'fixture_loop', match: 'exact', case_sensitive: true },
    });
    assert.ok('data' in page && page.data.items.length === 1);
    const target = page.data.items[0]!;
    const log: string[] = [];
    const summary = await exportBinary(
      failing(session, target.id, 'forced failure for the test'),
      { out, language: 'c-like', jobs: 1 },
      new AbortController().signal,
      (message) => log.push(message),
    );
    assert.equal(summary.failed, 1);
    assert.ok(summary.complete + summary.partial + 1 === summary.functions);
    const rows = await indexRows(out);
    const row = rows.find((candidate) => candidate.name === 'fixture_loop')!;
    assert.equal(row.state, 'failed');
    assert.equal(row.reason, 'resource_limit: forced failure for the test');
    assert.equal(row.file, `functions/fixture_loop@${row.address}.asm`);
    const text = await readFile(join(out, row.file), 'utf8');
    const lines = text.trimEnd().split('\n');
    assert.ok(lines[0]!.startsWith('; fixture_loop @ '));
    assert.ok(
      lines[0]!.includes('no pseudocode: failed (resource_limit: forced failure for the test)'),
    );
    const instructions = lines.filter((line) => /^0x[0-9a-f]+: \S/.test(line));
    // The whole function body is present: it spans every byte of its range at 4 bytes each.
    assert.equal(instructions.length * 4, Number(row.code_bytes));
    const bodies = rows.filter((candidate) => candidate !== row);
    assert.ok(bodies.every((candidate) => /\.c$/.test(candidate.file)));
  },
);

test(
  'cancellation stops the export before any index file is written',
  { timeout: 120_000 },
  async (t) => {
    const root = await directory(t),
      out = join(root, 'out');
    const session = await openBinary(fixture, { cachePath: join(root, 'cache') });
    t.after(() => session.close());
    const controller = new AbortController();
    await assert.rejects(
      exportBinary(session, { out, language: 'c-like', jobs: 1 }, controller.signal, () =>
        controller.abort(),
      ),
      { name: 'AbortError' },
    );
    assert.ok(!(await readdir(out)).includes('index.tsv'));
  },
);

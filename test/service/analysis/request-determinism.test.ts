import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openBinary, type BinarySession, type ToolResult } from '../../../src/api/index.js';
import { SqliteProjectStore } from '../../../src/project/store/index.js';
import { NATIVE_SUMMARY_MARKER_ALLOWANCE } from '../../../src/service/analysis/native-summaries.js';
import { CLANG, nativeOracleSkip } from '../../support/host-tools.js';

// A request's output may depend on its own budget but never on what earlier requests of the
// same process happened to do. Image-scoped indexes and selected-local graphs are built or
// kept once per process; the request that built one must not be charged more work than a
// request that reused it, or the callee-loading reserve (half of the work left after the
// selected body) lands differently and later decisions differ: different callees become
// partial, so different structure names appear. The work budgets sweep the range in which
// the reserve cut-off of this call tree falls. Each session is a fresh sidecar process, so
// "cold" means no in-process cache and no persisted summary of any kind.
const budgets = [80_000, 84_000, 88_000, 92_000, 96_000, 100_000, 104_000, 108_000];

test(
  'a decompilation is identical whether the process served other requests first or not',
  { skip: nativeOracleSkip(), timeout: 300_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-request-determinism-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const binary = join(root, 'determinism');
    const compiled = spawnSync(
      CLANG,
      [
        '-target',
        'arm64-apple-macos13.0',
        '-O1',
        '-g0',
        '-fno-inline',
        resolve('test/service/analysis/request-determinism-source.c'),
        '-o',
        binary,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    let sessions = 0;
    const run = async (order: readonly string[], work: number): Promise<string[]> => {
      const session = await openBinary(binary, { cachePath: join(root, `cache-${sessions++}`) });
      try {
        const texts: string[] = [];
        for (const name of order) {
          const result = await session.decompile({ name }, { emitter: 'c-like', budget: { work } });
          texts.push(
            'data' in result && result.data.delivery === 'inline'
              ? result.data.emission.text
              : `unavailable: ${result.state}`,
          );
        }
        return texts;
      } finally {
        await session.close();
      }
    };
    for (const work of budgets) {
      const [cold] = await run(['root'], work);
      assert.ok(cold !== undefined);
      // The same request again, and after another function warmed the same process.
      const repeated = await run(['root', 'root'], work);
      const afterOther = await run(['mid_three', 'root'], work);
      assert.equal(repeated[1], cold, `work ${work}: repeated request`);
      assert.equal(afterOther[1], cold, `work ${work}: request after another function`);
    }
  },
);

// A callee whose only reason is `unresolved control flow` (an indirect call) is retained in
// process and persisted, so later requests reuse it. They must produce the text and charge
// the work of a request that prepared everything itself, whatever ran before it.
test(
  'a callee with an unresolved indirect call is reused with identical output and work',
  { skip: nativeOracleSkip(), timeout: 300_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-retained-reasons-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const binary = join(root, 'retained');
    const compiled = spawnSync(
      CLANG,
      [
        '-target',
        'arm64-apple-macos13.0',
        '-O1',
        '-g0',
        '-fno-inline',
        resolve('test/service/analysis/retained-reasons-source.c'),
        '-o',
        binary,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    let sessions = 0;
    const run = async (cache: string, names: readonly string[]) => {
      const session = await openBinary(binary, { cachePath: join(root, cache) });
      try {
        const results: { text: string; work: unknown }[] = [];
        for (const name of names) {
          const result = await session.decompile({ name }, { emitter: 'c-like' });
          assert.ok('data' in result && result.data.delivery === 'inline', name);
          results.push({ text: result.data.emission.text, work: result.data.work });
        }
        return results;
      } finally {
        await session.close();
      }
    };
    // Reference: each function alone in a fresh cache.
    const cold = new Map<string, { text: string; work: unknown }>();
    for (const name of ['user_a', 'user_b', 'user_c'])
      cold.set(name, (await run(`cold-${sessions++}`, [name]))[0]!);
    for (const { work } of cold.values()) assert.notEqual(work, undefined);
    // In process: the functions after the first reuse what it retained.
    const together = await run('warm', ['user_b', 'user_a', 'user_c']);
    // Persisted: a new process reuses the rows the previous one wrote.
    await run('persisted', ['user_b']);
    const persisted = await run('persisted', ['user_c']);
    const expectations: [string, { text: string; work: unknown }][] = [
      ['user_b', together[0]!],
      ['user_a', together[1]!],
      ['user_c', together[2]!],
    ];
    for (const [name, got] of expectations) {
      assert.equal(got.text, cold.get(name)!.text, `${name}: text after other requests`);
      assert.deepEqual(got.work, cold.get(name)!.work, `${name}: work after other requests`);
    }
    assert.equal(persisted[0]!.text, cold.get('user_c')!.text, 'user_c: text from persisted rows');
  },
);

// The open-time job prepares and persists every function's generic unit before any request.
// A request that reuses one replays its exact charge, so its text and work equal those of a
// process that prepared everything itself, across the budgets in which the callee reserve
// cut-off falls. Each request runs in a fresh process (in-process history is the first
// test's subject), on a copy of the project the job left.
test(
  'decompiling with and without the open-time job gives identical texts and work',
  { skip: nativeOracleSkip(), timeout: 300_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-open-job-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const binary = join(root, 'determinism');
    const compiled = spawnSync(
      CLANG,
      [
        '-target',
        'arm64-apple-macos13.0',
        '-O1',
        '-g0',
        '-fno-inline',
        resolve('test/service/analysis/request-determinism-source.c'),
        '-o',
        binary,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    const names = ['root', 'mid_three'];
    const requests = budgets.flatMap((work) => names.map((name) => ({ name, work })));
    const decompileFresh = async (cachePath: string, name: string, work: number) => {
      const session = await openBinary(binary, { cachePath });
      try {
        const result = await session.decompile({ name }, { emitter: 'c-like', budget: { work } });
        return 'data' in result && result.data.delivery === 'inline'
          ? { text: result.data.emission.text, work: result.data.work }
          : { text: `unavailable: ${result.state}`, work: undefined };
      } finally {
        await session.close();
      }
    };
    const jobCache = join(root, 'job');
    const withJob = await openBinary(binary, { cachePath: jobCache, openJob: { jobs: 2 } });
    const job = withJob.openJob;
    await withJob.close();
    assert.ok(job);
    assert.equal(job.state, 'completed', job.message);
    assert.ok(job.stored > 0 && job.stored === job.prepared, 'every unit or marker imported');
    for (const [index, { name, work }] of requests.entries()) {
      const cold = await decompileFresh(join(root, `cold-${index}`), name, work);
      const copy = join(root, `job-${index}`);
      await cp(jobCache, copy, { recursive: true });
      const reused = await decompileFresh(copy, name, work);
      assert.deepEqual(reused, cold, `${name} at work ${work}`);
    }
    // A later open finds nothing left to prepare.
    const later = await openBinary(binary, { cachePath: jobCache, openJob: {} });
    try {
      assert.equal(later.openJob?.state, 'skipped');
    } finally {
      await later.close();
    }
  },
);

test(
  'a cancelled open-time job leaves a usable project',
  { skip: nativeOracleSkip(), timeout: 300_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-open-job-cancel-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const binary = join(root, 'retained');
    const compiled = spawnSync(
      CLANG,
      [
        '-target',
        'arm64-apple-macos13.0',
        '-O1',
        '-g0',
        '-fno-inline',
        resolve('test/service/analysis/retained-reasons-source.c'),
        '-o',
        binary,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    const decompile = async (session: BinarySession, name: string) => {
      const result = await session.decompile({ name }, { emitter: 'c-like' });
      assert.ok('data' in result && result.data.delivery === 'inline');
      return { text: result.data.emission.text, work: result.data.work };
    };
    const cold = new Map<string, { text: string; work: unknown }>();
    for (const name of ['user_b', 'user_c']) {
      const session = await openBinary(binary, { cachePath: join(root, `cold-${name}`) });
      cold.set(name, await decompile(session, name).finally(() => session.close()));
    }
    // Cancelled by its own signal: before it starts, and while its helpers run. The second
    // case needs real time (the job exposes no hook between helper batches); it accepts a job
    // that finished first, so it cannot flake. Each case has its own project, and the first
    // then runs the job to completion and serves another function.
    for (const delay of [-1, 30]) {
      const cache = join(root, `cancelled-${delay}`);
      const controller = new AbortController();
      if (delay < 0) controller.abort();
      else setTimeout(() => controller.abort(), delay);
      const session = await openBinary(binary, {
        cachePath: cache,
        openJob: { jobs: 2, signal: controller.signal },
      });
      try {
        const report = session.openJob;
        assert.ok(report && ['cancelled', 'completed'].includes(report.state), report?.state);
        if (delay < 0) assert.equal(report.state, 'cancelled');
        if (report.state === 'cancelled') assert.equal(report.stored, 0, 'nothing imported');
        assert.deepEqual(await decompile(session, 'user_c'), cold.get('user_c'));
      } finally {
        await session.close();
      }
      if (delay >= 0) continue;
      const resumed = await openBinary(binary, { cachePath: cache, openJob: { jobs: 2 } });
      try {
        assert.equal(resumed.openJob?.state, 'completed', resumed.openJob?.message);
        assert.deepEqual(await decompile(resumed, 'user_b'), cold.get('user_b'));
      } finally {
        await resumed.close();
      }
    }
  },
);

// Units are persisted whatever their size (instructions + IR nodes + evidence + traced reads)
// as long as their encoding fits the store's 128 MiB graph bound; the former size bound was
// 8,192. The open-time job persists a generated callee of size about 7.4k (about 1.8 MB
// compressed), and a later process that reuses the row decompiles its caller with the text
// and work of a process that prepared it.
test(
  'a large unit persists and is reused with identical output and work',
  { skip: nativeOracleSkip(), timeout: 300_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-large-unit-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const lines = Array.from(
      { length: 200 },
      (_, i) =>
        `  a = a * ${2 * i + 3} + p[${i % 13}]; b ^= a >> ${(i % 5) + 1}; c += b * ${i + 1}; p[${(i * 7) % 13}] = a + c;`,
    );
    const source = join(root, 'large.c');
    await writeFile(
      source,
      `int big(int *p, int n) {\n  int a = n, b = p[0], c = p[1];\n${lines.join('\n')}\n  return a + b + c;\n}\nint caller(int *p) { return big(p, 3) + 1; }\nint main(void) { int p[13] = {0}; return caller(p); }\n`,
    );
    const binary = join(root, 'large');
    const compiled = spawnSync(
      CLANG,
      ['-target', 'arm64-apple-macos13.0', '-O1', '-g0', '-fno-inline', source, '-o', binary],
      { encoding: 'utf8' },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    const decompile = async (session: BinarySession) => {
      const result = await session.decompile({ name: 'caller' }, { emitter: 'c-like' });
      assert.ok('data' in result && result.data.delivery === 'inline');
      return { text: result.data.emission.text, work: result.data.work };
    };
    const coldSession = await openBinary(binary, { cachePath: join(root, 'cold') });
    const cold = await decompile(coldSession).finally(() => coldSession.close());
    const cache = join(root, 'job');
    const jobSession = await openBinary(binary, { cachePath: cache, openJob: { jobs: 1 } });
    const projectPath = jobSession.projectPath;
    assert.equal(jobSession.openJob?.state, 'completed', jobSession.openJob?.message);
    await jobSession.close();
    // The largest persisted unit is above the former bound.
    const db = new DatabaseSync(join(projectPath, 'project.sqlite'), { readOnly: true });
    const rows = db
      .prepare('SELECT scope,function_id FROM native_summaries WHERE allowance<?')
      .all(NATIVE_SUMMARY_MARKER_ALLOWANCE);
    db.close();
    const store = SqliteProjectStore.open(projectPath, 'resume');
    let largest = 0;
    try {
      for (const row of rows) {
        const summary = store.readNativeSummary(String(row['scope']), String(row['function_id']));
        const value = summary?.value as
          | {
              unit: { instructions: number; nodes: number; evidence: unknown[] };
              trace: unknown;
            }
          | undefined;
        if (!value) continue;
        const size =
          value.unit.instructions +
          value.unit.nodes +
          value.unit.evidence.length +
          (Array.isArray(value.trace) ? value.trace.length : 0);
        largest = Math.max(largest, size);
      }
    } finally {
      await store.close();
    }
    // Well above the sizes a request prepares in tens of milliseconds.
    assert.ok(largest > 6000, `largest persisted unit size ${largest}`);
    const later = await openBinary(binary, { cachePath: cache });
    try {
      assert.deepEqual(await decompile(later), cold, 'caller from the persisted large unit');
    } finally {
      await later.close();
    }
  },
);

// Request workers (T9): with four, decompiles run in parallel processes over a shared read-only
// snapshot of the project and the session's owner publishes them. Every function's text and
// work equal those of one owner decompiling them one after another, across the budgets in
// which the callee reserve cut-off falls; the owner published every result (a later session
// is served from the store).
test(
  'decompiles give identical texts and work with one and four request workers',
  { skip: nativeOracleSkip(), timeout: 300_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-request-workers-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const binary = join(root, 'determinism');
    const compiled = spawnSync(
      CLANG,
      [
        '-target',
        'arm64-apple-macos13.0',
        '-O1',
        '-g0',
        '-fno-inline',
        resolve('test/service/analysis/request-determinism-source.c'),
        '-o',
        binary,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    type Outcome = { text: string; work: unknown; cache: unknown };
    const outcome = (result: ToolResult<'function_decompile'>): Outcome =>
      'data' in result && result.data.delivery === 'inline'
        ? { text: result.data.emission.text, work: result.data.work, cache: result.data.cache }
        : { text: `unavailable: ${result.state}`, work: undefined, cache: undefined };
    const run = async (cachePath: string, workers: number): Promise<Map<string, Outcome>> => {
      const session = await openBinary(binary, {
        cachePath,
        openJob: { jobs: 2 },
        requestWorkers: workers,
      });
      try {
        const found = await session.findFunctions({ page: { limit: 1000 } });
        assert.ok('data' in found);
        const requests = [100_000, 104_000, undefined].flatMap((work) =>
          found.data.items.map((fn) => ({ fn, work })),
        );
        // `workers` requests in flight (the session runs that many at a time), in order.
        const results: ToolResult<'function_decompile'>[] = [];
        let next = 0;
        await Promise.all(
          Array.from({ length: workers }, async () => {
            for (let index = next++; index < requests.length; index = next++) {
              const { fn, work } = requests[index]!;
              results[index] = await session.decompileFunction(fn.id, {
                emitter: 'c-like',
                ...(work === undefined ? {} : { budget: { work } }),
              });
            }
          }),
        );
        return new Map(
          requests.map(({ fn, work }, index) => [
            `${fn.display_name ?? fn.id}@${work ?? 'default'}`,
            outcome(results[index]!),
          ]),
        );
      } finally {
        await session.close();
      }
    };
    const serial = await run(join(root, 'one'), 1);
    const parallel = await run(join(root, 'four'), 4);
    assert.ok(serial.size >= 12, `${serial.size} requests`);
    assert.deepEqual(parallel, serial);
    // Each request computed its result (a failed one has none).
    for (const [key, { cache }] of parallel) assert.notEqual(cache, 'hit', key);
    // The owner published what the request workers computed: a later session hits it.
    const later = await openBinary(binary, { cachePath: join(root, 'four') });
    try {
      const again = outcome(await later.decompile({ name: 'root' }, { emitter: 'c-like' }));
      assert.equal(again.cache, 'hit');
      assert.equal(again.text, serial.get('_root@default')?.text);
    } finally {
      await later.close();
    }
  },
);

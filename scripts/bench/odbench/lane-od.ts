/**
 * OD lane: decompiles the corpus with a checkout's built `dist/` API. One `od-worker.ts` child per
 * binary and repeat (isolated memory, fresh cache directory, cold timing). The checkout is only
 * imported, never modified; budgets are never overridden.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { binaryPath, corpusBinary, tierFunctions } from './corpus.js';
import { hostInfo, resetLane, writeLane, writeText } from './store.js';
import { sampleProcessTree } from './rss.js';
import { FIRST_FUNCTIONS } from './speed.js';
import { ODBENCH_DIR } from './types.js';
import type {
  BinaryTiming,
  Corpus,
  CorpusFunction,
  FunctionResult,
  FunctionDiagnostic,
  FunctionWork,
  FunctionState,
  LaneRun,
  ProcessRss,
  Tier,
} from './types.js';

const WORKER = join(ODBENCH_DIR, 'od-worker.ts');
const CHECKOUT = resolve(ODBENCH_DIR, '../../..');

/** What the parent hands the worker (as a JSON file named by argv[2]). */
export interface OdWorkerRequest {
  /** `file://` URL of `<repo>/dist/src/api/index.js`. */
  readonly api: string;
  readonly input: string;
  readonly binary: string;
  readonly cachePath: string;
  readonly inference: 'proven' | 'likely';
  /** False opens without the open-time job (`openJob: false`). */
  readonly open_job: boolean;
  /** JSONL file the worker appends its `OdWorkerLine`s to. */
  readonly out: string;
  readonly repeat: { readonly index: number; readonly total: number };
  readonly functions: readonly {
    readonly id: string;
    readonly va: string;
    readonly name: string | null;
  }[];
}

export type OdWorkerLine =
  | {
      readonly kind: 'open';
      readonly import_ms: number;
      /** The open-time job's own time and work; set only when the job ran. */
      readonly open_job_ms?: number;
      readonly open_job_work?: number;
    }
  | { readonly kind: 'open_error'; readonly message: string }
  | { readonly kind: 'start'; readonly id: string }
  | {
      readonly kind: 'fn';
      readonly id: string;
      readonly state: FunctionState;
      readonly reason: string | null;
      readonly ms: number;
      /** Wall time from `openBinary` returning to this result. */
      readonly at_ms?: number;
      readonly text: string | null;
      readonly work: FunctionWork | null;
      readonly diagnostics: readonly FunctionDiagnostic[];
    }
  | {
      readonly kind: 'done';
      readonly cold_ms: number;
      readonly decompile_ms_total: number;
      /** The worker process's own exact peak resident set size. */
      readonly worker_peak_rss_bytes?: number;
    };

/** One function in one repeat. */
interface Attempt {
  readonly state: FunctionState;
  readonly reason: string | null;
  readonly ms: number | null;
  readonly at_ms: number | null;
  readonly text: string | null;
  readonly work: FunctionWork | null;
  readonly diagnostics: readonly FunctionDiagnostic[] | null;
}

/** One worker process: its functions' attempts and timing. */
interface Repeat {
  readonly attempts: ReadonlyMap<string, Attempt>;
  readonly import_ms: number | null;
  readonly open_job_ms: number | null;
  readonly open_job_work: number | null;
  readonly first10_ms: number | null;
  readonly peak_rss: readonly ProcessRss[];
  readonly cold_ms: number;
  readonly decompile_ms_total: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function git(repo: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

async function runWorker(
  request: OdWorkerRequest,
  requestFile: string,
): Promise<{ exit: string | null; wall_ms: number; rss: readonly ProcessRss[] }> {
  await writeFile(requestFile, JSON.stringify(request));
  const start = performance.now();
  // cwd = this checkout so `--import tsx` resolves here whatever checkout is measured.
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--no-deprecation', '--import', 'tsx', WORKER, requestFile],
      {
        cwd: CHECKOUT,
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    );
    const sampler = child.pid === undefined ? null : sampleProcessTree(child.pid);
    const finish = (exit: string | null): void => {
      const wall_ms = performance.now() - start;
      void (sampler?.stop() ?? Promise.resolve([])).then((rss) => resolve({ exit, wall_ms, rss }));
    };
    child.on('error', (error) => finish(`worker spawn failed: ${error.message}`));
    child.on('close', (code, signal) =>
      finish(
        signal
          ? `worker killed by ${signal}`
          : code === 0
            ? null
            : `worker exited with code ${code}`,
      ),
    );
  });
}

/** `atMs` is every corpus function's result time (corpus order): the 10th's, or null when there is none. */
export function firstFunctionsMs(atMs: readonly (number | null)[]): number | null {
  return atMs.length < FIRST_FUNCTIONS ? null : (atMs[FIRST_FUNCTIONS - 1] ?? null);
}

/** The worker's exact self-reported peak replaces its sampled one when larger. */
function withWorkerPeak(
  sampled: readonly ProcessRss[],
  exact: number | undefined,
): readonly ProcessRss[] {
  if (exact === undefined) return sampled;
  const worker = sampled.find((process_) => process_.role === 'bench worker');
  return worker
    ? sampled.map((process_) =>
        process_ === worker ? { ...worker, bytes: Math.max(worker.bytes, exact) } : process_,
      )
    : [{ role: 'bench worker', bytes: exact }, ...sampled];
}

/** The repeat whose largest process peak is the greatest (peak RSS is a maximum, never a median). */
export function largestPeak(repeats: readonly (readonly ProcessRss[])[]): readonly ProcessRss[] {
  const top = (peak: readonly ProcessRss[]): number => Math.max(0, ...peak.map((p) => p.bytes));
  return repeats.reduce<readonly ProcessRss[]>(
    (best, peak) => (top(peak) > top(best) ? peak : best),
    [],
  );
}

async function runRepeat(
  request: OdWorkerRequest,
  fns: readonly CorpusFunction[],
  workDir: string,
): Promise<Repeat> {
  const process_ = await runWorker(request, join(workDir, 'request.json'));
  const text = await readFile(request.out, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const lines = text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as OdWorkerLine);
  const attempts = new Map<string, Attempt>();
  let importMs: number | null = null;
  let openJobMs: number | null = null;
  let openJobWork: number | null = null;
  let done: Extract<OdWorkerLine, { kind: 'done' }> | null = null;
  let openError: string | null = null;
  let started: string | null = null;
  for (const line of lines) {
    if (line.kind === 'open') {
      importMs = line.import_ms;
      openJobMs = line.open_job_ms ?? null;
      openJobWork = line.open_job_work ?? null;
    } else if (line.kind === 'open_error') openError = line.message;
    else if (line.kind === 'start') started = line.id;
    else if (line.kind === 'fn')
      attempts.set(line.id, {
        state: line.state,
        reason: line.reason,
        ms: line.ms,
        at_ms: line.at_ms ?? null,
        text: line.text,
        work: line.work,
        diagnostics: line.diagnostics,
      });
    else done = line;
  }
  // A function without a result means the worker died, never that it was skipped.
  const lost = openError ?? process_.exit ?? 'worker exited without a result';
  for (const fn of fns) {
    if (attempts.has(fn.id)) continue;
    const reason =
      openError !== null
        ? `open failed: ${openError}`
        : started === fn.id
          ? `${lost} while decompiling this function`
          : `${lost} (before this function)`;
    attempts.set(fn.id, {
      state: 'failed',
      reason,
      ms: null,
      at_ms: null,
      text: null,
      work: null,
      diagnostics: null,
    });
  }
  const measured = [...attempts.values()].reduce((sum, attempt) => sum + (attempt.ms ?? 0), 0);
  return {
    attempts,
    import_ms: importMs,
    open_job_ms: openJobMs,
    open_job_work: openJobWork,
    first10_ms: firstFunctionsMs(fns.map((fn) => attempts.get(fn.id)?.at_ms ?? null)),
    peak_rss: withWorkerPeak(process_.rss, done?.worker_peak_rss_bytes),
    cold_ms: done?.cold_ms ?? process_.wall_ms,
    decompile_ms_total: done?.decompile_ms_total ?? measured,
  };
}

export async function runOdLane(opts: {
  corpus: Corpus;
  corpusSha256: string;
  label: string;
  repo: string;
  tier: Tier;
  repeat: number;
  inference: 'proven' | 'likely';
  only: readonly string[] | null;
  /** Request workers per binary; only 1 until roadmap 4 T9 (parallel requests over one opened project). */
  jobs: number;
  /** Run the open-time job at open (default build behaviour); false passes `openJob: false`. */
  openJob: boolean;
}): Promise<LaneRun> {
  if (opts.jobs !== 1)
    throw new Error(
      `od: --jobs ${opts.jobs} is not supported yet: decompiling one binary with several request workers needs roadmap 4 T9; only --jobs 1 runs`,
    );
  const loadStart = [...loadavg()];
  const started = new Date().toISOString();
  const repo = resolve(opts.repo);
  const api = join(repo, 'dist', 'src', 'api', 'index.js');
  if (!existsSync(api))
    throw new Error(
      `od: ${api} does not exist; build the checkout first (bun run build in ${repo})`,
    );
  if (!Number.isInteger(opts.repeat) || opts.repeat < 1)
    throw new Error(`od: repeat must be a positive integer, got ${opts.repeat}`);
  for (const id of opts.only ?? []) corpusBinary(opts.corpus, id);
  const packageVersion = await readFile(join(repo, 'package.json'), 'utf8')
    .then((text) => {
      const manifest: { version?: string } = JSON.parse(text);
      return manifest.version ?? null;
    })
    .catch(() => null);
  const distBuilt = statSync(api).mtimeMs;
  const lastSrcCommit = Number(git(repo, ['log', '-1', '--format=%ct', '--', 'src']) ?? '0') * 1000;
  const srcChanges = git(repo, ['status', '--porcelain', '--', 'src']);
  const freshness = [
    ...(distBuilt < lastSrcCommit
      ? [
          'WARNING: dist/ is older than the last commit touching src/; rebuild with `bun run build`.',
        ]
      : []),
    ...(srcChanges
      ? ['WARNING: src/ has uncommitted changes; git_head does not identify the measured code.']
      : []),
  ];

  const lane = `od-${opts.label}`;
  await resetLane(lane);
  const tierFns = tierFunctions(opts.corpus, opts.tier);
  const functions: Record<string, FunctionResult> = {};
  const binaries: Record<string, BinaryTiming> = {};

  const snapshot = (): LaneRun => ({
    schema: 'odbench-lane/1',
    lane,
    kind: 'od',
    tool: {
      name: 'open-decomp',
      version: packageVersion,
      path: repo,
      git_head: git(repo, ['rev-parse', 'HEAD']),
      dirty: (() => {
        const status = git(repo, ['status', '--porcelain']);
        return status === null ? null : status !== '';
      })(),
      options: {
        emitter: 'c-like',
        view: 'source',
        inference: opts.inference,
        open_job: opts.openJob,
        dist_built: new Date(distBuilt).toISOString(),
      },
    },
    corpus_sha256: opts.corpusSha256,
    tier: opts.tier,
    started,
    finished: new Date().toISOString(),
    host: hostInfo(loadStart),
    repeat: opts.repeat,
    jobs: opts.jobs,
    binaries,
    functions,
    notes: [
      'One worker process per binary and repeat, fresh cache directory, default budgets and structures.',
      'cold_ms = API module load + openBinary + every decompile (tsx start-up and session close excluded); import_ms = open_ms = openBinary (import, discovery and the open-time job); open_job_ms / open_job_work = the open-time job alone; per-function ms = median over repeats.',
      'first10_ms = wall time from openBinary returning to the 10th corpus function result (corpus order); peak_rss = peak resident set size per process (ps sampling every 200 ms for the analysis workers, exact maxRSS for the bench worker), largest over repeats.',
      ...freshness,
    ],
  });

  for (const binary of opts.corpus.binaries) {
    const fns = tierFns.filter((fn) => fn.binary === binary.id);
    if (fns.length === 0 || (opts.only && !opts.only.includes(binary.id))) continue;
    const repeats: Repeat[] = [];
    for (let index = 0; index < opts.repeat; index++) {
      const work = await mkdtemp(join(tmpdir(), 'odbench-od-'));
      const cachePath = join(work, 'cache');
      try {
        repeats.push(
          await runRepeat(
            {
              api: pathToFileURL(api).href,
              input: binaryPath(binary),
              binary: binary.id,
              cachePath,
              inference: opts.inference,
              open_job: opts.openJob,
              out: join(work, 'out.jsonl'),
              repeat: { index, total: opts.repeat },
              functions: fns.map((fn) => ({ id: fn.id, va: fn.va, name: fn.name })),
            },
            fns,
            work,
          ),
        );
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    }

    for (const fn of fns) {
      const attempts = repeats.map((repeat) => repeat.attempts.get(fn.id)!);
      const first = attempts[0]!;
      const times = attempts.flatMap((attempt) => (attempt.ms === null ? [] : [attempt.ms]));
      const written =
        first.text === null
          ? { text_file: null, sha256: null, bytes: 0 }
          : await writeText(lane, fn.id, first.text);
      functions[fn.id] = {
        state: first.state,
        reason: first.reason,
        ms: times.length === 0 ? null : median(times),
        work: first.work,
        diagnostics: first.diagnostics,
        ...written,
        ...(opts.repeat > 1
          ? {
              deterministic: attempts.every(
                (attempt) => attempt.state === first.state && attempt.text === first.text,
              ),
            }
          : {}),
      };
    }
    const importTimes = repeats.flatMap((repeat) =>
      repeat.import_ms === null ? [] : [repeat.import_ms],
    );
    const first10 = repeats.flatMap((repeat) =>
      repeat.first10_ms === null ? [] : [repeat.first10_ms],
    );
    const openJobs = repeats.flatMap((repeat) =>
      repeat.open_job_ms === null ? [] : [repeat.open_job_ms],
    );
    const openJobWork = repeats.flatMap((repeat) =>
      repeat.open_job_work === null ? [] : [repeat.open_job_work],
    );
    binaries[binary.id] = {
      cold_ms: median(repeats.map((repeat) => repeat.cold_ms)),
      import_ms: importTimes.length === 0 ? null : median(importTimes),
      analysis_ms: null,
      decompile_ms_total: median(repeats.map((repeat) => repeat.decompile_ms_total)),
      open_ms: importTimes.length === 0 ? null : median(importTimes),
      ...(openJobs.length === 0 ? {} : { open_job_ms: median(openJobs) }),
      ...(openJobWork.length === 0 ? {} : { open_job_work: median(openJobWork) }),
      first10_ms: first10.length === 0 ? null : median(first10),
      peak_rss: largestPeak(repeats.map((repeat) => repeat.peak_rss)),
      ...(opts.repeat > 1 ? { repeats_cold_ms: repeats.map((repeat) => repeat.cold_ms) } : {}),
    };
    const states = fns.map((fn) => functions[fn.id]?.state);
    process.stderr.write(
      `od: ${binary.id} done, ${states.filter((state) => state === 'complete').length}/${fns.length} complete, cold ${Math.round(binaries[binary.id]!.cold_ms)} ms\n`,
    );
    await writeLane(snapshot());
  }

  const run = snapshot();
  await writeLane(run);
  return run;
}

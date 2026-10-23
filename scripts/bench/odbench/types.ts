/**
 * odbench shared contract: corpus, lane store and judgment shapes, data-store paths.
 * Every odbench module imports these; change them only together with every reader.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ODBENCH_DIR = dirname(fileURLToPath(import.meta.url));
export const CORPUS_PATH = join(ODBENCH_DIR, 'corpus.json');

export type Tier = 'quick' | 'full';
export type SizeBucket = 'small' | 'medium' | 'large' | 'huge';

/** Code-byte bounds of the size buckets: small < 128 <= medium < 1024 <= large < 8192 <= huge. */
export function sizeBucket(codeBytes: number): SizeBucket {
  if (codeBytes < 128) return 'small';
  if (codeBytes < 1024) return 'medium';
  if (codeBytes < 8192) return 'large';
  return 'huge';
}

export interface CorpusSource {
  /** Stable id, e.g. `sqlite3.c`, `brotli.c`, `matrix/adler32.c`. */
  readonly id: string;
  /** Path relative to `<bench dir>/sources/`. */
  readonly path: string;
  readonly sha256: string;
  readonly origin: string;
  readonly url?: string;
}

export interface CorpusBinary {
  /** Stable id. `sqlite3-arm64` and `brotli` are shared with scripts/bench/llm-tasks/questions.json. */
  readonly id: string;
  /** Path relative to `<bench dir>/inputs/`. */
  readonly path: string;
  readonly sha256: string;
  readonly format: 'macho' | 'elf' | 'pe';
  readonly arch: 'arm64' | 'x86_64';
  /** `release` = vendor build with unknown exact flags. */
  readonly opt: 'O0' | 'O2' | 'release';
  readonly stripped: boolean;
  /** Corpus group used for breakdowns: `sqlite`, `brotli`, `matrix`. */
  readonly group: string;
  readonly origin: string;
  /** CorpusSource ids holding this binary's function definitions. */
  readonly sources: readonly string[];
}

export interface CorpusFunction {
  /** `${binary}/${name ?? 'sub'}@${va}`, e.g. `brotli/CheckAlias@0x100002f0c`. */
  readonly id: string;
  readonly binary: string;
  /** Open Decomp `va` address, lowercase `0x` hex. */
  readonly va: string;
  /** C spelling of the native symbol (Mach-O leading underscore dropped); null in stripped binaries. */
  readonly name: string | null;
  /**
   * The defining source function (for stripped binaries: the symbol-bearing twin's name). `alternative`
   * (0-based, source order) picks the active definition when the file defines the name once per
   * conditional-compilation branch; without it the name must be defined exactly once.
   */
  readonly source: {
    readonly file: string;
    readonly name: string;
    readonly alternative?: number;
  } | null;
  readonly code_bytes: number;
  readonly size: SizeBucket;
  /** `quick` functions are also `full` functions. */
  readonly tiers: readonly Tier[];
}

export interface Corpus {
  readonly schema: 'odbench-corpus/1';
  readonly frozen: string;
  readonly method: string;
  readonly binaries: readonly CorpusBinary[];
  readonly sources: readonly CorpusSource[];
  readonly functions: readonly CorpusFunction[];
}

export type LaneKind = 'od' | 'ghidra' | 'source';
export type FunctionState = 'complete' | 'partial' | 'failed' | 'not_found';

export interface HostInfo {
  readonly platform: string;
  readonly cpu: string;
  readonly cores: number;
  readonly memory_bytes: number;
  readonly node: string;
  readonly loadavg_start: readonly number[];
  readonly loadavg_end: readonly number[];
}

export interface BinaryTiming {
  /** Wall time of everything for this binary: process start/open, import, analysis, every decompile. */
  readonly cold_ms: number;
  /** Open Decomp: `openBinary` (import + indexes). Ghidra: JVM start + import (cold − analysis − decompiles). */
  readonly import_ms: number | null;
  /** Ghidra auto-analysis; null for Open Decomp (its analysis happens inside each decompile). */
  readonly analysis_ms: number | null;
  readonly decompile_ms_total: number;
  /** Open Decomp: `openBinary` wall time (median over repeats; once an open-time job exists, it includes the job). Absent on lanes recorded before roadmap 4 M2 and on other tools. */
  readonly open_ms?: number | null;
  /** Open Decomp: the open-time job's own share of `open_ms` (roadmap 4 T8). Recorded only when the job ran. */
  readonly open_job_ms?: number | null;
  /** Open Decomp: the work the open-time job charged under its own budget (not request work). */
  readonly open_job_work?: number | null;
  /** Open Decomp: wall time from `openBinary` returning to the 10th corpus function's result, in corpus order (median over repeats); null for a binary with fewer than 10 corpus functions or without that result. */
  readonly first10_ms?: number | null;
  /** Open Decomp: peak resident set size of every process the binary's run used (largest over repeats); absent on lanes recorded before roadmap 4 M2. */
  readonly peak_rss?: readonly ProcessRss[];
  /** cold_ms of every repeat when `repeat > 1`. */
  readonly repeats_cold_ms?: readonly number[];
}

/** Peak resident set size of one process of an Open Decomp run. */
export interface ProcessRss {
  /** `bench worker` (the odbench process that calls the API) or `analysis worker` (a child the API spawned). */
  readonly role: string;
  readonly bytes: number;
}

/** Work one Open Decomp decompile consumed against the limit its result reported. */
export interface FunctionWork {
  readonly consumed: number;
  readonly limit: number;
}

/** One distinct diagnostic of one decompile: severity, code and the first sentence of the message. */
export interface FunctionDiagnostic {
  readonly code: string;
  readonly severity: string;
  readonly text: string;
}

export interface FunctionResult {
  readonly state: FunctionState;
  /** Tool reason/diagnostic for partial/failed/not_found (e.g. `unsupported_subset`, `budget`). */
  readonly reason: string | null;
  /** Wall time of this function's decompile (median over repeats); null when not attempted. */
  readonly ms: number | null;
  /** Relative to the lane directory: `texts/<fnKey>.c`; null when the tool printed no pseudocode. */
  readonly text_file: string | null;
  readonly sha256: string | null;
  readonly bytes: number;
  /** Ghidra: how the corpus function was located. */
  readonly resolved?: {
    readonly name: string | null;
    readonly address: string;
    readonly method: string;
  };
  /** Open Decomp: work this function's decompile consumed (`consumed`) against the work limit
   * its result reported (`limit`), taken from the first repeat; for a work-limit failure `consumed` is the count its diagnostic reports. Absent on lanes
   * recorded before this field and on other tools; null when no result carried it (failures). */
  readonly work?: FunctionWork | null;
  /** Open Decomp with repeat > 1: every repeat printed byte-identical text. */
  readonly deterministic?: boolean;
  /** Open Decomp: the result's distinct diagnostics (not part of text identity); null when no result
   * carried them (worker died before this function). Absent on lanes recorded before this field and
   * on other tools. */
  readonly diagnostics?: readonly FunctionDiagnostic[] | null;
}

export interface LaneRun {
  readonly schema: 'odbench-lane/1';
  /** Directory name under `<bench dir>/lanes/`: `od-<label>`, `ghidra`, `source`. */
  readonly lane: string;
  readonly kind: LaneKind;
  readonly tool: {
    readonly name: string;
    readonly version: string | null;
    /** Checkout or installation path. */
    readonly path: string | null;
    readonly git_head?: string | null;
    readonly dirty?: boolean | null;
    readonly options?: Readonly<Record<string, unknown>>;
  };
  readonly corpus_sha256: string;
  /** Tier the lane was last run for (a `full` lane also serves `quick`). */
  readonly tier: Tier;
  readonly started: string;
  readonly finished: string;
  readonly host: HostInfo;
  readonly repeat: number;
  /** Timing is comparable only for lanes run with `jobs: 1` on an otherwise idle host. */
  readonly jobs: number;
  readonly binaries: Readonly<Record<string, BinaryTiming>>;
  /** Keyed by CorpusFunction.id. */
  readonly functions: Readonly<Record<string, FunctionResult>>;
  readonly notes: readonly string[];
}

export type Dimension = 'control_flow' | 'data' | 'expressions' | 'noise' | 'overall';
export const DIMENSIONS: readonly Dimension[] = [
  'control_flow',
  'data',
  'expressions',
  'noise',
  'overall',
];
export type Verdict = 'first' | 'second' | 'tie';

export type JudgmentStatus = 'judged' | 'identical' | 'too_large' | 'missing' | 'error';

/** Pairwise readability of lane `a` against lane `b` for one function, both presentation orders. */
export interface ReadabilityJudgment {
  readonly fn: string;
  readonly a: string;
  readonly b: string;
  readonly status: JudgmentStatus;
  /** Per order, the judge's verdict in terms of lanes: `a`, `b` or `tie`; null unless judged. */
  readonly orders: readonly [OrderVerdicts, OrderVerdicts] | null;
  /** Lane `a`'s score per dimension: mean over both orders of win 1 / tie 0.5 / loss 0. */
  readonly score: Readonly<Record<Dimension, number>> | null;
  /** Both orders named the same winner (or both tie) per dimension. */
  readonly consistent: Readonly<Record<Dimension, boolean>> | null;
  readonly reasons: readonly string[];
  readonly error?: string;
}
export type OrderVerdicts = Readonly<Record<Dimension, 'a' | 'b' | 'tie'>>;

/** LLM comprehension: an explanation written from the lane text, graded against the source. */
export interface ComprehensionJudgment {
  readonly fn: string;
  readonly lane: string;
  readonly status: JudgmentStatus;
  /** 0–4, mean over samples. */
  readonly coverage: number | null;
  readonly correct: number | null;
  readonly wrong: number | null;
  readonly unverifiable: number | null;
  readonly wrong_claims: readonly string[];
  readonly error?: string;
}

export type QaOutcome = 'correct' | 'unknown' | 'wrong' | 'missing';

/** One frozen llm-tasks question answered from one lane's text. */
export interface QaJudgment {
  readonly question: string;
  readonly fn: string;
  readonly lane: string;
  readonly status: JudgmentStatus;
  readonly samples: readonly { readonly answer: string; readonly outcome: QaOutcome }[];
  /** Fraction of samples scored correct. */
  readonly correct_rate: number | null;
  readonly error?: string;
}

/** Claude tokens of one lane text as the judge model tokenizes it. */
export interface TokenCount {
  readonly fn: string;
  readonly lane: string;
  readonly sha256: string;
  readonly tokens: number | null;
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function functionId(binary: string, name: string | null, va: string): string {
  return `${binary}/${name ?? 'sub'}@${va}`;
}

/** File-name form of a function id: `/` becomes `__`, anything outside [A-Za-z0-9._@-] becomes `_`. */
export function fnKey(id: string): string {
  return id.replaceAll('/', '__').replace(/[^A-Za-z0-9._@-]/g, '_');
}

export type TaskName = 'tokens' | 'readability' | 'comprehension' | 'qa';
export const TASKS: readonly TaskName[] = ['tokens', 'readability', 'comprehension', 'qa'];

export interface JudgeOptions {
  readonly tier: Tier;
  readonly tasks: readonly TaskName[];
  /** Lanes for the per-lane tasks (tokens, comprehension, qa). */
  readonly lanes: readonly string[];
  /** [a, b] lane pairs for readability; `a` is scored against `b`. */
  readonly pairs: readonly (readonly [string, string])[];
  /** e.g. `anthropic/claude-haiku-5-5`. */
  readonly model: string;
  readonly backend: 'omp' | 'anthropic' | 'cmd';
  /** Shell command for the `cmd` backend: prompt on stdin, reply on stdout. */
  readonly command?: string;
  readonly concurrency: number;
  readonly qaSamples: number;
  readonly comprehensionSamples: number;
  /** Count the calls a run would make (cache misses) without calling the model. */
  readonly dryRun: boolean;
}

export interface JudgeRunSummary {
  readonly model: string;
  readonly backend: string;
  /** Per task: planned calls, cache hits, calls made, failures. */
  readonly tasks: Readonly<
    Record<
      string,
      {
        readonly planned: number;
        readonly cached: number;
        readonly called: number;
        readonly failed: number;
      }
    >
  >;
  readonly input_tokens: number;
  readonly output_tokens: number;
  /** USD as reported by the backend; null when it reports none. */
  readonly cost: number | null;
  readonly seconds: number;
}

/** Everything the judge cache holds for a tier, lanes and pairs; read without calling a model. */
export interface CollectedJudgments {
  readonly model: string;
  readonly readability: readonly ReadabilityJudgment[];
  readonly comprehension: readonly ComprehensionJudgment[];
  readonly qa: readonly QaJudgment[];
  readonly tokens: readonly TokenCount[];
}

/**
 * Data store root: $OPEN_DECOMP_BENCH_DIR, else `.odbench/` in the main checkout (shared by every
 * git worktree of this repository, so Ghidra lanes and judge caches are reused across worktrees).
 */
export function benchDir(): string {
  const configured = process.env['OPEN_DECOMP_BENCH_DIR'];
  if (configured) return resolve(configured);
  try {
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd: ODBENCH_DIR,
        encoding: 'utf8',
      },
    ).trim();
    return join(dirname(common), '.odbench');
  } catch {
    return resolve(ODBENCH_DIR, '../../..', '.odbench');
  }
}

export const paths = {
  inputs: (): string => join(benchDir(), 'inputs'),
  sources: (): string => join(benchDir(), 'sources'),
  lane: (lane: string): string => join(benchDir(), 'lanes', lane),
  judgeCache: (): string => join(benchDir(), 'judge', 'cache'),
  reports: (): string => join(benchDir(), 'reports'),
};

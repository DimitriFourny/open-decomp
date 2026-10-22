/**
 * odbench report: reads the lane store and the collected judgments, computes every axis over the
 * paired function set (tier functions on which all compared lanes have text) and renders the
 * markdown. `Report` is the content of report.json: plain numbers, `null` where a value is not
 * available, never NaN.
 */
import { tierFunctions } from './corpus.js';
import { ARTIFACT_PATTERNS, SCALAR_METRICS, computeMetrics } from './metrics.js';
import type { StaticMetrics } from './metrics.js';
import {
  DEFAULT_SEED,
  bootstrapCi,
  geomean,
  mean,
  median,
  pairedRatioGeomean,
  quantile,
  signTest,
} from './stats.js';
import { readLane, readText } from './store.js';
import { DIMENSIONS } from './types.js';
import type {
  CollectedJudgments,
  ComprehensionJudgment,
  Corpus,
  CorpusBinary,
  CorpusFunction,
  Dimension,
  HostInfo,
  LaneRun,
  QaJudgment,
  Tier,
} from './types.js';

// ---- report shape ------------------------------------------------------------------------------

export interface Estimate {
  readonly value: number | null;
  readonly lo: number | null;
  readonly hi: number | null;
  /** Observations behind the estimate. */
  readonly n: number;
}

export interface ReadabilitySummary {
  /** Functions with a usable judgment (judged or identical). */
  readonly n: number;
  /** Mean overall score of the first lane of the pair, with a bootstrap CI over functions. */
  readonly overall: Estimate;
  readonly wins: number;
  readonly ties: number;
  readonly losses: number;
  /** Exact two-sided sign test of strict wins (score 1) against strict losses (score 0). */
  readonly sign_p: number | null;
}

export interface LaneHeader {
  readonly lane: string;
  readonly kind: string;
  readonly tool: string;
  readonly version: string | null;
  readonly path: string | null;
  readonly git_head: string | null;
  readonly dirty: boolean | null;
  readonly options: Readonly<Record<string, unknown>>;
  readonly tier: Tier;
  readonly started: string;
  readonly repeat: number;
  readonly jobs: number;
  readonly corpus_sha256: string;
  readonly host: HostInfo;
}

export interface LaneScore {
  readonly lane: string;
  readonly is_reference: boolean;
  readonly coverage: {
    readonly total: number;
    readonly with_text: number;
    readonly complete: number;
    readonly partial: number;
    readonly failed: number;
    readonly not_found: number;
    /** Tier functions the lane manifest does not list at all. */
    readonly absent: number;
  };
  readonly lexical: {
    /** Sum over the paired set. */
    readonly sum: number;
    /** Geometric mean of per-function lane/reference ratios; null for the reference. */
    readonly ratio: Estimate | null;
  };
  readonly claude: {
    /** Sum over paired functions with Claude token counts for every lane; null without counts. */
    readonly sum: number | null;
    readonly ratio: Estimate | null;
  };
  /** Pair [lane, reference]; null for the reference and when the pair was not judged. */
  readonly readability: ReadabilitySummary | null;
  readonly comprehension: {
    readonly n: number;
    readonly coverage: number | null;
    readonly wrong_per_function: number | null;
    /** Mean per-function coverage difference lane − reference (functions both have graded), with CI. */
    readonly coverage_vs_reference: Estimate | null;
  } | null;
  readonly qa: {
    /** Questions answered by every compared lane that has QA judgments. */
    readonly questions: number;
    /** Answered samples. */
    readonly samples: number;
    readonly correct: number;
    readonly unknown: number;
    readonly wrong: number;
    /** Sum of the lane text's tokens over answered samples, divided by correct answers. */
    readonly tokens_per_correct: number | null;
    /** Questions where this lane's correct rate is above / below the reference's, with the sign test. */
    readonly vs_reference: {
      readonly better: number;
      readonly worse: number;
      readonly sign_p: number | null;
    } | null;
  } | null;
  readonly speed: {
    /** Sum of cold_ms over the tier's binaries present in the manifest; null when none. */
    readonly cold_ms: number | null;
    readonly binaries: number;
    readonly binaries_missing: number;
    readonly median_ms: number | null;
    readonly p90_ms: number | null;
    readonly n: number;
  };
}

export interface ReadabilityPair {
  readonly a: string;
  readonly b: string;
  readonly summary: ReadabilitySummary;
  readonly dimensions: Readonly<
    Record<Dimension, { readonly score: Estimate; readonly consistency: number | null }>
  >;
  readonly status: Readonly<Record<string, number>>;
}

export interface BreakdownRow {
  readonly value: string;
  readonly n: number;
  readonly lanes: Readonly<
    Record<
      string,
      {
        readonly lexical_ratio: number | null;
        readonly readability: number | null;
        readonly readability_n: number;
        readonly coverage: number | null;
      }
    >
  >;
}

export interface Breakdown {
  readonly by: string;
  readonly rows: readonly BreakdownRow[];
}

export interface MetricTotals {
  readonly lane: string;
  /** Per SCALAR_METRICS key: sum, max or ratio over the paired set. */
  readonly scalars: Readonly<Record<string, number>>;
  /** Mean of per-function max_nesting. */
  readonly mean_nesting: number | null;
  readonly artifacts: Readonly<Record<string, number>>;
}

export interface QaQuestionRow {
  readonly question: string;
  readonly fn: string;
  /** Correct rate per QA lane over the answered samples; null when the lane has none. */
  readonly rates: Readonly<Record<string, number | null>>;
}

export interface WorstFunction {
  readonly fn: string;
  readonly lane_tokens: number;
  readonly reference_tokens: number;
  readonly ratio: number;
  readonly claude_ratio: number | null;
}

export interface WorstSection {
  readonly lane: string;
  readonly token_ratio: readonly WorstFunction[];
  readonly readability_losses: readonly {
    readonly fn: string;
    readonly score: number;
    readonly reasons: readonly string[];
  }[];
  readonly wrong_claims: readonly {
    readonly fn: string;
    readonly wrong: number;
    readonly coverage: number | null;
    readonly claims: readonly string[];
  }[];
}

export interface BinarySpeed {
  readonly binary: string;
  readonly lane: string;
  readonly cold_ms: number;
  readonly import_ms: number | null;
  readonly analysis_ms: number | null;
  readonly decompile_ms_total: number;
}

/** Counted work (what `budget.work` bounds) of one function in one lane that recorded it. */
export interface WorkRow {
  readonly fn: string;
  readonly consumed: number;
  /** The work limit the function's own result reported. */
  readonly limit: number;
  readonly state: string;
}

export interface LaneWork {
  readonly lane: string;
  /** Tier functions of this lane with a recorded `work`. */
  readonly recorded: number;
  /** Tier functions of this lane without one (failed before a result, or a lane recorded before M1). */
  readonly unrecorded: number;
  /** Every recorded function, largest consumed work first. */
  readonly functions: readonly WorkRow[];
  /** Functions at more than 80% of their reported limit (a subset of `functions`, same order). */
  readonly above_80_percent: readonly WorkRow[];
}

export interface PerFunction {
  readonly id: string;
  readonly binary: string;
  readonly size: string;
  readonly lanes: Readonly<
    Record<
      string,
      {
        readonly state: string;
        readonly lexical_tokens: number;
        readonly claude_tokens: number | null;
        readonly ms: number | null;
        /** Counted work consumed, or null when the lane recorded none. */
        readonly work: number | null;
        /** Overall readability score of this lane against the reference. */
        readonly readability: number | null;
        readonly coverage: number | null;
      }
    >
  >;
}

export interface Report {
  readonly schema: 'odbench-report/1';
  readonly generated: string;
  readonly tier: Tier;
  readonly corpus_sha256: string;
  /** Compared lanes in column order (the requested lanes, then the reference when missing). */
  readonly lanes: readonly string[];
  readonly reference: string;
  readonly tier_functions: number;
  readonly paired_functions: number;
  readonly header: {
    readonly lanes: readonly LaneHeader[];
    readonly judge: {
      readonly model: string;
      readonly readability: number;
      readonly comprehension: number;
      readonly qa: number;
      readonly tokens: number;
    } | null;
  };
  readonly scorecard: readonly LaneScore[];
  readonly qa_token_basis: 'claude' | 'lexical' | null;
  readonly readability: readonly ReadabilityPair[];
  readonly anchor: { readonly score: number | null; readonly warning: string | null } | null;
  readonly breakdowns: readonly Breakdown[];
  readonly metrics: readonly MetricTotals[];
  readonly qa: {
    readonly common_questions: number;
    /** Lanes with QA judgments (the source lane is never asked: QA asks compiled facts). */
    readonly lanes: readonly string[];
    readonly differing: readonly QaQuestionRow[];
  };
  readonly worst: WorstSection | null;
  readonly speed: {
    readonly binaries: readonly BinarySpeed[];
    readonly load_warnings: readonly string[];
    readonly determinism_failures: readonly { readonly lane: string; readonly fn: string }[];
    /** Lanes that recorded counted work (Open Decomp lanes recorded since M1). */
    readonly work: readonly LaneWork[];
  };
  readonly warnings: readonly string[];
  readonly per_function: readonly PerFunction[];
}

// ---- small helpers -----------------------------------------------------------------------------

const finite = (value: number): number | null => (Number.isFinite(value) ? value : null);

function meanOrNull(values: readonly number[]): number | null {
  return values.length === 0 ? null : finite(mean(values));
}

function estimateOf(interval: { estimate: number; lo: number; hi: number }, n: number): Estimate {
  return { value: finite(interval.estimate), lo: finite(interval.lo), hi: finite(interval.hi), n };
}

const SIZE_ORDER = ['small', 'medium', 'large', 'huge'];

/** Per-lane lookup keyed by function id. */
type ByFn<T> = Map<string, T>;

interface Context {
  readonly corpus: Corpus;
  readonly tier: Tier;
  readonly lanes: readonly string[];
  readonly reference: string;
  readonly judgments: CollectedJudgments | null;
  readonly runs: ReadonlyMap<string, LaneRun>;
  readonly tierFns: readonly CorpusFunction[];
  readonly paired: readonly CorpusFunction[];
  readonly binaries: ReadonlyMap<string, CorpusBinary>;
  readonly metrics: ReadonlyMap<string, ByFn<StaticMetrics>>;
  readonly claude: ReadonlyMap<string, number>;
  readonly comprehension: ReadonlyMap<string, ByFn<ComprehensionJudgment>>;
}

interface PairScore {
  readonly fn: string;
  readonly status: 'judged' | 'identical';
  readonly score: Readonly<Record<Dimension, number>>;
  readonly consistent: Readonly<Record<Dimension, boolean>> | null;
  readonly reasons: readonly string[];
}

const claudeKey = (lane: string, fn: string): string => `${lane}\u0000${fn}`;

function lexicalTokens(ctx: Context, lane: string, fn: string): number | null {
  return ctx.metrics.get(lane)?.get(fn)?.lexical_tokens ?? null;
}

function claudeTokens(ctx: Context, lane: string, fn: string): number | null {
  return ctx.claude.get(claudeKey(lane, fn)) ?? null;
}

/** Judgments of `a` against `b` per function, from the direct pair or the flipped one (scores mirrored). */
function pairScores(
  ctx: Context,
  a: string,
  b: string,
  allowed: ReadonlySet<string>,
): ByFn<PairScore> {
  const result: ByFn<PairScore> = new Map();
  for (const judgment of ctx.judgments?.readability ?? []) {
    if (!allowed.has(judgment.fn) || !judgment.score) continue;
    if (judgment.status !== 'judged' && judgment.status !== 'identical') continue;
    const direct = judgment.a === a && judgment.b === b;
    if (!direct && !(judgment.a === b && judgment.b === a)) continue;
    const score = {} as Record<Dimension, number>;
    for (const dimension of DIMENSIONS)
      score[dimension] = direct ? judgment.score[dimension] : 1 - judgment.score[dimension];
    result.set(judgment.fn, {
      fn: judgment.fn,
      status: judgment.status,
      score,
      consistent: judgment.consistent,
      reasons: judgment.reasons,
    });
  }
  return result;
}

function summarizeReadability(scores: readonly PairScore[], withCi: boolean): ReadabilitySummary {
  const overall = scores.map((item) => item.score.overall);
  const wins = overall.filter((value) => value >= 1 - 1e-9).length;
  const losses = overall.filter((value) => value <= 1e-9).length;
  const interval = withCi
    ? bootstrapCi(overall, mean, { seed: DEFAULT_SEED })
    : { estimate: mean(overall), lo: Number.NaN, hi: Number.NaN };
  return {
    n: scores.length,
    overall: estimateOf(interval, scores.length),
    wins,
    ties: scores.length - wins - losses,
    losses,
    sign_p: scores.length === 0 ? null : signTest(wins, losses),
  };
}

function ratioEstimate(
  ctx: Context,
  fns: readonly CorpusFunction[],
  lane: string,
  value: (lane: string, fn: string) => number | null,
  withCi: boolean,
): Estimate | null {
  if (lane === ctx.reference) return null;
  const numerators: number[] = [];
  const denominators: number[] = [];
  for (const fn of fns) {
    const top = value(lane, fn.id);
    const bottom = value(ctx.reference, fn.id);
    if (top === null || bottom === null) continue;
    numerators.push(top);
    denominators.push(bottom);
  }
  if (withCi) {
    const ratio = pairedRatioGeomean(numerators, denominators, { seed: DEFAULT_SEED });
    return estimateOf(ratio, ratio.n);
  }
  const ratios = numerators.flatMap((top, index) => {
    const bottom = denominators[index] ?? 0;
    return top > 0 && bottom > 0 ? [top / bottom] : [];
  });
  return { value: finite(geomean(ratios)), lo: null, hi: null, n: ratios.length };
}

function comprehensionOf(
  ctx: Context,
  lane: string,
  fns: readonly CorpusFunction[],
): ComprehensionJudgment[] {
  const judged = ctx.comprehension.get(lane);
  return fns.flatMap((fn) => {
    const judgment = judged?.get(fn.id);
    return judgment ? [judgment] : [];
  });
}

// ---- QA ----------------------------------------------------------------------------------------

interface QaIndex {
  /** question → lane → judgment with at least one answered sample. */
  readonly byQuestion: Map<string, Map<string, QaJudgment>>;
  readonly lanesWithQa: readonly string[];
  readonly common: readonly string[];
}

function answered(judgment: QaJudgment): readonly QaJudgment['samples'][number][] {
  return judgment.samples.filter((sample) => sample.outcome !== 'missing');
}

function indexQa(ctx: Context): QaIndex {
  const byQuestion = new Map<string, Map<string, QaJudgment>>();
  const laneSet = new Set(ctx.lanes);
  for (const judgment of ctx.judgments?.qa ?? []) {
    if (
      !laneSet.has(judgment.lane) ||
      judgment.status !== 'judged' ||
      answered(judgment).length === 0
    )
      continue;
    let lanes = byQuestion.get(judgment.question);
    if (!lanes) byQuestion.set(judgment.question, (lanes = new Map()));
    lanes.set(judgment.lane, judgment);
  }
  const lanesWithQa = ctx.lanes.filter((lane) =>
    [...byQuestion.values()].some((lanes) => lanes.has(lane)),
  );
  const common = [...byQuestion.entries()]
    .filter(([, lanes]) => lanesWithQa.every((lane) => lanes.has(lane)))
    .map(([question]) => question)
    .sort();
  return { byQuestion, lanesWithQa, common };
}

function correctRate(judgment: QaJudgment): number {
  const samples = answered(judgment);
  return samples.filter((sample) => sample.outcome === 'correct').length / samples.length;
}

// ---- metric totals -----------------------------------------------------------------------------

function totalsOf(lane: string, all: readonly StaticMetrics[]): MetricTotals {
  const scalars: Record<string, number> = {};
  for (const { key, aggregate } of SCALAR_METRICS) {
    const values = all.map((metrics) => metrics[key]);
    if (aggregate === 'sum') scalars[key] = values.reduce((sum, value) => sum + value, 0);
    else if (aggregate === 'max')
      scalars[key] = values.reduce((top, value) => Math.max(top, value), 0);
  }
  const identifiers = scalars['identifiers'] ?? 0;
  scalars['placeholder_ratio'] =
    identifiers === 0 ? 0 : (scalars['placeholder_names'] ?? 0) / identifiers;
  const artifacts: Record<string, number> = {};
  for (const pattern of ARTIFACT_PATTERNS)
    artifacts[pattern.name] = all.reduce(
      (sum, metrics) => sum + (metrics.artifacts[pattern.name] ?? 0),
      0,
    );
  return {
    lane,
    scalars,
    mean_nesting: meanOrNull(all.map((metrics) => metrics.max_nesting)),
    artifacts,
  };
}

// ---- build -------------------------------------------------------------------------------------

export async function buildReport(opts: {
  corpus: Corpus;
  corpusSha256: string;
  tier: Tier;
  lanes: readonly string[];
  reference: string;
  judgments: CollectedJudgments | null;
}): Promise<Report> {
  const { corpus, tier, reference, judgments } = opts;
  const lanes = [...new Set([...opts.lanes, reference])];
  const warnings: string[] = [];

  const runs = new Map<string, LaneRun>();
  for (const lane of lanes) {
    const run = await readLane(lane);
    if (!run)
      throw new Error(`lane ${lane} has no run in the data store; run it first (bench run …)`);
    runs.set(lane, run);
    if (run.corpus_sha256 !== opts.corpusSha256)
      warnings.push(
        `Lane ${lane} ran on another corpus (sha ${run.corpus_sha256.slice(0, 12)}, current ${opts.corpusSha256.slice(0, 12)}): its functions may not match.`,
      );
    if (tier === 'full' && run.tier === 'quick')
      warnings.push(
        `Lane ${lane} ran the quick tier; the full tier's other functions are missing for it.`,
      );
    if (tier === 'quick' && run.tier === 'full' && run.kind !== 'source')
      warnings.push(
        `Lane ${lane} was last run on the full tier: its cold times cover every full-tier function of each binary, so compare its cold time only with lanes run on the same tier (per-function times are unaffected).`,
      );
    for (const note of run.notes)
      if (note.startsWith('WARNING: ')) warnings.push(`Lane ${lane}: ${note.slice(9)}`);
  }

  const tierFns = tierFunctions(corpus, tier);
  const hasText = (lane: string, fn: CorpusFunction): boolean =>
    Boolean(runs.get(lane)?.functions[fn.id]?.text_file);
  const paired = tierFns.filter((fn) => lanes.every((lane) => hasText(lane, fn)));
  const pairedIds = new Set(paired.map((fn) => fn.id));
  const tierIds = new Set(tierFns.map((fn) => fn.id));
  const binaries = new Map(corpus.binaries.map((binary) => [binary.id, binary]));

  const metrics = new Map<string, ByFn<StaticMetrics>>();
  for (const lane of lanes) {
    const run = runs.get(lane);
    const lanes_: ByFn<StaticMetrics> = new Map();
    for (const fn of tierFns) {
      if (!run || !hasText(lane, fn)) continue;
      const text = await readText(run, fn.id);
      if (text !== null) lanes_.set(fn.id, computeMetrics(text));
    }
    metrics.set(lane, lanes_);
  }

  const claude = new Map<string, number>();
  for (const count of judgments?.tokens ?? [])
    if (count.tokens !== null) claude.set(claudeKey(count.lane, count.fn), count.tokens);
  const comprehension = new Map<string, ByFn<ComprehensionJudgment>>();
  for (const judgment of judgments?.comprehension ?? []) {
    if (judgment.status !== 'judged' || judgment.coverage === null || !pairedIds.has(judgment.fn))
      continue;
    let byFn = comprehension.get(judgment.lane);
    if (!byFn) comprehension.set(judgment.lane, (byFn = new Map()));
    byFn.set(judgment.fn, judgment);
  }

  const ctx: Context = {
    corpus,
    tier,
    lanes,
    reference,
    judgments,
    runs,
    tierFns,
    paired,
    binaries,
    metrics,
    claude,
    comprehension,
  };

  // Section 2 inputs shared with others.
  const qaIndex = indexQa(ctx);
  const tokenSet = paired.filter((fn) =>
    lanes.every((lane) => claudeTokens(ctx, lane, fn.id) !== null),
  );
  const lexicalOf = (lane: string, fn: string): number | null => lexicalTokens(ctx, lane, fn);
  const claudeOf = (lane: string, fn: string): number | null => claudeTokens(ctx, lane, fn);

  // QA token basis: Claude tokens only when every answered text has them.
  let qaBasis: 'claude' | 'lexical' | null = null;
  if (qaIndex.common.length > 0) {
    qaBasis = 'claude';
    for (const question of qaIndex.common)
      for (const lane of qaIndex.lanesWithQa) {
        const judgment = qaIndex.byQuestion.get(question)?.get(lane);
        if (judgment && claudeTokens(ctx, lane, judgment.fn) === null) qaBasis = 'lexical';
      }
  }

  const scorecard: LaneScore[] = lanes.map((lane): LaneScore => {
    const run = runs.get(lane) as LaneRun;
    const states = tierFns.map((fn) => run.functions[fn.id]);
    const count = (state: string): number =>
      states.filter((result) => result?.state === state).length;
    const comp = comprehensionOf(ctx, lane, paired);
    const isReference = lane === reference;

    const pair = isReference ? null : pairScores(ctx, lane, reference, pairedIds);
    const readability =
      pair && pair.size > 0 ? summarizeReadability([...pair.values()], true) : null;

    let qa: LaneScore['qa'] = null;
    if (qaIndex.lanesWithQa.includes(lane) && qaIndex.common.length > 0) {
      let samples = 0;
      let correct = 0;
      let unknown = 0;
      let wrong = 0;
      let tokens = 0;
      let better = 0;
      let worse = 0;
      for (const question of qaIndex.common) {
        const judgment = qaIndex.byQuestion.get(question)?.get(lane);
        if (!judgment) continue;
        const given = answered(judgment);
        const cost =
          qaBasis === 'claude'
            ? claudeTokens(ctx, lane, judgment.fn)
            : lexicalTokens(ctx, lane, judgment.fn);
        for (const sample of given) {
          samples++;
          tokens += cost ?? 0;
          if (sample.outcome === 'correct') correct++;
          else if (sample.outcome === 'unknown') unknown++;
          else wrong++;
        }
        const other = qaIndex.byQuestion.get(question)?.get(reference);
        if (!isReference && other) {
          const delta = correctRate(judgment) - correctRate(other);
          if (delta > 1e-9) better++;
          else if (delta < -1e-9) worse++;
        }
      }
      const comparable = !isReference && qaIndex.lanesWithQa.includes(reference);
      qa = {
        questions: qaIndex.common.length,
        samples,
        correct,
        unknown,
        wrong,
        tokens_per_correct: correct > 0 ? tokens / correct : null,
        vs_reference: comparable ? { better, worse, sign_p: signTest(better, worse) } : null,
      };
    }

    const timedBinaries = [...new Set(tierFns.map((fn) => fn.binary))];
    const timings = timedBinaries.flatMap((binary) => {
      const timing = run.binaries[binary];
      return timing ? [timing] : [];
    });
    const times = paired.flatMap((fn) => {
      const ms = run.functions[fn.id]?.ms;
      return typeof ms === 'number' ? [ms] : [];
    });

    return {
      lane,
      is_reference: isReference,
      coverage: {
        total: tierFns.length,
        with_text: states.filter((result) => result?.text_file).length,
        complete: count('complete'),
        partial: count('partial'),
        failed: count('failed'),
        not_found: count('not_found'),
        absent: states.filter((result) => !result).length,
      },
      lexical: {
        sum: paired.reduce((sum, fn) => sum + (lexicalOf(lane, fn.id) ?? 0), 0),
        ratio: ratioEstimate(ctx, paired, lane, lexicalOf, true),
      },
      claude: {
        sum:
          tokenSet.length === 0
            ? null
            : tokenSet.reduce((sum, fn) => sum + (claudeOf(lane, fn.id) ?? 0), 0),
        ratio: judgments ? ratioEstimate(ctx, tokenSet, lane, claudeOf, true) : null,
      },
      readability,
      comprehension:
        comp.length === 0
          ? null
          : {
              n: comp.length,
              coverage: meanOrNull(
                comp.flatMap((judgment) => (judgment.coverage === null ? [] : [judgment.coverage])),
              ),
              wrong_per_function: meanOrNull(
                comp.flatMap((judgment) => (judgment.wrong === null ? [] : [judgment.wrong])),
              ),
              coverage_vs_reference: isReference
                ? null
                : (() => {
                    const own = ctx.comprehension.get(lane);
                    const ref = ctx.comprehension.get(reference);
                    const diffs = paired.flatMap((fn) => {
                      const a = own?.get(fn.id)?.coverage;
                      const b = ref?.get(fn.id)?.coverage;
                      return a === null || a === undefined || b === null || b === undefined
                        ? []
                        : [a - b];
                    });
                    return diffs.length === 0
                      ? null
                      : estimateOf(bootstrapCi(diffs, mean, { seed: DEFAULT_SEED }), diffs.length);
                  })(),
            },
      qa,
      speed: {
        cold_ms:
          timings.length === 0 ? null : timings.reduce((sum, timing) => sum + timing.cold_ms, 0),
        binaries: timings.length,
        binaries_missing:
          lane === 'source' || run.kind === 'source' ? 0 : timedBinaries.length - timings.length,
        median_ms: times.length === 0 ? null : finite(median(times)),
        p90_ms: times.length === 0 ? null : finite(quantile(times, 0.9)),
        n: times.length,
      },
    };
  });

  // Section 3: readability by dimension per judged pair.
  const readabilityPairs: ReadabilityPair[] = [];
  const seenPairs = new Set<string>();
  for (const judgment of judgments?.readability ?? []) {
    const key = `${judgment.a}\u0000${judgment.b}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    const bothCompared = lanes.includes(judgment.a) && lanes.includes(judgment.b);
    const allowed = bothCompared ? pairedIds : tierIds;
    const status: Record<string, number> = {};
    for (const item of judgments?.readability ?? []) {
      if (item.a !== judgment.a || item.b !== judgment.b || !allowed.has(item.fn)) continue;
      status[item.status] = (status[item.status] ?? 0) + 1;
    }
    const scores = [...pairScores(ctx, judgment.a, judgment.b, allowed).values()].filter(
      (item) => item.status === 'judged' || item.status === 'identical',
    );
    const dimensions = {} as Record<Dimension, { score: Estimate; consistency: number | null }>;
    for (const dimension of DIMENSIONS) {
      const values = scores.map((item) => item.score[dimension]);
      const checked = scores.flatMap((item) =>
        item.status === 'judged' && item.consistent ? [item.consistent[dimension]] : [],
      );
      dimensions[dimension] = {
        score: estimateOf(bootstrapCi(values, mean, { seed: DEFAULT_SEED }), values.length),
        consistency: checked.length === 0 ? null : checked.filter(Boolean).length / checked.length,
      };
    }
    readabilityPairs.push({
      a: judgment.a,
      b: judgment.b,
      summary: summarizeReadability(scores, true),
      dimensions,
      status,
    });
  }
  let anchor: Report['anchor'] = null;
  const anchorPair = readabilityPairs.find((pair) => pair.a === 'source' && pair.b === reference);
  if (anchorPair) {
    const score = anchorPair.summary.overall.value;
    anchor = {
      score,
      warning:
        score !== null && score < 0.7
          ? `WARNING: judge sanity check failed: source vs ${reference} overall score is ${score.toFixed(3)} (< 0.7); the judge does not clearly prefer the original source, so readability results are suspect.`
          : null,
    };
  }

  // Section 4: breakdowns.
  const attributes: {
    by: string;
    value: (fn: CorpusFunction) => string;
    order?: readonly string[];
  }[] = [
    { by: 'group', value: (fn) => binaries.get(fn.binary)?.group ?? '?' },
    { by: 'format', value: (fn) => binaries.get(fn.binary)?.format ?? '?' },
    { by: 'opt', value: (fn) => binaries.get(fn.binary)?.opt ?? '?' },
    { by: 'stripped', value: (fn) => (binaries.get(fn.binary)?.stripped ? 'stripped' : 'symbols') },
    { by: 'size', value: (fn) => fn.size, order: SIZE_ORDER },
  ];
  const breakdowns: Breakdown[] = attributes.map(({ by, value, order }) => {
    const values = [...new Set(paired.map(value))].sort((a, b) =>
      order ? order.indexOf(a) - order.indexOf(b) : a.localeCompare(b),
    );
    const rows = values.map((label): BreakdownRow => {
      const fns = paired.filter((fn) => value(fn) === label);
      const ids = new Set(fns.map((fn) => fn.id));
      const perLane: Record<string, BreakdownRow['lanes'][string]> = {};
      for (const lane of lanes) {
        const scores =
          lane === reference ? null : [...pairScores(ctx, lane, reference, ids).values()];
        const comp = comprehensionOf(ctx, lane, fns);
        perLane[lane] = {
          lexical_ratio: ratioEstimate(ctx, fns, lane, lexicalOf, false)?.value ?? null,
          readability: scores ? meanOrNull(scores.map((item) => item.score.overall)) : null,
          readability_n: scores?.length ?? 0,
          coverage: meanOrNull(
            comp.flatMap((judgment) => (judgment.coverage === null ? [] : [judgment.coverage])),
          ),
        };
      }
      return { value: label, n: fns.length, lanes: perLane };
    });
    return { by, rows };
  });

  // Section 5: static metrics.
  const metricTotals = lanes.map((lane) =>
    totalsOf(
      lane,
      paired.flatMap((fn) => {
        const found = metrics.get(lane)?.get(fn.id);
        return found ? [found] : [];
      }),
    ),
  );

  // Section 6: QA.
  const qaRows: QaQuestionRow[] = qaIndex.common.map((question) => {
    const byLane = qaIndex.byQuestion.get(question);
    const rates: Record<string, number | null> = {};
    for (const lane of qaIndex.lanesWithQa) {
      const judgment = byLane?.get(lane);
      rates[lane] = judgment ? correctRate(judgment) : null;
    }
    const fn = [...(byLane?.values() ?? [])][0]?.fn ?? '';
    return { question, fn, rates };
  });
  const differing = qaRows.filter((row) => {
    const rates = Object.values(row.rates).filter((rate): rate is number => rate !== null);
    return rates.some((rate) => Math.abs(rate - (rates[0] ?? 0)) > 1e-9);
  });

  // Section 7: worst functions for the first non-reference lane.
  const focus = lanes.find((lane) => lane !== reference) ?? null;
  let worst: WorstSection | null = null;
  if (focus) {
    const focusPairs = pairScores(ctx, focus, reference, pairedIds);
    const tokenRatios = paired.flatMap((fn): WorstFunction[] => {
      const top = lexicalOf(focus, fn.id);
      const bottom = lexicalOf(reference, fn.id);
      if (!top || !bottom) return [];
      const claudeTop = claudeOf(focus, fn.id);
      const claudeBottom = claudeOf(reference, fn.id);
      return [
        {
          fn: fn.id,
          lane_tokens: top,
          reference_tokens: bottom,
          ratio: top / bottom,
          claude_ratio: claudeTop && claudeBottom ? claudeTop / claudeBottom : null,
        },
      ];
    });
    worst = {
      lane: focus,
      token_ratio: tokenRatios.sort((a, b) => b.ratio - a.ratio).slice(0, 10),
      readability_losses: [...focusPairs.values()]
        .filter((item) => item.score.overall < 0.5)
        .sort((a, b) => a.score.overall - b.score.overall || a.fn.localeCompare(b.fn))
        .slice(0, 10)
        .map((item) => ({ fn: item.fn, score: item.score.overall, reasons: item.reasons })),
      wrong_claims: comprehensionOf(ctx, focus, paired)
        .filter((judgment) => (judgment.wrong ?? 0) > 0)
        .sort((a, b) => (b.wrong ?? 0) - (a.wrong ?? 0) || a.fn.localeCompare(b.fn))
        .slice(0, 10)
        .map((judgment) => ({
          fn: judgment.fn,
          wrong: judgment.wrong ?? 0,
          coverage: judgment.coverage,
          claims: judgment.wrong_claims,
        })),
    };
  }

  // Section 8: speed.
  const binarySpeed: BinarySpeed[] = [];
  const loadWarnings: string[] = [];
  const determinism: { lane: string; fn: string }[] = [];
  const laneWork: LaneWork[] = [];
  const tierBinaries = [...new Set(tierFns.map((fn) => fn.binary))];
  for (const lane of lanes) {
    const run = runs.get(lane) as LaneRun;
    for (const binary of tierBinaries) {
      const timing = run.binaries[binary];
      if (timing)
        binarySpeed.push({
          binary,
          lane,
          cold_ms: timing.cold_ms,
          import_ms: timing.import_ms,
          analysis_ms: timing.analysis_ms,
          decompile_ms_total: timing.decompile_ms_total,
        });
    }
    const load = run.host.loadavg_start[0];
    if (load !== undefined && load > run.host.cores / 2)
      loadWarnings.push(
        `Lane ${lane} started with load average ${load.toFixed(2)} on ${run.host.cores} cores (> cores/2): its timings are inflated.`,
      );
    if (run.kind !== 'source' && run.jobs > 1)
      loadWarnings.push(`Lane ${lane} ran with jobs=${run.jobs}: its timings are not comparable.`);
    for (const fn of tierFns)
      if (run.functions[fn.id]?.deterministic === false) determinism.push({ lane, fn: fn.id });
    const rows: WorkRow[] = [];
    for (const fn of tierFns) {
      const result = run.functions[fn.id];
      if (result?.work)
        rows.push({
          fn: fn.id,
          consumed: result.work.consumed,
          limit: result.work.limit,
          state: result.state,
        });
    }
    if (rows.length > 0) {
      rows.sort((a, b) => b.consumed - a.consumed || a.fn.localeCompare(b.fn));
      laneWork.push({
        lane,
        recorded: rows.length,
        unrecorded: tierFns.length - rows.length,
        functions: rows,
        above_80_percent: rows.filter((row) => row.consumed > 0.8 * row.limit),
      });
    }
  }

  // Section 9: warnings from judgments.
  if (!judgments) {
    warnings.push(
      'No judgments were supplied: token counts, readability, comprehension and QA rows are not available.',
    );
  } else {
    const missing = (items: readonly { status: string; fn: string }[]): number =>
      items.filter(
        (item) => (item.status === 'missing' || item.status === 'error') && pairedIds.has(item.fn),
      ).length;
    const note = (task: string, count: number): void => {
      if (count > 0)
        warnings.push(
          `${count} ${task} judgment(s) are missing or failed; run bench judge to complete them.`,
        );
    };
    note('readability', missing(judgments.readability));
    note('comprehension', missing(judgments.comprehension));
    const laneSet = new Set(lanes);
    note('QA', missing(judgments.qa.filter((item) => laneSet.has(item.lane))));
    const uncounted = paired.length - tokenSet.length;
    if (uncounted > 0)
      warnings.push(
        `${uncounted} paired function(s) lack Claude token counts for some lane; Claude token sums cover ${tokenSet.length} of ${paired.length}.`,
      );
    for (const lane of qaIndex.lanesWithQa.length > 0
      ? lanes.filter((l) => !qaIndex.lanesWithQa.includes(l) && runs.get(l)?.kind !== 'source')
      : [])
      warnings.push(`Lane ${lane} has no QA judgments.`);
    if (qaIndex.common.length > 0 && qaBasis === 'lexical')
      warnings.push(
        'QA tokens per correct answer use lexical tokens: Claude token counts are missing for some answered texts.',
      );
  }
  if (paired.length < tierFns.length)
    warnings.push(
      `The paired set holds ${paired.length} of ${tierFns.length} tier functions: some lane has no text for the others.`,
    );
  if (anchor?.warning) warnings.push(anchor.warning);

  const perFunction: PerFunction[] = paired.map((fn) => {
    const lanesOut: Record<string, PerFunction['lanes'][string]> = {};
    for (const lane of lanes) {
      const result = runs.get(lane)?.functions[fn.id];
      const scores =
        lane === reference ? null : pairScores(ctx, lane, reference, pairedIds).get(fn.id);
      lanesOut[lane] = {
        state: result?.state ?? 'absent',
        lexical_tokens: lexicalOf(lane, fn.id) ?? 0,
        claude_tokens: claudeOf(lane, fn.id),
        ms: result?.ms ?? null,
        work: result?.work?.consumed ?? null,
        readability: scores?.score.overall ?? null,
        coverage: ctx.comprehension.get(lane)?.get(fn.id)?.coverage ?? null,
      };
    }
    return { id: fn.id, binary: fn.binary, size: fn.size, lanes: lanesOut };
  });

  return {
    schema: 'odbench-report/1',
    generated: new Date().toISOString(),
    tier,
    corpus_sha256: opts.corpusSha256,
    lanes,
    reference,
    tier_functions: tierFns.length,
    paired_functions: paired.length,
    header: {
      lanes: lanes.map((lane): LaneHeader => {
        const run = runs.get(lane) as LaneRun;
        return {
          lane,
          kind: run.kind,
          tool: run.tool.name,
          version: run.tool.version,
          path: run.tool.path,
          git_head: run.tool.git_head ?? null,
          dirty: run.tool.dirty ?? null,
          options: run.tool.options ?? {},
          tier: run.tier,
          started: run.started,
          repeat: run.repeat,
          jobs: run.jobs,
          corpus_sha256: run.corpus_sha256,
          host: run.host,
        };
      }),
      judge: judgments
        ? {
            model: judgments.model,
            readability: judgments.readability.length,
            comprehension: judgments.comprehension.length,
            qa: judgments.qa.length,
            tokens: judgments.tokens.length,
          }
        : null,
    },
    scorecard,
    qa_token_basis: qaBasis,
    readability: readabilityPairs,
    anchor,
    breakdowns,
    metrics: metricTotals,
    qa: {
      common_questions: qaIndex.common.length,
      lanes: qaIndex.lanesWithQa,
      differing,
    },
    worst,
    speed: {
      binaries: binarySpeed,
      load_warnings: loadWarnings,
      determinism_failures: determinism,
      work: laneWork,
    },
    warnings,
    per_function: perFunction,
  };
}

// ---- rendering ---------------------------------------------------------------------------------

const DASH = '—';

function fmtInt(value: number | null): string {
  return value === null ? DASH : Math.round(value).toLocaleString('en-US');
}

/** Fixed decimals with thousands separators. */
function fmtFixed(value: number | null, digits: number): string {
  return value === null
    ? DASH
    : value.toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
}

/** Compact: integers plain, otherwise 3 decimals below 10, 2 below 100, 1 above. */
function fmtNum(value: number | null): string {
  if (value === null) return DASH;
  if (Number.isInteger(value)) return fmtInt(value);
  const magnitude = Math.abs(value);
  return fmtFixed(value, magnitude >= 100 ? 1 : magnitude >= 10 ? 2 : 3);
}

function fmtCi(estimate: Estimate | null, digits = 3): string {
  if (!estimate || estimate.value === null) return DASH;
  const range =
    estimate.lo === null || estimate.hi === null
      ? ''
      : ` [${fmtFixed(estimate.lo, digits)}, ${fmtFixed(estimate.hi, digits)}]`;
  return `${fmtFixed(estimate.value, digits)}${range}`;
}

function fmtP(value: number | null): string {
  if (value === null) return DASH;
  return value < 0.001 ? '<0.001' : value.toFixed(3);
}

function fmtMs(value: number | null): string {
  if (value === null) return DASH;
  if (value < 1000) return `${fmtFixed(value, value < 10 ? 2 : 0)} ms`;
  if (value < 60_000) return `${fmtFixed(value / 1000, 2)} s`;
  const seconds = Math.round(value / 1000);
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

function fmtPct(value: number | null): string {
  return value === null ? DASH : `${(value * 100).toFixed(0)}%`;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

/** GitHub table; the first column is left-aligned, the others right-aligned unless `left` names them. */
function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  left: readonly number[] = [],
): string {
  const align = header.map((_, index) => (index === 0 || left.includes(index) ? ':---' : '---:'));
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  return [line(header.map(cell)), line(align), ...rows.map((row) => line(row.map(cell)))].join(
    '\n',
  );
}

function scorecardRows(report: Report): { header: string[]; rows: string[][] } {
  const cards = report.scorecard;
  const header = [
    'metric',
    ...cards.map((card) => (card.is_reference ? `${card.lane} (ref)` : card.lane)),
  ];
  const row = (label: string, value: (card: LaneScore) => string): string[] => [
    label,
    ...cards.map(value),
  ];
  const fullTier = cards[0]?.coverage.total ?? 0;
  const rows: string[][] = [
    row(`functions with text (of ${fullTier})`, (card) => fmtInt(card.coverage.with_text)),
    row('failed', (card) => fmtInt(card.coverage.failed)),
    row('not_found', (card) => fmtInt(card.coverage.not_found)),
    row('partial', (card) => fmtInt(card.coverage.partial)),
    row(`lexical tokens (paired sum, ${report.paired_functions} functions)`, (card) =>
      fmtInt(card.lexical.sum),
    ),
    row(`lexical token ratio vs ${report.reference} (geomean, 95% CI)`, (card) =>
      fmtCi(card.lexical.ratio),
    ),
    row('Claude tokens (paired sum)', (card) => fmtInt(card.claude.sum)),
    row(`Claude token ratio vs ${report.reference} (geomean, 95% CI)`, (card) =>
      fmtCi(card.claude.ratio),
    ),
    row(`readability vs ${report.reference} (overall, 95% CI)`, (card) =>
      fmtCi(card.readability?.overall ?? null),
    ),
    row('readability strict wins / ties / losses', (card) =>
      card.readability
        ? `${card.readability.wins} / ${card.readability.ties} / ${card.readability.losses}`
        : DASH,
    ),
    row('readability sign test p', (card) => fmtP(card.readability?.sign_p ?? null)),
    row('comprehension coverage (0-4, mean)', (card) =>
      fmtNum(card.comprehension?.coverage ?? null),
    ),
    row('comprehension wrong claims per function', (card) =>
      fmtNum(card.comprehension?.wrong_per_function ?? null),
    ),
    row(`comprehension coverage − ${report.reference} (paired, 95% CI)`, (card) =>
      fmtCi(card.comprehension?.coverage_vs_reference ?? null),
    ),
    row('QA correct / unknown / wrong (samples)', (card) =>
      card.qa ? `${card.qa.correct} / ${card.qa.unknown} / ${card.qa.wrong}` : DASH,
    ),
    row('QA correct rate', (card) =>
      card.qa && card.qa.samples > 0 ? fmtPct(card.qa.correct / card.qa.samples) : DASH,
    ),
    row(`QA tokens per correct answer (${report.qa_token_basis ?? DASH})`, (card) =>
      fmtNum(card.qa?.tokens_per_correct ?? null),
    ),
    row(`QA questions better / worse than ${report.reference} (sign p)`, (card) =>
      card.qa?.vs_reference
        ? `${card.qa.vs_reference.better} / ${card.qa.vs_reference.worse} (p=${fmtP(card.qa.vs_reference.sign_p)})`
        : DASH,
    ),
    row('cold time, all binaries', (card) => fmtMs(card.speed.cold_ms)),
    row('per-function ms: median / p90 (paired)', (card) =>
      card.speed.n === 0 ? DASH : `${fmtMs(card.speed.median_ms)} / ${fmtMs(card.speed.p90_ms)}`,
    ),
  ];
  return { header, rows };
}

export function renderScorecard(report: Report): string {
  const { header, rows } = scorecardRows(report);
  return table(header, rows);
}

export function renderMarkdown(report: Report): string {
  const out: string[] = [];
  const push = (...lines: string[]): void => {
    out.push(...lines, '');
  };
  const lanesOther = report.lanes.filter((lane) => lane !== report.reference);

  push(`# odbench report: ${lanesOther.join(', ') || report.reference} vs ${report.reference}`);

  // 1. Header
  push('## 1. Header');
  push(
    `- Date: ${report.generated}`,
    `- Tier: ${report.tier} (${report.tier_functions} functions, ${report.paired_functions} paired across all lanes)`,
    `- Corpus sha256: \`${report.corpus_sha256.slice(0, 12)}\``,
    `- Reference lane: ${report.reference}`,
    report.header.judge
      ? `- Judge model: ${report.header.judge.model}; judgments read from cache: readability ${report.header.judge.readability}, comprehension ${report.header.judge.comprehension}, QA ${report.header.judge.qa}, token counts ${report.header.judge.tokens}`
      : '- Judge: no judgments',
  );
  push(
    table(
      ['lane', 'kind', 'tool', 'version / git', 'options', 'tier', 'repeat', 'jobs', 'started'],
      report.header.lanes.map((lane) => [
        lane.lane,
        lane.kind,
        lane.tool,
        [
          lane.version,
          lane.git_head ? `${lane.git_head.slice(0, 10)}${lane.dirty ? '+dirty' : ''}` : null,
        ]
          .filter(Boolean)
          .join(' ') || DASH,
        Object.keys(lane.options).length === 0 ? DASH : `\`${JSON.stringify(lane.options)}\``,
        lane.tier,
        String(lane.repeat),
        String(lane.jobs),
        lane.started,
      ]),
      [1, 2, 3, 4, 5, 8],
    ),
  );

  // 2. Scorecard
  push('## 2. Scorecard');
  push(renderScorecard(report));
  push(
    `Ratios are per-function paired geometric means against ${report.reference}; below 1 is better for token counts. Readability is the mean overall score of the lane against ${report.reference} over both presentation orders (1 = always preferred, 0.5 = even); wins/losses are strict (both orders agree). QA rows cover the ${report.qa.common_questions} questions answered by every lane with QA judgments.`,
  );

  // 3. Readability by dimension
  push('## 3. Readability by dimension');
  if (report.readability.length === 0) {
    push('No readability judgments.');
  } else {
    for (const pair of report.readability) {
      const status = Object.entries(pair.status)
        .map(([name, count]) => `${name} ${count}`)
        .join(', ');
      push(
        `### ${pair.a} vs ${pair.b}`,
        `Score is for ${pair.a}: ${fmtCi(pair.summary.overall)} overall over ${pair.summary.n} functions; strict wins / ties / losses ${pair.summary.wins} / ${pair.summary.ties} / ${pair.summary.losses}, sign test p = ${fmtP(pair.summary.sign_p)}. Judgments: ${status || 'none'}.`,
      );
      push(
        table(
          ['dimension', `score (${pair.a})`, 'consistency'],
          DIMENSIONS.map((dimension) => [
            dimension,
            fmtCi(pair.dimensions[dimension].score),
            fmtPct(pair.dimensions[dimension].consistency),
          ]),
        ),
      );
    }
    if (report.anchor?.warning) push(report.anchor.warning);
    else if (report.anchor)
      push(
        `Judge sanity: source vs ${report.reference} overall score ${fmtFixed(report.anchor.score, 3)} (>= 0.7).`,
      );
    else push(`Judge sanity: the anchor pair source vs ${report.reference} was not judged.`);
  }

  // 4. Breakdowns
  push('## 4. Breakdowns');
  push(
    `Per group of paired functions: lexical token ratio and readability overall are against ${report.reference}; \`cov\` is mean comprehension coverage (0-4).`,
  );
  for (const breakdown of report.breakdowns) {
    const header = ['by ' + breakdown.by, 'n'];
    for (const lane of report.lanes) {
      if (lane !== report.reference) header.push(`${lane} tok×`, `${lane} read`);
      header.push(`${lane} cov`);
    }
    push(
      table(
        header,
        breakdown.rows.map((row) => {
          const cells = [row.value, String(row.n)];
          for (const lane of report.lanes) {
            const data = row.lanes[lane];
            if (lane !== report.reference)
              cells.push(
                fmtFixed(data?.lexical_ratio ?? null, 3),
                fmtFixed(data?.readability ?? null, 3),
              );
            cells.push(fmtNum(data?.coverage ?? null));
          }
          return cells;
        }),
      ),
    );
  }

  // 5. Static metrics
  push('## 5. Static metrics');
  push(
    `Totals over the ${report.paired_functions} paired functions (max / mean for nesting; ratio of totals for the placeholder ratio).`,
  );
  const metricRows: string[][] = SCALAR_METRICS.map(({ key, label, aggregate }) => [
    aggregate === 'max' ? `${label} (max)` : label,
    ...report.metrics.map((totals) =>
      aggregate === 'ratio'
        ? fmtFixed(totals.scalars[key] ?? 0, 3)
        : fmtInt(totals.scalars[key] ?? 0),
    ),
  ]);
  metricRows.push([
    'max nesting (mean per function)',
    ...report.metrics.map((totals) => fmtFixed(totals.mean_nesting, 2)),
  ]);
  push(table(['counter', ...report.lanes], metricRows));
  const shownArtifacts = ARTIFACT_PATTERNS.filter((pattern) =>
    report.metrics.some((totals) => (totals.artifacts[pattern.name] ?? 0) > 0),
  );
  push(
    shownArtifacts.length === 0
      ? 'No decompiler artifacts in any lane.'
      : table(
          ['artifact', 'tool', ...report.lanes],
          shownArtifacts.map((pattern) => [
            pattern.name,
            pattern.tool,
            ...report.metrics.map((totals) => fmtInt(totals.artifacts[pattern.name] ?? 0)),
          ]),
          [1],
        ),
  );

  // 6. QA
  push('## 6. QA');
  if (report.qa.common_questions === 0) {
    push('No QA judgments.');
  } else {
    push(
      `${report.qa.common_questions} questions answered by every lane with QA (${report.qa.lanes.join(', ')}); ${report.qa.differing.length} where lanes differ. Correct rate = share of samples scored correct.`,
    );
    if (report.qa.differing.length > 0)
      push(
        table(
          ['question', 'function', ...report.qa.lanes],
          report.qa.differing.map((row) => [
            row.question,
            row.fn,
            ...report.qa.lanes.map((lane) => fmtFixed(row.rates[lane] ?? null, 2)),
          ]),
          [1],
        ),
      );
  }

  // 7. Worst functions
  push('## 7. Worst functions');
  if (!report.worst) {
    push('Only the reference lane was compared.');
  } else {
    const worst = report.worst;
    push(`### Highest token ratio: ${worst.lane} vs ${report.reference}`);
    push(
      worst.token_ratio.length === 0
        ? 'None.'
        : table(
            [
              'function',
              `${worst.lane} tokens`,
              `${report.reference} tokens`,
              'ratio',
              'Claude ratio',
            ],
            worst.token_ratio.map((item) => [
              item.fn,
              fmtInt(item.lane_tokens),
              fmtInt(item.reference_tokens),
              fmtFixed(item.ratio, 3),
              fmtFixed(item.claude_ratio, 3),
            ]),
          ),
    );
    push(`### Readability losses: ${worst.lane} vs ${report.reference}`);
    push(
      worst.readability_losses.length === 0
        ? 'None (no function with an overall score below 0.5).'
        : table(
            ['function', 'score', 'judge reasons'],
            worst.readability_losses.map((item) => [
              item.fn,
              fmtFixed(item.score, 2),
              item.reasons.join(' / ') || DASH,
            ]),
            [2],
          ),
    );
    push(`### Most wrong comprehension claims: ${worst.lane}`);
    push(
      worst.wrong_claims.length === 0
        ? 'None.'
        : table(
            ['function', 'wrong', 'coverage', 'claims'],
            worst.wrong_claims.map((item) => [
              item.fn,
              String(item.wrong),
              fmtNum(item.coverage),
              item.claims.join('; ') || DASH,
            ]),
            [3],
          ),
    );
  }

  // 8. Speed
  push('## 8. Speed');
  push(
    report.speed.binaries.length === 0
      ? 'No timings recorded.'
      : table(
          ['binary', 'lane', 'cold', 'import', 'analysis', 'decompile total'],
          report.speed.binaries.map((item) => [
            item.binary,
            item.lane,
            fmtMs(item.cold_ms),
            fmtMs(item.import_ms),
            fmtMs(item.analysis_ms),
            fmtMs(item.decompile_ms_total),
          ]),
          [1],
        ),
  );
  for (const warning of report.speed.load_warnings) push(`WARNING: ${warning}`);
  const repeated = report.header.lanes.filter((lane) => lane.kind === 'od' && lane.repeat > 1);
  push(
    report.speed.determinism_failures.length > 0
      ? `Determinism failures (repeats printed different text): ${report.speed.determinism_failures.map((item) => `${item.lane}: ${item.fn}`).join('; ')}.`
      : repeated.length === 0
        ? 'Determinism: not checked (run od with --repeat 2 or more).'
        : `Determinism: every function printed identical text across repeats (${repeated.map((lane) => `${lane.lane} ×${lane.repeat}`).join(', ')}).`,
  );
  if (report.speed.work.length === 0)
    push('Counted work: no lane recorded it (re-run the od lane with a build that reports it).');
  for (const work of report.speed.work) {
    const limit = Math.max(...work.functions.map((row) => row.limit));
    push(
      `Counted work, ${work.lane}: ${work.recorded} function(s) recorded${work.unrecorded > 0 ? `, ${work.unrecorded} without a result` : ''}; limit ${fmtInt(limit)}; ${work.above_80_percent.length} above 80% of their limit. Largest:`,
    );
    const pct = (row: WorkRow): string => fmtPct(row.consumed / row.limit);
    push(
      table(
        ['function', 'work', 'of limit', 'state'],
        work.functions
          .slice(0, 10)
          .map((row) => [row.fn, fmtInt(row.consumed), pct(row), row.state]),
        [3],
      ),
    );
    if (work.above_80_percent.length > 0)
      push(
        table(
          ['function above 80%', 'work', 'of limit', 'state'],
          work.above_80_percent.map((row) => [row.fn, fmtInt(row.consumed), pct(row), row.state]),
          [3],
        ),
      );
  }

  // 9. Warnings
  push('## 9. Warnings');
  push(
    ...(report.warnings.length === 0
      ? ['None.']
      : report.warnings.map((warning) => `- ${warning}`)),
  );

  return `${out.join('\n').trimEnd()}\n`;
}

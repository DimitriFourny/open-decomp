/**
 * Judge tasks over a corpus tier: `tokens`, `readability`, `comprehension`, `qa`.
 * `runJudge` plans every call, serves cache hits and makes the misses; `collectJudgments` rebuilds
 * the same plan and reads only the cache. Both share the unit code below, so a report built from
 * the cache sees exactly the judgments a run produced.
 */
import { z } from 'zod';
import { loadQuestions } from '../../llm-tasks/questions.js';
import type { Question, QuestionSet } from '../../llm-tasks/questions.js';
import { scoreAnswer } from '../../llm-tasks/score.js';
import { tierFunctions } from '../corpus.js';
import { sourceDefinition } from '../sources.js';
import { readLane, readText } from '../store.js';
import { DIMENSIONS, TASKS, sha256 } from '../types.js';
import type {
  CollectedJudgments,
  ComprehensionJudgment,
  Corpus,
  CorpusFunction,
  Dimension,
  JudgeOptions,
  JudgeRunSummary,
  JudgmentStatus,
  LaneRun,
  OrderVerdicts,
  QaJudgment,
  QaOutcome,
  ReadabilityJudgment,
  TaskName,
  TokenCount,
} from '../types.js';
import { RETRY_DELAYS_MS, createBackend, extractJson, runPool, withRetries } from './backend.js';
import type { AskReply, Backend } from './backend.js';
import { cacheKey, readRecord, writeRecord } from './cache.js';
import type { JudgeRecord } from './cache.js';
import {
  EXPLAIN_SYSTEM,
  GRADE_SYSTEM,
  QA_SYSTEM,
  READABILITY_SYSTEM,
  TOKENS_BASELINE_USER,
  TOKENS_SYSTEM,
  explainUser,
  gradeUser,
  normalizeForJudge,
  qaUser,
  readabilityUser,
} from './prompts.js';

/** Pairs whose two normalized texts together exceed this many bytes are not judged. */
export const READABILITY_MAX_BYTES = 150_000;
/** Lane texts above this many bytes are not explained. */
export const COMPREHENSION_MAX_BYTES = 100_000;
/** Prompt bytes per Claude token assumed by `dryRun` estimates (measured on decompiler C and the judge prompts: about 2.2). */
export const ESTIMATE_BYTES_PER_TOKEN = 2;
/** Prompt tokens every `omp` call adds (its own system prompt), measured as the usage of an empty-prompt call. */
export const OMP_CALL_OVERHEAD_TOKENS = 270;
/** Cache reads of `collectJudgments` run this wide. */
const COLLECT_CONCURRENCY = 16;
/** Stand-in for a not-yet-known explanation when `dryRun` sizes a grade call. */
const ESTIMATED_EXPLANATION = 'x'.repeat(1200);

// ---------------------------------------------------------------------------------------------
// readability: pure order mapping and scoring

const verdictSchema = z.preprocess(
  (value) =>
    typeof value === 'number'
      ? String(value)
      : typeof value === 'string'
        ? value.trim().toLowerCase()
        : value,
  z.enum(['1', '2', 'tie']),
);

export const readabilitySchema = z.object({
  control_flow: verdictSchema,
  data: verdictSchema,
  expressions: verdictSchema,
  noise: verdictSchema,
  overall: verdictSchema,
  reason: z.string().default(''),
});
export type ReadabilityReply = z.output<typeof readabilitySchema>;

export function perDimension<T>(value: (dimension: Dimension) => T): Record<Dimension, T> {
  return Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, value(dimension)])) as Record<
    Dimension,
    T
  >;
}

/**
 * Maps one reply's `"1"`/`"2"`/`"tie"` back to lanes. Order 0 showed lane `a` as Listing 1, order 1
 * showed lane `b` as Listing 1.
 */
export function mapOrderVerdicts(
  order: 0 | 1,
  reply: Readonly<Record<Dimension, '1' | '2' | 'tie'>>,
): OrderVerdicts {
  return perDimension((dimension) => {
    const verdict = reply[dimension];
    if (verdict === 'tie') return 'tie';
    return (verdict === '1') === (order === 0) ? 'a' : 'b';
  });
}

/** Lane `a`'s score per dimension (mean over the orders of win 1 / tie 0.5 / loss 0) and consistency. */
export function scoreOrders(orders: readonly [OrderVerdicts, OrderVerdicts]): {
  score: Record<Dimension, number>;
  consistent: Record<Dimension, boolean>;
} {
  const points = { a: 1, tie: 0.5, b: 0 } as const;
  return {
    score: perDimension((d) => (points[orders[0][d]] + points[orders[1][d]]) / 2),
    consistent: perDimension((d) => orders[0][d] === orders[1][d]),
  };
}

/** Rewrites the judge's "Listing 1"/"Listing 2" in a reason to the lane names shown in that order. */
export function laneReason(reason: string, order: 0 | 1, a: string, b: string): string {
  const [first, second] = order === 0 ? [a, b] : [b, a];
  return reason
    .replace(/\blisting\s*([12])\b/gi, (_, n: string) => (n === '1' ? first : second))
    .trim();
}

// ---------------------------------------------------------------------------------------------
// comprehension schemas

const prose = z.union([z.string(), z.array(z.string())]);
export const explainSchema = z.object({
  purpose: z.string(),
  inputs: prose,
  output: prose,
  effects: prose,
  details: z.array(z.string()),
});
/** `coverage` and `wrong` are the measures; Haiku sometimes drops an informational count. */
export const gradeSchema = z.object({
  coverage: z.number().min(0).max(4),
  wrong: z.number().int().min(0),
  correct: z.number().int().min(0).optional(),
  unverifiable: z.number().int().min(0).optional(),
  wrong_claims: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------------------------
// calls: cache, backend, retries

interface Reply<T> {
  readonly json: boolean;
  /** JSON replies: whether a candidate object is the answer (a reply may quote another object first). */
  readonly accepts?: (value: unknown) => boolean;
  decode(text: string, parsed: unknown): T;
}

function jsonReply<T>(schema: z.ZodType<T>): Reply<T> {
  return {
    json: true,
    accepts: (value) => schema.safeParse(value).success,
    decode(text, parsed) {
      if (parsed === null)
        throw new Error(
          `no JSON object in the reply (${text.length} chars: ${JSON.stringify(`${text.slice(0, 120)}…${text.slice(-120)}`)})`,
        );
      return schema.parse(parsed);
    },
  };
}

const textReply: Reply<string> = { json: false, decode: (text) => text };

interface Call<T> {
  readonly task: TaskName;
  readonly system: string;
  readonly user: string;
  readonly sample: number;
  readonly reply: Reply<T>;
  /** Progress/failure text, e.g. `od-x:ghidra sqlite3-arm64/foo@0x… order 1`. */
  readonly label: string;
  /** Prompt-size measurement through the backend's token counter instead of a completion. */
  readonly count?: boolean;
}

type Outcome<T> =
  | { readonly kind: 'ok'; readonly record: JudgeRecord; readonly value: T }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly error: string };
type Failure = Exclude<Outcome<unknown>, { kind: 'ok' }>;

const MISSING: Outcome<never> = { kind: 'missing' };

function describeError(error: unknown): string {
  if (error instanceof z.ZodError)
    return `reply does not match the schema: ${error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')}`;
  return error instanceof Error ? error.message : String(error);
}

function decodeRecord<T>(call: Call<T>, record: JudgeRecord): Outcome<T> {
  try {
    return { kind: 'ok', record, value: call.reply.decode(record.text, record.parsed) };
  } catch (error) {
    return { kind: 'error', error: `cached reply unusable: ${describeError(error)}` };
  }
}

interface TaskStats {
  planned: number;
  cached: number;
  called: number;
  failed: number;
}

type Mode = 'run' | 'dry' | 'collect';

class Runner {
  readonly stats = new Map<TaskName, TaskStats>();
  inputTokens = 0;
  outputTokens = 0;
  cost: number | null = null;
  estimatedInputTokens = 0;
  private readonly inflight = new Map<string, Promise<Outcome<unknown>>>();
  private baselineTokens: Promise<number | null> | null = null;

  constructor(
    readonly mode: Mode,
    readonly model: string,
    private readonly backend: Backend | null,
    /** Prompt tokens the backend adds to every call; only used for `dryRun` estimates. */
    private readonly callOverheadTokens = 0,
  ) {}

  /** Whether token measurements go through a dedicated counter (`anthropic`). */
  get counts(): boolean {
    return this.backend?.countInput !== undefined;
  }

  statsFor(task: TaskName): TaskStats {
    let stats = this.stats.get(task);
    if (!stats) {
      stats = { planned: 0, cached: 0, called: 0, failed: 0 };
      this.stats.set(task, stats);
    }
    return stats;
  }

  async call<T>(call: Call<T>): Promise<Outcome<T>> {
    const key = cacheKey(call.task, this.model, call.system, call.user, call.sample);
    if (this.mode === 'collect') {
      const record = await readRecord(key);
      return record ? decodeRecord(call, record) : MISSING;
    }
    const stats = this.statsFor(call.task);
    stats.planned++;
    const pending = this.inflight.get(key);
    if (pending) {
      stats.cached++;
      return (await pending) as Outcome<T>;
    }
    const work = this.resolve(call, key, stats);
    this.inflight.set(key, work);
    return work;
  }

  /** Claude tokens of the tokens-task system prompt with the user prompt `.`; null when unknown. */
  baseline(): Promise<number | null> {
    this.baselineTokens ??= this.call({
      task: 'tokens',
      system: TOKENS_SYSTEM,
      user: TOKENS_BASELINE_USER,
      sample: 0,
      reply: textReply,
      label: 'tokens baseline',
      count: this.counts,
    }).then((outcome) => (outcome.kind === 'ok' ? (outcome.record.usage?.input ?? null) : null));
    return this.baselineTokens;
  }

  private async resolve<T>(call: Call<T>, key: string, stats: TaskStats): Promise<Outcome<T>> {
    const record = await readRecord(key);
    if (record) {
      const hit = decodeRecord(call, record);
      if (hit.kind === 'ok') {
        stats.cached++;
        return hit;
      }
    }
    if (this.mode === 'dry') {
      this.estimatedInputTokens +=
        this.callOverheadTokens +
        Math.ceil(
          (Buffer.byteLength(call.system) + Buffer.byteLength(call.user)) /
            ESTIMATE_BYTES_PER_TOKEN,
        );
      return MISSING;
    }
    stats.called++;
    const outcome = await this.execute(call, key);
    if (outcome.kind === 'error') {
      stats.failed++;
      process.stderr.write(`judge: FAILED ${call.task} ${call.label}: ${outcome.error}\n`);
    }
    return outcome;
  }

  private async execute<T>(call: Call<T>, key: string): Promise<Outcome<T>> {
    const backend = this.backend;
    if (!backend) throw new Error('judge: no backend');
    const request = { system: call.system, user: call.user, model: this.model };
    try {
      return await withRetries(
        async () => {
          const reply: AskReply =
            call.count && backend.countInput
              ? await backend.countInput(request)
              : await backend.ask(request);
          this.account(reply);
          const parsed = call.reply.json ? extractJson(reply.text, call.reply.accepts) : null;
          const value = call.reply.decode(reply.text, parsed);
          const record: JudgeRecord = {
            key,
            task: call.task,
            model: this.model,
            sample: call.sample,
            system_sha256: sha256(call.system),
            user_sha256: sha256(call.user),
            text: reply.text,
            parsed,
            usage: reply.usage,
            cost: reply.cost,
            reply_model: reply.model,
            created: new Date().toISOString(),
          };
          await writeRecord(record);
          return { kind: 'ok', record, value } as const;
        },
        RETRY_DELAYS_MS,
        (error, n) =>
          process.stderr.write(
            `judge: retry ${n + 1} ${call.task} ${call.label}: ${describeError(error)}\n`,
          ),
      );
    } catch (error) {
      return { kind: 'error', error: describeError(error) };
    }
  }

  private account(reply: AskReply): void {
    if (reply.usage) {
      this.inputTokens += reply.usage.input;
      this.outputTokens += reply.usage.output;
    }
    if (reply.cost !== null) this.cost = (this.cost ?? 0) + reply.cost;
  }
}

function failure(outcome: Failure): { status: JudgmentStatus; error?: string } {
  return outcome.kind === 'error'
    ? { status: 'error', error: outcome.error }
    : { status: 'missing' };
}

// ---------------------------------------------------------------------------------------------
// lane texts

class LaneTexts {
  private readonly runs = new Map<string, LaneRun | null>();
  private readonly texts = new Map<string, Promise<{ raw: string; text: string } | null>>();

  static async load(lanes: Iterable<string>, mustExist: boolean): Promise<LaneTexts> {
    const texts = new LaneTexts();
    for (const lane of new Set(lanes)) {
      const run = await readLane(lane);
      if (!run && mustExist) throw new Error(`lane ${lane} has no lane.json (run it first)`);
      texts.runs.set(lane, run);
    }
    return texts;
  }

  /** The lane has pseudocode for the function. */
  has(lane: string, fn: CorpusFunction): boolean {
    return Boolean(this.runs.get(lane)?.functions[fn.id]?.text_file);
  }

  kind(lane: string): LaneRun['kind'] | null {
    return this.runs.get(lane)?.kind ?? null;
  }

  /** Recorded sha256 of the raw text, when the lane manifest has one. */
  recordedSha(lane: string, fn: CorpusFunction): string | null {
    return this.runs.get(lane)?.functions[fn.id]?.sha256 ?? null;
  }

  async get(lane: string, fn: CorpusFunction): Promise<{ raw: string; text: string }> {
    const key = `${lane}\0${fn.id}`;
    let pending = this.texts.get(key);
    if (!pending) {
      const run = this.runs.get(lane);
      pending = (run ? readText(run, fn.id) : Promise.resolve(null)).then((raw) =>
        raw === null ? null : { raw, text: normalizeForJudge(raw) },
      );
      this.texts.set(key, pending);
    }
    const text = await pending;
    if (!text) throw new Error(`${lane}: no text for ${fn.id}`);
    return text;
  }
}

// ---------------------------------------------------------------------------------------------
// plan

interface PlanOptions {
  readonly tier: JudgeOptions['tier'];
  readonly tasks: readonly TaskName[];
  readonly lanes: readonly string[];
  readonly pairs: JudgeOptions['pairs'];
  readonly qaSamples: number;
  readonly comprehensionSamples: number;
}

interface Unit {
  readonly task: TaskName;
  run(): Promise<void>;
}

interface Plan {
  readonly units: readonly Unit[];
  results(): Omit<CollectedJudgments, 'model'>;
}

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

function meanOfPresent(values: readonly (number | undefined)[]): number | null {
  const present = values.filter((value) => value !== undefined);
  return present.length === 0 ? null : mean(present);
}

function sameAddress(a: string, b: string): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

async function buildPlan(
  corpus: Corpus,
  options: PlanOptions,
  runner: Runner,
  mustExist: boolean,
): Promise<Plan> {
  const wants = (task: TaskName): boolean => options.tasks.includes(task);
  const fns = tierFunctions(corpus, options.tier);
  const laneNames: string[] = [];
  if (wants('tokens') || wants('comprehension') || wants('qa')) laneNames.push(...options.lanes);
  if (wants('readability')) for (const [a, b] of options.pairs) laneNames.push(a, b);
  const texts = await LaneTexts.load(laneNames, mustExist);

  const units: Unit[] = [];
  const readability: (ReadabilityJudgment | undefined)[] = [];
  const comprehension: (ComprehensionJudgment | undefined)[] = [];
  const qa: (QaJudgment | undefined)[] = [];

  // tokens: one unit per distinct text
  const tokenEntries: { fn: CorpusFunction; lane: string; key: string }[] = [];
  const tokenResults = new Map<string, { sha: string; tokens: number | null }>();
  if (wants('tokens')) {
    const seen = new Set<string>();
    for (const lane of new Set(options.lanes))
      for (const fn of fns) {
        if (!texts.has(lane, fn)) continue;
        const key = texts.recordedSha(lane, fn) ?? `${lane}\0${fn.id}`;
        tokenEntries.push({ fn, lane, key });
        if (seen.has(key)) continue;
        seen.add(key);
        units.push({
          task: 'tokens',
          run: async () => {
            const { raw, text } = await texts.get(lane, fn);
            tokenResults.set(key, {
              sha: sha256(raw),
              tokens: await countTokens(runner, text, `${lane} ${fn.id}`),
            });
          },
        });
      }
  }

  // readability: one unit per pair and function
  if (wants('readability'))
    for (const [a, b] of options.pairs)
      for (const fn of fns) {
        if (!texts.has(a, fn) || !texts.has(b, fn)) continue;
        const slot = readability.length;
        readability.push(undefined);
        units.push({
          task: 'readability',
          run: async () => {
            readability[slot] = await judgeReadability(
              runner,
              a,
              b,
              fn,
              await texts.get(a, fn),
              await texts.get(b, fn),
            );
          },
        });
      }

  // comprehension: one unit per lane and function with a source definition
  if (wants('comprehension')) {
    const sources = new Map<string, string>();
    for (const fn of fns) {
      const source = fn.source ? await sourceDefinition(corpus, fn, true) : null;
      if (source !== null) sources.set(fn.id, source);
    }
    for (const lane of new Set(options.lanes))
      for (const fn of fns) {
        const source = sources.get(fn.id);
        if (source === undefined || !texts.has(lane, fn)) continue;
        const slot = comprehension.length;
        comprehension.push(undefined);
        units.push({
          task: 'comprehension',
          run: async () => {
            comprehension[slot] = await judgeComprehension(
              runner,
              lane,
              fn,
              (await texts.get(lane, fn)).text,
              source,
              options.comprehensionSamples,
            );
          },
        });
      }
  }

  // qa: one unit per decompiler lane and frozen question about a tier function. The questions ask
  // for compiled facts (field offsets, folded constants, flag values) that source text does not
  // show, so the source lane is not asked.
  if (wants('qa')) {
    const set = await loadQuestions();
    for (const lane of new Set(options.lanes)) {
      if (texts.kind(lane) === 'source') continue;
      for (const fn of fns) {
        if (!texts.has(lane, fn)) continue;
        for (const question of set.questions) {
          if (question.binary !== fn.binary || !sameAddress(question.address, fn.va)) continue;
          const slot = qa.length;
          qa.push(undefined);
          units.push({
            task: 'qa',
            run: async () => {
              qa[slot] = await judgeQuestion(
                runner,
                set,
                question,
                lane,
                fn,
                (await texts.get(lane, fn)).text,
                options.qaSamples,
              );
            },
          });
        }
      }
    }
  }

  return {
    units,
    results: () => ({
      readability: readability.filter((item) => item !== undefined),
      comprehension: comprehension.filter((item) => item !== undefined),
      qa: qa.filter((item) => item !== undefined),
      tokens: tokenEntries.map(({ fn, lane, key }): TokenCount => {
        const result = tokenResults.get(key);
        return { fn: fn.id, lane, sha256: result?.sha ?? key, tokens: result?.tokens ?? null };
      }),
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// units

/** Claude tokens of `text` (prompt size minus the empty-prompt baseline); null when unknown. */
async function countTokens(runner: Runner, text: string, label: string): Promise<number | null> {
  if (text === '') return 0;
  const baseline = await runner.baseline();
  const outcome = await runner.call({
    task: 'tokens',
    system: TOKENS_SYSTEM,
    user: text,
    sample: 0,
    reply: textReply,
    label,
    count: runner.counts,
  });
  const input = outcome.kind === 'ok' ? (outcome.record.usage?.input ?? null) : null;
  return input === null || baseline === null ? null : input - baseline;
}

async function judgeReadability(
  runner: Runner,
  a: string,
  b: string,
  fn: CorpusFunction,
  textA: { text: string },
  textB: { text: string },
): Promise<ReadabilityJudgment> {
  const base = { fn: fn.id, a, b } as const;
  if (textA.text === textB.text)
    return {
      ...base,
      status: 'identical',
      orders: null,
      score: perDimension(() => 0.5),
      consistent: null,
      reasons: [],
    };
  if (Buffer.byteLength(textA.text) + Buffer.byteLength(textB.text) > READABILITY_MAX_BYTES)
    return {
      ...base,
      status: 'too_large',
      orders: null,
      score: null,
      consistent: null,
      reasons: [],
    };
  const verdicts: OrderVerdicts[] = [];
  const reasons: string[] = [];
  let failed: Failure | null = null;
  for (const order of [0, 1] as const) {
    const [first, second] = order === 0 ? [textA.text, textB.text] : [textB.text, textA.text];
    const outcome = await runner.call({
      task: 'readability',
      system: READABILITY_SYSTEM,
      user: readabilityUser(first, second),
      sample: 0,
      reply: jsonReply(readabilitySchema),
      label: `${a}:${b} ${fn.id} order ${order}`,
    });
    if (outcome.kind !== 'ok') {
      failed ??= outcome;
      if (runner.mode === 'dry') continue; // keep counting the remaining calls
      break;
    }
    verdicts.push(mapOrderVerdicts(order, outcome.value));
    const reason = laneReason(outcome.value.reason, order, a, b);
    if (reason) reasons.push(reason);
  }
  if (failed)
    return {
      ...base,
      ...failure(failed),
      orders: null,
      score: null,
      consistent: null,
      reasons: [],
    };
  const orders = [verdicts[0], verdicts[1]] as [OrderVerdicts, OrderVerdicts];
  const { score, consistent } = scoreOrders(orders);
  return { ...base, status: 'judged', orders, score, consistent, reasons };
}

async function judgeComprehension(
  runner: Runner,
  lane: string,
  fn: CorpusFunction,
  text: string,
  source: string,
  samples: number,
): Promise<ComprehensionJudgment> {
  const base = { fn: fn.id, lane } as const;
  const empty = {
    coverage: null,
    correct: null,
    wrong: null,
    unverifiable: null,
    wrong_claims: [],
  } as const;
  if (Buffer.byteLength(text) > COMPREHENSION_MAX_BYTES)
    return { ...base, ...empty, status: 'too_large' };
  const grades: z.output<typeof gradeSchema>[] = [];
  let failed: Failure | null = null;
  for (let sample = 0; sample < Math.max(1, samples); sample++) {
    const explain = await runner.call({
      task: 'comprehension',
      system: EXPLAIN_SYSTEM,
      user: explainUser(text),
      sample,
      reply: jsonReply(explainSchema),
      label: `${lane} ${fn.id} explain ${sample}`,
    });
    let explanation: string;
    if (explain.kind === 'ok') explanation = JSON.stringify(explain.record.parsed, null, 2);
    else if (runner.mode === 'dry' && explain.kind === 'missing') {
      failed ??= explain;
      explanation = `${ESTIMATED_EXPLANATION}${lane} ${sample}`; // unique: sized, never deduplicated
    } else {
      failed ??= explain;
      break;
    }
    const grade = await runner.call({
      task: 'comprehension',
      system: GRADE_SYSTEM,
      user: gradeUser(source, explanation),
      sample,
      reply: jsonReply(gradeSchema),
      label: `${lane} ${fn.id} grade ${sample}`,
    });
    if (grade.kind !== 'ok') {
      failed ??= grade;
      if (runner.mode === 'dry') continue;
      break;
    }
    grades.push(grade.value);
  }
  if (failed) return { ...base, ...empty, ...failure(failed) };
  return {
    ...base,
    status: 'judged',
    coverage: mean(grades.map((grade) => grade.coverage)),
    correct: meanOfPresent(grades.map((grade) => grade.correct)),
    wrong: mean(grades.map((grade) => grade.wrong)),
    unverifiable: meanOfPresent(grades.map((grade) => grade.unverifiable)),
    wrong_claims: grades.flatMap((grade) => grade.wrong_claims),
  };
}

async function judgeQuestion(
  runner: Runner,
  set: QuestionSet,
  question: Question,
  lane: string,
  fn: CorpusFunction,
  text: string,
  samples: number,
): Promise<QaJudgment> {
  const base = { question: question.id, fn: fn.id, lane } as const;
  const user = qaUser(set, question, text);
  const answered: { answer: string; outcome: QaOutcome }[] = [];
  let failed: Failure | null = null;
  for (let sample = 0; sample < Math.max(1, samples); sample++) {
    const outcome = await runner.call({
      task: 'qa',
      system: QA_SYSTEM,
      user,
      sample,
      reply: textReply,
      label: `${lane} ${question.id} sample ${sample}`,
    });
    if (outcome.kind !== 'ok') {
      failed ??= outcome;
      if (runner.mode === 'dry') continue;
      break;
    }
    answered.push({ answer: outcome.value, outcome: scoreAnswer(question, outcome.value).outcome });
  }
  if (failed) return { ...base, ...failure(failed), samples: answered, correct_rate: null };
  return {
    ...base,
    status: 'judged',
    samples: answered,
    correct_rate:
      answered.filter((sample) => sample.outcome === 'correct').length / answered.length,
  };
}

// ---------------------------------------------------------------------------------------------
// entry points

/** Plans every call, serves cache hits, makes the misses (or only counts them when `dryRun`). */
export async function runJudge(corpus: Corpus, options: JudgeOptions): Promise<JudgeRunSummary> {
  const started = Date.now();
  const skipTokens = options.tasks.includes('tokens') && options.backend === 'cmd';
  if (skipTokens) process.stderr.write('judge: tokens skipped: the cmd backend reports no usage\n');
  const tasks = TASKS.filter(
    (task) => options.tasks.includes(task) && !(skipTokens && task === 'tokens'),
  );
  const backend = options.dryRun ? null : createBackend(options.backend, options.command);
  const runner = new Runner(
    options.dryRun ? 'dry' : 'run',
    options.model,
    backend,
    options.backend === 'omp' ? OMP_CALL_OVERHEAD_TOKENS : 0,
  );
  const plan = await buildPlan(corpus, { ...options, tasks }, runner, true);

  const total = new Map<TaskName, number>();
  for (const unit of plan.units) total.set(unit.task, (total.get(unit.task) ?? 0) + 1);
  const done = new Map<TaskName, number>();
  const tick = (task: TaskName): void => {
    const count = (done.get(task) ?? 0) + 1;
    done.set(task, count);
    const all = total.get(task) ?? count;
    if (count !== all && count % Math.max(1, Math.ceil(all / 25)) !== 0) return;
    const stats = runner.statsFor(task);
    process.stderr.write(
      `judge: ${task} ${count}/${all} (calls ${stats.called}, cached ${stats.cached}, failed ${stats.failed})\n`,
    );
  };

  if (tasks.includes('tokens')) await runner.baseline();
  await runPool(plan.units, options.concurrency, async (unit) => {
    await unit.run();
    tick(unit.task);
  });

  return {
    model: options.model,
    backend: options.backend,
    tasks: Object.fromEntries(tasks.map((task) => [task, { ...runner.statsFor(task) }])),
    input_tokens: options.dryRun ? runner.estimatedInputTokens : runner.inputTokens,
    output_tokens: runner.outputTokens,
    cost: runner.cost,
    seconds: (Date.now() - started) / 1000,
  };
}

/** Rebuilds the plan of `runJudge` and reads only the cache; uncached judgments get status `missing`. */
export async function collectJudgments(
  corpus: Corpus,
  options: Pick<
    JudgeOptions,
    'tier' | 'lanes' | 'pairs' | 'model' | 'qaSamples' | 'comprehensionSamples'
  >,
): Promise<CollectedJudgments> {
  const runner = new Runner('collect', options.model, null);
  const plan = await buildPlan(corpus, { ...options, tasks: TASKS }, runner, false);
  await runner.baseline();
  await runPool(plan.units, COLLECT_CONCURRENCY, (unit) => unit.run());
  return { model: options.model, ...plan.results() };
}

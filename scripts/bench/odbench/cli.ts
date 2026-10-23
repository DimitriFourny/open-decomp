/**
 * odbench command line: `node --import tsx scripts/bench/odbench/cli.ts <command>` (`bun run bench`).
 * Run `--help` for the command list.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { corpusSha256, loadCorpus, verifyInputs } from './corpus.js';
import { DEFAULT_MODEL, defaultBackend } from './judge/backend.js';
import { collectJudgments, runJudge } from './judge/tasks.js';
import { runGhidraLane } from './lane-ghidra.js';
import { runOdLane } from './lane-od.js';
import { buildReport, renderMarkdown, renderScorecard } from './report.js';
import { selectCorpus } from './select.js';
import { runSourceLane } from './sources.js';
import { ODBENCH_DIR, TASKS, paths } from './types.js';
import type { Corpus, JudgeOptions, LaneRun, TaskName, Tier } from './types.js';

const REFERENCE_LANE = 'ghidra';

/** Request workers per binary of an OD run (roadmap 4 T9 measurement: docs/internals/project-cache.md). */
const DEFAULT_OD_JOBS = Math.max(1, Math.min(4, availableParallelism() >> 1));

const USAGE = `Usage: bench <command> [flags]

Commands:
  inputs                       verify every corpus binary/source hash in the data store
  select [--check]             rebuild corpus.json (--check: verify the committed one reproduces)
  run od --label L [--repo PATH] [--tier quick|full] [--repeat N] [--jobs N] [--inference proven|likely] [--only BINARY,...]
                               [--no-open-job]
  run ghidra [--tier] [--install DIR] [--java-home DIR] [--force] [--only BINARY,...]
  run source [--tier]
  judge --lanes A,B,... [--pairs A:B,...] [--tier] [--tasks tokens,readability,comprehension,qa]
        [--model M] [--backend omp|anthropic|cmd] [--command CMD] [--concurrency N]
        [--qa-samples N] [--comprehension-samples N] [--reference LANE] [--dry-run]
  report --lanes A,B,... [--reference ghidra] [--pairs A:B,...] [--tier] [--model M] [--out DIR]
        [--qa-samples N] [--comprehension-samples N]
  all --label L [--repo PATH] [--base LANE] [--tier quick] [--no-judge] [--model M]
        [--repeat N] [--jobs N] [--inference proven|likely] [--only BINARY,...] [--install DIR] [--java-home DIR]
        [--force] [--backend omp|anthropic|cmd] [--command CMD] [--concurrency N]
        [--qa-samples N] [--comprehension-samples N] [--out DIR]
        run od, source and ghidra (cached), judge od-L/ghidra/source[/base], write the report

Defaults: --tier quick, --model ${DEFAULT_MODEL}, --backend anthropic if ANTHROPIC_API_KEY is set else omp,
--concurrency 8, --qa-samples 3, --comprehension-samples 1, --repeat 1, --inference proven,
--repo this checkout, --reference ghidra, --jobs ${DEFAULT_OD_JOBS} (request workers per binary: min(4, cores/2)).
--no-open-job opens without the open-time job (T8).
Lanes: od-<label>, ghidra (reference), source (calibration anchor). Data store: $OPEN_DECOMP_BENCH_DIR or .odbench/.
`;

class UsageError extends Error {}

const FLAG_TYPES = {
  label: 'string',
  repo: 'string',
  tier: 'string',
  repeat: 'string',
  jobs: 'string',
  inference: 'string',
  only: 'string',
  install: 'string',
  'java-home': 'string',
  force: 'boolean',
  lanes: 'string',
  pairs: 'string',
  tasks: 'string',
  model: 'string',
  backend: 'string',
  command: 'string',
  concurrency: 'string',
  'qa-samples': 'string',
  'comprehension-samples': 'string',
  reference: 'string',
  out: 'string',
  base: 'string',
  check: 'boolean',
  'dry-run': 'boolean',
  'no-judge': 'boolean',
  'no-open-job': 'boolean',
  help: 'boolean',
} as const;
type FlagName = keyof typeof FLAG_TYPES;

const JUDGE_FLAGS: readonly FlagName[] = [
  'tier',
  'model',
  'backend',
  'command',
  'concurrency',
  'qa-samples',
  'comprehension-samples',
];
const OD_FLAGS: readonly FlagName[] = [
  'label',
  'repo',
  'tier',
  'repeat',
  'jobs',
  'inference',
  'only',
  'no-open-job',
];
const GHIDRA_FLAGS: readonly FlagName[] = ['tier', 'install', 'java-home', 'force', 'only'];

const COMMAND_FLAGS: Record<string, readonly FlagName[]> = {
  inputs: [],
  select: ['check'],
  'run od': OD_FLAGS,
  'run ghidra': GHIDRA_FLAGS,
  'run source': ['tier'],
  judge: [...JUDGE_FLAGS, 'lanes', 'pairs', 'tasks', 'reference', 'dry-run'],
  report: [
    'lanes',
    'reference',
    'pairs',
    'tier',
    'model',
    'out',
    'qa-samples',
    'comprehension-samples',
  ],
  all: [
    ...new Set([...OD_FLAGS, ...GHIDRA_FLAGS, ...JUDGE_FLAGS, 'base', 'no-judge', 'out'] as const),
  ],
};

type Flags = Partial<Record<FlagName, string | boolean>>;

function parseFlags(command: string, args: readonly string[]): Flags {
  const allowed = COMMAND_FLAGS[command];
  if (!allowed) throw new UsageError(`unknown command: ${command}`);
  const options: Record<string, { type: 'string' | 'boolean' }> = { help: { type: 'boolean' } };
  for (const name of allowed) options[name] = { type: FLAG_TYPES[name] };
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options,
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > 0)
      throw new UsageError(`unexpected argument: ${positionals.join(' ')}`);
    return values as Flags;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function text(flags: Flags, name: FlagName): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

function requiredText(flags: Flags, name: FlagName, command: string): string {
  const value = text(flags, name);
  if (!value) throw new UsageError(`${command}: --${name} is required`);
  return value;
}

function choice<T extends string>(
  flags: Flags,
  name: FlagName,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = text(flags, name);
  if (value === undefined) return fallback;
  const found = allowed.find((candidate) => candidate === value);
  if (!found) throw new UsageError(`--${name} must be one of ${allowed.join(', ')} (got ${value})`);
  return found;
}

function integer(flags: Flags, name: FlagName, fallback: number): number {
  const value = text(flags, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new UsageError(`--${name} must be a positive integer (got ${value})`);
  return parsed;
}

function list(flags: Flags, name: FlagName): string[] | null {
  const value = text(flags, name);
  return value === undefined
    ? null
    : value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

function pairsFrom(flags: Flags): (readonly [string, string])[] | null {
  const items = list(flags, 'pairs');
  if (items === null) return null;
  return items.map((item) => {
    const parts = item.split(':');
    const [a, b] = parts;
    if (parts.length !== 2 || !a || !b)
      throw new UsageError(`--pairs entries look like A:B (got ${item})`);
    return [a, b] as const;
  });
}

/** Every compared lane against the reference, when the reference is among the lanes. */
function defaultPairs(lanes: readonly string[], reference: string): (readonly [string, string])[] {
  return lanes.includes(reference)
    ? lanes.filter((lane) => lane !== reference).map((lane) => [lane, reference] as const)
    : [];
}

function summarizeLane(run: LaneRun): string {
  const states = new Map<string, number>();
  for (const result of Object.values(run.functions))
    states.set(result.state, (states.get(result.state) ?? 0) + 1);
  const counts = [...states.entries()].map(([state, count]) => `${state} ${count}`).join(', ');
  return `lane ${run.lane}: ${Object.keys(run.functions).length} functions (${counts || 'none'}) -> ${paths.lane(run.lane)}`;
}

interface Loaded {
  readonly corpus: Corpus;
  readonly sha: string;
}

async function load(): Promise<Loaded> {
  return { corpus: await loadCorpus(), sha: await corpusSha256() };
}

// ---- commands ----------------------------------------------------------------------------------

async function inputs(): Promise<void> {
  const { corpus } = await load();
  const checks = await verifyInputs(corpus);
  const bad = checks.filter((check) => check.status !== 'ok');
  for (const check of bad)
    console.log(
      `${check.status.toUpperCase()} ${check.kind} ${check.id}: ${check.path}\n  origin: ${check.origin}${check.url ? `\n  url: ${check.url}` : ''}`,
    );
  console.log(`inputs: ${checks.length - bad.length}/${checks.length} ok`);
  if (bad.length > 0) process.exitCode = 1;
}

async function select(flags: Flags): Promise<void> {
  await selectCorpus({ check: flags.check === true });
}

async function runOd(flags: Flags, loaded: Loaded): Promise<LaneRun> {
  const run = await runOdLane({
    corpus: loaded.corpus,
    corpusSha256: loaded.sha,
    label: requiredText(flags, 'label', 'run od'),
    repo: resolve(text(flags, 'repo') ?? resolve(ODBENCH_DIR, '../../..')),
    tier: choice<Tier>(flags, 'tier', ['quick', 'full'], 'quick'),
    repeat: integer(flags, 'repeat', 1),
    jobs: integer(flags, 'jobs', DEFAULT_OD_JOBS),
    inference: choice(flags, 'inference', ['proven', 'likely'], 'proven'),
    only: list(flags, 'only'),
    openJob: flags['no-open-job'] !== true,
  });
  console.log(summarizeLane(run));
  return run;
}

async function runGhidra(flags: Flags, loaded: Loaded): Promise<LaneRun> {
  const run = await runGhidraLane({
    corpus: loaded.corpus,
    corpusSha256: loaded.sha,
    tier: choice<Tier>(flags, 'tier', ['quick', 'full'], 'quick'),
    install: text(flags, 'install') ?? null,
    javaHome: text(flags, 'java-home') ?? null,
    force: flags.force === true,
    only: list(flags, 'only'),
  });
  console.log(summarizeLane(run));
  return run;
}

async function runSource(flags: Flags, loaded: Loaded): Promise<LaneRun> {
  const run = await runSourceLane({
    corpus: loaded.corpus,
    corpusSha256: loaded.sha,
    tier: choice<Tier>(flags, 'tier', ['quick', 'full'], 'quick'),
  });
  console.log(summarizeLane(run));
  return run;
}

function judgeOptions(
  flags: Flags,
  lanes: readonly string[],
  pairs: readonly (readonly [string, string])[],
  tasks: readonly TaskName[],
  dryRun: boolean,
): JudgeOptions {
  const backend = choice(flags, 'backend', ['omp', 'anthropic', 'cmd'], defaultBackend());
  const command = text(flags, 'command');
  if (backend === 'cmd' && !command) throw new UsageError('--backend cmd needs --command');
  return {
    tier: choice<Tier>(flags, 'tier', ['quick', 'full'], 'quick'),
    tasks,
    lanes,
    pairs,
    model: text(flags, 'model') ?? DEFAULT_MODEL,
    backend,
    ...(command === undefined ? {} : { command }),
    concurrency: integer(flags, 'concurrency', 8),
    qaSamples: integer(flags, 'qa-samples', 3),
    comprehensionSamples: integer(flags, 'comprehension-samples', 1),
    dryRun,
  };
}

function taskList(flags: Flags): TaskName[] {
  const requested = list(flags, 'tasks');
  if (requested === null) return [...TASKS];
  return requested.map((name) => {
    const task = TASKS.find((candidate) => candidate === name);
    if (!task)
      throw new UsageError(`--tasks entries must be one of ${TASKS.join(', ')} (got ${name})`);
    return task;
  });
}

async function judge(flags: Flags): Promise<void> {
  const { corpus } = await load();
  const lanes = list(flags, 'lanes');
  if (!lanes || lanes.length === 0) throw new UsageError('judge: --lanes is required');
  const reference = text(flags, 'reference') ?? REFERENCE_LANE;
  const pairs = pairsFrom(flags) ?? defaultPairs(lanes, reference);
  if (pairs.length === 0 && taskList(flags).includes('readability'))
    console.error(`judge: no readability pairs (--pairs, or include ${reference} in --lanes)`);
  const summary = await runJudge(
    corpus,
    judgeOptions(flags, lanes, pairs, taskList(flags), flags['dry-run'] === true),
  );
  console.log(JSON.stringify(summary, null, 2));
}

function stamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function report(
  loaded: Loaded,
  options: {
    tier: Tier;
    lanes: readonly string[];
    reference: string;
    pairs: readonly (readonly [string, string])[];
    model: string;
    qaSamples: number;
    comprehensionSamples: number;
    out: string | undefined;
  },
): Promise<void> {
  const compared = [...new Set([...options.lanes, options.reference])];
  const judgments = await collectJudgments(loaded.corpus, {
    tier: options.tier,
    lanes: compared,
    pairs: options.pairs,
    model: options.model,
    qaSamples: options.qaSamples,
    comprehensionSamples: options.comprehensionSamples,
  });
  const built = await buildReport({
    corpus: loaded.corpus,
    corpusSha256: loaded.sha,
    tier: options.tier,
    lanes: options.lanes,
    reference: options.reference,
    judgments,
  });
  const focus = compared.find((lane) => lane !== options.reference) ?? options.reference;
  const directory = options.out
    ? resolve(options.out)
    : join(paths.reports(), `${stamp(new Date())}-${focus}-${options.tier}`);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'report.md'), renderMarkdown(built));
  await writeFile(join(directory, 'report.json'), `${JSON.stringify(built, null, 2)}\n`);
  console.log(`report: ${join(directory, 'report.md')}`);
  console.log(renderScorecard(built));
  if (built.warnings.length > 0)
    console.log(`\n${built.warnings.length} warning(s); see section 9 of the report.`);
}

async function reportCommand(flags: Flags): Promise<void> {
  const lanes = list(flags, 'lanes');
  if (!lanes || lanes.length === 0) throw new UsageError('report: --lanes is required');
  const reference = text(flags, 'reference') ?? REFERENCE_LANE;
  await report(await load(), {
    tier: choice<Tier>(flags, 'tier', ['quick', 'full'], 'quick'),
    lanes,
    reference,
    pairs: pairsFrom(flags) ?? defaultPairs([...new Set([...lanes, reference])], reference),
    model: text(flags, 'model') ?? DEFAULT_MODEL,
    qaSamples: integer(flags, 'qa-samples', 3),
    comprehensionSamples: integer(flags, 'comprehension-samples', 1),
    out: text(flags, 'out'),
  });
}

async function all(flags: Flags): Promise<void> {
  const label = requiredText(flags, 'label', 'all');
  const loaded = await load();
  const odLane = `od-${label}`;
  const base = text(flags, 'base');
  await runOd(flags, loaded);
  await runSource(flags, loaded);
  await runGhidra(flags, loaded);

  const lanes = base
    ? [odLane, base, REFERENCE_LANE, 'source']
    : [odLane, REFERENCE_LANE, 'source'];
  const pairs: (readonly [string, string])[] = [
    [odLane, REFERENCE_LANE],
    ['source', REFERENCE_LANE],
    ...(base ? [[base, REFERENCE_LANE] as const, [odLane, base] as const] : []),
  ];
  if (flags['no-judge'] !== true) {
    const summary = await runJudge(
      loaded.corpus,
      judgeOptions(flags, lanes, pairs, [...TASKS], false),
    );
    console.log(JSON.stringify(summary, null, 2));
  }
  await report(loaded, {
    tier: choice<Tier>(flags, 'tier', ['quick', 'full'], 'quick'),
    lanes,
    reference: REFERENCE_LANE,
    pairs,
    model: text(flags, 'model') ?? DEFAULT_MODEL,
    qaSamples: integer(flags, 'qa-samples', 3),
    comprehensionSamples: integer(flags, 'comprehension-samples', 1),
    out: text(flags, 'out'),
  });
}

async function main(argv: readonly string[]): Promise<void> {
  const [first, ...rest] = argv;
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    console.log(USAGE);
    return;
  }
  const command = first === 'run' ? `run ${rest[0] ?? ''}`.trim() : first;
  const args = first === 'run' ? rest.slice(1) : rest;
  if (!(command in COMMAND_FLAGS))
    throw new UsageError(
      first === 'run'
        ? `run needs od, ghidra or source (got ${rest[0] ?? 'nothing'})`
        : `unknown command: ${first}`,
    );
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const flags = parseFlags(command, args);
  switch (command) {
    case 'inputs':
      return inputs();
    case 'select':
      return select(flags);
    case 'run od':
      requiredText(flags, 'label', 'run od');
      await runOd(flags, await load());
      return;
    case 'run ghidra':
      await runGhidra(flags, await load());
      return;
    case 'run source':
      await runSource(flags, await load());
      return;
    case 'judge':
      return judge(flags);
    case 'report':
      return reportCommand(flags);
    case 'all':
      return all(flags);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(`odbench: ${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
  } else {
    console.error(`odbench: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
});

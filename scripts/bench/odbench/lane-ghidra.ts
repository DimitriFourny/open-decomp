/**
 * Ghidra lane: Ghidra's headless decompiler as the reference. Incremental per binary: a binary is
 * re-run only when its cache key (binary hash, Ghidra version, both Java scripts, function list)
 * differs from the key stored in lane.json `tool.options.keys`, or with `force`.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { binaryPath, corpusBinary, tierFunctions } from './corpus.js';
import { hostInfo, readLane, writeLane, writeText } from './store.js';
import { ODBENCH_DIR, fnKey, paths, sha256 } from './types.js';
import type {
  BinaryTiming,
  Corpus,
  CorpusFunction,
  FunctionResult,
  LaneRun,
  Tier,
} from './types.js';

const LANE = 'ghidra';
const ANALYSIS_TIMEOUT_S = 3600;
const DECOMPILE_TIMEOUT_S = 300;
const DEFAULT_INSTALL = join(homedir(), 'Downloads', 'ghidra_12.1.4_PUBLIC');
const DEFAULT_JAVA_HOME = '/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home';
const SCRIPT_DIR = join(ODBENCH_DIR, 'ghidra');
const SCRIPTS = ['OdbenchMark.java', 'OdbenchDecompile.java'] as const;

interface ScriptRecord {
  readonly fnKey: string;
  readonly state: 'complete' | 'failed' | 'not_found';
  readonly method: string | null;
  readonly name: string | null;
  readonly address: string | null;
  readonly ghidra_address: string | null;
  readonly ms: number;
  readonly error: string | null;
}

interface ScriptMeta {
  readonly analysis_ms: number;
}

interface Installation {
  readonly install: string;
  readonly javaHome: string | null;
}

function resolveInstallation(install: string | null, javaHome: string | null): Installation {
  const root =
    install ??
    process.env['GHIDRA_INSTALL_DIR'] ??
    (existsSync(DEFAULT_INSTALL) ? DEFAULT_INSTALL : null);
  if (!root || !existsSync(join(root, 'support', 'analyzeHeadless')))
    throw new Error(
      'ghidra: set --install or GHIDRA_INSTALL_DIR to a Ghidra installation (support/analyzeHeadless)',
    );
  const java =
    javaHome ??
    process.env['JAVA_HOME'] ??
    (existsSync(DEFAULT_JAVA_HOME) ? DEFAULT_JAVA_HOME : null);
  return { install: root, javaHome: java };
}

async function ghidraVersion(install: string): Promise<string> {
  const properties = await readFile(join(install, 'Ghidra', 'application.properties'), 'utf8');
  const version = /^application\.version=(.+)$/m.exec(properties)?.[1]?.trim();
  if (!version)
    throw new Error(`ghidra: no application.version in ${install}/Ghidra/application.properties`);
  return version;
}

/** The `fnKey<TAB>va<TAB>name-or-empty` lines of one binary, sorted (also the cache-key input). */
function listLines(functions: readonly CorpusFunction[]): string[] {
  return functions.map((fn) => `${fnKey(fn.id)}\t${fn.va}\t${fn.name ?? ''}`).sort();
}

function parseJsonLines<T>(text: string): T[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

interface ProcessOutcome {
  readonly wall_ms: number;
  readonly exit: string | null;
}

/** Runs analyzeHeadless with stdout/stderr appended to `logFile`; `exit` is null on exit code 0. */
function runAnalyzeHeadless(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  logFile: string,
  deadlineMs: number,
): Promise<ProcessOutcome> {
  const log = openSync(logFile, 'w');
  const start = performance.now();
  return new Promise<ProcessOutcome>((resolve) => {
    const finish = (exit: string | null): void => {
      clearTimeout(timer);
      closeSync(log);
      resolve({ wall_ms: performance.now() - start, exit });
    };
    // A process group of its own, so a timeout also stops the JVM the launcher script started.
    const child = spawn(command, [...args], { env, stdio: ['ignore', log, log], detached: true });
    const timer = setTimeout(() => {
      if (child.pid !== undefined)
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
    }, deadlineMs);
    child.on('error', (error) => finish(`spawn failed: ${error.message}`));
    child.on('close', (code, signal) =>
      finish(
        signal
          ? `analyzeHeadless killed by ${signal}`
          : code === 0
            ? null
            : `analyzeHeadless exit code ${code}`,
      ),
    );
  });
}

function failedResult(reason: string): FunctionResult {
  return { state: 'failed', reason, ms: null, text_file: null, sha256: null, bytes: 0 };
}

export async function runGhidraLane(opts: {
  corpus: Corpus;
  corpusSha256: string;
  tier: Tier;
  install: string | null;
  javaHome: string | null;
  force: boolean;
  only: readonly string[] | null;
}): Promise<LaneRun> {
  const loadStart = [...loadavg()];
  const started = new Date().toISOString();
  const resolved = resolveInstallation(opts.install, opts.javaHome);
  const version = await ghidraVersion(resolved.install);
  const scriptHashes = await Promise.all(
    SCRIPTS.map(async (name) => sha256(await readFile(join(SCRIPT_DIR, name)))),
  );

  const tierFns = tierFunctions(opts.corpus, opts.tier);
  const byBinary = new Map<string, CorpusFunction[]>();
  for (const fn of tierFns) byBinary.set(fn.binary, [...(byBinary.get(fn.binary) ?? []), fn]);
  for (const id of opts.only ?? []) corpusBinary(opts.corpus, id);
  const selected = opts.corpus.binaries
    .filter((binary) => byBinary.has(binary.id) && (!opts.only || opts.only.includes(binary.id)))
    .map((binary) => binary.id);

  const previous = await readLane(LANE);
  const storedKeys: unknown = previous?.tool.options?.['keys'];
  const keys: Record<string, string> = {};
  if (typeof storedKeys === 'object' && storedKeys !== null)
    for (const [binary, key] of Object.entries(storedKeys))
      if (typeof key === 'string') keys[binary] = key;
  const functions: Record<string, FunctionResult> = { ...previous?.functions };
  const binaries: Record<string, BinaryTiming> = { ...previous?.binaries };
  const cached: string[] = [];
  const ran: string[] = [];

  const lanePaths = paths.lane(LANE);
  await mkdir(join(lanePaths, 'texts'), { recursive: true });
  await mkdir(join(lanePaths, 'logs'), { recursive: true });

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    JAVA_TOOL_OPTIONS: '-Djava.awt.headless=true',
  };
  if (resolved.javaHome) environment['JAVA_HOME'] = resolved.javaHome;

  const snapshot = (finished: string): LaneRun => ({
    schema: 'odbench-lane/1',
    lane: LANE,
    kind: 'ghidra',
    tool: {
      name: 'ghidra',
      version,
      path: resolved.install,
      options: {
        keys,
        java_home: resolved.javaHome,
        analysis_timeout_s: ANALYSIS_TIMEOUT_S,
        decompile_timeout_s: DECOMPILE_TIMEOUT_S,
        simplification_style: 'decompile',
      },
    },
    corpus_sha256: opts.corpusSha256,
    tier: opts.tier,
    started,
    finished,
    host: hostInfo(loadStart),
    repeat: 1,
    jobs: 1,
    binaries,
    functions,
    notes: [
      `Ghidra ${version} headless, auto-analysis timeout ${ANALYSIS_TIMEOUT_S} s per file, decompile timeout ${DECOMPILE_TIMEOUT_S} s per function.`,
      'cold_ms = analyzeHeadless wall (JVM start, import, analysis, decompiles); import_ms = cold - analysis - decompiles.',
      `ran: ${ran.join(', ') || '(none)'}; cached: ${cached.join(', ') || '(none)'}.`,
    ],
  });

  for (const id of selected) {
    const binary = corpusBinary(opts.corpus, id);
    const fns = byBinary.get(id) ?? [];
    const lines = listLines(fns);
    const key = sha256(JSON.stringify([binary.sha256, version, ...scriptHashes, lines]));
    if (!opts.force && keys[id] === key && fns.every((fn) => functions[fn.id] !== undefined)) {
      cached.push(id);
      process.stderr.write(`ghidra: ${id} cached (${fns.length} functions)\n`);
      continue;
    }
    ran.push(id);
    delete keys[id];
    for (const stale of Object.keys(functions).filter((fnId) => fnId.startsWith(`${id}/`))) {
      const file = functions[stale]?.text_file;
      if (file) await rm(join(lanePaths, file), { force: true });
      delete functions[stale];
    }

    process.stderr.write(
      `ghidra: ${id} analyzing, ${fns.length} functions (log: lanes/${LANE}/logs/${id}.log)\n`,
    );
    const work = await mkdtemp(join(tmpdir(), 'odbench-ghidra-'));
    try {
      const scriptDir = join(work, 'scripts');
      const outDir = join(work, 'out');
      const projectDir = join(work, 'project');
      const listFile = join(work, 'functions.list');
      const markFile = join(work, 'mark.txt');
      await Promise.all([mkdir(scriptDir), mkdir(outDir), mkdir(projectDir)]);
      await Promise.all(
        SCRIPTS.map((name) => copyFile(join(SCRIPT_DIR, name), join(scriptDir, name))),
      );
      await writeFile(listFile, `${lines.join('\n')}\n`);
      const outcome = await runAnalyzeHeadless(
        join(resolved.install, 'support', 'analyzeHeadless'),
        [
          projectDir,
          'odbench',
          '-import',
          binaryPath(binary),
          '-scriptPath',
          scriptDir,
          '-preScript',
          'OdbenchMark.java',
          markFile,
          '-postScript',
          'OdbenchDecompile.java',
          listFile,
          outDir,
          markFile,
          '-deleteProject',
          '-analysisTimeoutPerFile',
          String(ANALYSIS_TIMEOUT_S),
        ],
        environment,
        join(lanePaths, 'logs', `${id}.log`),
        (ANALYSIS_TIMEOUT_S + 600 + DECOMPILE_TIMEOUT_S * fns.length) * 1000,
      );

      const meta = await readIfExists(join(outDir, 'meta.json'));
      const analysisMs = meta ? (JSON.parse(meta) as ScriptMeta).analysis_ms : null;
      const lines_ = parseJsonLines<ScriptRecord>(
        (await readIfExists(join(outDir, 'results.jsonl'))) ?? '',
      );
      const records = new Map(lines_.map((record) => [record.fnKey, record]));
      const missing = `${outcome.exit ?? 'ghidra script recorded no result'} (see lanes/${LANE}/logs/${id}.log)`;

      let decompileTotal = 0;
      let complete = true;
      for (const fn of fns) {
        const record = records.get(fnKey(fn.id));
        if (!record) {
          functions[fn.id] = failedResult(missing);
          complete = false;
          continue;
        }
        decompileTotal += record.ms;
        const resolvedAt =
          record.address !== null && record.method !== null
            ? { name: record.name, address: record.address, method: record.method }
            : undefined;
        const base = { reason: record.error, ms: record.state === 'not_found' ? null : record.ms };
        if (record.state === 'complete') {
          const text = await readFile(join(outDir, `${record.fnKey}.c`), 'utf8');
          functions[fn.id] = {
            state: 'complete',
            ...base,
            ...(await writeText(LANE, fn.id, text)),
            ...(resolvedAt ? { resolved: resolvedAt } : {}),
          };
        } else {
          functions[fn.id] = {
            state: record.state,
            ...base,
            text_file: null,
            sha256: null,
            bytes: 0,
            ...(resolvedAt ? { resolved: resolvedAt } : {}),
          };
        }
      }
      binaries[id] = {
        cold_ms: outcome.wall_ms,
        import_ms:
          analysisMs === null ? null : Math.max(0, outcome.wall_ms - analysisMs - decompileTotal),
        analysis_ms: analysisMs,
        decompile_ms_total: decompileTotal,
      };
      if (outcome.exit === null && complete) keys[id] = key;
      const states = fns.map((fn) => functions[fn.id]?.state);
      process.stderr.write(
        `ghidra: ${id} ${(outcome.wall_ms / 1000).toFixed(1)} s, ${states.filter((state) => state === 'complete').length}/${fns.length} complete` +
          `${outcome.exit ? `, ${outcome.exit}` : ''}\n`,
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    await writeLane(snapshot(new Date().toISOString()));
  }

  if (ran.length > 0) {
    const run = snapshot(new Date().toISOString());
    await writeLane(run);
    return run;
  }
  const unchanged: LaneRun = previous
    ? { ...previous, corpus_sha256: opts.corpusSha256, tier: opts.tier }
    : snapshot(new Date().toISOString());
  if (!previous || previous.corpus_sha256 !== opts.corpusSha256 || previous.tier !== opts.tier)
    await writeLane(unchanged);
  return unchanged;
}

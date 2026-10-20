/**
 * Precision harness for the `likely` inference mode (TODO.md R5).
 *
 * Each heuristic that closes an open argument list records a `guess` inference. This script
 * decompiles functions of binaries whose sources we hold, in `likely` mode, joins every `guess`
 * record with source-derived ground truth (a DWARF dump of the compiler's own output for the
 * same sources, never of the analyzed binary), and reports precision and coverage per
 * heuristic. A heuristic prints in `likely` mode only if it passes the gate (`LIKELY_GATE` in
 * `src/service/analysis/likely-arity.ts`); this script decides that from measurement.
 *
 *   node --import tsx scripts/bench/likely-precision.ts --label NAME [--only ID,ID] [--sample N]
 *     [--out DIR] [--work DIR]
 *
 * Targets: `matrix` (the dev-loop matrix, symbol-bearing cells, scripts/bench/quality-matrix-corpus.c),
 * `fixtures` (Mach-O fixture executables, fixtures/source), `sqlite` (SQLite 3.54.0 executable
 * of the LLM-task benchmark and its amalgamation), `brotli` (Homebrew brotli 1.2.0 CLI and its
 * tools/brotli.c) and `brotli-lib` (the pinned brotli 1.2.0 library sources built here for arm64
 * macOS at -O0 and -O2). Targets whose inputs are absent are reported as skipped. Needs a built
 * `dist/` or tsx (it imports the API from source), clang and `dwarfdump` (macOS).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { expandEmission, openBinary } from '../../src/api/index.js';
import type { BinarySession } from '../../src/api/index.js';
import {
  DwarfReader,
  HEURISTICS,
  HEURISTIC_DIMENSION,
  cName,
  gate,
  guessableSites,
  parseDeclaration,
  scoreGuess,
  tally,
  typePopulation,
} from './likely-precision-score.js';
import type {
  CallRow,
  FunctionObservation,
  GuessRow,
  Heuristic,
  Tally,
  Truth,
  TypePopulation,
  Verdict,
} from './likely-precision-score.js';

const ROOT = resolve(import.meta.dirname, '../..');
const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

interface Source {
  readonly file: string;
  readonly includes?: readonly string[];
}
interface Target {
  readonly id: string;
  /** `<work>` in a path stands for the working directory. */
  readonly binaries: readonly { readonly id: string; readonly path: string }[];
  /** A thunk lists sources that `prepare` creates. */
  readonly sources: readonly Source[] | (() => readonly Source[]);
  /** Decompile at most this many functions of each binary (deterministic by name hash). */
  readonly sample: number;
  /** Prepares sources that are not in the repository (pinned downloads); may throw. */
  readonly prepare?: (work: string) => Promise<void>;
}

const BROTLI_TAG = 'https://raw.githubusercontent.com/google/brotli/v1.2.0/c';
const BROTLI_FILES: Readonly<Record<string, string>> = {
  'tools/brotli.c': 'cb6c8ca6668d324d50cd085fc3ddb3f202afe34fb562b5b583c0d7b0cceccd0c',
  'common/constants.h': 'c9c898542360e811dc44aa9be270d21ce0d18f3ecf45310f3d9f285f3692a59e',
  'common/platform.h': '63d47925374e1015e35eaac73d9d9dfc79b7f0585fe73c19d1ccde7a36aaa407',
  'common/version.h': '792d03d8feff8168edf639899f72b71a37e9cbd9f178e3be397ccef29d3346b0',
};
/** Brotli 1.2.0 library (common, dec, enc): built here for arm64 macOS at two optimization levels
 * with no debug info; the ground truth is a separate `-O1 -g` compile of the same files. */
const BROTLI_ARCHIVE = 'https://github.com/google/brotli/archive/refs/tags/v1.2.0.tar.gz';
const BROTLI_ARCHIVE_SHA256 = '816c96e8e8f193b40151dad7e8ff37b1221d019dbcb9c35cd3fadbfe6477dfec';
const BROTLI_LIBRARY_LEVELS = ['O0', 'O2'] as const;
const SQLITE_SOURCE = '.local/quality-coordinator-reviewed/reference/sqlite3.c';
const SQLITE_SHA256 = '2da161e310ef0aba3465f22a4d12b8a43723236f0942fa76e8aac523c3317243';
const SQLITE_BINARY = '.local/quality-coordinator-reviewed/inputs/sqlite3-arm64';
const BROTLI_BINARY = '/opt/homebrew/bin/brotli';
const MATRIX = '.local/performance/quality-matrix-reviewed';

async function matrixBinaries(): Promise<Target['binaries']> {
  const manifest = JSON.parse(
    await readFile(join(ROOT, MATRIX, 'build-manifest.json'), 'utf8'),
  ) as {
    root: string;
    cells: { id: string; input: { path: string } }[];
  };
  // Symbol-bearing cells only: stripped cells have no names to join with the truth, and the
  // matrix builds carry no debug info, so no signature is ever proven from DWARF.
  return manifest.cells
    .filter((cell) => cell.id.endsWith('symbol-bearing'))
    .map((cell) => ({
      id: cell.id,
      path: join(ROOT, MATRIX, relative(manifest.root, cell.input.path)),
    }));
}

function brotliLibrarySources(work: string): readonly Source[] {
  const root = join(work, 'brotli-lib', 'src', 'brotli-1.2.0', 'c');
  const include = [join(root, 'include')];
  return ['common', 'dec', 'enc'].flatMap((dir) =>
    existsSync(join(root, dir))
      ? readdirSync(join(root, dir))
          .filter((name) => name.endsWith('.c'))
          .sort()
          .map((name) => ({ file: join(root, dir, name), includes: include }))
      : [],
  );
}

async function prepareBrotliLibrary(work: string): Promise<void> {
  const base = join(work, 'brotli-lib');
  const archive = join(base, 'v1.2.0.tar.gz');
  await mkdir(base, { recursive: true });
  if (!existsSync(archive) || sha256(await readFile(archive)) !== BROTLI_ARCHIVE_SHA256) {
    const response = await fetch(BROTLI_ARCHIVE);
    if (!response.ok) throw new Error(`brotli archive: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (sha256(bytes) !== BROTLI_ARCHIVE_SHA256)
      throw new Error('brotli archive: SHA-256 differs from the pin');
    await writeFile(archive, bytes);
  }
  const root = join(base, 'src');
  if (!existsSync(join(root, 'brotli-1.2.0'))) {
    await mkdir(root, { recursive: true });
    const unpacked = spawnSync('tar', ['xzf', archive, '-C', root], { encoding: 'utf8' });
    if (unpacked.status !== 0) throw new Error(`tar failed: ${unpacked.stderr}`);
  }
  const sources = brotliLibrarySources(work).map((source) => source.file);
  for (const level of BROTLI_LIBRARY_LEVELS) {
    const output = join(base, `libbrotli-${level}.dylib`);
    if (existsSync(output)) continue;
    const built = spawnSync(
      'clang',
      [
        '-target',
        'arm64-apple-macos13.0',
        `-${level}`,
        '-g0',
        '-w',
        '-shared',
        `-I${join(root, 'brotli-1.2.0', 'c', 'include')}`,
        ...sources,
        '-o',
        output,
      ],
      { encoding: 'utf8', maxBuffer: 1 << 26 },
    );
    if (built.status !== 0) throw new Error(`clang failed: ${built.stderr.slice(0, 2000)}`);
  }
}

async function targets(work: string): Promise<readonly Target[]> {
  return [
    {
      id: 'matrix',
      binaries: await matrixBinaries().catch(() => []),
      sources: [{ file: 'scripts/bench/quality-matrix-corpus.c' }],
      sample: 100,
    },
    {
      id: 'fixtures',
      binaries: [
        { id: 'macho-arm64-symbols', path: join(ROOT, 'fixtures/bin/macho-arm64-symbols') },
        {
          id: 'libcorpus-arm64-symbols',
          path: join(ROOT, 'fixtures/bin/libcorpus-arm64-symbols.dylib'),
        },
      ],
      sources: [
        { file: 'fixtures/source/corpus.c', includes: ['fixtures/source'] },
        { file: 'fixtures/source/check.c', includes: ['fixtures/source'] },
      ],
      sample: 100,
    },
    {
      id: 'sqlite',
      binaries: [{ id: 'sqlite3-arm64', path: join(ROOT, SQLITE_BINARY) }],
      sources: [{ file: SQLITE_SOURCE }],
      sample: 250,
      prepare: async () => {
        const path = join(ROOT, SQLITE_SOURCE);
        if (existsSync(path) && sha256(await readFile(path)) !== SQLITE_SHA256)
          throw new Error(`${SQLITE_SOURCE} is not the pinned SQLite 3.54.0 amalgamation`);
      },
    },
    {
      id: 'brotli-lib',
      binaries: BROTLI_LIBRARY_LEVELS.map((level) => ({
        id: `libbrotli-${level}`,
        path: join('<work>', 'brotli-lib', `libbrotli-${level}.dylib`),
      })),
      sources: () => brotliLibrarySources(work),
      sample: 150,
      prepare: prepareBrotliLibrary,
    },
    {
      id: 'brotli',
      binaries: [{ id: 'brotli', path: BROTLI_BINARY }],
      sources: [
        {
          file: '<work>/brotli/tools/brotli.c',
          includes: ['/opt/homebrew/include'],
        },
      ],
      sample: 80,
      prepare: async (work) => {
        for (const [path, digest] of Object.entries(BROTLI_FILES)) {
          const target = join(work, 'brotli', path);
          if (existsSync(target) && sha256(await readFile(target)) === digest) continue;
          const response = await fetch(`${BROTLI_TAG}/${path}`);
          if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (sha256(bytes) !== digest) throw new Error(`${path}: SHA-256 differs from the pin`);
          await mkdir(join(target, '..'), { recursive: true });
          await writeFile(target, bytes);
        }
      },
    },
  ];
}

/** Compile each source with the host clang (-O1 -g: called externals get declarations too)
 * and merge the DWARF truth. Cached by source hash. */
async function groundTruth(target: Target, work: string): Promise<Truth> {
  const listed = typeof target.sources === 'function' ? target.sources() : target.sources;
  const files = listed.map((source) => ({
    ...source,
    path: resolve(source.file.replace('<work>', work).replace(/^(?!\/)/, `${ROOT}/`)),
  }));
  const key = sha256(
    JSON.stringify(
      await Promise.all(files.map(async (f) => [f.path, sha256(await readFile(f.path))])),
    ),
  );
  const cache = join(work, 'truth', `${target.id}-${key.slice(0, 16)}.json`);
  if (existsSync(cache)) return JSON.parse(await readFile(cache, 'utf8')) as Truth;
  const merged: Record<string, Truth[string]> = {};
  const scratch = join(work, 'tmp');
  await mkdir(scratch, { recursive: true });
  for (const file of files) {
    const object = join(scratch, `${target.id}-${basename(file.path)}.o`);
    const include = (file.includes ?? []).map((dir) =>
      dir.startsWith('/') ? `-I${dir}` : `-I${join(ROOT, dir)}`,
    );
    const compiled = spawnSync(
      'clang',
      ['-g', '-O1', '-gdwarf-5', '-w', '-c', ...include, file.path, '-o', object],
      { encoding: 'utf8', maxBuffer: 1 << 28 },
    );
    if (compiled.status !== 0)
      throw new Error(`clang failed on ${file.path}: ${compiled.stderr.slice(0, 2000)}`);
    // The dump of SQLite is far larger than a string can be: read it line by line.
    const dump = spawn('dwarfdump', ['--debug-info', object], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const reader = new DwarfReader();
    const exited = new Promise<number | null>((done) => dump.on('close', done));
    for await (const line of createInterface({ input: dump.stdout })) reader.feed(line);
    if ((await exited) !== 0) throw new Error(`dwarfdump failed on ${object}`);
    for (const [name, fact] of Object.entries(reader.truth())) merged[name] ??= fact;
  }
  await mkdir(join(work, 'truth'), { recursive: true });
  await writeFile(cache, JSON.stringify(merged));
  return merged;
}

interface FunctionRow {
  readonly id: string;
  readonly address: string;
  readonly name: string | null;
  readonly import_stub: boolean;
}

async function listFunctions(session: BinarySession): Promise<FunctionRow[]> {
  const rows: FunctionRow[] = [];
  let cursor: string | undefined;
  do {
    const result = await session.findFunctions({
      page: { limit: 1000, ...(cursor ? { cursor } : {}) },
    });
    if (!('data' in result) || result.data === undefined) throw new Error('functions_find failed');
    for (const item of result.data.items)
      rows.push({
        id: item.id,
        address: BigInt(item.entry.value).toString(),
        name: item.display_name ?? item.original_name ?? null,
        import_stub: item.kind === 'import_stub',
      });
    cursor = result.data.page.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return rows;
}

interface BinaryReport {
  readonly id: string;
  readonly functions: number;
  readonly decompiled: number;
  readonly failed: number;
  readonly calls: number;
  readonly open_known: number;
  /** The most frequent still-open targets (unguessed direct sites with a scorable arity). */
  readonly open_top: readonly (readonly [string, number])[];
  readonly tallies: Record<Heuristic | 'any', Tally>;
  readonly population: TypePopulation;
  readonly observations: readonly FunctionObservation[];
  readonly guessed_sites: number;
  readonly applied_sites: number;
  readonly rows: readonly (GuessRow & Verdict)[];
}

async function runBinary(
  target: Target,
  binary: Target['binaries'][number],
  truth: Truth,
  work: string,
  sample: number,
): Promise<BinaryReport | { readonly id: string; readonly skipped: string }> {
  const path = binary.path.replace('<work>', work);
  if (!existsSync(path)) return { id: binary.id, skipped: `${path} is absent` };
  const session = await openBinary(path, {
    cachePath: join(work, 'cache', `${target.id}-${binary.id}`),
  });
  try {
    const functions = await listFunctions(session);
    const names = new Map(
      functions.map((fn) => [fn.address, fn.name === null ? null : cName(fn.name)]),
    );
    // Callers: defined functions of the sources, in a deterministic order.
    const candidates = functions
      .filter((fn) => !fn.import_stub && fn.name !== null && truth[cName(fn.name)] !== undefined)
      .sort((a, b) => sha256(a.name!).localeCompare(sha256(b.name!)))
      .slice(0, sample);
    const guesses: GuessRow[] = [];
    const calls: CallRow[] = [];
    const observations: FunctionObservation[] = [];
    let decompiled = 0,
      failed = 0;
    for (const fn of candidates) {
      const result = await session.decompileFunction(fn.id, { inference: 'likely' });
      if (!('data' in result) || result.data.delivery !== 'inline') {
        failed++;
        continue;
      }
      decompiled++;
      const caller = cName(fn.name!);
      const emission = expandEmission(result.data.emission);
      const inferences = emission.inferences ?? [];
      // The stack base of an escaped frame prints as a formal but is no source parameter:
      // source formals are the others, numbered without it.
      const entryOrdinals = new Set<number>();
      for (const inference of inferences)
        if (inference.details.kind === 'parameter' && inference.details.role === 'entry_storage')
          entryOrdinals.add(inference.details.ordinal);
      const sourceOrdinal = (ordinal: number): number =>
        ordinal - [...entryOrdinals].filter((entry) => entry < ordinal).length;
      const printed = emission.declaration_span
        ? parseDeclaration(
            emission.text.slice(emission.declaration_span.start, emission.declaration_span.end),
          )
        : null;
      if (printed)
        observations.push({
          name: caller,
          result_pointer: printed.result_pointer,
          params: printed.params.filter((_, index) => !entryOrdinals.has(index)),
        });
      const printedParams = inferences.filter(
        (inference) =>
          inference.details.kind === 'parameter' && inference.details.role !== 'entry_storage',
      ).length;
      for (const inference of inferences) {
        const details = inference.details;
        if (details.kind === 'call') {
          const address = details.target.kind === 'direct' ? details.target.identity.address : null;
          calls.push({
            caller,
            call_id: details.call_id,
            target_address: address,
            target_name: address === null ? null : (names.get(address) ?? null),
            arity_complete: details.arity_complete,
          });
        } else if (details.kind === 'guess' && details.subject !== 'argument_list') {
          guesses.push({
            subject: details.subject,
            caller,
            ordinal: details.ordinal === null ? null : sourceOrdinal(details.ordinal),
            printed_params: printedParams,
            heuristics: details.heuristics,
            applied: details.applied,
            sites: details.sites,
          });
        } else if (
          details.kind === 'guess' &&
          details.subject === 'argument_list' &&
          details.target.kind === 'direct'
        ) {
          const address = details.target.identity.address;
          guesses.push({
            subject: 'argument_list',
            caller,
            call_id: details.call_id,
            target_address: address,
            target_name: names.get(address) ?? null,
            heuristics: details.heuristics,
            applied: details.applied,
            arity: details.arity,
            sites: details.sites,
          });
        }
      }
    }
    const tallies = tally(guesses, truth);
    return {
      id: binary.id,
      functions: functions.length,
      decompiled,
      failed,
      calls: calls.length,
      open_known: guessableSites(calls, truth),
      open_top: openTargets(calls, guesses, truth),
      tallies,
      population: typePopulation(observations, truth, guesses),
      observations,
      guessed_sites: guesses.length,
      applied_sites: guesses.filter((guess) => guess.applied).length,
      rows: guesses.map((guess) => ({ ...guess, ...scoreGuess(guess, truth) })),
    };
  } finally {
    await session.close();
  }
}

function openTargets(
  calls: readonly CallRow[],
  guesses: readonly GuessRow[],
  truth: Truth,
): [string, number][] {
  const guessed = new Set(
    guesses.flatMap((guess) => (guess.subject === 'argument_list' ? [guess.call_id] : [])),
  );
  const counts = new Map<string, number>();
  for (const call of calls) {
    const fact = call.target_name === null ? undefined : truth[call.target_name];
    if (call.arity_complete || guessed.has(call.call_id) || !fact || fact.variadic || fact.complex)
      continue;
    counts.set(call.target_name!, (counts.get(call.target_name!) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12);
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const pct = (value: number | null): string =>
  value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;

/** Correct guesses over what the heuristic could reach: the declared pointer formals (or
 * results) proven analysis leaves integer for the type heuristics; for arity, every scored
 * guess over the open direct sites with a scorable arity (when the report has them). */
function coverageOf(
  name: Heuristic | 'any',
  t: Tally,
  openSites: number | null,
  population: TypePopulation,
): number | null {
  if (name === 'any') return openSites ? t.sites / openSites : null;
  switch (HEURISTIC_DIMENSION[name]) {
    case 'parameter_type':
      return population.open_params ? t.correct / population.open_params : null;
    case 'result_type':
      return population.open_results ? t.correct / population.open_results : null;
    case 'argument_list':
      return openSites ? t.sites / openSites : null;
  }
}

async function main(): Promise<void> {
  const label = flag('--label');
  if (!label) throw new Error('--label is required');
  const only = flag('--only')?.split(',');
  const work = resolve(flag('--work') ?? join(ROOT, '.local/r5-likely'));
  const out = resolve(flag('--out') ?? join(work, 'runs', label));
  const sampleOverride = flag('--sample');
  await mkdir(out, { recursive: true });
  const reports: Record<string, unknown> = {};
  // Pool of every scored guess, for the pooled gate decision.
  const pooled: { guesses: GuessRow[]; observations: FunctionObservation[] } = {
    guesses: [],
    observations: [],
  };
  const merged: Record<string, Truth[string]> = {};
  const markdown: string[] = [`# Likely-mode precision (${label})`, ''];
  for (const target of await targets(work)) {
    if (only && !only.includes(target.id)) continue;
    try {
      await target.prepare?.(work);
      const truth = await groundTruth(target, work);
      Object.assign(
        merged,
        Object.fromEntries(Object.entries(truth).map(([k, v]) => [`${target.id}:${k}`, v])),
      );
      const perBinary = [];
      for (const binary of target.binaries) {
        const report = await runBinary(
          target,
          binary,
          truth,
          work,
          sampleOverride ? Number(sampleOverride) : target.sample,
        );
        perBinary.push(report);
        if ('skipped' in report) {
          markdown.push(`- ${target.id}/${report.id}: skipped (${report.skipped})`);
          continue;
        }
        for (const row of report.rows)
          pooled.guesses.push(
            row.subject === 'argument_list'
              ? {
                  ...row,
                  target_name: row.target_name === null ? null : `${target.id}:${row.target_name}`,
                }
              : { ...row, caller: `${target.id}:${row.caller}` },
          );
        for (const observation of report.observations)
          pooled.observations.push({ ...observation, name: `${target.id}:${observation.name}` });
        const line = (name: Heuristic | 'any'): string => {
          const t = report.tallies[name];
          const coverage = coverageOf(name, t, report.open_known, report.population);
          return `${name}: ${t.correct}/${t.sites} sites (${pct(t.precision_sites)}), ${t.callees_correct}/${t.callees} ${name !== 'any' && HEURISTIC_DIMENSION[name] !== 'argument_list' ? 'formals/results' : 'callees'} (${pct(t.precision_callees)}), coverage ${pct(coverage)}, wrong ${t.wrong} over ${t.over} under ${t.under} variadic ${t.variadic} unscored ${t.unscored}`;
        };
        const population = report.population;
        markdown.push(
          `## ${target.id}/${report.id}`,
          `${report.decompiled}/${report.decompiled + report.failed} sampled functions decompiled; ${report.calls} call records; ${report.open_known} open direct sites with a scorable source arity; ${report.guessed_sites} guesses (${report.applied_sites} applied)`,
          `declared pointers: formals ${population.proven_params} printed as pointers by proven analysis, ${population.open_params} open; results ${population.proven_results} proven, ${population.open_results} open`,
          ...[...HEURISTICS, 'any' as const].map((name) => `- ${line(name)}`),
          `- most frequent open targets: ${report.open_top.map(([name, count]) => `${name} x${count}`).join(', ')}`,
          '',
        );
      }
      reports[target.id] = perBinary;
    } catch (error) {
      reports[target.id] = { error: String(error) };
      markdown.push(`- ${target.id}: failed (${String(error)})`);
    }
  }
  // Pooled gate: guesses of all targets against the union of their truths, keyed per target
  // so equal names in different programs never alias.
  const pooledTruth: Truth = merged;
  const pooledTallies = tally(pooled.guesses, pooledTruth);
  const pooledPopulation = typePopulation(pooled.observations, pooledTruth, pooled.guesses);
  markdown.push('## Pooled gate', '');
  for (const verdict of gate(pooledTallies)) {
    const coverage = coverageOf(
      verdict.heuristic,
      pooledTallies[verdict.heuristic],
      null,
      pooledPopulation,
    );
    markdown.push(
      `- ${verdict.heuristic}: ${verdict.sites} scored sites, precision ${pct(verdict.precision_sites)} (sites) / ${pct(verdict.precision_callees)} (${HEURISTIC_DIMENSION[verdict.heuristic] !== 'argument_list' ? 'formals/results' : 'callees'}), coverage ${pct(coverage)}: ${verdict.passes ? 'PASSES' : 'FAILS'} the 95% gate`,
    );
  }
  await writeFile(
    join(out, 'report.json'),
    JSON.stringify(
      {
        label,
        reports,
        pooled: pooledTallies,
        population: pooledPopulation,
        gate: gate(pooledTallies),
      },
      null,
      1,
    ),
  );
  await writeFile(join(out, 'report.md'), `${markdown.join('\n')}\n`);
  process.stdout.write(`${markdown.join('\n')}\nreport: ${out}\n`);
}

await main();

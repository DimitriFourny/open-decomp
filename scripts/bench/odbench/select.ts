/**
 * Corpus selection: builds `corpus.json` (committed, frozen) from the pinned inputs and sources in the
 * data store, the Open Decomp function index of this checkout and the frozen QA questions.
 *
 * Deterministic: no clock, no randomness except a seeded PRNG. `--check` rebuilds in memory and
 * compares with the committed file.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadQuestions } from '../llm-tasks/questions.js';
import { binaryPath } from './corpus.js';
import { extractDefinitions } from './sources.js';
import { CORPUS_PATH, ODBENCH_DIR, functionId, paths, sha256, sizeBucket } from './types.js';
import type {
  Corpus,
  CorpusBinary,
  CorpusFunction,
  CorpusSource,
  SizeBucket,
  Tier,
} from './types.js';

const FROZEN = '2026-10-21';
const SEED = 20261021;
const MIN_CODE_BYTES = 16;
const MAX_CODE_BYTES = 32768;
const BUCKETS: readonly SizeBucket[] = ['small', 'medium', 'large', 'huge'];
const SQLITE_FULL: Readonly<Record<SizeBucket, number>> = {
  small: 25,
  medium: 40,
  large: 25,
  huge: 10,
};
const SQLITE_QUICK: Readonly<Record<SizeBucket, number>> = {
  small: 5,
  medium: 8,
  large: 5,
  huge: 2,
};
const BROTLI_QUICK_EXTRA = 3;
const OD_API = join(resolve(ODBENCH_DIR, '../../..'), 'dist', 'src', 'api', 'index.js');

/**
 * Names the source defines once per conditional-compilation branch: the active branch (0-based, source
 * order) for the matrix builds. Any other ambiguous matrix name stops the selection.
 * crc32.c: `crc32_z` is defined under `#ifdef ARMCRC32` (inline-asm CRC32 instruction) and in the
 * `#else` branch. `clang -E -dM --target=<each matrix target> -std=c11 -ffreestanding -DZ_SOLO crc32.c`
 * defines neither `W` nor `ARMCRC32` (the preprocessed text of every target holds the generic
 * definition), so the `#else` branch is active in every cell.
 */
const ACTIVE_ALTERNATIVE: Readonly<Record<string, number>> = { 'matrix/crc32.c:crc32_z': 1 };

const SOURCES: readonly Omit<CorpusSource, 'sha256'>[] = [
  {
    id: 'sqlite3.c',
    path: 'sqlite3.c',
    origin:
      'SQLite 3.54.0 amalgamation (sqlite-autoconf-3540000.tar.gz, archive sha256 134ec0802dda5795816e25d25872d20b312cb3973438c49b30bc40b7705ea9ed)',
    url: 'https://sqlite.org/2026/sqlite-autoconf-3540000.tar.gz',
  },
  {
    id: 'brotli.c',
    path: 'brotli.c',
    origin: 'brotli v1.2.0 command-line tool source (c/tools/brotli.c)',
    url: 'https://raw.githubusercontent.com/google/brotli/v1.2.0/c/tools/brotli.c',
  },
  {
    id: 'matrix/quality-matrix-corpus.c',
    path: 'matrix/quality-matrix-corpus.c',
    origin: 'Open Decomp quality-matrix corpus (MIT), .odbench/sources/matrix/build-manifest.json',
  },
  {
    id: 'matrix/adler32.c',
    path: 'matrix/adler32.c',
    origin:
      'zlib 1.3.1 adler32.c, unmodified (Z_SOLO), sha256 of archive 9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23',
    url: 'https://zlib.net/fossils/zlib-1.3.1.tar.gz',
  },
  {
    id: 'matrix/crc32.c',
    path: 'matrix/crc32.c',
    origin:
      'zlib 1.3.1 crc32.c, unmodified (Z_SOLO), sha256 of archive 9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23',
    url: 'https://zlib.net/fossils/zlib-1.3.1.tar.gz',
  },
];
const MATRIX_SOURCES = SOURCES.filter((source) => source.id.startsWith('matrix/')).map(
  (source) => source.id,
);

// ---------------------------------------------------------------------------------------------
// Open Decomp index access (this checkout's built API)

interface OdFunction {
  readonly id: string;
  readonly va: string;
  /** C spelling of the native symbol; null when unnamed. */
  readonly name: string | null;
  readonly stub: boolean;
}

interface OdItem {
  readonly id: string;
  readonly original_name: string | null;
  readonly display_name: string | null;
  readonly entry: { readonly value: string };
  readonly kind?: 'import_stub';
}

interface OdPage<T> {
  readonly state: string;
  readonly data?: {
    readonly items: readonly T[];
    readonly page: { readonly next_cursor: string | null };
  };
  readonly error?: { readonly message: string };
}

interface OdSession {
  findFunctions(query: { page: { limit: number; cursor?: string } }): Promise<OdPage<OdItem>>;
  getFunction(
    id: string,
    query: { view: 'disassembly'; detail: 'compact'; page: { limit: number; cursor?: string } },
  ): Promise<
    OdPage<{ readonly size: number | string }> & { readonly data?: { readonly view: string } }
  >;
  close(): Promise<void>;
  completeDiscovery(): Promise<boolean>;
}

interface OdApi {
  openBinary(path: string, options: { cachePath: string }): Promise<OdSession>;
}

const hex = (value: bigint | string): string => `0x${BigInt(value).toString(16)}`;

async function withSession<T>(path: string, run: (session: OdSession) => Promise<T>): Promise<T> {
  // Runtime-selected: the OD checkout's built dist/ is not part of this module graph (and may be absent).
  const api = (await import(pathToFileURL(OD_API).href)) as OdApi;
  const cachePath = await mkdtemp(join(tmpdir(), 'odbench-select-'));
  try {
    const session = await api.openBinary(path, { cachePath });
    try {
      return await run(session);
    } finally {
      await session.close();
    }
  } finally {
    await rm(cachePath, { recursive: true, force: true });
  }
}

async function listFunctions(
  session: OdSession,
  format: CorpusBinary['format'],
): Promise<OdFunction[]> {
  // The index is partial until whole-image discovery ran (stripped binaries list no function before it);
  // `decompile({ address })` runs the same discovery on demand.
  await session.completeDiscovery();
  const out: OdFunction[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await session.findFunctions({
      page: { limit: 1000, ...(cursor ? { cursor } : {}) },
    });
    if (!page.data) throw new Error(`functions_find: ${page.error?.message ?? page.state}`);
    for (const item of page.data.items) {
      const native = item.display_name ?? item.original_name;
      const name =
        native === null || native === ''
          ? null
          : format === 'macho' && native.startsWith('_')
            ? native.slice(1)
            : native;
      out.push({ id: item.id, va: hex(item.entry.value), name, stub: item.kind === 'import_stub' });
    }
    cursor = page.data.page.next_cursor ?? undefined;
    if (cursor !== undefined) {
      if (seen.has(cursor)) throw new Error('functions_find repeated a cursor');
      seen.add(cursor);
    }
  } while (cursor !== undefined);
  return out;
}

/**
 * Instruction bytes of the function's body: the sum of its compact disassembly instruction sizes, the
 * measure of `index.tsv` `code_bytes` in the CLI export. (`FunctionSummary.ranges` is not used: for
 * functions whose extent is not yet discovered it holds only the first block.) Null when unreadable.
 */
async function codeBytes(session: OdSession, id: string): Promise<number | null> {
  let total = 0n;
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await session.getFunction(id, {
      view: 'disassembly',
      detail: 'compact',
      page: { limit: 1000, ...(cursor ? { cursor } : {}) },
    });
    if (!page.data || page.data.view !== 'disassembly') return null;
    for (const item of page.data.items) total += BigInt(item.size);
    cursor = page.data.page.next_cursor ?? undefined;
    if (cursor !== undefined) {
      if (seen.has(cursor)) throw new Error('disassembly pagination repeated a cursor');
      seen.add(cursor);
    }
  } while (cursor !== undefined);
  return Number(total);
}

// ---------------------------------------------------------------------------------------------
// Deterministic drawing

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const byVa = <T extends { readonly va: string }>(left: T, right: T): number => {
  const a = BigInt(left.va);
  const b = BigInt(right.va);
  return a < b ? -1 : a > b ? 1 : 0;
};

/** `count` items drawn without replacement from the va-sorted pool (partial Fisher-Yates), returned in va order. */
function draw<T extends { readonly va: string }>(
  pool: readonly T[],
  count: number,
  random: () => number,
): T[] {
  const items = [...pool].sort(byVa);
  const take = Math.min(count, items.length);
  for (let index = 0; index < take; index++) {
    const pick = index + Math.floor(random() * (items.length - index));
    [items[index], items[pick]] = [items[pick]!, items[index]!];
  }
  return items.slice(0, take).sort(byVa);
}

/** Per bucket quota: a bucket that runs out hands its remainder to medium. */
function quotas(
  want: Readonly<Record<SizeBucket, number>>,
  pool: readonly { readonly size: SizeBucket }[],
): Record<SizeBucket, number> {
  const available = Object.fromEntries(
    BUCKETS.map((bucket) => [bucket, pool.filter((item) => item.size === bucket).length]),
  ) as Record<SizeBucket, number>;
  const take = Object.fromEntries(
    BUCKETS.map((bucket) => [bucket, Math.min(want[bucket], available[bucket])]),
  ) as Record<SizeBucket, number>;
  const deficit = BUCKETS.reduce((sum, bucket) => sum + want[bucket] - take[bucket], 0);
  take.medium = Math.min(available.medium, take.medium + deficit);
  return take;
}

function stratified<T extends { readonly va: string; readonly size: SizeBucket }>(
  pool: readonly T[],
  want: Readonly<Record<SizeBucket, number>>,
  random: () => number,
): T[] {
  const take = quotas(want, pool);
  return BUCKETS.flatMap((bucket) =>
    draw(
      pool.filter((item) => item.size === bucket),
      take[bucket],
      random,
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Corpus build

interface Candidate {
  readonly va: string;
  readonly name: string;
  readonly code_bytes: number;
  readonly size: SizeBucket;
}

interface MatrixCell {
  readonly id: string;
  readonly target: 'macho-arm64' | 'pe-x86_64' | 'elf-x86_64';
  readonly compiler: string;
  readonly optimization: 'O0' | 'O2';
  readonly symbols: 'symbol-bearing' | 'stripped';
  readonly functions: readonly { readonly address: string; readonly name: string }[];
}

interface BuildManifest {
  readonly cells: readonly MatrixCell[];
}

interface BuildStats {
  readonly exclusions: Record<string, Record<string, number>>;
  readonly candidates: Record<string, number>;
}

async function fileSha(path: string): Promise<string> {
  return sha256(await readFile(path));
}

async function loadSources(): Promise<{ sources: CorpusSource[]; texts: Map<string, string> }> {
  const sources: CorpusSource[] = [];
  const texts = new Map<string, string>();
  for (const source of SOURCES) {
    const bytes = await readFile(join(paths.sources(), source.path));
    texts.set(source.id, bytes.toString('utf8'));
    sources.push({ ...source, sha256: sha256(bytes) });
  }
  return { sources, texts };
}

/** Function entries of one real-world binary (sqlite, brotli): candidates, exclusions and QA functions. */
async function realBinary(
  binary: CorpusBinary,
  sourceId: string,
  sourceText: string,
  qa: readonly { readonly function: string; readonly address: string }[],
  stats: BuildStats,
): Promise<{ candidates: Candidate[]; qa: Candidate[] }> {
  const exclusions: Record<string, number> = {};
  const exclude = (reason: string): void =>
    void (exclusions[reason] = (exclusions[reason] ?? 0) + 1);
  stats.exclusions[binary.id] = exclusions;
  return withSession(binaryPath(binary), async (session) => {
    const functions = await listFunctions(session, binary.format);
    const nameCount = new Map<string, number>();
    for (const fn of functions)
      if (fn.name !== null) nameCount.set(fn.name, (nameCount.get(fn.name) ?? 0) + 1);
    const measured = new Map<string, Candidate | null>();
    const measure = async (fn: OdFunction & { name: string }): Promise<Candidate | null> => {
      const cached = measured.get(fn.va);
      if (cached !== undefined) return cached;
      const bytes = await codeBytes(session, fn.id);
      const result =
        bytes === null
          ? null
          : { va: fn.va, name: fn.name, code_bytes: bytes, size: sizeBucket(bytes) };
      measured.set(fn.va, result);
      return result;
    };
    const candidates: Candidate[] = [];
    for (const fn of functions) {
      if (fn.stub) exclude('import_stub');
      else if (fn.name === null) exclude('unnamed');
      else if (fn.name.includes('.cold')) exclude('compiler_outlined_cold');
      else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fn.name)) exclude('compiler_derived_name');
      else if ((nameCount.get(fn.name) ?? 0) > 1) exclude('duplicate_name_in_binary');
      else {
        const definitions = extractDefinitions(sourceText, fn.name).length;
        if (definitions === 0) exclude('no_definition_in_source');
        else if (definitions > 1) exclude('ambiguous_definition_in_source');
        else {
          const candidate = await measure({ ...fn, name: fn.name });
          if (candidate === null) exclude('code_bytes_unreadable');
          else if (candidate.code_bytes < MIN_CODE_BYTES)
            exclude(`code_bytes_below_${MIN_CODE_BYTES}`);
          else if (candidate.code_bytes > MAX_CODE_BYTES)
            exclude(`code_bytes_above_${MAX_CODE_BYTES}`);
          else candidates.push(candidate);
        }
      }
    }
    stats.candidates[binary.id] = candidates.length;

    const forced: Candidate[] = [];
    for (const question of qa) {
      const at = functions.find((fn) => BigInt(fn.va) === BigInt(question.address));
      if (!at)
        throw new Error(
          `${binary.id}: QA function ${question.function} ${question.address} is not in the OD index`,
        );
      if (at.name !== question.function)
        throw new Error(
          `${binary.id}: ${question.address} is ${at.name ?? '(unnamed)'}, questions.json says ${question.function}`,
        );
      if (extractDefinitions(sourceText, question.function).length !== 1)
        throw new Error(
          `${binary.id}: QA function ${question.function} has no unique definition in ${sourceId}`,
        );
      const candidate = await measure({ ...at, name: question.function });
      if (candidate === null)
        throw new Error(
          `${binary.id}: QA function ${question.function} has no readable disassembly`,
        );
      if (!forced.some((entry) => entry.va === candidate.va)) forced.push(candidate);
    }
    return { candidates, qa: forced.sort(byVa) };
  });
}

function matrixBinary(cell: MatrixCell, directory: string): CorpusBinary {
  const stripped = cell.symbols === 'stripped';
  const file = `${stripped ? 'stripped' : 'symbols'}${cell.target === 'pe-x86_64' ? '.exe' : ''}`;
  const [format, arch] = cell.target.split('-') as [CorpusBinary['format'], CorpusBinary['arch']];
  return {
    id: `m-${directory}-${stripped ? 'strip' : 'sym'}`,
    path: `matrix/${directory}/${file}`,
    sha256: '',
    format,
    arch,
    opt: cell.optimization,
    stripped,
    group: 'matrix',
    origin: `Open Decomp quality-matrix build ${cell.id} (${cell.compiler}, ${stripped ? 'stripped' : 'symbols'}); build-manifest.json cell ${cell.id}`,
    sources: MATRIX_SOURCES,
  };
}

/** The matrix source (file, name, active alternative) defining each manifest function name. */
function matrixSource(
  texts: ReadonlyMap<string, string>,
  name: string,
): { file: string; name: string; alternative?: number } {
  const owners = MATRIX_SOURCES.flatMap((file) => {
    const count = extractDefinitions(texts.get(file)!, name).length;
    return count > 0 ? [{ file, count }] : [];
  });
  if (owners.length !== 1)
    throw new Error(`matrix: ${name} is defined in ${owners.length} source files`);
  const { file, count } = owners[0]!;
  if (count === 1) return { file, name };
  const alternative = ACTIVE_ALTERNATIVE[`${file}:${name}`];
  if (alternative === undefined || alternative >= count)
    throw new Error(
      `matrix: ${name} has ${count} definitions in ${file} and no ACTIVE_ALTERNATIVE entry`,
    );
  return { file, name, alternative };
}

async function buildCorpus(): Promise<{ corpus: Corpus; summary: string }> {
  const { sources, texts } = await loadSources();
  const stats: BuildStats = { exclusions: {}, candidates: {} };
  const questions = (await loadQuestions()).questions;
  const binaries: CorpusBinary[] = [];
  const functions: CorpusFunction[] = [];
  const stamp = async (binary: CorpusBinary): Promise<CorpusBinary> => {
    const done = { ...binary, sha256: await fileSha(binaryPath(binary)) };
    binaries.push(done);
    return done;
  };
  const record = (
    binary: CorpusBinary,
    entry: Candidate | (Omit<Candidate, 'name'> & { name: string | null }),
    source: CorpusFunction['source'],
    tiers: readonly Tier[],
  ): void => {
    functions.push({
      id: functionId(binary.id, entry.name, entry.va),
      binary: binary.id,
      va: entry.va,
      name: entry.name,
      source,
      code_bytes: entry.code_bytes,
      size: entry.size,
      tiers,
    });
  };
  const tierOf = (quick: boolean): readonly Tier[] => (quick ? ['quick', 'full'] : ['full']);

  // SQLite: stratified draw from the candidates without QA functions, plus every QA function.
  const sqlite = await stamp({
    id: 'sqlite3-arm64',
    path: 'sqlite3-arm64',
    sha256: '',
    format: 'macho',
    arch: 'arm64',
    opt: 'release',
    stripped: false,
    group: 'sqlite',
    origin:
      'SQLite 3.54.0 shell, macOS arm64; the binary of the archived baseline-2026-10-17 Ghidra run (llm-tasks/questions.json)',
    sources: ['sqlite3.c'],
  });
  const sqliteQa = questions.filter((question) => question.binary === sqlite.id);
  const sq = await realBinary(sqlite, 'sqlite3.c', texts.get('sqlite3.c')!, sqliteQa, stats);
  const qaVas = new Set(sq.qa.map((fn) => fn.va));
  const pool = sq.candidates.filter((fn) => !qaVas.has(fn.va));
  const sqliteFull = stratified(pool, SQLITE_FULL, mulberry32(SEED));
  const sqliteQuick = new Set(
    stratified(sqliteFull, SQLITE_QUICK, mulberry32(SEED)).map((fn) => fn.va),
  );
  const sqliteAll = [
    ...sqliteFull.map((fn) => ({ fn, quick: sqliteQuick.has(fn.va) })),
    ...sq.qa.map((fn) => ({ fn, quick: true })),
  ];
  const sqliteOrder = sqliteAll.sort((a, b) => byVa(a.fn, b.fn));

  // brotli: every candidate; quick = QA functions + a few others.
  const brotli = await stamp({
    id: 'brotli',
    path: 'brotli',
    sha256: '',
    format: 'macho',
    arch: 'arm64',
    opt: 'release',
    stripped: false,
    group: 'brotli',
    origin: 'brotli 1.2.0 command-line tool, Homebrew macOS arm64 (llm-tasks/questions.json)',
    sources: ['brotli.c'],
  });
  const brotliQa = questions.filter((question) => question.binary === brotli.id);
  const br = await realBinary(brotli, 'brotli.c', texts.get('brotli.c')!, brotliQa, stats);
  const brQaVas = new Set(br.qa.map((fn) => fn.va));
  const brOthers = br.candidates.filter((fn) => !brQaVas.has(fn.va));
  const brQuick = new Set([
    ...br.qa.map((fn) => fn.va),
    ...draw(brOthers, BROTLI_QUICK_EXTRA, mulberry32(SEED)).map((fn) => fn.va),
  ]);
  const brotliAll = [...brOthers, ...br.qa].sort(byVa);

  for (const { fn, quick } of sqliteOrder)
    record(sqlite, fn, { file: 'sqlite3.c', name: fn.name }, tierOf(quick));
  for (const fn of brotliAll)
    record(brotli, fn, { file: 'brotli.c', name: fn.name }, tierOf(brQuick.has(fn.va)));

  // Matrix: the manifest functions of the selected cells; stripped cells take names from their symbol twin.
  const manifest = JSON.parse(
    await readFile(join(paths.sources(), 'matrix', 'build-manifest.json'), 'utf8'),
  ) as BuildManifest;
  const cellOf = (id: string): MatrixCell => {
    const cell = manifest.cells.find((candidate) => candidate.id === id);
    if (!cell) throw new Error(`build-manifest.json has no cell ${id}`);
    return cell;
  };
  const targets = ['macho-arm64', 'pe-x86_64', 'elf-x86_64'] as const;
  const cells: { directory: string; cell: MatrixCell; quick: boolean }[] = [];
  for (const optimization of ['O0', 'O2'] as const)
    for (const target of targets)
      cells.push({
        directory: `${target}-apple-clang21-${optimization}`,
        cell: cellOf(`${target}-apple-clang21-${optimization}-symbol-bearing`),
        quick: target === 'elf-x86_64' && optimization === 'O2',
      });
  for (const target of targets)
    cells.push({
      directory: `${target}-llvm-clang23-O2`,
      cell: cellOf(`${target}-llvm-clang23-O2-stripped`),
      quick: target === 'pe-x86_64',
    });
  for (const { directory, cell, quick } of cells) {
    const binary = await stamp(matrixBinary(cell, directory));
    const names = new Map<string, string>(
      (cell.symbols === 'stripped'
        ? cellOf(cell.id.replace(/-stripped$/, '-symbol-bearing')).functions
        : cell.functions
      ).map((fn) => [hex(fn.address), fn.name]),
    );
    // code_bytes come from the symbol-bearing twin (a stripped image has the same text bytes and VAs):
    // whole-image discovery does not list every manifest function of a stripped image (a dense switch
    // splits into jump-table pieces), but `decompile({ address })` still selects the entry.
    const twin = {
      ...binary,
      path: binary.path.replace(/(^|\/)stripped(\.exe)?$/, '$1symbols$2'),
    };
    const found = await withSession(binaryPath(twin), async (session) => {
      const index = await listFunctions(session, binary.format);
      const entries: Candidate[] = [];
      for (const expected of cell.functions) {
        const va = hex(expected.address);
        const at = index.find((fn) => fn.va === va);
        if (!at)
          throw new Error(
            `${twin.path}: manifest function ${expected.name} ${va} is not in the OD index`,
          );
        const twinName = names.get(va);
        if (at.name !== twinName)
          throw new Error(
            `${twin.path}: ${va} is ${at.name ?? '(unnamed)'}, manifest says ${twinName ?? '(none)'}`,
          );
        const bytes = await codeBytes(session, at.id);
        if (bytes === null)
          throw new Error(`${twin.path}: ${expected.name} has no readable disassembly`);
        entries.push({ va, name: expected.name, code_bytes: bytes, size: sizeBucket(bytes) });
      }
      return entries.sort(byVa);
    });
    for (const entry of found) {
      const sourceName = names.get(entry.va);
      if (sourceName !== entry.name)
        throw new Error(
          `${binary.id}: symbol twin names ${entry.va} ${sourceName ?? '(none)'}, not ${entry.name}`,
        );
      record(
        binary,
        { ...entry, name: binary.stripped ? null : entry.name },
        matrixSource(texts, sourceName),
        tierOf(quick),
      );
    }
  }

  const order = new Map(binaries.map((binary, index) => [binary.id, index]));
  functions.sort((a, b) => order.get(a.binary)! - order.get(b.binary)! || byVa(a, b));

  const tierCounts = (tier: Tier): string => {
    const chosen = functions.filter((fn) => fn.tiers.includes(tier));
    const perBinary = binaries
      .map((binary) => [binary.id, chosen.filter((fn) => fn.binary === binary.id)] as const)
      .filter(([, list]) => list.length > 0);
    const groups = [...new Set(binaries.map((binary) => binary.group))].map(
      (group) =>
        `${group} ${chosen.filter((fn) => binaries.find((binary) => binary.id === fn.binary)?.group === group).length}`,
    );
    const buckets = BUCKETS.map(
      (bucket) => `${bucket} ${chosen.filter((fn) => fn.size === bucket).length}`,
    );
    return `${tier}: ${chosen.length} functions (${groups.join(', ')}); by size ${buckets.join(', ')}; per binary ${perBinary
      .map(([id, list]) => `${id} ${list.length}`)
      .join(', ')}`;
  };
  const exclusionText = Object.entries(stats.exclusions)
    .map(
      ([id, reasons]) =>
        `${id}: ${stats.candidates[id]} candidates after excluding ${Object.entries(reasons)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([reason, count]) => `${count} ${reason}`)
          .join(', ')}`,
    )
    .join('; ');
  const method = [
    `Selected once on ${FROZEN} by scripts/bench/odbench/select.ts (\`bun run bench select\`; \`--check\` rebuilds and compares); the committed file is frozen.`,
    `Candidates (sqlite3-arm64, brotli): functions of the Open Decomp function index of the binary, minus import stubs (kind import_stub), unnamed and compiler-derived names (outlined .cold pieces and other names with a dot), names that occur more than once in the binary, names without exactly one top-level definition in the binary's source (sources.ts extractDefinitions: prototypes do not count; names defined on several conditional-compilation branches are ambiguous), and code_bytes outside [${MIN_CODE_BYTES}, ${MAX_CODE_BYTES}] (larger functions dominate every total).`,
    `code_bytes = sum of the instruction sizes of the function's compact disassembly (getFunction view disassembly), the value of index.tsv code_bytes in the CLI export; size buckets: small < 128 <= medium < 1024 <= large < 8192 <= huge.`,
    `Exclusion counts: ${exclusionText}.`,
    `sqlite3-arm64: full = ${Object.values(SQLITE_FULL).reduce((a, b) => a + b, 0)} drawn from the candidates other than QA functions, stratified small ${SQLITE_FULL.small}, medium ${SQLITE_FULL.medium}, large ${SQLITE_FULL.large}, huge ${SQLITE_FULL.huge} (a bucket that runs out hands its remainder to medium), plus every function used by a question of scripts/bench/llm-tasks/questions.json (mapped by address, forced in regardless of size); quick = those QA functions + ${Object.values(SQLITE_QUICK).reduce((a, b) => a + b, 0)} drawn from the full draw (small ${SQLITE_QUICK.small}, medium ${SQLITE_QUICK.medium}, large ${SQLITE_QUICK.large}, huge ${SQLITE_QUICK.huge}).`,
    `brotli: full = every candidate plus the QA functions; quick = the QA functions + ${BROTLI_QUICK_EXTRA} others.`,
    `matrix: full = the 12 build-manifest functions of the 6 apple-clang21 symbol-bearing cells (macho-arm64, pe-x86_64, elf-x86_64 x O0, O2) and of the 3 llvm-clang23 -O2 stripped cells (stripped functions: name null, source from the symbol-bearing twin by address); quick = the 12 functions of elf-x86_64-apple-clang21-O2 symbols and of pe-x86_64-llvm-clang23-O2 stripped. crc32_z is defined on both branches of #ifdef ARMCRC32 in zlib crc32.c; the #else definition is active in every build (source.alternative 1; clang -E of each target defines neither W nor ARMCRC32).`,
    `PRNG: mulberry32 seeded ${SEED}; pools sorted by va before drawing (partial Fisher-Yates per bucket in order small, medium, large, huge); one fresh generator per draw.`,
    `Counts: ${tierCounts('quick')}. ${tierCounts('full')}.`,
  ].join(' ');

  const corpus: Corpus = {
    schema: 'odbench-corpus/1',
    frozen: FROZEN,
    method,
    binaries,
    sources,
    functions,
  };
  return { corpus, summary: `${tierCounts('quick')}\n${tierCounts('full')}` };
}

// ---------------------------------------------------------------------------------------------

function diffSummary(committed: Corpus, rebuilt: Corpus): string {
  const lines: string[] = [];
  const compare = <T extends { readonly id: string }>(
    label: string,
    before: readonly T[],
    after: readonly T[],
  ): void => {
    const old = new Map(before.map((item) => [item.id, JSON.stringify(item)]));
    const next = new Map(after.map((item) => [item.id, JSON.stringify(item)]));
    const added = [...next.keys()].filter((id) => !old.has(id));
    const removed = [...old.keys()].filter((id) => !next.has(id));
    const changed = [...next.keys()].filter((id) => old.has(id) && old.get(id) !== next.get(id));
    if (added.length + removed.length + changed.length === 0) return;
    lines.push(`${label}: +${added.length} -${removed.length} ~${changed.length}`);
    for (const [mark, ids] of [
      ['+', added],
      ['-', removed],
      ['~', changed],
    ] as const)
      for (const id of ids.slice(0, 10)) lines.push(`  ${mark} ${id}`);
  };
  compare('binaries', committed.binaries, rebuilt.binaries);
  compare('sources', committed.sources, rebuilt.sources);
  compare('functions', committed.functions, rebuilt.functions);
  if (committed.frozen !== rebuilt.frozen)
    lines.push(`frozen: ${committed.frozen} -> ${rebuilt.frozen}`);
  if (committed.method !== rebuilt.method) lines.push('method text differs');
  return lines.join('\n');
}

/** Writes `corpus.json`, or (check) verifies that rebuilding reproduces the committed file byte for byte. */
export async function selectCorpus(opts: { check: boolean }): Promise<void> {
  const { corpus, summary } = await buildCorpus();
  const text = `${JSON.stringify(corpus, null, 2)}\n`;
  if (opts.check) {
    const committed = await readFile(CORPUS_PATH, 'utf8');
    if (committed !== text) {
      const detail = diffSummary(JSON.parse(committed) as Corpus, corpus);
      throw new Error(
        `corpus.json does not reproduce from the current inputs:\n${detail || 'formatting differs'}`,
      );
    }
    console.log(`corpus.json reproduces (${corpus.functions.length} functions)\n${summary}`);
    return;
  }
  await writeFile(CORPUS_PATH, text);
  console.log(`wrote ${CORPUS_PATH}\n${summary}`);
}

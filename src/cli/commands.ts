import { openBinary, BinaryOpenError, FunctionSelectionError } from '../api/index.js';
import type { BinarySession, FunctionSelector } from '../api/index.js';
import { caveats, distinctDiagnostics, entityIdSchema, sliceIdSchema } from '../core/index.js';
import type { ToolResult, WireDiagnostic, WireJob } from '../core/index.js';
import { exportBinary } from './export.js';
import { inferenceSchema, languageSchema, loadSettings, viewSchema } from '../settings/index.js';
import type { Settings } from '../settings/index.js';

type Command = 'functions' | 'decompile' | 'export' | 'types';
interface Arguments {
  command: Command;
  binary: string;
  json: boolean;
  cachePath?: string;
  sliceId?: string;
  /** Explicit `--analysis-cache` / `--no-analysis-cache`; absent means the settings decide. */
  analysisCache?: boolean;
  /** `--no-open-job`: open without the open-time job. */
  noOpenJob: boolean;
  /** `--unit-store-mib N`: the project's byte cap on persisted native units. */
  unitStoreBytes?: number;
  settingsPath?: string;
  name?: string;
  selector?: FunctionSelector;
  emitter?: 'c-like' | 'python-like';
  view?: 'source' | 'checked';
  inference?: 'proven' | 'likely';
  out?: string;
  jobs?: number;
}
type ParsedArguments = Arguments | { help: Command };
type FunctionsResult = ToolResult<'functions_find'>;
type FunctionRow = Extract<FunctionsResult, { data: unknown }>['data']['items'][number];
type AnalysisResult =
  | FunctionsResult
  | ToolResult<'function_decompile'>
  | ToolResult<'project_open'>
  | ToolResult<'binary_info'>;

const settingsOption = '[--settings PATH]';
const cacheOptions =
  '[--cache PATH] [--slice ID] [--analysis-cache|--no-analysis-cache] [--no-open-job] [--unit-store-mib N]';
const usage = {
  functions: `open-decomp functions BINARY [--name TEXT] [--json] ${cacheOptions} ${settingsOption}`,
  decompile: `open-decomp decompile BINARY (--function NAME | --id ID | --address va:0x.../rva:0x.../file:0x...) [--language c-like|python-like] [--view source|checked] [--inference proven|likely] [--json] ${cacheOptions} ${settingsOption}`,
  export: `open-decomp export BINARY --out DIR [--language c-like|python-like] [--inference proven|likely] [--jobs N] [--name SUBSTRING] ${cacheOptions} ${settingsOption}`,
  types: `open-decomp types BINARY [--json] ${cacheOptions} ${settingsOption}`,
} as const;

class UsageError extends Error {}

// Binary paths, symbol names and engine messages are untrusted terminal text.
export function terminal(value: string, limit = 8192): string {
  const escaped = value.replace(
    /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return escaped.length > limit ? `${escaped.slice(0, limit)}…` : escaped;
}
function diagnostic(item: WireDiagnostic, count = 1): void {
  process.stderr.write(
    `${terminal(item.severity)}: ${terminal(item.code)}: ${terminal(item.message)}${count > 1 ? ` (×${count})` : ''}\n`,
  );
  if (item.details?.kind === 'slice_selection') {
    for (const slice of item.details.slices)
      process.stderr.write(
        `  ${terminal(slice.id)}  ${terminal(slice.architecture)}  ${terminal(slice.subtype)}  ${slice.supported ? 'supported' : 'unsupported'}\n`,
      );
  }
}
/** One line per distinct caveat (`caveats`: counts, name lists for partial callee summaries,
 * no info diagnostics; `--json` keeps every diagnostic). Slice choices list their candidates. */
function report(result: AnalysisResult, operation: string): void {
  const all = [...result.diagnostics];
  if (
    'error' in result &&
    !result.diagnostics.some(
      (item) => item.code === result.error.code && item.message === result.error.message,
    )
  )
    all.push(result.error);
  const choices = all.filter((item) => item.details?.kind === 'slice_selection');
  for (const { diagnostic: item, count } of distinctDiagnostics(choices)) diagnostic(item, count);
  for (const { severity, code, text } of caveats(
    all.filter((item) => item.details?.kind !== 'slice_selection'),
  ))
    process.stderr.write(`${severity}: ${terminal(code)}: ${terminal(text)}\n`);
  if (result.state === 'partial')
    process.stderr.write(`warning: ${operation}: partial (${result.reason})\n`);
  else if (result.state !== 'complete' && result.state !== 'empty')
    process.stderr.write(`warning: ${operation}: ${result.state}\n`);
}
function exitCode(result: AnalysisResult): number {
  if (result.state === 'complete' || result.state === 'empty') return 0;
  return result.state === 'partial' ? 2 : 1;
}
function combineExit(current: number, next: number): number {
  return current === 1 || next === 1 ? 1 : Math.max(current, next);
}
function row(item: FunctionRow): string {
  const name = item.display_name ?? item.original_name ?? '(unnamed)';
  return `${terminal(item.id)}  ${terminal(item.entry.space)}:${terminal(item.entry.value)}  ${terminal(name)}  [${terminal(item.boundary)}, ${terminal(item.analysis)}${item.kind === 'import_stub' ? ', import stub' : ''}]`;
}
function emitterOption(value: string): 'c-like' | 'python-like' {
  const language = languageSchema.safeParse(value);
  if (!language.success) throw new UsageError('--language must be c-like or python-like');
  return language.data;
}
function inferenceOption(value: string): 'proven' | 'likely' {
  const inference = inferenceSchema.safeParse(value);
  if (!inference.success) throw new UsageError('--inference must be proven or likely');
  return inference.data;
}
function parse(args: readonly string[]): ParsedArguments {
  const command = args[0];
  if (
    command !== 'functions' &&
    command !== 'decompile' &&
    command !== 'export' &&
    command !== 'types'
  )
    throw new UsageError('Expected functions, decompile, export or types; see open-decomp --help');
  const separator = args.indexOf('--');
  if (args.slice(1, separator < 0 ? undefined : separator).includes('--help'))
    return { help: command };
  const values = new Map<string, string>();
  const positional: string[] = [];
  const allowed = [
    '--cache',
    '--slice',
    '--settings',
    '--unit-store-mib',
    ...(command === 'functions'
      ? ['--name']
      : command === 'export'
        ? ['--name', '--out', '--language', '--inference', '--jobs']
        : command === 'decompile'
          ? ['--function', '--id', '--address', '--language', '--view', '--inference']
          : []),
  ];
  let json = false,
    enableCache = false,
    disableCache = false,
    noOpenJob = false,
    positionalOnly = false;
  for (let index = 1; index < args.length; index++) {
    const argument = args[index]!;
    if (!positionalOnly && argument === '--') {
      positionalOnly = true;
      continue;
    }
    if (positionalOnly || !argument.startsWith('-')) {
      positional.push(argument);
      continue;
    }
    if (argument === '--json') {
      if (json) throw new UsageError('Duplicate option --json');
      json = true;
      continue;
    }
    if (argument === '--no-open-job') {
      if (noOpenJob) throw new UsageError('Duplicate option --no-open-job');
      noOpenJob = true;
      continue;
    }
    if (argument === '--analysis-cache' || argument === '--no-analysis-cache') {
      if (argument === '--analysis-cache' ? enableCache : disableCache)
        throw new UsageError(`Duplicate option ${argument}`);
      if (argument === '--analysis-cache') enableCache = true;
      else disableCache = true;
      if (enableCache && disableCache)
        throw new UsageError('Specify only one of --analysis-cache and --no-analysis-cache');
      continue;
    }
    const equals = argument.indexOf('=');
    const key = equals < 0 ? argument : argument.slice(0, equals);
    if (!allowed.includes(key)) throw new UsageError(`Unknown option ${terminal(key)}`);
    if (values.has(key)) throw new UsageError(`Duplicate option ${key}`);
    const value = equals < 0 ? args[++index] : argument.slice(equals + 1);
    if (value === undefined || value.length === 0 || (equals < 0 && value.startsWith('--')))
      throw new UsageError(`Missing value for ${key}`);
    values.set(key, value);
  }
  if (positional.length !== 1 || !positional[0])
    throw new UsageError('Expected exactly one BINARY path');
  const result: Arguments = { command, binary: positional[0], json, noOpenJob };
  if (enableCache) result.analysisCache = true;
  if (disableCache) result.analysisCache = false;
  const cache = values.get('--cache'),
    slice = values.get('--slice'),
    settings = values.get('--settings');
  if (cache !== undefined) result.cachePath = cache;
  if (settings !== undefined) result.settingsPath = settings;
  if (slice !== undefined) {
    if (!sliceIdSchema.safeParse(slice).success) throw new UsageError('--slice must be a slice ID');
    result.sliceId = slice;
  }
  const unitStore = values.get('--unit-store-mib');
  if (unitStore !== undefined) {
    if (!/^[1-9][0-9]{0,6}$/.test(unitStore) || Number(unitStore) > 1_048_576)
      throw new UsageError('--unit-store-mib must be an integer from 1 to 1048576');
    result.unitStoreBytes = Number(unitStore) * 1024 * 1024;
  }
  if (command === 'types') return result;
  if (command === 'functions' || command === 'export') {
    const name = values.get('--name');
    if (name !== undefined) {
      if (name.length > 4096) throw new UsageError('--name exceeds 4096 characters');
      result.name = name;
    }
    if (command === 'functions') return result;
    const out = values.get('--out');
    if (out === undefined) throw new UsageError('export requires --out DIR');
    result.out = out;
    const language = values.get('--language');
    if (language !== undefined) result.emitter = emitterOption(language);
    const inference = values.get('--inference');
    if (inference !== undefined) result.inference = inferenceOption(inference);
    const jobs = values.get('--jobs');
    if (jobs !== undefined) {
      if (!/^[1-9][0-9]{0,2}$/.test(jobs) || Number(jobs) > 32)
        throw new UsageError('--jobs must be an integer from 1 to 32');
      result.jobs = Number(jobs);
    }
    return result;
  }
  const selectors = ['--function', '--id', '--address'].filter((key) => values.has(key));
  if (selectors.length !== 1)
    throw new UsageError('Specify exactly one of --function, --id or --address');
  const key = selectors[0]!,
    value = values.get(key)!;
  if (key === '--function') {
    if (value.length > 4096) throw new UsageError('--function exceeds 4096 characters');
    result.selector = { name: value };
  } else if (key === '--id') {
    if (!entityIdSchema.safeParse(value).success)
      throw new UsageError('--id must be a function entity ID');
    result.selector = { id: value };
  } else {
    const address = /^(va|rva|file):(0x[0-9a-fA-F]{1,16})$/.exec(value);
    if (!address)
      throw new UsageError('--address must be va:0x..., rva:0x... or file:0x... (unsigned 64-bit)');
    result.selector = {
      address: { space: address[1] as 'va' | 'rva' | 'file', value: address[2]! },
    };
  }
  const language = values.get('--language');
  if (language !== undefined) result.emitter = emitterOption(language);
  const view = values.get('--view');
  if (view !== undefined) {
    const parsedView = viewSchema.safeParse(view);
    if (!parsedView.success) throw new UsageError('--view must be source or checked');
    result.view = parsedView.data;
  }
  const inference = values.get('--inference');
  if (inference !== undefined) result.inference = inferenceOption(inference);
  return result;
}
function help(command: Command): void {
  process.stdout.write(
    `Usage: ${usage[command]}\n\n${
      command === 'functions'
        ? 'List every matching function; --name performs a case-insensitive substring search.\nJSON result is {pages:[...]} with the original schema envelope for each page.'
        : command === 'export'
          ? 'Decompile every function in one process into a directory an agent can grep:\n  OUT/functions/NAME@0xADDR.c|.py  header comment + the pseudocode `decompile` prints\n  OUT/functions/NAME@0xADDR.asm    compact disassembly where decompilation failed (reason in header)\n  OUT/index.tsv  OUT/strings.tsv  OUT/imports.tsv  OUT/exports.tsv  OUT/README.txt\n--out DIR      Output directory (created; generated files are overwritten on re-run).\n--language     c-like (default) or python-like.\n--inference    proven (default) or likely: likely also closes open argument lists by gated heuristics; each guess is marked `likely_arity(...)` and recorded as a guess inference.\n--jobs N       Parallel workers (default min(4, CPUs/2)); extra workers analyze private copies of the project.\n--name TEXT    Only functions whose name contains TEXT (case-insensitive).\nPartial and failed functions are recorded in index.tsv and do not change the exit status.'
          : command === 'decompile'
            ? 'Decompile one exact, unambiguous function name, entity ID or address.\nText stdout contains only pseudocode; JSON preserves the result envelope.\n--inference proven|likely  proven (default) closes only established interfaces; likely also closes open argument lists by gated heuristics (each guess is marked `likely_arity(...)` and recorded as a guess inference; may be wrong).'
            : 'Print the image-wide merged structure types as C declarations (the names decompile uses).\nAnalyzes function bodies within the default budget; a partial result exits 2.'
    }\n\n--cache PATH  Override the sidecar cache root (default: BINARY.open-decomp).\n--slice ID    Select a binary slice.\n--analysis-cache     Force analysis caching on (overrides analysis_cache: false in a settings file).\n--no-open-job  Open without the open-time job, which prepares every function's callee unit in helper processes at open and persists it (callees first, within the unit store cap). Output and per-request work are identical either way.\n--unit-store-mib N  Byte cap of the project's persisted callee units (1..1048576 MiB; default 256). Units past it are prepared on demand.\n--no-analysis-cache  Read and write no derived analysis: no published results, reuse candidates or persisted callee summaries, and no in-process summary reuse. Import and indexes still persist. Output is identical; repeated and cross-process runs are slower.\n--settings PATH  Read settings from PATH instead of $XDG_CONFIG_HOME/open-decomp/settings.json (default ~/.config/open-decomp/settings.json). A flag beats the file; the file beats built-in defaults. See: open-decomp settings --help.\n${command === 'export' ? '' : '--json        Write {project_path,reused,result} JSON to stdout.\n'}--help        Show this help.\nProgress, project reuse and diagnostics go to stderr. Work stays in the foreground.\nExit: ${command === 'export' ? '0 all files written (even if some functions are partial/failed); 1 error/cancelled' : '0 complete/empty; 2 semantic partial; 1 error/unsupported/cancelled'}; 130 SIGINT; 143 SIGTERM.\n`,
  );
}

async function functions(
  session: BinarySession,
  args: Arguments,
  signal: AbortSignal,
  onProgress: (job: WireJob) => void,
): Promise<number> {
  const pages: FunctionsResult[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined,
    code = 0,
    count = 0;
  if (!args.json) process.stdout.write('ID  ADDRESS  NAME  [BOUNDARY, ANALYSIS]\n');
  do {
    const result = await session.findFunctions(
      {
        ...(args.name === undefined
          ? {}
          : { query: { text: args.name, match: 'contains', case_sensitive: false } }),
        page: { limit: 100, ...(cursor === undefined ? {} : { cursor }) },
      },
      { signal, onProgress },
    );
    report(result, 'functions');
    if (args.json) pages.push(result);
    if (!('data' in result)) {
      code = combineExit(code, exitCode(result));
      break;
    }
    count += result.data.items.length;
    if (!args.json) for (const item of result.data.items) process.stdout.write(`${row(item)}\n`);
    const next = result.data.page.next_cursor;
    // A delivery limit is resolved by consuming its cursor. An incomplete index
    // remains partial even after its last currently available page is consumed.
    const consumedDeliveryLimit =
      result.state === 'partial' &&
      result.reason === 'output_limit' &&
      next !== null &&
      result.data.page.index_state === 'complete';
    code = combineExit(code, consumedDeliveryLimit ? 0 : exitCode(result));
    if (result.data.page.index_state !== 'complete') code = combineExit(code, 2);
    if (next !== null && seen.has(next))
      throw new Error('Function pagination repeated a cursor; results are incomplete');
    if (next !== null) seen.add(next);
    cursor = next ?? undefined;
  } while (cursor !== undefined && !signal.aborted);
  if (args.json)
    process.stdout.write(
      `${JSON.stringify({ project_path: session.projectPath, reused: session.reused, result: { pages } })}\n`,
    );
  else if (count === 0)
    process.stderr.write(
      code === 0
        ? 'No matching functions (complete index).\n'
        : 'No matching functions returned; the result is not complete.\n',
    );
  return code;
}

/** Human commands keep worker jobs in the foreground and own their cancellation. */
export async function runAnalysisCli(args: readonly string[]): Promise<void> {
  let parsed: ParsedArguments;
  try {
    parsed = parse(args);
  } catch (error) {
    process.stderr.write(
      `error: ${terminal(error instanceof Error ? error.message : String(error))}\n`,
    );
    if (
      args[0] === 'functions' ||
      args[0] === 'decompile' ||
      args[0] === 'export' ||
      args[0] === 'types'
    )
      process.stderr.write(`Usage: ${usage[args[0]]}\n`);
    process.exitCode = 1;
    return;
  }
  if ('help' in parsed) {
    help(parsed.help);
    return;
  }
  // Built-in default < settings file < explicit flag. A bad settings file is an error, not a fallback.
  let settings: Settings;
  try {
    settings = await loadSettings(parsed.settingsPath);
  } catch (error) {
    process.stderr.write(
      `error: ${terminal(error instanceof Error ? error.message : String(error))}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const analysisCache = parsed.analysisCache ?? settings.analysis_cache;
  const cachePath = parsed.cachePath ?? settings.cache_root ?? undefined;
  const controller = new AbortController();
  let interrupted: number | undefined, session: BinarySession | undefined;
  const interrupt = (code: number): void => {
    interrupted ??= code;
    controller.abort();
  };
  const sigint = (): void => interrupt(130),
    sigterm = (): void => interrupt(143);
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  const progress = new Map<string, string>();
  const onProgress = (job: WireJob): void => {
    const phase = `${job.state}:${job.progress.phase}`;
    if (progress.get(job.id) !== phase) {
      progress.set(job.id, phase);
      process.stderr.write(
        `${terminal(job.operation)}: ${terminal(job.progress.phase)} (${terminal(job.state)})\n`,
      );
    }
  };
  let code = 0;
  try {
    session = await openBinary(parsed.binary, {
      ...(cachePath === undefined ? {} : { cachePath }),
      ...(parsed.sliceId === undefined ? {} : { sliceId: parsed.sliceId }),
      ...(analysisCache ? {} : { analysisCache: false }),
      openJob: parsed.noOpenJob ? false : {},
      ...(parsed.unitStoreBytes === undefined ? {} : { unitStoreBytes: parsed.unitStoreBytes }),
      signal: controller.signal,
      onProgress,
    });
    if (session.openJob && session.openJob.state !== 'skipped')
      process.stderr.write(
        `open-time job: ${session.openJob.state}, ${session.openJob.retained}/${session.openJob.prepared} callee units kept, ${Math.round(session.openJob.ms)} ms${session.openJob.message ? ` (${terminal(session.openJob.message)})` : ''}\n`,
      );
    process.stderr.write(
      `${session.reused ? 'Reusing' : 'Created'} project: ${terminal(session.projectPath, 32768)}\n`,
    );
    report(session.opened, 'open');
    if (parsed.command === 'functions')
      code = await functions(session, parsed, controller.signal, onProgress);
    else if (parsed.command === 'types') {
      const result = await session.types({}, { signal: controller.signal, onProgress });
      report(result, 'types');
      code = exitCode(result);
      if (parsed.json)
        process.stdout.write(
          `${JSON.stringify({ project_path: session.projectPath, reused: session.reused, result })}\n`,
        );
      else if ('data' in result && result.data.view === 'types')
        process.stdout.write(result.data.text);
    } else if (parsed.command === 'export') {
      const summary = await exportBinary(
        session,
        {
          out: parsed.out!,
          language: parsed.emitter ?? settings.export.language,
          inference: parsed.inference ?? settings.decompile.inference,
          jobs: parsed.jobs ?? settings.export.jobs ?? undefined,
          sliceId: parsed.sliceId,
          name: parsed.name,
          analysisCache,
          unitStoreBytes: parsed.unitStoreBytes,
        },
        controller.signal,
        (message) => process.stderr.write(`${terminal(message)}\n`),
      );
      process.stderr.write(
        `export: wrote ${summary.files} files, ${summary.bytes} bytes to ${terminal(parsed.out!)}: ${summary.functions} functions (${summary.complete} complete, ${summary.partial} partial, ${summary.failed} failed)${summary.incompleteIndexes.length === 0 ? '' : `; incomplete indexes (lists are lower bounds): ${summary.incompleteIndexes.join(', ')}`}\n`,
      );
    } else {
      const result = await session.decompile(parsed.selector!, {
        emitter: parsed.emitter ?? settings.decompile.language,
        view: parsed.view ?? settings.decompile.view,
        inference: parsed.inference ?? settings.decompile.inference,
        signal: controller.signal,
        onProgress,
      });
      report(result, 'decompile');
      code = exitCode(result);
      if (parsed.json)
        process.stdout.write(
          `${JSON.stringify({ project_path: session.projectPath, reused: session.reused, result })}\n`,
        );
      else if ('data' in result) {
        if (result.data.delivery !== 'inline')
          throw new Error('API returned an unmaterialized decompilation artifact');
        const text = result.data.emission.text;
        process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
      }
    }
  } catch (error) {
    code = 1;
    if (error instanceof FunctionSelectionError) {
      if (error.reason === 'incomplete') code = 2;
      process.stderr.write(`error: ${terminal(error.message)}\n`);
      for (const candidate of error.candidates) process.stderr.write(`  ${row(candidate)}\n`);
    } else {
      process.stderr.write(
        `error: ${terminal(error instanceof Error ? error.message : String(error))}\n`,
      );
      if (error instanceof BinaryOpenError) {
        report(error.result, 'open');
        code = exitCode(error.result);
        if (parsed.json)
          process.stdout.write(
            `${JSON.stringify({ project_path: error.projectPath, reused: error.reused, result: error.result })}\n`,
          );
      }
    }
  } finally {
    try {
      await session?.close();
    } catch (error) {
      code = 1;
      process.stderr.write(
        `error: closing project: ${terminal(error instanceof Error ? error.message : String(error))}\n`,
      );
    } finally {
      process.removeListener('SIGINT', sigint);
      process.removeListener('SIGTERM', sigterm);
      process.exitCode = interrupted ?? code;
    }
  }
}

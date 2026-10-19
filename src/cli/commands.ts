import { openBinary, BinaryOpenError, FunctionSelectionError } from '../api/index.js';
import type { BinarySession, FunctionSelector } from '../api/index.js';
import { entityIdSchema, sliceIdSchema } from '../core/index.js';
import type { ToolResult, WireDiagnostic, WireJob } from '../core/index.js';

type Command = 'functions' | 'decompile';
interface Arguments {
  command: Command;
  binary: string;
  json: boolean;
  cachePath?: string;
  sliceId?: string;
  name?: string;
  selector?: FunctionSelector;
  emitter?: 'c-like' | 'python-like';
  view?: 'source' | 'checked';
}
type ParsedArguments = Arguments | { help: Command };
type FunctionsResult = ToolResult<'functions_find'>;
type FunctionRow = Extract<FunctionsResult, { data: unknown }>['data']['items'][number];
type AnalysisResult =
  FunctionsResult | ToolResult<'function_decompile'> | ToolResult<'project_open'>;

const usage = {
  functions: 'open-decomp functions BINARY [--name TEXT] [--json] [--cache PATH] [--slice ID]',
  decompile:
    'open-decomp decompile BINARY (--function NAME | --id ID | --address va:0x.../rva:0x.../file:0x...) [--language c-like|python-like] [--view source|checked] [--json] [--cache PATH] [--slice ID]',
} as const;

class UsageError extends Error {}

// Binary paths, symbol names and engine messages are untrusted terminal text.
function terminal(value: string, limit = 8192): string {
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
/** One line per distinct diagnostic, in first-seen order, with its occurrence count. */
function report(result: AnalysisResult, operation: string): void {
  const distinct = new Map<string, { item: WireDiagnostic; count: number }>();
  const add = (item: WireDiagnostic): void => {
    const key = JSON.stringify([item.severity, item.code, item.message, item.details ?? null]);
    const seen = distinct.get(key);
    if (seen) seen.count++;
    else distinct.set(key, { item, count: 1 });
  };
  for (const item of result.diagnostics) add(item);
  if (
    'error' in result &&
    !result.diagnostics.some(
      (item) => item.code === result.error.code && item.message === result.error.message,
    )
  )
    add(result.error);
  for (const { item, count } of distinct.values()) diagnostic(item, count);
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
  return `${terminal(item.id)}  ${terminal(item.entry.space)}:${terminal(item.entry.value)}  ${terminal(name)}  [${terminal(item.boundary)}, ${terminal(item.analysis)}]`;
}
function parse(args: readonly string[]): ParsedArguments {
  const command = args[0];
  if (command !== 'functions' && command !== 'decompile')
    throw new UsageError('Expected functions or decompile; see open-decomp --help');
  const separator = args.indexOf('--');
  if (args.slice(1, separator < 0 ? undefined : separator).includes('--help'))
    return { help: command };
  const values = new Map<string, string>();
  const positional: string[] = [];
  const allowed = [
    '--cache',
    '--slice',
    ...(command === 'functions'
      ? ['--name']
      : ['--function', '--id', '--address', '--language', '--view']),
  ];
  let json = false,
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
  const result: Arguments = { command, binary: positional[0], json };
  const cache = values.get('--cache'),
    slice = values.get('--slice');
  if (cache !== undefined) result.cachePath = cache;
  if (slice !== undefined) {
    if (!sliceIdSchema.safeParse(slice).success) throw new UsageError('--slice must be a slice ID');
    result.sliceId = slice;
  }
  if (command === 'functions') {
    const name = values.get('--name');
    if (name !== undefined) {
      if (name.length > 4096) throw new UsageError('--name exceeds 4096 characters');
      result.name = name;
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
  if (language !== undefined) {
    if (language !== 'c-like' && language !== 'python-like')
      throw new UsageError('--language must be c-like or python-like');
    result.emitter = language;
  }
  const view = values.get('--view');
  if (view !== undefined) {
    if (view !== 'source' && view !== 'checked')
      throw new UsageError('--view must be source or checked');
    result.view = view;
  }
  return result;
}
function help(command: Command): void {
  process.stdout.write(
    `Usage: ${usage[command]}\n\n${
      command === 'functions'
        ? 'List every matching function; --name performs a case-insensitive substring search.\nJSON result is {pages:[...]} with the original schema envelope for each page.'
        : 'Decompile one exact, unambiguous function name, entity ID or address.\nText stdout contains only pseudocode; JSON preserves the result envelope.'
    }\n\n--cache PATH  Override the sidecar cache root (default: BINARY.open-decomp).\n--slice ID    Select a binary slice.\n--json        Write {project_path,reused,result} JSON to stdout.\n--help        Show this help.\nProgress, project reuse and diagnostics go to stderr. Work stays in the foreground.\nExit: 0 complete/empty; 2 semantic partial; 1 error/unsupported/cancelled; 130 SIGINT; 143 SIGTERM.\n`,
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
    if (args[0] === 'functions' || args[0] === 'decompile')
      process.stderr.write(`Usage: ${usage[args[0]]}\n`);
    process.exitCode = 1;
    return;
  }
  if ('help' in parsed) {
    help(parsed.help);
    return;
  }
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
      ...(parsed.cachePath === undefined ? {} : { cachePath: parsed.cachePath }),
      ...(parsed.sliceId === undefined ? {} : { sliceId: parsed.sliceId }),
      signal: controller.signal,
      onProgress,
    });
    process.stderr.write(
      `${session.reused ? 'Reusing' : 'Created'} project: ${terminal(session.projectPath, 32768)}\n`,
    );
    report(session.opened, 'open');
    if (parsed.command === 'functions')
      code = await functions(session, parsed, controller.signal, onProgress);
    else {
      const result = await session.decompile(parsed.selector!, {
        ...(parsed.emitter === undefined ? {} : { emitter: parsed.emitter }),
        ...(parsed.view === undefined ? {} : { view: parsed.view }),
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

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { toolSchemas } from '../../src/core/index.js';
import type {
  ToolInput,
  ToolName,
  ToolResult,
  WireArtifact,
  WireDiagnostic,
} from '../../src/core/index.js';

// Usage: node --import tsx scripts/bench/public-surface-census.ts --out DIR
//   [--contract /retained/contract.json] [--binary corpus-arm64] [--function NAME]
//   [--surface mcp|cli|both]
//
// Public-surface census: every contract function through the REAL MCP stdio server
// (spawned from source, server defaults, tool defaults, default functions_find page)
// and through the ordinary CLI commands, in both dialects, first and cached. Wall
// time is diagnostic only. Nothing here raises a budget, page size or limit, and no
// prototype/annotation is supplied. Each partial/failed result is classified from
// the actual result fields:
//   failed                 state failed/unsupported/cancelled (error code in evidence)
//   resource_limit         reason budget, diagnostic details.kind=limit, or coverage
//                          reason naming a (sub-)budget/deadline/limit
//   missing_instructions   decode coverage not complete, or an unmapped diagnostic
//   missing_graph          lift/analysis coverage incomplete for control-flow reasons
//   unresolved_semantics   reason unsupported_subset, reconstruction coverage partial,
//                          or unavailable_semantics warnings about source interfaces
//   metadata_gap           reason incomplete_index, or unavailable_semantics naming
//                          image-wide discovery / imported-metadata indexes
//   delivery_limit         reason output_limit: only the delivery wrapper overflowed;
//                          the semantic class comes from the published artifact body
// A function whose body was fully decoded and lifted but whose result is partial only
// because of the image-wide index is therefore metadata_gap, not missing code.
const flags = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]!,
    value = process.argv[i + 1];
  assert.ok(key.startsWith('--') && value !== undefined, `Malformed argument ${key}`);
  flags.set(key, value);
}
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const outDir = resolve(flags.get('--out') ?? '');
assert.ok(flags.has('--out'), '--out DIR is required');
const contractPath = resolve(
  flags.get('--contract') ?? '/tmp/open-decomp-ghidra-compare.sfUkLc/contract.json',
);
const surfaceFlag = flags.get('--surface') ?? 'both';
assert.ok(['mcp', 'cli', 'both'].includes(surfaceFlag));
const contract = JSON.parse(await readFile(contractPath, 'utf8')) as {
  binaries: { path: string; functions: string[] }[];
};
const selected = contract.binaries.filter(
  (entry) => !flags.has('--binary') || basename(entry.path) === flags.get('--binary'),
);
assert.ok(selected.length > 0, 'No contract binary selected');
const dialects = ['c-like', 'python-like'] as const;
type Dialect = (typeof dialects)[number];

await mkdir(outDir, { recursive: true });
const calls: WriteStream = createWriteStream(join(outDir, 'calls.jsonl'));
const bigintJson = (_: string, value: unknown): unknown =>
  typeof value === 'bigint' ? `0x${value.toString(16)}` : value;
const record = (value: Record<string, unknown>): void => {
  calls.write(`${JSON.stringify(value, bigintJson)}\n`);
};

// ---------------------------------------------------------------- classification
type Limitation =
  | 'none'
  | 'failed'
  | 'resource_limit'
  | 'missing_instructions'
  | 'missing_graph'
  | 'unresolved_semantics'
  | 'metadata_gap'
  | 'delivery_limit';
const priority: Limitation[] = [
  'failed',
  'resource_limit',
  'missing_instructions',
  'missing_graph',
  'unresolved_semantics',
  'metadata_gap',
  'delivery_limit',
];
interface Classification {
  primary: Limitation;
  classes: Limitation[];
  evidence: string[];
}
interface Envelope {
  state: string;
  reason?: string;
  coverage?: { layer: string; state: string; reasons: string[] }[];
  diagnostics?: WireDiagnostic[];
  error?: WireDiagnostic;
  data?: { delivery?: string; delivery_reason?: string; cache?: string };
}
const BUDGET_TEXT = /sub-budget|budget|deadline|work limit|limit/i;
const GRAPH_TEXT = /control flow|indirect|jump table|branch target|unreachable|cfg|graph/i;
const INSTRUCTION_TEXT = /unmapped|undecoded|truncated|undecodable|decode/i;
const METADATA_TEXT = /image-wide|imported metadata|native-name|discovery remains partial|index/i;
function classify(result: Envelope): Classification {
  const classes = new Set<Limitation>();
  const evidence: string[] = [];
  const add = (item: Limitation, why: string): void => {
    classes.add(item);
    if (!evidence.includes(`${item}: ${why}`)) evidence.push(`${item}: ${why}`);
  };
  if (result.state === 'failed' || result.state === 'unsupported' || result.state === 'cancelled') {
    add(
      'failed',
      `${result.state}${result.error ? ` ${result.error.code}: ${result.error.message}` : ''}`,
    );
    if (result.error?.details?.kind === 'limit')
      add(
        'resource_limit',
        `${result.error.details.resource} ${result.error.details.consumed}/${result.error.details.limit}`,
      );
  }
  if (result.state === 'partial') {
    if (result.reason === 'budget') add('resource_limit', 'partial reason budget');
    else if (result.reason === 'output_limit') add('delivery_limit', 'partial reason output_limit');
    else if (result.reason === 'incomplete_index')
      add('metadata_gap', 'partial reason incomplete_index');
    else if (result.reason === 'unsupported_subset')
      add('unresolved_semantics', 'partial reason unsupported_subset');
  }
  for (const layer of result.coverage ?? []) {
    if (layer.state === 'complete') continue;
    if (layer.layer === 'decode' || layer.layer === 'format')
      add(
        layer.layer === 'decode' ? 'missing_instructions' : 'metadata_gap',
        `${layer.layer} coverage ${layer.state}`,
      );
    for (const reason of layer.reasons) {
      const text = reason.slice(0, 200);
      if (BUDGET_TEXT.test(reason)) add('resource_limit', `${layer.layer}: ${text}`);
      else if (layer.layer === 'decode' && INSTRUCTION_TEXT.test(reason))
        add('missing_instructions', `${layer.layer}: ${text}`);
      else if (GRAPH_TEXT.test(reason)) add('missing_graph', `${layer.layer}: ${text}`);
      else if (layer.layer === 'reconstruction')
        add('unresolved_semantics', `${layer.layer}: ${text}`);
      else if (layer.layer === 'lift' || layer.layer === 'analysis')
        add('unresolved_semantics', `${layer.layer}: ${text}`);
      else if (layer.layer === 'abi') add('unresolved_semantics', `${layer.layer}: ${text}`);
      else add('metadata_gap', `${layer.layer}: ${text}`);
    }
  }
  for (const item of [...(result.diagnostics ?? []), ...(result.error ? [result.error] : [])]) {
    if (item.details?.kind === 'limit')
      add(
        'resource_limit',
        `${item.details.resource} ${item.details.consumed}/${item.details.limit}`,
      );
    else if (
      item.code === 'resource_limit' &&
      !/available in the analysis artifact/.test(item.message)
    )
      add('resource_limit', item.message.slice(0, 200));
    else if (item.code === 'unmapped') add('missing_instructions', item.message.slice(0, 200));
    else if (item.code === 'unavailable_semantics' && item.severity !== 'info') {
      if (METADATA_TEXT.test(item.message) && !/source|interface|return|call/i.test(item.message))
        add('metadata_gap', item.message.slice(0, 200));
      else if (/work sub-budget|budget/i.test(item.message))
        add('resource_limit', item.message.slice(0, 200));
      else add('unresolved_semantics', item.message.slice(0, 200));
    }
  }
  const ordered = priority.filter((item) => classes.has(item));
  return { primary: ordered[0] ?? 'none', classes: ordered, evidence: evidence.slice(0, 12) };
}
function diagnosticSummary(items: readonly WireDiagnostic[] | undefined) {
  const grouped = new Map<
    string,
    { code: string; severity: string; message: string; count: number; details?: unknown }
  >();
  for (const item of items ?? []) {
    const key = `${item.code}\0${item.severity}\0${item.message}`;
    const found = grouped.get(key);
    if (found) found.count++;
    else
      grouped.set(key, {
        code: item.code,
        severity: item.severity,
        message: item.message.slice(0, 400),
        count: 1,
        ...(item.details === undefined ? {} : { details: item.details }),
      });
  }
  return [...grouped.values()];
}
function envelopeFacts(result: Envelope) {
  return {
    state: result.state,
    reason: result.reason ?? null,
    delivery: result.data?.delivery ?? null,
    delivery_reason: result.data?.delivery_reason ?? null,
    cache: result.data?.cache ?? null,
    error: result.error
      ? {
          code: result.error.code,
          message: result.error.message.slice(0, 400),
          details: result.error.details ?? null,
        }
      : null,
    diagnostics: diagnosticSummary(result.diagnostics),
    coverage: (result.coverage ?? []).map((layer) => ({
      layer: layer.layer,
      state: layer.state,
      reasons: layer.reasons.map((r) => r.slice(0, 200)),
    })),
  };
}

// ---------------------------------------------------------------- MCP surface
interface Wire {
  in: number;
  out: number;
  messages: number;
}
interface McpSession {
  client: Client;
  wire: Wire;
  protocolErrors: Error[];
  stderr: () => string;
  close: () => Promise<void>;
}
async function connect(projectRoot: string, inputsRoot: string): Promise<McpSession> {
  const wire: Wire = { in: 0, out: 0, messages: 0 };
  const protocolErrors: Error[] = [];
  let stderr = '';
  const client = new Client(
    { name: 'open-decomp-public-surface-census', version: '0.1.0' },
    { capabilities: {} },
  );
  // Server flags are the documented defaults: only authorized roots are supplied.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--import',
      'tsx',
      join(repo, 'src/cli/entry.ts'),
      'mcp',
      'start',
      '--root',
      projectRoot,
      '--root',
      inputsRoot,
    ],
    cwd: repo,
    stderr: 'pipe',
    maxBufferSize: 2 * 1024 * 1024,
  });
  client.onerror = (error) => protocolErrors.push(error);
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-8192);
  });
  try {
    await client.connect(transport);
  } catch (cause) {
    throw new Error(`MCP server failed to start: ${stderr.slice(-600)}`, { cause });
  }
  const send = transport.send.bind(transport);
  transport.send = async (message) => {
    wire.out += Buffer.byteLength(JSON.stringify(message), 'utf8') + 1;
    return send(message);
  };
  const received = transport.onmessage;
  transport.onmessage = (message) => {
    wire.in += Buffer.byteLength(JSON.stringify(message), 'utf8') + 1;
    wire.messages++;
    received?.(message);
  };
  return { client, wire, protocolErrors, stderr: () => stderr, close: () => client.close() };
}

interface Measured<T> {
  value: T;
  ms: number;
  bytes_in: number;
  bytes_out: number;
}
async function measure<T>(session: McpSession, work: () => Promise<T>): Promise<Measured<T>> {
  const before = { ...session.wire };
  const start = performance.now();
  const value = await work();
  return {
    value,
    ms: Math.round((performance.now() - start) * 10) / 10,
    bytes_in: session.wire.in - before.in,
    bytes_out: session.wire.out - before.out,
  };
}
interface ToolCall<K extends ToolName> {
  result: ToolResult<K>;
  links: { uri: string; name?: string }[];
  is_error: boolean;
  parse_error: string | null;
  error_text: string | null;
}
async function callTool<K extends ToolName>(
  session: McpSession,
  name: K,
  args: ToolInput<K>,
): Promise<ToolCall<K>> {
  const response = await session.client.callTool(
    { name, arguments: args as Record<string, unknown> },
    { timeout: 900_000 },
  );
  const links = response.content
    .filter((block) => block.type === 'resource_link')
    .map((block) => ({ uri: block.uri, name: block.name }));
  const errorText = response.isError
    ? response.content
        .flatMap((block) => (block.type === 'text' ? [block.text.slice(0, 600)] : []))
        .join(' ')
    : null;
  let parseError: string | null = null;
  let result: unknown = response.structuredContent;
  if (result === undefined) parseError = 'no structuredContent';
  else {
    const parsed = toolSchemas[name].output.safeParse(result);
    if (!parsed.success) parseError = parsed.error.issues[0]?.message ?? 'schema mismatch';
    else result = parsed.data;
  }
  // A schema mismatch is recorded as an anomaly; the raw envelope is still classified.
  return {
    result: result as ToolResult<K>,
    links,
    is_error: response.isError === true,
    parse_error: parseError,
    error_text: errorText,
  };
}

const pageMeta = (part: { _meta?: Record<string, unknown> }) =>
  part._meta?.['open-decomp/artifact'] as
    { length: number; next_offset: string | null; next_uri: string | null } | undefined;
/** Follow the published resource_link and next_uri pages exactly as an agent would. */
async function readArtifact(
  session: McpSession,
  link: string,
  artifact: WireArtifact | undefined,
  context: object,
) {
  const chunks: Buffer[] = [];
  let uri: string | null = link,
    pages = 0,
    error: string | null = null,
    ms = 0,
    bytesIn = 0,
    maxPageBytes = 0;
  while (uri !== null && pages < 100_000) {
    pages++;
    try {
      const page = await measure(session, () =>
        session.client.readResource({ uri: uri! }, { cacheMode: 'bypass', timeout: 300_000 }),
      );
      ms += page.ms;
      bytesIn += page.bytes_in;
      maxPageBytes = Math.max(maxPageBytes, page.bytes_in);
      const part = page.value.contents[0] as
        { text?: string; blob?: string; _meta?: Record<string, unknown> } | undefined;
      if (!part || page.value.contents.length !== 1)
        throw new Error('resource page did not contain exactly one part');
      const meta = pageMeta(part);
      if (!meta) throw new Error('resource page lacks open-decomp/artifact metadata');
      const bytes =
        part.text !== undefined
          ? Buffer.from(part.text, 'utf8')
          : Buffer.from(part.blob ?? '', 'base64');
      chunks.push(bytes);
      uri = meta.next_uri;
    } catch (cause) {
      error = cause instanceof Error ? cause.message.slice(0, 400) : String(cause);
      break;
    }
  }
  const bytes = Buffer.concat(chunks);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const verified =
    artifact === undefined
      ? null
      : digest === artifact.sha256 && BigInt(bytes.length) === BigInt(artifact.size);
  record({
    kind: 'artifact_read',
    ...context,
    pages,
    bytes: bytes.length,
    wire_bytes_in: bytesIn,
    max_page_wire_bytes: maxPageBytes,
    ms,
    digest_verified: verified,
    error,
  });
  return { bytes, pages, ms, wire_bytes_in: bytesIn, verified, error };
}

interface Cell {
  tool: string;
  phase: string;
  state: string;
  reason: string | null;
  delivery: string | null;
  cache: string | null;
  ms: number;
  bytes_in: number;
  artifact_pages: number;
  artifact_ms: number;
  classification: Classification;
  semantic_state: string;
  semantic_reason: string | null;
  anomalies: string[];
}
const cells: { binary: string; function: string; dialect: Dialect; surface: string; cell: Cell }[] =
  [];
const anomalies: string[] = [];
const sweepSummaries: { binary: string; sweeps: object[] }[] = [];
const anomaly = (where: string, text: string): void => {
  anomalies.push(`${where}: ${text}`);
  process.stderr.write(`ANOMALY ${where}: ${text}\n`);
};

async function waitForJob(
  session: McpSession,
  project_id: string,
  revision: number,
  job_id: string,
  context: object,
  imported = false,
) {
  const deadline = Date.now() + 900_000;
  let polls = 0,
    totalMs = 0;
  while (Date.now() < deadline) {
    const status = await measure(session, () =>
      callTool(session, 'analysis_status', {
        project_id,
        revision,
        job_id,
      } as ToolInput<'analysis_status'>),
    );
    polls++;
    totalMs += status.ms;
    const result = status.value.result;
    record({
      kind: 'call',
      ...context,
      tool: 'analysis_status',
      poll: polls,
      state: result.state,
      ms: status.ms,
      bytes_in: status.bytes_in,
      bytes_out: status.bytes_out,
    });
    if ('data' in result) {
      const job = result.data.job;
      if (
        !['queued', 'running'].includes(job.state) &&
        (!imported || result.data.known_revision > job.input_revision || job.state !== 'completed')
      )
        return { job, known_revision: result.data.known_revision, polls, ms: totalMs, result };
    } else if (result.state === 'failed')
      return { job: null, known_revision: revision, polls, ms: totalMs, result };
    await delay(polls < 20 ? 25 : 150);
  }
  throw new Error(`Timed out awaiting job ${job_id}`);
}

interface Located {
  id: string;
  name: string;
}
async function runMcp(
  binary: string,
  path: string,
  names: string[],
  inputsRoot: string,
  projectRoot: string,
) {
  const label = basename(path);
  const projectPath = join(projectRoot, label);
  let session = await connect(projectRoot, inputsRoot);
  const ctx = (extra: object = {}) => ({ surface: 'mcp', binary: label, ...extra });
  try {
    // ---- import (default queued job)
    const importStart = performance.now();
    const open = await measure(session, () =>
      callTool(session, 'project_open', {
        source: { kind: 'import', input_path: path, project_path: projectPath },
      } as ToolInput<'project_open'>),
    );
    const opened = open.value.result;
    record({
      kind: 'call',
      ...ctx(),
      tool: 'project_open',
      phase: 'import',
      ms: open.ms,
      bytes_in: open.bytes_in,
      bytes_out: open.bytes_out,
      ...envelopeFacts(opened as Envelope),
    });
    assert.ok(
      opened.project_id !== null && opened.revision !== null,
      `import failed: ${JSON.stringify(opened).slice(0, 500)}`,
    );
    const project_id = opened.project_id;
    let revision = opened.revision;
    if ('job' in opened) {
      const done = await waitForJob(
        session,
        project_id,
        revision,
        opened.job.id,
        ctx({ phase: 'import' }),
        true,
      );
      revision = done.known_revision;
      record({
        kind: 'import_done',
        ...ctx(),
        wall_ms: Math.round(performance.now() - importStart),
        job_state: done.job?.state ?? null,
        polls: done.polls,
        status_ms: done.ms,
        known_revision: revision,
        diagnostics: diagnosticSummary(done.job?.diagnostics),
      });
      if (done.job?.state !== 'completed') throw new Error(`import ended ${done.job?.state}`);
    }
    const scope = () => ({ project_id, revision });
    const info = await measure(session, () =>
      callTool(session, 'binary_info', scope() as ToolInput<'binary_info'>),
    );
    const infoResult = info.value.result;
    assert.ok(
      'data' in infoResult && infoResult.data.view === 'summary',
      'binary_info summary unavailable',
    );
    const image_id = infoResult.data.image.id;
    record({
      kind: 'call',
      ...ctx(),
      tool: 'binary_info',
      state: infoResult.state,
      ms: info.ms,
      bytes_in: info.bytes_in,
      bytes_out: info.bytes_out,
    });

    // ---- navigation sweeps: every paged read tool, default page size, cursors followed
    interface SweepStats {
      tool: string;
      label: string;
      limit: number | null;
      pages: number;
      items: number;
      max_bytes: number;
      max_ms: number;
      total_ms: number;
      duplicates: number;
      states: Record<string, number>;
      index_states: Record<string, number>;
      reasons: Record<string, number>;
      errors: number;
    }
    const sweepTool = async (
      tool: 'functions_find' | 'symbols_find' | 'strings_find' | 'binary_info',
      extra: object,
      sweepLabel: string,
      limit?: number,
    ): Promise<{ stats: SweepStats; keys: string[] }> => {
      const stats: SweepStats = {
        tool,
        label: sweepLabel,
        limit: limit ?? null,
        pages: 0,
        items: 0,
        max_bytes: 0,
        max_ms: 0,
        total_ms: 0,
        duplicates: 0,
        states: {},
        index_states: {},
        reasons: {},
        errors: 0,
      };
      const keys: string[] = [],
        seen = new Set<string>(),
        cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const pageArg =
          limit === undefined && cursor === undefined
            ? {}
            : {
                page: {
                  ...(limit === undefined ? {} : { limit }),
                  ...(cursor === undefined ? {} : { cursor }),
                },
              };
        const page = await measure(session, () =>
          callTool(session, tool, { ...scope(), image_id, ...extra, ...pageArg } as ToolInput<
            typeof tool
          >),
        );
        const result = page.value.result as Envelope & {
          data?: { items?: unknown[]; page: { next_cursor: string | null; index_state: string } };
        };
        stats.pages++;
        stats.max_bytes = Math.max(stats.max_bytes, page.bytes_in);
        stats.max_ms = Math.max(stats.max_ms, page.ms);
        stats.total_ms += page.ms;
        stats.states[result.state] = (stats.states[result.state] ?? 0) + 1;
        if (result.reason) stats.reasons[result.reason] = (stats.reasons[result.reason] ?? 0) + 1;
        record({
          kind: 'call',
          ...ctx({ phase: 'sweep', sweep: sweepLabel }),
          tool,
          page: stats.pages,
          ms: page.ms,
          bytes_in: page.bytes_in,
          bytes_out: page.bytes_out,
          is_error: page.value.is_error,
          error_text: page.value.error_text,
          items: result.data?.items?.length ?? null,
          index_state: result.data?.page.index_state ?? null,
          ...envelopeFacts(result),
        });
        if (!result.data || !result.data.items) {
          stats.errors++;
          anomaly(
            `${label} ${sweepLabel} page ${stats.pages}`,
            `navigation failed: ${result.state} ${page.value.error_text ?? ''}`,
          );
          break;
        }
        stats.index_states[result.data.page.index_state] =
          (stats.index_states[result.data.page.index_state] ?? 0) + 1;
        for (const item of result.data.items) {
          const key = JSON.stringify(item);
          if (seen.has(key)) stats.duplicates++;
          seen.add(key);
          keys.push(key);
        }
        stats.items += result.data.items.length;
        cursor = result.data.page.next_cursor ?? undefined;
        if (cursor !== undefined) {
          if (cursors.has(cursor)) {
            stats.errors++;
            anomaly(`${label} ${sweepLabel}`, 'cursor repeated');
            break;
          }
          cursors.add(cursor);
        }
      } while (cursor !== undefined);
      record({ kind: 'sweep', ...ctx(), ...stats });
      process.stderr.write(
        `[${label}] sweep ${sweepLabel}: ${stats.pages} pages, ${stats.items} items, max page ${stats.max_bytes} B, max ${stats.max_ms} ms, states ${JSON.stringify(stats.states)}\n`,
      );
      if (stats.duplicates > 0)
        anomaly(`${label} ${sweepLabel}`, `${stats.duplicates} duplicate items across pages`);
      return { stats, keys };
    };
    const sweeps: SweepStats[] = [];
    const defaultFunctions = await sweepTool('functions_find', {}, 'functions_find default');
    sweeps.push(defaultFunctions.stats);
    const smallFunctions = await sweepTool('functions_find', {}, 'functions_find limit 10', 10);
    sweeps.push(smallFunctions.stats);
    if (
      defaultFunctions.keys.length !== smallFunctions.keys.length ||
      defaultFunctions.keys.some((key, index) => key !== smallFunctions.keys[index])
    )
      anomaly(
        `${label} functions_find`,
        'default-page and limit-10 sweeps returned different ordered functions',
      );
    sweeps.push((await sweepTool('symbols_find', {}, 'symbols_find default')).stats);
    sweeps.push((await sweepTool('strings_find', {}, 'strings_find default')).stats);
    for (const view of [
      'headers',
      'sections',
      'mappings',
      'entry_points',
      'relocations',
      'hints',
      'capabilities',
    ] as const)
      sweeps.push((await sweepTool('binary_info', { view }, `binary_info ${view}`)).stats);
    sweepSummaries.push({ binary: label, sweeps });

    // ---- locate each selected function with a default-size page, following cursors
    const located = new Map<string, Located>();
    for (const name of names) {
      let pageCursor: string | undefined,
        pages = 0,
        found: Located | undefined;
      do {
        const page = await measure(session, () =>
          callTool(session, 'functions_find', {
            ...scope(),
            image_id,
            query: { text: name, match: 'contains', case_sensitive: false },
            ...(pageCursor === undefined ? {} : { page: { cursor: pageCursor } }),
          } as ToolInput<'functions_find'>),
        );
        const result = page.value.result;
        pages++;
        record({
          kind: 'call',
          ...ctx({ function: name, phase: 'locate' }),
          tool: 'functions_find',
          page: pages,
          ms: page.ms,
          bytes_in: page.bytes_in,
          bytes_out: page.bytes_out,
          is_error: page.value.is_error,
          error_text: page.value.error_text,
          items: 'data' in result ? result.data.items.length : null,
          index_state: 'data' in result ? result.data.page.index_state : null,
          ...envelopeFacts(result as Envelope),
        });
        if (!('data' in result)) break;
        const hit = result.data.items.find((item) =>
          [item.original_name, item.display_name].some(
            (candidate) => candidate === name || candidate === `_${name}`,
          ),
        );
        if (hit) found = { id: hit.id, name };
        pageCursor = found ? undefined : (result.data.page.next_cursor ?? undefined);
      } while (pageCursor !== undefined);
      if (found) located.set(name, found);
      else anomaly(`${label} ${name}`, 'functions_find did not locate the selected function');
    }

    // ---- per-function navigation: metadata, then references with default pages
    for (const [name, fn] of located) {
      const meta = await measure(session, () =>
        callTool(session, 'function_get', {
          ...scope(),
          function_id: fn.id,
        } as ToolInput<'function_get'>),
      );
      record({
        kind: 'call',
        ...ctx({ function: name, phase: 'navigate' }),
        tool: 'function_get',
        ms: meta.ms,
        bytes_in: meta.bytes_in,
        bytes_out: meta.bytes_out,
        is_error: meta.value.is_error,
        error_text: meta.value.error_text,
        ...envelopeFacts(meta.value.result as Envelope),
      });
      if (meta.value.is_error)
        anomaly(`${label} ${name} function_get`, meta.value.error_text ?? meta.value.result.state);
      let refCursor: string | undefined,
        refPages = 0;
      do {
        const refs = await measure(session, () =>
          callTool(session, 'xrefs_get', {
            ...scope(),
            target: { kind: 'entity', id: fn.id },
            ...(refCursor === undefined ? {} : { page: { cursor: refCursor } }),
          } as ToolInput<'xrefs_get'>),
        );
        const result = refs.value.result as Envelope & {
          data?: { items: unknown[]; page: { next_cursor: string | null } };
        };
        refPages++;
        record({
          kind: 'call',
          ...ctx({ function: name, phase: 'navigate' }),
          tool: 'xrefs_get',
          page: refPages,
          ms: refs.ms,
          bytes_in: refs.bytes_in,
          bytes_out: refs.bytes_out,
          is_error: refs.value.is_error,
          error_text: refs.value.error_text,
          items: result.data?.items.length ?? null,
          ...envelopeFacts(result),
        });
        if (!result.data) {
          anomaly(`${label} ${name} xrefs_get`, `${result.state} ${refs.value.error_text ?? ''}`);
          break;
        }
        refCursor = result.data.page.next_cursor ?? undefined;
      } while (refCursor !== undefined && refPages < 10_000);
    }

    // Queued jobs publish handles without tool-result links: use the documented page URI.
    const artifactLink = (artifact: WireArtifact): string =>
      `open-decomp://artifact/${artifact.project_id}/${artifact.revision}/${artifact.id}?offset=0x0&length=524288`;
    const resultOf = async (call: ToolCall<'function_decompile'>, context: object) => {
      // Resolve the semantic result: inline body, or the published analysis artifact.
      const result = call.result as Envelope & {
        artifacts?: WireArtifact[];
        data?: { delivery?: string; artifact_id?: string };
      };
      const out = { semantic: result as Envelope, pages: 0, ms: 0, errors: [] as string[] };
      if (result.state !== 'complete' && result.state !== 'partial') return out;
      if (result.data?.delivery !== 'artifact') return out;
      const artifact = result.artifacts?.find((item) => item.id === result.data?.artifact_id);
      const link = call.links.find((item) => item.name === result.data?.artifact_id);
      if (!artifact || !link) {
        out.errors.push('artifact delivery lacked its published artifact or resource_link');
        return out;
      }
      const read = await readArtifact(session, link.uri, artifact, context);
      out.pages = read.pages;
      out.ms = read.ms;
      if (read.error) out.errors.push(`artifact read: ${read.error}`);
      if (read.verified === false) out.errors.push('artifact digest/size mismatch');
      if (!read.error) {
        try {
          const stored = JSON.parse(read.bytes.toString('utf8')) as { result: Envelope };
          out.semantic = stored.result;
        } catch (cause) {
          out.errors.push(`artifact JSON: ${(cause as Error).message}`);
        }
      }
      return out;
    };
    const decompile = async (
      name: string,
      fn: Located,
      dialect: Dialect,
      phase: string,
      wait: boolean,
    ) => {
      const args = {
        ...scope(),
        function_id: fn.id,
        ...(wait ? { wait: true } : {}),
        ...(dialect === 'c-like' ? {} : { options: { emitter: dialect } }),
      } as ToolInput<'function_decompile'>;
      const context = { surface: 'mcp', binary: label, function: name, dialect, phase };
      let timedOut: string | null = null;
      let call: Measured<ToolCall<'function_decompile'>> | undefined;
      try {
        call = await measure(session, () => callTool(session, 'function_decompile', args));
      } catch (cause) {
        timedOut = cause instanceof Error ? cause.message.slice(0, 400) : String(cause);
      }
      if (!call) {
        record({
          kind: 'call',
          ...context,
          tool: 'function_decompile',
          state: 'transport_error',
          error_text: timedOut,
        });
        anomaly(`${label} ${name} ${dialect} ${phase}`, `transport error ${timedOut}`);
        return;
      }
      const result = call.value.result as Envelope & {
        job?: { id: string };
        artifacts?: WireArtifact[];
      };
      let semantic: Envelope = result,
        artifactPages = 0,
        artifactMs = 0,
        extraMs = 0,
        polls = 0;
      const cellAnomalies: string[] = [];
      if (call.value.parse_error) cellAnomalies.push(`response schema: ${call.value.parse_error}`);
      if (call.value.is_error && result.state !== 'failed' && result.state !== 'unsupported')
        cellAnomalies.push(`tool error: ${call.value.error_text}`);
      if ((result.state === 'queued' || result.state === 'running') && result.job) {
        // Default queued path: follow analysis_status, then the published artifact link.
        const done = await waitForJob(session, project_id, revision, result.job.id, context);
        polls = done.polls;
        extraMs = done.ms;
        const artifact = done.job?.artifacts.find(
          (item) => item.media_type === 'application/vnd.open-decomp.function+json',
        );
        if (!done.job || done.job.state !== 'completed' || !artifact) {
          cellAnomalies.push(
            `queued job ended ${done.job?.state ?? 'unknown'} without analysis artifact: ${JSON.stringify(diagnosticSummary(done.job?.diagnostics)).slice(0, 300)}`,
          );
          semantic = {
            state: done.job?.state === 'failed' ? 'failed' : 'cancelled',
            diagnostics: done.job?.diagnostics ?? [],
          } as Envelope;
        } else {
          const read = await readArtifact(session, artifactLink(artifact), artifact, context);
          artifactPages = read.pages;
          artifactMs = read.ms;
          if (read.error) cellAnomalies.push(`artifact read: ${read.error}`);
          else {
            try {
              semantic = (JSON.parse(read.bytes.toString('utf8')) as { result: Envelope }).result;
            } catch (cause) {
              cellAnomalies.push(`artifact JSON: ${(cause as Error).message}`);
            }
          }
        }
      } else {
        const resolved = await resultOf(call.value, context);
        semantic = resolved.semantic;
        artifactPages = resolved.pages;
        artifactMs = resolved.ms;
        cellAnomalies.push(...resolved.errors);
      }
      const classification = classify(
        semantic.state === result.state && result.state !== 'partial' ? result : semantic,
      );
      // The wrapper may be an output_limit projection: keep both honest.
      const wrapperLimit = result.state === 'partial' && result.reason === 'output_limit';
      if (wrapperLimit && !classification.classes.includes('delivery_limit'))
        classification.classes.push('delivery_limit');
      const facts = envelopeFacts(result);
      record({
        kind: 'call',
        ...context,
        tool: 'function_decompile',
        wait,
        ...facts,
        ms: call.ms,
        bytes_in: call.bytes_in,
        bytes_out: call.bytes_out,
        is_error: call.value.is_error,
        error_text: call.value.error_text,
        polls,
        status_ms: extraMs,
        artifact_pages: artifactPages,
        artifact_ms: artifactMs,
        semantic_state: semantic.state,
        semantic_reason: semantic.reason ?? null,
        semantic: envelopeFacts(semantic),
        classification,
        anomalies: cellAnomalies,
      });
      for (const text of cellAnomalies) anomaly(`${label} ${name} ${dialect} ${phase}`, text);
      cells.push({
        binary: label,
        function: name,
        dialect,
        surface: 'mcp',
        cell: {
          tool: 'function_decompile',
          phase,
          state: result.state,
          reason: result.reason ?? null,
          delivery: facts.delivery,
          cache: facts.cache,
          ms: call.ms + extraMs + artifactMs,
          bytes_in: call.bytes_in,
          artifact_pages: artifactPages,
          artifact_ms: artifactMs,
          classification,
          semantic_state: semantic.state,
          semantic_reason: semantic.reason ?? null,
          anomalies: cellAnomalies,
        },
      });
    };
    for (const name of names) {
      const fn = located.get(name);
      if (!fn) continue;
      for (const dialect of dialects) {
        await decompile(name, fn, dialect, 'first', true);
        await decompile(name, fn, dialect, 'cached', true);
        await decompile(name, fn, dialect, 'cached_queued_default', false);
      }
    }

    // ---- real restart: a new server process must serve from the persisted cache
    await measure(session, () =>
      callTool(session, 'project_close', scope() as ToolInput<'project_close'>),
    );
    await session.close();
    assert.deepEqual(session.protocolErrors, [], `protocol errors: ${session.stderr()}`);
    session = await connect(projectRoot, inputsRoot);
    const resume = await measure(session, () =>
      callTool(session, 'project_open', {
        source: { kind: 'resume', project_path: projectPath },
        wait: true,
      } as ToolInput<'project_open'>),
    );
    record({
      kind: 'call',
      ...ctx({ phase: 'resume' }),
      tool: 'project_open',
      ms: resume.ms,
      bytes_in: resume.bytes_in,
      bytes_out: resume.bytes_out,
      ...envelopeFacts(resume.value.result as Envelope),
    });
    if (resume.value.result.project_id !== project_id || resume.value.result.revision !== revision)
      anomaly(
        `${label} resume`,
        `identity changed: ${resume.value.result.project_id} r${resume.value.result.revision}`,
      );
    for (const name of names) {
      const fn = located.get(name);
      if (!fn) continue;
      for (const dialect of dialects) await decompile(name, fn, dialect, 'restarted', true);
    }
    assert.deepEqual(session.protocolErrors, [], `protocol errors: ${session.stderr()}`);
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------- CLI surface
interface CliRun {
  code: number | null;
  signal: string | null;
  stdout: Buffer;
  stderr: string;
  ms: number;
}
function runCli(args: string[]): Promise<CliRun> {
  let resolve!: (run: CliRun) => void;
  const promise = new Promise<CliRun>((done) => {
    resolve = done;
  });
  const start = performance.now();
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', join(repo, 'src/cli/entry.ts'), ...args],
    { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const out: Buffer[] = [];
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-65536);
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 1_800_000);
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    resolve({
      code,
      signal,
      stdout: Buffer.concat(out),
      stderr,
      ms: Math.round((performance.now() - start) * 10) / 10,
    });
  });
  return promise;
}
async function runCliSurface(path: string, names: string[], cacheRoot: string) {
  const label = basename(path);
  const cache = join(cacheRoot, label);
  await rm(cache, { recursive: true, force: true });
  const base = ['--cache', cache];
  const listing = await runCli(['functions', path, ...base]);
  record({
    kind: 'call',
    surface: 'cli',
    binary: label,
    tool: 'functions',
    phase: 'full_listing',
    exit: listing.code,
    ms: listing.ms,
    stdout_bytes: listing.stdout.length,
    rows: Math.max(0, listing.stdout.toString('utf8').split('\n').length - 2),
    stderr_tail: listing.stderr.slice(-400),
  });
  process.stderr.write(
    `[${label}] cli full listing exit ${listing.code} in ${listing.ms} ms (${listing.stdout.length} B)\n`,
  );
  for (const name of names) {
    const find = await runCli(['functions', path, '--name', name, '--json', ...base]);
    let rows = 0,
      pages = 0,
      found = false,
      states: string[] = [];
    try {
      const parsed = JSON.parse(find.stdout.toString('utf8')) as {
        result: {
          pages: {
            state: string;
            data?: { items: { original_name: string | null; display_name: string | null }[] };
          }[];
        };
      };
      pages = parsed.result.pages.length;
      states = parsed.result.pages.map((page) => page.state);
      for (const page of parsed.result.pages) {
        rows += page.data?.items.length ?? 0;
        found ||= (page.data?.items ?? []).some((item) =>
          [item.original_name, item.display_name].some(
            (candidate) => candidate === name || candidate === `_${name}`,
          ),
        );
      }
    } catch {
      /* classified below by exit/stderr */
    }
    record({
      kind: 'call',
      surface: 'cli',
      binary: label,
      function: name,
      tool: 'functions',
      phase: 'locate',
      exit: find.code,
      ms: find.ms,
      stdout_bytes: find.stdout.length,
      pages,
      rows,
      found,
      states,
      stderr_tail: find.stderr.slice(-400),
    });
    if (find.code !== 0 && !found)
      anomaly(
        `${label} ${name} cli functions`,
        `exit ${find.code}, found=${found}: ${find.stderr.slice(-200)}`,
      );
    // The contract names are unprefixed; Mach-O symbols carry their leading underscore.
    // Try the name exactly as an operator would type it, and only then the symbol name.
    let selector = name;
    const literal = await runCli([
      'decompile',
      path,
      '--function',
      name,
      '--language',
      'c-like',
      ...base,
    ]);
    const literalFailed =
      literal.stdout.length === 0 &&
      /Function search is incomplete|No function matches/.test(literal.stderr);
    record({
      kind: 'call',
      surface: 'cli',
      binary: label,
      function: name,
      dialect: 'c-like',
      tool: 'decompile',
      phase: 'contract_name',
      exit: literal.code,
      ms: literal.ms,
      stdout_bytes: literal.stdout.length,
      resolved: !literalFailed,
      stderr_tail: literal.stderr.slice(-300),
    });
    if (literalFailed) {
      selector = `_${name}`;
      anomaly(
        `${label} ${name} cli`,
        `--function ${name} did not resolve (${literal.stderr.split('\n').filter((line) => line.startsWith('error:'))[0] ?? 'no error line'}); the Mach-O symbol is ${selector}`,
      );
    }
    for (const dialect of dialects) {
      const args = ['decompile', path, '--function', selector, '--language', dialect, ...base];
      const context = { surface: 'cli', binary: label, function: name, selector, dialect };
      const phases: [string, string[]][] = [
        ['first', args],
        ['cached', args],
        ['cached_json', [...args, '--json']],
      ];
      const group: Cell[] = [];
      let jsonClassification: Classification | null = null;
      for (const [phase, runArgs] of phases) {
        const run = await runCli(runArgs);
        const stderr = run.stderr;
        const warning = /warning: decompile: (partial) \((\w+)\)|warning: decompile: (\w+)/.exec(
          stderr,
        );
        let result: Envelope | null = null;
        if (phase === 'cached_json') {
          try {
            result = (JSON.parse(run.stdout.toString('utf8')) as { result: Envelope }).result;
          } catch {
            /* reported through anomaly */
          }
        }
        const classification = result ? classify(result) : null;
        if (classification) jsonClassification = classification;
        const reused = /Reusing project/.test(stderr);
        record({
          kind: 'call',
          ...context,
          tool: 'decompile',
          phase,
          exit: run.code,
          signal: run.signal,
          ms: run.ms,
          stdout_bytes: run.stdout.length,
          reused_project: reused,
          warning: warning ? warning[0] : null,
          stderr_codes: [...stderr.matchAll(/^(?:info|warning|error): (\w+):/gm)]
            .map((match) => match[1])
            .reduce<Record<string, number>>(
              (all, code) => ({ ...all, [code!]: (all[code!] ?? 0) + 1 }),
              {},
            ),
          stderr_tail: stderr.slice(-500),
          ...(result ? { ...envelopeFacts(result), classification } : {}),
        });
        const state = result
          ? result.state
          : run.code === 0
            ? 'complete'
            : run.code === 2
              ? 'partial'
              : 'failed';
        const cellAnomalies: string[] = [];
        if (run.code === 1)
          cellAnomalies.push(
            `exit 1: ${stderr.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300)}`,
          );
        if (run.code === 2 && run.stdout.length === 0)
          cellAnomalies.push(
            `exit 2 with empty stdout: ${stderr.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300)}`,
          );
        if (phase !== 'first' && !reused) cellAnomalies.push('project was not reused on repeat');
        if (run.code === 0 && run.stdout.length === 0)
          cellAnomalies.push('exit 0 with empty stdout');
        for (const text of cellAnomalies) anomaly(`${label} ${name} ${dialect} cli ${phase}`, text);
        const cell: Cell = {
          tool: 'decompile',
          phase,
          state,
          reason: result?.reason ?? warning?.[2] ?? null,
          delivery: result?.data?.delivery ?? (run.stdout.length ? 'stdout' : null),
          cache: result?.data?.cache ?? null,
          ms: run.ms,
          bytes_in: run.stdout.length,
          artifact_pages: 0,
          artifact_ms: 0,
          classification: classification ?? { primary: 'none', classes: [], evidence: [] },
          semantic_state: state,
          semantic_reason: result?.reason ?? null,
          anomalies: cellAnomalies,
        };
        group.push(cell);
        cells.push({ binary: label, function: name, dialect, surface: 'cli', cell });
      }
      // Text runs carry only an exit code; their limitation is the JSON run's actual envelope.
      for (const cell of group) if (jsonClassification) cell.classification = jsonClassification;
    }
  }
}

// ---------------------------------------------------------------- driver
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-surface-')));
try {
  for (const entry of selected) {
    const names = flags.has('--function') ? [flags.get('--function')!] : entry.functions;
    for (const name of names)
      assert.ok(entry.functions.includes(name), `${name} is not in the contract selection`);
    const path = await realpath(entry.path);
    await mkdir(join(scratch, 'projects'), { recursive: true });
    if (surfaceFlag !== 'cli')
      await runMcp(entry.path, path, names, dirname(path), join(scratch, 'projects'));
    if (surfaceFlag !== 'mcp') await runCliSurface(path, names, join(scratch, 'cli-cache'));
  }
} finally {
  await new Promise<void>((done) => calls.end(done));
  await rm(scratch, { recursive: true, force: true });
}

// ---------------------------------------------------------------- summary
const rows: string[] = [];
const keyOf = (c: (typeof cells)[number]) =>
  `${c.binary}\0${c.function}\0${c.dialect}\0${c.surface}`;
const groups = new Map<string, typeof cells>();
for (const cell of cells) groups.set(keyOf(cell), [...(groups.get(keyOf(cell)) ?? []), cell]);
const show = (cell: Cell | undefined): string =>
  cell === undefined
    ? '-'
    : cell.state === 'queued'
      ? `queued job -> ${cell.semantic_state}${cell.semantic_reason ? `/${cell.semantic_reason}` : ''} ${Math.round(cell.ms)}ms`
      : `${cell.state}${cell.reason ? `/${cell.reason}` : ''}${cell.delivery ? ` ${cell.delivery}` : ''}${cell.cache ? ` ${cell.cache}` : ''} ${Math.round(cell.ms)}ms`;
rows.push(
  '| binary | function | dialect | surface | first | cached | restarted (mcp) / cached --json (cli) | default queued job (mcp) | primary limitation | all classes | anomalies |',
);
rows.push('|---|---|---|---|---|---|---|---|---|---|---|');
const summaryRows: object[] = [];
for (const [, group] of groups) {
  const first = group.find((item) => item.cell.phase === 'first')?.cell;
  const cached = group.find((item) => item.cell.phase === 'cached')?.cell;
  const third = group.find(
    (item) => item.cell.phase === 'restarted' || item.cell.phase === 'cached_json',
  )?.cell;
  const queued = group.find((item) => item.cell.phase === 'cached_queued_default')?.cell;
  const head = group[0]!;
  const semantic = first?.classification ?? cached?.classification;
  const issues = group.flatMap((item) => item.cell.anomalies);
  rows.push(
    `| ${head.binary} | ${head.function} | ${head.dialect} | ${head.surface} | ${show(first)} | ${show(cached)} | ${show(third)} | ${show(queued)} | ${semantic?.primary ?? '-'} | ${semantic?.classes.join(',') || 'none'} | ${issues.length ? issues.length : 0} |`,
  );
  summaryRows.push({
    binary: head.binary,
    function: head.function,
    dialect: head.dialect,
    surface: head.surface,
    first,
    cached,
    queued_default: queued,
    restarted_or_json: third,
    classification: semantic,
    anomalies: issues,
  });
}
await writeFile(
  join(outDir, 'summary.json'),
  `${JSON.stringify({ schema: 'open-decomp/public-surface-census/1', node: process.version, sweeps: sweepSummaries, rows: summaryRows, anomalies }, bigintJson, 1)}\n`,
);
const sweepRows = sweepSummaries.flatMap((entry) =>
  entry.sweeps.map((sweep) => {
    const w = sweep as {
      label: string;
      pages: number;
      items: number;
      max_bytes: number;
      max_ms: number;
      total_ms: number;
      states: object;
      errors: number;
    };
    return `| ${entry.binary} | ${w.label} | ${w.pages} | ${w.items} | ${w.max_bytes} | ${Math.round(w.max_ms)} | ${Math.round(w.total_ms)} | ${JSON.stringify(w.states)} | ${w.errors} |`;
  }),
);
const sweepTable = `| binary | sweep | pages | items | max page bytes on wire | max ms | total ms | states | errors |\n|---|---|---|---|---|---|---|---|---|\n${sweepRows.join('\n')}\n\n`;
const table = `${sweepTable}${rows.join('\n')}\n\nanomalies: ${anomalies.length}\n${anomalies.map((item) => `- ${item}`).join('\n')}\n`;
await writeFile(join(outDir, 'summary.md'), table);
process.stdout.write(table);

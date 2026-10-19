import type { ToolResult, WireDiagnostic } from '../core/index.js';

/** Compact, line-oriented text for the three search tools. A row keeps what a reader needs to
 * choose its next call (address, name, kind, status, short ID); per-record evidence IDs, ranges
 * and image IDs stay in structuredContent. Short IDs are accepted wherever a function is selected. */

/** `entity_` plus the first 12 hex digits; lengthened only to separate IDs listed together. */
export function shortIds(ids: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  const bodies = ids.map((id) => id.slice(id.indexOf('_') + 1));
  for (const [index, id] of ids.entries()) {
    const body = bodies[index]!;
    let length = 12;
    while (
      length < body.length &&
      bodies.some((other, at) => at !== index && other.startsWith(body.slice(0, length)))
    )
      length++;
    result.set(id, `${id.slice(0, id.indexOf('_') + 1)}${body.slice(0, length)}`);
  }
  return result;
}

export interface DistinctDiagnostic {
  readonly severity: WireDiagnostic['severity'];
  readonly code: string;
  readonly message: string;
  readonly count: number;
}
const severityRank: Record<WireDiagnostic['severity'], number> = { error: 0, warning: 1, info: 2 };
const MAX_MESSAGE = 240;

/** Each distinct (severity, code, message) once, most severe first, with its occurrence count. */
export function distinctDiagnostics(diagnostics: readonly WireDiagnostic[]): DistinctDiagnostic[] {
  const distinct = new Map<string, { item: WireDiagnostic; count: number }>();
  for (const item of diagnostics) {
    const key = JSON.stringify([item.severity, item.code, item.message]);
    const seen = distinct.get(key);
    if (seen) seen.count++;
    else distinct.set(key, { item, count: 1 });
  }
  return [...distinct.values()]
    .map(({ item, count }) => ({
      severity: item.severity,
      code: item.code,
      message: item.message,
      count,
    }))
    .sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
}

export function diagnosticLine(item: DistinctDiagnostic): string {
  const message =
    item.message.length > MAX_MESSAGE ? `${item.message.slice(0, MAX_MESSAGE)}…` : item.message;
  return `${item.severity} ${item.code}${item.count > 1 ? ` ×${item.count}` : ''}: ${message}`;
}

interface Named {
  readonly display_name: string | null;
  readonly original_name: string | null;
}
function nameOf(item: Named): string {
  const display = item.display_name ?? item.original_name ?? '(unnamed)';
  return item.original_name !== null && item.original_name !== display
    ? `${display} (native ${item.original_name})`
    : display;
}
interface Located {
  readonly space: string;
  readonly value: string;
}
function at(address: Located | null): string {
  return address === null ? '-' : `${address.space}:${address.value}`;
}
const MAX_STRING = 2000;

interface Page {
  readonly state: string;
  readonly reason?: string;
  readonly diagnostics: readonly WireDiagnostic[];
  readonly index_state: string;
  readonly next_cursor: string | null;
}
function listing(tool: string, page: Page, rows: readonly string[]): string {
  return [
    `${tool} ${page.state}${page.reason === undefined ? '' : ` (${page.reason})`}; index ${page.index_state}; ${rows.length} rows; next_cursor ${page.next_cursor ?? 'none'}`,
    ...distinctDiagnostics(page.diagnostics).map((item) => `! ${diagnosticLine(item)}`),
    ...rows,
  ].join('\n');
}
function pageOf(
  result: { state: string; diagnostics: readonly WireDiagnostic[] },
  data: { page: { index_state: string; next_cursor: string | null } },
): Page {
  return {
    state: result.state,
    ...('reason' in result && typeof result.reason === 'string' ? { reason: result.reason } : {}),
    diagnostics: result.diagnostics,
    index_state: data.page.index_state,
    next_cursor: data.page.next_cursor,
  };
}

/** One row per function: `entry  name  size  boundary/analysis  signature?  short ID`. */
export function functionsListing(result: ToolResult<'functions_find'>): string | undefined {
  if (!('data' in result)) return undefined;
  const short = shortIds(result.data.items.map((item) => item.id));
  return listing(
    'functions_find',
    pageOf(result, result.data),
    result.data.items.map((item) => {
      const first = item.ranges[0];
      return [
        at(item.entry),
        nameOf(item),
        first === undefined
          ? 'no range'
          : `size ${first.size}${item.ranges.length > 1 ? ` (+${item.ranges.length - 1} ranges)` : ''}`,
        `${item.boundary}/${item.analysis}`,
        item.signature === null ? 'no signature' : 'signature',
        short.get(item.id),
      ].join('  ');
    }),
  );
}

export function symbolsListing(result: ToolResult<'symbols_find'>): string | undefined {
  if (!('data' in result)) return undefined;
  return listing(
    'symbols_find',
    pageOf(result, result.data),
    result.data.items.map((item) => {
      if (item.kind === 'symbol') {
        const symbol = item.symbol;
        return [
          at(symbol.address),
          nameOf(symbol),
          `symbol ${symbol.kind}${symbol.size === null ? '' : ` size ${symbol.size}`}`,
          symbol.binding,
        ].join('  ');
      }
      if (item.kind === 'import') {
        const found = item.import;
        return [
          at(found.callable_entry ?? found.slot),
          nameOf(found),
          `import ${found.library ?? 'unknown library'}${found.callable_entry && found.slot ? ` slot ${at(found.slot)}` : ''}${found.ordinal === null ? '' : ` ordinal ${found.ordinal}`}${found.delayed ? ' delayed' : ''}${found.weak ? ' weak' : ''}`,
        ].join('  ');
      }
      const found = item.export;
      return [
        at(found.address),
        nameOf(found),
        `export${found.ordinal === null ? '' : ` ordinal ${found.ordinal}`}${found.forwarder === null ? '' : ` forwards to ${found.forwarder.library}.${found.forwarder.symbol}`}`,
      ].join('  ');
    }),
  );
}

export function stringsListing(result: ToolResult<'strings_find'>): string | undefined {
  if (!('data' in result)) return undefined;
  return listing(
    'strings_find',
    pageOf(result, result.data),
    result.data.items.map((item) => {
      const text =
        item.text.length > MAX_STRING
          ? `${JSON.stringify(item.text.slice(0, MAX_STRING))}…(+${item.text.length - MAX_STRING} chars)`
          : JSON.stringify(item.text);
      return [
        at(item.address),
        `${item.encoding} len ${item.byte_length}`,
        `${item.status}${item.terminated ? '' : ' unterminated'}`,
        text,
      ].join('  ');
    }),
  );
}

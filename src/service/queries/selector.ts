import { OperationError, decodeDiagnostic } from '../../core/index.js';
import type { ToolInput, ToolResult } from '../../core/index.js';
import type { QueryCallOptions, QueryService } from './index.js';

export type FunctionRecord = Extract<
  ToolResult<'functions_find'>,
  { data: unknown }
>['data']['items'][number];
export type FunctionSelector =
  | { readonly name: string }
  | { readonly id: string }
  /** `entity_` plus at least 12 hex digits of a function ID; must match exactly one function. */
  | { readonly id_prefix: string }
  | { readonly address: { readonly space: 'va' | 'rva' | 'file'; readonly value: string } };
export interface FunctionScope {
  readonly project_id: string;
  readonly revision: number;
  readonly image_id: string;
}
type Executor = Pick<QueryService, 'execute'>;
type Lookup = ToolResult<'binary_info'> | ToolResult<'functions_find'> | ToolResult<'symbols_find'>;
type FunctionQuery = Omit<
  ToolInput<'functions_find'>,
  'project_id' | 'revision' | 'image_id' | 'page'
>;

export class FunctionSelectionError extends Error {
  constructor(
    readonly reason: 'not_found' | 'ambiguous' | 'incomplete',
    readonly candidates: readonly FunctionRecord[],
  ) {
    super(
      reason === 'ambiguous'
        ? 'Function selector is ambiguous; use a function ID or address.'
        : reason === 'incomplete'
          ? 'Function search is incomplete; uniqueness or absence cannot be established.'
          : 'No function matches the selector.',
    );
    this.name = 'FunctionSelectionError';
  }
}

const fullId = /^entity_[0-9a-f]{64}$/;
const idPrefix = /^entity_[0-9a-f]{12,63}$/;
const addressHandle = /^(va|rva|file):(0x[0-9a-fA-F]{1,16})$/;

/** The one-string function handle accepted by MCP: a full ID, a unique `entity_<12+ hex>` prefix,
 * `va:0x…` / `rva:0x…` / `file:0x…`, or otherwise an exact function name. */
export function parseFunctionHandle(handle: string): FunctionSelector {
  if (fullId.test(handle)) return { id: handle };
  if (idPrefix.test(handle)) return { id_prefix: handle };
  const address = addressHandle.exec(handle);
  if (address)
    return {
      address: { space: address[1] as 'va' | 'rva' | 'file', value: address[2]!.toLowerCase() },
    };
  return { name: handle };
}

function unsettled(result: Lookup): never {
  if (result.state === 'failed' || result.state === 'unsupported')
    throw new OperationError(decodeDiagnostic(result.error));
  throw new FunctionSelectionError('incomplete', []);
}

/** The sole image of a snapshot; a multi-image snapshot needs an explicit image. */
export async function soleImageId(
  service: Executor,
  scope: { readonly project_id: string; readonly revision: number },
  call: QueryCallOptions = {},
): Promise<string> {
  const summary = await service.execute('binary_info', { ...scope, view: 'summary' }, call);
  if (!('data' in summary) || summary.data.view !== 'summary') return unsettled(summary);
  return summary.data.image.id;
}

/** Resolve one function. Absence, ambiguity or an index too incomplete to prove uniqueness are
 * reported as FunctionSelectionError; a match is never guessed. */
export async function selectFunction(
  service: Executor,
  scope: FunctionScope,
  selector: FunctionSelector,
  call: QueryCallOptions = {},
): Promise<FunctionRecord> {
  const find = (query: FunctionQuery, limit: number) =>
    service.execute('functions_find', { ...scope, ...query, page: { limit } }, call);
  const found = await find(
    'name' in selector
      ? { query: { text: selector.name, match: 'exact', case_sensitive: true } }
      : 'id' in selector
        ? { id: selector.id }
        : 'id_prefix' in selector
          ? { id_prefix: selector.id_prefix }
          : { address: { ...selector.address, image_id: scope.image_id } },
    8,
  );
  if (!('data' in found)) return unsettled(found);
  const candidates = found.data.items;
  if (candidates.length > 1) throw new FunctionSelectionError('ambiguous', candidates);
  if (found.data.page.next_cursor !== null)
    throw new FunctionSelectionError('incomplete', candidates);
  let selected: FunctionRecord | undefined = candidates[0];
  if ('name' in selector && found.data.page.index_state !== 'complete')
    selected = await selectByNativeName(service, scope, selector.name, candidates, find, call);
  if (!selected)
    throw new FunctionSelectionError(found.state === 'partial' ? 'incomplete' : 'not_found', []);
  return selected;
}

/** A partial function index cannot prove that a name is unique. The complete native symbol and
 * export tables can: they define the name (Mach-O underscore convention applied by the query
 * layer) at distinct addresses, and the index only supplies the function entity at that address.
 * Anything the authoritative tables cannot settle stays incomplete or ambiguous, never guessed. */
async function selectByNativeName(
  service: Executor,
  scope: FunctionScope,
  name: string,
  indexed: readonly FunctionRecord[],
  find: (query: FunctionQuery, limit: number) => Promise<ToolResult<'functions_find'>>,
  call: QueryCallOptions,
): Promise<FunctionRecord> {
  const definitions = new Map<string, FunctionRecord['entry']>();
  let authoritative = true,
    cursor: string | undefined;
  do {
    const page = await service.execute(
      'symbols_find',
      {
        ...scope,
        kinds: ['symbol', 'export'],
        query: { text: name, match: 'exact', case_sensitive: true },
        page: { limit: 100, ...(cursor === undefined ? {} : { cursor }) },
      },
      call,
    );
    if (!('data' in page)) return unsettled(page);
    if (page.data.page.index_state !== 'complete') authoritative = false;
    for (const item of page.data.items) {
      const address =
        item.kind === 'symbol'
          ? item.symbol.kind === 'function'
            ? item.symbol.address
            : null
          : item.kind === 'export'
            ? item.export.address
            : null;
      if (address === null) continue;
      if (address.space === 'va') definitions.set(BigInt(address.value).toString(16), address);
      else authoritative = false;
    }
    cursor = page.data.page.next_cursor ?? undefined;
  } while (cursor !== undefined && definitions.size < 2);
  if (!authoritative) throw new FunctionSelectionError('incomplete', indexed);
  // A stub is named by the loader's import, which no native symbol/export defines: with
  // authoritative tables defining no function of this name, the one indexed stub is it.
  if (definitions.size === 0 && indexed.length === 1 && indexed[0]!.kind === 'import_stub')
    return indexed[0]!;
  const functions = new Map(indexed.map((item) => [item.id, item] as const));
  const defined = new Map<string, number>();
  for (const [key, address] of [...definitions].slice(0, 16)) {
    const page = await find({ address }, 3);
    if (!('data' in page)) return unsettled(page);
    const entries = page.data.items.filter(
      (item) => item.entry.space === 'va' && BigInt(item.entry.value) === BigInt(address.value),
    );
    for (const item of entries) functions.set(item.id, item);
    defined.set(key, entries.length);
  }
  const candidates = [...functions.values()];
  if (definitions.size > 1 || candidates.length > 1)
    throw new FunctionSelectionError('ambiguous', candidates);
  const [only] = candidates;
  if (only && definitions.size === 1 && [...defined.values()][0] === 1) return only;
  throw new FunctionSelectionError('incomplete', candidates);
}

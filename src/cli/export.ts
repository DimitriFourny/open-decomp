import { cp, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename, join } from 'node:path';
import { openBinary } from '../api/index.js';
import type { BinaryFunction, BinarySession } from '../api/index.js';
import { cSourceName } from '../metadata/symbols/c-names.js';
import type { Target, ToolResult } from '../core/index.js';

export interface ExportOptions {
  readonly out: string;
  readonly language: 'c-like' | 'python-like';
  readonly jobs: number | undefined;
  readonly sliceId?: string | undefined;
  readonly name?: string | undefined;
  /** False: extra workers open their project copies without analysis caching too. */
  readonly analysisCache?: boolean | undefined;
}
export interface ExportSummary {
  readonly functions: number;
  readonly complete: number;
  readonly partial: number;
  readonly failed: number;
  readonly files: number;
  readonly bytes: number;
  /** Native indexes that reported incompleteness: lists derived from them are lower bounds. */
  readonly incompleteIndexes: readonly string[];
}

type Address = BinaryFunction['entry'];
type SymbolItem = Extract<ToolResult<'symbols_find'>, { data: unknown }>['data']['items'][number];
type StringRecord = Extract<ToolResult<'strings_find'>, { data: unknown }>['data']['items'][number];
type Reference = Extract<ToolResult<'xrefs_get'>, { data: unknown }>['data']['items'][number];
type ImportRecord = Extract<SymbolItem, { kind: 'import' }>['import'];
type ExportRecord = Extract<SymbolItem, { kind: 'export' }>['export'];

interface Row {
  readonly fn: BinaryFunction;
  readonly name: string;
  readonly va: string;
  file: string;
  state: string;
  reason: string;
  /** Instruction bytes of the function's disassembly; null when unreadable. */
  codeBytes: bigint | null;
  fileBytes: number;
  callers: string[];
  callees: string[];
}

/** One writer per run; plain-text artifacts only. Strings and names are untrusted bytes. */
function escape(value: string, limit = Infinity): string {
  let text = value;
  let suffix = '';
  if (text.length > limit) {
    suffix = `…(+${text.length - limit} chars)`;
    text = text.slice(0, limit);
  }
  return (
    text.replace(/[\\\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (character) =>
      character === '\\'
        ? '\\\\'
        : character === '\t'
          ? '\\t'
          : character === '\n'
            ? '\\n'
            : character === '\r'
              ? '\\r'
              : `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    ) + suffix
  );
}
function tsv(fields: readonly string[]): string {
  return fields.join('\t');
}
function oneLine(value: string, limit = 160): string {
  const flat = value.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}
function addressKey(address: Address): string {
  return `${address.space}:${BigInt(address.value).toString(16)}`;
}
function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function compareAddress(left: Address, right: Address): number {
  const a = BigInt(left.value),
    b = BigInt(right.value);
  return a < b ? -1 : a > b ? 1 : 0;
}
/** Filesystem-safe, bounded stem. The address suffix makes names unique; collisions on
 * case-insensitive volumes (same address spelling is impossible, but sanitising may fold) get ~N. */
function stem(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9_.$+-]+/g, '_').replace(/^\.+/, '_');
  return (clean.length > 96 ? clean.slice(0, 96) : clean) || 'sub';
}

interface Page<T> {
  readonly items: readonly T[];
  readonly next: string | null;
  readonly complete: boolean;
}
async function collect<T>(
  page: (cursor: string | undefined) => Promise<Page<T>>,
  signal: AbortSignal,
): Promise<{ items: T[]; complete: boolean }> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined,
    complete = true;
  do {
    signal.throwIfAborted();
    const result = await page(cursor);
    items.push(...result.items);
    complete &&= result.complete;
    if (result.next !== null && seen.has(result.next))
      throw new Error('Pagination repeated a cursor; results are incomplete');
    if (result.next !== null) seen.add(result.next);
    cursor = result.next ?? undefined;
  } while (cursor !== undefined);
  return { items, complete };
}

interface PagedResult<T> {
  readonly state: string;
  readonly data?: {
    readonly items: readonly T[];
    readonly page: { readonly next_cursor: string | null; readonly index_state: string };
  };
  readonly error?: { readonly message: string };
}
/** One page of a query result. A failed/unsupported page is a real error. */
function pageOf<T>(result: PagedResult<T>, operation: string): Page<T> {
  if (result.data === undefined)
    throw new Error(`${operation}: ${oneLine(result.error?.message ?? result.state)}`);
  return {
    items: result.data.items,
    next: result.data.page.next_cursor,
    complete: result.state !== 'partial' || result.data.page.index_state === 'complete',
  };
}

interface Disassembly {
  /** Instruction text lines (empty unless requested) plus notes about gaps/incompleteness. */
  readonly lines: string[];
  /** Sum of instruction sizes; null when the disassembly view could not be read. */
  readonly bytes: bigint | null;
}
/** Compact disassembly: the function's real extent, and (for functions without pseudocode)
 * its text, so nothing is dropped silently. */
async function disassemble(
  session: BinarySession,
  id: string,
  signal: AbortSignal,
  keepLines: boolean,
): Promise<Disassembly> {
  const lines: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined,
    bytes = 0n,
    incomplete = false;
  do {
    signal.throwIfAborted();
    const result = await session.getFunction(
      id,
      {
        view: 'disassembly',
        detail: 'compact',
        page: { limit: 1000, ...(cursor ? { cursor } : {}) },
      },
      { signal },
    );
    if (
      !('data' in result) ||
      result.data.view !== 'disassembly' ||
      result.data.detail !== 'compact'
    ) {
      lines.push(
        `; disassembly unavailable: ${oneLine('error' in result ? result.error.message : result.state)}`,
      );
      return { lines, bytes: null };
    }
    const { data } = result;
    for (const item of data.items) {
      bytes += BigInt(item.size);
      if (!keepLines) continue;
      const text = item.presentation
        ? `${item.presentation.mnemonic} ${item.presentation.operands}`.trimEnd()
        : '(undecoded)';
      lines.push(
        `${item.address.value}: ${text}${item.validity === 'valid' ? '' : `  ; ${item.validity}`}`,
      );
    }
    if (keepLines)
      for (const gap of data.gaps)
        lines.push(`; gap ${gap.range.start.value}+${gap.range.size}: ${gap.reason}`);
    if (result.state === 'partial' && data.page.index_state !== 'complete') incomplete = true;
    cursor = data.page.next_cursor ?? undefined;
    if (cursor !== undefined) {
      if (seen.has(cursor)) throw new Error('Disassembly pagination repeated a cursor');
      seen.add(cursor);
    }
  } while (cursor !== undefined);
  if (keepLines && incomplete) lines.push('; disassembly is incomplete');
  return { lines, bytes };
}

interface ExportData {
  readonly functions: BinaryFunction[];
  readonly imports: ImportRecord[];
  readonly exports: ExportRecord[];
  readonly strings: StringRecord[];
}
type CFormat = Target['format'];

class Exporter {
  readonly #options: ExportOptions;
  readonly #input: string;
  readonly #signal: AbortSignal;
  readonly #cFormat: CFormat;
  readonly #names = new Map<string, string>(); // entity id -> name
  readonly #addressNames = new Map<string, string>(); // addressKey -> name
  readonly #stringIds = new Map<string, StringRecord>();
  readonly #stringRefs = new Map<string, Set<string>>();
  readonly #importRefs = new Map<string, Set<string>>();
  readonly #importByEntity = new Map<string, ImportRecord>();
  readonly #importByAddress = new Map<string, ImportRecord>();
  readonly #used = new Set<string>();
  readonly #functionsDirectory: string;
  rows: Row[] = [];
  readonly #incomplete = new Set<string>();

  constructor(options: ExportOptions, input: string, signal: AbortSignal, format: CFormat) {
    this.#input = input;
    this.#options = options;
    this.#signal = signal;
    this.#cFormat = format;
    this.#functionsDirectory = join(options.out, 'functions');
  }

  get incompleteIndexes(): string[] {
    return [...this.#incomplete].sort(compare);
  }

  #cName(name: string): string {
    return cSourceName(this.#cFormat, name);
  }

  /** Functions, symbols and strings from the primary session: the shared name tables. */
  async load(session: BinarySession): Promise<ExportData> {
    const signal = this.#signal;
    const functions = await collect(
      async (cursor) =>
        pageOf(
          await session.findFunctions(
            { page: { limit: 1000, ...(cursor ? { cursor } : {}) } },
            { signal },
          ),
          'functions_find',
        ),
      signal,
    );
    if (!functions.complete) this.#incomplete.add('functions');
    const symbols = await collect(
      async (cursor) =>
        pageOf(
          await session.findSymbols(
            { kinds: ['import', 'export'], page: { limit: 1000, ...(cursor ? { cursor } : {}) } },
            { signal },
          ),
          'symbols_find',
        ),
      signal,
    );
    if (!symbols.complete) this.#incomplete.add('symbols');
    const strings = await collect(
      async (cursor) =>
        pageOf(
          await session.findStrings(
            { page: { limit: 1000, ...(cursor ? { cursor } : {}) } },
            { signal },
          ),
          'strings_find',
        ),
      signal,
    );
    if (!strings.complete) this.#incomplete.add('strings');
    const imports: ImportRecord[] = [],
      exports: ExportRecord[] = [];
    for (const item of symbols.items) {
      if (item.kind === 'import') imports.push(item.import);
      else if (item.kind === 'export') exports.push(item.export);
    }
    for (const record of imports) {
      const name = this.#nameOf(record);
      if (name === null) continue;
      this.#importByEntity.set(record.id, record);
      this.#names.set(record.id, name);
      for (const address of [record.callable_entry, record.slot])
        if (address) {
          this.#addressNames.set(addressKey(address), name);
          this.#importByAddress.set(addressKey(address), record);
        }
    }
    for (const record of exports) {
      const name = this.#nameOf(record);
      if (name !== null && record.address && !this.#addressNames.has(addressKey(record.address)))
        this.#addressNames.set(addressKey(record.address), name);
    }
    for (const record of functions.items) {
      const name =
        this.#nameOf(record) ??
        this.#addressNames.get(addressKey(record.entry)) ??
        `sub_${BigInt(record.entry.value).toString(16)}`;
      this.#names.set(record.id, name);
      if (!this.#addressNames.has(addressKey(record.entry)))
        this.#addressNames.set(addressKey(record.entry), name);
    }
    for (const record of strings.items) this.#stringIds.set(record.id, record);
    return { functions: functions.items, imports, exports, strings: strings.items };
  }

  #nameOf(record: { display_name: string | null; original_name: string | null }): string | null {
    const name = record.display_name ?? record.original_name;
    return name === null || name === '' ? null : this.#cName(name);
  }

  buildRows(functions: readonly BinaryFunction[]): void {
    const filter = this.#options.name?.toLowerCase();
    const rows: Row[] = [];
    for (const fn of functions) {
      const name = this.#names.get(fn.id)!;
      if (filter !== undefined && !name.toLowerCase().includes(filter)) continue;
      rows.push({
        fn,
        name,
        va: hex(BigInt(fn.entry.value)),
        file: '',
        state: '',
        reason: '',
        codeBytes: null,
        fileBytes: 0,
        callers: [],
        callees: [],
      });
    }
    rows.sort(
      (left, right) =>
        compareAddress(left.fn.entry, right.fn.entry) || compare(left.fn.id, right.fn.id),
    );
    const extension = this.#options.language === 'python-like' ? 'py' : 'c';
    for (const row of rows) {
      const base = `${stem(row.name)}@${row.va}`;
      let candidate = `${base}.${extension}`,
        counter = 1;
      // Collision-safe on case-insensitive volumes too; sorted order keeps the choice stable.
      while (this.#used.has(candidate.toLowerCase()))
        candidate = `${base}~${++counter}.${extension}`;
      this.#used.add(candidate.toLowerCase());
      row.file = candidate;
    }
    this.rows = rows;
  }

  async prepareDirectory(): Promise<void> {
    await mkdir(this.#functionsDirectory, { recursive: true });
    // Re-runs overwrite: only files this command generates are ever removed.
    for (const entry of await readdir(this.#functionsDirectory))
      if (/@0x[0-9a-f]+(~\d+)?\.(c|py|asm)$/.test(entry))
        await rm(join(this.#functionsDirectory, entry), { force: true });
  }

  /** Callee spelling: entity name, else a named address (import stub/slot, function), else the address. */
  #label(target: Address | null, entity: string | null): string | null {
    const named = entity === null ? undefined : this.#names.get(entity);
    if (named !== undefined) return named;
    if (target === null) return null;
    return this.#addressNames.get(addressKey(target)) ?? hex(BigInt(target.value));
  }

  async #references(session: BinarySession, id: string): Promise<Reference[]> {
    const page = await collect(
      async (cursor) =>
        pageOf(
          await session.getReferences(
            {
              target: { kind: 'entity', id },
              direction: 'both',
              kinds: ['call', 'tail_call', 'read', 'address'],
              include_unresolved: true,
              page: { limit: 1000, ...(cursor ? { cursor } : {}) },
            },
            { signal: this.#signal },
          ),
          'xrefs_get',
        ),
      this.#signal,
    );
    if (!page.complete) this.#incomplete.add('references');
    return page.items;
  }

  /** Fold one function's references into its caller/callee lists and the string/import indexes. */
  #relate(row: Row, references: readonly Reference[]): void {
    const callers = new Set<string>(),
      callees = new Map<string, bigint>();
    let unresolved = false;
    for (const reference of [...references].sort((a, b) => compareAddress(a.from, b.from))) {
      const outgoing = reference.from_function === row.fn.id;
      if (reference.kind === 'call' || reference.kind === 'tail_call') {
        if (outgoing) {
          const label = this.#label(reference.to, reference.to_entity);
          if (label === null) unresolved = true;
          else {
            callees.set(label, callees.get(label) ?? BigInt(reference.from.value));
            const imported =
              (reference.to_entity === null
                ? undefined
                : this.#importByEntity.get(reference.to_entity)) ??
              (reference.to === null
                ? undefined
                : this.#importByAddress.get(addressKey(reference.to)));
            if (imported !== undefined)
              this.#note(this.#importRefs, this.#nameOf(imported) ?? '', row.name);
          }
        }
        if (reference.to_entity === row.fn.id)
          callers.add(
            (reference.from_function === null
              ? undefined
              : this.#names.get(reference.from_function)) ?? hex(BigInt(reference.from.value)),
          );
      } else if (
        outgoing &&
        reference.to_entity !== null &&
        this.#stringIds.has(reference.to_entity)
      )
        this.#note(this.#stringRefs, reference.to_entity, row.name);
    }
    row.callers = [...callers].sort(compare);
    row.callees = [...callees]
      .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : compare(a[0], b[0])))
      .map(([label]) => label);
    if (unresolved) row.callees.push('?');
  }

  #note(index: Map<string, Set<string>>, key: string, caller: string): void {
    let set = index.get(key);
    if (!set) index.set(key, (set = new Set()));
    set.add(caller);
  }

  /** One function end to end: references, pseudocode (or disassembly), file. */
  async process(session: BinarySession, row: Row): Promise<void> {
    this.#relate(row, await this.#references(session, row.fn.id));
    const language = this.#options.language;
    const result = await session.decompileFunction(row.fn.id, {
      emitter: language,
      signal: this.#signal,
    });
    this.#signal.throwIfAborted();
    const pseudocode =
      'data' in result && result.data.delivery === 'inline' ? result.data.emission.text : undefined;
    if (pseudocode !== undefined) {
      row.state = result.state;
      row.reason = 'reason' in result ? result.reason : '';
    } else {
      row.state =
        result.state === 'unsupported' || result.state === 'cancelled' ? result.state : 'failed';
      row.reason =
        'error' in result ? `${result.error.code}: ${oneLine(result.error.message)}` : result.state;
    }
    const disassembly = await disassemble(
      session,
      row.fn.id,
      this.#signal,
      pseudocode === undefined,
    );
    row.codeBytes = disassembly.bytes;
    const names = (list: readonly string[]): string =>
      list.length === 0
        ? '-'
        : list.length > 12
          ? `${list.slice(0, 12).join(', ')}, +${list.length - 12} more`
          : list.join(', ');
    const status = row.state === 'complete' ? 'complete' : `${row.state} (${row.reason})`;
    const facts = `${escape(row.name)} @ ${row.va} | ${pseudocode === undefined ? 'no pseudocode: ' : ''}${status} | ${row.codeBytes ?? '?'} bytes | callers: ${escape(names(row.callers))} | callees: ${escape(names(row.callees))}`;
    let text: string;
    if (pseudocode !== undefined) {
      const header =
        language === 'python-like' ? `# ${facts}` : `/* ${facts.replaceAll('*/', '* /')} */`;
      text = `${header}\n${pseudocode.endsWith('\n') ? pseudocode : `${pseudocode}\n`}`;
    } else {
      row.file = row.file.replace(/\.(c|py)$/, '.asm');
      text = `; ${facts}\n; compact native disassembly (address: instruction)\n${disassembly.lines.join('\n')}\n`;
    }
    await writeFile(join(this.#functionsDirectory, row.file), text);
    row.fileBytes = Buffer.byteLength(text);
  }

  async writeIndexes(
    data: ExportData,
    summary: { functions: number; complete: number; partial: number; failed: number },
    types: { readonly text: string; readonly complete: boolean },
  ): Promise<number> {
    const out = this.#options.out;
    let bytes = 0;
    const write = async (name: string, lines: readonly string[]): Promise<void> => {
      const text = `${lines.join('\n')}\n`;
      bytes += Buffer.byteLength(text);
      const temporary = join(out, `.${name}.tmp`);
      await writeFile(temporary, text);
      await rename(temporary, join(out, name));
    };
    const list = (names: Iterable<string>, limit: number): string => {
      const sorted = [...names].sort(compare);
      return sorted.length > limit
        ? `${sorted.slice(0, limit).join(',')},+${sorted.length - limit}`
        : sorted.join(',');
    };
    await write('index.tsv', [
      tsv(['address', 'name', 'file', 'state', 'reason', 'code_bytes', 'callers', 'callees']),
      ...this.rows.map((row) =>
        tsv([
          row.va,
          escape(row.name),
          escape(`functions/${row.file}`),
          row.state,
          escape(row.reason),
          row.codeBytes?.toString() ?? '?',
          escape(row.callers.join(',')),
          escape(row.callees.join(',')),
        ]),
      ),
    ]);
    const strings = [...data.strings].sort(
      (left, right) => compareAddress(left.address, right.address) || compare(left.id, right.id),
    );
    await write('strings.tsv', [
      tsv(['address', 'text', 'referenced_by']),
      ...strings.map((record) =>
        tsv([
          hex(BigInt(record.address.value)),
          escape(record.text, 400),
          escape(list(this.#stringRefs.get(record.id) ?? [], 24)),
        ]),
      ),
    ]);
    // The index lists a binding and its callable stub as separate records of one import.
    const merged = new Map<string, { name: string; library: string; slot: string; stub: string }>();
    for (const record of data.imports) {
      const name = this.#nameOf(record) ?? '';
      const key = `${record.library ?? ''}\0${name}`;
      const entry = merged.get(key) ?? { name, library: record.library ?? '', slot: '', stub: '' };
      if (record.slot && entry.slot === '') entry.slot = hex(BigInt(record.slot.value));
      if (record.callable_entry && entry.stub === '')
        entry.stub = hex(BigInt(record.callable_entry.value));
      merged.set(key, entry);
    }
    const imports = [...merged.values()].sort(
      (left, right) => compare(left.name, right.name) || compare(left.library, right.library),
    );
    await write('imports.tsv', [
      tsv(['name', 'library', 'slot', 'stub', 'called_by']),
      ...imports.map((entry) =>
        tsv([
          escape(entry.name),
          escape(entry.library),
          entry.slot,
          entry.stub,
          escape(list(this.#importRefs.get(entry.name) ?? [], 24)),
        ]),
      ),
    ]);
    const exports = [...data.exports]
      .map((record) => ({ record, name: this.#nameOf(record) ?? '' }))
      .sort(
        (left, right) =>
          (left.record.address && right.record.address
            ? compareAddress(left.record.address, right.record.address)
            : 0) || compare(left.name, right.name),
      );
    await write('exports.tsv', [
      tsv(['address', 'name', 'forwarder']),
      ...exports.map(({ record, name }) =>
        tsv([
          record.address ? hex(BigInt(record.address.value)) : '',
          escape(name),
          record.forwarder ? escape(`${record.forwarder.library}!${record.forwarder.symbol}`) : '',
        ]),
      ),
    ]);
    const typesText = types.text.endsWith('\n') ? types.text.slice(0, -1) : types.text;
    await write('types.h', [typesText]);
    const extension = this.#options.language === 'python-like' ? 'py' : 'c';
    await write('README.txt', [
      `Open Decomp export (${this.#options.language}) of ${escape(basename(this.#input))}: ${summary.functions} functions (${summary.complete} complete, ${summary.partial} partial, ${summary.failed} failed).`,
      `index.tsv: one row per function: address, name, file, state, reason, code_bytes (instruction bytes of its body; ? = unreadable), callers, callees. Start here; grep it by name or state.`,
      `functions/NAME@0xADDR.${extension}: pseudocode exactly as 'open-decomp decompile' prints it, preceded by one header comment (state, size, callers, callees; '?' = unresolved indirect call).`,
      `functions/NAME@0xADDR.asm: only where pseudocode could not be produced; compact native disassembly and the reason in the header. state=partial files are real but incomplete pseudocode (reason in index.tsv).`,
      `Names use the C spelling of the native symbol (Mach-O leading underscore removed); stripped functions are sub_<hex address>. Every name is a symbol fact, never a guess.`,
      `strings.tsv: address, escaped text (cut at 400 chars, marked), referenced_by (functions in this export; at most 24 listed, then +N).`,
      `imports.tsv: imported symbols with library, slot, stub address and called_by. exports.tsv: exported symbols and forwarders. ` +
        `types.h: C declarations of the image-wide merged structure types; the pseudocode uses the same names (observed members only, sizes unknown)${types.complete ? '' : '; partial: not every function body was analyzed within the budget'}.`,
      `Grep examples: grep -rn "sqlite3_free" functions/ ; grep -l "partial" index.tsv ; awk -F'\\t' '$4=="failed"' index.tsv`,
      this.#options.name === undefined
        ? 'Whole binary: referenced_by and called_by cover every function.'
        : 'Filtered by --name: referenced_by and called_by cover only the exported functions.',
      this.#incomplete.size === 0
        ? 'Native indexes (functions, symbols, strings, references) were complete.'
        : `Incomplete native indexes: ${this.incompleteIndexes.join(', ')}. Functions without symbols may be missing; callers, callees and referenced_by are lower bounds.`,
    ]);
    return bytes;
  }
}

/** Exports one binary as a greppable directory. Throws on real errors; per-function
 * failures are recorded in index.tsv instead. */
export async function exportBinary(
  primary: BinarySession,
  options: ExportOptions,
  outer: AbortSignal,
  log: (message: string) => void,
): Promise<ExportSummary> {
  const started = Date.now();
  // The first real error stops every worker; the caller's signal stops them all too.
  const stop = new AbortController();
  const signal = stop.signal;
  const forward = (): void => stop.abort(outer.reason);
  if (outer.aborted) forward();
  else outer.addEventListener('abort', forward, { once: true });
  const exporter = new Exporter(options, primary.inputPath, signal, primary.image.target.format);
  const sessions: BinarySession[] = [primary];
  let scratch: string | undefined;
  try {
    const data = await exporter.load(primary);
    exporter.buildRows(data.functions);
    const rows = exporter.rows;
    const jobs = Math.max(
      1,
      Math.min(
        options.jobs ?? Math.max(1, Math.min(4, availableParallelism() >> 1)),
        rows.length || 1,
      ),
    );
    await mkdir(options.out, { recursive: true });
    await exporter.prepareDirectory();
    log(
      `export: ${rows.length} functions${options.name === undefined ? '' : ` matching "${options.name}"`}, ${jobs} worker${jobs === 1 ? '' : 's'}`,
    );
    if (jobs > 1) {
      // A project database has one owner. Extra workers analyze private copies of the
      // finished import (copy-on-write where the filesystem supports it).
      await primary.close();
      sessions.length = 0;
      scratch = join(primary.cachePath, `.export-${process.pid}-${Date.now()}`);
      const projectName = basename(primary.projectPath);
      await Promise.all(
        Array.from({ length: jobs }, async (_, index) => {
          let cachePath = primary.cachePath;
          if (index > 0) {
            cachePath = join(scratch!, `w${index}`);
            await mkdir(cachePath, { recursive: true, mode: 0o700 });
            await cp(primary.projectPath, join(cachePath, projectName), {
              recursive: true,
              mode: constants.COPYFILE_FICLONE,
            });
          }
          sessions.push(
            await openBinary(primary.inputPath, {
              cachePath,
              ...(options.sliceId === undefined ? {} : { sliceId: options.sliceId }),
              ...(options.analysisCache === false ? { analysisCache: false } : {}),
              signal,
            }),
          );
        }),
      );
    }

    let next = 0,
      done = 0,
      lastReport = started;
    const counts = { complete: 0, partial: 0, failed: 0 };
    let failure: { error: unknown } | undefined;
    const worker = async (session: BinarySession): Promise<void> => {
      try {
        for (;;) {
          signal.throwIfAborted();
          const row = rows[next++];
          if (row === undefined) return;
          await exporter.process(session, row);
          if (row.state === 'complete') counts.complete++;
          else if (row.state === 'partial') counts.partial++;
          else counts.failed++;
          done++;
          const now = Date.now();
          if (now - lastReport >= 2000) {
            lastReport = now;
            log(
              `export: ${done}/${rows.length} (${Math.floor((done * 100) / rows.length)}%), ${counts.complete} complete, ${counts.partial} partial, ${counts.failed} failed, ${Math.round((now - started) / 1000)}s`,
            );
          }
        }
      } catch (error) {
        failure ??= { error };
        stop.abort(error);
      }
    };
    await Promise.all(sessions.map((session) => worker(session)));
    if (failure) throw failure.error;
    signal.throwIfAborted();
    // Image-wide merged structure types: the names the pseudocode files use.
    const types = await sessions[0]!.types({}, { signal });
    signal.throwIfAborted();
    let bytes = await exporter.writeIndexes(
        data,
        { functions: rows.length, ...counts },
        {
          text:
            'data' in types && types.data.view === 'types'
              ? types.data.text
              : `/* Image types unavailable: ${types.state} */\n`,
          complete: types.state === 'complete',
        },
      ),
      files = 6;
    for (const row of rows) {
      bytes += row.fileBytes;
      files++;
    }
    return {
      functions: rows.length,
      ...counts,
      files,
      bytes,
      incompleteIndexes: exporter.incompleteIndexes,
    };
  } finally {
    outer.removeEventListener('abort', forward);
    await Promise.allSettled(sessions.map((session) => session.close()));
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  }
}

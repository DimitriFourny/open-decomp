import { readFile } from 'node:fs/promises';
import * as cppGlue from 'gecko-profiler-demangle/index_bg.js';
import initializeSwift from 'swift-demangle-wasm';
import { createDemangler, type Demangler } from 'llvm-msvc-demangle';
import type { Diagnostic, ExportRecord, ImportRecord, LoadedImage, OperationContext, SymbolRecord, Target } from '../../core/index.js';

export interface NamePresentation {
  readonly original_name: string;
  readonly display_name: string | null;
  readonly language: 'c++-itanium' | 'c++-msvc' | 'swift' | null;
  readonly status: 'plain' | 'demangled' | 'unrecognized' | 'limited' | 'unavailable';
  readonly diagnostics: readonly Diagnostic[];
}
export interface NamedImageMetadata {
  readonly symbols: readonly SymbolRecord[]; readonly imports: readonly ImportRecord[]; readonly exports: readonly ExportRecord[];
  /** Complete means all names were visited, not that every mangling was recognized. */
  readonly state: 'complete' | 'partial'; readonly diagnostics: readonly Diagnostic[];
}
let cpp: Promise<(name: string) => string> | undefined;
let swift: Promise<(name: string) => string> | undefined;
let msvc: Promise<Demangler> | undefined;
const cache = new Map<string, NamePresentation>();
let cacheCharacters = 0;

/** Only fixed, installed WASM assets are loaded; no URLs, filesystem preopens,
 * environment or target code are supplied to an engine. Initialization is lazy.
 * Native names/identities are immutable. Demangled text is display/search data,
 * never a source signature, ABI declaration or proof of a runtime object type.
 * Names/output are capped at 4096/8192 UTF-16 units. The process-local cache is
 * capped at 1024 entries and 1 Mi characters; ordinary names never enter it.
 * A synchronous engine is additionally contained by the project worker deadline.
 */
export async function demangleName(original_name: string, format: Target['format'], context: OperationContext): Promise<NamePresentation> {
  context.checkpoint(1);
  const base = { original_name, display_name: null, language: null, status: 'plain', diagnostics: [] } as const;
  const candidate = format === 'macho' && /^(?:__Z|_\$[sS]|__T|_\?)/.test(original_name) ? original_name.slice(1) : original_name;
  const language = candidate.startsWith('_Z') ? 'c++-itanium' : candidate.startsWith('?') ? 'c++-msvc' : /^(?:\$[sS]|_T)/.test(candidate) ? 'swift' : null;
  if (!language) return base;
  if (original_name.length > 4096) return { ...base, language, status: 'limited', diagnostics: [{ code: 'resource_limit', severity: 'warning', message: 'Mangled name exceeds the display parser input bound', evidence_ids: [] }] };
  context.checkpoint(original_name.length);
  if (original_name.includes('\0')) return { ...base, language, status: 'unrecognized' };
  const key = `${format}:${original_name}`, prior = cache.get(key);
  if (prior) return prior;
  let engine: ((name: string) => string) | Demangler;
  try {
    if (language === 'c++-itanium') {
      cpp ??= (async () => {
        const bytes = await readFile(new URL(import.meta.resolve('gecko-profiler-demangle/index_bg.wasm')));
        const { instance } = await WebAssembly.instantiate(bytes, { './index_bg.js': cppGlue });
        cppGlue.__wbg_set_wasm(instance.exports);
        (instance.exports.__wbindgen_start as () => void)();
        return cppGlue.demangle_any;
      })();
      engine = await cpp;
    } else if (language === 'swift') {
      swift ??= initializeSwift(); // Node entry uses only its local asset and empty WASI capabilities.
      engine = await swift;
    } else {
      msvc ??= createDemangler(); // Fixed package-local WASM, no caller-controlled path.
      engine = await msvc;
    }
  } catch {
    context.checkpoint(0);
    return { ...base, language, status: 'unavailable', diagnostics: [{ code: 'unavailable_semantics', severity: 'warning', message: `Local ${language} display engine could not initialize`, evidence_ids: [] }] };
  }
  context.checkpoint(0);
  let decoded: string | null = null, parserLimited = false;
  try {
    if (typeof engine === 'function') decoded = engine(candidate);
    else {
      const result = engine.demangleWithText(candidate);
      if (result.status === 'success' && result.consumed === candidate.length) decoded = result.text;
      parserLimited = result.status === 'limit';
    }
  } catch {
    // Malformed manglings cannot replace native linkage names or stop other names.
  }
  context.checkpoint(0);
  const result: NamePresentation = parserLimited || decoded && decoded.length > 8192
    ? { ...base, language, status: 'limited', diagnostics: [{ code: 'resource_limit', severity: 'warning', message: 'Display parser resource or output bound reached', evidence_ids: [] }] }
    : decoded && decoded !== candidate && decoded !== candidate.slice(1)
      ? { ...base, language, status: 'demangled', display_name: decoded }
      : { ...base, language, status: 'unrecognized' };
  const characters = key.length + original_name.length + (result.display_name?.length ?? 0);
  if (cache.size < 1024 && cacheCharacters + characters <= 1_048_576) { cache.set(key, result); cacheCharacters += characters; }
  return result;
}

/** Preserve native addressing and already supplied display labels. Annotation
 * renames are a separate layer, never mutations of original linkage names. */
export async function decorateImageNames(image: LoadedImage, context: OperationContext): Promise<NamedImageMetadata> {
  const diagnostics: Diagnostic[] = [];
  let state: NamedImageMetadata['state'] = 'complete';
  async function decorate<T extends SymbolRecord | ImportRecord | ExportRecord>(records: readonly T[]): Promise<readonly T[]> {
    const output: T[] = [];
    for (const record of records) {
      context.checkpoint(1);
      if (record.original_name === null) { output.push(record); continue; }
      const name = await demangleName(record.original_name, image.target.format, context);
      if (name.status === 'limited' || name.status === 'unavailable') state = 'partial';
      for (const diagnostic of name.diagnostics) if (diagnostics.length < 256) diagnostics.push({ ...diagnostic, entity_id: record.id });
      output.push((record.display_name === null || record.display_name === record.original_name) && name.display_name !== null ? { ...record, display_name: name.display_name } : record);
    }
    return output;
  }
  const symbols = await decorate(image.symbols), imports = await decorate(image.imports), exports = await decorate(image.exports);
  return { symbols, imports, exports, state, diagnostics };
}

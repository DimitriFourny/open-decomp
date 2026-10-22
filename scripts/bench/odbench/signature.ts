/**
 * Tolerant C definition reader for the three lane text styles, and the "signature vs source"
 * comparison built on it.
 *
 * - Open Decomp: a preamble (typedefs, struct bodies, externs, comments), then a one-line or
 *   multi-line signature ending in `{`. The return type may be `unknown_result`.
 * - Ghidra: a blank line, the signature line (`void _name(long *param_1,undefined8 param_2)`), a
 *   blank line, then `{` on its own line.
 * - Source: the function's original definition: storage and export macros (`SQLITE_API`,
 *   `ZEXPORT`, `KEEP`), parameters spread over several lines, the `{` after `)` or on the next line.
 *
 * A definition is a top-level segment (outside every brace, after the previous `;`, `}` or
 * preprocessor line) whose last token is a parameter list `( … )` preceded by a name, followed by
 * `{`. Comments, string literals and preprocessor lines are blanked first. No type is resolved: the
 * return type is classified from the tokens before the name, so unknown macros and typedef names
 * are fine (`static BROTLI_BOOL f(…)`, `uLong ZEXPORT f(…)`). Old-style (K&R) parameter lists and
 * functions returning function pointers are not definitions here.
 */
import { blankNoise } from './metrics.js';

/** Return kind of a definition: `void`, any other type (`value`) or Open Decomp's `unknown_result`. */
export type ReturnKind = 'void' | 'value' | 'unknown_result';

export interface CDefinition {
  readonly name: string;
  /** Source text before the name, comments and attributes removed (storage, macros, return type). */
  readonly head: string;
  readonly returns: ReturnKind;
  /** Parameter declarations as written, whitespace collapsed; `(void)` and `()` give none, `...` is not one. */
  readonly parameters: readonly string[];
  readonly variadic: boolean;
}

const NOT_A_NAME = new Set([
  'if',
  'while',
  'for',
  'switch',
  'return',
  'sizeof',
  'defined',
  'do',
  'else',
  'case',
  '__attribute__',
  '__declspec',
  '_Alignas',
  '_Alignof',
  '__asm__',
  'asm',
  'typeof',
  '__typeof__',
]);
const ATTRIBUTE_NAMES = new Set(['__attribute__', '__declspec', '_Alignas', '__asm__', 'asm']);

const isIdentChar = (char: string | undefined): boolean => char !== undefined && /[\w$]/.test(char);

/** Preprocessor lines (with `\` continuations) become blank lines: they separate top-level segments. */
function blankPreprocessor(code: string): string {
  const lines = code.split('\n');
  let continued = false;
  return lines
    .map((line) => {
      const directive = continued || /^\s*#/.test(line);
      continued = directive && /\\\s*$/.test(line);
      return directive ? '' : line;
    })
    .join('\n');
}

/** Index of the `(` matching the `)` at `close`, or -1. */
function matchingOpen(text: string, close: number): number {
  let depth = 0;
  for (let index = close; index >= 0; index--) {
    const char = text[index];
    if (char === ')') depth++;
    else if (char === '(' && --depth === 0) return index;
  }
  return -1;
}

/** The identifier ending just before `end` (whitespace skipped), with its start index. */
function identifierBefore(text: string, end: number): { name: string; start: number } | null {
  let stop = end;
  while (stop > 0 && /\s/.test(text[stop - 1] ?? '')) stop--;
  let start = stop;
  while (start > 0 && isIdentChar(text[start - 1])) start--;
  if (start === stop || /^\d/.test(text.slice(start, stop))) return null;
  return { name: text.slice(start, stop), start };
}

/** Splits a parameter list at top-level commas (function-pointer parameters keep theirs). */
function splitParameters(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let index = 0; index < list.length; index++) {
    const char = list[index];
    if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') depth--;
    else if (char === ',' && depth === 0) {
      parts.push(list.slice(from, index));
      from = index + 1;
    }
  }
  parts.push(list.slice(from));
  return parts.map((part) => part.replace(/\s+/g, ' ').trim());
}

function classify(head: string): ReturnKind {
  if (/\bunknown_result\b/.test(head)) return 'unknown_result';
  return /\bvoid\b/.test(head) && !head.includes('*') ? 'void' : 'value';
}

/** The definition a segment ending just before a top-level `{` spells, or null. */
function parseSegment(segment: string): CDefinition | null {
  let text = segment.trimEnd();
  // Trailing attribute groups: `__attribute__((noreturn))` follows the parameter list.
  for (;;) {
    if (!text.endsWith(')')) return null;
    const open = matchingOpen(text, text.length - 1);
    if (open < 0) return null;
    const owner = identifierBefore(text, open);
    if (!owner || !ATTRIBUTE_NAMES.has(owner.name)) break;
    text = text.slice(0, owner.start).trimEnd();
  }
  const open = matchingOpen(text, text.length - 1);
  const owner = identifierBefore(text, open);
  if (open < 0 || !owner || NOT_A_NAME.has(owner.name)) return null;
  // Leading attributes of the declaration are not part of the return type.
  let head = text.slice(0, owner.start);
  for (;;) {
    const attribute = /\b(?:__attribute__|__declspec)\s*\(/.exec(head);
    if (!attribute) break;
    const first = attribute.index + attribute[0].length - 1;
    let depth = 0;
    let end = first;
    for (; end < head.length; end++) {
      if (head[end] === '(') depth++;
      else if (head[end] === ')' && --depth === 0) break;
    }
    head = `${head.slice(0, attribute.index)} ${head.slice(end + 1)}`;
  }
  head = head.replace(/\s+/g, ' ').trim();
  if (head === '') return null;
  const inner = splitParameters(text.slice(open + 1, text.length - 1));
  const variadic = inner.includes('...');
  const none = inner.length === 1 && (inner[0] === '' || inner[0] === 'void');
  const parameters = none ? [] : inner.filter((parameter) => parameter !== '...');
  return { name: owner.name, head, returns: classify(head), parameters, variadic };
}

/** Every definition of a text, in order. */
export function readDefinitions(text: string): CDefinition[] {
  const code = blankPreprocessor(blankNoise(text));
  const found: CDefinition[] = [];
  let braces = 0;
  let parens = 0;
  let from = 0;
  for (let index = 0; index < code.length; index++) {
    const char = code[index];
    if (char === '(') parens++;
    else if (char === ')') parens = Math.max(0, parens - 1);
    else if (char === '{') {
      if (braces === 0 && parens === 0) {
        const definition = parseSegment(code.slice(from, index));
        if (definition) found.push(definition);
      }
      braces++;
    } else if (char === '}') {
      braces = Math.max(0, braces - 1);
      if (braces === 0) from = index + 1;
    } else if (char === ';' && braces === 0 && parens === 0) {
      from = index + 1;
    }
  }
  return found;
}

/** Name compared the way tools spell it: Ghidra and Mach-O prefix C names with `_`. */
const bare = (name: string): string => name.replace(/^_+/, '');

/**
 * The definition of the corpus function `name` (`_name` counts) in a lane text. Without a name match
 * (stripped binaries print their own names) the text's last definition: Open Decomp prints the
 * function after its `static inline` helpers; Ghidra and source texts hold one function.
 */
export function readDefinition(text: string, name: string | null): CDefinition | null {
  const definitions = readDefinitions(text);
  const wanted = name === null ? null : bare(name);
  const match = definitions.find((definition) => bare(definition.name) === wanted);
  return match ?? definitions[definitions.length - 1] ?? null;
}

export type ParameterComparison = 'equal' | 'fewer' | 'more';

export interface SignatureComparison {
  readonly returns: ReturnKind;
  readonly source_returns: Exclude<ReturnKind, 'unknown_result'>;
  readonly parameters: ParameterComparison;
}

/** Return kind and parameter count of a lane definition against the source definition of the same function. */
export function compareSignature(
  lane: CDefinition,
  source: CDefinition,
): SignatureComparison | null {
  if (source.returns === 'unknown_result') return null;
  const delta = lane.parameters.length - source.parameters.length;
  return {
    returns: lane.returns,
    source_returns: source.returns,
    parameters: delta === 0 ? 'equal' : delta < 0 ? 'fewer' : 'more',
  };
}

/** Tallies of one lane's signatures against the source's over the same functions. */
export interface SignatureTable {
  readonly lane: string;
  /** Functions compared (both definitions read). */
  readonly compared: number;
  /** Functions whose lane or source definition could not be read, by side. */
  readonly unread_lane: number;
  readonly unread_source: number;
  /** Lane return kind per source return kind. */
  readonly returns: Readonly<Record<'void' | 'value', Readonly<Record<ReturnKind, number>>>>;
  readonly parameters: Readonly<Record<ParameterComparison, number>>;
}

export interface SignatureInput {
  readonly name: string | null;
  readonly lane: string;
  readonly source: string;
}

/** The "signature vs source" table of one lane over `functions` (lane and source text of each). */
export function signatureTable(lane: string, functions: readonly SignatureInput[]): SignatureTable {
  const returns = {
    void: { void: 0, value: 0, unknown_result: 0 },
    value: { void: 0, value: 0, unknown_result: 0 },
  };
  const parameters = { equal: 0, fewer: 0, more: 0 };
  let compared = 0;
  let unreadLane = 0;
  let unreadSource = 0;
  for (const fn of functions) {
    const source = readDefinition(fn.source, fn.name);
    if (!source) {
      unreadSource++;
      continue;
    }
    const definition = readDefinition(fn.lane, fn.name);
    if (!definition) {
      unreadLane++;
      continue;
    }
    const comparison = compareSignature(definition, source);
    if (!comparison) {
      unreadSource++;
      continue;
    }
    compared++;
    returns[comparison.source_returns][comparison.returns]++;
    parameters[comparison.parameters]++;
  }
  return {
    lane,
    compared,
    unread_lane: unreadLane,
    unread_source: unreadSource,
    returns,
    parameters,
  };
}

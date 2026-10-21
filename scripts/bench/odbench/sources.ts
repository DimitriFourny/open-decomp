/**
 * Source lane: the original C definition of each corpus function, comments stripped. The
 * calibration anchor of the benchmark (the judge should prefer it; QA on it validates the questions).
 *
 * `extractDefinition` is a small purpose-built C scanner, not a parser: it indexes every top-level
 * function definition of a file once (comments, string/char literals and preprocessor lines are
 * skipped, braces and parentheses are matched) and answers by name.
 */
import { readFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { hostInfo, resetLane, writeLane, writeText } from './store.js';
import { sourcePath, tierFunctions } from './corpus.js';
import type { Corpus, CorpusFunction, FunctionResult, LaneRun, Tier } from './types.js';

interface Definition {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

const NOT_FUNCTION_NAMES = new Set([
  'if',
  'while',
  'for',
  'switch',
  'return',
  'sizeof',
  'defined',
  '__attribute__',
  '__declspec',
  '_Alignas',
  '_Static_assert',
  'static_assert',
]);

const isIdentStart = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36;
const isIdentPart = (code: number): boolean => isIdentStart(code) || (code >= 48 && code <= 57);
const isBlank = (code: number): boolean =>
  code === 32 || code === 9 || code === 13 || code === 12 || code === 11;

/** End (exclusive) of a string or char literal starting at `from` (the quote); stops at an unescaped newline. */
function skipLiteral(text: string, from: number): number {
  const quote = text.charCodeAt(from);
  let index = from + 1;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 92) {
      index += 2;
      continue;
    }
    if (code === quote) return index + 1;
    if (code === 10) return index;
    index++;
  }
  return text.length;
}

/** End (exclusive) of a block comment starting at `from` (the slash). */
function skipBlockComment(text: string, from: number): number {
  const close = text.indexOf('*/', from + 2);
  return close < 0 ? text.length : close + 2;
}

/** End (exclusive, before the newline) of a `//` comment starting at `from`; honours line continuations. */
function skipLineComment(text: string, from: number): number {
  let index = from + 2;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 10) {
      if (
        text.charCodeAt(index - 1) === 92 ||
        (text.charCodeAt(index - 1) === 13 && text.charCodeAt(index - 2) === 92)
      ) {
        index++;
        continue;
      }
      return index;
    }
    index++;
  }
  return text.length;
}

interface Directive {
  readonly end: number;
  readonly name: string;
  readonly rest: string;
}

/** The preprocessor directive whose `#` is at `from`: its end (before the newline), name and the text after the name. */
function readDirective(text: string, from: number): Directive {
  let index = from + 1;
  while (index < text.length && isBlank(text.charCodeAt(index))) index++;
  const nameStart = index;
  while (index < text.length && isIdentPart(text.charCodeAt(index))) index++;
  const name = text.slice(nameStart, index);
  const restStart = index;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 10) {
      if (
        text.charCodeAt(index - 1) === 92 ||
        (text.charCodeAt(index - 1) === 13 && text.charCodeAt(index - 2) === 92)
      ) {
        index++;
        continue;
      }
      break;
    }
    if (code === 34 || code === 39) {
      index = skipLiteral(text, index);
      continue;
    }
    if (code === 47 && text.charCodeAt(index + 1) === 42) {
      index = skipBlockComment(text, index);
      continue;
    }
    if (code === 47 && text.charCodeAt(index + 1) === 47) {
      index = skipLineComment(text, index);
      continue;
    }
    index++;
  }
  return { end: index, name, rest: text.slice(restStart, index) };
}

interface ConditionalGroup {
  readonly depth: number;
  readonly parens: number;
  readonly headStart: number;
  hasElse: boolean;
}

/**
 * Every top-level function definition of a C file. A definition is a top-level `{` directly preceded
 * by a parenthesized group, named by the identifier before that group, together with the specifier
 * tokens since the previous top-level statement. Conditional-compilation branches are treated as
 * alternatives: every `#else`/`#elif` starts again from the depth at the `#if`, and a group without
 * `#else` leaves the depth unchanged, so unbalanced braces on different branches cannot desynchronize
 * the scan. Text of `#if 0` branches is skipped.
 */
function indexDefinitions(text: string): Map<string, Definition[]> {
  const index = new Map<string, Definition[]>();
  const groups: ConditionalGroup[] = [];
  let depth = 0;
  let parens = 0;
  let headStart = -1; // first token of the current top-level statement
  let groupName: string | null = null; // identifier before the last top-level parenthesized group
  let lastIdentifier: string | null = null; // previous token when it was an identifier
  let afterGroup = false; // previous token closed a top-level parenthesized group
  let open: { name: string; start: number } | null = null;
  let lineStart = true;
  let position = 0;
  const length = text.length;

  const record = (name: string, start: number, end: number): void => {
    const list = index.get(name);
    if (list) list.push({ name, start, end });
    else index.set(name, [{ name, start, end }]);
  };

  while (position < length) {
    const code = text.charCodeAt(position);
    if (code === 10) {
      lineStart = true;
      position++;
      continue;
    }
    if (isBlank(code)) {
      position++;
      continue;
    }
    if (code === 47) {
      const next = text.charCodeAt(position + 1);
      if (next === 42) {
        position = skipBlockComment(text, position);
        continue;
      }
      if (next === 47) {
        position = skipLineComment(text, position);
        continue;
      }
    }
    if (code === 35 && lineStart) {
      const directive = readDirective(text, position);
      position = directive.end;
      if (directive.name === 'if' || directive.name === 'ifdef' || directive.name === 'ifndef') {
        groups.push({ depth, parens, headStart, hasElse: false });
        if (
          directive.name === 'if' &&
          /^\s*0\s*$/.test(directive.rest.replace(/\/\*.*?\*\//g, ''))
        ) {
          // `#if 0`: skip to the matching #else/#elif/#endif; the else branch resumes normal scanning.
          let nesting = 0;
          let cursor = position;
          while (cursor < length) {
            const nextCode = text.charCodeAt(cursor);
            if (nextCode === 10) {
              lineStart = true;
              cursor++;
              continue;
            }
            if (isBlank(nextCode)) {
              cursor++;
              continue;
            }
            if (nextCode === 47 && text.charCodeAt(cursor + 1) === 42) {
              cursor = skipBlockComment(text, cursor);
              continue;
            }
            if (nextCode === 35 && lineStart) {
              const inner = readDirective(text, cursor);
              if (inner.name === 'if' || inner.name === 'ifdef' || inner.name === 'ifndef')
                nesting++;
              else if (inner.name === 'endif' || inner.name === 'else' || inner.name === 'elif') {
                if (nesting === 0) break;
                if (inner.name === 'endif') nesting--;
              }
              cursor = inner.end;
              continue;
            }
            lineStart = false;
            cursor++;
          }
          position = cursor;
        }
      } else if (directive.name === 'else' || directive.name === 'elif') {
        const group = groups[groups.length - 1];
        if (group) {
          group.hasElse = true;
          depth = group.depth;
          parens = group.parens;
          headStart = group.headStart;
          groupName = null;
          lastIdentifier = null;
          afterGroup = false;
          if (depth === 0) open = null;
        }
      } else if (directive.name === 'endif') {
        const group = groups.pop();
        if (group && !group.hasElse) {
          depth = group.depth;
          parens = group.parens;
          headStart = group.headStart;
          groupName = null;
          lastIdentifier = null;
          afterGroup = false;
          if (depth === 0) open = null;
        }
      }
      continue;
    }
    lineStart = false;

    if (code === 34 || code === 39) {
      if (depth === 0) {
        if (headStart < 0) headStart = position;
        lastIdentifier = null;
        afterGroup = false;
      }
      position = skipLiteral(text, position);
      continue;
    }
    if (isIdentStart(code)) {
      const start = position;
      position++;
      while (position < length && isIdentPart(text.charCodeAt(position))) position++;
      if (depth === 0 && parens === 0) {
        if (headStart < 0) headStart = start;
        lastIdentifier = text.slice(start, position);
        afterGroup = false;
      }
      continue;
    }
    if (code === 40) {
      if (depth === 0) {
        if (headStart < 0) headStart = position;
        if (parens === 0) groupName = lastIdentifier;
        parens++;
        lastIdentifier = null;
        afterGroup = false;
      }
      position++;
      continue;
    }
    if (code === 41) {
      if (depth === 0 && parens > 0) {
        parens--;
        afterGroup = parens === 0 && groupName !== null;
      }
      position++;
      continue;
    }
    if (code === 123) {
      if (
        depth === 0 &&
        parens === 0 &&
        afterGroup &&
        groupName !== null &&
        !NOT_FUNCTION_NAMES.has(groupName)
      ) {
        open = { name: groupName, start: headStart };
      }
      depth++;
      lastIdentifier = null;
      afterGroup = false;
      position++;
      continue;
    }
    if (code === 125) {
      if (depth > 0) depth--;
      if (depth === 0) {
        if (open) {
          record(open.name, open.start, position + 1);
          open = null;
          headStart = -1;
          groupName = null;
        }
        parens = 0;
      }
      lastIdentifier = null;
      afterGroup = false;
      position++;
      continue;
    }
    if (depth === 0 && parens === 0) {
      if (code === 59) {
        headStart = -1;
        groupName = null;
      } else if (headStart < 0) headStart = position;
      lastIdentifier = null;
      afterGroup = false;
    }
    position++;
  }
  return index;
}

// Indexing a 9 MB amalgamation takes tens of milliseconds, but the corpus asks for hundreds of names:
// index each distinct text once per process (a few recent texts are kept).
const indexCache = new Map<string, Map<string, Definition[]>>();
const INDEX_CACHE_LIMIT = 4;

function definitionsOf(sourceText: string): Map<string, Definition[]> {
  let index = indexCache.get(sourceText);
  if (!index) {
    index = indexDefinitions(sourceText);
    if (indexCache.size >= INDEX_CACHE_LIMIT)
      indexCache.delete(indexCache.keys().next().value as string);
    indexCache.set(sourceText, index);
  }
  return index;
}

/**
 * Every definition of the top-level C function `name` in source order: specifiers and return type
 * through the closing brace of its body, comments inside kept. More than one entry means the file
 * defines the name on several conditional-compilation branches.
 */
export function extractDefinitions(sourceText: string, name: string): string[] {
  return (definitionsOf(sourceText).get(name) ?? []).map(({ start, end }) =>
    sourceText.slice(start, end),
  );
}

/**
 * The definition of the top-level C function `name`, comments inside kept. Null when there is no
 * definition (prototypes do not count) or more than one (the name is ambiguous).
 */
export function extractDefinition(sourceText: string, name: string): string | null {
  const found = extractDefinitions(sourceText, name);
  return found.length === 1 ? found[0]! : null;
}

/**
 * Removes block and line comments (never inside string/char literals) and drops the lines that
 * the removal left blank; code layout and originally blank lines are kept.
 */
export function stripComments(text: string): string {
  const lines: string[] = [];
  let line = '';
  let touched = false; // a comment was removed from the current line
  const endLine = (): void => {
    if (touched) {
      line = line.replace(/[ \t\r]+$/, '');
      if (line !== '') lines.push(line);
    } else lines.push(line);
    line = '';
    touched = false;
  };
  const gap = (next: number): void => {
    // A comment between two tokens must not glue them together.
    const before = line.charCodeAt(line.length - 1);
    if (line.length > 0 && !isBlank(before) && next < text.length && !isBlank(next) && next !== 10)
      line += ' ';
  };
  let position = 0;
  while (position < text.length) {
    const code = text.charCodeAt(position);
    if (code === 10) {
      endLine();
      position++;
    } else if (code === 34 || code === 39) {
      const end = skipLiteral(text, position);
      line += text.slice(position, end);
      position = end;
    } else if (code === 47 && text.charCodeAt(position + 1) === 42) {
      const end = skipBlockComment(text, position);
      touched = true;
      for (let cursor = position; cursor < end; cursor++) {
        if (text.charCodeAt(cursor) === 10) {
          endLine();
          touched = true;
        }
      }
      gap(text.charCodeAt(end));
      position = end;
    } else if (code === 47 && text.charCodeAt(position + 1) === 47) {
      const end = skipLineComment(text, position);
      touched = true;
      for (let cursor = position; cursor < end; cursor++) {
        if (text.charCodeAt(cursor) === 10) {
          endLine();
          touched = true;
        }
      }
      position = end;
    } else {
      line += text[position];
      position++;
    }
  }
  endLine();
  return lines.join('\n');
}

const fileCache = new Map<string, Promise<string>>();
function readSource(path: string): Promise<string> {
  let text = fileCache.get(path);
  if (!text) {
    text = readFile(path, 'utf8');
    fileCache.set(path, text);
  }
  return text;
}

/** The corpus function's source definition (comments kept or stripped); null when it has no source or none is found. */
export async function sourceDefinition(
  corpus: Corpus,
  fn: CorpusFunction,
  keepComments: boolean,
): Promise<string | null> {
  if (!fn.source) return null;
  const source = corpus.sources.find((candidate) => candidate.id === fn.source?.file);
  if (!source) throw new Error(`corpus: ${fn.id} names unknown source ${fn.source.file}`);
  const sourceText = await readSource(sourcePath(source));
  const definition =
    fn.source.alternative === undefined
      ? extractDefinition(sourceText, fn.source.name)
      : (extractDefinitions(sourceText, fn.source.name)[fn.source.alternative] ?? null);
  if (definition === null) return null;
  return keepComments ? definition : stripComments(definition);
}

export async function runSourceLane(opts: {
  corpus: Corpus;
  corpusSha256: string;
  tier: Tier;
}): Promise<LaneRun> {
  const lane = 'source';
  const started = new Date().toISOString();
  const loadStart = loadavg();
  await resetLane(lane);
  const functions: Record<string, FunctionResult> = {};
  const notes: string[] = [];
  for (const fn of tierFunctions(opts.corpus, opts.tier)) {
    const text = await sourceDefinition(opts.corpus, fn, false);
    if (text === null) {
      functions[fn.id] = {
        state: 'not_found',
        reason: fn.source ? 'definition_not_found' : 'no_source',
        ms: null,
        text_file: null,
        sha256: null,
        bytes: 0,
      };
      notes.push(`${fn.id}: no definition of ${fn.source?.name ?? '(no source)'}`);
      continue;
    }
    functions[fn.id] = {
      state: 'complete',
      reason: null,
      ms: null,
      ...(await writeText(lane, fn.id, `${text}\n`)),
    };
  }
  const run: LaneRun = {
    schema: 'odbench-lane/1',
    lane,
    kind: 'source',
    tool: { name: 'source', version: null, path: null, options: { comments: 'stripped' } },
    corpus_sha256: opts.corpusSha256,
    tier: opts.tier,
    started,
    finished: new Date().toISOString(),
    host: hostInfo(loadStart),
    repeat: 1,
    jobs: 1,
    binaries: {},
    functions,
    notes,
  };
  await writeLane(run);
  return run;
}

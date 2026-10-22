/**
 * Offline static metrics of one decompiled function text.
 *
 * The structure counters are a faithful port of the retired structure sample's counters
 * (`git show 0eaab0f:scripts/bench/structure-gotos.py`; comments and
 * literal contents are blanked first, then regexes count the constructs). On top of them: a C lexer
 * (token counts, distinct identifiers, decision points), brace nesting, casts, generic placeholder
 * names and decompiler artifacts of both tools.
 */

export interface StaticMetrics {
  /** `goto L;` statements. */
  readonly gotos: number;
  /** Labels (`name:` at the start of a line, excluding `case`/`default`/access specifiers). */
  readonly labels: number;
  /** `do { } while (0)` blocks (breakable regions, i.e. jumps in disguise). */
  readonly breakable: number;
  readonly while_true: number;
  readonly for: number;
  /** Loops with a real test: `while (...)` minus breakable and `while (true)`, plus `for`. */
  readonly tested: number;
  readonly breaks: number;
  readonly continues: number;
  /** Distinct `loop_exit_N` flag variables. */
  readonly exit_flags: number;
  /** gotos + breaks + continues + exit_flags + breakable. */
  readonly jumps: number;
  readonly else_if: number;
  /** `if`/`while` conditions holding a comma operator. */
  readonly comma_conditions: number;
  /** `if`/`while` conditions holding a parenthesized assignment compared to a value: `(x = e) != k`. */
  readonly embedded_assignment_conditions: number;
  /** `x | ((uint64_t)y << 32)`: a 64-bit value rebuilt from two 32-bit cells. */
  readonly cells64: number;
  /** Local declarations at the top of the body. */
  readonly decls: number;
  /** OD result-unknown markers (`unknown_result` return type or value), occurrences. */
  readonly unknown_result: number;
  /** `unknown_value(` calls. */
  readonly unknown_values: number;
  /** `__unknown_effect(` calls. */
  readonly unknown_effects: number;
  /** `boundary(` calls. */
  readonly boundaries: number;
  /** `requirement_predicate(` calls. */
  readonly requirement_predicates: number;
  /** Function-pointer casts whose parameter list contains `...`: `(T (*)(A, ...))f`. */
  readonly open_pointer_casts: number;
  /** 0/1: the text declares a `frame` struct (`} frame;`). */
  readonly with_frame: number;
  /** Body lines with a call ending `, ...)`. */
  readonly open_calls: number;
  /** Lines (comments included) mentioning `entry_sp`. */
  readonly entry_sp_lines: number;
  /** 0/1 flags so that totals over functions count functions. */
  readonly with_goto: number;
  readonly with_entry_sp: number;
  readonly with_cells64: number;
  /** Non-blank, non-comment lines. */
  readonly lines: number;
  readonly bytes: number;
  /** UTF-8 bytes inside comments. */
  readonly comment_bytes: number;
  /** C lexer tokens, comments excluded. */
  readonly lexical_tokens: number;
  /**
   * Deepest nesting of blocks inside the function body: the body's own braces are level 0, so
   * `f() { if (a) { while (b) { } } }` has 2. 0 when the text has no braces.
   */
  readonly max_nesting: number;
  /** `if`, `while`, `for`, `case`, `&&`, `||`, `?`. */
  readonly decision_points: number;
  /** Parenthesized scalar/pointer/struct type name followed by an operand. */
  readonly casts: number;
  /** Distinct non-keyword identifiers. */
  readonly identifiers: number;
  /** Distinct identifiers matching a generic placeholder pattern of either tool. */
  readonly placeholder_names: number;
  /** placeholder_names / identifiers (0 when there are no identifiers). */
  readonly placeholder_ratio: number;
  /** Occurrences per artifact pattern name (every pattern of {@link ARTIFACT_PATTERNS} is present). */
  readonly artifacts: Readonly<Record<string, number>>;
  readonly artifacts_total: number;
}

export type ScalarMetricKey = Exclude<keyof StaticMetrics, 'artifacts'>;

/** Every scalar counter in report order; `aggregate` says how totals over functions combine. */
export const SCALAR_METRICS: readonly {
  readonly key: ScalarMetricKey;
  readonly label: string;
  readonly aggregate: 'sum' | 'max' | 'ratio';
}[] = [
  { key: 'lexical_tokens', label: 'lexical tokens', aggregate: 'sum' },
  { key: 'bytes', label: 'bytes', aggregate: 'sum' },
  { key: 'lines', label: 'lines (non-blank, no comments)', aggregate: 'sum' },
  { key: 'comment_bytes', label: 'comment bytes', aggregate: 'sum' },
  { key: 'gotos', label: 'goto', aggregate: 'sum' },
  { key: 'with_goto', label: 'functions with a goto', aggregate: 'sum' },
  { key: 'labels', label: 'labels', aggregate: 'sum' },
  { key: 'breakable', label: 'do { } while (0)', aggregate: 'sum' },
  { key: 'breaks', label: 'break', aggregate: 'sum' },
  { key: 'continues', label: 'continue', aggregate: 'sum' },
  { key: 'exit_flags', label: 'exit-flag variables', aggregate: 'sum' },
  { key: 'jumps', label: 'jump statements', aggregate: 'sum' },
  { key: 'while_true', label: 'while (true)', aggregate: 'sum' },
  { key: 'for', label: 'for', aggregate: 'sum' },
  { key: 'tested', label: 'loops with a test', aggregate: 'sum' },
  { key: 'else_if', label: 'else if', aggregate: 'sum' },
  { key: 'comma_conditions', label: 'comma conditions', aggregate: 'sum' },
  {
    key: 'embedded_assignment_conditions',
    label: 'embedded-assignment conditions `(x = e) op k`',
    aggregate: 'sum',
  },
  { key: 'unknown_result', label: 'unknown_result', aggregate: 'sum' },
  { key: 'unknown_values', label: 'unknown_value(', aggregate: 'sum' },
  { key: 'unknown_effects', label: '__unknown_effect(', aggregate: 'sum' },
  { key: 'boundaries', label: 'boundary(', aggregate: 'sum' },
  { key: 'requirement_predicates', label: 'requirement_predicate(', aggregate: 'sum' },
  { key: 'open_pointer_casts', label: 'function-pointer casts with `...`', aggregate: 'sum' },
  { key: 'with_frame', label: 'functions with a frame struct', aggregate: 'sum' },
  { key: 'decision_points', label: 'decision points', aggregate: 'sum' },
  { key: 'max_nesting', label: 'max nesting', aggregate: 'max' },
  { key: 'decls', label: 'local declarations', aggregate: 'sum' },
  { key: 'casts', label: 'casts', aggregate: 'sum' },
  { key: 'identifiers', label: 'distinct identifiers (per function, summed)', aggregate: 'sum' },
  { key: 'placeholder_names', label: 'placeholder names', aggregate: 'sum' },
  { key: 'placeholder_ratio', label: 'placeholder ratio', aggregate: 'ratio' },
  { key: 'entry_sp_lines', label: 'lines with entry_sp', aggregate: 'sum' },
  { key: 'with_entry_sp', label: 'functions with entry_sp', aggregate: 'sum' },
  { key: 'open_calls', label: 'body lines with a call ending , ...)', aggregate: 'sum' },
  { key: 'cells64', label: '64-bit cell reassemblies', aggregate: 'sum' },
  { key: 'with_cells64', label: 'functions with a reassembly', aggregate: 'sum' },
  { key: 'artifacts_total', label: 'artifacts (all patterns)', aggregate: 'sum' },
];

export interface NamePattern {
  readonly name: string;
  readonly tool: 'od' | 'ghidra';
  /** Global regex; placeholder patterns are anchored (`^…$`) and tested against whole identifiers. */
  readonly regex: RegExp;
  /** `code`: comments and literals blanked; `text`: the raw text (artifacts that live in comments). */
  readonly scope?: 'code' | 'text';
}

/** Generic names a decompiler invents when it recovers no real name. Whole-identifier matches. */
export const PLACEHOLDER_PATTERNS: readonly NamePattern[] = [
  { name: '[a-z]{1,4}Var<N>', tool: 'ghidra', regex: /^[a-z]{1,4}Var\d+$/ },
  { name: 'local_<hex>', tool: 'ghidra', regex: /^local_[0-9a-f]+$/ },
  { name: 'param_<N>', tool: 'ghidra', regex: /^param_\d+$/ },
  { name: '*Stack_<hex>', tool: 'ghidra', regex: /^[a-z]*Stack_[0-9a-f]+$/ },
  { name: 'in_*', tool: 'ghidra', regex: /^in_\w+$/ },
  { name: 'extraout_*', tool: 'ghidra', regex: /^extraout_\w+$/ },
  { name: 'unaff_*', tool: 'ghidra', regex: /^unaff_\w+$/ },
  { name: 'DAT_<hex>', tool: 'ghidra', regex: /^DAT_[0-9a-f]+$/ },
  { name: 'PTR_*', tool: 'ghidra', regex: /^PTR_\w+$/ },
  { name: 'FUN_<hex>', tool: 'ghidra', regex: /^FUN_[0-9a-f]+$/ },
  { name: 'LAB_<hex>', tool: 'ghidra', regex: /^LAB_[0-9a-f]+$/ },
  { name: 'sub_<hex>', tool: 'od', regex: /^sub_[0-9a-f]+$/ },
  { name: 'field_0x<hex>', tool: 'od', regex: /^field_0x[0-9a-f]+$/ },
  { name: 'type_<N>', tool: 'od', regex: /^type_\d+$/ },
  { name: 'value<N>', tool: 'od', regex: /^value\d+$/ },
  { name: 'arg<N>', tool: 'od', regex: /^arg\d+$/ },
  { name: 'v<N>', tool: 'od', regex: /^v\d+$/ },
  { name: 'x<N>', tool: 'od', regex: /^x\d+$/ },
  { name: 'w<N>', tool: 'od', regex: /^w\d+$/ },
  { name: 'var<N>', tool: 'od', regex: /^var\d+$/ },
  { name: 'tmp[N]', tool: 'od', regex: /^tmp\d*$/ },
];

/** Decompiler-specific constructs that carry no source-level meaning; counted per occurrence. */
export const ARTIFACT_PATTERNS: readonly NamePattern[] = [
  { name: 'entry_sp', tool: 'od', regex: /\bentry_sp\b/g },
  { name: '__od_*', tool: 'od', regex: /\b__od_\w+/g },
  { name: 'unknown_*', tool: 'od', regex: /\bunknown_\w+/g },
  { name: 'requirement_predicate', tool: 'od', regex: /\brequirement_predicate\b/g },
  { name: 'physical_*', tool: 'od', regex: /\bphysical_\w+/g },
  { name: 'bv_*', tool: 'od', regex: /\bbv_\w+/g },
  { name: 'insert_bits', tool: 'od', regex: /\binsert_bits\b/g },
  { name: 'indirect_exit', tool: 'od', regex: /\bindirect_exit\b/g },
  { name: 'loop_exit_<N>', tool: 'od', regex: /\bloop_exit_\d+\b/g },
  { name: 'open call ", ...)"', tool: 'od', regex: /,\s*\.\.\.\)/g },
  { name: 'CONCAT<N>', tool: 'ghidra', regex: /\bCONCAT\d+\b/g },
  { name: 'SUB<N>', tool: 'ghidra', regex: /\bSUB\d+\b/g },
  { name: 'ZEXT<N>', tool: 'ghidra', regex: /\bZEXT\d+\b/g },
  { name: 'SEXT<N>', tool: 'ghidra', regex: /\bSEXT\d+\b/g },
  { name: 'CARRY<N>', tool: 'ghidra', regex: /\bCARRY\d\b/g },
  { name: 'SCARRY<N>', tool: 'ghidra', regex: /\bSCARRY\d\b/g },
  { name: 'SBORROW<N>', tool: 'ghidra', regex: /\bSBORROW\d\b/g },
  { name: 'undefined[N]', tool: 'ghidra', regex: /\bundefined\d*\b/g },
  { name: 'WARNING', tool: 'ghidra', regex: /\bWARNING\b/g, scope: 'text' },
  { name: 'extraout_*', tool: 'ghidra', regex: /\bextraout_/g },
  { name: 'unaff_*', tool: 'ghidra', regex: /\bunaff_/g },
  { name: 'in_<x>', tool: 'ghidra', regex: /\bin_[A-Za-z]/g },
  { name: 'halt_baddata', tool: 'ghidra', regex: /\bhalt_baddata\b/g },
  { name: 'UNRECOVERED_JUMPTABLE', tool: 'ghidra', regex: /\bUNRECOVERED_JUMPTABLE\b/g },
  { name: '(code *)', tool: 'ghidra', regex: /\(\s*code\s*\*\s*\)/g },
];

// ---- structure sample counters (retired structure-gotos.py) -------------------------------------

const KEYWORDS_NOT_LABELS = new Set(['default', 'case', 'public', 'private']);
const NOT_BODY = /^(?:typedef|struct|union|enum|extern|static|inline|#)/;
const DECLARATION = new RegExp(
  '^(?:\\s+(?!(?:return|goto|break|continue|else|case|default|do|typedef|throw)\\b)' +
    '[A-Za-z_][\\w \\t]*?[ \\t*]+\\w+[ \\t]*(?:\\[[^\\]\\n]*\\][ \\t]*)*;\\s*)$',
);
const HELPER = /\b(?:unknown_\w+|requirement_predicate|physical_\w+)\b/;
const ENTRY_SP = /\bentry_sp\b/;
const OPEN_CALL = /,\s*\.\.\.\)/;
const UNKNOWN_RESULT = /\bunknown_result\b/g;
const UNKNOWN_VALUE = /\bunknown_value\s*\(/g;
const UNKNOWN_EFFECT = /\b__unknown_effect\s*\(/g;
const BOUNDARY = /\bboundary\s*\(/g;
const REQUIREMENT_PREDICATE = /\brequirement_predicate\s*\(/g;
/** `(*)(…, ...)` with at most one level of nested parentheses in the parameter list. */
const OPEN_POINTER_CAST = /\(\s*\*\s*\)\s*\((?:[^()]|\([^()]*\))*\.\.\.\s*\)/g;
const FRAME_STRUCT = /\}\s*frame\s*;/;
const CELL64 = /\|\s*\(\s*\(\s*uint64_t\s*\)\s*[A-Za-z_]\w*\s*<<\s*32\s*\)/g;
const EXIT_FLAG = /\bloop_exit_\d+\b/g;
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

/** Python `str.splitlines()`. */
function splitLines(text: string): string[] {
  const lines = text.split(LINE_BREAK);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function countMatches(regex: RegExp, text: string): number {
  let found = 0;
  for (const _ of text.matchAll(regex)) found++;
  return found;
}

/** End index (exclusive) of a quoted literal starting at `start`, or -1 when it is unterminated on its line. */
function literalEnd(text: string, start: number): number {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index++) {
    const char = text[index];
    if (char === '\\') {
      if (index + 1 >= text.length) return -1;
      index++;
    } else if (char === quote) {
      return index + 1;
    } else if (char === '\n') {
      return -1;
    }
  }
  return -1;
}

/** Comments become spaces (newlines kept), string and char literals become their bare quotes. */
export function blankNoise(text: string): string {
  const parts: string[] = [];
  let copied = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    let end = -1;
    let replacement = '';
    if (char === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      if (close >= 0) {
        end = close + 2;
        replacement = text.slice(index, end).replace(/[^\n]/g, ' ');
      }
    } else if (char === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index);
      end = newline < 0 ? text.length : newline;
      replacement = ' '.repeat(end - index);
    } else if (char === '"' || char === "'") {
      end = literalEnd(text, index);
      replacement = char + char;
    }
    if (end < 0) {
      index++;
      continue;
    }
    parts.push(text.slice(copied, index), replacement);
    copied = index = end;
  }
  parts.push(text.slice(copied));
  return parts.join('');
}

/** `if` / `while` conditions holding a comma operator, e.g. `(x = f(), x != 0)`. */
function commaConditions(code: string): number {
  let found = 0;
  for (const match of code.matchAll(/\b(?:if|while)\s*\(/g)) {
    const groups = [true]; // innermost open group may hold a comma operator (false: call arguments)
    for (let index = match.index + match[0].length; index < code.length; index++) {
      const char = code[index];
      if (char === '(') {
        let back = index - 1;
        while (back >= 0 && /\s/.test(code[back] ?? '')) back--;
        const before = back >= 0 ? (code[back] ?? '') : '';
        // Python: `before in '_)]'` is also true for the empty string.
        groups.push(!(/[\p{L}\p{N}]/u.test(before) || before === '' || '_)]'.includes(before)));
      } else if (char === ')') {
        groups.pop();
        if (groups.length === 0) break;
      } else if (char === ',' && groups[groups.length - 1]) {
        found++;
        break;
      } else if (char === ';' || char === '{' || char === '}') {
        break;
      }
    }
  }
  return found;
}

/** True when the `)` at `close` ends a type-name group (`(uint32_t)`, `(struct s*)`), i.e. a cast. */
function closesCast(code: string, close: number): boolean {
  let depth = 0;
  for (let index = close; index >= 0; index--) {
    if (code[index] === ')') depth++;
    else if (code[index] === '(' && --depth === 0) {
      let back = index - 1;
      while (back >= 0 && /\s/.test(code[back] ?? '')) back--;
      return /^[\w\s*]+$/.test(code.slice(index + 1, close)) && !/[\w)\]]/.test(code[back] ?? ' ');
    }
  }
  return false;
}

/**
 * `if` / `while` conditions with an assignment inside a parenthesized group that is followed by a
 * comparison or arithmetic operator: `(x = f()) != 0`, `(uint32_t)(n -= 2) > 0`, `(v = a + b) >> 16`.
 * One per condition. Call argument lists and `sizeof` groups (a group preceded by a name or a
 * closing bracket other than a cast) never count; a group holding a comma operator is the business
 * of `comma_conditions`, and `(x = e) && y` has no operator on the value.
 */
function embeddedAssignmentConditions(code: string): number {
  const OPERATOR_AFTER = /^\s*(?:==|!=|<=|>=|<|>|\+|-|\*|\/|%|&(?!&)|\|(?!\|)|\^)/;
  let found = 0;
  for (const match of code.matchAll(/\b(?:if|while)\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const groups: { assigns: boolean; value: boolean }[] = [];
    let counted = false;
    for (let index = open; index < code.length && !counted; index++) {
      const char = code[index];
      if (char === '(') {
        let back = index - 1;
        while (back >= 0 && /\s/.test(code[back] ?? '')) back--;
        const before = back >= 0 ? (code[back] ?? '') : '';
        // A value group: not the condition's own parenthesis, not a call or index, maybe a cast's operand.
        const value =
          index !== open &&
          (!/[\p{L}\p{N}_)\]]/u.test(before) || (before === ')' && closesCast(code, back)));
        groups.push({ assigns: false, value });
      } else if (char === ')') {
        const group = groups.pop();
        if (!group) break;
        if (group.value && group.assigns && OPERATOR_AFTER.test(code.slice(index + 1)))
          counted = true;
        if (groups.length === 0) break;
      } else if (
        char === '=' &&
        code[index + 1] !== '=' &&
        !'=!<>'.includes(code[index - 1] ?? '')
      ) {
        // Only the group's own level: an assignment inside a nested call belongs to that call.
        const top = groups[groups.length - 1];
        if (top) top.assigns = true;
      } else if (char === ';' || char === '{' || char === '}') {
        break;
      }
    }
    if (counted) found++;
  }
  return found;
}

/**
 * Index of the line that opens the function body: the first unindented line ending in `{` that is not a
 * type, extern/static/inline or preprocessor line (the signature is the line itself or the block above
 * a lone `{`). Lines up to it are preamble and never count as declarations.
 */
function bodyLine(clean: readonly string[]): number {
  for (const [index, line] of clean.entries())
    if (!/^\s/.test(line) && line.trimEnd().endsWith('{') && !NOT_BODY.test(line)) return index;
  return clean.length;
}

interface StructureCounts {
  gotos: number;
  labels: number;
  breakable: number;
  while_true: number;
  for: number;
  tested: number;
  breaks: number;
  continues: number;
  exit_flags: number;
  jumps: number;
  else_if: number;
  comma_conditions: number;
  embedded_assignment_conditions: number;
  cells64: number;
  decls: number;
  open_calls: number;
  entry_sp_lines: number;
  lines: number;
}

function structure(text: string, code: string): StructureCounts {
  const lines = splitLines(text);
  const clean = splitLines(code);
  const gotos = countMatches(/\bgoto\s+\w+\s*;/g, code);
  let labels = 0;
  for (const match of code.matchAll(/^\s*([A-Za-z_]\w*):(?!:)/gm))
    if (!KEYWORDS_NOT_LABELS.has(match[1] ?? '')) labels++;
  const breakable = countMatches(/\}\s*while\s*\(\s*0\s*\)\s*;/g, code);
  const whileTrue = countMatches(/\bwhile\s*\(\s*(?:true|1)\s*\)/g, code);
  const forLoops = countMatches(/^\s*for\s*\(/gm, code);
  const whiles = countMatches(/\bwhile\s*\(/g, code);
  const breaks = countMatches(/\bbreak\s*;/g, code);
  const continues = countMatches(/\bcontinue\s*;/g, code);
  const exitFlags = new Set(code.match(EXIT_FLAG) ?? []).size;
  const result: StructureCounts = {
    gotos,
    labels,
    breakable,
    while_true: whileTrue,
    for: forLoops,
    tested: whiles - breakable - whileTrue + forLoops,
    breaks,
    continues,
    exit_flags: exitFlags,
    jumps: gotos + breaks + continues + exitFlags + breakable,
    else_if: countMatches(/\belse\s+if\b/g, code),
    comma_conditions: commaConditions(code),
    embedded_assignment_conditions: embeddedAssignmentConditions(code),
    cells64: countMatches(CELL64, code),
    decls: 0,
    open_calls: 0,
    entry_sp_lines: 0,
    lines: 0,
  };
  const body = bodyLine(clean);
  for (const [index, line] of lines.entries()) {
    if (ENTRY_SP.test(line)) result.entry_sp_lines++;
    if (!line.trim()) continue;
    const shown = index < clean.length ? (clean[index] ?? '').trim() : '';
    if (!shown) continue; // comment-only line
    result.lines++;
    if (
      index > body &&
      !ENTRY_SP.test(shown) &&
      !HELPER.test(shown) &&
      DECLARATION.test(clean[index] ?? '')
    )
      result.decls++;
    if (index > body && OPEN_CALL.test(shown)) result.open_calls++;
  }
  return result;
}

// ---- lexer -------------------------------------------------------------------------------------

const C_KEYWORDS = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extern',
  'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register', 'restrict', 'return', 'short', 'signed',
  'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while', '_Bool',
  '_Complex', '_Atomic', '_Alignas', '_Alignof', '_Generic', '_Noreturn', '_Static_assert', '_Thread_local',
]); // prettier-ignore
const PUNCT3 = new Set(['<<=', '>>=', '...']);
const PUNCT2 = new Set([
  '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '*=', '/=', '%=', '+=', '-=', '&=', '^=',
  '|=', '##',
]); // prettier-ignore
const STRING_PREFIXES = new Set(['L', 'u', 'U', 'u8']);

function isIdentChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 36 ||
    code > 127
  );
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

interface LexResult {
  tokens: number;
  commentBytes: number;
  decisions: number;
  identifiers: Set<string>;
}

function lex(text: string): LexResult {
  const result: LexResult = { tokens: 0, commentBytes: 0, decisions: 0, identifiers: new Set() };
  const length = text.length;
  let index = 0;
  while (index < length) {
    const code = text.charCodeAt(index);
    const char = text[index] ?? '';
    if (code === 32 || (code >= 9 && code <= 13)) {
      index++;
    } else if (char === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      const end = close < 0 ? length : close + 2;
      result.commentBytes += Buffer.byteLength(text.slice(index, end));
      index = end;
    } else if (char === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index);
      const end = newline < 0 ? length : newline;
      result.commentBytes += Buffer.byteLength(text.slice(index, end));
      index = end;
    } else if (char === '"' || char === "'") {
      const end = literalEnd(text, index);
      result.tokens++;
      if (end >= 0) {
        index = end;
      } else {
        const newline = text.indexOf('\n', index);
        index = newline < 0 ? length : newline;
      }
    } else if (isDigit(code) || (char === '.' && isDigit(text.charCodeAt(index + 1)))) {
      let end = index + 1;
      while (end < length) {
        const next = text.charCodeAt(end);
        const sign = text[end];
        const previous = text[end - 1] ?? '';
        if (
          isIdentChar(next) ||
          sign === '.' ||
          ((sign === '+' || sign === '-') && 'eEpP'.includes(previous))
        )
          end++;
        else break;
      }
      result.tokens++;
      index = end;
    } else if (isIdentChar(code)) {
      let end = index + 1;
      while (end < length && isIdentChar(text.charCodeAt(end))) end++;
      const word = text.slice(index, end);
      index = end;
      if (STRING_PREFIXES.has(word) && (text[end] === '"' || text[end] === "'")) continue; // prefix of the next literal
      result.tokens++;
      if (C_KEYWORDS.has(word)) {
        if (word === 'if' || word === 'while' || word === 'for' || word === 'case')
          result.decisions++;
      } else {
        result.identifiers.add(word);
      }
    } else {
      const three = text.slice(index, index + 3);
      const two = text.slice(index, index + 2);
      let width = 1;
      if (PUNCT3.has(three)) width = 3;
      else if (PUNCT2.has(two)) width = 2;
      if (width === 2 && (two === '&&' || two === '||')) result.decisions++;
      if (width === 1 && char === '?') result.decisions++;
      result.tokens++;
      index += width;
    }
  }
  return result;
}

// ---- nesting, casts ----------------------------------------------------------------------------

function maxNesting(code: string): number {
  let depth = 0;
  let deepest = 0;
  for (const char of code) {
    if (char === '{') {
      depth++;
      if (depth > deepest) deepest = depth;
    } else if (char === '}' && depth > 0) {
      depth--;
    }
  }
  return Math.max(0, deepest - 1);
}

const CAST_TYPE =
  '(?:u?int(?:8|16|32|64|ptr|max)?_t|size_t|ssize_t|ptrdiff_t|char|(?:long(?:[ \\t]+long)?|short)(?:[ \\t]+int)?|int|float|double|bool|_Bool|void' +
  '|undefined\\d*|byte|uint|ulong|ushort|longlong|ulonglong|code|(?:struct|union|enum)[ \\t]+\\w+|\\w+_t)';
const CAST = new RegExp(
  '(?<![\\w)\\]])(?<!\\bsizeof[ \\t]*)\\([ \\t]*(?:(?:const|volatile)[ \\t]+)*' +
    `(?:(?:unsigned|signed)(?:[ \\t]+${CAST_TYPE})?|${CAST_TYPE})` +
    '(?:[ \\t]+const)?(?:[ \\t]*\\*+[ \\t]*(?:const\\b[ \\t]*)?)*[ \\t]*\\)[ \\t]*(?=[A-Za-z0-9_(&*~!\'"+-])',
  'g',
);

// ---- entry point -------------------------------------------------------------------------------

const PLACEHOLDER_TESTS = PLACEHOLDER_PATTERNS.map((pattern) => pattern.regex);

export function computeMetrics(text: string): StaticMetrics {
  const code = blankNoise(text);
  const counts = structure(text, code);
  const tokens = lex(text);
  let placeholders = 0;
  for (const identifier of tokens.identifiers)
    if (PLACEHOLDER_TESTS.some((regex) => regex.test(identifier))) placeholders++;
  const artifacts: Record<string, number> = {};
  let artifactsTotal = 0;
  for (const pattern of ARTIFACT_PATTERNS) {
    const found = countMatches(pattern.regex, pattern.scope === 'text' ? text : code);
    artifacts[pattern.name] = found;
    artifactsTotal += found;
  }
  return {
    gotos: counts.gotos,
    labels: counts.labels,
    breakable: counts.breakable,
    while_true: counts.while_true,
    for: counts.for,
    tested: counts.tested,
    breaks: counts.breaks,
    continues: counts.continues,
    exit_flags: counts.exit_flags,
    jumps: counts.jumps,
    else_if: counts.else_if,
    comma_conditions: counts.comma_conditions,
    embedded_assignment_conditions: counts.embedded_assignment_conditions,
    cells64: counts.cells64,
    decls: counts.decls,
    open_calls: counts.open_calls,
    unknown_result: countMatches(UNKNOWN_RESULT, code),
    unknown_values: countMatches(UNKNOWN_VALUE, code),
    unknown_effects: countMatches(UNKNOWN_EFFECT, code),
    boundaries: countMatches(BOUNDARY, code),
    requirement_predicates: countMatches(REQUIREMENT_PREDICATE, code),
    open_pointer_casts: countMatches(OPEN_POINTER_CAST, code),
    with_frame: FRAME_STRUCT.test(code) ? 1 : 0,
    entry_sp_lines: counts.entry_sp_lines,
    with_goto: counts.gotos > 0 ? 1 : 0,
    with_entry_sp: counts.entry_sp_lines > 0 ? 1 : 0,
    with_cells64: counts.cells64 > 0 ? 1 : 0,
    lines: counts.lines,
    bytes: Buffer.byteLength(text),
    comment_bytes: tokens.commentBytes,
    lexical_tokens: tokens.tokens,
    max_nesting: maxNesting(code),
    decision_points: tokens.decisions,
    casts: countMatches(CAST, code),
    identifiers: tokens.identifiers.size,
    placeholder_names: placeholders,
    placeholder_ratio: tokens.identifiers.size === 0 ? 0 : placeholders / tokens.identifiers.size,
    artifacts,
    artifacts_total: artifactsTotal,
  };
}

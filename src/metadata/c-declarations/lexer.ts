import type { CDiagnostic } from './types.js';

export interface Token {
  readonly kind: 'ident' | 'number' | 'char' | 'string' | 'punct' | 'eof';
  readonly text: string;
  readonly line: number;
  readonly column: number;
  /** `#pragma pack` limit in effect at this token (null = natural alignment). */
  readonly pack: number | null;
}

export interface LexResult {
  readonly tokens: readonly Token[];
  readonly diagnostics: readonly CDiagnostic[];
}

const PUNCTUATORS = ['...', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '->'];
const PACK_VALUES = new Set([1, 2, 4, 8, 16]);

function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
}
function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}

/**
 * Tokenizes C source. Comments and preprocessor lines are dropped, except that
 * `#pragma pack` is interpreted in place: each token records the pack limit that applies to it.
 */
export function lex(source: string): LexResult {
  const tokens: Token[] = [];
  const diagnostics: CDiagnostic[] = [];
  const stack: (number | null)[] = [];
  let pack: number | null = null;
  let pos = 0;
  let line = 1;
  let lineStart = 0;
  let atLineStart = true;

  const column = (at: number): number => at - lineStart + 1;
  const diagnose = (message: string, atLine: number, atColumn: number): void => {
    diagnostics.push({ message, line: atLine, column: atColumn });
  };
  const newline = (): void => {
    // Called with `pos` on the first character of a line terminator.
    if (source[pos] === '\r' && source[pos + 1] === '\n') pos++;
    pos++;
    line++;
    lineStart = pos;
    atLineStart = true;
  };
  const push = (kind: Token['kind'], start: number, end: number): void => {
    tokens.push({ kind, text: source.slice(start, end), line, column: column(start), pack });
  };

  const applyPragma = (text: string, atLine: number, atColumn: number): void => {
    const match = /^#\s*pragma\s+pack\b\s*(?:\(([^)]*)\))?\s*$/.exec(text);
    if (!match) return;
    const args = (match[1] ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const number = (value: string): number | null => {
      if (!/^[0-9]+$/.test(value) || !PACK_VALUES.has(Number(value))) {
        diagnose(`invalid #pragma pack value '${value}'`, atLine, atColumn);
        return null;
      }
      return Number(value);
    };
    const first = args[0];
    if (first === undefined) pack = null;
    else if (first === 'show') return;
    else if (first === 'push') {
      stack.push(pack);
      const value = args.find((arg, index) => index > 0 && /^[0-9]+$/.test(arg));
      if (value !== undefined) pack = number(value);
    } else if (first === 'pop') {
      if (stack.length === 0) diagnose('#pragma pack(pop) without matching push', atLine, atColumn);
      else pack = stack.pop() ?? null;
      const value = args.find((arg, index) => index > 0 && /^[0-9]+$/.test(arg));
      if (value !== undefined) pack = number(value);
    } else pack = number(first);
  };

  while (pos < source.length) {
    const c = source[pos] as string;
    if (c === '\n' || c === '\r') {
      newline();
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\f' || c === '\v') {
      pos++;
      continue;
    }
    if (c === '/' && source[pos + 1] === '/') {
      while (pos < source.length && source[pos] !== '\n' && source[pos] !== '\r') pos++;
      continue;
    }
    if (c === '/' && source[pos + 1] === '*') {
      const startLine = line;
      const startColumn = column(pos);
      pos += 2;
      let closed = false;
      while (pos < source.length) {
        if (source[pos] === '*' && source[pos + 1] === '/') {
          pos += 2;
          closed = true;
          break;
        }
        if (source[pos] === '\n' || source[pos] === '\r') {
          newline();
          atLineStart = false;
        } else pos++;
      }
      if (!closed) diagnose('unterminated comment', startLine, startColumn);
      continue;
    }
    if (c === '#' && atLineStart) {
      const startLine = line;
      const startColumn = column(pos);
      let text = '';
      for (;;) {
        const begin = pos;
        while (pos < source.length && source[pos] !== '\n' && source[pos] !== '\r') pos++;
        const part = source.slice(begin, pos);
        if (part.endsWith('\\') && pos < source.length) {
          text += part.slice(0, -1);
          newline();
          atLineStart = false;
          continue;
        }
        text += part;
        break;
      }
      applyPragma(text.replace(/\/\*.*?\*\//g, ' ').replace(/\/\/.*$/, ''), startLine, startColumn);
      continue;
    }
    atLineStart = false;
    const start = pos;
    if (isIdentStart(c)) {
      pos++;
      while (pos < source.length && isIdentPart(source[pos] as string)) pos++;
      push('ident', start, pos);
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(source[pos + 1] ?? ''))) {
      pos++;
      const hex = /^0[xX]/.test(source.slice(start, start + 2));
      while (pos < source.length) {
        const d = source[pos] as string;
        if (isIdentPart(d) || d === '.') pos++;
        else if ((d === '+' || d === '-') && !hex && /[eE]/.test(source[pos - 1] as string)) pos++;
        else break;
      }
      push('number', start, pos);
      continue;
    }
    if (c === '"' || c === "'") {
      pos++;
      let closed = false;
      while (pos < source.length) {
        const d = source[pos] as string;
        if (d === '\n' || d === '\r') break;
        pos++;
        if (d === '\\' && pos < source.length && source[pos] !== '\n' && source[pos] !== '\r')
          pos++;
        else if (d === c) {
          closed = true;
          break;
        }
      }
      if (!closed)
        diagnose(`unterminated ${c === '"' ? 'string' : 'character'} literal`, line, column(start));
      push(c === '"' ? 'string' : 'char', start, pos);
      continue;
    }
    const multi = PUNCTUATORS.find((p) => source.startsWith(p, pos));
    if (multi !== undefined) {
      pos += multi.length;
      push('punct', start, pos);
      continue;
    }
    if ('{}()[];,*=:<>+-/%&|^~!?.#'.includes(c)) {
      pos++;
      push('punct', start, pos);
      continue;
    }
    diagnose(`unexpected character '${c}'`, line, column(start));
    pos++;
  }
  tokens.push({ kind: 'eof', text: '', line, column: column(pos), pack });
  return { tokens, diagnostics };
}

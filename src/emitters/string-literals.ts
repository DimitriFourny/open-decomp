import type { Emission } from '../core/index.js';

type Language = Emission['language'];

/** Longest string shown in full: characters beyond it are replaced by an
 * explicit marker that keeps the address and total length. */
export const STRING_LITERAL_LIMIT = 200;

/** Characters never printed raw: controls, format/bidirectional controls,
 * line/paragraph separators, private-use and unassigned code points. Target text
 * can therefore neither reorder displayed code nor hide in invisible characters. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/u;
const C_NAMED: Readonly<Record<number, string>> = {
  7: '\\a',
  8: '\\b',
  9: '\\t',
  10: '\\n',
  11: '\\v',
  12: '\\f',
  13: '\\r',
};
const PYTHON_NAMED: Readonly<Record<number, string>> = { 9: '\\t', 10: '\\n', 13: '\\r' };

const octal = (byte: number): string => `\\${byte.toString(8).padStart(3, '0')}`;
const unicode = (code: number): string =>
  code > 0xffff
    ? `\\U${code.toString(16).padStart(8, '0')}`
    : `\\u${code.toString(16).padStart(4, '0')}`;

/** One text character as escaped inside a C string/character literal. `quote`
 * is the delimiter that must be escaped. `after` is the next character: an
 * octal escape is only unambiguous before a non-octal-digit. */
function escapeC(character: string, quote: '"' | "'", previous: string, after: string): string {
  const code = character.codePointAt(0)!;
  if (character === '\\') return '\\\\';
  if (character === quote) return `\\${quote}`;
  if (code === 0) return /[0-7]/.test(after) ? '\\000' : '\\0';
  const named = C_NAMED[code];
  if (named) return named;
  // `??x` is a trigraph in older C; `*/` ends a comment the literal may sit in.
  if (character === '?' && previous === '?') return '\\?';
  if (character === '/' && previous === '*') return '\\057';
  if (code < 0x80 ? code < 0x20 || code === 0x7f : UNSAFE.test(character))
    return [...Buffer.from(character, 'utf8')].map(octal).join('');
  return character;
}

function escapePython(character: string, quote: '"' | "'", previous: string): string {
  const code = character.codePointAt(0)!;
  if (character === '\\') return '\\\\';
  if (character === quote) return `\\${quote}`;
  const named = PYTHON_NAMED[code];
  if (named) return named;
  if (character === '/' && previous === '*') return '\\u002f';
  if (code < 0x80 ? code < 0x20 || code === 0x7f : UNSAFE.test(character)) return unicode(code);
  return character;
}

export interface StringLiteral {
  /** Delimited literal text of the shown prefix. */
  readonly text: string;
  /** Bytes of the string (UTF-8, excluding the terminator) that are not shown. */
  readonly omitted_bytes: number;
}

/** Delimited string literal of `text` in the dialect's escape rules, showing
 * at most `limit` characters. Bytes are the UTF-8 bytes of the image string. */
export function stringLiteral(
  text: string,
  language: Language,
  limit = STRING_LITERAL_LIMIT,
): StringLiteral {
  const parts: string[] = ['"'];
  const characters = [...text];
  const shown = characters.length > limit ? characters.slice(0, limit) : characters;
  for (const [index, character] of shown.entries()) {
    const previous = shown[index - 1] ?? '',
      after = shown[index + 1] ?? '';
    parts.push(
      language === 'c-like'
        ? escapeC(character, '"', previous, after)
        : escapePython(character, '"', previous),
    );
  }
  parts.push('"');
  const omitted =
    shown.length === characters.length
      ? 0
      : Buffer.byteLength(characters.slice(limit).join(''), 'utf8');
  return { text: parts.join(''), omitted_bytes: omitted };
}

/** The character a value of this code prints as, or undefined when no
 * character spelling is sound: printable ASCII, plus the standard C escapes and
 * NUL when `escapes` (equality tests and call arguments; not arithmetic). */
export function characterLiteral(
  code: bigint,
  language: Language,
  escapes: boolean,
): string | undefined {
  if (code < 0n || code > 0x7fn) return undefined;
  const value = Number(code);
  const printable = value >= 0x20 && value <= 0x7e;
  if (!printable && !(escapes && (value === 0 || C_NAMED[value] !== undefined))) return undefined;
  const character = String.fromCharCode(value);
  const text =
    language === 'c-like'
      ? escapeC(character, "'", '', '')
      : value === 0
        ? '\\x00'
        : (PYTHON_NAMED[value] ?? escapePython(character, "'", ''));
  // Python has no character type: `ord` is the code of a one-character string.
  return language === 'c-like' ? `'${text}'` : `ord('${text}')`;
}

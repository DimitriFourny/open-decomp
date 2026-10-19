import type { ObjCMessage } from '../reconstruction/source-model.js';

type Language = 'c-like' | 'python-like';

/** String-literal body for exact image text: printable characters stay
 * readable, quotes/backslashes/controls/bidi/surrogate code points are escaped,
 * and a slash next to `*` uses an octal escape so the literal can never open
 * or close a comment. Valid in both C and Python string literals. */
export function literalText(text: string): string {
  let result = '';
  const characters = [...text];
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index]!,
      code = character.codePointAt(0)!;
    if (character === '\\' || character === '"') result += `\\${character}`;
    else if (character === '\n') result += '\\n';
    else if (character === '\r') result += '\\r';
    else if (character === '\t') result += '\\t';
    else if (
      code < 32 ||
      code === 0x7f ||
      (code >= 0x80 && code < 0xa0) ||
      (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      result +=
        code < 0x100
          ? `\\${code.toString(8).padStart(3, '0')}`
          : `\\u${code.toString(16).padStart(4, '0')}`;
    else if (character === '/' && (characters[index - 1] === '*' || characters[index + 1] === '*'))
      result += '\\057';
    else result += character;
  }
  return `"${result}"`;
}

/** Constant NSString object literal. */
export function objcStringLiteral(text: string, language: Language): string {
  return language === 'c-like' ? `@${literalText(text)}` : `NSString(${literalText(text)})`;
}

/** Message expression from already printed operands. `keywords` holds one
 * operand per selector colon; `extra` holds variadic actuals (and any explicit
 * remainder marker), printed after the last keyword as in Objective-C. */
export function objcMessageText(
  language: Language,
  message: ObjCMessage,
  receiver: string,
  keywords: readonly string[],
  extra: readonly string[],
): string {
  const inner = message.inner,
    tail = extra.length ? `, ${extra.join(', ')}` : '';
  if (language === 'python-like') {
    // PyObjC spelling: each selector colon becomes an underscore.
    const base = inner ? `${receiver}.${inner.replace(/:/g, '_')}()` : receiver;
    return `${base}.${message.selector.replace(/:/g, '_')}(${[...keywords, ...extra].join(', ')})`;
  }
  const base = inner ? `[${receiver} ${inner}]` : receiver;
  if (!keywords.length) return `[${base} ${message.selector}${tail}]`;
  const parts = message.selector.split(':');
  return `[${base} ${keywords.map((keyword, index) => `${parts[index]}:${keyword}`).join(' ')}${tail}]`;
}

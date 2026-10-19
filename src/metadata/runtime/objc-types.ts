import type { AbiType } from '../../core/index.js';

/** Source role of one Objective-C type-encoding element; `object`, `class` and
 * `selector` are pointer-width references (`id`, `Class`, `SEL`). */
export type ObjCTypeRole = 'object' | 'class' | 'selector' | 'pointer' | 'bool' | 'scalar' | 'void';
export interface ObjCEncodedType {
  readonly abi: AbiType;
  readonly role: ObjCTypeRole;
}
export interface ObjCMethodType {
  readonly returns: ObjCEncodedType;
  /** Includes the implicit `self` and `_cmd` formals. */
  readonly parameters: readonly ObjCEncodedType[];
}

const SCALARS: Record<string, AbiType> = {
  c: { kind: 'integer', bits: 8, signed: true },
  C: { kind: 'integer', bits: 8, signed: false },
  s: { kind: 'integer', bits: 16, signed: true },
  S: { kind: 'integer', bits: 16, signed: false },
  i: { kind: 'integer', bits: 32, signed: true },
  I: { kind: 'integer', bits: 32, signed: false },
  l: { kind: 'integer', bits: 32, signed: true },
  L: { kind: 'integer', bits: 32, signed: false },
  q: { kind: 'integer', bits: 64, signed: true },
  Q: { kind: 'integer', bits: 64, signed: false },
  f: { kind: 'float', bits: 32 },
  d: { kind: 'float', bits: 64 },
};
const QUALIFIERS = 'rnNoORVAj';
const OPEN: Record<string, string> = { '{': '}', '(': ')', '[': ']' };

/** Parse a compiler-emitted method type encoding (`@24@0:8q16`) into ABI
 * scalar/pointer types. Aggregates, unions, arrays, bit-fields, `long double`
 * and unknown elements return null rather than a guessed layout; the encoding
 * cannot express variadic methods, so callers decide arity separately. */
export function parseObjCMethodType(encoding: string): ObjCMethodType | null {
  let at = 0;
  const skipDigits = (): void => {
    while (at < encoding.length && /[0-9-]/.test(encoding[at]!)) at++;
  };
  /** Skip one complete element (used for pointees); false when malformed. */
  const skip = (): boolean => {
    while (at < encoding.length && QUALIFIERS.includes(encoding[at]!)) at++;
    const head = encoding[at++];
    if (head === undefined) return false;
    if (head === '^') return skip();
    if (head === '@') {
      if (encoding[at] === '?') at++;
      else if (encoding[at] === '"') {
        const close = encoding.indexOf('"', at + 1);
        if (close < 0) return false;
        at = close + 1;
      }
      return true;
    }
    if (head === 'b') {
      skipDigits();
      return true;
    }
    const close = OPEN[head];
    if (close === undefined) return true;
    for (let depth = 1; depth > 0;) {
      const next = encoding[at++];
      if (next === undefined) return false;
      if (next === '"') {
        const end = encoding.indexOf('"', at);
        if (end < 0) return false;
        at = end + 1;
      } else if (next === head) depth++;
      else if (next === close) depth--;
    }
    return true;
  };
  const element = (): ObjCEncodedType | null => {
    while (at < encoding.length && QUALIFIERS.includes(encoding[at]!)) at++;
    const head = encoding[at++];
    let result: ObjCEncodedType | null = null;
    if (head === undefined) return null;
    if (head === 'v') result = { abi: { kind: 'void' }, role: 'void' };
    else if (head === 'B')
      result = { abi: { kind: 'integer', bits: 8, signed: false }, role: 'bool' };
    else if (head === '@') {
      // `@?` is a block; `@"Name"` records the static class, still an object reference.
      at--;
      if (!skip()) return null;
      result = { abi: { kind: 'pointer' }, role: 'object' };
    } else if (head === '#') result = { abi: { kind: 'pointer' }, role: 'class' };
    else if (head === ':') result = { abi: { kind: 'pointer' }, role: 'selector' };
    else if (head === '*') result = { abi: { kind: 'pointer' }, role: 'pointer' };
    else if (head === '^') result = skip() ? { abi: { kind: 'pointer' }, role: 'pointer' } : null;
    else if (SCALARS[head]) result = { abi: SCALARS[head], role: 'scalar' };
    if (result) skipDigits();
    return result;
  };
  const returns = element();
  if (!returns) return null;
  const parameters: ObjCEncodedType[] = [];
  while (at < encoding.length) {
    const parameter = element();
    if (!parameter || parameter.role === 'void') return null;
    parameters.push(parameter);
  }
  if (
    parameters.length < 2 ||
    parameters[0]!.abi.kind !== 'pointer' ||
    parameters[1]!.role !== 'selector'
  )
    return null;
  return { returns, parameters };
}

/** Number of keyword arguments a selector names (its colon count). */
export function selectorArity(selector: string): number {
  let count = 0;
  for (const character of selector) if (character === ':') count++;
  return count;
}

/** Foundation/AppKit selectors declared with a trailing C variadic list. Only
 * these acquire an open variadic tail; every other selector is fixed-arity. */
export const variadicSelectors: Readonly<Record<string, true>> = {
  'stringWithFormat:': true,
  'initWithFormat:': true,
  'localizedStringWithFormat:': true,
  'appendFormat:': true,
  'stringByAppendingFormat:': true,
  'predicateWithFormat:': true,
  'arrayWithObjects:': true,
  'initWithObjects:': true,
  'setWithObjects:': true,
  'orderedSetWithObjects:': true,
  'dictionaryWithObjectsAndKeys:': true,
  'initWithObjectsAndKeys:': true,
  'raise:format:': true,
  'handleFailureInMethod:object:file:lineNumber:description:': true,
  'handleFailureInFunction:file:lineNumber:description:': true,
};

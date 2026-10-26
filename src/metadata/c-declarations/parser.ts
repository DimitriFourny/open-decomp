import {
  builtinDefinition,
  builtinTypedefs,
  emptyWords,
  resolveBaseWords,
  scalarBytes,
  type TypeWords,
} from './builtins.js';
import { lex, type Token } from './lexer.js';
import type {
  CDeclarationTarget,
  CDiagnostic,
  CParsedType,
  CParseResult,
  CStructureField,
  CTypeDefinition,
} from './types.js';

/** Parser-internal type expression; `named` nodes reference keys in the definition table. */
type Ty =
  | { k: 'named'; key: string; tag: boolean }
  | { k: 'ptr'; to: Ty }
  | { k: 'arr'; of: Ty; count: bigint | null }
  | { k: 'fn' };
type NamedTy = Extract<Ty, { k: 'named' }>;
type AggregateKind = 'struct' | 'union' | 'enum';

interface Attributes {
  packed: boolean;
  aligned: number | null;
}
interface Spec {
  base: Ty | null;
  typedef: boolean;
  /** Set while the specifier is a tag-less aggregate that still carries a placeholder key. */
  anon: { ty: NamedTy; kind: AggregateKind } | null;
  bound: boolean;
  attrs: Attributes;
}
interface Declared {
  name: Token | null;
  ty: Ty;
  attrs: Attributes;
}
type Member =
  | { kind: 'field'; name: Token; ty: Ty; attrs: Attributes }
  | { kind: 'anon'; ty: NamedTy; tok: Token };
interface Entry {
  name: string | null;
  def: CTypeDefinition;
}
interface Measure {
  size: bigint;
  align: number;
  flexible: boolean;
}

class ParseFailure {
  constructor(
    readonly message: string,
    readonly index: number,
  ) {}
}

const MAX_DEPTH = 128;
const U64_MAX = 0xffff_ffff_ffff_ffffn;
const SIZED = new Map([
  ['__int8', 8],
  ['__int16', 16],
  ['__int32', 32],
  ['__int64', 64],
]);
const QUALIFIERS = new Set([
  'const',
  '__const',
  '__const__',
  'volatile',
  '__volatile',
  '__volatile__',
  'restrict',
  '__restrict',
  '__restrict__',
  '_Atomic',
  'static',
  'extern',
  'register',
  'auto',
  'inline',
  '__inline',
  '__inline__',
  '__forceinline',
  '_Noreturn',
  '__extension__',
  '_Thread_local',
  '__thread',
  '__unaligned',
  '__w64',
]);
const CALLING_CONVENTIONS = new Set([
  '__cdecl',
  '__stdcall',
  '__fastcall',
  '__thiscall',
  '__vectorcall',
  '__clrcall',
]);
const ATTRIBUTE_WORDS = new Set([
  '__attribute__',
  '__attribute',
  '__declspec',
  '__asm__',
  '__asm',
  'asm',
  '_Alignas',
]);
const BASE_WORDS = new Set([
  'void',
  'char',
  'short',
  'int',
  'long',
  'signed',
  'unsigned',
  '__signed',
  '__signed__',
  'float',
  'double',
  '__int128',
  '__int8',
  '__int16',
  '__int32',
  '__int64',
]);
const AGGREGATES = new Set(['struct', 'union', 'enum']);
const BINARY_PRECEDENCE = new Map([
  ['||', 1],
  ['&&', 2],
  ['|', 3],
  ['^', 4],
  ['&', 5],
  ['==', 6],
  ['!=', 6],
  ['<', 7],
  ['>', 7],
  ['<=', 7],
  ['>=', 7],
  ['<<', 8],
  ['>>', 8],
  ['+', 9],
  ['-', 9],
  ['*', 10],
  ['/', 10],
  ['%', 10],
]);

function alignUp(value: bigint, align: number): bigint {
  const a = BigInt(align);
  return ((value + a - 1n) / a) * a;
}

function sameDefinition(a: CTypeDefinition, b: CTypeDefinition): boolean {
  return (
    JSON.stringify(a, (_key, value: unknown) =>
      typeof value === 'bigint' ? `${value}n` : value,
    ) ===
    JSON.stringify(b, (_key, value: unknown) => (typeof value === 'bigint' ? `${value}n` : value))
  );
}

function mapReferences(def: CTypeDefinition, remap: (key: string) => string): CTypeDefinition {
  switch (def.kind) {
    case 'pointer':
      return { ...def, to: remap(def.to) };
    case 'array':
    case 'vector':
      return { ...def, element: remap(def.element) };
    case 'structure':
      return {
        ...def,
        fields: def.fields.map((field) => ({ ...field, type_id: remap(field.type_id) })),
      };
    default:
      return def;
  }
}

function references(def: CTypeDefinition): string[] {
  switch (def.kind) {
    case 'pointer':
      return [def.to];
    case 'array':
    case 'vector':
      return [def.element];
    case 'structure':
      return def.fields.map((field) => field.type_id);
    default:
      return [];
  }
}

export class CParser {
  private readonly tokens: readonly Token[];
  private readonly diagnostics: CDiagnostic[];
  private readonly typedefNames: ReadonlyMap<string, string>;
  private readonly defs = new Map<string, Entry>();
  private readonly tags = new Map<string, { key: string; kind: AggregateKind }>();
  private readonly typedefs = new Map<string, Ty>();
  private readonly owners = new Map<string, string>();
  private readonly named = new Map<string, string>();
  private readonly constants = new Map<string, bigint>();
  private readonly defining = new Set<string>();
  private readonly completed = new Set<string>();
  private pos = 0;
  private depth = 0;
  private anonymous = 0;

  constructor(
    source: string,
    private readonly target: CDeclarationTarget,
  ) {
    const lexed = lex(source);
    this.tokens = lexed.tokens;
    this.diagnostics = [...lexed.diagnostics];
    this.typedefNames = builtinTypedefs(target);
  }

  parse(): CParseResult {
    while (this.tok().kind !== 'eof') {
      const start = this.pos;
      if (this.acceptPunct(';')) continue;
      try {
        this.parseTopLevelDeclaration();
      } catch (error) {
        if (!(error instanceof ParseFailure)) throw error;
        this.depth = 0;
        this.report(error);
        this.recover(start, error.index, false);
      }
      this.dropPlaceholders();
    }
    this.diagnostics.sort((a, b) => a.line - b.line || a.column - b.column);
    return { types: this.ordered(), named: this.named, diagnostics: this.diagnostics };
  }

  // ---- token helpers -------------------------------------------------------

  private tok(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)] as Token;
  }

  private next(): Token {
    const token = this.tok();
    if (token.kind !== 'eof') this.pos++;
    return token;
  }

  private isPunct(text: string, offset = 0): boolean {
    const token = this.tok(offset);
    return token.kind === 'punct' && token.text === text;
  }

  private isIdent(text: string, offset = 0): boolean {
    const token = this.tok(offset);
    return token.kind === 'ident' && token.text === text;
  }

  private acceptPunct(text: string): boolean {
    if (!this.isPunct(text)) return false;
    this.pos++;
    return true;
  }

  private expectPunct(text: string): Token {
    if (!this.isPunct(text)) this.fail(`expected '${text}', found ${this.describe(this.tok())}`);
    return this.next();
  }

  private describe(token: Token): string {
    return token.kind === 'eof' ? 'end of input' : `'${token.text}'`;
  }

  private fail(message: string, index = this.pos): never {
    throw new ParseFailure(message, Math.min(index, this.tokens.length - 1));
  }

  private failAt(token: Token, message: string): never {
    this.fail(message, this.tokens.indexOf(token));
  }

  private report(error: ParseFailure): void {
    const token = this.tokens[error.index] as Token;
    this.diagnostics.push({ message: error.message, line: token.line, column: token.column });
  }

  private error(token: Token, message: string): void {
    this.diagnostics.push({ message, line: token.line, column: token.column });
  }

  private enter(): void {
    if (++this.depth > MAX_DEPTH) this.fail('declaration nesting is too deep');
  }

  private skipBalanced(): void {
    const open = this.next().text;
    const close = open === '(' ? ')' : open === '[' ? ']' : '}';
    let depth = 1;
    while (depth > 0) {
      const token = this.tok();
      if (token.kind === 'eof') this.fail(`unterminated '${open}'`);
      this.pos++;
      if (token.kind !== 'punct') continue;
      if (token.text === open) depth++;
      else if (token.text === close) depth--;
    }
  }

  /** Skips to the end of the damaged declaration that began at `start`. */
  private recover(start: number, errorIndex: number, insideBraces: boolean): void {
    let depth = 0;
    for (let i = start; i < this.tokens.length - 1; i++) {
      const token = this.tokens[i] as Token;
      if (token.kind !== 'punct') continue;
      if (token.text === '{') depth++;
      else if (token.text === '}') {
        if (depth > 0) depth--;
        else if (i >= errorIndex) {
          this.pos = insideBraces ? i : i + 1;
          return;
        }
      } else if (token.text === ';' && depth === 0 && i >= errorIndex) {
        this.pos = i + 1;
        return;
      }
    }
    this.pos = this.tokens.length - 1;
  }

  // ---- type table ----------------------------------------------------------

  private placeholder(): string {
    return `<anon${this.anonymous++}>`;
  }

  private dropPlaceholders(): void {
    for (const key of [...this.defs.keys()]) if (key.startsWith('<')) this.defs.delete(key);
  }

  private definitionOf(key: string): CTypeDefinition | null {
    return this.defs.get(key)?.def ?? builtinDefinition(key);
  }

  private ensure(key: string): string {
    if (!this.defs.has(key)) {
      const def = builtinDefinition(key);
      if (def) this.defs.set(key, { name: null, def });
    }
    return key;
  }

  private claim(token: Token, key: string, description: string): void {
    const existing = this.owners.get(key) ?? (builtinDefinition(key) ? 'a builtin type' : null);
    if (existing !== null) this.failAt(token, `'${key}' is already declared as ${existing}`);
    this.owners.set(key, description);
  }

  private rename(from: string, to: string): void {
    const remap = (key: string): string =>
      key === from
        ? to
        : key.startsWith(from) && '$#.'.includes(key[from.length] as string)
          ? to + key.slice(from.length)
          : key;
    const entries = [...this.defs];
    this.defs.clear();
    for (const [key, entry] of entries)
      this.defs.set(remap(key), { name: entry.name, def: mapReferences(entry.def, remap) });
  }

  // ---- layout --------------------------------------------------------------

  private measure(ty: Ty, flexible = false): Measure | null {
    switch (ty.k) {
      case 'fn':
        return null;
      case 'ptr':
        return { size: 8n, align: 8, flexible: false };
      case 'arr': {
        const element = this.measure(ty.of);
        if (!element) return null;
        return this.arrayMeasure(element, ty.count, flexible);
      }
      case 'named': {
        const def = this.definitionOf(ty.key);
        return def ? this.measureDefinition(def, flexible) : null;
      }
    }
  }

  private arrayMeasure(element: Measure, count: bigint | null, flexible: boolean): Measure | null {
    if (count === null) return flexible ? { size: 0n, align: element.align, flexible: true } : null;
    const size = element.size * count;
    if (size > U64_MAX) this.fail('array is too large');
    return { size, align: element.align, flexible: false };
  }

  private measureDefinition(def: CTypeDefinition, flexible: boolean): Measure | null {
    const bytes = scalarBytes(def);
    if (bytes !== null) return { size: BigInt(bytes), align: bytes, flexible: false };
    switch (def.kind) {
      case 'array': {
        const element = this.measure({ k: 'named', key: def.element, tag: false });
        return element ? this.arrayMeasure(element, def.count, flexible) : null;
      }
      case 'structure':
        return def.size === null
          ? null
          : { size: def.size, align: def.alignment ?? 1, flexible: false };
      case 'unknown':
        return def.size === null ? null : { size: def.size, align: 1, flexible: false };
      default:
        return null;
    }
  }

  private mat(ty: Ty, path: string, depth = 0): string {
    switch (ty.k) {
      case 'named':
        return this.ensure(ty.key);
      case 'fn':
        return this.fail('a function type cannot be used here');
      case 'ptr': {
        const key = depth === 0 ? path : `${path}#${depth}`;
        const to = ty.to.k === 'fn' ? this.ensure('void') : this.mat(ty.to, path, depth + 1);
        this.defs.set(key, { name: null, def: { kind: 'pointer', to, bits: 64 } });
        return key;
      }
      case 'arr': {
        const key = depth === 0 ? path : `${path}#${depth}`;
        if (!this.measure(ty.of)) this.fail('array element has incomplete type');
        const element = this.mat(ty.of, path, depth + 1);
        this.defs.set(key, { name: null, def: { kind: 'array', element, count: ty.count } });
        return key;
      }
    }
  }

  private layout(
    kind: 'struct' | 'union',
    key: string,
    members: readonly Member[],
    pack: number | null,
    attrs: Attributes,
  ): CTypeDefinition {
    const limit = attrs.packed ? 1 : pack;
    const fields: CStructureField[] = [];
    const names = new Set<string>();
    let offset = 0n;
    let extent = 0n;
    let alignment = 1;
    const place = (size: bigint, natural: number, fieldAttrs: Attributes | null): bigint => {
      let align = limit === null ? natural : Math.min(natural, limit);
      if (fieldAttrs?.packed) align = 1;
      if (fieldAttrs?.aligned != null)
        align = fieldAttrs.packed ? fieldAttrs.aligned : Math.max(align, fieldAttrs.aligned);
      alignment = Math.max(alignment, align);
      const at = kind === 'union' ? 0n : alignUp(offset, align);
      offset = at + size;
      extent = offset > extent ? offset : extent;
      return at;
    };
    const add = (token: Token, name: string, at: bigint, typeKey: string): void => {
      if (names.has(name)) this.error(token, `duplicate member '${name}'`);
      names.add(name);
      fields.push({ id: name, name, offset: at, type_id: typeKey });
    };
    members.forEach((member, index) => {
      if (member.kind === 'anon') {
        const flatKey = `${key}$_${index}`;
        this.rename(member.ty.key, flatKey);
        const aggregate = this.defs.get(flatKey)?.def;
        this.defs.delete(flatKey);
        if (aggregate?.kind !== 'structure' || aggregate.size === null) return;
        const at = place(aggregate.size, aggregate.alignment ?? 1, null);
        for (const field of aggregate.fields)
          add(member.tok, field.name, at + field.offset, field.type_id);
        return;
      }
      const token = member.name;
      const name = token.text;
      if (member.ty.k === 'fn') return this.error(token, `member '${name}' has function type`);
      const measured = this.measure(member.ty, true);
      if (!measured) return this.error(token, `member '${name}' has incomplete type`);
      if (measured.flexible && index !== members.length - 1)
        this.error(token, `flexible array member '${name}' must be last`);
      const at = place(measured.size, measured.align, member.attrs);
      add(token, name, at, this.mat(member.ty, `${key}$${name}`));
    });
    if (attrs.aligned !== null) alignment = Math.max(alignment, attrs.aligned);
    return {
      kind: 'structure',
      size: alignUp(extent, alignment),
      alignment,
      fields,
    };
  }

  // ---- attributes and qualifiers -------------------------------------------

  /** Consumes qualifiers, calling conventions and attribute-like constructs. */
  private noise(): Attributes {
    const attrs: Attributes = { packed: false, aligned: null };
    for (;;) {
      const token = this.tok();
      if (token.kind !== 'ident') return attrs;
      if (QUALIFIERS.has(token.text) || CALLING_CONVENTIONS.has(token.text)) {
        this.pos++;
        continue;
      }
      if (!ATTRIBUTE_WORDS.has(token.text)) return attrs;
      this.pos++;
      this.attribute(token.text, attrs);
    }
  }

  private attribute(word: string, attrs: Attributes): void {
    if (word === 'asm' || word === '__asm' || word === '__asm__') {
      this.expectPunct('(');
      this.pos--;
      this.skipBalanced();
      return;
    }
    if (word === '_Alignas') {
      this.expectPunct('(');
      attrs.aligned = this.alignment(this.constant());
      this.expectPunct(')');
      return;
    }
    this.expectPunct('(');
    if (word === '__declspec') {
      while (!this.isPunct(')')) {
        const name = this.next();
        if (name.kind === 'eof') this.fail("unterminated '__declspec'");
        if (name.text === 'align' && this.acceptPunct('(')) {
          attrs.aligned = this.alignment(this.constant());
          this.expectPunct(')');
        } else if (this.isPunct('(')) this.skipBalanced();
      }
      this.expectPunct(')');
      return;
    }
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      const name = this.next();
      if (name.kind !== 'ident') this.fail(`unexpected ${this.describe(name)} in attribute`);
      const plain = name.text.replace(/^__|__$/g, '');
      if (plain === 'packed') attrs.packed = true;
      if (plain === 'aligned' || plain === 'align') {
        if (this.acceptPunct('(')) {
          attrs.aligned = this.alignment(this.constant());
          this.expectPunct(')');
        } else attrs.aligned = 16;
      } else if (this.isPunct('(')) this.skipBalanced();
      if (!this.acceptPunct(',')) break;
    }
    this.expectPunct(')');
    this.expectPunct(')');
  }

  private alignment(value: bigint): number {
    if (value < 1n || value > 65536n || (value & (value - 1n)) !== 0n)
      this.fail('alignment must be a power of two between 1 and 65536');
    return Number(value);
  }

  // ---- constant expressions ------------------------------------------------

  private constant(minPrecedence = 0): bigint {
    this.enter();
    try {
      let left = this.unary();
      for (;;) {
        const token = this.tok();
        if (token.kind !== 'punct') break;
        if (token.text === '?' && minPrecedence === 0) {
          this.pos++;
          const yes = this.constant();
          this.expectPunct(':');
          const no = this.constant();
          left = left !== 0n ? yes : no;
          continue;
        }
        const precedence = BINARY_PRECEDENCE.get(token.text);
        if (precedence === undefined || precedence <= minPrecedence) break;
        this.pos++;
        const right = this.constant(precedence);
        left = this.binary(token, left, right);
      }
      return left;
    } finally {
      this.depth--;
    }
  }

  private binary(op: Token, a: bigint, b: bigint): bigint {
    const wrap = (value: bigint): bigint => BigInt.asIntN(64, value);
    switch (op.text) {
      case '||':
        return a !== 0n || b !== 0n ? 1n : 0n;
      case '&&':
        return a !== 0n && b !== 0n ? 1n : 0n;
      case '|':
        return a | b;
      case '^':
        return a ^ b;
      case '&':
        return a & b;
      case '==':
        return a === b ? 1n : 0n;
      case '!=':
        return a !== b ? 1n : 0n;
      case '<':
        return a < b ? 1n : 0n;
      case '>':
        return a > b ? 1n : 0n;
      case '<=':
        return a <= b ? 1n : 0n;
      case '>=':
        return a >= b ? 1n : 0n;
      case '<<':
      case '>>':
        if (b < 0n || b > 63n) this.failAt(op, 'shift count out of range');
        return wrap(op.text === '<<' ? a << b : a >> b);
      case '+':
        return wrap(a + b);
      case '-':
        return wrap(a - b);
      case '*':
        return wrap(a * b);
      default:
        if (b === 0n) this.failAt(op, 'division by zero in constant expression');
        return op.text === '/' ? wrap(a / b) : a % b;
    }
  }

  private unary(): bigint {
    const token = this.next();
    if (token.kind === 'number') return this.integerLiteral(token);
    if (token.kind === 'char') return this.characterLiteral(token);
    if (token.kind === 'ident') {
      if (token.text === 'sizeof') return this.sizeofType();
      const value = this.constants.get(token.text);
      if (value === undefined)
        this.failAt(token, `'${token.text}' is not a known integer constant`);
      return value;
    }
    if (token.kind === 'punct') {
      switch (token.text) {
        case '-':
          return BigInt.asIntN(64, -this.unary());
        case '+':
          return this.unary();
        case '~':
          return BigInt.asIntN(64, ~this.unary());
        case '!':
          return this.unary() === 0n ? 1n : 0n;
        case '(': {
          const value = this.constant();
          this.expectPunct(')');
          return value;
        }
      }
    }
    return this.failAt(token, `expected a constant expression, found ${this.describe(token)}`);
  }

  private integerLiteral(token: Token): bigint {
    const match = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|0[0-7]*|[1-9][0-9]*)([uUlL]*)$/.exec(token.text);
    if (!match) return this.failAt(token, `'${token.text}' is not an integer constant`);
    const digits = match[1] as string;
    const value = BigInt(/^0[0-7]+$/.test(digits) ? `0o${digits.slice(1)}` : digits);
    if (value > U64_MAX) this.failAt(token, 'integer constant is too large');
    return BigInt.asIntN(64, value);
  }

  private characterLiteral(token: Token): bigint {
    const body = token.text.slice(1, -1);
    const escapes: Record<string, number> = {
      n: 10,
      t: 9,
      r: 13,
      '0': 0,
      a: 7,
      b: 8,
      f: 12,
      v: 11,
      '\\': 92,
      "'": 39,
      '"': 34,
    };
    if (body.length === 1) return BigInt(body.charCodeAt(0));
    if (body.length === 2 && body[0] === '\\' && escapes[body[1] as string] !== undefined)
      return BigInt(escapes[body[1] as string] as number);
    const hex = /^\\x([0-9a-fA-F]{1,2})$/.exec(body);
    if (hex) return BigInt(parseInt(hex[1] as string, 16));
    return this.failAt(token, `unsupported character constant ${token.text}`);
  }

  private sizeofType(): bigint {
    this.expectPunct('(');
    if (!this.startsType(this.tok())) this.fail('sizeof is supported only for type names');
    const spec = this.specifiers();
    if (!spec.base) this.fail('expected a type');
    const declared = this.declarator(spec.base, true, false);
    const measured = this.measure(declared.ty);
    if (!measured) this.fail('sizeof applied to an incomplete type');
    this.expectPunct(')');
    return measured.size;
  }

  // ---- specifiers ----------------------------------------------------------

  private startsType(token: Token): boolean {
    if (token.kind !== 'ident') return false;
    const text = token.text;
    return (
      BASE_WORDS.has(text) ||
      AGGREGATES.has(text) ||
      QUALIFIERS.has(text) ||
      text === 'typedef' ||
      this.typedefs.has(text) ||
      this.typedefNames.has(text)
    );
  }

  private typedefType(name: string): Ty | null {
    const user = this.typedefs.get(name);
    if (user) return user;
    const builtin = this.typedefNames.get(name);
    return builtin === undefined ? null : { k: 'named', key: builtin, tag: false };
  }

  private specifiers(): Spec {
    const spec: Spec = {
      base: null,
      typedef: false,
      anon: null,
      bound: false,
      attrs: { packed: false, aligned: null },
    };
    const words = emptyWords();
    let sawWord = false;
    for (;;) {
      const token = this.tok();
      if (token.kind !== 'ident') break;
      const text = token.text;
      if (QUALIFIERS.has(text) || CALLING_CONVENTIONS.has(text) || ATTRIBUTE_WORDS.has(text)) {
        const attrs = this.noise();
        spec.attrs.packed ||= attrs.packed;
        spec.attrs.aligned = attrs.aligned ?? spec.attrs.aligned;
        continue;
      }
      if (text === 'typedef') {
        spec.typedef = true;
        this.pos++;
        continue;
      }
      if (BASE_WORDS.has(text)) {
        if (spec.base) this.fail(`unexpected '${text}' after a type`);
        this.pos++;
        sawWord = true;
        this.addWord(words, text);
        continue;
      }
      if (AGGREGATES.has(text)) {
        if (spec.base || sawWord) this.fail(`unexpected '${text}' after a type`);
        const aggregate = this.aggregate();
        spec.base = aggregate.ty;
        if (aggregate.anon) spec.anon = { ty: aggregate.ty, kind: aggregate.kind };
        continue;
      }
      if (!spec.base && !sawWord) {
        const ty = this.typedefType(text);
        if (ty) {
          spec.base = ty;
          this.pos++;
          continue;
        }
      }
      break;
    }
    if (sawWord) {
      const key = resolveBaseWords(words, this.target);
      if (key === null) this.fail('invalid combination of type specifiers');
      spec.base = { k: 'named', key, tag: false };
    }
    return spec;
  }

  private addWord(words: TypeWords, text: string): void {
    switch (text) {
      case 'void':
      case 'char':
      case 'int':
      case 'float':
      case 'double':
      case 'short':
        if (words[text]) this.fail(`duplicate '${text}'`, this.pos - 1);
        words[text] = true;
        return;
      case 'long':
        words.long++;
        return;
      case 'signed':
      case '__signed':
      case '__signed__':
        words.signed = true;
        return;
      case 'unsigned':
        words.unsigned = true;
        return;
      case '__int128':
        words.int128 = true;
        return;
      default:
        words.sized = SIZED.get(text) ?? null;
    }
  }

  private aggregate(): { ty: NamedTy; anon: boolean; kind: AggregateKind } {
    const keyword = this.next();
    const kind = keyword.text as AggregateKind;
    const attrs = this.noise();
    const tagToken = this.tok().kind === 'ident' ? this.next() : null;
    if (tagToken) {
      const trailing = this.noise();
      attrs.packed ||= trailing.packed;
      attrs.aligned = trailing.aligned ?? attrs.aligned;
    }
    if (!this.isPunct('{')) {
      if (!tagToken) this.fail(`expected a tag or '{' after '${kind}'`);
      const existing = this.tags.get(tagToken.text);
      if (existing) {
        this.matchKind(tagToken, existing.kind, kind);
        return { ty: { k: 'named', key: existing.key, tag: true }, anon: false, kind };
      }
      return {
        ty: { k: 'named', key: this.declareTag(tagToken, kind), tag: true },
        anon: false,
        kind,
      };
    }
    let key: string;
    let result: string;
    if (tagToken) {
      const existing = this.tags.get(tagToken.text);
      if (existing) {
        this.matchKind(tagToken, existing.kind, kind);
        result = existing.key;
        const complete = this.defining.has(existing.key) || this.completed.has(existing.key);
        if (complete) this.error(tagToken, `redefinition of ${kind} '${tagToken.text}'`);
        key = complete ? this.placeholder() : existing.key;
      } else key = result = this.declareTag(tagToken, kind);
    } else key = result = this.placeholder();
    this.defining.add(key);
    try {
      if (kind === 'enum') this.enumBody(key, tagToken?.text ?? null);
      else this.structBody(kind, key, tagToken?.text ?? null, attrs);
    } finally {
      this.defining.delete(key);
    }
    return { ty: { k: 'named', key: result, tag: true }, anon: !tagToken, kind };
  }

  private matchKind(token: Token, existing: AggregateKind, wanted: AggregateKind): void {
    if (existing !== wanted)
      this.failAt(
        token,
        `'${token.text}' is ${existing === 'enum' ? 'an' : 'a'} ${existing}, not ${wanted === 'enum' ? 'an' : 'a'} ${wanted}`,
      );
  }

  private declareTag(token: Token, kind: AggregateKind): string {
    const key = token.text;
    this.claim(token, key, `${kind} ${key}`);
    this.tags.set(key, { key, kind });
    this.named.set(key, key);
    this.defs.set(key, {
      name: key,
      def:
        kind === 'enum'
          ? { kind: 'integer', bits: 32, signed: true }
          : { kind: 'structure', size: null, alignment: null, fields: [] },
    });
    return key;
  }

  private enumBody(key: string, name: string | null): void {
    this.expectPunct('{');
    let value = 0n;
    while (!this.isPunct('}')) {
      const token = this.next();
      if (token.kind !== 'ident')
        this.failAt(token, `expected an enumerator, found ${this.describe(token)}`);
      this.noise();
      if (this.acceptPunct('=')) value = this.constant();
      this.constants.set(token.text, value);
      value = BigInt.asIntN(64, value + 1n);
      if (!this.acceptPunct(',')) break;
    }
    this.expectPunct('}');
    this.noise();
    this.defs.set(key, { name, def: { kind: 'integer', bits: 32, signed: true } });
    this.completed.add(key);
  }

  private structBody(
    kind: 'struct' | 'union',
    key: string,
    name: string | null,
    attrs: Attributes,
  ): void {
    const open = this.expectPunct('{');
    const members: Member[] = [];
    while (!this.isPunct('}')) {
      if (this.tok().kind === 'eof') this.fail(`unterminated ${kind} body`);
      const start = this.pos;
      const depth = this.depth;
      if (this.acceptPunct(';')) continue;
      try {
        this.member(key, members);
      } catch (error) {
        if (!(error instanceof ParseFailure)) throw error;
        this.depth = depth;
        this.report(error);
        this.recover(start, error.index, true);
      }
    }
    this.expectPunct('}');
    const trailing = this.noise();
    attrs.packed ||= trailing.packed;
    attrs.aligned = trailing.aligned ?? attrs.aligned;
    this.defs.set(key, { name, def: this.layout(kind, key, members, open.pack, attrs) });
    this.completed.add(key);
  }

  private member(owner: string, members: Member[]): void {
    const start = this.tok();
    const spec = this.requireSpecifiers();
    if (spec.typedef) this.failAt(start, 'typedef is not allowed in a member declaration');
    if (this.isPunct(';')) {
      if (spec.anon && spec.anon.kind !== 'enum')
        members.push({ kind: 'anon', ty: spec.anon.ty, tok: start });
      else if (!(spec.base?.k === 'named' && spec.base.tag))
        this.failAt(start, 'declaration does not declare anything');
      this.pos++;
      return;
    }
    for (;;) {
      if (this.isPunct(':')) this.fail('bit-fields are not supported');
      const declared = this.declarator(spec.base as Ty, false, false);
      if (!declared.name) this.fail('expected a member name');
      if (this.isPunct(':')) this.fail('bit-fields are not supported');
      this.bindAnon(spec, declared, `${owner}$${declared.name.text}`, false);
      members.push({
        kind: 'field',
        name: declared.name,
        ty: declared.ty,
        attrs: {
          packed: spec.attrs.packed || declared.attrs.packed,
          aligned: declared.attrs.aligned ?? spec.attrs.aligned,
        },
      });
      if (!this.acceptPunct(',')) break;
    }
    this.expectPunct(';');
  }

  private requireSpecifiers(): Spec & { base: Ty } {
    const token = this.tok();
    const spec = this.specifiers();
    if (!spec.base)
      this.failAt(
        token,
        token.kind === 'ident' && !this.startsType(token)
          ? `unknown type name '${token.text}'`
          : `expected a type, found ${this.describe(token)}`,
      );
    return spec as Spec & { base: Ty };
  }

  /** Gives a tag-less aggregate the key implied by the first declarator that names it. */
  private bindAnon(spec: Spec, declared: Declared, path: string, typedef: boolean): void {
    if (!spec.anon || spec.bound) return;
    spec.bound = true;
    let depth = 0;
    let ty = declared.ty;
    while (ty.k === 'ptr' || ty.k === 'arr') {
      depth++;
      ty = ty.k === 'ptr' ? ty.to : ty.of;
    }
    if (ty.k === 'fn') return;
    const key = depth === 0 ? path : `${path}#${depth}`;
    const token = declared.name as Token;
    if (typedef && depth === 0) {
      this.claim(token, path, `typedef ${path}`);
      const entry = this.defs.get(spec.anon.ty.key);
      if (entry) entry.name = path;
      this.named.set(path, path);
    } else if (this.defs.has(key)) this.failAt(token, `'${key}' is already declared`);
    this.rename(spec.anon.ty.key, key);
    spec.anon.ty.key = key;
  }

  // ---- declarators ---------------------------------------------------------

  private declarator(base: Ty, abstract: boolean, lenient: boolean): Declared {
    this.enter();
    try {
      const attrs = this.noise();
      let ty = base;
      while (this.acceptPunct('*')) {
        ty = { k: 'ptr', to: ty };
        const more = this.noise();
        attrs.packed ||= more.packed;
      }
      if (this.isPunct('(') && this.nestedDeclarator()) {
        const open = this.pos;
        this.skipBalanced();
        const after = this.pos;
        ty = this.suffixes(ty, lenient, attrs);
        const resume = this.pos;
        this.pos = open + 1;
        const inner = this.declarator(ty, abstract, lenient);
        if (this.pos !== after - 1)
          this.fail(`unexpected ${this.describe(this.tok())} in declarator`);
        this.pos = resume;
        attrs.packed ||= inner.attrs.packed;
        attrs.aligned = inner.attrs.aligned ?? attrs.aligned;
        return { name: inner.name, ty: inner.ty, attrs };
      }
      const name =
        this.tok().kind === 'ident' && !this.startsReserved(this.tok()) ? this.next() : null;
      if (!name && !abstract) this.fail(`expected a name, found ${this.describe(this.tok())}`);
      ty = this.suffixes(ty, lenient, attrs);
      return { name, ty, attrs };
    } finally {
      this.depth--;
    }
  }

  private startsReserved(token: Token): boolean {
    return (
      BASE_WORDS.has(token.text) ||
      AGGREGATES.has(token.text) ||
      QUALIFIERS.has(token.text) ||
      CALLING_CONVENTIONS.has(token.text) ||
      ATTRIBUTE_WORDS.has(token.text) ||
      token.text === 'typedef'
    );
  }

  private nestedDeclarator(): boolean {
    const next = this.tok(1);
    if (next.kind === 'punct') return next.text === '*' || next.text === '(';
    if (next.kind !== 'ident') return false;
    if (CALLING_CONVENTIONS.has(next.text) || ATTRIBUTE_WORDS.has(next.text)) return true;
    return !this.startsType(next);
  }

  private suffixes(base: Ty, lenient: boolean, attrs: Attributes): Ty {
    const dims: (bigint | null)[] = [];
    let ty = base;
    for (;;) {
      if (this.isPunct('[')) {
        this.pos++;
        if (lenient) {
          this.pos--;
          this.skipBalanced();
          dims.push(null);
          continue;
        }
        while (this.tok().kind === 'ident' && QUALIFIERS.has(this.tok().text)) this.pos++;
        if (this.acceptPunct(']')) dims.push(null);
        else {
          const at = this.tok();
          const count = this.constant();
          if (count < 0n) this.failAt(at, 'array size is negative');
          this.expectPunct(']');
          dims.push(count);
        }
        continue;
      }
      if (this.isPunct('(')) {
        this.parameters();
        ty = { k: 'fn' };
      }
      break;
    }
    for (let i = dims.length - 1; i >= 0; i--) ty = { k: 'arr', of: ty, count: dims[i] ?? null };
    const trailing = this.noise();
    attrs.packed ||= trailing.packed;
    attrs.aligned = trailing.aligned ?? attrs.aligned;
    return ty;
  }

  private parameters(): void {
    this.expectPunct('(');
    if (this.acceptPunct(')')) return;
    if (this.isIdent('void') && this.isPunct(')', 1)) {
      this.pos += 2;
      return;
    }
    for (;;) {
      if (this.acceptPunct('...')) break;
      const spec = this.requireSpecifiers();
      if (spec.typedef) this.fail('typedef is not allowed in a parameter');
      this.declarator(spec.base, true, true);
      if (!this.acceptPunct(',')) break;
    }
    this.expectPunct(')');
  }

  // ---- top level -----------------------------------------------------------

  private parseTopLevelDeclaration(): void {
    const spec = this.requireSpecifiers();
    if (this.acceptPunct(';')) return;
    for (;;) {
      const declared = this.declarator(spec.base, false, false);
      if (spec.typedef) this.declareTypedef(spec, declared);
      else {
        if (this.isPunct('{')) return this.skipBalanced();
        if (this.acceptPunct('=')) this.skipInitializer();
      }
      if (!this.acceptPunct(',')) break;
    }
    this.expectPunct(';');
  }

  private skipInitializer(): void {
    for (;;) {
      const token = this.tok();
      if (token.kind === 'eof') return;
      if (token.kind === 'punct') {
        if (token.text === ',' || token.text === ';') return;
        if (token.text === '(' || token.text === '[' || token.text === '{') {
          this.skipBalanced();
          continue;
        }
      }
      this.pos++;
    }
  }

  private declareTypedef(spec: Spec, declared: Declared): void {
    const token = declared.name as Token;
    const name = token.text;
    this.bindAnon(spec, declared, name, true);
    const ty = declared.ty;
    if (ty.k === 'fn') {
      if (this.typedefs.has(name)) this.failAt(token, `redefinition of typedef '${name}'`);
      this.typedefs.set(name, ty);
      return;
    }
    if (ty.k === 'named' && ty.tag) {
      const existing = this.typedefs.get(name);
      if (existing) {
        if (existing.k === 'named' && existing.key === ty.key) return;
        this.failAt(token, `redefinition of typedef '${name}'`);
      }
      if (ty.key !== name) this.claim(token, name, `typedef ${name}`);
      this.typedefs.set(name, ty);
      this.named.set(name, ty.key);
      return;
    }
    const builtin = builtinDefinition(name);
    if (builtin && ty.k === 'named') {
      const target = this.definitionOf(ty.key);
      if (target && sameDefinition(builtin, target)) {
        this.typedefs.set(name, { k: 'named', key: name, tag: false });
        return;
      }
    }
    this.claim(token, name, `typedef ${name}`);
    if (ty.k === 'named') {
      const def = this.definitionOf(ty.key);
      if (!def) this.failAt(token, `unknown type '${ty.key}'`);
      this.defs.set(name, { name, def });
    } else {
      this.mat(ty, name);
      const entry = this.defs.get(name);
      if (entry) entry.name = name;
    }
    this.typedefs.set(name, { k: 'named', key: name, tag: false });
    this.named.set(name, name);
  }

  // ---- output --------------------------------------------------------------

  /** Declaration order, dependencies first; back edges (pointer cycles) are left in place. */
  private ordered(): CParsedType[] {
    const result: CParsedType[] = [];
    const state = new Map<string, 1 | 2>();
    for (const root of this.defs.keys()) {
      if (state.has(root)) continue;
      const stack: { key: string; deps: string[]; index: number }[] = [];
      const open = (key: string): void => {
        state.set(key, 1);
        const entry = this.defs.get(key) as Entry;
        stack.push({ key, deps: references(entry.def), index: 0 });
      };
      open(root);
      while (stack.length > 0) {
        const frame = stack[stack.length - 1] as (typeof stack)[number];
        const dep = frame.deps[frame.index++];
        if (dep !== undefined) {
          if (!state.has(dep) && this.defs.has(dep)) open(dep);
          continue;
        }
        stack.pop();
        state.set(frame.key, 2);
        const entry = this.defs.get(frame.key) as Entry;
        result.push({ key: frame.key, name: entry.name, definition: entry.def });
      }
    }
    return result;
  }
}

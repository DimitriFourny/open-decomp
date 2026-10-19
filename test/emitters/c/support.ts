import assert from 'node:assert/strict';
import { createOperationContext, DEFAULT_ANALYSIS_OPTIONS } from '../../../src/core/index.js';
import type { SSAForm } from '../../../src/ir/index.js';
import { structureControlFlow } from '../../../src/presentation/index.js';
import { emitC } from '../../../src/emitters/c/index.js';
import { emitPythonLike } from '../../../src/emitters/python-like/index.js';
import type { EmissionInput, EmissionResult } from '../../../src/emitters/model.js';

export function emit(
  input: SSAForm,
  extra: Omit<EmissionInput, 'function'> = {},
  language: 'c-like' | 'python-like' = 'c-like',
  view: 'source' | 'checked' = 'source',
): EmissionResult {
  const structured = structureControlFlow(input, createOperationContext());
  assert.ok(structured.value);
  return (language === 'python-like' ? emitPythonLike : emitC)(
    { function: structured.value, ...extra },
    { ...DEFAULT_ANALYSIS_OPTIONS, emitter: language, view },
    createOperationContext(),
  );
}

type Data = bigint | string | boolean | null | Data[] | { readonly [key: string]: Data };
/** Static C type of an emitted expression (LP64: int is 32 bits, pointers are
 * 64-bit addresses). `math` marks helper-defined mathematical integers (the
 * documented checked-view helpers and Python-like ints), never C arithmetic. */
type CType =
  | { readonly kind: 'int'; readonly bits: number; readonly signed: boolean; readonly bool?: true }
  | { readonly kind: 'float'; readonly bits: number }
  | { readonly kind: 'pointer'; readonly to: Pointee | null }
  | { readonly kind: 'math' };
type Pointee =
  Extract<CType, { kind: 'int' | 'float' }> | { readonly kind: 'struct'; readonly name: string };
interface StructLayout {
  readonly size: bigint;
  readonly fields: ReadonlyMap<
    string,
    { readonly offset: bigint; readonly type: CType; readonly array: boolean }
  >;
}
const MATH: CType = { kind: 'math' };
/** Decode the body of a C or Python-like string/character literal (octal and
 * \\u/\\U escapes included). */
export function unescapeLiteral(body: string): string {
  const bytes: number[] = [];
  const simple: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '\\': 92,
    '"': 34,
    "'": 39,
    '?': 63,
  };
  for (let index = 0; index < body.length;) {
    const character = body[index]!;
    if (character !== '\\') {
      const code = body.codePointAt(index)!;
      bytes.push(...Buffer.from(String.fromCodePoint(code)));
      index += code > 0xffff ? 2 : 1;
      continue;
    }
    const next = body[index + 1]!;
    const octal = /^[0-7]{1,3}/.exec(body.slice(index + 1));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      index += 1 + octal[0].length;
    } else if (next === 'u' || next === 'U') {
      const width = next === 'u' ? 4 : 8;
      bytes.push(
        ...Buffer.from(
          String.fromCodePoint(parseInt(body.slice(index + 2, index + 2 + width), 16)),
        ),
      );
      index += 2 + width;
    } else {
      assert.ok(next in simple, `Unsupported escape \\${next}`);
      bytes.push(simple[next]!);
      index += 2;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

const INT: Extract<CType, { kind: 'int' }> = { kind: 'int', bits: 32, signed: true };
const unsignedType = (bits: number): CType => ({ kind: 'int', bits, signed: false });
type Expr =
  | { kind: 'literal'; value: Data; ctype?: CType }
  | { kind: 'ref'; name: string }
  | { kind: 'call'; name: string; args: Expr[]; ctype?: CType }
  | { kind: 'cast'; type: CType; value: Expr }
  | { kind: 'invoke'; target: Expr; args: Expr[] }
  | { kind: 'list'; values: Expr[] }
  | { kind: 'binary'; op: string; left: Expr; right: Expr }
  | { kind: 'unary'; op: string; value: Expr }
  | { kind: 'select'; condition: Expr; yes: Expr; no: Expr };
type Op =
  | { kind: 'assign'; names: string[]; expression: Expr | null; tuple: boolean }
  | { kind: 'jump'; target: string | number }
  | { kind: 'test'; condition: Expr; target: number }
  | { kind: 'return'; expression: Expr }
  | { kind: 'effect'; expression: Expr };

/** C integer promotion: every rank below int (bool, 8/16-bit) becomes int. */
function promote(type: CType): CType {
  return type.kind === 'int' && type.bits < 32
    ? INT
    : type.kind === 'pointer'
      ? unsignedType(64)
      : type;
}
/** C usual arithmetic conversions for two promoted integer operands. */
function usualArithmetic(left: CType, right: CType): CType {
  const a = promote(left),
    b = promote(right);
  if (a.kind === 'float' || b.kind === 'float')
    return {
      kind: 'float',
      bits: Math.max(a.kind === 'float' ? a.bits : 0, b.kind === 'float' ? b.bits : 0),
    };
  if (a.kind !== 'int' || b.kind !== 'int') return MATH;
  if (a.signed === b.signed) return a.bits >= b.bits ? a : b;
  const unsigned = a.signed ? b : a,
    signed = a.signed ? a : b;
  return unsigned.bits >= signed.bits ? unsigned : signed;
}
/** Conversion as by assignment/cast: modular for every integer type (signed is
 * implementation-defined; every supported compiler wraps), _Bool tests != 0. */
function convert(value: bigint, type: CType): bigint {
  if (type.kind === 'pointer') return BigInt.asUintN(64, value);
  if (type.kind !== 'int') return value;
  if (type.bool) return value === 0n ? 0n : 1n;
  return type.signed ? BigInt.asIntN(type.bits, value) : BigInt.asUintN(type.bits, value);
}
class UndefinedBehavior extends Error {}
/** Result types of documented helpers: fixed-width bit patterns are unsigned;
 * mathematical helpers (signed_value, source calls) stay `math`. */
function helperType(call: Extract<Expr, { kind: 'call' }>): CType {
  const first = call.args[0],
    literal = first?.kind === 'literal' ? first.value : undefined;
  const named = (value: Data | undefined): CType => {
    if (typeof value === 'string' && /^ieee(?:32|64)_t$/.test(value))
      return { kind: 'float', bits: Number(value.slice(4, -2)) };
    const match = typeof value === 'string' ? /^(?:bits|ieee|uint)(\d+)_t$/.exec(value) : null;
    return value === 'bool'
      ? { kind: 'int', bits: 1, signed: false, bool: true }
      : match
        ? unsignedType(Number(match[1]))
        : MATH;
  };
  const bitcastFloat = /^__od_bitcast_f(32|64)_u(?:32|64)$/.exec(call.name);
  if (bitcastFloat) return { kind: 'float', bits: Number(bitcastFloat[1]) };
  if (call.name === 'float') return { kind: 'float', bits: 64 };
  if (call.name === 'abs') return { kind: 'float', bits: 64 };
  const unary = /^__builtin_(?:fabs|sqrt)(f?)$/.exec(call.name);
  if (unary) return { kind: 'float', bits: unary[1] ? 32 : 64 };
  if (/^fp_(?:add|sub|mul|div|neg|abs|sqrt)$/.test(call.name) && typeof literal === 'bigint')
    return { kind: 'float', bits: Number(literal) };
  if (/^(?:fp_(?:eq|ne|lt|le|gt|ge|ordered|unordered)|flag_|isunordered$)/.test(call.name))
    return INT;
  if (/^(?:bv_|fp_|wrap$|extract_bits$|insert_bits$|concat_low_first$)/.test(call.name))
    return typeof literal === 'bigint' ? unsignedType(Number(literal)) : MATH;
  const view = call.args[1];
  if (call.name === 'read_memory') return named(view?.kind === 'literal' ? view.value : undefined);
  const bigEndian = /^memory_be(\d+)$/.exec(call.name);
  if (bigEndian) return unsignedType(Number(bigEndian[1]));
  if (/^(?:bit_pattern$|cast_|vector_lane$|unknown_value$|undefined_value$)/.test(call.name))
    return named(literal);
  if (
    /^(?:image_address|data_address|address_of|stack_slot|field_view|source_target|function_pointer)$/.test(
      call.name,
    )
  )
    return unsignedType(64);
  return MATH;
}

interface EmittedText {
  readonly text: string;
  readonly ids: readonly string[];
  readonly mappings: readonly {
    readonly start: number;
    readonly end: number;
    readonly semantic_refs: readonly number[];
  }[];
  /** Source-view presentation records. `unaligned_access_permitted` documents,
   * once per function, that plain scalar dereferences carry no alignment fault. */
  readonly local_validation?:
    readonly { readonly kind: string; readonly rule?: string | undefined }[] | undefined;
}
export interface EmittedFormal {
  readonly name: string;
  readonly statement_id: string;
  readonly semantic_ids: readonly string[];
}

export type RequirementAcknowledgments = readonly {
  readonly requirement_id: string;
  readonly site_id: string;
  readonly state_epoch: string;
}[];

/** A trusted source oracle may explicitly assert supported FP state at each
 * actual guard epoch. Merely executing emitted output never calls this helper. */
export function acknowledgeRequirements(
  emission: {
    readonly requirements?:
      | readonly {
          readonly id: string;
          readonly kind: string;
          readonly sites: readonly {
            readonly id: string;
            readonly state_epoch: string;
            readonly predicate_value_id?: string | undefined;
          }[];
        }[]
      | undefined;
  },
  siteIds?: ReadonlySet<string>,
): RequirementAcknowledgments {
  return (emission.requirements ?? [])
    .filter((requirement) => requirement.kind === 'fp_environment')
    .flatMap((requirement) =>
      requirement.sites
        .filter(
          (site) => site.predicate_value_id !== undefined && (!siteIds || siteIds.has(site.id)),
        )
        .map((site) => ({
          requirement_id: requirement.id,
          site_id: site.id,
          state_epoch: site.state_epoch,
        })),
    );
}

/** Direct integer-to-IEEE oracle: round the exact discarded remainder once.
 * No intermediate Number, production evaluator, or target implementation is used. */
function integerFloatBits(value: bigint, width: number): bigint {
  assert.ok(width === 32 || width === 64);
  if (value === 0n) return 0n;
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const precision = width === 32 ? 24 : 53;
  const bias = width === 32 ? 127 : 1023;
  let exponent = magnitude.toString(2).length - 1;
  const discard = Math.max(0, exponent + 1 - precision);
  const scale = 1n << BigInt(discard);
  let significand = magnitude / scale;
  const remainder = magnitude % scale;
  if (remainder * 2n > scale || (remainder * 2n === scale && (significand & 1n) !== 0n))
    significand++;
  if (significand === 1n << BigInt(precision)) {
    significand >>= 1n;
    exponent++;
  }
  if (exponent < precision - 1) significand <<= BigInt(precision - 1 - exponent);
  const fractionBits = BigInt(precision - 1);
  const fraction = significand & ((1n << fractionBits) - 1n);
  const sign = negative ? 1n << BigInt(width - 1) : 0n;
  const maximumExponent = bias * 2 + 1;
  if (exponent + bias >= maximumExponent) return sign | (BigInt(maximumExponent) << fractionBits);
  return sign | (BigInt(exponent + bias) << fractionBits) | fraction;
}

/** Small test-only parser for the emitted machine-expression/control grammar.
 * It consumes the OUTPUT, not IR or mappings, and never evals target text. Helper
 * semantics below are independent arithmetic/byte-array observations, not imports
 * from the production IR interpreter. Separate C and indentation-sensitive Python
 * statement parsers share only this expression grammar and independent oracle. */
class Parser {
  readonly tokens: string[] = [];
  readonly ops: Op[] = [];
  readonly labels = new Map<string, number>();
  readonly headerEnd: number;
  readonly python: boolean;
  /** C declarations in scope: formals, body locals and partial struct layouts. */
  readonly symbols = new Map<string, CType>();
  readonly structs = new Map<string, StructLayout>();
  /** Typedef-declared structure names whose bodies may follow. */
  private readonly structNames = new Set<string>();
  private readonly tables = new Map<string, { readonly address: bigint; readonly bits: number }>();
  /** Declared scalar globals (`extern T name;`): the name is the object, not a pointer. */
  private readonly scalars = new Set<string>();
  returnType: CType = MATH;
  /** A `void` function: control falling off its end returns (C11 6.9.1p12). */
  readonly voidResult: boolean;
  private readonly types = new WeakMap<Expr, CType>();
  private position = 0;
  private switchId = 0;
  /** Parsing bit_pattern arguments, whose hex payload is exact storage bits. */
  private payload = false;
  /** `continues` (do-while only) are patched to the loop test after its body. */
  private readonly loops: { start: number; breaks: number[]; continues?: number[] }[] = [];
  constructor(text: string) {
    this.python = /^def /m.test(text);
    this.voidResult = /^void [A-Za-z_]\w*\(/m.test(text) || /^def .*-> void:/m.test(text);
    const declarations = this.python
      ? /^(\w+) = memory_view\((0x[\da-f]+), "uint(\d+)_t", (?:True|False)\)(?:  # .*)?$/gm
      : /(?:\/\* (\w+): image VA (0x[\da-f]+); byte extent (?:unknown|\d+) \*\/\nextern (?:const )?uint(\d+)_t \1(?:\[\])?;|extern (?:const )?uint(\d+)_t (\w+)(?:\[\])?; \/\* VA (0x[\da-f]+)(?:, \d+ bytes)?(?:, [a-z ]+)? \*\/)/g;
    for (const match of text.matchAll(declarations)) {
      const name = (match[1] ?? match[5])!,
        address = BigInt((match[2] ?? match[6])!),
        bits = Number((match[3] ?? match[4])!);
      this.tables.set(name, { address, bits });
      if (!this.python && !match[0].includes('[];')) this.scalars.add(name);
      this.symbols.set(name, { kind: 'pointer', to: { kind: 'int', bits, signed: false } });
      this.ops.push({
        kind: 'assign',
        names: [name],
        tuple: false,
        expression: { kind: 'literal', value: address, ctype: unsignedType(64) },
      });
    }
    if (this.python) {
      const lines = text.split('\n'),
        header = lines.findIndex((line) => line.startsWith('def '));
      // The header line may end with a trailing `# ...` requirement note.
      const endHeader = lines.findIndex(
        (line, index) => index >= header && /(?:\):|\) -> [^#]*:)(?:\s+#.*)?$/.test(line),
      );
      assert.ok(endHeader >= header);
      this.headerEnd = lines
        .slice(0, endHeader + 1)
        .reduce((length, line) => length + line.length + 1, 0);
      for (const match of lines
        .slice(header, endHeader + 1)
        .join(' ')
        .matchAll(/(\w+): (float|double)\b/g))
        this.symbols.set(match[1]!, { kind: 'float', bits: match[2] === 'float' ? 32 : 64 });
      const result = /-> (float|double):(?:\s+#.*)?$/.exec(lines[endHeader]!);
      if (result) this.returnType = { kind: 'float', bits: result[1] === 'float' ? 32 : 64 };
      const indents = [0];
      const token =
        /[ \t]+|#[^\n]*|ord\('(?:\\u[0-9a-f]{4}|\\[0-7]{1,3}|\\.|[^'\\])'\)|"(?:\\.|[^"\\])*"|0x[0-9a-fA-F]+|[0-9]+\.[0-9]*(?:[eE][+-]?[0-9]+)?|[0-9]+[eE][+-]?[0-9]+|[0-9]+|[A-Za-z_][A-Za-z_0-9]*|\.\.\.|==|!=|<=|>=|<<|>>|[.()[\],:=?<>+*/%&|^~!-]/gy;
      for (const line of lines.slice(endHeader + 1)) {
        if (/^\s*(?:#|$)/.test(line)) continue;
        const indent = line.length - line.trimStart().length;
        assert.ok(indent > 0, 'Unexpected top-level Python pseudocode');
        if (indent > indents.at(-1)!) {
          indents.push(indent);
          this.tokens.push('INDENT');
        } else
          while (indent < indents.at(-1)!) {
            indents.pop();
            this.tokens.push('DEDENT');
          }
        assert.equal(indent, indents.at(-1));
        let offset = indent;
        while (offset < line.length) {
          token.lastIndex = offset;
          const match = token.exec(line);
          assert.ok(match, `Unrecognized Python pseudocode near ${line.slice(offset)}`);
          offset = token.lastIndex;
          if (!/^\s|^#/.test(match[0])) this.tokens.push(match[0]);
        }
        this.tokens.push('\n');
      }
      while (indents.length > 1) {
        indents.pop();
        this.tokens.push('DEDENT');
      }
      this.pythonBlock();
      assert.equal(this.position, this.tokens.length);
      return;
    }
    const token =
      /\s+|#[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\(?:[0-7]{1,3}|.)|[^'\\])'|"(?:\\.|[^"\\])*"|0x[0-9a-fA-F]+|[0-9]+\.[0-9]*(?:[eE][+-]?[0-9]+)?f?|[0-9]+[eE][+-]?[0-9]+f?|[0-9]+|[A-Za-z_][A-Za-z_0-9]*|\.\.\.|->|==|!=|<=|>=|<<|>>|&&|\|\||[{}()[\],.;:=?<>@+*/%&|^~!-]/gy;
    let offset = 0;
    const offsets: number[] = [];
    while (offset < text.length) {
      token.lastIndex = offset;
      const match = token.exec(text);
      assert.ok(match, `Unrecognized emitted token near ${text.slice(offset, offset + 80)}`);
      offset = token.lastIndex;
      if (!/^\s|^\/\*|^#/.test(match[0])) {
        offsets.push(match.index);
        this.tokens.push(match[0]);
      }
    }
    // Partial struct declarations precede the function; the body opens at the
    // first brace after them.
    while (['typedef', 'struct', 'extern', 'static'].includes(this.peek())) {
      if (this.peek() === 'static') {
        // Real helper bodies are independently compiled/executed in the C
        // support tests; this interpreter uses its existing bit-vector oracle.
        this.take('static');
        this.take('inline');
        while (this.take() !== '{') assert.ok(this.position < this.tokens.length);
        let depth = 1;
        while (depth) {
          const token = this.take();
          if (token === '{') depth++;
          if (token === '}') depth--;
          assert.ok(this.position <= this.tokens.length);
        }
      } else if (this.peek() !== 'extern') this.structDeclaration();
      else {
        this.take('extern');
        if (this.peek() === 'const') this.take('const');
        assert.ok(this.bodyType(false));
        const name = this.take();
        if (this.peek() === '(') {
          while (this.take() !== ';') assert.ok(this.position < this.tokens.length);
          continue;
        }
        assert.ok(this.tables.has(name), 'External table needs an exact image VA binding');
        if (this.peek() === '[') {
          this.take('[');
          this.take(']');
        }
        this.take(';');
      }
    }
    const start = this.tokens.indexOf('{', this.position);
    assert.ok(start >= 0);
    this.headerEnd = offsets[start]!;
    this.header(start);
    this.position = start;
    this.block([]);
  }

  /** `[typedef] struct NAME { T field; uint8_t gap[N]; ... } [NAME];` laid out
   * by C rules (each scalar at its natural alignment). */
  private structDeclaration(): void {
    if (this.peek() === 'typedef') this.take('typedef');
    if (this.peek() !== 'struct') {
      assert.ok(this.bodyType(false), 'Unsupported array element type');
      this.take(); // Alias; array pointers retain raw target addresses.
      this.take('[');
      if (this.peek() !== ']') assert.match(this.take(), /^\d+$/);
      this.take(']');
      this.take(';');
      return;
    }
    this.take('struct');
    const name = this.take(),
      fields = new Map<string, { offset: bigint; type: CType; array: boolean }>();
    if (this.peek() === name) {
      this.take(name);
      this.take(';');
      this.structNames.add(name);
      return;
    }
    let offset = 0n,
      alignment = 1n;
    this.take('{');
    const end = this.tokens.indexOf('}', this.position);
    const packed = this.tokens[end + 1] === '__attribute__';
    while (this.peek() !== '}') {
      const type = this.bodyType(false);
      assert.ok(type, 'Unsupported struct member type');
      const field = this.cType(type);
      assert.ok(
        field.kind === 'pointer' || (field.kind === 'int' && !field.bool),
        'Struct members are fixed-width integers or target pointers',
      );
      const size = field.kind === 'pointer' ? 8n : BigInt(field.bits / 8),
        member = this.take();
      let count = 1n;
      const array = this.peek() === '[';
      if (this.peek() === '[') {
        this.take('[');
        count = this.peek() === ']' ? 0n : BigInt(this.take());
        this.take(']');
      }
      if (!packed) {
        offset = ((offset + size - 1n) / size) * size;
        if (size > alignment) alignment = size;
      }
      fields.set(member, { offset, type: field, array });
      offset += size * count;
      this.take(';');
    }
    this.take('}');
    if (packed)
      for (const token of ['__attribute__', '(', '(', 'packed', ')', ')']) this.take(token);
    if (this.peek() === name) this.take(name);
    this.take(';');
    this.structs.set(name, { size: ((offset + alignment - 1n) / alignment) * alignment, fields });
  }

  /** Return and formal types of `R name(T a, U b) {`; unknown spellings stay mathematical. */
  private header(end: number): void {
    const open = this.tokens.indexOf('(', this.position);
    if (open < 0 || open > end) return;
    const result = this.bodyType(false);
    if (result && this.position === open - 1) this.returnType = this.cType(result);
    this.position = open + 1;
    while (this.position < end && this.peek() !== ')') {
      const type = this.bodyType(false);
      if (!type || this.peek() === ')' || this.peek() === ',') return;
      this.symbols.set(this.take(), this.cType(type));
      if (this.peek() === ',') this.take(',');
    }
  }

  private cType(type: { readonly scalar: string; readonly pointers: number }): CType {
    const name = type.scalar,
      integer = /^(u?)int(\d+)_t$/.exec(name),
      bits = /^bits(\d+)_t$/.exec(name);
    const floating = /^(?:float|double|ieee(?:32|64)_t)$/.test(name)
      ? ({ kind: 'float', bits: name === 'float' || name === 'ieee32_t' ? 32 : 64 } as const)
      : null;
    if (type.pointers === 0 && floating) return floating;
    const scalar: CType =
      name === 'bool'
        ? { kind: 'int', bits: 1, signed: false, bool: true }
        : name === 'char'
          ? { kind: 'int', bits: 8, signed: true }
          : name === 'uintptr_t'
            ? unsignedType(64)
            : integer
              ? { kind: 'int', bits: Number(integer[2]), signed: !integer[1] }
              : bits
                ? unsignedType(Number(bits[1]))
                : MATH;
    if (type.pointers === 0) return scalar;
    if (type.pointers > 1) return { kind: 'pointer', to: null };
    if (scalar.kind === 'int') return { kind: 'pointer', to: scalar };
    if (floating) return { kind: 'pointer', to: floating };
    return {
      kind: 'pointer',
      // A member may point to a structure whose body is declared later.
      to: this.structs.has(name) || this.structNames.has(name) ? { kind: 'struct', name } : null,
    };
  }

  private peek(): string {
    return this.tokens[this.position] ?? '';
  }

  private take(expected?: string): string {
    const token = this.tokens[this.position++];
    assert.ok(token, 'Unexpected end of emitted code');
    if (expected !== undefined) assert.equal(token, expected);
    return token;
  }

  private block(breaks: number[]): void {
    this.take('{');
    while (this.peek() !== '}') this.statement(breaks);
    this.take('}');
  }

  private pythonBlock(): void {
    this.take('INDENT');
    while (this.peek() !== 'DEDENT') this.pythonStatement();
    this.take('DEDENT');
  }

  /** Source type syntax carries no host allocation or pointee bounds. Only
   * machine-width casts below give values numeric interpretation. */
  private bodyType(python: boolean, depth = 0): { scalar: string; pointers: number } | null {
    assert.ok(depth < 64, 'Source type annotation nesting limit');
    const start = this.position;
    if (this.peek() === 'const') this.take('const');
    const token = this.take();
    const scalar =
      /^(?:bits\d+_t|u?int\d+_t|uintptr_t|bool|char|void|float|double|ieee\d+_t|vector_[if]\d+x\d+_t|effect_t|type_\d+)$/;
    let pointers = 0;
    if (python && token === 'pointer' && this.peek() === '[') {
      this.take('[');
      assert.ok(this.bodyType(python, depth + 1));
      this.take(']');
      pointers = 1;
    } else if ((token === 'array' || token === 'vector') && this.peek() === '<') {
      this.take('<');
      assert.ok(this.bodyType(python, depth + 1));
      this.take(',');
      assert.match(this.take(), /^(?:\d+|\?)$/);
      this.take('>');
    } else if (
      !scalar.test(token) &&
      !((depth > 0 || this.peek() === '*') && /^[A-Za-z_]\w*$/.test(token))
    ) {
      this.position = start;
      return null;
    }
    if (!python)
      while (this.peek() === '*') {
        this.take('*');
        pointers++;
      }
    return { scalar: token, pointers };
  }

  private pythonStatement(): void {
    const token = this.take();
    if (token === 'memory' && this.peek() === '.') {
      this.position--;
      this.memoryStatement('\n');
      return;
    }
    if (token === 'label') {
      this.labels.set(this.take(), this.ops.length);
      this.take(':');
      this.take('\n');
      return;
    }
    if (token === 'pass') {
      this.take('\n');
      return;
    }
    if (token === 'break' || token === 'continue') {
      const loop = this.loops.at(-1);
      assert.ok(loop);
      if (token === 'break') loop.breaks.push(this.ops.length);
      this.ops.push({ kind: 'jump', target: token === 'continue' ? loop.start : -1 });
      this.take('\n');
      return;
    }
    if (token === 'goto') {
      this.ops.push({ kind: 'jump', target: this.take() });
      this.take('\n');
      return;
    }
    if (token === 'return') {
      this.ops.push({
        kind: 'return',
        expression: this.peek() === '\n' ? { kind: 'list', values: [] } : this.expression(),
      });
      this.take('\n');
      return;
    }
    if (token === 'if') {
      const condition = this.expression();
      this.take(':');
      this.take('\n');
      const test: Op & { kind: 'test' } = { kind: 'test', condition, target: -1 };
      this.ops.push(test);
      this.pythonBlock();
      const end: Op & { kind: 'jump' } = { kind: 'jump', target: -1 };
      this.ops.push(end);
      test.target = this.ops.length;
      if (this.peek() === 'else') {
        this.take('else');
        this.take(':');
        this.take('\n');
        this.pythonBlock();
      }
      end.target = this.ops.length;
      return;
    }
    if (token === 'while') {
      const start = this.ops.length,
        condition = this.expression();
      this.take(':');
      this.take('\n');
      const test: Op & { kind: 'test' } = { kind: 'test', condition, target: -1 };
      this.ops.push(test);
      const loop = { start, breaks: [] as number[] };
      this.loops.push(loop);
      this.pythonBlock();
      this.loops.pop();
      this.ops.push({ kind: 'jump', target: start });
      test.target = this.ops.length;
      for (const index of loop.breaks) {
        const op = this.ops[index]!;
        if (op.kind === 'jump') op.target = this.ops.length;
      }
      return;
    }
    if (token === 'match') {
      const expression = this.expression(),
        name = `$match${this.switchId++}`;
      this.take(':');
      this.take('\n');
      this.take('INDENT');
      this.ops.push({ kind: 'assign', names: [name], expression, tuple: false });
      // An unknown selector must never select the default, including zero cases.
      this.ops.push({
        kind: 'test',
        condition: {
          kind: 'binary',
          op: '==',
          left: { kind: 'ref', name },
          right: { kind: 'ref', name },
        },
        target: this.ops.length + 1,
      });
      const dispatch: Op & { kind: 'jump' } = { kind: 'jump', target: -1 };
      this.ops.push(dispatch);
      const cases: { value: Expr; start: number }[] = [],
        ends: (Op & { kind: 'jump' })[] = [];
      let otherwise = -1;
      while (this.peek() !== 'DEDENT') {
        this.take('case');
        if (this.peek() === '_') {
          this.take('_');
          otherwise = this.ops.length;
        } else {
          // `case a | b:` is a literal alternative pattern, not a bitwise or.
          const start = this.ops.length;
          const alternatives = (value: Expr): void => {
            if (value.kind === 'binary' && value.op === '|') {
              alternatives(value.left);
              alternatives(value.right);
            } else cases.push({ value, start });
          };
          alternatives(this.expression());
        }
        this.take(':');
        this.take('\n');
        this.pythonBlock();
        const end: Op & { kind: 'jump' } = { kind: 'jump', target: -1 };
        ends.push(end);
        this.ops.push(end);
      }
      this.take('DEDENT');
      dispatch.target = this.ops.length;
      for (const item of cases) {
        this.ops.push({
          kind: 'test',
          condition: { kind: 'binary', op: '==', left: { kind: 'ref', name }, right: item.value },
          target: this.ops.length + 2,
        });
        this.ops.push({ kind: 'jump', target: item.start });
      }
      // Without a wildcard, an unmatched value leaves the match.
      this.ops.push({ kind: 'jump', target: otherwise >= 0 ? otherwise : this.ops.length + 1 });
      for (const end of ends) end.target = this.ops.length;
      return;
    }
    if (this.peek() === '(') {
      this.position--;
      this.ops.push({ kind: 'effect', expression: this.expression() });
      this.take('\n');
      return;
    }
    const tuple = token === '(',
      names = tuple ? [] : [token];
    if (tuple) {
      while (this.peek() !== ')') {
        names.push(this.take());
        if (this.peek() !== ')') this.take(',');
      }
      this.take(')');
    }
    if (this.peek() === ':') {
      this.take(':');
      const type = this.bodyType(true);
      assert.ok(type, 'Unsupported source local annotation');
      this.symbols.set(names[0]!, this.cType(type));
    }
    const expression = this.peek() === '=' ? (this.take('='), this.expression()) : null;
    this.take('\n');
    this.ops.push({ kind: 'assign', names, expression, tuple });
  }

  private statement(breaks: number[]): void {
    const token = this.take();
    if (token === '_Alignas') {
      this.take('(');
      const alignment = this.expression();
      this.take(')');
      this.take('uint8_t');
      const name = this.take();
      this.take('[');
      const size = this.expression();
      this.take(']');
      this.take(';');
      this.ops.push({
        kind: 'assign',
        names: [name],
        tuple: false,
        expression: { kind: 'call', name: 'stack_storage', args: [size, alignment] },
      });
      return;
    }
    if (
      (token === '(' && this.peek() === '*') ||
      token === '*' ||
      (/^[A-Za-z_]\w*$/.test(token) && (this.peek() === '[' || this.peek() === '->'))
    ) {
      this.position--;
      this.memoryStatement(';');
      return;
    }
    if (token === ';') return;
    if (this.peek() === ':') {
      this.take(':');
      this.labels.set(token, this.ops.length);
      this.take(';');
      return;
    }
    if (token === 'goto') {
      this.ops.push({ kind: 'jump', target: this.take() });
      this.take(';');
      return;
    }
    if (token === 'return') {
      this.ops.push({
        kind: 'return',
        expression: this.peek() === ';' ? { kind: 'list', values: [] } : this.expression(),
      });
      this.take(';');
      return;
    }
    if (token === 'break') {
      breaks.push(this.ops.length);
      this.ops.push({ kind: 'jump', target: -1 });
      this.take(';');
      return;
    }
    if (token === 'continue') {
      const loop = this.loops.at(-1);
      assert.ok(loop);
      loop.continues?.push(this.ops.length);
      this.ops.push({ kind: 'jump', target: loop.start });
      this.take(';');
      return;
    }
    if (token === 'if') {
      this.take('(');
      const condition = this.expression();
      this.take(')');
      const test: Op & { kind: 'test' } = { kind: 'test', condition, target: -1 };
      this.ops.push(test);
      this.block(breaks);
      const end: Op & { kind: 'jump' } = { kind: 'jump', target: -1 };
      this.ops.push(end);
      test.target = this.ops.length;
      if (this.peek() === 'else') {
        this.take('else');
        this.block(breaks);
      }
      end.target = this.ops.length;
      return;
    }
    if (token === 'while') {
      const start = this.ops.length;
      this.take('(');
      const condition = this.expression();
      this.take(')');
      const test: Op & { kind: 'test' } = { kind: 'test', condition, target: -1 };
      this.ops.push(test);
      const exits: number[] = [];
      this.loops.push({ start, breaks: exits });
      this.block(exits);
      this.loops.pop();
      this.ops.push({ kind: 'jump', target: start });
      test.target = this.ops.length;
      for (const index of exits) {
        const op = this.ops[index]!;
        assert.equal(op.kind, 'jump');
        if (op.kind === 'jump') op.target = this.ops.length;
      }
      return;
    }
    if (token === 'for') {
      // for (a = x, b = y; cond; a = a + 1, b = b - 1) { body }
      const assignments = (end: string): Op[] => {
        const list: Op[] = [];
        while (this.peek() !== end) {
          const name = this.take();
          this.take('=');
          list.push({ kind: 'assign', names: [name], expression: this.expression(), tuple: false });
          if (this.peek() === ',') this.take(',');
        }
        this.take(end);
        return list;
      };
      this.take('(');
      this.ops.push(...assignments(';'));
      const start = this.ops.length,
        condition = this.expression();
      this.take(';');
      const step = assignments(')');
      const test: Op & { kind: 'test' } = { kind: 'test', condition, target: -1 };
      this.ops.push(test);
      const exits: number[] = [],
        continues: number[] = [];
      this.loops.push({ start, breaks: exits, continues });
      this.block(exits);
      this.loops.pop();
      const next = this.ops.length;
      this.ops.push(...step, { kind: 'jump', target: start });
      test.target = this.ops.length;
      for (const index of continues) {
        const op = this.ops[index]!;
        if (op.kind === 'jump') op.target = next;
      }
      for (const index of exits) {
        const op = this.ops[index]!;
        if (op.kind === 'jump') op.target = this.ops.length;
      }
      return;
    }
    if (token === 'do') {
      const start = this.ops.length,
        exits: number[] = [],
        continues: number[] = [];
      this.loops.push({ start, breaks: exits, continues });
      this.block(exits);
      this.loops.pop();
      const test = this.ops.length;
      this.take('while');
      this.take('(');
      const condition = this.expression();
      this.take(')');
      this.take(';');
      const leave: Op & { kind: 'test' } = { kind: 'test', condition, target: -1 };
      this.ops.push(leave, { kind: 'jump', target: start });
      leave.target = this.ops.length;
      for (const index of continues) {
        const op = this.ops[index]!;
        if (op.kind === 'jump') op.target = test;
      }
      for (const index of exits) {
        const op = this.ops[index]!;
        if (op.kind === 'jump') op.target = this.ops.length;
      }
      return;
    }
    if (token === 'switch') {
      this.take('(');
      const expression = this.expression();
      this.take(')');
      const name = `$switch${this.switchId++}`;
      this.ops.push({ kind: 'assign', names: [name], expression, tuple: false });
      const dispatch: Op & { kind: 'jump' } = { kind: 'jump', target: -1 };
      this.ops.push(dispatch);
      this.take('{');
      const cases: { value: Expr; start: number }[] = [],
        exits: number[] = [];
      let otherwise = -1;
      while (this.peek() !== '}') {
        const kind = this.take();
        if (kind === 'case') {
          const value = this.expression();
          this.take(':');
          cases.push({ value, start: this.ops.length });
        } else {
          assert.equal(kind, 'default');
          this.take(':');
          otherwise = this.ops.length;
        }
        // Consecutive labels share the next label's statements; a body is either
        // one braced block or the statements up to the next label.
        if (this.peek() === '{') this.block(exits);
        else while (!['case', 'default', '}'].includes(this.peek())) this.statement(exits);
      }
      this.take('}');
      dispatch.target = this.ops.length;
      for (const item of cases) {
        this.ops.push({
          kind: 'test',
          condition: { kind: 'binary', op: '==', left: { kind: 'ref', name }, right: item.value },
          target: this.ops.length + 2,
        });
        this.ops.push({ kind: 'jump', target: item.start });
      }
      // Without a default, an unmatched value leaves the switch.
      this.ops.push({ kind: 'jump', target: otherwise >= 0 ? otherwise : this.ops.length + 1 });
      for (const index of exits) {
        const op = this.ops[index]!;
        if (op.kind === 'jump') op.target = this.ops.length;
      }
      return;
    }
    if (this.peek() === '(') {
      this.position--;
      this.ops.push({ kind: 'effect', expression: this.expression() });
      this.take(';');
      return;
    }
    let names: string[];
    if (token === '(') {
      names = [this.take()];
      while (this.peek() === ',') {
        this.take(',');
        names.push(this.take());
      }
      this.take(')');
    } else {
      this.position--;
      const type = this.bodyType(false);
      if (type) {
        names = [this.take()];
        this.symbols.set(names[0]!, this.cType(type));
      } else {
        this.take(token);
        names = [token];
      }
    }
    const expression = this.peek() === '=' ? (this.take('='), this.expression()) : null;
    this.take(';');
    this.ops.push({ kind: 'assign', names, expression, tuple: token === '(' });
  }

  private memoryStatement(end: string): void {
    const memory = this.expression();
    assert.ok(memory.kind === 'call' && memory.name === 'read_memory');
    if (this.peek() === '=') {
      this.take('=');
      const assigned = this.expression();
      // C assignment converts to the lvalue type: an integer stored through a
      // float/double lvalue is a numeric conversion, not a bit copy.
      const value: Expr =
        memory.ctype?.kind === 'float'
          ? { kind: 'cast', type: memory.ctype, value: assigned }
          : assigned;
      this.ops.push({
        kind: 'effect',
        expression: {
          kind: 'call',
          name: 'write_memory',
          args: [memory.args[0]!, value, ...memory.args.slice(1)],
        },
      });
    } else this.ops.push({ kind: 'effect', expression: memory });
    this.take(end);
  }

  /** A conjunction operand: Python `not` binds looser than comparisons and
   * tighter than `and`/`or`; same semantics as C `!`. */
  private conjunct(): Expr {
    if (this.python && this.peek() === 'not') {
      this.take('not');
      return { kind: 'unary', op: '!', value: this.conjunct() };
    }
    return this.expression(1);
  }

  private expression(minimum = 0): Expr {
    let left = minimum === 0 ? this.conjunct() : this.atom();
    // Each dialect parses with its own grammar: Python's bitwise operators bind
    // tighter than comparisons, C's looser.
    const precedence: Record<string, number> = this.python
      ? {
          '==': 1,
          '!=': 1,
          '<': 1,
          '<=': 1,
          '>': 1,
          '>=': 1,
          '|': 2,
          '^': 3,
          '&': 4,
          '<<': 5,
          '>>': 5,
          '+': 6,
          '-': 6,
          '*': 7,
          '%': 7,
        }
      : {
          '|': 1,
          '^': 2,
          '&': 3,
          '==': 4,
          '!=': 4,
          '<': 5,
          '<=': 5,
          '>': 5,
          '>=': 5,
          '<<': 6,
          '>>': 6,
          '+': 7,
          '-': 7,
          '*': 8,
          '/': 8,
          '%': 8,
        };
    while ((precedence[this.peek()] ?? -1) >= minimum) {
      const op = this.take(),
        right = this.expression(precedence[op]! + 1);
      left = { kind: 'binary', op, left, right };
    }
    if (minimum > 0) return left;
    const conjunction = (first: Expr): Expr => {
      let result = first;
      while (this.peek() === (this.python ? 'and' : '&&')) {
        this.take();
        result = { kind: 'binary', op: '&&', left: result, right: this.conjunct() };
      }
      return result;
    };
    left = conjunction(left);
    // `||` binds tighter than the conditional operator in both dialects.
    while (this.peek() === (this.python ? 'or' : '||')) {
      this.take();
      left = { kind: 'binary', op: '||', left, right: conjunction(this.conjunct()) };
    }
    if (this.peek() === '?') {
      this.take('?');
      const yes = this.expression();
      this.take(':');
      left = { kind: 'select', condition: left, yes, no: this.expression() };
    }
    if (this.peek() === 'if') {
      this.take('if');
      const condition = this.expression();
      this.take('else');
      left = { kind: 'select', condition, yes: left, no: this.expression() };
    }
    return left;
  }

  private atom(): Expr {
    let expression = this.primary();
    for (;;) {
      if (this.peek() === '(') {
        this.take('(');
        const args: Expr[] = [];
        if (this.peek() !== ')') {
          args.push(this.expression());
          while (this.peek() === ',') {
            this.take(',');
            args.push(this.expression());
          }
        }
        this.take(')');
        expression = { kind: 'invoke', target: expression, args };
      } else if (
        this.python &&
        this.peek() === '[' &&
        expression.kind === 'ref' &&
        this.tables.has(expression.name)
      ) {
        const table = this.tables.get(expression.name)!;
        this.take('[');
        const index = this.expression();
        this.take(']');
        expression = this.read(
          {
            kind: 'binary',
            op: '+',
            left: { kind: 'literal', value: table.address },
            right: {
              kind: 'binary',
              op: '*',
              left: index,
              right: { kind: 'literal', value: BigInt(table.bits / 8) },
            },
          },
          { kind: 'int', bits: table.bits, signed: false },
        );
      } else if (!this.python && this.peek() === '[') {
        this.take('[');
        const index = this.expression();
        this.take(']');
        const added: Expr = { kind: 'binary', op: '+', left: expression, right: index };
        expression = this.peek() === '.' ? added : this.dereference(added);
      } else if (!this.python && (this.peek() === '->' || this.peek() === '.')) {
        this.take();
        const type = this.typeOf(expression),
          field = this.take();
        assert.ok(
          type.kind === 'pointer' && type.to?.kind === 'struct',
          `${field}: not a struct pointer`,
        );
        const member = this.structs.get(type.to.name)?.fields.get(field);
        assert.ok(
          member?.type.kind === 'int' || (member?.type.kind === 'pointer' && !member.array),
          `Undeclared struct member ${field}`,
        );
        const address: Expr = {
          kind: 'binary',
          op: '+',
          left: { kind: 'cast', type: unsignedType(64), value: expression },
          right: { kind: 'literal', value: member.offset, ctype: unsignedType(64) },
        };
        const memberType = member.type;
        expression =
          memberType.kind !== 'int'
            ? // A pointer member is its 64-bit target address.
              { ...this.read(address, { kind: 'int', bits: 64, signed: false }), ctype: memberType }
            : member.array
              ? { kind: 'cast', type: { kind: 'pointer', to: memberType }, value: address }
              : this.read(address, memberType);
      } else return expression;
    }
  }

  /** Plain C dereference of a typed scalar pointer; alignment follows the
   * function's documented target permission (see `local_validation`). */
  private dereference(pointer: Expr): Expr {
    const type = this.typeOf(pointer);
    assert.ok(
      type.kind === 'pointer' && (type.to?.kind === 'int' || type.to?.kind === 'float'),
      'Dereference of a non-scalar pointer',
    );
    return this.read(pointer, type.to);
  }

  private read(
    address: Expr,
    type: Extract<CType, { kind: 'int' | 'float' }>,
  ): Extract<Expr, { kind: 'call' }> {
    assert.ok(type.bits % 8 === 0 && (type.kind === 'float' || !type.bool));
    return {
      kind: 'call',
      name: 'read_memory',
      args: [
        address,
        { kind: 'literal', value: `${type.kind === 'float' ? 'ieee' : 'bits'}${type.bits}_t` },
        { kind: 'literal', value: 'little' },
        { kind: 'literal', value: 'natural' },
        { kind: 'literal', value: false },
      ],
      ctype: type,
    };
  }

  /** Static C type (LP64); Python-like values are mathematical integers. */
  typeOf(expression: Expr): CType {
    const cached = this.types.get(expression);
    if (cached) return cached;
    let type: CType = MATH;
    switch (expression.kind) {
      case 'literal':
        type = expression.ctype ?? MATH;
        break;
      case 'ref':
        type = this.symbols.get(expression.name) ?? MATH;
        break;
      case 'cast':
        type = expression.type;
        break;
      case 'call':
        type = expression.ctype ?? helperType(expression);
        break;
      case 'unary':
        type = expression.op === '!' ? INT : promote(this.typeOf(expression.value));
        break;
      case 'binary': {
        const left = this.typeOf(expression.left),
          right = this.typeOf(expression.right);
        if (['==', '!=', '<', '<=', '>', '>=', '&&', '||'].includes(expression.op)) type = INT;
        else if (expression.op === '<<' || expression.op === '>>') type = promote(left);
        else if (expression.op === '-' && left.kind === 'pointer' && right.kind === 'pointer')
          type = { kind: 'int', bits: 64, signed: true };
        else if ((expression.op === '+' || expression.op === '-') && left.kind === 'pointer')
          type = left;
        else if (expression.op === '+' && right.kind === 'pointer') type = right;
        else type = usualArithmetic(left, right);
        break;
      }
      case 'select': {
        const yes = this.typeOf(expression.yes),
          no = this.typeOf(expression.no);
        type = yes.kind === 'pointer' && no.kind === 'pointer' ? yes : usualArithmetic(yes, no);
        break;
      }
    }
    if (this.python && type.kind !== 'float') type = MATH;
    this.types.set(expression, type);
    return type;
  }

  /** Exact C view size; declarations never establish allocation bounds. */
  elementSize(type: CType): bigint {
    assert.ok(type.kind === 'pointer' && type.to, 'Pointer arithmetic on an incomplete type');
    if (type.to.kind === 'struct') {
      const layout = this.structs.get(type.to.name);
      assert.ok(layout, 'Pointer arithmetic on an incomplete structure');
      return layout.size;
    }
    assert.ok(
      (type.to.kind === 'int' || type.to.kind === 'float') && type.to.bits % 8 === 0,
      'Pointer arithmetic needs a sized scalar element',
    );
    return BigInt(type.to.bits / 8);
  }

  private primary(): Expr {
    const token = this.take();
    // The open-arity marker printed in call position: the same unresolved remainder.
    if (token === '...') return { kind: 'call', name: 'unknown_argument_remainder', args: [] };
    if (token === '&' && this.scalars.has(this.peek()) && this.tokens[this.position + 1] !== '[')
      return { kind: 'ref', name: this.take() };
    if (token === '&') {
      const name = this.take();
      this.take('[');
      const offset = this.expression();
      this.take(']');
      return { kind: 'call', name: 'address_of', args: [{ kind: 'ref', name }, offset] };
    }
    if (token === '*') {
      const pointer = this.atom();
      if (pointer.kind === 'call' && pointer.name === '__pointer') {
        const type = pointer.ctype;
        assert.ok(
          type?.kind === 'pointer' && (type.to?.kind === 'int' || type.to?.kind === 'float'),
        );
        return { kind: 'call', name: 'read_memory', args: pointer.args, ctype: type.to };
      }
      return this.dereference(pointer);
    }
    if (token === 'memory' && this.peek() === '.') {
      this.take('.');
      const view = this.take(),
        match = /^(volatile_)?(be_)?([uf])(\d+)$/.exec(view);
      assert.ok(match);
      this.take('[');
      const address = this.expression();
      this.take(']');
      return {
        kind: 'call',
        name: 'read_memory',
        args: [
          address,
          { kind: 'literal', value: `${match[3] === 'f' ? 'ieee' : 'bits'}${match[4]}_t` },
          { kind: 'literal', value: match[2] ? 'big' : 'little' },
          { kind: 'literal', value: 1n },
          { kind: 'literal', value: !!match[1] },
        ],
        ...(match[3] === 'f' ? { ctype: { kind: 'float', bits: Number(match[4]) } } : {}),
      };
    }
    if (['-', '~', '!'].includes(token)) return { kind: 'unary', op: token, value: this.atom() };
    if (token === '(') {
      if (
        this.peek() === 'volatile' ||
        (/^(?:(?:unaligned_|aligned\d+_)?u?int\d+_t|float|double)$/.test(this.peek()) &&
          this.tokens[this.position + 1] === '*' &&
          this.tokens[this.position + 2] === ')')
      ) {
        const volatile = this.peek() === 'volatile' ? (this.take(), true) : false;
        const type = this.take(),
          match = /^(?:(unaligned_)|aligned(\d+)_)?(u?)int(\d+)_t$|^(float|double)$/.exec(type);
        assert.ok(match);
        this.take('*');
        this.take(')');
        const floating = match[5] !== undefined;
        const bits = floating ? (match[5] === 'float' ? 32 : 64) : Number(match[4]);
        return {
          kind: 'call',
          name: '__pointer',
          args: [
            this.atom(),
            { kind: 'literal', value: `${floating ? 'ieee' : 'bits'}${bits}_t` },
            { kind: 'literal', value: 'little' },
            {
              kind: 'literal',
              value: match[1]
                ? 1n
                : match[2]
                  ? BigInt(match[2])
                  : this.python
                    ? BigInt(bits / 8)
                    : 'natural',
            },
            { kind: 'literal', value: volatile },
          ],
          // As a value this is an ordinary pointer conversion; `*` reads through it.
          ctype: {
            kind: 'pointer',
            to: floating ? { kind: 'float', bits } : { kind: 'int', bits, signed: !match[3] },
          },
        };
      }
      const castStart = this.position,
        type = this.python ? null : this.bodyType(false);
      if (
        type &&
        this.peek() === '(' &&
        this.tokens[this.position + 1] === '*' &&
        this.tokens[this.position + 2] === ')' &&
        this.tokens[this.position + 3] === '('
      ) {
        // Function-pointer cast `(R (*)(T, ...))target`: only the address bits
        // reach the invocation; the prototype is presentation.
        this.position += 4;
        while (this.peek() !== ')') {
          if (this.peek() === '...') this.take('...');
          else assert.ok(this.bodyType(false), 'Unsupported function-pointer parameter');
          if (this.peek() === ',') this.take(',');
        }
        this.take(')');
        this.take(')');
        return { kind: 'cast', type: { kind: 'pointer', to: null }, value: this.atom() };
      }
      if (
        type &&
        this.peek() === ')' &&
        (type.pointers > 0 || /^(?:u?int\d+_t|uintptr_t|bool|float|double)$/.test(type.scalar))
      ) {
        this.take(')');
        return { kind: 'cast', type: this.cType(type), value: this.atom() };
      }
      this.position = castStart;
      const expression = this.expression();
      if (this.peek() !== ',') {
        this.take(')');
        return expression;
      }
      const values = [expression];
      while (this.peek() === ',') {
        this.take(',');
        if (this.peek() !== ')') values.push(this.expression());
      }
      this.take(')');
      return { kind: 'list', values };
    }
    if (token === '{' || token === '[') {
      const close = token === '{' ? '}' : ']',
        values: Expr[] = [];
      if (this.peek() !== close) {
        values.push(this.expression());
        while (this.peek() === ',') {
          this.take(',');
          values.push(this.expression());
        }
      }
      this.take(close);
      return { kind: 'list', values };
    }
    if (token.startsWith('"'))
      return { kind: 'literal', value: unescapeLiteral(token.slice(1, -1)) };
    // A C character constant has type int; Python spells the code as ord('c').
    if (token.startsWith("'") || token.startsWith("ord('")) {
      const body = token.slice(token.indexOf("'") + 1, token.lastIndexOf("'"));
      const code = unescapeLiteral(body).codePointAt(0)!;
      return this.python
        ? { kind: 'literal', value: BigInt(code) }
        : { kind: 'literal', value: BigInt(code), ctype: INT };
    }
    if (/^\d/.test(token)) {
      if (!token.startsWith('0x') && /[.eE]/.test(token)) {
        const bits = token.endsWith('f') ? 32 : 64;
        const bytes = new DataView(new ArrayBuffer(8));
        const value = Number(token.replace(/f$/, ''));
        if (bits === 32) bytes.setFloat32(0, value, true);
        else bytes.setFloat64(0, value, true);
        return {
          kind: 'literal',
          value: bits === 32 ? BigInt(bytes.getUint32(0, true)) : bytes.getBigUint64(0, true),
          ctype: { kind: 'float', bits },
        };
      }
      const value = BigInt(token);
      if (this.python) return { kind: 'literal', value };
      // C11 6.4.4.1: decimal constants are signed; hex may be unsigned.
      const hex = token.startsWith('0x');
      // bit_pattern's payload is exact machine-storage bits, not a C constant.
      if (hex && this.payload) return { kind: 'literal', value };
      assert.ok(
        value < 1n << 64n && (hex || value < 1n << 63n),
        `Unrepresentable C constant ${token}`,
      );
      const ctype: CType =
        value < 1n << 31n
          ? INT
          : hex && value < 1n << 32n
            ? unsignedType(32)
            : value < 1n << 63n
              ? { kind: 'int', bits: 64, signed: true }
              : unsignedType(64);
      return { kind: 'literal', value, ctype };
    }
    if (token === 'true' || token === 'false' || token === 'True' || token === 'False')
      return { kind: 'literal', value: token === 'true' || token === 'True' };
    if (this.peek() === '(') {
      this.take('(');
      const args: Expr[] = [];
      const payload = this.payload;
      this.payload = token === 'bit_pattern';
      if (this.peek() !== ')') {
        args.push(this.expression());
        while (this.peek() === ',') {
          this.take(',');
          args.push(this.expression());
        }
      }
      this.payload = payload;
      this.take(')');
      return { kind: 'call', name: token, args };
    }
    if (this.scalars.has(token)) return this.dereference({ kind: 'ref', name: token });
    return { kind: 'ref', name: token };
  }
}

export interface Observation {
  readonly exit: string;
  readonly values: readonly bigint[];
  /** Immutable literal bytes returned by the source-level pointer subset. */
  readonly string_result?: string;
  readonly tail_target?: bigint;
  readonly source_calls?: readonly {
    readonly name: string;
    readonly arguments: readonly bigint[];
  }[];
  readonly registers: ReadonlyMap<string, { readonly bits: bigint; readonly known: bigint }>;
  readonly memory: ReadonlyMap<bigint, number>;
  readonly events: readonly string[];
  readonly calls: readonly {
    readonly target: bigint;
    readonly arguments: readonly bigint[];
    readonly arguments_complete?: boolean;
  }[];
}
export type SourceCallOracle = (
  arguments_: readonly bigint[],
  context: { readonly arguments_complete: boolean },
) => bigint | readonly bigint[];

/** Formal identity comes from exact mapped declaration spans, never guessed
 * argN spelling or commas inside an annotated/generic type. */
export function emittedFormals(
  emission: EmittedText,
  headerEnd: number = new Parser(emission.text).headerEnd,
): readonly EmittedFormal[] {
  const python = /^def /m.test(emission.text);
  const declarations = new Map<string, { formal: EmittedFormal; start: number; end: number }>();
  for (const mapping of emission.mappings) {
    if (mapping.end > headerEnd) continue;
    const declaration = emission.text.slice(mapping.start, mapping.end).trim();
    const match = python
      ? /^([A-Za-z_]\w*)\s*:/.exec(declaration)
      : /\b([A-Za-z_]\w*)\s*,?$/.exec(declaration);
    if (!match) continue;
    if (
      !python &&
      !declaration.endsWith(',') &&
      !/^\s*[,)]/.test(emission.text.slice(mapping.end, headerEnd))
    )
      continue;
    // semantic_refs[0] is the mapped statement; all cite the emission's ids table.
    const semantic = mapping.semantic_refs.map((ref) => emission.ids[ref]!);
    const name = match[1]!,
      previous = declarations.get(name);
    if (previous) {
      assert.ok(
        mapping.start < previous.end && mapping.end > previous.start,
        `Duplicate formal declaration ${name}`,
      );
      declarations.set(name, {
        formal: {
          ...previous.formal,
          semantic_ids: [...new Set([...previous.formal.semantic_ids, ...semantic])],
        },
        start: Math.min(previous.start, mapping.start),
        end: Math.max(previous.end, mapping.end),
      });
    } else
      declarations.set(name, {
        formal: { name, statement_id: semantic[0]!, semantic_ids: [...new Set(semantic)] },
        start: mapping.start,
        end: mapping.end,
      });
  }
  return [...declarations.values()]
    .sort((left, right) => left.start - right.start)
    .map((declaration) => declaration.formal);
}
export function execute(
  emission: EmittedText,
  inputs: ReadonlyMap<string, bigint> = new Map(),
  memory: Map<bigint, number> = new Map(),
  callDelta = 0n,
  entryRegisters: Observation['registers'] = new Map(),
  unknownValues: ReadonlyMap<string, bigint> = new Map(),
  sourceCalls: ReadonlyMap<string, SourceCallOracle> = new Map(),
  requirementAcknowledgments: RequirementAcknowledgments = [],
): Observation {
  const text = emission.text,
    parser = new Parser(text),
    environment = new Map<string, Data>(inputs),
    events: string[] = [];
  const unalignedPermitted =
    emission.local_validation?.some(
      (record) => record.kind === 'presentation' && record.rule === 'unaligned_access_permitted',
    ) ?? false;
  // C assignment (and argument passing) converts to the declared object type.
  const assign = (name: string, value: Data, source?: CType): void => {
    const type = parser.symbols.get(name);
    environment.set(
      name,
      typeof value === 'bigint' && type
        ? source && (!parser.python || type.kind === 'float')
          ? convertScalar(value, source, type)
          : convert(value, type)
        : value,
    );
  };
  // Mappings supply only formal input identity; every operation below executes
  // parsed output independently of the analyzed IR and its reconstruction plan.
  for (const formal of emittedFormals(emission, parser.headerEnd)) {
    const id = inputs.has(formal.statement_id)
      ? formal.statement_id
      : formal.semantic_ids.find((id) => inputs.has(id));
    assert.ok(id, `Missing explicit input for ${formal.name}`);
    assign(formal.name, inputs.get(id)!);
  }
  const calls: { target: bigint; arguments: bigint[]; arguments_complete?: boolean }[] = [];
  const sourceCallsObserved: { name: string; arguments: bigint[] }[] = [];
  const uninitializedStack = new Set<bigint>();
  let nextStackAddress = 0x7000000000000000n;
  const number = (value: Data | undefined): bigint => {
    assert.equal(typeof value, 'bigint');
    return value as bigint;
  };
  const array = (value: Data | undefined): Data[] => {
    assert.ok(Array.isArray(value));
    return value;
  };
  const string = (value: Data | undefined): string => {
    assert.equal(typeof value, 'string');
    return value as string;
  };
  const width = (type: Data | undefined): number => {
    const match = /^(?:bits|ieee)(\d+)_t$|^vector_[if](\d+)x(\d+)_t$/.exec(string(type));
    assert.ok(match);
    return match[1] ? Number(match[1]) : Number(match[2]) * Number(match[3]);
  };
  const object = (value: Data | undefined): { readonly [key: string]: Data } => {
    assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
    return value;
  };
  const descriptor = (value: Data | undefined): { root: string; offset: bigint; bits: bigint } => {
    const match = /^(.*):(\d+):(\d+)$/.exec(string(value));
    assert.ok(match);
    return { root: match[1]!, offset: BigInt(match[2]!), bits: BigInt(match[3]!) };
  };
  const physical = (state: Data | undefined): Observation['registers'] => {
    const roots = new Map(entryRegisters);
    const bindings = array(state);
    for (let i = 0; i < bindings.length; i += 2) {
      const { root, offset, bits } = descriptor(bindings[i]),
        value = bindings[i + 1];
      const mask = ((1n << bits) - 1n) << offset,
        previous = roots.get(root) ?? { bits: 0n, known: 0n };
      roots.set(
        root,
        value === null
          ? { bits: previous.bits & ~mask, known: previous.known & ~mask }
          : {
              bits: (previous.bits & ~mask) | ((number(value) << offset) & mask),
              known: previous.known | mask,
            },
      );
    }
    return roots;
  };
  const scratch = new DataView(new ArrayBuffer(8));
  const decodeFloat = (bits: bigint, n: number): number => {
    if (n === 32) {
      scratch.setUint32(0, Number(bits), true);
      return scratch.getFloat32(0, true);
    }
    scratch.setBigUint64(0, bits, true);
    return scratch.getFloat64(0, true);
  };
  const encodeFloat = (value: number, n: number): bigint => {
    if (Number.isNaN(value)) return n === 32 ? 0x7fc00000n : 0x7ff8000000000000n;
    if (n === 32) {
      scratch.setFloat32(0, value, true);
      return BigInt(scratch.getUint32(0, true));
    }
    scratch.setFloat64(0, value, true);
    return scratch.getBigUint64(0, true);
  };
  const convertScalar = (value: bigint, source: CType, target: CType): bigint => {
    if (target.kind === 'float') {
      if (source.kind === 'float')
        return source.bits === target.bits
          ? value
          : encodeFloat(decodeFloat(value, source.bits), target.bits);
      if (source.kind === 'int') return integerFloatBits(value, target.bits);
    }
    if (source.kind === 'float' && target.kind === 'int') {
      const number = decodeFloat(value, source.bits);
      if (target.bool) return BigInt(number !== 0);
      if (!Number.isFinite(number))
        throw new UndefinedBehavior('Non-finite native float-to-integer conversion');
      const integer = BigInt(Math.trunc(number));
      if (
        integer < (target.signed ? -(1n << BigInt(target.bits - 1)) : 0n) ||
        integer >= 1n << BigInt(target.bits - Number(target.signed))
      )
        throw new UndefinedBehavior('Out-of-range native float-to-integer conversion');
      return integer;
    }
    return convert(value, target);
  };
  const literals = new Map<string, bigint>();
  let nextLiteralAddress = 0x6000000000000000n;
  const invokeSourceCall = (name: string, target: bigint | undefined, args: Data[]): Data => {
    const sourceCall =
      sourceCalls.get(name) ??
      (target === undefined ? undefined : sourceCalls.get(`0x${target.toString(16)}`));
    if (!sourceCall) throw new Error(`Oracle does not support helper ${name}`);
    const last = args.at(-1);
    const remainder =
      last !== null &&
      typeof last === 'object' &&
      !Array.isArray(last) &&
      (last['unresolved'] === 'unknown_arguments' ||
        last['unresolved'] === 'unknown_argument_remainder');
    const prefix = remainder ? args.slice(0, -1) : args;
    if (prefix.includes(null)) throw new Boundary('unknown', []);
    // A string literal argument is the address of its static, NUL-terminated
    // UTF-8 bytes (C11 6.4.5), interned once per distinct literal.
    const arguments_ = prefix.map((arg) => {
      if (typeof arg !== 'string') return number(arg);
      const interned = literals.get(arg);
      if (interned !== undefined) return interned;
      const bytes = [...Buffer.from(arg, 'utf8'), 0];
      let base = nextLiteralAddress;
      while (bytes.some((_, offset) => memory.has(base + BigInt(offset)))) base += 0x1000n;
      bytes.forEach((byte, offset) => memory.set(base + BigInt(offset), byte));
      nextLiteralAddress = base + BigInt(bytes.length + 15) - (BigInt(bytes.length + 15) % 16n);
      literals.set(arg, base);
      return base;
    });
    const context = { arguments_complete: !remainder };
    events.push('call');
    sourceCallsObserved.push({ name, arguments: arguments_ });
    if (target !== undefined) calls.push({ target, arguments: arguments_, ...context });
    const returned = sourceCall(arguments_, context);
    return typeof returned === 'bigint' ? returned : [...returned];
  };
  const helper = (name: string, args: Data[]): Data => {
    const sourceCast = /^(u?int)(\d+)$/.exec(name);
    if (sourceCast)
      return args[0] === null
        ? null
        : sourceCast[1] === 'uint'
          ? BigInt.asUintN(Number(sourceCast[2]), number(args[0]))
          : BigInt.asIntN(Number(sourceCast[2]), number(args[0]));
    if (name === '__pointer') return args[0]!;
    if (
      /^(?:bv_|fp_|cast_|flag_|vector_|extract_bits$|insert_bits$|concat_low_first$|signed_value$|wrap$)/.test(
        name,
      ) &&
      args.includes(null)
    )
      return null;
    if (name === 'wrap') return BigInt.asUintN(Number(number(args[0])), number(args[1]));
    if (name === 'bit_pattern') return BigInt.asUintN(Number(number(args[1])), number(args[2]));
    if (name === 'image_address') return number(args[2]);
    if (name === 'data_address') return number(args[1]) + number(args[2]);
    if (name === 'address_of') return number(args[0]) + number(args[1]);
    if (name === 'stack_storage') {
      const size = number(args[0]),
        alignment = number(args[1]);
      assert.ok(size >= 0n && size <= 1048576n && alignment > 0n);
      let base = ((nextStackAddress + alignment - 1n) / alignment) * alignment;
      for (;;) {
        let overlap = false;
        for (let offset = 0n; offset < size; offset++)
          if (memory.has(base + offset)) {
            overlap = true;
            break;
          }
        if (!overlap) break;
        base += size + alignment;
      }
      for (let offset = 0n; offset < size; offset++) {
        memory.set(base + offset, 0);
        uninitializedStack.add(base + offset);
      }
      nextStackAddress = base + size + alignment;
      return base;
    }
    // Python-like function-pointer views carry only the target address bits.
    if (name === 'stack_slot' || name === 'field_view' || name === 'function_pointer')
      return args[0]!;
    if (name === 'source_target') return args[1]!;
    if (name === 'physical_inputs' || name === 'explicit_values' || name === 'boundary')
      return args;
    if (name === 'signed_value') return BigInt.asIntN(Number(number(args[0])), number(args[1]));
    if (name.startsWith('bv_')) {
      const n = Number(number(args[0])),
        a = number(args[1]),
        b = args[2] === undefined ? 0n : number(args[2]);
      let result: bigint;
      switch (name.slice(3)) {
        case 'add':
          result = a + b;
          break;
        case 'sub':
          result = a - b;
          break;
        case 'mul':
          result = a * b;
          break;
        case 'and':
          result = a & b;
          break;
        case 'or':
          result = a | b;
          break;
        case 'xor':
          result = a ^ b;
          break;
        case 'not':
          result = ~a;
          break;
        case 'neg':
          result = -a;
          break;
        case 'clz':
          result = BigInt(n - (a === 0n ? 0 : a.toString(2).length));
          break;
        case 'ctz': {
          let zeros = 0;
          while (zeros < n && ((a >> BigInt(zeros)) & 1n) === 0n) zeros++;
          result = BigInt(zeros);
          break;
        }
        case 'popcount':
          result = BigInt([...a.toString(2)].filter((bit) => bit === '1').length);
          break;
        case 'shl':
          result = b >= n ? 0n : a << b;
          break;
        case 'lshr':
          result = b >= n ? 0n : a >> b;
          break;
        case 'ashr':
          result = b >= n ? (BigInt.asIntN(n, a) < 0n ? -1n : 0n) : BigInt.asIntN(n, a) >> b;
          break;
        case 'rol':
          result = (a << (b % BigInt(n))) | (a >> (BigInt(n) - (b % BigInt(n))));
          break;
        case 'ror':
          result = (a >> (b % BigInt(n))) | (a << (BigInt(n) - (b % BigInt(n))));
          break;
        case 'udiv':
          if (b === 0n) return null;
          result = a / b;
          break;
        case 'urem':
          if (b === 0n) return null;
          result = a % b;
          break;
        case 'sdiv':
        case 'srem': {
          const left = BigInt.asIntN(n, a),
            right = BigInt.asIntN(n, b);
          if (right === 0n || (left === -(1n << BigInt(n - 1)) && right === -1n)) return null;
          result = name === 'bv_sdiv' ? left / right : left % right;
          break;
        }
        default:
          throw new Error(`Unimplemented oracle integer helper ${name}`);
      }
      return BigInt.asUintN(n, result);
    }
    if (name === 'extract_bits')
      return BigInt.asUintN(Number(number(args[0])), number(args[1]) >> number(args[2]));
    if (name === 'insert_bits') {
      const mask = ((1n << number(args[2])) - 1n) << number(args[4]);
      return BigInt.asUintN(
        Number(number(args[0])),
        (number(args[1]) & ~mask) | (number(args[3]) << number(args[4])),
      );
    }
    if (name === 'concat_low_first') {
      let result = 0n,
        offset = 0n;
      for (let i = 1; i < args.length; i += 2) {
        result |= number(args[i + 1]) << offset;
        offset += number(args[i]);
      }
      return result;
    }
    if (/^__od_bitcast_[fu](32|64)_[fu]\1$/.test(name)) return number(args[0]);
    if (name.startsWith('cast_')) {
      const n = width(args[0]),
        source = width(args[1]),
        value = number(args[2]);
      if (name === 'cast_sign_extend') return BigInt.asUintN(n, BigInt.asIntN(source, value));
      if (name === 'cast_bitcast' || name === 'cast_truncate' || name === 'cast_zero_extend')
        return BigInt.asUintN(n, value);
      if (name === 'cast_unsigned_to_float' || name === 'cast_signed_to_float')
        return integerFloatBits(
          name === 'cast_signed_to_float'
            ? BigInt.asIntN(source, value)
            : BigInt.asUintN(source, value),
          n,
        );
      if (name === 'cast_float_convert') return encodeFloat(decodeFloat(value, source), n);
      if (name === 'cast_float_to_unsigned' || name === 'cast_float_to_signed') {
        const decoded = decodeFloat(value, source);
        if (!Number.isFinite(decoded)) return null;
        const integer = BigInt(Math.trunc(decoded)),
          signed = name === 'cast_float_to_signed';
        if (
          integer < (signed ? -(1n << BigInt(n - 1)) : 0n) ||
          integer >= 1n << BigInt(n - Number(signed))
        )
          return null;
        return BigInt.asUintN(n, integer);
      }
      throw new Error(`Unimplemented oracle conversion ${name}`);
    }
    if (name === 'fp_neg') return number(args[1]) ^ (1n << (number(args[0]) - 1n));
    if (name === 'fp_abs') return number(args[1]) & ((1n << (number(args[0]) - 1n)) - 1n);
    if (name.startsWith('fp_')) {
      const n = Number(number(args[0])),
        a = decodeFloat(number(args[1]), n),
        b = args[2] === undefined ? 0 : decodeFloat(number(args[2]), n);
      switch (name) {
        case 'fp_add':
          return encodeFloat(a + b, n);
        case 'fp_sub':
          return encodeFloat(a - b, n);
        case 'fp_mul':
          return encodeFloat(a * b, n);
        case 'fp_div':
          return encodeFloat(a / b, n);
        case 'fp_sqrt':
          return encodeFloat(Math.sqrt(a), n);
        case 'fp_eq':
          return BigInt(a === b);
        case 'fp_ne':
          return BigInt(a !== b);
        case 'fp_lt':
          return BigInt(a < b);
        case 'fp_le':
          return BigInt(a <= b);
        case 'fp_gt':
          return BigInt(a > b);
        case 'fp_ge':
          return BigInt(a >= b);
        case 'fp_ordered':
          return BigInt(!Number.isNaN(a) && !Number.isNaN(b));
        case 'fp_unordered':
          return BigInt(Number.isNaN(a) || Number.isNaN(b));
      }
    }
    if (name.startsWith('flag_')) {
      const n = Number(number(args[0])),
        a = number(args[1]),
        b = number(args[2]),
        carry = number(args[3]),
        addition = name.startsWith('flag_add_');
      const full = addition ? a + b + carry : a - b - carry,
        wrapped = BigInt.asUintN(n, full),
        signed = addition
          ? BigInt.asIntN(n, a) + BigInt.asIntN(n, b) + carry
          : BigInt.asIntN(n, a) - BigInt.asIntN(n, b) - carry;
      const flag = name.split('_')[2];
      return BigInt(
        flag === 'carry'
          ? addition
            ? full >= 1n << BigInt(n)
            : full >= 0n
          : flag === 'borrow'
            ? full < 0n
            : flag === 'overflow'
              ? signed !== BigInt.asIntN(n, wrapped)
              : flag === 'zero'
                ? wrapped === 0n
                : flag === 'negative'
                  ? BigInt.asIntN(n, wrapped) < 0n
                  : [...(wrapped & 255n).toString(2)].filter((bit) => bit === '1').length % 2 === 0,
      );
    }
    if (name.startsWith('vector_bv_') || name.startsWith('vector_fp_')) {
      const match = /^vector_[if](\d+)x(\d+)_t$/.exec(string(args[0]));
      assert.ok(match);
      const n = Number(match[1]),
        lanes = Number(match[2]);
      let result = 0n;
      for (let lane = 0; lane < lanes; lane++) {
        const shift = BigInt(lane * n),
          left = BigInt.asUintN(n, number(args[1]) >> shift),
          right = BigInt.asUintN(n, number(args[2]) >> shift);
        result |= number(helper(name.slice(7), [BigInt(n), left, right])) << shift;
      }
      return result;
    }
    if (name === 'vector_lanes') {
      const match = /^vector_[if](\d+)x\d+_t$/.exec(string(args[0]));
      assert.ok(match);
      let result = 0n;
      for (let i = 1; i < args.length; i++)
        result |= number(args[i]) << BigInt((i - 1) * Number(match[1]));
      return result;
    }
    if (name === 'vector_lane')
      return BigInt.asUintN(
        width(args[0]),
        number(args[1]) >> (number(args[2]) * BigInt(width(args[0]))),
      );
    if (name === 'vector_insert') {
      const match = /^vector_[if](\d+)x\d+_t$/.exec(string(args[0]));
      assert.ok(match);
      const n = BigInt(match[1]!),
        offset = n * number(args[2]),
        mask = ((1n << n) - 1n) << offset;
      return (number(args[1]) & ~mask) | (number(args[3]) << offset);
    }
    const bigEndian = /^memory_be(\d+)$/.exec(name);
    if (bigEndian)
      return helper('read_memory', [
        args[0]!,
        `bits${bigEndian[1]}_t`,
        'big',
        BigInt(Number(bigEndian[1]) / 8),
        false,
      ]);
    if (name === 'write_memory' || name === 'read_memory') {
      const store = name === 'write_memory',
        address = number(args[0]),
        count = width(args[store ? 2 : 1]) / 8,
        endian = string(args[store ? 3 : 2]);
      events.push(store ? 'store' : 'load');
      const required = args[store ? 4 : 3];
      // A plain C scalar dereference requires natural alignment unless the
      // function documents that the target permits unaligned access.
      const alignment =
        required === 'natural' ? (unalignedPermitted ? 1n : BigInt(count)) : number(required);
      if (address % alignment !== 0n) throw new Boundary('fault', []);
      for (let i = 0; i < count; i++)
        if (!memory.has(address + BigInt(i))) throw new Boundary('fault', []);
      let value = 0n;
      for (let i = 0; i < count; i++) {
        const shift = BigInt((endian === 'little' ? i : count - 1 - i) * 8),
          cell = address + BigInt(i);
        if (store) {
          memory.set(cell, Number((number(args[1]) >> shift) & 255n));
          uninitializedStack.delete(cell);
        } else {
          if (uninitializedStack.has(cell)) return null;
          value |= BigInt(memory.get(cell)!) << shift;
        }
      }
      return store ? null : value;
    }
    if (name === 'memory_fence') {
      events.push(`fence:${args.map(string).join(':')}`);
      return null;
    }
    if (name === 'physical_call' || name === 'source_call') {
      events.push('call');
      calls.push({ target: number(args[0]), arguments: array(args[1]).map(number) });
      const before = physical(args[2]),
        results = array(args[4]).map(() => callDelta),
        outputs = array(args[5]).map((item) => {
          const { root, offset, bits } = descriptor(item),
            n = Number(bits);
          const value = before.get(root),
            required = (1n << (offset + bits)) - 1n;
          if (value === undefined || (value.known & required) !== required) return null;
          return BigInt.asUintN(n, (value.bits + callDelta) >> offset);
        });
      return [...results, ...outputs];
    }
    if (name === 'opaque_effect' || name === '__unknown_effect') {
      events.push('unknown');
      throw new Boundary('unknown', []);
    }
    if (name === 'unknown_value') return unknownValues.get(string(args[1])) ?? null;
    if (name === 'undefined_value') return null;
    if (
      name === 'unknown_arguments' ||
      name === 'unknown_argument_remainder' ||
      name === 'unknown_calling_convention' ||
      name === 'unknown_results'
    )
      return { unresolved: name };
    if (name === 'tail_call') {
      assert.equal(object(args[1])['unresolved'], 'unknown_arguments');
      assert.equal(object(args[2])['unresolved'], 'unknown_calling_convention');
      assert.equal(object(args[3])['unresolved'], 'unknown_results');
      events.push('tail_call');
      return { exit: 'tail_call', target: number(args[0]), values: [], state: args.at(-1)! };
    }
    if (name === 'physical_return' || name === 'source_return' || name.endsWith('_exit'))
      return {
        exit: name.endsWith('_return') ? 'machine_return' : name,
        values: name.endsWith('_return') ? array(args[0]) : [],
        state: args.at(-1)!,
      };
    const pointer = environment.get(name);
    const target = typeof pointer === 'bigint' ? pointer : undefined;
    return invokeSourceCall(name, target, args);
  };
  /** Bit pattern of a C argument as passed to a helper or call boundary. */
  const pattern = (value: Data, type: CType): Data =>
    typeof value === 'bigint' && type.kind === 'int' && type.signed
      ? BigInt.asUintN(type.bits, value)
      : value;
  const ub = (message: string): never => {
    throw new UndefinedBehavior(`Emitted C has undefined behavior: ${message}`);
  };
  /** C11 6.5.5-6.5.12 for typed operands; `math` (helper arguments documented as
   * mathematical, e.g. inside wrap, and Python-like ints) is unbounded. */
  const binary = (op: string, left: bigint, right: bigint, lt: CType, rt: CType): bigint => {
    if (lt.kind === 'float' || rt.kind === 'float') {
      const a = lt.kind === 'float' ? decodeFloat(left, lt.bits) : Number(left);
      const b = rt.kind === 'float' ? decodeFloat(right, rt.bits) : Number(right);
      const bits = Math.max(lt.kind === 'float' ? lt.bits : 0, rt.kind === 'float' ? rt.bits : 0);
      switch (op) {
        case '==':
          return BigInt(a === b);
        case '!=':
          return BigInt(a !== b);
        case '<':
          return BigInt(a < b);
        case '<=':
          return BigInt(a <= b);
        case '>':
          return BigInt(a > b);
        case '>=':
          return BigInt(a >= b);
        case '+':
          return encodeFloat(a + b, bits);
        case '-':
          return encodeFloat(a - b, bits);
        case '*':
          return encodeFloat(a * b, bits);
        case '/':
          return encodeFloat(a / b, bits);
        default:
          throw new Error(`Invalid floating operator ${op}`);
      }
    }
    const comparisons: Record<string, (a: bigint, b: bigint) => boolean> = {
      '==': (a, b) => a === b,
      '!=': (a, b) => a !== b,
      '<': (a, b) => a < b,
      '<=': (a, b) => a <= b,
      '>': (a, b) => a > b,
      '>=': (a, b) => a >= b,
    };
    if ((op === '+' || op === '-') && (lt.kind === 'pointer' || rt.kind === 'pointer')) {
      if (lt.kind === 'pointer' && rt.kind === 'pointer') {
        assert.equal(op, '-');
        return BigInt.asIntN(64, left - right) / parser.elementSize(lt);
      }
      const [base, type, index, indexType] =
        lt.kind === 'pointer' ? [left, lt, right, rt] : [right, rt, left, lt];
      const offset = convert(index, promote(indexType)) * parser.elementSize(type);
      return BigInt.asUintN(64, op === '+' ? base + offset : base - offset);
    }
    if (lt.kind === 'math' || rt.kind === 'math') {
      if (comparisons[op]) return BigInt(comparisons[op](left, right));
      switch (op) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '&':
          return left & right;
        case '|':
          return left | right;
        case '^':
          return left ^ right;
        case '<<':
          return left << right;
        case '>>':
          return left >> right;
        case '/':
          return left / right;
        case '%':
          return left % right;
      }
      throw new Error(`Unknown emitted operator ${op}`);
    }
    const range = (type: CType, value: bigint): bigint => {
      assert.ok(type.kind === 'int');
      if (!type.signed) return BigInt.asUintN(type.bits, value);
      if (BigInt.asIntN(type.bits, value) !== value)
        ub(`signed ${type.bits}-bit overflow in ${op}`);
      return value;
    };
    if (op === '<<' || op === '>>') {
      const type = promote(lt),
        count = convert(right, promote(rt));
      assert.ok(type.kind === 'int');
      if (count < 0n || count >= BigInt(type.bits))
        ub(`shift count ${count} for ${type.bits}-bit operand`);
      const value = convert(left, type);
      if (op === '>>') return value >> count;
      if (value < 0n) ub('left shift of a negative value');
      return range(type, value << count);
    }
    const type = usualArithmetic(lt, rt);
    const a = convert(left, type),
      b = convert(right, type);
    if (comparisons[op]) return BigInt(comparisons[op](a, b));
    switch (op) {
      case '+':
        return range(type, a + b);
      case '-':
        return range(type, a - b);
      case '*':
        return range(type, a * b);
      case '&':
        return range(type, a & b);
      case '|':
        return range(type, a | b);
      case '^':
        return range(type, a ^ b);
      case '/':
      case '%':
        if (b === 0n) ub(`${op} by zero`);
        return range(type, op === '/' ? a / b : a % b);
    }
    throw new Error(`Unknown emitted operator ${op}`);
  };
  const evaluate = (expression: Expr, math = false): Data => {
    const typeOf = (node: Expr): CType => (math ? MATH : parser.typeOf(node));
    const argumentsOf = (args: readonly Expr[], helper?: string): Data[] =>
      args.map((arg) => pattern(evaluate(arg, math || helper === 'wrap'), typeOf(arg)));
    switch (expression.kind) {
      case 'literal':
        return expression.value;
      case 'ref':
        assert.ok(
          environment.has(expression.name),
          `Undeclared/uninitialized emitted value ${expression.name}`,
        );
        return environment.get(expression.name)!;
      case 'list':
        return expression.values.map((value) => evaluate(value, math));
      case 'cast': {
        const value = evaluate(expression.value, math);
        return typeof value === 'bigint'
          ? convertScalar(value, typeOf(expression.value), expression.type)
          : value;
      }
      case 'call':
        if (expression.name === 'float') {
          const value = evaluate(expression.args[0]!, math);
          return value === null ? null : integerFloatBits(number(value), 64);
        }
        if (expression.name === 'requirement_predicate') {
          assert.equal(expression.args.length, 5);
          const requirement = string(evaluate(expression.args[0]!));
          const site = string(evaluate(expression.args[1]!));
          const epoch = string(evaluate(expression.args[2]!));
          // The fourth argument is structurally guaranteed pure by production
          // planning. Acknowledgment never resets unrelated unknown state and
          // cannot replace a known supported or unsupported predicate result.
          const predicate = evaluate(expression.args[3]!);
          if (predicate !== null) return predicate;
          const supported = number(evaluate(expression.args[4]!));
          assert.ok(supported === 0n || supported === 1n);
          return requirementAcknowledgments.some(
            (ack) =>
              ack.requirement_id === requirement &&
              ack.site_id === site &&
              ack.state_epoch === epoch,
          )
            ? supported
            : null;
        }
        // Python `abs` and the GCC/Clang `__builtin_fabs[f]`/`__builtin_sqrt[f]`
        // on a typed native float: sign-bit clear and the correctly rounded root.
        if (/^(?:abs|__builtin_(?:fabs|sqrt)f?)$/.test(expression.name)) {
          assert.equal(expression.args.length, 1);
          const type = typeOf(expression.args[0]!);
          assert.equal(type.kind, 'float');
          const bits = evaluate(expression.args[0]!);
          if (bits === null || type.kind !== 'float') return null;
          return expression.name.includes('sqrt')
            ? encodeFloat(Math.sqrt(decodeFloat(number(bits), type.bits)), type.bits)
            : number(bits) & ((1n << BigInt(type.bits - 1)) - 1n);
        }
        // C99 <math.h> / documented Python-like helper: 1 iff either is a NaN.
        if (expression.name === 'isunordered') {
          assert.equal(expression.args.length, 2);
          const operands = expression.args.map((arg) => {
            const bits = evaluate(arg),
              type = typeOf(arg);
            assert.equal(type.kind, 'float');
            return bits === null || type.kind !== 'float'
              ? null
              : decodeFloat(number(bits), type.bits);
          });
          if (operands.includes(null)) return null;
          return BigInt(operands.some((operand) => Number.isNaN(operand)));
        }
        {
          const args = argumentsOf(expression.args, expression.name);
          const fpWidth =
            expression.name.startsWith('fp_') && typeof args[0] === 'bigint'
              ? Number(args[0])
              : undefined;
          const castWidth =
            /^cast_/.test(expression.name) && typeof args[1] === 'string'
              ? /^ieee(32|64)_t$/.exec(args[1])
              : undefined;
          const bitcastWidth = /^__od_bitcast_u(?:32|64)_f(32|64)$/.exec(expression.name);
          for (let index = 0; index < args.length; index++) {
            const width =
              fpWidth !== undefined && index > 0
                ? fpWidth
                : castWidth && index === 2
                  ? Number(castWidth[1])
                  : bitcastWidth && index === 0
                    ? Number(bitcastWidth[1])
                    : undefined;
            const source = typeOf(expression.args[index]!);
            if (width !== undefined && source.kind === 'float' && typeof args[index] === 'bigint')
              args[index] = convertScalar(args[index] as bigint, source, {
                kind: 'float',
                bits: width,
              });
          }
          const value = helper(expression.name, args);
          return typeof value === 'bigint' && expression.ctype
            ? convert(value, expression.ctype)
            : value;
        }
      case 'invoke': {
        const bits = evaluate(expression.target, math);
        if (bits === null) throw new Boundary('unknown', []);
        const target = BigInt.asUintN(64, number(bits));
        return invokeSourceCall(`0x${target.toString(16)}`, target, argumentsOf(expression.args));
      }
      case 'select': {
        const condition = evaluate(expression.condition, math);
        if (condition === null) return null;
        const value = evaluate(
          condition === 0n || condition === false ? expression.no : expression.yes,
          math,
        );
        return typeof value === 'bigint' ? convert(value, typeOf(expression)) : value;
      }
      case 'unary': {
        const value = evaluate(expression.value, math);
        if (value === null) return null;
        const operand = number(value),
          type = promote(typeOf(expression.value));
        if (expression.op === '!') return BigInt(operand === 0n);
        if (type.kind === 'float' && expression.op === '-')
          return operand ^ (1n << BigInt(type.bits - 1));
        const result = expression.op === '-' ? -convert(operand, type) : ~convert(operand, type);
        if (type.kind !== 'int') return result;
        if (!type.signed) return BigInt.asUintN(type.bits, result);
        if (BigInt.asIntN(type.bits, result) !== result)
          ub(`signed overflow in unary ${expression.op}`);
        return result;
      }
      case 'binary': {
        const a = evaluate(expression.left, math);
        if (a === null) return null;
        if (expression.op === '&&' && number(a) === 0n) return 0n;
        if (expression.op === '||' && number(a) !== 0n) return 1n;
        const b = evaluate(expression.right, math);
        if (expression.op === '&&' || expression.op === '||')
          return b === null ? null : BigInt(number(b) !== 0n);
        if (a === null || b === null) return null;
        return binary(
          expression.op,
          number(a),
          number(b),
          typeOf(expression.left),
          typeOf(expression.right),
        );
      }
    }
  };
  try {
    let pc = 0;
    for (let steps = 0; steps < 20000; steps++) {
      const op =
        parser.ops[pc++] ??
        (parser.voidResult ? { kind: 'return' as const, expression: { kind: 'list' as const, values: [] } } : undefined);
      assert.ok(op, 'Emitted control fell out of function');
      switch (op.kind) {
        case 'assign':
          if (op.expression) {
            const value = evaluate(op.expression),
              values = op.tuple ? array(value) : [value];
            assert.equal(values.length, op.names.length);
            op.names.forEach((name, index) =>
              assign(name, values[index]!, op.tuple ? undefined : parser.typeOf(op.expression!)),
            );
          }
          break;
        case 'effect':
          evaluate(op.expression);
          break;
        case 'jump': {
          const target = typeof op.target === 'number' ? op.target : parser.labels.get(op.target);
          assert.ok(target !== undefined && target >= 0, 'Missing emitted label');
          pc = target;
          break;
        }
        case 'test': {
          const value = evaluate(op.condition);
          if (value === null) throw new Boundary('unknown', []);
          if (value === false || value === 0n) pc = op.target;
          break;
        }
        case 'return': {
          const value = evaluate(op.expression);
          if (value === null) throw new Boundary('unknown', []);
          if (typeof value === 'string')
            return {
              exit: 'machine_return',
              values: [],
              string_result: value,
              registers: new Map(),
              memory,
              events,
              calls,
            };
          if (typeof value === 'bigint' || Array.isArray(value))
            return {
              exit: 'machine_return',
              // `return` converts to the declared result type; observations
              // are its ABI bit pattern.
              values: (Array.isArray(value)
                ? value
                : [
                    pattern(
                      convertScalar(value, parser.typeOf(op.expression), parser.returnType),
                      parser.returnType,
                    ),
                  ]
              ).map(number),
              registers: new Map(),
              memory,
              events,
              calls,
              source_calls: sourceCallsObserved,
            };
          const result = object(value);
          return {
            exit: string(result['exit']),
            ...(result['target'] === undefined ? {} : { tail_target: number(result['target']) }),
            values: array(result['values']).map(number),
            registers: physical(result['state']),
            memory,
            events,
            calls,
            source_calls: sourceCallsObserved,
          };
        }
      }
    }
    throw new Error('Emitted program exceeded oracle step bound');
  } catch (error) {
    if (error instanceof Boundary)
      return {
        exit: error.exit,
        values: error.values,
        registers: new Map(),
        memory,
        events,
        calls,
      };
    throw error;
  }
}
class Boundary extends Error {
  constructor(
    readonly exit: string,
    readonly values: readonly bigint[],
  ) {
    super(exit);
  }
}

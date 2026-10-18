import type { Address } from '../core/index.js';
import { bitWidth, sameType, type DataType, type Expression, type Value } from '../ir/index.js';
import type { Writer } from './writer.js';

const floatLiteralStorage = new DataView(new ArrayBuffer(8));

/** These are machine storage types, never inferred C source types. */
export function machineType(type: DataType): string {
  switch (type.kind) {
    case 'integer':
      return `bits${type.bits}_t`;
    case 'float':
      return `ieee${type.bits}_t`;
    case 'vector':
      return `vector_${type.element.kind === 'float' ? 'f' : 'i'}${type.element.bits}x${type.lanes}_t`;
  }
}

/** Ordinary C storage for an exact-width bit-vector; reductions are separate. */
export function integerStorageBits(bits: number): number {
  return bits <= 8
    ? 8
    : bits <= 16
      ? 16
      : bits <= 32
        ? 32
        : bits <= 64
          ? 64
          : bits <= 128
            ? 128
            : bits;
}

const integerOperators: Partial<Record<Extract<Expression, { kind: 'integer' }>['op'], string>> = {
  add: '+',
  sub: '-',
  mul: '*',
  and: '&',
  or: '|',
  xor: '^',
};
const comparisonOperators: Record<Extract<Expression, { kind: 'compare' }>['op'], string> = {
  eq: '==',
  ne: '!=',
  ult: '<',
  ule: '<=',
  ugt: '>',
  uge: '>=',
  slt: '<',
  sle: '<=',
  sgt: '>',
  sge: '>=',
};
const integerMeaning: Record<string, string> = {
  add: 'Add unsigned bit patterns and reduce modulo 2^width.',
  sub: 'Subtract unsigned bit patterns and reduce modulo 2^width.',
  mul: 'Multiply unsigned bit patterns and reduce modulo 2^width.',
  and: 'Bitwise AND of width-bit patterns.',
  or: 'Bitwise OR of width-bit patterns.',
  xor: 'Bitwise XOR of width-bit patterns.',
  udiv: 'Unsigned division, quotient rounded toward zero. Zero divisor is undefined, not an established machine trap.',
  urem: 'Unsigned remainder. Zero divisor is undefined, not an established machine trap.',
  sdiv: "Interpret operands as width-bit two's complement, divide toward zero, return width-bit pattern. Zero divisor and minimum/-1 are undefined, not established traps.",
  srem: 'Signed remainder with quotient rounded toward zero; zero divisor and minimum/-1 are undefined, not established traps.',
  shl: 'Shift left by the full unsigned count; counts >= width produce zero. Reduce modulo 2^width. No implicit ISA count mask.',
  lshr: 'Logical right shift by the full unsigned count; counts >= width produce zero. No implicit ISA count mask.',
  ashr: "Two's-complement arithmetic right shift; counts >= width produce all sign bits. No implicit ISA count mask.",
  rol: 'Rotate left; count modulo width.',
  ror: 'Rotate right; count modulo width.',
};
const castMeaning: Record<string, string> = {
  truncate: 'Keep the low destination-width bits.',
  zero_extend: 'Zero-extend the bit pattern to destination width.',
  sign_extend: "Interpret the source as two's complement and sign-extend to destination width.",
  bitcast:
    'Reinterpret exactly the same bits, including NaN payloads, signed zero and vector lane packing; no numeric conversion.',
  signed_to_float:
    "Convert signed two's-complement integer directly to IEEE destination precision, round nearest ties-even (no intermediate double rounding).",
  unsigned_to_float:
    'Convert unsigned integer directly to IEEE destination precision, round nearest ties-even (no intermediate double rounding).',
  float_to_signed:
    'IEEE to signed integer, truncate toward zero. Non-finite or out-of-range results are undefined, not traps.',
  float_to_unsigned:
    'IEEE to unsigned integer, truncate toward zero. Non-finite or out-of-range results are undefined, not traps.',
  float_convert:
    'IEEE precision conversion with nearest ties-even rounding, gradual underflow and canonical arithmetic NaNs.',
};
const fpMeaning =
  'IEEE binary32/64, nearest ties-even and gradual underflow; arithmetic NaNs canonicalize to 0x7fc00000/0x7ff8000000000000. No ambient exception/control-register behavior is invented.';

/** The checked view: every reduction and reinterpretation is spelled out and
 * every compound form is fully parenthesized. Exact floating/vector/unknown
 * operations retain documented semantic helpers. */
function checkedExpressionText(
  expression: Expression,
  type: DataType,
  writer: Writer,
  name: (value: Value) => string,
  source?: { readonly address: (address: Address) => string },
): string {
  const width = bitWidth(type);
  const invoke = (helper: string, meaning: string, args: readonly string[]): string => {
    writer.helper(helper, meaning);
    return `${helper}(${writer.join(args)})`;
  };
  const unsigned = (bits: number, value: string): string => {
    if (writer.language === 'c-like')
      return bits === 1 ? `((${value}) & 1)` : `((uint${bits}_t)(${value}))`;
    return invoke(
      `uint${bits}`,
      `Reduce to an unsigned ${bits}-bit value; unknown/undefined propagates.`,
      [value],
    );
  };
  const signed = (bits: number, value: string): string =>
    writer.language === 'c-like'
      ? `((int${bits}_t)(${value}))`
      : invoke(
          `int${bits}`,
          `Interpret the low ${bits} bits as a signed two's-complement value; unknown/undefined propagates.`,
          [value],
        );
  switch (expression.kind) {
    case 'constant':
      return type.kind === 'integer'
        ? source && expression.bits >= 0n && expression.bits <= 9n
          ? String(expression.bits)
          : `0x${BigInt.asUintN(width, expression.bits).toString(16)}`
        : invoke(
            'bit_pattern',
            'Construct exact machine-storage bits, preserving floating-point/vector payloads.',
            [
              writer.quote(machineType(type)),
              String(width),
              `0x${BigInt.asUintN(width, expression.bits).toString(16)}`,
            ],
          );
    case 'address':
      return source
        ? source.address(expression.address)
        : invoke(
            'image_address',
            'Image-qualified address-space value; no host pointer, ASLR assumption or memory read.',
            [
              writer.quote(expression.address.image_id),
              writer.quote(expression.address.space),
              `0x${expression.address.value.toString(16)}`,
            ],
          );
    case 'integer': {
      const operator = integerOperators[expression.op];
      if (operator) {
        const infix = `(${name(expression.left)} ${operator} ${name(expression.right)})`;
        if (source)
          return expression.op === 'and' || expression.op === 'or' || expression.op === 'xor'
            ? infix
            : unsigned(width, infix);
        return expression.op === 'and' || expression.op === 'or' || expression.op === 'xor'
          ? infix
          : invoke(
              'wrap',
              'Arguments: bit width, mathematical integer expression. Reduce modulo 2^width; unknown/undefined propagates. Infix arithmetic inside wrap is mathematical, not host C arithmetic.',
              [String(width), infix],
            );
      }
      return invoke(
        `bv_${expression.op}`,
        `Arguments: width, left, right. ${integerMeaning[expression.op]} Unknown/undefined operands propagate.`,
        [String(width), name(expression.left), name(expression.right)],
      );
    }
    case 'integer_unary':
      if (source && (expression.op === 'neg' || expression.op === 'not'))
        return unsigned(width, `(${expression.op === 'neg' ? '-' : '~'}${name(expression.value)})`);
      if (expression.op === 'neg' || expression.op === 'not')
        return invoke(
          'wrap',
          'Arguments: bit width, mathematical integer expression. Reduce modulo 2^width; unknown/undefined propagates. Infix arithmetic inside wrap is mathematical, not host C arithmetic.',
          [String(width), `(${expression.op === 'neg' ? '-' : '~'}${name(expression.value)})`],
        );
      return invoke(
        `bv_${expression.op}`,
        `Arguments: width, value. ${expression.op === 'clz' ? 'Count leading zeros; zero input returns width.' : expression.op === 'ctz' ? 'Count trailing zeros; zero input returns width.' : 'Count set bits.'} Unknown/undefined operands propagate.`,
        [String(width), name(expression.value)],
      );
    case 'compare': {
      const isSigned = expression.op.startsWith('s');
      const operand = (value: Value): string =>
        isSigned
          ? source
            ? signed(bitWidth(value.type), name(value))
            : invoke(
                'signed_value',
                "Interpret a width-bit pattern as its mathematical two's-complement signed value; no host narrowing cast. Unknown/undefined propagates.",
                [String(bitWidth(value.type)), name(value)],
              )
          : name(value);
      return `(${operand(expression.left)} ${comparisonOperators[expression.op]} ${operand(expression.right)})`;
    }
    case 'cast':
      if (expression.op === 'bitcast' && sameType(type, expression.value.type))
        return name(expression.value);
      if (source && type.kind === 'integer' && expression.value.type.kind === 'integer') {
        if (expression.op === 'truncate' || expression.op === 'zero_extend')
          return unsigned(width, name(expression.value));
        if (expression.op === 'sign_extend')
          return unsigned(width, signed(bitWidth(expression.value.type), name(expression.value)));
      }
      return invoke(
        `cast_${expression.op}`,
        `Arguments: destination machine type, source machine type, value. ${castMeaning[expression.op]} Unknown/undefined operands propagate.`,
        [
          writer.quote(machineType(type)),
          writer.quote(machineType(expression.value.type)),
          name(expression.value),
        ],
      );
    case 'extract':
      if (source && expression.value.type.kind === 'integer' && type.kind === 'integer')
        return unsigned(
          width,
          expression.offset
            ? `(${name(expression.value)} >> ${expression.offset})`
            : name(expression.value),
        );
      return invoke(
        'extract_bits',
        'Arguments: result width, source, bit offset. Return that slice, offset zero is least significant; preserve raw FP/vector bits. Unknown/undefined propagates.',
        [String(width), name(expression.value), String(expression.offset)],
      );
    case 'insert':
      return invoke(
        'insert_bits',
        'Arguments: result width, base, value width, value, offset. Replace only the designated slice, preserving all other bits. Unknown/undefined propagates.',
        [
          String(width),
          name(expression.base),
          String(bitWidth(expression.value.type)),
          name(expression.value),
          String(expression.offset),
        ],
      );
    case 'concat': {
      if (
        source &&
        type.kind === 'integer' &&
        expression.values.every((value) => value.type.kind === 'integer')
      ) {
        let offset = 0;
        const parts: string[] = [];
        for (const value of expression.values) {
          writer.context.checkpoint(1);
          const part = unsigned(width, name(value));
          parts.push(offset ? `(${part} << ${offset})` : part);
          offset += bitWidth(value.type);
        }
        return `(${writer.join(parts, ' | ')})`;
      }
      const args = [String(width)];
      for (const value of expression.values) {
        writer.context.checkpoint(1);
        args.push(String(bitWidth(value.type)), name(value));
      }
      return invoke(
        'concat_low_first',
        'Arguments: total width, repeated (part width, value). First part occupies least significant bits; no host endian dependency. Undefined dominates unknown, otherwise concatenate exact patterns.',
        args,
      );
    }
    case 'select':
      return writer.language === 'c-like'
        ? `(${name(expression.condition)} ? ${name(expression.when_true)} : ${name(expression.when_false)})`
        : `(${name(expression.when_true)} if ${name(expression.condition)} else ${name(expression.when_false)})`;
    case 'flag':
      return invoke(
        `flag_${expression.op}_${expression.flag}`,
        `Arguments: operand width, left, right, carry/borrow-in. Compute full mathematical ${expression.op === 'add' ? 'left + right + carry' : 'left - right - borrow'} then its wrapped result. Carry is full >= 2^width for addition, full >= 0 for subtraction; borrow is full < 0; overflow compares signed full result with signed wrapped result; zero/negative inspect wrapped result; parity is even parity of its low eight bits. Return the named flag as one bit. Unknown/undefined propagates.`,
        [
          String(bitWidth(expression.left.type)),
          name(expression.left),
          name(expression.right),
          name(expression.carry),
        ],
      );
    case 'float':
      return invoke(
        `fp_${expression.op}`,
        `Arguments: width, left, right. ${fpMeaning} Unknown/undefined propagates.`,
        [String(width), name(expression.left), name(expression.right)],
      );
    case 'float_unary':
      return invoke(
        `fp_${expression.op}`,
        `Arguments: width, value. ${expression.op === 'neg' ? 'Toggle only the sign bit, preserving NaN payloads and signed zero.' : expression.op === 'abs' ? 'Clear only the sign bit, preserving NaN payloads.' : fpMeaning} Unknown/undefined propagates.`,
        [String(width), name(expression.value)],
      );
    case 'float_compare':
      return invoke(
        `fp_${expression.op}`,
        'Arguments: operand width, left, right. IEEE comparison returning one bit: unordered iff either is NaN; ordered iff neither is NaN; ne is true for unordered inputs, all other relational comparisons are false for unordered inputs. +0 equals -0. Unknown/undefined propagates.',
        [String(bitWidth(expression.left.type)), name(expression.left), name(expression.right)],
      );
    case 'vector':
      return invoke(
        'vector_lanes',
        'Arguments: vector machine type, lanes in increasing index order. Lane zero occupies the least significant bits. Unknown/undefined propagates.',
        [writer.quote(machineType(type)), ...writer.list(expression.lanes, name)],
      );
    case 'vector_lane':
      return invoke(
        'vector_lane',
        'Arguments: result machine type, vector, zero-based lane index. Extract raw lane bits, preserving IEEE payloads. Unknown/undefined propagates.',
        [writer.quote(machineType(type)), name(expression.vector), String(expression.lane)],
      );
    case 'vector_insert':
      return invoke(
        'vector_insert',
        'Arguments: vector machine type, vector, zero-based lane index, value. Replace only this lane; preserve all other bits. Unknown/undefined propagates.',
        [
          writer.quote(machineType(type)),
          name(expression.vector),
          String(expression.lane),
          name(expression.value),
        ],
      );
    case 'vector_integer':
      return invoke(
        `vector_bv_${expression.op}`,
        `Arguments: vector machine type, left, right. Independent per-lane operation; no cross-lane carry. ${integerMeaning[expression.op]} A lane with undefined/unknown input or result makes the vector undefined/unknown.`,
        [writer.quote(machineType(type)), name(expression.left), name(expression.right)],
      );
    case 'vector_float':
      return invoke(
        `vector_fp_${expression.op}`,
        `Arguments: vector machine type, left, right. Independent per-lane IEEE operation. ${fpMeaning} Unknown/undefined propagates.`,
        [writer.quote(machineType(type)), name(expression.left), name(expression.right)],
      );
    case 'indeterminate':
      return invoke(
        expression.state === 'unknown' ? 'unknown_value' : 'undefined_value',
        'Arguments: machine type, inert reason text. An unavailable/undefined value, not zero, a fresh random number, or an established trap; dependencies remain indeterminate.',
        [writer.quote(machineType(type)), writer.quote(expression.reason)],
      );
  }
}

/** Static type of a printed integer value. In C-like text it is the C type of
 * the expression (LP64, 32-bit int); in Python-like text the value lies in
 * [0, 2^bits) (signed: [-2^(bits-1), 2^(bits-1))). A printed value always
 * equals its IR operand's unsigned bit pattern unless `signed` says otherwise. */
export interface IntegerCType {
  readonly bits: number;
  readonly signed: boolean;
}
export interface Printed {
  readonly text: string;
  readonly precedence: number;
  readonly ctype: IntegerCType | null;
  /** The same value before its final modular reduction to its own unsigned
   * width: a context that converts implicitly to exactly that unsigned type
   * (C assignment/return) may print this instead. */
  readonly unreduced?: Printed;
  /** The same value at a narrower unsigned type (a zero extension): operators,
   * comparisons and converting contexts may use it; call arguments keep the
   * widening because variadic/unprototyped callees do not convert. */
  readonly widened?: Printed;
}
/** Binding strength shared by both dialects; only binary operators differ. */
export const PRIMARY = 16;
export const UNARY = 14;
export const CONDITIONAL = 3;
/** Logical connectives: C `&&`/`||`; Python `not` (below comparisons), `and`, `or`. */
const LOGICAL_AND = 5,
  LOGICAL_OR = 4,
  PYTHON_NOT = 6;
const C_PRECEDENCE: Readonly<Record<string, number>> = {
  '*': 13,
  '/': 13,
  '%': 13,
  '+': 12,
  '-': 12,
  '<<': 11,
  '>>': 11,
  '<': 10,
  '<=': 10,
  '>': 10,
  '>=': 10,
  '==': 9,
  '!=': 9,
  '&': 8,
  '^': 7,
  '|': 6,
};
const PYTHON_PRECEDENCE: Readonly<Record<string, number>> = {
  '*': 13,
  '%': 13,
  '+': 12,
  '-': 12,
  '<<': 11,
  '>>': 11,
  '&': 10,
  '^': 9,
  '|': 8,
  '<': 7,
  '<=': 7,
  '>': 7,
  '>=': 7,
  '==': 7,
  '!=': 7,
};
const INT: IntegerCType = { bits: 32, signed: true };
/** C integer promotion (bool, 8- and 16-bit types become int). */
function promote(type: IntegerCType): IntegerCType {
  return type.bits < 32 ? INT : type;
}
/** C usual arithmetic conversions. */
export function usualArithmetic(left: IntegerCType, right: IntegerCType): IntegerCType {
  const a = promote(left),
    b = promote(right);
  if (a.signed === b.signed) return a.bits >= b.bits ? a : b;
  const unsigned = a.signed ? b : a,
    signed = a.signed ? a : b;
  return unsigned.bits >= signed.bits ? unsigned : signed;
}

/** Source-view syntax shared by expression and memory printing. */
export class SourcePrinter {
  constructor(
    private readonly writer: Writer,
    private readonly nativeWidths = false,
  ) {}

  get python(): boolean {
    return this.writer.language === 'python-like';
  }

  primary(text: string, ctype: IntegerCType | null = null): Printed {
    return { text, precedence: PRIMARY, ctype };
  }

  group(value: Printed, minimum: number): string {
    return value.precedence < minimum ? `(${value.text})` : value.text;
  }

  /** Left-associative infix by precedence, plus grouping where C compilers
   * warn (-Wparentheses) or Python would chain comparisons. */
  binary(op: string, left: Printed, right: Printed, ctype: IntegerCType | null): Printed {
    const precedence = (this.python ? PYTHON_PRECEDENCE : C_PRECEDENCE)[op]!;
    const bitwise = op === '&' || op === '|' || op === '^',
      shift = op === '<<' || op === '>>',
      comparison = /^[<>=!]=?$/.test(op);
    const operand = (value: Printed, rightSide: boolean): string => {
      const mixed =
        value.precedence < UNARY &&
        ((bitwise && value.precedence !== precedence) ||
          shift ||
          (comparison && (this.python ? value.precedence <= precedence : value.precedence < 11)));
      return this.group(value, mixed ? UNARY : rightSide ? precedence + 1 : precedence);
    };
    return {
      text: `${operand(left, false)} ${op} ${operand(right, true)}`,
      precedence,
      ctype,
    };
  }

  /** Logical negation; exact for a one-bit value in any printed representation
   * whose zero is the zero bit pattern. */
  not(value: Printed): Printed {
    return this.python
      ? {
          text: `not ${this.group(value, PRIMARY)}`,
          precedence: PYTHON_NOT,
          ctype: { bits: 1, signed: false },
        }
      : { text: `!${this.group(value, UNARY)}`, precedence: UNARY, ctype: INT };
  }

  /** Conjunction/disjunction of one-bit values. Pure operands make evaluation
   * order unobservable and each connective associative; C groups `&&` inside
   * `||` (-Wparentheses). */
  logical(op: 'and' | 'or', left: Printed, right: Printed): Printed {
    const precedence = op === 'and' ? LOGICAL_AND : LOGICAL_OR;
    const operand = (value: Printed): string =>
      this.group(
        value,
        !this.python && op === 'or' && value.precedence === LOGICAL_AND ? UNARY : precedence,
      );
    return {
      text: `${operand(left)} ${this.python ? op : op === 'and' ? '&&' : '||'} ${operand(right)}`,
      precedence,
      ctype: this.python ? { bits: 1, signed: false } : INT,
    };
  }

  /** Explicit conversion: C cast, or the documented Python-like reduction helper. */
  cast(bits: number, signed: boolean, value: Printed): Printed {
    if (value.ctype?.bits === bits && value.ctype.signed === signed) return value;
    // Reinterpreting a signed word as unsigned and back is the identity; retain
    // the original typed spelling rather than stacking inverse casts.
    if (
      !this.python &&
      signed &&
      value.ctype?.bits === bits &&
      value.unreduced?.ctype?.bits === bits &&
      value.unreduced.ctype.signed
    )
      return value.unreduced;
    if (bits === 1 && !signed)
      return this.binary(
        '&',
        value,
        this.literal(1n, 1),
        this.python ? { bits: 1, signed: false } : usualArithmetic(value.ctype ?? INT, INT),
      );
    const storage = integerStorageBits(bits);
    if (!this.python && this.nativeWidths && bits !== storage && bits <= 128) {
      const narrowed = this.binary(
        '&',
        this.cast(storage, false, value),
        this.literal((1n << BigInt(bits)) - 1n, storage),
        usualArithmetic({ bits: storage, signed: false }, { bits: storage, signed: false }),
      );
      if (!signed) return narrowed;
      const sign = this.literal(1n << BigInt(bits - 1), storage);
      const flipped = this.binary('^', narrowed, sign, narrowed.ctype);
      return this.cast(
        storage,
        true,
        this.binary('-', flipped, sign, { bits: storage, signed: false }),
      );
    }
    const ctype = { bits, signed };
    const inverse =
      !this.python && !signed && value.ctype?.bits === bits && value.ctype.signed
        ? { unreduced: value }
        : {};
    if (!this.python)
      return {
        text: `(${signed ? 'int' : 'uint'}${bits}_t)${this.group(value, UNARY)}`,
        precedence: UNARY,
        ctype,
        ...inverse,
      };
    const helper = `${signed ? 'int' : 'uint'}${bits}`;
    this.writer.helper(
      helper,
      signed
        ? `Interpret the low ${bits} bits as a signed two's-complement value; unknown/undefined propagates.`
        : `Reduce to an unsigned ${bits}-bit value; unknown/undefined propagates.`,
    );
    return { ...this.primary(`${helper}(${value.text})`, ctype), ...inverse };
  }

  /** Reduce a value to exactly unsigned `bits` unless its type already is that. */
  reduce(bits: number, value: Printed): Printed {
    if (value.ctype && !value.ctype.signed && value.ctype.bits === bits) return value;
    return { ...this.cast(bits, false, value), unreduced: value };
  }

  /** Integer constant of an IR width; small counts read as decimal, masks and
   * bitwise operands (`bitwise`) as hex. */
  literal(value: bigint, bits: number, bitwise = false): Printed {
    const mask = value >= 15n && (value & (value + 1n)) === 0n;
    const text =
      value < (bitwise ? 10n : 256n) && !mask ? String(value) : `0x${value.toString(16)}`;
    if (this.python)
      return this.primary(text, { bits: Math.max(1, value.toString(2).length), signed: false });
    // C has no integer constant wider than 64 bits: compose wider values from
    // 64-bit chunks in the IR width, most significant first.
    if (value >= 1n << 64n) {
      const ctype = { bits, signed: false };
      let result: Printed | null = null;
      for (
        let shift = BigInt(Math.ceil(value.toString(2).length / 64) - 1) * 64n;
        shift >= 0n;
        shift -= 64n
      ) {
        const chunk = this.literal((value >> shift) & ((1n << 64n) - 1n), 64, true);
        if (!result) {
          result = this.cast(bits, false, chunk);
          continue;
        }
        result = this.binary('<<', result, this.literal(64n, 32), ctype);
        if (chunk.text !== '0') result = this.binary('|', result, chunk, ctype);
      }
      return result!;
    }
    // C11 6.4.4.1: decimal constants are signed; hexadecimal may be unsigned.
    const ctype: IntegerCType =
      value < 1n << 31n
        ? INT
        : value < 1n << 32n
          ? { bits: 32, signed: false }
          : value < 1n << 63n
            ? { bits: 64, signed: true }
            : { bits: Math.max(64, bits), signed: false };
    return this.primary(text, ctype);
  }

  /** Signed decimal constant for a signed comparison operand. */
  signedLiteral(value: bigint): Printed {
    const magnitude = this.literal(value < 0n ? -value : value, 64);
    if (value >= 0n) return magnitude;
    return {
      text: `-${magnitude.text}`,
      precedence: UNARY,
      ctype: this.python ? null : magnitude.ctype,
    };
  }
}

export interface ExpressionOptions {
  /** Source reconstruction: addresses print as source data references. */
  readonly source?: { readonly address: (address: Address) => Printed };
  /** `checked` keeps every machine-level reduction explicit (today's text). */
  readonly view: 'source' | 'checked';
  /** Proven constant value of an operand, when it prints as a literal. */
  readonly constant?: (value: Value) => bigint | undefined;
  readonly nativeIntegerStorage?: boolean;
  /** Approved scalar operation under the recorded FP environment requirement. */
  readonly nativeFp?: boolean;
  readonly floatLiterals?: boolean;
}

/** Reconstruction chooses substitutions; formatting preserves width semantics.
 * The source view prints C/Python arithmetic whose native semantics equal the
 * IR bit-vector operation: reductions appear only where the dialect's own
 * arithmetic would not already wrap at the operation width. */
export function expressionText(
  expression: Expression,
  type: DataType,
  writer: Writer,
  name: (value: Value) => Printed,
  options: ExpressionOptions,
): Printed {
  if (options.view === 'checked' || !options.source) {
    const source = options.source;
    return {
      text: checkedExpressionText(
        expression,
        type,
        writer,
        (value) => name(value).text,
        source && { address: (address) => source.address(address).text },
      ),
      precedence: PRIMARY,
      ctype: null,
    };
  }
  const printer = new SourcePrinter(writer, options.nativeIntegerStorage),
    python = printer.python,
    width = bitWidth(type);
  const helper = (): Printed => ({
    text: checkedExpressionText(expression, type, writer, (value) => name(value).text, {
      address: (address) => options.source!.address(address).text,
    }),
    precedence: PRIMARY,
    ctype: type.kind === 'integer' ? { bits: width, signed: false } : null,
  });
  /** An integer operand with a known type; an unknown one is first reduced
   * explicitly to its own width so every rule below starts from a typed value. */
  const operand = (value: Value): Printed => {
    const printed = name(value),
      narrow = printed.widened ?? printed;
    return narrow.ctype || value.type.kind !== 'integer'
      ? narrow
      : printer.cast(value.type.bits, false, narrow);
  };
  const range = (value: Printed, bits: number): IntegerCType =>
    value.ctype ?? { bits, signed: false };
  if (options.nativeFp) {
    if (expression.kind === 'float_compare') {
      const operators: Record<string, string> = {
        eq: '==',
        ne: '!=',
        lt: '<',
        le: '<=',
        gt: '>',
        ge: '>=',
      };
      const op = operators[expression.op];
      if (op)
        return printer.binary(op, name(expression.left), name(expression.right), {
          bits: 1,
          signed: false,
        });
      // A value is unordered with itself exactly when it is a NaN: the quiet
      // self-comparison. Otherwise C99 <math.h> isunordered (exactly 0 or 1),
      // also a documented Python-like helper.
      if (expression.left.id === expression.right.id)
        return printer.binary(
          expression.op === 'unordered' ? '!=' : '==',
          name(expression.left),
          name(expression.left),
          { bits: 1, signed: false },
        );
      writer.helper(
        'isunordered',
        'True (1) iff either IEEE operand is a NaN, otherwise 0; quiet, no exception or environment effect.',
      );
      const unordered = printer.primary(
        `isunordered(${writer.join([name(expression.left).text, name(expression.right).text])})`,
        { bits: 1, signed: false },
      );
      return expression.op === 'unordered' ? unordered : printer.not(unordered);
    }
    if (expression.kind === 'float' && (!python || (width === 64 && expression.op !== 'div'))) {
      const operators: Record<string, string> = { add: '+', sub: '-', mul: '*', div: '/' };
      const op = operators[expression.op];
      if (op) return printer.binary(op, name(expression.left), name(expression.right), null);
    }
    if (
      expression.kind === 'cast' &&
      type.kind === 'float' &&
      (!python || (width === 64 && expression.op !== 'float_convert')) &&
      (expression.op === 'float_convert' ||
        [8, 16, 32, 64, 128].includes(bitWidth(expression.value.type)))
    ) {
      const value =
        expression.op === 'signed_to_float'
          ? printer.cast(bitWidth(expression.value.type), true, name(expression.value))
          : expression.op === 'unsigned_to_float'
            ? printer.cast(bitWidth(expression.value.type), false, name(expression.value))
            : name(expression.value);
      if (python) return printer.primary(`float(${value.text})`);
      return {
        text: `(${width === 32 ? 'float' : 'double'})${printer.group(value, UNARY)}`,
        precedence: UNARY,
        ctype: null,
      };
    }
  }
  switch (expression.kind) {
    case 'constant':
      if (options.floatLiterals && type.kind === 'float' && (width === 64 || width === 32)) {
        const bytes = floatLiteralStorage;
        if (width === 32) bytes.setUint32(0, Number(BigInt.asUintN(32, expression.bits)), true);
        else bytes.setBigUint64(0, BigInt.asUintN(64, expression.bits), true);
        const value = width === 32 ? bytes.getFloat32(0, true) : bytes.getFloat64(0, true);
        if (Number.isFinite(value)) {
          let text = Object.is(value, -0) ? '-0.0' : String(value);
          if (!python && width === 32 && value !== 0)
            for (let precision = 1; precision <= 9; precision++) {
              const candidate = Number(value.toPrecision(precision));
              if (Object.is(Math.fround(candidate), value)) {
                text = String(candidate);
                break;
              }
            }
          if (!/[.eE]/.test(text)) text += '.0';
          if (!python && width === 32) text += 'f';
          return {
            text,
            precedence: value < 0 || Object.is(value, -0) ? UNARY : PRIMARY,
            ctype: null,
          };
        }
      }
      if (type.kind !== 'integer') return helper();
      return printer.literal(BigInt.asUintN(width, expression.bits), width);
    case 'address':
      return options.source.address(expression.address);
    case 'integer': {
      if (
        width === 1 &&
        type.kind === 'integer' &&
        (expression.op === 'and' || expression.op === 'or')
      ) {
        const left = operand(expression.left),
          right = operand(expression.right);
        if (!python || (!left.ctype?.signed && !right.ctype?.signed))
          return printer.logical(expression.op, left, right);
      }
      if (expression.op === 'and' || expression.op === 'or' || expression.op === 'xor') {
        const bitwise = (value: Value): Printed => {
          const constant = options.constant?.(value);
          return constant === undefined ? operand(value) : printer.literal(constant, width, true);
        };
        const left = bitwise(expression.left),
          right = bitwise(expression.right),
          l = range(left, width),
          r = range(right, width);
        // Bitwise results of non-negative operands never leave [0, 2^width).
        const ctype = python
          ? {
              bits: expression.op === 'and' ? Math.min(l.bits, r.bits) : Math.max(l.bits, r.bits),
              signed: false,
            }
          : usualArithmetic(l, r);
        return printer.binary(
          expression.op === 'and' ? '&' : expression.op === 'or' ? '|' : '^',
          left,
          right,
          ctype,
        );
      }
      if (expression.op === 'add' || expression.op === 'sub' || expression.op === 'mul') {
        const op = expression.op === 'add' ? '+' : expression.op === 'sub' ? '-' : '*';
        let left = operand(expression.left);
        const right = operand(expression.right);
        if (python) {
          const l = range(left, width).bits,
            r = range(right, width).bits;
          // Python ints are unbounded: reduce unless the exact result fits.
          const bits = op === '+' ? Math.max(l, r) + 1 : op === '*' ? l + r : Infinity;
          const result = printer.binary(op, left, right, { bits, signed: false });
          return bits <= width ? result : printer.reduce(width, result);
        }
        // Bound each operand's magnitude: a constant by its value, otherwise by
        // its type (all printed operands are non-negative bit patterns).
        const magnitude = (value: Value, printed: Printed): number => {
          const constant = options.constant?.(value);
          if (constant !== undefined) return constant.toString(2).length;
          const known = range(printed, width);
          return Math.min(width, known.signed ? known.bits - 1 : known.bits);
        };
        const lm = magnitude(expression.left, left),
          rm = magnitude(expression.right, right),
          needed = op === '*' ? lm + rm : Math.max(lm, rm) + 1;
        const fits = (type: IntegerCType): boolean =>
          needed <= (type.signed ? type.bits - 1 : type.bits);
        let common = usualArithmetic(range(left, width), range(right, width));
        // A non-negative exact result below 2^width needs no reduction at all.
        if (op !== '-' && needed <= width && fits(common))
          return printer.binary(op, left, right, common);
        if (common.bits < width) {
          left = printer.cast(width, false, left);
          common = usualArithmetic(left.ctype!, range(right, width));
        }
        // Signed arithmetic (after promotion) must not overflow: widen the left
        // operand to the unsigned type of the same rank when it could.
        if (common.signed && !fits(common)) {
          left = printer.cast(common.bits, false, left);
          common = usualArithmetic(left.ctype!, range(right, width));
        }
        return printer.reduce(width, printer.binary(op, left, right, common));
      }
      const count = options.constant?.(expression.right);
      if (
        (expression.op === 'shl' || expression.op === 'lshr' || expression.op === 'ashr') &&
        count !== undefined &&
        count < BigInt(width) &&
        type.kind === 'integer'
      ) {
        const amount = printer.literal(count, bitWidth(expression.right.type));
        let left = operand(expression.left);
        if (expression.op === 'lshr') {
          const l = range(left, width);
          return printer.binary(
            '>>',
            left,
            amount,
            python ? { bits: Math.max(1, l.bits - Number(count)), signed: false } : promote(l),
          );
        }
        if (expression.op === 'ashr')
          return printer.reduce(
            width,
            printer.binary(
              '>>',
              printer.cast(width, true, left),
              amount,
              python ? null : promote({ bits: width, signed: true }),
            ),
          );
        if (python) {
          const bits = range(left, width).bits + Number(count);
          const result = printer.binary('<<', left, amount, { bits, signed: false });
          return bits <= width ? result : printer.reduce(width, result);
        }
        let shifted = promote(range(left, width));
        if (shifted.signed ? width + Number(count) > 31 : shifted.bits < width) {
          left = printer.cast(Math.max(width, 32), false, left);
          shifted = left.ctype!;
        }
        return printer.reduce(width, printer.binary('<<', left, amount, shifted));
      }
      return helper();
    }
    case 'integer_unary': {
      if (expression.op !== 'neg' && expression.op !== 'not') return helper();
      let value = operand(expression.value);
      if (expression.op === 'not' && width === 1 && type.kind === 'integer')
        return printer.not(value);
      const symbol = expression.op === 'neg' ? '-' : '~';
      if (python)
        return printer.reduce(width, {
          text: `${symbol}${printer.group(value, UNARY)}`,
          precedence: UNARY,
          ctype: null,
        });
      let ctype = promote(range(value, width));
      if (!ctype.signed && ctype.bits < width) {
        value = printer.cast(width, false, value);
        ctype = value.ctype!;
      }
      return printer.reduce(width, {
        text: `${symbol}${printer.group(value, UNARY)}`,
        precedence: UNARY,
        ctype,
      });
    }
    case 'compare': {
      const bits = bitWidth(expression.left.type);
      const isSigned = expression.op.startsWith('s');
      const side = (value: Value): Printed => {
        const constant = options.constant?.(value);
        if (isSigned) {
          const signed = constant === undefined ? undefined : BigInt.asIntN(bits, constant);
          return signed !== undefined && signed >= -(1n << 31n) && signed < 1n << 31n
            ? printer.signedLiteral(signed)
            : printer.cast(bits, true, operand(value));
        }
        return operand(value);
      };
      // Every unsigned-compare operand is its non-negative bit pattern, so any
      // common C type compares the same values.
      const left = side(expression.left),
        right = side(expression.right);
      return printer.binary(
        comparisonOperators[expression.op],
        left,
        right,
        python ? { bits: 1, signed: false } : INT,
      );
    }
    case 'cast': {
      if (expression.op === 'bitcast' && sameType(type, expression.value.type))
        return name(expression.value);
      if (type.kind !== 'integer' || expression.value.type.kind !== 'integer') return helper();
      const value = operand(expression.value),
        bits = expression.value.type.bits;
      // Zero extension never changes the value: keep the widening spelled for
      // non-converting contexts, offer the narrow operand to all others.
      if (expression.op === 'zero_extend') {
        const narrow = value.widened ?? value;
        return python ? narrow : { ...printer.cast(width, false, narrow), widened: narrow };
      }
      if (expression.op === 'truncate') {
        const known = range(value, bits);
        return !known.signed && known.bits <= width ? value : printer.cast(width, false, value);
      }
      if (expression.op === 'sign_extend')
        return printer.cast(width, false, printer.cast(bits, true, value));
      return helper();
    }
    case 'extract': {
      if (expression.value.type.kind !== 'integer' || type.kind !== 'integer') return helper();
      const source = expression.value.type.bits;
      let value = operand(expression.value);
      if (!expression.offset && value.ctype && !value.ctype.signed && value.ctype.bits <= width)
        return value;
      // A narrowed printed zero-extension still needs a wide C shift operand
      // when extracting high bits; shifting a uint32_t by 32 is undefined.
      if (!python && expression.offset >= promote(range(value, source)).bits)
        value = printer.cast(source, false, value);
      if (expression.offset)
        value = printer.binary(
          '>>',
          value,
          printer.literal(BigInt(expression.offset), 32),
          python
            ? { bits: Math.max(1, range(value, source).bits - expression.offset), signed: false }
            : promote(range(value, source)),
        );
      // The top slice of a value already lies within the result width.
      return expression.offset + width >= source && !range(value, source).signed
        ? python
          ? { ...value, ctype: { bits: width, signed: false } }
          : value
        : printer.cast(width, false, value);
    }
    case 'concat': {
      if (
        type.kind !== 'integer' ||
        !expression.values.every((value) => value.type.kind === 'integer')
      )
        return helper();
      let offset = 0,
        result: Printed | null = null;
      for (const value of expression.values) {
        writer.context.checkpoint(1);
        let part = operand(value);
        if (offset) {
          // Shift within the full result width; each part is below 2^its width.
          if (!python && (part.ctype!.signed || part.ctype!.bits < width))
            part = printer.cast(width, false, part);
          part = printer.binary(
            '<<',
            part,
            printer.literal(BigInt(offset), 32),
            python ? { bits: width, signed: false } : promote(part.ctype!),
          );
        }
        result = result
          ? printer.binary(
              '|',
              result,
              part,
              python ? { bits: width, signed: false } : usualArithmetic(result.ctype!, part.ctype!),
            )
          : part;
        offset += bitWidth(value.type);
      }
      return result!;
    }
    case 'select': {
      const condition = operand(expression.condition),
        yes = operand(expression.when_true),
        no = operand(expression.when_false);
      const ctype =
        yes.ctype && no.ctype
          ? python
            ? {
                bits: Math.max(yes.ctype.bits, no.ctype.bits),
                signed: yes.ctype.signed || no.ctype.signed,
              }
            : usualArithmetic(yes.ctype, no.ctype)
          : null;
      return {
        text: python
          ? `${printer.group(yes, CONDITIONAL + 1)} if ${printer.group(condition, CONDITIONAL + 1)} else ${printer.group(no, CONDITIONAL)}`
          : `${printer.group(condition, CONDITIONAL + 1)} ? ${printer.group(yes, CONDITIONAL + 1)} : ${printer.group(no, CONDITIONAL)}`,
        precedence: CONDITIONAL,
        ctype,
      };
    }
    default:
      return helper();
  }
}

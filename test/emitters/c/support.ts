import assert from 'node:assert/strict';
import { createOperationContext, DEFAULT_ANALYSIS_OPTIONS } from '../../../src/core/index.js';
import type { SSAForm } from '../../../src/ir/index.js';
import { structureControlFlow } from '../../../src/presentation/index.js';
import { emitC } from '../../../src/emitters/c/index.js';
import { emitPythonLike } from '../../../src/emitters/python-like/index.js';
import type { EmissionInput, EmissionResult } from '../../../src/emitters/model.js';

export function emit(input: SSAForm, extra: Omit<EmissionInput, 'function'> = {}, language: 'c-like' | 'python-like' = 'c-like'): EmissionResult {
  const structured = structureControlFlow(input, createOperationContext());
  assert.ok(structured.value);
  return (language === 'python-like' ? emitPythonLike : emitC)({ function: structured.value, ...extra }, { ...DEFAULT_ANALYSIS_OPTIONS, emitter: language }, createOperationContext());
}

type Data = bigint | string | boolean | null | Data[] | { readonly [key: string]: Data };
type Expr = { kind: 'literal'; value: Data } | { kind: 'ref'; name: string }
  | { kind: 'call'; name: string; args: Expr[] } | { kind: 'list'; values: Expr[] }
  | { kind: 'binary'; op: string; left: Expr; right: Expr } | { kind: 'select'; condition: Expr; yes: Expr; no: Expr };
type Op = { kind: 'assign'; names: string[]; expression: Expr | null; tuple: boolean }
  | { kind: 'jump'; target: string | number } | { kind: 'test'; condition: Expr; target: number }
  | { kind: 'return'; expression: Expr };

/** Small test-only parser for the emitted machine-expression/control grammar.
 * It consumes the OUTPUT, not IR or mappings, and never evals target text. Helper
 * semantics below are independent arithmetic/byte-array observations, not imports
 * from the production IR interpreter. Separate C and indentation-sensitive Python
 * statement parsers share only this expression grammar and independent oracle. */
class Parser {
  readonly tokens: string[] = [];
  readonly ops: Op[] = [];
  readonly labels = new Map<string, number>();
  private position = 0;
  private switchId = 0;
  constructor(text: string) {
    if (/^def /m.test(text)) {
      const lines = text.split('\n'), header = lines.findIndex(line => line.startsWith('def '));
      const indents = [0];
      const token = /[ \t]+|#[^\n]*|"(?:\\.|[^"\\])*"|0x[0-9a-fA-F]+|[0-9]+|[A-Za-z_][A-Za-z_0-9]*|==|!=|<=|>=|[()[\],:=<>]/gy;
      for (const line of lines.slice(header + 1)) {
        if (/^\s*(?:#|$)/.test(line)) continue;
        const indent = line.length - line.trimStart().length;
        assert.ok(indent > 0, 'Unexpected top-level Python pseudocode');
        if (indent > indents.at(-1)!) { indents.push(indent); this.tokens.push('INDENT'); }
        else while (indent < indents.at(-1)!) { indents.pop(); this.tokens.push('DEDENT'); }
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
      while (indents.length > 1) { indents.pop(); this.tokens.push('DEDENT'); }
      this.pythonBlock();
      assert.equal(this.position, this.tokens.length);
      return;
    }
    const token = /\s+|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|0x[0-9a-fA-F]+|[0-9]+|[A-Za-z_][A-Za-z_0-9]*|==|!=|<=|>=|[{}()[\],;:=?<>@]/gy;
    let offset = 0;
    while (offset < text.length) {
      token.lastIndex = offset;
      const match = token.exec(text);
      assert.ok(match, `Unrecognized emitted token near ${text.slice(offset, offset + 80)}`);
      offset = token.lastIndex;
      if (!/^\s|^\/\*/.test(match[0])) this.tokens.push(match[0]);
    }
    const start = this.tokens.indexOf('machine_exit');
    assert.ok(start >= 0);
    this.position = start + 1;
    while (this.peek() !== '{') this.position++;
    this.block([]);
  }
  private peek(): string { return this.tokens[this.position] ?? ''; }
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
  private pythonStatement(): void {
    const token = this.take();
    if (token === 'label') { this.labels.set(this.take(), this.ops.length); this.take(':'); this.take('\n'); return; }
    if (token === 'goto') { this.ops.push({ kind: 'jump', target: this.take() }); this.take('\n'); return; }
    if (token === 'return') { this.ops.push({ kind: 'return', expression: this.expression() }); this.take('\n'); return; }
    if (token === 'if') {
      const condition = this.expression(); this.take(':'); this.take('\n');
      const test: Op & { kind: 'test' } = { kind: 'test', condition, target: -1 }; this.ops.push(test);
      this.pythonBlock();
      const end: Op & { kind: 'jump' } = { kind: 'jump', target: -1 }; this.ops.push(end);
      test.target = this.ops.length;
      this.take('else'); this.take(':'); this.take('\n'); this.pythonBlock();
      end.target = this.ops.length; return;
    }
    if (token === 'while') {
      const start = this.ops.length, condition = this.expression(); this.take(':'); this.take('\n');
      const test: Op & { kind: 'test' } = { kind: 'test', condition, target: -1 }; this.ops.push(test);
      this.pythonBlock(); this.ops.push({ kind: 'jump', target: start });
      test.target = this.ops.length; return;
    }
    if (token === 'match') {
      const expression = this.expression(), name = `$match${this.switchId++}`;
      this.take(':'); this.take('\n'); this.take('INDENT');
      this.ops.push({ kind: 'assign', names: [name], expression, tuple: false });
      // An unknown selector must never select the default, including zero cases.
      this.ops.push({ kind: 'test', condition: { kind: 'binary', op: '==', left: { kind: 'ref', name }, right: { kind: 'ref', name } }, target: this.ops.length + 1 });
      const dispatch: Op & { kind: 'jump' } = { kind: 'jump', target: -1 }; this.ops.push(dispatch);
      const cases: { value: Expr; start: number }[] = [], ends: (Op & { kind: 'jump' })[] = [];
      let otherwise = -1;
      while (this.peek() !== 'DEDENT') {
        this.take('case');
        if (this.peek() === '_') { this.take('_'); otherwise = this.ops.length; }
        else cases.push({ value: this.expression(), start: this.ops.length });
        this.take(':'); this.take('\n'); this.pythonBlock();
        const end: Op & { kind: 'jump' } = { kind: 'jump', target: -1 }; ends.push(end); this.ops.push(end);
      }
      this.take('DEDENT'); dispatch.target = this.ops.length;
      for (const item of cases) {
        this.ops.push({ kind: 'test', condition: { kind: 'binary', op: '==', left: { kind: 'ref', name }, right: item.value }, target: this.ops.length + 2 });
        this.ops.push({ kind: 'jump', target: item.start });
      }
      assert.ok(otherwise >= 0); this.ops.push({ kind: 'jump', target: otherwise });
      for (const end of ends) end.target = this.ops.length;
      return;
    }
    const tuple = token === '(', names = tuple ? [] : [token];
    if (tuple) {
      while (this.peek() !== ')') { names.push(this.take()); if (this.peek() !== ')') this.take(','); }
      this.take(')');
    }
    if (this.peek() === ':') { this.take(':'); assert.match(this.take(), /^(?:bits\d+_t|ieee\d+_t|vector_[if]\d+x\d+_t|effect_t)$/); }
    const expression = this.peek() === '=' ? (this.take('='), this.expression()) : null;
    this.take('\n'); this.ops.push({ kind: 'assign', names, expression, tuple });
  }
  private statement(breaks: number[]): void {
    const token = this.take();
    if (token === ';') return;
    if (this.peek() === ':') { this.take(':'); this.labels.set(token, this.ops.length); this.take(';'); return; }
    if (token === 'goto') { this.ops.push({ kind: 'jump', target: this.take() }); this.take(';'); return; }
    if (token === 'return') { this.ops.push({ kind: 'return', expression: this.expression() }); this.take(';'); return; }
    if (token === 'break') { breaks.push(this.ops.length); this.ops.push({ kind: 'jump', target: -1 }); this.take(';'); return; }
    if (token === 'if') {
      this.take('('); const condition = this.expression(); this.take(')');
      const test: Op & { kind: 'test' } = { kind: 'test', condition, target: -1 }; this.ops.push(test);
      this.block(breaks);
      const end: Op & { kind: 'jump' } = { kind: 'jump', target: -1 }; this.ops.push(end);
      test.target = this.ops.length;
      this.take('else'); this.block(breaks); end.target = this.ops.length; return;
    }
    if (token === 'while') {
      const start = this.ops.length;
      this.take('('); const condition = this.expression(); this.take(')');
      const test: Op & { kind: 'test' } = { kind: 'test', condition, target: -1 }; this.ops.push(test);
      const exits: number[] = []; this.block(exits); this.ops.push({ kind: 'jump', target: start });
      test.target = this.ops.length;
      for (const index of exits) { const op = this.ops[index]!; assert.equal(op.kind, 'jump'); if (op.kind === 'jump') op.target = this.ops.length; }
      return;
    }
    if (token === 'switch') {
      this.take('('); const expression = this.expression(); this.take(')');
      const name = `$switch${this.switchId++}`;
      this.ops.push({ kind: 'assign', names: [name], expression, tuple: false });
      const dispatch: Op & { kind: 'jump' } = { kind: 'jump', target: -1 }; this.ops.push(dispatch);
      this.take('{');
      const cases: { value: Expr; start: number }[] = [], exits: number[] = [];
      let otherwise = -1;
      while (this.peek() !== '}') {
        const kind = this.take();
        if (kind === 'case') { const value = this.expression(); this.take(':'); cases.push({ value, start: this.ops.length }); }
        else { assert.equal(kind, 'default'); this.take(':'); otherwise = this.ops.length; }
        this.block(exits);
      }
      this.take('}');
      dispatch.target = this.ops.length;
      for (const item of cases) {
        this.ops.push({ kind: 'test', condition: { kind: 'binary', op: '==', left: { kind: 'ref', name }, right: item.value }, target: this.ops.length + 2 });
        this.ops.push({ kind: 'jump', target: item.start });
      }
      assert.ok(otherwise >= 0); this.ops.push({ kind: 'jump', target: otherwise });
      for (const index of exits) { const op = this.ops[index]!; if (op.kind === 'jump') op.target = this.ops.length; }
      return;
    }
    let names: string[];
    if (token === '(') {
      names = [this.take()]; while (this.peek() === ',') { this.take(','); names.push(this.take()); } this.take(')');
    } else if (/^(?:bits\d+_t|ieee\d+_t|vector_[if]\d+x\d+_t|effect_t)$/.test(token)) names = [this.take()];
    else names = [token];
    const expression = this.peek() === '=' ? (this.take('='), this.expression()) : null;
    this.take(';'); this.ops.push({ kind: 'assign', names, expression, tuple: token === '(' });
  }
  private expression(): Expr {
    let left = this.atom();
    if (['==', '!=', '<', '<=', '>', '>='].includes(this.peek())) left = { kind: 'binary', op: this.take(), left, right: this.atom() };
    if (this.peek() === '?') { this.take('?'); const yes = this.expression(); this.take(':'); left = { kind: 'select', condition: left, yes, no: this.expression() }; }
    if (this.peek() === 'if') {
      this.take('if'); const condition = this.expression(); this.take('else');
      left = { kind: 'select', condition, yes: left, no: this.expression() };
    }
    return left;
  }
  private atom(): Expr {
    const token = this.take();
    if (token === '(') { const expression = this.expression(); this.take(')'); return expression; }
    if (token === '{' || token === '[') {
      const close = token === '{' ? '}' : ']', values: Expr[] = [];
      if (this.peek() !== close) { values.push(this.expression()); while (this.peek() === ',') { this.take(','); values.push(this.expression()); } }
      this.take(close); return { kind: 'list', values };
    }
    if (token.startsWith('"')) return { kind: 'literal', value: JSON.parse(token) as string };
    if (/^\d/.test(token)) return { kind: 'literal', value: BigInt(token) };
    if (token === 'true' || token === 'false' || token === 'True' || token === 'False') return { kind: 'literal', value: token === 'true' || token === 'True' };
    if (this.peek() === '(') {
      this.take('('); const args: Expr[] = [];
      if (this.peek() !== ')') { args.push(this.expression()); while (this.peek() === ',') { this.take(','); args.push(this.expression()); } }
      this.take(')'); return { kind: 'call', name: token, args };
    }
    return { kind: 'ref', name: token };
  }
}

export interface Observation {
  readonly exit: string;
  readonly values: readonly bigint[];
  readonly registers: ReadonlyMap<string, { readonly bits: bigint; readonly known: bigint }>;
  readonly memory: ReadonlyMap<bigint, number>;
  readonly events: readonly string[];
  readonly calls: readonly { readonly target: bigint; readonly arguments: readonly bigint[] }[];
}
export function execute(text: string, inputs: ReadonlyMap<string, bigint> = new Map(), memory: Map<bigint, number> = new Map(), callDelta = 0n): Observation {
  const parser = new Parser(text), environment = new Map<string, Data>([['incoming', null]]), events: string[] = [];
  const calls: { target: bigint; arguments: bigint[] }[] = [];
  let nextEffect = 0n;
  const number = (value: Data | undefined): bigint => { assert.equal(typeof value, 'bigint'); return value as bigint; };
  const array = (value: Data | undefined): Data[] => { assert.ok(Array.isArray(value)); return value; };
  const string = (value: Data | undefined): string => { assert.equal(typeof value, 'string'); return value as string; };
  const width = (type: Data | undefined): number => {
    const match = /^(?:bits|ieee)(\d+)_t$|^vector_[if](\d+)x(\d+)_t$/.exec(string(type)); assert.ok(match);
    return match[1] ? Number(match[1]) : Number(match[2]) * Number(match[3]);
  };
  const object = (value: Data | undefined): { readonly [key: string]: Data } => { assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value)); return value; };
  const physical = (state: Data | undefined): Observation['registers'] => {
    const roots = new Map<string, { bits: bigint; known: bigint }>();
    for (const item of array(state)) {
      const binding = array(item), descriptor = array(binding[0]), root = string(descriptor[1]), offset = number(descriptor[2]), bits = number(descriptor[3]);
      const mask = ((1n << bits) - 1n) << offset, previous = roots.get(root) ?? { bits: 0n, known: 0n };
      roots.set(root, binding[1] === null
        ? { bits: previous.bits & ~mask, known: previous.known & ~mask }
        : { bits: (previous.bits & ~mask) | (number(binding[1]) << offset & mask), known: previous.known | mask });
    }
    return roots;
  };
  const scratch = new DataView(new ArrayBuffer(8));
  const decodeFloat = (bits: bigint, n: number): number => {
    if (n === 32) { scratch.setUint32(0, Number(bits), true); return scratch.getFloat32(0, true); }
    scratch.setBigUint64(0, bits, true); return scratch.getFloat64(0, true);
  };
  const encodeFloat = (value: number, n: number): bigint => {
    if (Number.isNaN(value)) return n === 32 ? 0x7fc00000n : 0x7ff8000000000000n;
    if (n === 32) { scratch.setFloat32(0, value, true); return BigInt(scratch.getUint32(0, true)); }
    scratch.setFloat64(0, value, true); return scratch.getBigUint64(0, true);
  };
  const helper = (name: string, args: Data[]): Data => {
    if (/^(?:bv_|fp_|cast_|flag_|vector_|extract_bits$|insert_bits$|concat_low_first$|signed_value$)/.test(name) && args.includes(null)) return null;
    if (name === 'bit_pattern') return BigInt.asUintN(Number(number(args[1])), number(args[2]));
    if (name === 'entry_value') { const id = string(args[1]); assert.ok(inputs.has(id), `Missing explicit input ${id}`); return inputs.get(id)!; }
    if (name === 'entry_effect') return 0n;
    if (name === 'image_address') return number(args[2]);
    if (name === 'register_slice' || name === 'binding' || name === 'register_state' || name === 'explicit_values' || name === 'clobbers') return args;
    if (name === 'signed_value') return BigInt.asIntN(Number(number(args[0])), number(args[1]));
    if (name.startsWith('bv_')) {
      const n = Number(number(args[0])), a = number(args[1]), b = args[2] === undefined ? 0n : number(args[2]);
      let result: bigint;
      switch (name.slice(3)) {
        case 'add': result = a + b; break; case 'sub': result = a - b; break; case 'mul': result = a * b; break;
        case 'and': result = a & b; break; case 'or': result = a | b; break; case 'xor': result = a ^ b; break;
        case 'not': result = ~a; break; case 'neg': result = -a; break;
        case 'clz': result = BigInt(n - (a === 0n ? 0 : a.toString(2).length)); break;
        case 'ctz': { let zeros = 0; while (zeros < n && (a >> BigInt(zeros) & 1n) === 0n) zeros++; result = BigInt(zeros); break; }
        case 'popcount': result = BigInt([...a.toString(2)].filter(bit => bit === '1').length); break;
        case 'shl': result = b >= n ? 0n : a << b; break; case 'lshr': result = b >= n ? 0n : a >> b; break;
        case 'ashr': result = b >= n ? BigInt.asIntN(n, a) < 0n ? -1n : 0n : BigInt.asIntN(n, a) >> b; break;
        case 'rol': result = a << (b % BigInt(n)) | a >> (BigInt(n) - b % BigInt(n)); break;
        case 'ror': result = a >> (b % BigInt(n)) | a << (BigInt(n) - b % BigInt(n)); break;
        case 'udiv': if (b === 0n) return null; result = a / b; break; case 'urem': if (b === 0n) return null; result = a % b; break;
        case 'sdiv': case 'srem': {
          const left = BigInt.asIntN(n, a), right = BigInt.asIntN(n, b);
          if (right === 0n || left === -(1n << BigInt(n - 1)) && right === -1n) return null;
          result = name === 'bv_sdiv' ? left / right : left % right; break;
        }
        default: throw new Error(`Unimplemented oracle integer helper ${name}`);
      }
      return BigInt.asUintN(n, result);
    }
    if (name === 'extract_bits') return BigInt.asUintN(Number(number(args[0])), number(args[1]) >> number(args[2]));
    if (name === 'insert_bits') { const mask = ((1n << number(args[2])) - 1n) << number(args[4]); return BigInt.asUintN(Number(number(args[0])), number(args[1]) & ~mask | number(args[3]) << number(args[4])); }
    if (name === 'concat_low_first') { let result = 0n, offset = 0n; for (let i = 1; i < args.length; i += 2) { result |= number(args[i + 1]) << offset; offset += number(args[i]); } return result; }
    if (name.startsWith('cast_')) {
      const n = width(args[0]), source = width(args[1]), value = number(args[2]);
      if (name === 'cast_sign_extend') return BigInt.asUintN(n, BigInt.asIntN(source, value));
      if (name === 'cast_bitcast' || name === 'cast_truncate' || name === 'cast_zero_extend') return BigInt.asUintN(n, value);
      if (name === 'cast_unsigned_to_float' || name === 'cast_signed_to_float') return encodeFloat(Number(name === 'cast_signed_to_float' ? BigInt.asIntN(source, value) : value), n);
      if (name === 'cast_float_convert') return encodeFloat(decodeFloat(value, source), n);
      if (name === 'cast_float_to_unsigned' || name === 'cast_float_to_signed') {
        const decoded = decodeFloat(value, source);
        if (!Number.isFinite(decoded)) return null;
        const integer = BigInt(Math.trunc(decoded)), signed = name === 'cast_float_to_signed';
        if (integer < (signed ? -(1n << BigInt(n - 1)) : 0n) || integer >= 1n << BigInt(n - Number(signed))) return null;
        return BigInt.asUintN(n, integer);
      }
      throw new Error(`Unimplemented oracle conversion ${name}`);
    }
    if (name === 'fp_neg') return number(args[1]) ^ (1n << (number(args[0]) - 1n));
    if (name === 'fp_abs') return number(args[1]) & ((1n << (number(args[0]) - 1n)) - 1n);
    if (name.startsWith('fp_')) {
      const n = Number(number(args[0])), a = decodeFloat(number(args[1]), n), b = args[2] === undefined ? 0 : decodeFloat(number(args[2]), n);
      switch (name) {
        case 'fp_add': return encodeFloat(a + b, n); case 'fp_sub': return encodeFloat(a - b, n);
        case 'fp_mul': return encodeFloat(a * b, n); case 'fp_div': return encodeFloat(a / b, n); case 'fp_sqrt': return encodeFloat(Math.sqrt(a), n);
        case 'fp_eq': return BigInt(a === b); case 'fp_ne': return BigInt(a !== b);
        case 'fp_lt': return BigInt(a < b); case 'fp_le': return BigInt(a <= b); case 'fp_gt': return BigInt(a > b); case 'fp_ge': return BigInt(a >= b);
        case 'fp_ordered': return BigInt(!Number.isNaN(a) && !Number.isNaN(b)); case 'fp_unordered': return BigInt(Number.isNaN(a) || Number.isNaN(b));
      }
    }
    if (name.startsWith('flag_')) {
      const n = Number(number(args[0])), a = number(args[1]), b = number(args[2]), carry = number(args[3]), addition = name.startsWith('flag_add_');
      const full = addition ? a + b + carry : a - b - carry, wrapped = BigInt.asUintN(n, full), signed = addition ? BigInt.asIntN(n, a) + BigInt.asIntN(n, b) + carry : BigInt.asIntN(n, a) - BigInt.asIntN(n, b) - carry;
      const flag = name.split('_')[2];
      return BigInt(flag === 'carry' ? addition ? full >= 1n << BigInt(n) : full >= 0n : flag === 'borrow' ? full < 0n : flag === 'overflow' ? signed !== BigInt.asIntN(n, wrapped) : flag === 'zero' ? wrapped === 0n : flag === 'negative' ? BigInt.asIntN(n, wrapped) < 0n : [...(wrapped & 255n).toString(2)].filter(bit => bit === '1').length % 2 === 0);
    }
    if (name.startsWith('vector_bv_') || name.startsWith('vector_fp_')) {
      const match = /^vector_[if](\d+)x(\d+)_t$/.exec(string(args[0])); assert.ok(match);
      const n = Number(match[1]), lanes = Number(match[2]); let result = 0n;
      for (let lane = 0; lane < lanes; lane++) {
        const shift = BigInt(lane * n), left = BigInt.asUintN(n, number(args[1]) >> shift), right = BigInt.asUintN(n, number(args[2]) >> shift);
        result |= number(helper(name.slice(7), [BigInt(n), left, right])) << shift;
      }
      return result;
    }
    if (name === 'vector_lanes') { const match = /^vector_[if](\d+)x\d+_t$/.exec(string(args[0])); assert.ok(match); let result = 0n; for (let i = 1; i < args.length; i++) result |= number(args[i]) << BigInt((i - 1) * Number(match[1])); return result; }
    if (name === 'vector_lane') return BigInt.asUintN(width(args[0]), number(args[1]) >> (number(args[2]) * BigInt(width(args[0]))));
    if (name === 'vector_insert') { const match = /^vector_[if](\d+)x\d+_t$/.exec(string(args[0])); assert.ok(match); const n = BigInt(match[1]!), offset = n * number(args[2]), mask = ((1n << n) - 1n) << offset; return number(args[1]) & ~mask | number(args[3]) << offset; }
    if (name === 'memory_store' || name === 'memory_load') {
      const store = name === 'memory_store', address = number(args[1]), count = width(args[2]) / 8, endian = string(args[store ? 4 : 3]);
      assert.equal(number(args[0]), nextEffect, 'Effect order changed');
      events.push(store ? 'store' : 'load');
      if (address % number(args[store ? 5 : 4]) !== 0n) throw new Boundary('fault', []);
      for (let i = 0; i < count; i++) if (!memory.has(address + BigInt(i))) throw new Boundary('fault', []);
      let value = 0n;
      for (let i = 0; i < count; i++) {
        const shift = BigInt((endian === 'little' ? i : count - 1 - i) * 8), cell = address + BigInt(i);
        if (store) memory.set(cell, Number(number(args[3]) >> shift & 255n)); else value |= BigInt(memory.get(cell)!) << shift;
      }
      nextEffect++; return store ? nextEffect : [nextEffect, value];
    }
    if (name === 'machine_call') {
      assert.equal(number(args[0]), nextEffect); events.push('call'); nextEffect++;
      calls.push({ target: number(args[1]), arguments: array(args[2]).map(number) });
      const before = physical(args[3]), results = array(args[5]).map(() => callDelta), outputs = array(args[6]).map(item => {
        const descriptor = array(item), root = string(descriptor[1]), offset = number(descriptor[2]), n = Number(number(descriptor[3]));
        const value = before.get(root), required = (1n << (offset + BigInt(n))) - 1n;
        if (value === undefined || (value.known & required) !== required) return null;
        return BigInt.asUintN(n, (value.bits + callDelta) >> offset);
      });
      return [nextEffect, ...results, ...outputs];
    }
    if (name === 'unknown_effect') { events.push('unknown'); throw new Boundary('unknown', []); }
    if (name === 'unknown_value' || name === 'undefined_value') return null;
    if (name === 'machine_return' || name.endsWith('_exit')) return { exit: name, values: name === 'machine_return' ? array(args[1]) : [], state: args.at(-1)! };
    throw new Error(`Oracle does not support helper ${name}`);
  };
  const evaluate = (expression: Expr): Data => {
    switch (expression.kind) {
      case 'literal': return expression.value;
      case 'ref': assert.ok(environment.has(expression.name), `Undeclared/uninitialized emitted value ${expression.name}`); return environment.get(expression.name)!;
      case 'list': return expression.values.map(evaluate);
      case 'call': return helper(expression.name, expression.args.map(evaluate));
      case 'select': { const condition = evaluate(expression.condition); if (condition === null) return null; return evaluate(condition === 0n || condition === false ? expression.no : expression.yes); }
      case 'binary': {
        const a = evaluate(expression.left), b = evaluate(expression.right); if (a === null || b === null) return null;
        const left = number(a), right = number(b);
        const result = expression.op === '==' ? left === right : expression.op === '!=' ? left !== right : expression.op === '<' ? left < right : expression.op === '<=' ? left <= right : expression.op === '>' ? left > right : left >= right;
        return result ? 1n : 0n;
      }
    }
  };
  try {
    let pc = 0;
    for (let steps = 0; steps < 20000; steps++) {
      const op = parser.ops[pc++]; assert.ok(op, 'Emitted control fell out of function');
      switch (op.kind) {
        case 'assign': if (op.expression) { const value = evaluate(op.expression), values = op.tuple ? array(value) : [value]; assert.equal(values.length, op.names.length); op.names.forEach((name, index) => environment.set(name, values[index]!)); } break;
        case 'jump': { const target = typeof op.target === 'number' ? op.target : parser.labels.get(op.target); assert.ok(target !== undefined && target >= 0, 'Missing emitted label'); pc = target; break; }
        case 'test': { const value = evaluate(op.condition); if (value === null) throw new Boundary('unknown', []); if (value === false || value === 0n) pc = op.target; break; }
        case 'return': { const result = object(evaluate(op.expression)); return { exit: string(result['exit']), values: array(result['values']).map(number), registers: physical(result['state']), memory, events, calls }; }
      }
    }
    throw new Error('Emitted program exceeded oracle step bound');
  } catch (error) {
    if (error instanceof Boundary) return { exit: error.exit, values: error.values, registers: new Map(), memory, events, calls };
    throw error;
  }
}
class Boundary extends Error {
  constructor(readonly exit: string, readonly values: readonly bigint[]) { super(exit); }
}

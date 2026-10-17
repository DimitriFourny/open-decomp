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
): EmissionResult {
  const structured = structureControlFlow(input, createOperationContext());
  assert.ok(structured.value);
  return (language === 'python-like' ? emitPythonLike : emitC)(
    { function: structured.value, ...extra },
    { ...DEFAULT_ANALYSIS_OPTIONS, emitter: language },
    createOperationContext(),
  );
}

type Data = bigint | string | boolean | null | Data[] | { readonly [key: string]: Data };
type Expr =
  | { kind: 'literal'; value: Data }
  | { kind: 'ref'; name: string }
  | { kind: 'call'; name: string; args: Expr[] }
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

interface EmittedText {
  readonly text: string;
  readonly mappings: readonly {
    readonly start: number;
    readonly end: number;
    readonly statement_id: string;
    readonly semantic_ids: readonly string[];
  }[];
}
export interface EmittedFormal {
  readonly name: string;
  readonly statement_id: string;
  readonly semantic_ids: readonly string[];
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
  private position = 0;
  private switchId = 0;
  private readonly loops: { start: number; breaks: number[] }[] = [];
  constructor(text: string) {
    if (/^def /m.test(text)) {
      const lines = text.split('\n'),
        header = lines.findIndex((line) => line.startsWith('def '));
      const endHeader = lines.findIndex(
        (line, index) => index >= header && /\):$|\) -> .*:$/.test(line),
      );
      assert.ok(endHeader >= header);
      this.headerEnd = lines.slice(0, endHeader + 1).reduce((length, line) => length + line.length + 1, 0);
      const indents = [0];
      const token =
        /[ \t]+|#[^\n]*|"(?:\\.|[^"\\])*"|0x[0-9a-fA-F]+|[0-9]+|[A-Za-z_][A-Za-z_0-9]*|==|!=|<=|>=|<<|>>|[.()[\],:=?<>+*/%&|^~!-]/gy;
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
      /\s+|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|0x[0-9a-fA-F]+|[0-9]+|[A-Za-z_][A-Za-z_0-9]*|==|!=|<=|>=|<<|>>|[{}()[\],;:=?<>@+*/%&|^~!-]/gy;
    let offset = 0, headerEnd = -1;
    while (offset < text.length) {
      token.lastIndex = offset;
      const match = token.exec(text);
      assert.ok(match, `Unrecognized emitted token near ${text.slice(offset, offset + 80)}`);
      offset = token.lastIndex;
      if (!/^\s|^\/\*/.test(match[0])) {
        if (match[0] === '{' && headerEnd < 0) headerEnd = match.index;
        this.tokens.push(match[0]);
      }
    }
    const start = this.tokens.indexOf('{');
    assert.ok(start >= 0);
    this.headerEnd = headerEnd;
    this.position = start;
    this.block([]);
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
        } else cases.push({ value: this.expression(), start: this.ops.length });
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
      assert.ok(otherwise >= 0);
      this.ops.push({ kind: 'jump', target: otherwise });
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
      assert.match(
        this.take(),
        /^(?:bits\d+_t|u?int\d+_t|bool|ieee\d+_t|vector_[if]\d+x\d+_t|effect_t)$/,
      );
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
        kind: 'assign', names: [name], tuple: false,
        expression: { kind: 'call', name: 'stack_storage', args: [size, alignment] },
      });
      return;
    }
    if (token === '(' && this.peek() === '*') {
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
        this.block(exits);
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
      assert.ok(otherwise >= 0);
      this.ops.push({ kind: 'jump', target: otherwise });
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
    } else if (
      /^(?:bits\d+_t|u?int\d+_t|bool|ieee\d+_t|vector_[if]\d+x\d+_t|effect_t)$/.test(token)
    )
      names = [this.take()];
    else names = [token];
    const expression = this.peek() === '=' ? (this.take('='), this.expression()) : null;
    this.take(';');
    this.ops.push({ kind: 'assign', names, expression, tuple: token === '(' });
  }

  private memoryStatement(end: string): void {
    const memory = this.expression();
    assert.ok(memory.kind === 'call' && memory.name === 'read_memory');
    if (this.peek() === '=') {
      this.take('=');
      const value = this.expression();
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

  private expression(minimum = 0): Expr {
    let left = this.atom();
    const precedence: Record<string, number> = {
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
    const token = this.take();
    if (token === '&') {
      const name = this.take();
      this.take('[');
      const offset = this.expression();
      this.take(']');
      return { kind: 'call', name: 'address_of', args: [{ kind: 'ref', name }, offset] };
    }
    if (token === '*') {
      const pointer = this.atom();
      assert.ok(pointer.kind === 'call' && pointer.name === '__pointer');
      return { kind: 'call', name: 'read_memory', args: pointer.args };
    }
    if (token === 'memory' && this.peek() === '.') {
      this.take('.');
      const view = this.take(),
        match = /^(volatile_)?(be_)?u(\d+)$/.exec(view);
      assert.ok(match);
      this.take('[');
      const address = this.expression();
      this.take(']');
      return {
        kind: 'call',
        name: 'read_memory',
        args: [
          address,
          { kind: 'literal', value: `bits${match[3]}_t` },
          { kind: 'literal', value: match[2] ? 'big' : 'little' },
          { kind: 'literal', value: 1n },
          { kind: 'literal', value: !!match[1] },
        ],
      };
    }
    if (['-', '~', '!'].includes(token)) return { kind: 'unary', op: token, value: this.atom() };
    if (token === '(') {
      if (
        this.peek() === 'volatile' ||
        (/^(?:unaligned_)?u?int\d+_t$/.test(this.peek()) && this.tokens[this.position + 1] === '*')
      ) {
        const volatile = this.peek() === 'volatile' ? (this.take(), true) : false;
        const type = this.take(),
          match = /^(unaligned_)?u?int(\d+)_t$/.exec(type);
        assert.ok(match);
        this.take('*');
        this.take(')');
        return {
          kind: 'call',
          name: '__pointer',
          args: [
            this.atom(),
            { kind: 'literal', value: `bits${match[2]}_t` },
            { kind: 'literal', value: 'little' },
            { kind: 'literal', value: match[1] ? 1n : BigInt(Number(match[2]) / 8) },
            { kind: 'literal', value: volatile },
          ],
        };
      }
      if (
        /^(?:u?int\d+_t|uintptr_t)$/.test(this.peek()) &&
        this.tokens[this.position + 1] === ')'
      ) {
        const type = this.take();
        this.take(')');
        return {
          kind: 'call',
          name: type === 'uintptr_t' ? 'uint64' : type.slice(0, -2),
          args: [this.atom()],
        };
      }
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
    if (token.startsWith('"')) return { kind: 'literal', value: JSON.parse(token) as string };
    if (/^\d/.test(token)) return { kind: 'literal', value: BigInt(token) };
    if (token === 'true' || token === 'false' || token === 'True' || token === 'False')
      return { kind: 'literal', value: token === 'true' || token === 'True' };
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
      return { kind: 'call', name: token, args };
    }
    return { kind: 'ref', name: token };
  }
}

export interface Observation {
  readonly exit: string;
  readonly values: readonly bigint[];
  /** Immutable literal bytes returned by the source-level pointer subset. */
  readonly string_result?: string;
  readonly tail_target?: bigint;
  readonly source_calls?: readonly { readonly name: string; readonly arguments: readonly bigint[] }[];
  readonly registers: ReadonlyMap<string, { readonly bits: bigint; readonly known: bigint }>;
  readonly memory: ReadonlyMap<bigint, number>;
  readonly events: readonly string[];
  readonly calls: readonly { readonly target: bigint; readonly arguments: readonly bigint[]; readonly arguments_complete?: boolean }[];
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
    if (!python && !declaration.endsWith(',') &&
        !/^\s*[,)]/.test(emission.text.slice(mapping.end, headerEnd)))
      continue;
    const name = match[1]!, previous = declarations.get(name);
    if (previous) {
      assert.ok(mapping.start < previous.end && mapping.end > previous.start,
        `Duplicate formal declaration ${name}`);
      declarations.set(name, {
        formal: { ...previous.formal, semantic_ids: [...new Set([
          ...previous.formal.semantic_ids, mapping.statement_id, ...mapping.semantic_ids,
        ])] },
        start: Math.min(previous.start, mapping.start), end: Math.max(previous.end, mapping.end),
      });
    } else declarations.set(name, {
      formal: { name, statement_id: mapping.statement_id,
        semantic_ids: [...new Set([mapping.statement_id, ...mapping.semantic_ids])] },
      start: mapping.start, end: mapping.end,
    });
  }
  return [...declarations.values()].sort((left, right) => left.start - right.start)
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
): Observation {
  const text = emission.text,
    parser = new Parser(text),
    environment = new Map<string, Data>(inputs),
    events: string[] = [];
  // Mappings supply only formal input identity; every operation below executes
  // parsed output independently of the analyzed IR and its reconstruction plan.
  for (const formal of emittedFormals(emission, parser.headerEnd)) {
    const id = inputs.has(formal.statement_id)
      ? formal.statement_id
      : formal.semantic_ids.find((id) => inputs.has(id));
    assert.ok(id, `Missing explicit input for ${formal.name}`);
    environment.set(formal.name, inputs.get(id)!);
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
      const size = number(args[0]), alignment = number(args[1]);
      assert.ok(size >= 0n && size <= 1048576n && alignment > 0n);
      let base = ((nextStackAddress + alignment - 1n) / alignment) * alignment;
      for (;;) {
        let overlap = false;
        for (let offset = 0n; offset < size; offset++)
          if (memory.has(base + offset)) { overlap = true; break; }
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
    if (name === 'stack_slot' || name === 'field_view') return args[0]!;
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
    if (name.startsWith('cast_')) {
      const n = width(args[0]),
        source = width(args[1]),
        value = number(args[2]);
      if (name === 'cast_sign_extend') return BigInt.asUintN(n, BigInt.asIntN(source, value));
      if (name === 'cast_bitcast' || name === 'cast_truncate' || name === 'cast_zero_extend')
        return BigInt.asUintN(n, value);
      if (name === 'cast_unsigned_to_float' || name === 'cast_signed_to_float')
        return encodeFloat(
          Number(name === 'cast_signed_to_float' ? BigInt.asIntN(source, value) : value),
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
    if (name === 'write_memory' || name === 'read_memory') {
      const store = name === 'write_memory',
        address = number(args[0]),
        count = width(args[store ? 2 : 1]) / 8,
        endian = string(args[store ? 3 : 2]);
      events.push(store ? 'store' : 'load');
      if (address % number(args[store ? 4 : 3]) !== 0n) throw new Boundary('fault', []);
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
    if (name === 'opaque_effect') {
      events.push('unknown');
      throw new Boundary('unknown', []);
    }
    if (name === 'unknown_value') return unknownValues.get(string(args[1])) ?? null;
    if (name === 'undefined_value') return null;
    if (name === 'unknown_arguments' || name === 'unknown_argument_remainder' || name === 'unknown_calling_convention' || name === 'unknown_results')
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
    const sourceCall = sourceCalls.get(name) ?? (target === undefined ? undefined : sourceCalls.get(`0x${target.toString(16)}`));
    if (sourceCall) {
      const last = args.at(-1);
      const remainder = last !== null && typeof last === 'object' && !Array.isArray(last) &&
        (last['unresolved'] === 'unknown_arguments' || last['unresolved'] === 'unknown_argument_remainder');
      const arguments_ = (remainder ? args.slice(0, -1) : args).map(number);
      const context = { arguments_complete: !remainder };
      events.push('call');
      sourceCallsObserved.push({ name, arguments: arguments_ });
      if (target !== undefined) calls.push({ target, arguments: arguments_, ...context });
      const returned = sourceCall(arguments_, context);
      return typeof returned === 'bigint' ? returned : [...returned];
    }
    throw new Error(`Oracle does not support helper ${name}`);
  };
  const evaluate = (expression: Expr): Data => {
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
        return expression.values.map(evaluate);
      case 'call':
        return helper(expression.name, expression.args.map(evaluate));
      case 'select': {
        const condition = evaluate(expression.condition);
        if (condition === null) return null;
        return evaluate(condition === 0n || condition === false ? expression.no : expression.yes);
      }
      case 'unary': {
        const value = evaluate(expression.value);
        if (value === null) return null;
        const operand = number(value);
        return expression.op === '-'
          ? -operand
          : expression.op === '~'
            ? ~operand
            : BigInt(operand === 0n);
      }
      case 'binary': {
        const a = evaluate(expression.left),
          b = evaluate(expression.right);
        if (a === null || b === null) return null;
        const left = number(a),
          right = number(b);
        switch (expression.op) {
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
          case '==':
            return BigInt(left === right);
          case '!=':
            return BigInt(left !== right);
          case '<':
            return BigInt(left < right);
          case '<=':
            return BigInt(left <= right);
          case '>':
            return BigInt(left > right);
          case '>=':
            return BigInt(left >= right);
          default:
            throw new Error(`Unknown emitted operator ${expression.op}`);
        }
      }
    }
  };
  try {
    let pc = 0;
    for (let steps = 0; steps < 20000; steps++) {
      const op = parser.ops[pc++];
      assert.ok(op, 'Emitted control fell out of function');
      switch (op.kind) {
        case 'assign':
          if (op.expression) {
            const value = evaluate(op.expression),
              values = op.tuple ? array(value) : [value];
            assert.equal(values.length, op.names.length);
            op.names.forEach((name, index) => environment.set(name, values[index]!));
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
              values: (Array.isArray(value) ? value : [value]).map(number),
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

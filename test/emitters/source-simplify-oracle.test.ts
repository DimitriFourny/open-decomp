import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createOperationContext } from '../../src/core/index.js';
import { expressionText, SourcePrinter, type Printed } from '../../src/emitters/expressions.js';
import { Writer } from '../../src/emitters/writer.js';
import {
  bitWidth,
  evaluateExpression,
  integer,
  type Expression,
  type RuntimeValue,
  type Value,
} from '../../src/ir/index.js';
import { CLANG, nativeAndPythonOracleSkip } from '../support/host-tools.js';

/** Typed leaves a source-view printer meets: declared unsigned variables, a
 * declared signed variable (printed as its unsigned bit pattern), a 64-bit IR
 * value declared as a zero-extended 32-bit variable (carries `widened`) and a
 * 64-bit IR value declared as a sign-extended 32-bit variable. */
interface Leaf {
  readonly name: string;
  readonly bits: number;
  /** C declaration type of the variable. */
  readonly c: string;
  /** Printed value of the IR leaf value in a given dialect. */
  readonly printed: (printer: SourcePrinter, python: boolean) => Printed;
  /** IR bit pattern the variable holds for a raw random pattern. */
  readonly pattern: (raw: bigint) => bigint;
  /** Variable value (signed where declared signed) for an IR bit pattern. */
  readonly variable: (pattern: bigint) => bigint;
}
const unsignedLeaf = (name: string, bits: number): Leaf => ({
  name,
  bits,
  c: `uint${bits}_t`,
  printed: (printer) => printer.primary(name, { bits, signed: false }),
  pattern: (raw) => BigInt.asUintN(bits, raw),
  variable: (pattern) => pattern,
});
const leaves: readonly Leaf[] = [
  unsignedLeaf('a', 32),
  unsignedLeaf('b', 64),
  unsignedLeaf('h', 16),
  unsignedLeaf('c', 8),
  {
    name: 's',
    bits: 32,
    c: 'int32_t',
    printed: (printer) => printer.cast(32, false, printer.primary('s', { bits: 32, signed: true })),
    pattern: (raw) => BigInt.asUintN(32, raw),
    variable: (pattern) => BigInt.asIntN(32, pattern),
  },
  {
    name: 'w',
    bits: 64,
    c: 'uint32_t',
    printed: (printer, python) => {
      const narrow = printer.primary('w', { bits: 32, signed: false });
      return python ? narrow : { ...printer.cast(64, false, narrow), widened: narrow };
    },
    pattern: (raw) => BigInt.asUintN(32, raw),
    variable: (pattern) => pattern,
  },
  {
    name: 'x',
    bits: 64,
    c: 'int32_t',
    printed: (printer) => printer.cast(64, false, printer.primary('x', { bits: 32, signed: true })),
    pattern: (raw) => BigInt.asUintN(64, BigInt.asIntN(32, raw)),
    variable: (pattern) => BigInt.asIntN(32, pattern),
  },
];

function prng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Tree {
  readonly values: Map<string, Value>;
  readonly definitions: Map<string, Expression>;
  readonly root: Value;
}
function generate(seed: number): Tree {
  const random = prng(seed),
    values = new Map<string, Value>(),
    definitions = new Map<string, Expression>();
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const make = (bits: number, expression?: Expression): Value => {
    const value = { id: `v${values.size}`, type: integer(bits) };
    values.set(value.id, value);
    if (expression) definitions.set(value.id, expression);
    return value;
  };
  const constant = (bits: number, kind: 'zero' | 'mask' | 'any'): Value => {
    const ones = (1n << BigInt(bits)) - 1n;
    const choices = [0n, 1n, ones, ones >> 1n, 0xffn & ones, 0xffffn & ones, 0xffffffffn & ones];
    return make(bits, {
      kind: 'constant',
      bits:
        kind === 'zero'
          ? 0n
          : BigInt.asUintN(bits, kind === 'mask' ? pick(choices.slice(2)) : pick(choices)),
    });
  };
  const leaf = (bits: number): Value | undefined => {
    const options = leaves.filter((item) => item.bits === bits);
    if (!options.length) return undefined;
    const item = pick(options);
    const existing = values.get(`leaf:${item.name}`);
    if (existing) return existing;
    const value = { id: `leaf:${item.name}`, type: integer(bits) };
    values.set(value.id, value);
    return value;
  };
  const widths = [8, 16, 32, 64];
  const gen = (bits: number, depth: number): Value => {
    if (bits === 1) {
      if (depth <= 0 || random() < 0.2) {
        const width = pick(widths);
        return make(1, {
          kind: 'compare',
          op: pick(['eq', 'ne', 'ult', 'ule', 'slt', 'sge'] as const),
          left: gen(width, depth - 1),
          right: random() < 0.3 ? constant(width, 'any') : gen(width, depth - 1),
        });
      }
      const kind = random();
      if (kind < 0.45)
        return make(1, { kind: 'integer_unary', op: 'not', value: gen(1, depth - 1) });
      if (kind < 0.55)
        return make(1, {
          kind: 'integer_unary',
          op: 'not',
          value: make(1, { kind: 'integer_unary', op: 'not', value: gen(1, depth - 1) }),
        });
      return make(1, {
        kind: 'integer',
        op: pick(['and', 'or'] as const),
        left: gen(1, depth - 1),
        right: gen(1, depth - 1),
      });
    }
    const direct = leaf(bits);
    if (depth <= 0) return direct ?? constant(bits, 'any');
    const choice = random();
    if (direct && choice < 0.15) return direct;
    const narrower = widths.filter((width) => width < bits),
      wider = widths.filter((width) => width > bits);
    if (choice < 0.35 && narrower.length) {
      const from = pick(narrower);
      return make(bits, {
        kind: 'cast',
        op: pick(['zero_extend', 'sign_extend'] as const),
        value: gen(from, depth - 1),
      });
    }
    if (choice < 0.5 && wider.length) {
      const from = pick(wider);
      if (random() < 0.5)
        return make(bits, { kind: 'cast', op: 'truncate', value: gen(from, depth - 1) });
      const offsets = Array.from({ length: (from - bits) / 8 + 1 }, (_, index) => index * 8);
      return make(bits, { kind: 'extract', value: gen(from, depth - 1), offset: pick(offsets) });
    }
    if (choice < 0.65) {
      const op = pick(['and', 'or', 'xor', 'add', 'sub', 'mul'] as const);
      return make(bits, {
        kind: 'integer',
        op,
        left: gen(bits, depth - 1),
        right:
          random() < 0.4 ? constant(bits, op === 'and' ? 'mask' : 'any') : gen(bits, depth - 1),
      });
    }
    if (choice < 0.75 && bits > 1) {
      const op = pick(['shl', 'lshr', 'ashr'] as const);
      return make(bits, {
        kind: 'integer',
        op,
        left: gen(bits, depth - 1),
        right: make(bits, { kind: 'constant', bits: BigInt(Math.floor(random() * bits)) }),
      });
    }
    if (choice < 0.9 && bits >= 16) {
      const first = pick(widths.filter((width) => width <= bits / 2));
      const parts: Value[] = [gen(first, depth - 1)];
      let used = first;
      while (used < bits) {
        const part = pick(widths.filter((width) => used + width <= bits));
        parts.push(random() < 0.55 ? constant(part, 'zero') : gen(part, depth - 1));
        used += part;
      }
      return make(bits, { kind: 'concat', values: parts });
    }
    if (choice < 0.95)
      return make(bits, {
        kind: 'select',
        condition: gen(1, depth - 1),
        when_true: gen(bits, depth - 1),
        when_false: gen(bits, depth - 1),
      });
    return make(bits, {
      kind: 'integer_unary',
      op: pick(['not', 'neg'] as const),
      value: gen(bits, depth - 1),
    });
  };
  const root = gen(pick([1, 8, 16, 32, 64]), 4);
  return { values, definitions, root };
}

interface Printing {
  readonly text: string;
  readonly rules: ReadonlySet<string>;
}
function print(tree: Tree, language: 'c-like' | 'python-like', simplify: boolean): Printing {
  const writer = new Writer(createOperationContext(), 2, false, language),
    python = language === 'python-like';
  const rules = new Set<string>();
  const recorder = (rule: string): boolean => {
    rules.add(rule);
    return true;
  };
  const printer = new SourcePrinter(writer, false, simplify ? recorder : undefined);
  const options = {
    view: 'source' as const,
    source: { address: (): Printed => printer.primary('0') },
    constant: (value: Value): bigint | undefined => {
      const definition = tree.definitions.get(value.id);
      return definition?.kind === 'constant' ? definition.bits : undefined;
    },
    ...(simplify ? { presentation: recorder } : {}),
  };
  const name = (value: Value): Printed => {
    const item = leaves.find((candidate) => `leaf:${candidate.name}` === value.id);
    if (item) return item.printed(printer, python);
    const definition = tree.definitions.get(value.id);
    if (!definition) throw new Error(`undefined value ${value.id}`);
    return expressionText(definition, value.type, writer, name, options);
  };
  const root = name(tree.root);
  return { text: root.text, rules };
}

function evaluate(tree: Tree, inputs: ReadonlyMap<string, bigint>): bigint {
  const memo = new Map<string, RuntimeValue>();
  const get = (value: Value): RuntimeValue => {
    const known = memo.get(value.id);
    if (known) return known;
    let result: RuntimeValue;
    const input = inputs.get(value.id);
    if (input !== undefined) result = { kind: 'bits', bits: input };
    else {
      const definition = tree.definitions.get(value.id)!;
      result = evaluateExpression(value.type, definition, get);
    }
    memo.set(value.id, result);
    return result;
  };
  const result = get(tree.root);
  assert.equal(result.kind, 'bits');
  return result.kind === 'bits' ? result.bits : 0n;
}

const samples = [
  0n,
  1n,
  0x7fn,
  0x80n,
  0xffn,
  0x7fffn,
  0x8000n,
  0xffffn,
  0x7fffffffn,
  0x80000000n,
  0xffffffffn,
  0x100000000n,
  0x7fffffffffffffffn,
  0x8000000000000000n,
  0xffffffffffffffffn,
];

const cases = 700,
  vectors = 14;

test(
  'source printer simplifications equal the unsimplified printing and the IR semantics',
  { skip: nativeAndPythonOracleSkip(), timeout: 300_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'open-decomp-simplify-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const random = prng(7);
    const rulesSeen = new Set<string>();
    let changed = 0;
    const prototype = leaves.map((item) => `${item.c} ${item.name}`).join(', ');
    const parameters = leaves.map((item) => item.name).join(', ');
    const cLines = [
      '#include <stdint.h>',
      '#include <stdio.h>',
      'typedef unsigned __int128 uint128_t;',
      'typedef __int128 int128_t;',
    ];
    const pyLines = [
      ...[1, 8, 16, 32, 64, 128].flatMap((bits) => [
        `def uint${bits}(v): return v & ${(1n << BigInt(bits)) - 1n}`,
        `def int${bits}(v): return ((v + ${1n << BigInt(bits - 1)}) & ${(1n << BigInt(bits)) - 1n}) - ${1n << BigInt(bits - 1)}`,
      ]),
      'failures = 0',
    ];
    const cMain: string[] = [],
      pyMain: string[] = [];
    for (let index = 0; index < cases; index++) {
      const tree = generate(1000 + index);
      const width = bitWidth(tree.root.type),
        mask = (1n << BigInt(width)) - 1n;
      const printings = {
        c: [print(tree, 'c-like', false), print(tree, 'c-like', true)] as const,
        py: [print(tree, 'python-like', false), print(tree, 'python-like', true)] as const,
      };
      const texts = {
        c: printings.c.map((printing) => printing.text),
        py: printings.py.map((printing) => printing.text),
      };
      for (const printing of [...printings.c, ...printings.py])
        for (const rule of printing.rules) rulesSeen.add(rule);
      if (texts.c[0] !== texts.c[1] || texts.py[0] !== texts.py[1]) changed++;
      cLines.push(
        `static uint64_t u${index}(${prototype}) { return (uint64_t)(${texts.c[0]}); }`,
        `static uint64_t s${index}(${prototype}) { return (uint64_t)(${texts.c[1]}); }`,
      );
      pyLines.push(
        `def u${index}(${parameters}): return ${texts.py[0]}`,
        `def s${index}(${parameters}): return ${texts.py[1]}`,
      );
      for (let vector = 0; vector < vectors; vector++) {
        const inputs = new Map<string, bigint>();
        const cArgs: string[] = [],
          pyArgs: string[] = [];
        for (const item of leaves) {
          const raw =
            random() < 0.75
              ? samples[Math.floor(random() * samples.length)]!
              : BigInt(Math.floor(random() * 2 ** 32)) * 0x100000001n;
          const pattern = item.pattern(raw);
          inputs.set(`leaf:${item.name}`, pattern);
          const variable = item.variable(pattern);
          cArgs.push(variable < 0n ? `(${item.c})${variable}LL` : `${variable}ULL`);
          pyArgs.push(String(variable));
        }
        const expected = evaluate(tree, inputs) & mask;
        for (const kind of ['u', 's']) {
          cMain.push(
            `if ((${kind}${index}(${cArgs.join(', ')}) & ${mask}ULL) != ${expected}ULL) { printf("${kind}${index} vector ${vector}\\n"); failures++; }`,
          );
          pyMain.push(
            `if (${kind}${index}(${pyArgs.join(', ')}) & ${mask}) != ${expected}: print("${kind}${index} vector ${vector}"); failures += 1`,
          );
        }
      }
    }
    cLines.push('int main(void) { int failures = 0;', ...cMain, 'return failures != 0; }');
    pyLines.push(...pyMain, 'raise SystemExit(1 if failures else 0)');
    const cPath = join(directory, 'oracle.c'),
      pyPath = join(directory, 'oracle.py'),
      binary = join(directory, 'oracle');
    await writeFile(cPath, `${cLines.join('\n')}\n`);
    await writeFile(pyPath, `${pyLines.join('\n')}\n`);
    const build = spawnSync(
      CLANG,
      [
        '-std=c11',
        '-w',
        '-O0',
        '-fsanitize=signed-integer-overflow,shift',
        '-fno-sanitize-recover=all',
        cPath,
        '-o',
        binary,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(build.status, 0, build.stderr.slice(0, 4000));
    const c = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(c.status, 0, `${c.stdout.slice(0, 2000)}${c.stderr.slice(0, 2000)}`);
    const python = spawnSync('python3', [pyPath], { encoding: 'utf8' });
    assert.equal(
      python.status,
      0,
      `${python.stdout.slice(0, 2000)}${python.stderr.slice(0, 2000)}`,
    );
    assert.ok(changed > cases / 10, `simplifications applied in ${changed} of ${cases} cases`);
    for (const rule of [
      'zero_high_join',
      'conversion_collapse',
      'double_negation',
      'redundant_mask',
      'idempotent_bitwise',
      'complement_xor',
      'negative_addend',
    ])
      assert.ok(rulesSeen.has(rule), `${rule} exercised`);
  },
);

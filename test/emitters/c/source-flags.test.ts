import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { createOperationContext, DEFAULT_ANALYSIS_OPTIONS } from '../../../src/core/index.js';
import { integer, type SSAForm, type Value } from '../../../src/ir/index.js';
import { structureControlFlow } from '../../../src/presentation/index.js';
import { emitC } from '../../../src/emitters/c/index.js';
import { emitPythonLike } from '../../../src/emitters/python-like/index.js';
import type { EmissionResult } from '../../../src/emitters/model.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { builder } from '../../ir/support.js';
import { execute } from './support.js';

const i32 = integer(32),
  i64 = integer(64);
const ARRAY = 0x1000n,
  BOUND = 6n;

interface Shape {
  /** `&&` chains leave with flag 0, `||` chains with flag 1. */
  readonly op: 'and' | 'or';
  /** Element values tested by the second and later operands, in order. */
  readonly operands: 2 | 3;
  /** The test's flag load is also stored to memory in the loop body. */
  readonly readTwice?: boolean;
  /** The flag slot is read again after the loop. */
  readonly liveAfter?: boolean;
  /** The second stage stores to memory before writing the flag. */
  readonly interveningStore?: boolean;
}

/** The unoptimized form of `while (i < 6 && p[i] != 0 && p[i] != 7) i++` (or
 * `while (p[i] == 1 || p[i] == 2 || p[i] == 3) i++`): every value lives in a
 * frame slot, and the condition is carried to the loop test by a flag slot
 * written 0 (`&&`) or 1 (`||`) before each test and the last test's bit at the
 * end, then tested as `!(flag & 1)`. */
function flagLoop(label: string, shape: Shape): SSAForm {
  const abi = sysvAMD64Abi;
  const b = builder(`source-flags-${label}`),
    entry = b.block('entry'),
    stages = Array.from({ length: shape.operands }, (_, index) => b.block(`stage-${index}`)),
    merge = b.block('merge'),
    body = b.block('body'),
    exit = b.block('exit');
  type Block = typeof entry;
  const slot = (block: Block, offset: bigint): Value =>
    block.int('sub', block.readRegister(abi.stack_pointer), block.constant(i64, offset));
  const element = (block: Block): Value =>
    block.load(
      i64,
      block.int(
        'add',
        block.constant(i64, ARRAY),
        block.int('shl', block.load(i64, slot(block, 8n)), block.constant(i64, 3n)),
      ),
    );
  // Operand `index` of the chain.
  const operand = (block: Block, index: number): Value => {
    if (shape.op === 'or')
      return block.compare('eq', element(block), block.constant(i64, BigInt(index + 1)));
    if (index === 0)
      return block.compare('ult', block.load(i64, slot(block, 8n)), block.constant(i64, BOUND));
    return block.compare('ne', element(block), block.constant(i64, index === 1 ? 0n : 7n));
  };
  entry.store(slot(entry, 8n), entry.constant(i64, 0n));
  entry.jump(stages[0]!);
  stages.forEach((block, index) => {
    const condition = operand(block, index);
    if (index === 1 && shape.interveningStore)
      block.store(block.constant(i64, 0x2000n), block.load(i64, slot(block, 8n)));
    const last = index === stages.length - 1;
    block.store(
      slot(block, 16n),
      last
        ? block.cast('zero_extend', i32, condition)
        : block.constant(i32, shape.op === 'or' ? 1n : 0n),
    );
    if (last) block.jump(merge);
    else if (shape.op === 'or')
      block.branch(condition, block.edge(merge), block.edge(stages[index + 1]!));
    else block.branch(condition, block.edge(stages[index + 1]!), block.edge(merge));
  });
  const flag = merge.load(i32, slot(merge, 16n));
  merge.branch(
    merge.compare('eq', merge.int('and', flag, merge.constant(i32, 1n)), merge.constant(i32, 0n)),
    merge.edge(exit),
    merge.edge(body),
  );
  if (shape.readTwice) body.store(body.constant(i64, 0x2008n), flag);
  body.store(
    slot(body, 8n),
    body.int('add', body.load(i64, slot(body, 8n)), body.constant(i64, 1n)),
  );
  body.jump(stages[0]!);
  const index = exit.load(i64, slot(exit, 8n));
  exit.return([
    shape.liveAfter
      ? exit.int('add', index, exit.cast('zero_extend', i64, exit.load(i32, slot(exit, 16n))))
      : index,
  ]);
  return constructSSA(b.finish(entry, [i64])).value as SSAForm;
}

/** Iterations and array loads of the source loop. */
function oracle(shape: Shape, words: readonly bigint[]): { result: bigint; loads: number } {
  let i = 0,
    loads = 0;
  const read = (): bigint => {
    loads++;
    return words[i] ?? 0n;
  };
  for (;;) {
    let flag: boolean;
    if (shape.op === 'or') {
      flag = false;
      for (let k = 0; k < shape.operands && !flag; k++) flag = read() === BigInt(k + 1);
    } else {
      flag = BigInt(i) < BOUND;
      if (flag) flag = read() !== 0n;
      if (flag && shape.operands === 3) flag = read() !== 7n;
    }
    // The flag is 0 on exit, so reading it after the loop adds nothing.
    if (!flag) return { result: BigInt(i), loads };
    i++;
  }
}

const memory = (words: readonly bigint[]): Map<bigint, number> => {
  const bytes = new Map<bigint, number>();
  for (let index = 0; index < 16; index++)
    for (let byte = 0; byte < 8; byte++)
      bytes.set(
        ARRAY + BigInt(index * 8 + byte),
        Number(((words[index] ?? 0n) >> BigInt(byte * 8)) & 255n),
      );
  // Scratch words written by the negative shapes.
  for (let byte = 0n; byte < 16n; byte++) bytes.set(0x2000n + byte, 0);
  return bytes;
};

/** `while (i < 6 && (p[i] == 1 || p[i] == 2)) i++` unoptimized: the inner `||`
 * carries its own flag, which the outer chain's last stage copies. */
function nestedLoop(): SSAForm {
  const abi = sysvAMD64Abi;
  const b = builder('source-flags-nested'),
    entry = b.block('entry'),
    head = b.block('head'),
    inner = b.block('inner'),
    second = b.block('second'),
    copy = b.block('copy'),
    merge = b.block('merge'),
    body = b.block('body'),
    exit = b.block('exit');
  type Block = typeof entry;
  const slot = (block: Block, offset: bigint): Value =>
    block.int('sub', block.readRegister(abi.stack_pointer), block.constant(i64, offset));
  const element = (block: Block): Value =>
    block.load(
      i64,
      block.int(
        'add',
        block.constant(i64, ARRAY),
        block.int('shl', block.load(i64, slot(block, 8n)), block.constant(i64, 3n)),
      ),
    );
  entry.store(slot(entry, 8n), entry.constant(i64, 0n));
  entry.jump(head);
  const bounded = head.compare('ult', head.load(i64, slot(head, 8n)), head.constant(i64, BOUND));
  head.store(slot(head, 16n), head.constant(i32, 0n));
  head.branch(bounded, head.edge(inner), head.edge(merge));
  const one = inner.compare('eq', element(inner), inner.constant(i64, 1n));
  inner.store(slot(inner, 20n), inner.constant(i32, 1n));
  inner.branch(one, inner.edge(copy), inner.edge(second));
  const two = second.compare('eq', element(second), second.constant(i64, 2n));
  second.store(slot(second, 20n), second.cast('zero_extend', i32, two));
  second.jump(copy);
  copy.store(slot(copy, 16n), copy.load(i32, slot(copy, 20n)));
  copy.jump(merge);
  const flag = merge.load(i32, slot(merge, 16n));
  merge.branch(
    merge.compare('eq', merge.int('and', flag, merge.constant(i32, 1n)), merge.constant(i32, 0n)),
    merge.edge(exit),
    merge.edge(body),
  );
  body.store(
    slot(body, 8n),
    body.int('add', body.load(i64, slot(body, 8n)), body.constant(i64, 1n)),
  );
  body.jump(head);
  exit.return([exit.load(i64, slot(exit, 8n))]);
  return constructSSA(b.finish(entry, [i64])).value as SSAForm;
}

/** `if (p[0] != 0) { if (p[1] != 0 && p[2] != 0) *q = 1; } return *q;` with the
 * inner condition carried by a flag slot: no loop, so the merge is an `if`. */
function acyclic(): SSAForm {
  const abi = sysvAMD64Abi;
  const b = builder('source-flags-acyclic'),
    entry = b.block('entry'),
    head = b.block('head'),
    second = b.block('second'),
    merge = b.block('merge'),
    set = b.block('set'),
    exit = b.block('exit');
  type Block = typeof entry;
  const slot = (block: Block, offset: bigint): Value =>
    block.int('sub', block.readRegister(abi.stack_pointer), block.constant(i64, offset));
  const word = (block: Block, index: bigint): Value =>
    block.compare(
      'ne',
      block.load(i64, block.constant(i64, ARRAY + index * 8n)),
      block.constant(i64, 0n),
    );
  entry.branch(word(entry, 0n), entry.edge(head), entry.edge(exit));
  const first = word(head, 1n);
  head.store(slot(head, 16n), head.constant(i32, 0n));
  head.branch(first, head.edge(second), head.edge(merge));
  second.store(slot(second, 16n), second.cast('zero_extend', i32, word(second, 2n)));
  second.jump(merge);
  const flag = merge.load(i32, slot(merge, 16n));
  merge.branch(
    merge.compare('eq', merge.int('and', flag, merge.constant(i32, 1n)), merge.constant(i32, 0n)),
    merge.edge(exit),
    merge.edge(set),
  );
  set.store(set.constant(i64, 0x2000n), set.constant(i64, 1n));
  set.jump(exit);
  exit.return([exit.load(i64, exit.constant(i64, 0x2000n))]);
  return constructSSA(b.finish(entry, [i64])).value as SSAForm;
}

const INPUTS: readonly (readonly bigint[])[] = [
  [5n, 4n, 9n, 1n, 3n, 8n, 2n, 6n],
  [5n, 7n, 2n],
  [0n, 1n],
  [1n, 2n, 3n, 1n, 4n],
  [2n, 3n, 2n, 1n, 1n],
];

for (const language of ['c-like', 'python-like'] as const)
  describe(`short-circuit flag tests (${language})`, () => {
    const render = (input: SSAForm, view: 'source' | 'checked' = 'source'): EmissionResult => {
      const structured = structureControlFlow(input, createOperationContext());
      assert.ok(structured.value);
      return (language === 'python-like' ? emitPythonLike : emitC)(
        { function: structured.value, source: { abi: sysvAMD64Abi, callees: [], addresses: [] } },
        { ...DEFAULT_ANALYSIS_OPTIONS, emitter: language, view },
        createOperationContext(),
      );
    };
    const rules = (output: EmissionResult): string[] =>
      (output.emission.local_validation ?? []).flatMap((record) =>
        record.kind === 'presentation' && record.rule ? [record.rule] : [],
      );
    const and = language === 'c-like' ? '&&' : 'and',
      or = language === 'c-like' ? '||' : 'or';
    /** Results and array loads of the source text match the source loop. */
    const runs = (shape: Shape, output: EmissionResult): void => {
      for (const words of INPUTS) {
        const expected = oracle(shape, words),
          observed = execute(output.emission, new Map(), memory(words));
        assert.deepEqual(observed.values, [expected.result], output.emission.text);
        const loads = observed.events.filter((event) => event === 'load').length;
        if (!shape.readTwice && !shape.interveningStore && !shape.liveAfter)
          assert.equal(loads, expected.loads, output.emission.text);
      }
    };

    for (const operands of [2, 3] as const)
      test(`a ${operands}-operand && chain carried by a flag slot is the while condition`, () => {
        const shape: Shape = { op: 'and', operands };
        const output = render(flagLoop(`and-${operands}`, shape)),
          text = output.emission.text;
        assert.ok(rules(output).includes('short_circuit_flag'), text);
        const pattern =
          operands === 3
            ? new RegExp(`while \\(?index < 6 ${and} .+ != 0 ${and} .+ != 7\\)?:? ?\\{?\\n`)
            : new RegExp(`while \\(?index < 6 ${and} .+ != 0\\)?:? ?\\{?\\n`);
        assert.match(text, pattern, text);
        assert.doesNotMatch(text, /\blocal_|while \(?true|while True|& 1/, text);
        runs(shape, output);
      });

    test('a || chain carried by a flag written 1 is the disjunction', () => {
      const shape: Shape = { op: 'or', operands: 3 };
      const output = render(flagLoop('or', shape)),
        text = output.emission.text;
      assert.ok(rules(output).includes('short_circuit_flag'), text);
      assert.match(text, new RegExp(`while \\(?.+ == 1 ${or} .+ == 2 ${or} .+ == 3\\)?`), text);
      assert.doesNotMatch(text, /\blocal_|while \(?true|while True/, text);
      runs(shape, output);
    });

    for (const [label, shape] of [
      ['a flag read twice', { op: 'and', operands: 3, readTwice: true }],
      ['a flag live after its test', { op: 'and', operands: 3, liveAfter: true }],
      ['a store between operands', { op: 'and', operands: 3, interveningStore: true }],
    ] as const)
      test(`${label} keeps the flag variable`, () => {
        const output = render(flagLoop(label.replace(/ /g, '-'), shape)),
          text = output.emission.text;
        assert.ok(!rules(output).includes('short_circuit_flag'), text);
        assert.match(text, /\blocal_/, text);
        runs(shape, output);
      });

    test('a nested || flag copied by the last && stage is a parenthesized operand', () => {
      const output = render(nestedLoop()),
        text = output.emission.text;
      assert.ok(rules(output).includes('short_circuit_flag'), text);
      assert.match(
        text,
        new RegExp(`while \\(?index < 6 ${and} \\(.+ == 1 ${or} .+ == 2\\)\\)?`),
        text,
      );
      assert.doesNotMatch(text, /\blocal_|while \(?true|while True/, text);
      for (const words of INPUTS) {
        let i = 0,
          loads = 0;
        for (;;) {
          if (i >= 6) break;
          loads++;
          if (words[i] === 1n) {
            i++;
            continue;
          }
          loads++;
          if (words[i] !== 2n) break;
          i++;
        }
        const observed = execute(output.emission, new Map(), memory(words));
        assert.deepEqual(observed.values, [BigInt(i)], text);
        assert.equal(observed.events.filter((event) => event === 'load').length, loads, text);
      }
    });

    test('a flag test that is not a loop test merges with its enclosing if', () => {
      const output = render(acyclic()),
        text = output.emission.text;
      assert.ok(rules(output).includes('short_circuit_flag'), text);
      assert.ok(rules(output).includes('nested_condition_merge'), text);
      assert.match(text, new RegExp(`if \\(?.+ != 0 ${and} .+ != 0 ${and} .+ != 0\\)?`), text);
      assert.doesNotMatch(text, /\blocal_/, text);
      for (const words of [
        [0n, 1n, 1n],
        [1n, 0n, 1n],
        [1n, 1n, 0n],
        [1n, 1n, 1n],
        [2n, 3n, 4n],
      ]) {
        const loads = words[0] === 0n ? 1 : words[1] === 0n ? 2 : 3;
        const set = words.every((word) => word !== 0n);
        const observed = execute(output.emission, new Map(), memory(words));
        assert.deepEqual(observed.values, [set ? 1n : 0n], text);
        assert.equal(observed.events.filter((event) => event === 'load').length, loads + 1, text);
        assert.equal(observed.events.filter((event) => event === 'store').length, set ? 1 : 0);
      }
    });

    test('the checked view keeps the flag stores and tests', () => {
      const output = render(flagLoop('checked', { op: 'and', operands: 3 }), 'checked');
      assert.ok(!rules(output).includes('short_circuit_flag'));
      assert.doesNotMatch(output.emission.text, / && | and /);
    });
  });

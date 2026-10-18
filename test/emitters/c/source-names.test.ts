import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  createOperationContext,
  DEFAULT_ANALYSIS_OPTIONS,
  entityIdentity,
} from '../../../src/core/index.js';
import {
  IRBuilder,
  integer,
  type DataType,
  type SSAForm,
  type Value,
} from '../../../src/ir/index.js';
import { structureControlFlow } from '../../../src/presentation/index.js';
import { emitC } from '../../../src/emitters/c/index.js';
import { emitPythonLike } from '../../../src/emitters/python-like/index.js';
import type { EmissionResult } from '../../../src/emitters/model.js';
import { provenance, slice } from '../../ir/support.js';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { builder, register } from '../../ir/support.js';

const i32 = integer(32),
  i64 = integer(64),
  f64: DataType = { kind: 'float', bits: 64 };
const program = (name: string): IRBuilder<'ssa'> =>
  new IRBuilder(slice, entityIdentity(slice, 'function', name), provenance, 'ssa');
const emit = (
  input: SSAForm,
  language: 'c-like' | 'python-like',
  view: 'source' | 'checked' = 'source',
): EmissionResult => {
  const structured = structureControlFlow(input, createOperationContext());
  assert.ok(structured.value);
  return (language === 'python-like' ? emitPythonLike : emitC)(
    {
      function: structured.value,
      ...(view === 'source'
        ? { source: { abi: new DarwinArm64Abi(), callees: [], addresses: [] } }
        : {}),
    },
    { ...DEFAULT_ANALYSIS_OPTIONS, emitter: language, view },
    createOperationContext(),
  );
};
const name = (output: EmissionResult, value: Value): string | undefined =>
  output.identifiers.find((row) => row.entity_id === value.id)?.identifier;
const stem = (identifier: string | undefined): string | undefined =>
  identifier?.replace(/_\d+$/, '');
const neutral = /^value\d+$/;

interface Loop {
  input: SSAForm;
  bound: Value;
  index: Value;
  fold: Value;
  folded: Value;
  merged: Value;
  running: Value;
}
/** `for (index = 0; index < bound; index += step) fold = fold OP element[index]`.
 * `merge` routes the update through a conditional merge phi, the way an optimizer
 * leaves a guarded update. */
function counted(
  label: string,
  options: {
    step?: bigint;
    op?: 'add' | 'mul' | 'xor' | 'or';
    float?: boolean;
    merge?: boolean;
    constantFold?: bigint;
    shiftIndex?: boolean;
    unrolled?: boolean;
    untested?: boolean;
  } = {},
): Loop {
  const { step = 1n, op = 'add', float = false, merge = false, constantFold } = options;
  const kind = float ? f64 : i32;
  const b = program(`source-names-${label}`),
    entry = b.block('entry', [i32]),
    head = b.block('head', [i32, kind]),
    body = b.block('body'),
    exit = b.block('exit', [kind]);
  const bound = entry.parameters[0]!;
  entry.jump(head, [entry.constant(i32, 0n), entry.constant(kind, 0n)]);
  const [index, fold] = head.parameters as [Value, Value];
  const condition = options.untested
    ? head.compare('ne', bound, head.constant(i32, 0n))
    : head.compare('ult', index, bound);
  head.branch(condition, head.edge(body), head.edge(exit, [fold]));
  const address = body.int(
    'add',
    body.constant(i64, 0x1000n),
    body.cast('zero_extend', i64, body.int('shl', index, body.constant(i32, 2n))),
  );
  const element = body.load(kind, address);
  const next = body.int('add', index, body.constant(i32, step));
  let merged = fold;
  const operand = constantFold === undefined ? element : body.constant(kind, constantFold);
  let running = fold;
  let folded: Value;
  if (options.unrolled) {
    // Two unrolled steps: `running` is the fold after the first element.
    running = body.int(op, fold, operand);
    body.store(body.constant(i64, 0x2000n), running);
    folded = body.int(op, running, body.load(kind, body.constant(i64, 0x1800n)));
  } else folded = float ? body.fp('add', fold, element) : body.int(op, fold, operand);
  if (options.shiftIndex) {
    const shifted = body.int('shl', body.constant(i32, 1n), index);
    body.store(body.constant(i64, 0x2000n), shifted);
  }
  if (merge) {
    const skip = b.block('skip'),
      join = b.block('join', [kind]);
    body.branch(
      body.compare('eq', element, body.constant(i32, 0n)),
      body.edge(join, [fold]),
      body.edge(skip),
    );
    skip.jump(join, [folded]);
    merged = join.parameters[0]!;
    join.jump(head, [next, merged]);
  } else body.jump(head, [next, folded]);
  exit.return(exit.parameters);
  return { input: b.finish(entry, [kind]), bound, index, fold, folded, merged, running };
}

for (const language of ['c-like', 'python-like'] as const)
  describe(`source loop roles (${language})`, () => {
    test('a constant +1 induction variable is index and its invariant bound is count', () => {
      const { input, bound, index } = counted('index-one');
      const output = emit(input, language);
      assert.equal(stem(name(output, index)), 'index');
      assert.equal(stem(name(output, bound)), 'count');
      // The checked view never carries role names.
      assert.doesNotMatch(emit(input, language, 'checked').emission.text, /\bindex\b|\bcount\b/);
    });

    test('a larger constant step is still index; its bound is limit, not count', () => {
      const { input, bound, index } = counted('index-four', { step: 4n });
      const output = emit(input, language);
      assert.equal(stem(name(output, index)), 'index');
      assert.equal(stem(name(output, bound)), 'limit');
    });

    test('an untested step is index only when it is one, not a possible pointer stride', () => {
      const unit = counted('index-untested-one', { untested: true });
      assert.equal(stem(name(emit(unit.input, language), unit.index)), 'index');
      const stride = counted('index-untested-eight', { step: 8n, untested: true });
      assert.match(name(emit(stride.input, language), stride.index) ?? '', neutral);
    });

    test('a negative constant step is a decreasing count', () => {
      const { input, index } = counted('index-down', { step: 0xfffffffen });
      const output = emit(input, language);
      assert.equal(stem(name(output, index)), 'remaining');
    });

    test('loop-carried xor, or, mul and add folds with a varying operand are accumulators', () => {
      for (const op of ['add', 'mul', 'xor', 'or'] as const) {
        const { input, fold } = counted(`fold-${op}`, { op });
        assert.equal(stem(name(emit(input, language), fold)), 'accumulator', op);
      }
    });

    test('an update routed through a conditional merge phi names the whole web once', () => {
      const { input, fold, folded, merged } = counted('fold-merge', { op: 'xor', merge: true });
      const output = emit(input, language);
      // The header phi, the merge phi and the update are one printed variable.
      const names = new Set([fold, merged, folded].flatMap((value) => name(output, value) ?? []));
      assert.equal(names.size, 1, [...names].join());
      assert.equal(stem([...names][0]), 'accumulator');
    });

    test('every running value of an unrolled fold shares the accumulator role', () => {
      const { input, fold, running, folded } = counted('fold-unrolled', {
        op: 'xor',
        unrolled: true,
      });
      const output = emit(input, language);
      const names = [fold, running, folded].flatMap((value) => name(output, value) ?? []);
      assert.ok(names.length >= 2, names.join());
      for (const identifier of names) assert.equal(stem(identifier), 'accumulator');
      assert.equal(stem(name(output, running)), 'accumulator');
    });

    test('a floating-point sum is an accumulator', () => {
      const { input, fold } = counted('fold-float', { float: true });
      assert.equal(stem(name(emit(input, language), fold)), 'accumulator');
    });

    test('a fold by a constant is a state update, not an accumulator', () => {
      const { input, fold } = counted('fold-constant', { op: 'xor', constantFold: 0xedb88320n });
      assert.doesNotMatch(name(emit(input, language), fold) ?? '', /^accumulator/);
    });

    test('conflicting roles stay neutral', () => {
      // The induction variable is also a shift count: index and shift_count disagree.
      const { input, index } = counted('index-shift', { shiftIndex: true });
      assert.match(name(emit(input, language), index) ?? '', neutral);
    });
  });

const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');
/** The unoptimized form of a counted loop: index, sum and bound live in private
 * frame slots, so the carried variables are slot loads and stores, not phis. */
function slotLoop(label: string, shifted = false): SSAForm {
  const abi = sysvAMD64Abi;
  const b = builder(`source-names-slots-${label}`),
    entry = b.block('entry'),
    head = b.block('head'),
    body = b.block('body'),
    exit = b.block('exit');
  const slot = (block: typeof entry, offset: bigint): Value =>
    block.int('sub', block.readRegister(abi.stack_pointer), block.constant(i64, offset));
  entry.store(slot(entry, 24n), entry.readRegister(rdi));
  entry.store(slot(entry, 8n), entry.constant(i64, 0n));
  entry.store(slot(entry, 16n), entry.constant(i64, 0n));
  entry.jump(head);
  head.branch(
    head.compare('ult', head.load(i64, slot(head, 8n)), head.load(i64, slot(head, 24n))),
    head.edge(body),
    head.edge(exit),
  );
  const index = body.load(i64, slot(body, 8n));
  const element = body.load(i64, body.int('add', body.constant(i64, 0x1000n), index));
  body.store(slot(body, 16n), body.int('xor', body.load(i64, slot(body, 16n)), element));
  if (shifted)
    body.store(body.constant(i64, 0x2000n), body.int('shl', body.constant(i64, 1n), index));
  body.store(slot(body, 8n), body.int('add', index, body.constant(i64, 1n)));
  body.jump(head);
  exit.return([exit.load(i64, slot(exit, 16n))]);
  return constructSSA(b.finish(entry, [i64])).value as SSAForm;
}
for (const language of ['c-like', 'python-like'] as const)
  describe(`promoted frame slot loop roles (${language})`, () => {
    const emitSlots = (input: SSAForm): string => {
      const structured = structureControlFlow(input, createOperationContext());
      assert.ok(structured.value);
      return (language === 'python-like' ? emitPythonLike : emitC)(
        { function: structured.value, source: { abi: sysvAMD64Abi, callees: [], addresses: [] } },
        { ...DEFAULT_ANALYSIS_OPTIONS, emitter: language, view: 'source' },
        createOperationContext(),
      ).emission.text;
    };
    test('a slot stepped by one is index and a slot folded by xor is accumulator', () => {
      const text = emitSlots(slotLoop('plain'));
      assert.match(text, /\bindex\b/);
      assert.match(text, /\baccumulator\b/);
      assert.doesNotMatch(text, /\blocal_/);
    });
    test('a slot with conflicting roles keeps its frame-offset name', () => {
      const text = emitSlots(slotLoop('shifted', true));
      assert.doesNotMatch(text, /\bindex\b/);
      assert.match(text, /\blocal_/);
      assert.match(text, /\baccumulator\b/);
    });
  });

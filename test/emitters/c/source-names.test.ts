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
const loopRole = /^(?:index|count|remaining|limit|accumulator)(?:_\d+)?$/;

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
 * leaves a guarded update; `seeded` starts the fold from a loaded value, not 0. */
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
    seeded?: boolean;
  } = {},
): Loop & { seed: Value } {
  const { step = 1n, op = 'add', float = false, merge = false, constantFold } = options;
  const kind = float ? f64 : i32;
  const b = program(`source-names-${label}`),
    entry = b.block('entry', [i32]),
    head = b.block('head', [i32, kind]),
    body = b.block('body'),
    exit = b.block('exit', [kind]);
  const bound = entry.parameters[0]!;
  const seed = options.seeded
    ? entry.load(kind, entry.constant(i64, 0x3000n))
    : entry.constant(kind, 0n);
  entry.jump(head, [entry.constant(i32, 0n), seed]);
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
  return { input: b.finish(entry, [kind]), bound, index, fold, folded, merged, running, seed };
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

    test('a countdown from zero counts negated iterations, not what remains', () => {
      const { input, index } = counted('index-down', { step: 0xfffffffen });
      const output = emit(input, language);
      assert.doesNotMatch(name(output, index) ?? '', loopRole);
    });

    test('loop-carried xor, or, mul and add folds with a varying operand are accumulators', () => {
      for (const op of ['add', 'mul', 'xor', 'or'] as const) {
        const { input, fold } = counted(`fold-${op}`, { op });
        assert.equal(stem(name(emit(input, language), fold)), 'accumulator', op);
      }
    });

    test('an accumulator initialized from a varying value keeps its role', () => {
      const { input, fold, seed } = counted('fold-seeded', { seeded: true });
      const output = emit(input, language);
      assert.equal(stem(name(output, fold)), 'accumulator');
      // The initial value is the same printed variable, not a second accumulator.
      assert.ok([undefined, name(output, fold)].includes(name(output, seed)), name(output, seed));
    });

    test('an update routed through a conditional merge phi names the whole web once', () => {
      const { input, fold, folded, merged } = counted('fold-merge', { op: 'xor', merge: true });
      const output = emit(input, language);
      // The header phi, the merge phi and the update are one printed variable.
      const names = new Set([fold, merged, folded].flatMap((value) => name(output, value) ?? []));
      assert.equal(names.size, 1, [...names].join());
      assert.equal(stem([...names][0]), 'accumulator');
    });

    test('only the loop-carried fold of an unrolled chain is an accumulator', () => {
      const { input, fold, running, folded } = counted('fold-unrolled', {
        op: 'xor',
        unrolled: true,
      });
      const output = emit(input, language);
      assert.equal(stem(name(output, fold)), 'accumulator');
      // The update itself prints inline or as the same variable.
      assert.ok([undefined, name(output, fold)].includes(name(output, folded)));
      // The running value after the first unrolled step is not a second accumulator.
      assert.match(name(output, running) ?? '', neutral);
    });

    test('a floating-point sum is an accumulator', () => {
      const { input, fold } = counted('fold-float', { float: true });
      assert.equal(stem(name(emit(input, language), fold)), 'accumulator');
    });

    test('a floating-point sum carried as integer bits is one accumulator', () => {
      const b = program('source-names-fold-bits'),
        entry = b.block('entry', [i32]),
        head = b.block('head', [i32, i64]),
        body = b.block('body'),
        exit = b.block('exit', [i64]);
      const bound = entry.parameters[0]!;
      entry.jump(head, [entry.constant(i32, 0n), entry.constant(i64, 0n)]);
      const [index, bits] = head.parameters as [Value, Value];
      head.branch(head.compare('ult', index, bound), head.edge(body), head.edge(exit, [bits]));
      const element = body.load(
        f64,
        body.int(
          'add',
          body.constant(i64, 0x1000n),
          body.cast('zero_extend', i64, body.int('shl', index, body.constant(i32, 3n))),
        ),
      );
      // The sum is the same 64 bits reinterpreted as IEEE binary64 and back.
      const sum = body.fp('add', body.cast('bitcast', f64, bits), element);
      body.jump(head, [
        body.int('add', index, body.constant(i32, 1n)),
        body.cast('bitcast', i64, sum),
      ]);
      exit.return(exit.parameters);
      const output = emit(b.finish(entry, [i64]), language);
      const names = [bits, sum].flatMap((value) => name(output, value) ?? []);
      assert.ok(names.length, output.emission.text);
      for (const identifier of names) assert.equal(stem(identifier), 'accumulator');
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

/** `for (i = 0; i < bound; i++) if (element[i] != 0) out[n++] = element[i];` The
 * guarded `n + 1` reaches the back edge merged with the unchanged `n`, through a
 * join phi or, as an optimizer may leave it, a select. */
function conditionalCounter(label: string, select: boolean) {
  const b = program(`source-names-conditional-${label}`),
    entry = b.block('entry', [i32]),
    head = b.block('head', [i32, i32]),
    body = b.block('body'),
    exit = b.block('exit', [i32]);
  const bound = entry.parameters[0]!;
  entry.jump(head, [entry.constant(i32, 0n), entry.constant(i32, 0n)]);
  const [index, counter] = head.parameters as [Value, Value];
  head.branch(head.compare('ult', index, bound), head.edge(body), head.edge(exit, [counter]));
  const element = body.load(
    i32,
    body.int(
      'add',
      body.constant(i64, 0x1000n),
      body.cast('zero_extend', i64, body.int('shl', index, body.constant(i32, 2n))),
    ),
  );
  const next = body.int('add', index, body.constant(i32, 1n)),
    present = body.compare('ne', element, body.constant(i32, 0n)),
    stepped = body.int('add', counter, body.constant(i32, 1n));
  if (select) body.jump(head, [next, body.select(present, stepped, counter)]);
  else {
    const write = b.block('write'),
      join = b.block('join', [i32]);
    body.branch(present, body.edge(write), body.edge(join, [counter]));
    write.store(
      write.int(
        'add',
        write.constant(i64, 0x2000n),
        write.cast('zero_extend', i64, write.int('shl', counter, write.constant(i32, 2n))),
      ),
      element,
    );
    write.jump(join, [stepped]);
    join.jump(head, [next, join.parameters[0]!]);
  }
  exit.return(exit.parameters);
  return { input: b.finish(entry, [i32]), index, counter, stepped };
}

/** `for (i = 0; i < bound; i++) { run = runs[i]; out[p] = run; p += run; sum += run; }`
 * `p` and `sum` have the same update shape; only `p` is a subscript. */
function cursor(label: string) {
  const b = program(`source-names-cursor-${label}`),
    entry = b.block('entry', [i32]),
    head = b.block('head', [i32, i32, i32]),
    body = b.block('body'),
    exit = b.block('exit', [i32]);
  const bound = entry.parameters[0]!;
  const zero = entry.constant(i32, 0n);
  entry.jump(head, [zero, zero, zero]);
  const [index, position, sum] = head.parameters as [Value, Value, Value];
  head.branch(head.compare('ult', index, bound), head.edge(body), head.edge(exit, [sum]));
  const run = body.load(
    i32,
    body.int(
      'add',
      body.constant(i64, 0x1000n),
      body.cast('zero_extend', i64, body.int('shl', index, body.constant(i32, 2n))),
    ),
  );
  body.store(
    body.int('add', body.constant(i64, 0x2000n), body.cast('zero_extend', i64, position)),
    run,
  );
  body.jump(head, [
    body.int('add', index, body.constant(i32, 1n)),
    body.int('add', position, run),
    body.int('add', sum, run),
  ]);
  exit.return(exit.parameters);
  return { input: b.finish(entry, [i32]), index, position, sum };
}

/** `crc32_combine_gen`-shaped nesting: the outer `p = multmodp(table[k], p)` runs an
 * inner loop folding `acc ^= b` while the shift register `b` (initialized from
 * `p`) steps by `b = b & 1 ? (b >> 1) ^ POLY : b >> 1`; the latch copies the
 * inner accumulator back into `p`. */
function shiftRegister(label: string) {
  const b = program(`source-names-shift-register-${label}`),
    entry = b.block('entry', [i32]),
    outer = b.block('outer', [i32, i32]),
    start = b.block('start'),
    inner = b.block('inner', [i32, i32, i32]),
    latch = b.block('latch'),
    exit = b.block('exit', [i32]);
  entry.jump(outer, [entry.constant(i32, 0x80000000n), entry.parameters[0]!]);
  const [p, n] = outer.parameters as [Value, Value];
  outer.branch(
    outer.compare('ne', n, outer.constant(i32, 0n)),
    outer.edge(start),
    outer.edge(exit, [p]),
  );
  start.jump(inner, [start.constant(i32, 0n), p, start.constant(i32, 0x80000000n)]);
  const [acc, register, mask] = inner.parameters as [Value, Value, Value];
  const folded = inner.int('xor', acc, register),
    shifted = inner.int('lshr', register, inner.constant(i32, 1n));
  const stepped = inner.select(
    inner.compare(
      'ne',
      inner.int('and', register, inner.constant(i32, 1n)),
      inner.constant(i32, 0n),
    ),
    inner.int('xor', shifted, inner.constant(i32, 0xedb88320n)),
    shifted,
  );
  const narrowed = inner.int('lshr', mask, inner.constant(i32, 1n));
  inner.branch(
    inner.compare('ne', narrowed, inner.constant(i32, 0n)),
    inner.edge(inner, [folded, stepped, narrowed]),
    inner.edge(latch),
  );
  latch.jump(outer, [folded, latch.int('lshr', n, latch.constant(i32, 1n))]);
  exit.return(exit.parameters);
  return { input: b.finish(entry, [i32]), p, acc, register, folded };
}

for (const language of ['c-like', 'python-like'] as const)
  describe(`unproven loop roles stay neutral (${language})`, () => {
    test('a counter stepped only on some iterations is not an index', () => {
      for (const select of [false, true]) {
        const { input, index, counter } = conditionalCounter(`${select}`, select);
        const output = emit(input, language);
        assert.doesNotMatch(name(output, counter) ?? '', loopRole, `select ${select}`);
        // The unconditional induction variable of the same loop still is.
        assert.equal(stem(name(output, index)), 'index', `select ${select}`);
      }
    });

    test('a cursor advanced by a varying amount and used as a subscript is not an accumulator', () => {
      const { input, index, position, sum } = cursor('run');
      const output = emit(input, language);
      assert.match(name(output, position) ?? '', neutral);
      assert.equal(stem(name(output, sum)), 'accumulator');
      assert.equal(stem(name(output, index)), 'index');
    });

    test('a shift register copied from an accumulator at the latch is not an accumulator', () => {
      const { input, p, acc, register, folded } = shiftRegister('crc');
      const output = emit(input, language);
      assert.equal(stem(name(output, acc)), 'accumulator');
      assert.equal(stem(name(output, folded)), 'accumulator');
      for (const value of [p, register])
        assert.doesNotMatch(name(output, value) ?? '', /^accumulator/, name(output, value));
    });
  });

const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');
/** The unoptimized form of a counted loop: index, sum and bound live in private
 * frame slots, so the carried variables are slot loads and stores, not phis.
 * `postIncrement` writes `out[index++] = element`: the reload of the old index
 * outlives the store of the new one. `counted` adds `if (element) count++` in a
 * fourth slot, stored only on some iterations. */
function slotLoop(
  label: string,
  options: { shifted?: boolean; postIncrement?: boolean; counted?: boolean } = {},
): SSAForm {
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
  if (options.counted) entry.store(slot(entry, 32n), entry.constant(i64, 0n));
  entry.jump(head);
  head.branch(
    head.compare('ult', head.load(i64, slot(head, 8n)), head.load(i64, slot(head, 24n))),
    head.edge(body),
    head.edge(exit),
  );
  const index = body.load(i64, slot(body, 8n));
  const element = body.load(i64, body.int('add', body.constant(i64, 0x1000n), index));
  body.store(slot(body, 16n), body.int('xor', body.load(i64, slot(body, 16n)), element));
  if (options.shifted)
    body.store(body.constant(i64, 0x2000n), body.int('shl', body.constant(i64, 1n), index));
  if (options.postIncrement) {
    const old = body.load(i64, slot(body, 8n));
    body.store(slot(body, 8n), body.int('add', old, body.constant(i64, 1n)));
    body.store(body.int('add', body.constant(i64, 0x3000n), old), element);
  } else body.store(slot(body, 8n), body.int('add', index, body.constant(i64, 1n)));
  if (options.counted) {
    const bump = b.block('bump');
    body.branch(
      body.compare('ne', element, body.constant(i64, 0n)),
      body.edge(bump),
      body.edge(head),
    );
    bump.store(
      slot(bump, 32n),
      bump.int('add', bump.load(i64, slot(bump, 32n)), bump.constant(i64, 1n)),
    );
    bump.jump(head);
  } else body.jump(head);
  exit.return([
    options.counted
      ? exit.int('add', exit.load(i64, slot(exit, 16n)), exit.load(i64, slot(exit, 32n)))
      : exit.load(i64, slot(exit, 16n)),
  ]);
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
      const text = emitSlots(slotLoop('shifted', { shifted: true }));
      assert.doesNotMatch(text, /\bindex\b/);
      assert.match(text, /\blocal_/);
      assert.match(text, /\baccumulator\b/);
    });
    test('a reload kept for a post-increment is a copy, not a second index', () => {
      const text = emitSlots(slotLoop('post-increment', { postIncrement: true }));
      assert.match(text, /\bindex\b/);
      assert.doesNotMatch(text, /\bindex_\d+\b/);
      // The kept reload exists as its own neutral temporary.
      assert.match(text, /\bvalue\d+ = index\b/);
    });
    test('a slot stored only on some iterations is not an index', () => {
      const text = emitSlots(slotLoop('counted', { counted: true }));
      assert.match(text, /\bindex\b/);
      assert.doesNotMatch(text, /\bindex_\d+\b/);
      assert.match(text, /\blocal_20\b/);
    });
  });

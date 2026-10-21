import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  createOperationContext,
  DEFAULT_ANALYSIS_OPTIONS,
  entityIdentity,
} from '../../../src/core/index.js';
import { IRBuilder, integer, type SSAForm, type Value } from '../../../src/ir/index.js';
import { structureControlFlow } from '../../../src/presentation/index.js';
import { emitC } from '../../../src/emitters/c/index.js';
import { emitPythonLike } from '../../../src/emitters/python-like/index.js';
import type { EmissionResult } from '../../../src/emitters/model.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { recoverTypes } from '../../../src/analysis/types/index.js';
import { builder, image, provenance, register, slice } from '../../ir/support.js';
import { emit as emitWith, emittedFormals, execute } from './support.js';

const evidence = { abi: sysvAMD64Abi, callees: [], addresses: [] };

const i8 = integer(8),
  i32 = integer(32),
  i64 = integer(64);
const program = (name: string): IRBuilder<'ssa'> =>
  new IRBuilder(slice, entityIdentity(slice, 'function', name), provenance, 'ssa');
const emit = (
  input: SSAForm,
  language: 'c-like' | 'python-like',
  view: 'source' | 'checked' = 'source',
  source = false,
): EmissionResult => {
  const structured = structureControlFlow(input, createOperationContext());
  assert.ok(structured.value);
  return (language === 'python-like' ? emitPythonLike : emitC)(
    {
      function: structured.value,
      ...(source ? { source: { abi: sysvAMD64Abi, callees: [], addresses: [] } } : {}),
    },
    { ...DEFAULT_ANALYSIS_OPTIONS, emitter: language, view },
    createOperationContext(),
  );
};
const rules = (output: EmissionResult): string[] =>
  (output.emission.local_validation ?? []).flatMap((record) =>
    record.kind === 'presentation' && record.rule ? [record.rule] : [],
  );
const name = (output: EmissionResult, value: Value): string | undefined =>
  output.identifiers.find((row) => row.entity_id === value.id)?.identifier;
/** Zeroed bytes everywhere the programs touch, with little-endian words at 0x1000. */
const memory = (words: readonly number[] = []): Map<bigint, number> => {
  const bytes = new Map<bigint, number>();
  for (const base of [0x1000n, 0x2000n, 0x3000n, 0x4000n])
    for (let index = 0n; index < 128n; index++) bytes.set(base + index, 0);
  words.forEach((word, index) => bytes.set(0x1000n + BigInt(index * 4), word));
  return bytes;
};

/** `v0 = load; v1 = v0 + 1; v2 = v1 * 3; v3 = v2 ^ 5`, each stored and read once more
 * by its successor. With `interfere`, `v0` is read again after `v1` is defined. */
function chain(interfere: boolean) {
  const b = program(`coalesce-chain-${interfere}`),
    entry = b.block('entry');
  const at = (offset: number): Value => entry.constant(i64, BigInt(0x2000 + offset));
  const v0 = entry.load(i32, entry.constant(i64, 0x1000n));
  entry.store(at(0), v0);
  const v1 = entry.int('add', v0, entry.constant(i32, 1n));
  entry.store(at(4), v1);
  const v2 = entry.int('mul', v1, entry.constant(i32, 3n));
  entry.store(at(8), v2);
  if (interfere) entry.store(at(12), v0);
  const v3 = entry.int('xor', v2, entry.constant(i32, 5n));
  entry.store(at(16), v3);
  entry.return([v3]);
  return { input: b.finish(entry, [i32]), v0, v1, v2, v3 };
}

/** `loop(i, sum): a = sum + i; store a; b = a * 3; next = i + 1`, carrying `next` and
 * `b`. With `interfere`, `sum` is read again after `a` is defined. */
function carried(interfere: boolean) {
  const b = program(`coalesce-carried-${interfere}`),
    entry = b.block('entry'),
    loop = b.block('loop', [i32, i32]),
    exit = b.block('exit', [i32]);
  entry.jump(loop, [entry.constant(i32, 0n), entry.constant(i32, 1n)]);
  const [index, sum] = loop.parameters as [Value, Value];
  const a = loop.int('add', sum, index);
  loop.store(loop.constant(i64, 0x2000n), a);
  if (interfere) loop.store(loop.constant(i64, 0x2004n), sum);
  const product = loop.int('mul', a, loop.constant(i32, 3n));
  const next = loop.int('add', index, loop.constant(i32, 1n));
  loop.branch(
    loop.compare('ne', next, loop.constant(i32, 4n)),
    loop.edge(loop, [next, product]),
    loop.edge(exit, [product]),
  );
  exit.return(exit.parameters);
  return { input: b.finish(entry, [i32]), index, sum, a, product, next };
}

const observe = (output: EmissionResult) => execute(output.emission, new Map(), memory([7]));

for (const language of ['c-like', 'python-like'] as const)
  describe(`copy coalescing ${language}`, () => {
    test('a chain of in-place updates shares one variable exactly when no operand outlives its update', () => {
      for (const interfere of [false, true]) {
        const { input, v0, v1, v2, v3 } = chain(interfere);
        const source = emit(input, language),
          checked = emit(input, language, 'checked');
        assert.ok(rules(source).includes('variable_partition'), source.emission.text);
        assert.ok(!rules(checked).includes('variable_partition'));
        assert.equal(name(source, v1), name(source, v2));
        assert.equal(name(source, v2), name(source, v3));
        // v0 is read after v1 is defined: they are live together and stay apart.
        if (interfere) assert.notEqual(name(source, v0), name(source, v1));
        else assert.equal(name(source, v0), name(source, v1));
        const expected = observe(checked);
        const actual = observe(source);
        assert.deepEqual(actual.values, expected.values);
        assert.deepEqual([...actual.memory], [...expected.memory]);
        assert.deepEqual(actual.events, expected.events);
        assert.deepEqual(actual.values, [((7n + 1n) * 3n) ^ 5n]);
        assert.equal(actual.memory.get(0x2008n), 24);
      }
    });

    test('a loop-carried update merges through the phi unless the old carried value is still read', () => {
      for (const interfere of [false, true]) {
        const { input, sum, a, product, index, next } = carried(interfere);
        const source = emit(input, language),
          checked = emit(input, language, 'checked');
        assert.equal(name(source, sum), name(source, product));
        assert.equal(name(source, index), name(source, next));
        // `sum` is still read after `a` is defined: `a` cannot take its storage.
        if (interfere) assert.notEqual(name(source, a), name(source, sum));
        else assert.equal(name(source, a), name(source, sum));
        assert.ok(rules(source).includes('variable_partition'), source.emission.text);
        const expected = observe(checked),
          actual = observe(source);
        assert.deepEqual(actual.values, expected.values);
        assert.deepEqual([...actual.memory], [...expected.memory]);
        assert.deepEqual(actual.events, expected.events);
      }
    });

    test('unrelated temporaries never share a variable, even with disjoint live ranges', () => {
      for (const overlap of [false, true]) {
        const b = program(`coalesce-reuse-${overlap}`),
          entry = b.block('entry');
        const at = (offset: number): Value => entry.constant(i64, BigInt(offset));
        const first = entry.load(i32, at(0x1000));
        entry.store(at(0x2000), first);
        entry.store(at(0x2004), first);
        const second = entry.load(i32, at(0x1004));
        entry.store(at(0x2008), second);
        entry.store(at(0x200c), second);
        // Read after `second` is defined: the two are live together.
        if (overlap) entry.store(at(0x2010), first);
        const wide = entry.load(i64, at(0x1008));
        entry.store(at(0x2018), wide);
        entry.store(at(0x2020), wide);
        entry.return([second]);
        const input = b.finish(entry, [i32]);
        const source = emit(input, language),
          checked = emit(input, language, 'checked');
        assert.notEqual(name(source, first), name(source, second));
        // A different machine width is a different variable.
        assert.notEqual(name(source, wide), name(source, first));
        assert.notEqual(name(source, wide), name(source, second));
        const expected = observe(checked),
          actual = observe(source);
        assert.deepEqual(actual.values, expected.values);
        assert.deepEqual([...actual.memory], [...expected.memory]);
        assert.deepEqual(actual.events, expected.events);
      }
    });

    test('a loop swapping two carried values keeps them in separate variables', () => {
      // loop(a, b, i): store a; t = a; a = b; b = t; i++ while i != 3; return a - b.
      const b = program('coalesce-swap'),
        entry = b.block('entry'),
        loop = b.block('loop', [i32, i32, i32]),
        exit = b.block('exit', [i32, i32]);
      entry.jump(loop, [entry.constant(i32, 5n), entry.constant(i32, 2n), entry.constant(i32, 0n)]);
      const [first, second, index] = loop.parameters as [Value, Value, Value];
      loop.store(
        loop.int('add', loop.constant(i64, 0x2000n), loop.cast('zero_extend', i64, index)),
        first,
      );
      const next = loop.int('add', index, loop.constant(i32, 1n));
      loop.branch(
        loop.compare('ne', next, loop.constant(i32, 3n)),
        loop.edge(loop, [second, first, next]),
        loop.edge(exit, [second, first]),
      );
      const [left, right] = exit.parameters as [Value, Value];
      exit.return([exit.int('sub', left, right)]);
      const input = b.finish(entry, [i32]);
      const source = emit(input, language),
        checked = emit(input, language, 'checked');
      assert.notEqual(name(source, first), name(source, second), source.emission.text);
      const expected = observe(checked),
        actual = observe(source);
      assert.deepEqual(actual.values, expected.values);
      assert.deepEqual([...actual.memory], [...expected.memory]);
      // Three iterations swap (5, 2) twice; the exit edge swaps once more: 2 - 5.
      assert.equal(BigInt.asUintN(32, actual.values[0]!), 0xfffffffdn);
    });

    test('a narrow value zero-extended into a wider phi shares its storage only when it is int-wide and the extensions are its only reads; high bits stay zero', () => {
      for (const [bits, withSource, read] of [
        [16, false, false],
        [32, false, false],
        [16, true, false],
        [32, true, false],
        [32, true, true],
      ] as const) {
        // v = ~(uintN)word; odd words store v (`read`) or the word; both edges pass
        // zext64(v); return it. The extra narrow read would need a conversion, and a
        // 16-bit `~` promotes to signed int in C, so its wide definition would too.
        const b = program(`coalesce-widen-${bits}-${withSource}-${read}`),
          entry = b.block('entry'),
          odd = b.block('odd'),
          even = b.block('even'),
          join = b.block('join', [i64]);
        const word = entry.load(i32, entry.constant(i64, 0x1000n));
        const narrow = bits === 32 ? word : entry.cast('truncate', integer(16), word);
        const v = entry.unary('not', narrow);
        entry.branch(
          entry.compare(
            'ne',
            entry.int('and', word, entry.constant(i32, 1n)),
            entry.constant(i32, 0n),
          ),
          entry.edge(odd),
          entry.edge(even),
        );
        odd.store(odd.constant(i64, 0x2000n), read ? v : word);
        odd.jump(join, [odd.cast('zero_extend', i64, v)]);
        even.jump(join, [even.cast('zero_extend', i64, v)]);
        const [merged] = join.parameters as [Value];
        join.return([merged]);
        const input = b.finish(entry, [i64]);
        const source = emit(input, language, 'source', withSource),
          checked = emit(input, language, 'checked', withSource);
        if (read || bits === 16)
          assert.notEqual(name(source, v), name(source, merged), source.emission.text);
        else {
          assert.ok(rules(source).includes('variable_partition'), source.emission.text);
          assert.equal(name(source, v), name(source, merged), source.emission.text);
          // The even edge only carried the dropped copy: no empty `else` arm prints.
          assert.doesNotMatch(source.emission.text, /\belse\b/, source.emission.text);
        }
        for (const word of [0, 1, 0x7f, 0xfe]) {
          const bytes = memory([word]);
          const expected = execute(checked.emission, new Map(), bytes),
            actual = execute(source.emission, new Map(), bytes);
          assert.deepEqual(actual.values, expected.values, `${bits} ${word}`);
          assert.deepEqual([...actual.memory], [...expected.memory]);
          const mask = (1n << BigInt(bits)) - 1n;
          assert.deepEqual(actual.values, [~BigInt(word) & mask], `${bits} ${word}`);
        }
      }
    });
  });

const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');
/** `p = arg; while (i < n) { old = p; p = old + 1; out[old] = in[old]; i++ }` over private
 * frame slots: the reload of the pointer outlives the store of its successor. `peek` reads
 * the slot between the update and the reader, which must observe the new value. */
function postIncrement(peek: boolean): SSAForm {
  const b = builder(`coalesce-post-increment-${peek}`),
    entry = b.block('entry'),
    head = b.block('head'),
    body = b.block('body'),
    exit = b.block('exit');
  const slot = (block: typeof entry, offset: bigint): Value =>
    block.int('sub', block.readRegister(sysvAMD64Abi.stack_pointer), block.constant(i64, offset));
  entry.store(slot(entry, 24n), entry.readRegister(rdi));
  entry.store(slot(entry, 8n), entry.constant(i64, 0n));
  entry.jump(head);
  head.branch(
    head.compare('ult', head.load(i64, slot(head, 8n)), head.load(i64, slot(head, 24n))),
    head.edge(body),
    head.edge(exit),
  );
  const old = body.load(i64, slot(body, 8n));
  body.store(slot(body, 8n), body.int('add', old, body.constant(i64, 1n)));
  if (peek) body.store(body.constant(i64, 0x4000n), body.load(i64, slot(body, 8n)));
  const element = body.load(i8, body.int('add', body.constant(i64, 0x1000n), old));
  body.store(body.int('add', body.constant(i64, 0x3000n), old), element);
  body.jump(head);
  exit.return([exit.load(i64, slot(exit, 8n))]);
  return constructSSA(b.finish(entry, [i64])).value as SSAForm;
}

for (const language of ['c-like', 'python-like'] as const)
  describe(`post-update ordering ${language}`, () => {
    const run = (output: EmissionResult, count: bigint) => {
      const formal = emittedFormals(output.emission)[0]!;
      return execute(
        output.emission,
        new Map([[formal.statement_id, count]]),
        memory([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      );
    };
    test('the reload of an updated slot reads the slot itself and the update prints after its reader', () => {
      const output = emit(postIncrement(false), language, 'source', true);
      const text = output.emission.text;
      assert.ok(rules(output).includes('local_load_reuse'), text);
      assert.doesNotMatch(text, /\bvalue\d+ = \w+\n|\bvalue\d+ = \w+;/);
      const store = text.search(/0x3000/),
        update = text.search(/\n\s+(\w+) = [^\n]*\b\1 \+ 1/);
      assert.ok(store >= 0 && update > store, text);
      // The checked view keeps the reload and prints no such rule.
      assert.ok(
        !rules(emit(postIncrement(false), language, 'checked')).includes('local_load_reuse'),
      );
      for (const count of [0n, 1n, 4n]) {
        const observed = run(output, count);
        assert.deepEqual(observed.values, [count]);
        const input = memory([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        for (let index = 0n; index < 8n; index++)
          assert.equal(
            observed.memory.get(0x3000n + index),
            index < count ? input.get(0x1000n + index) : 0,
          );
      }
    });

    test('a read of the slot between the update and the reader keeps the reload', () => {
      const output = emit(postIncrement(true), language, 'source', true);
      assert.ok(!rules(output).includes('local_load_reuse'), output.emission.text);
      for (const count of [1n, 3n]) {
        const observed = run(output, count);
        // The peek observed the already updated slot on the last iteration.
        assert.equal(observed.memory.get(0x4000n), Number(count));
        assert.deepEqual(observed.values, [count]);
      }
    });
  });

/** `x = load; p = odd(x) ? x : x + 5; store p; return p`. With `interfere`, `x` is
 * stored again after the join, so it is live where `p` is bound. */
function joined(interfere: boolean) {
  const b = program(`partition-join-${interfere}`),
    entry = b.block('entry'),
    odd = b.block('odd'),
    even = b.block('even'),
    join = b.block('join', [i32]);
  const x = entry.load(i32, entry.constant(i64, 0x1000n));
  entry.branch(
    entry.compare('ne', entry.int('and', x, entry.constant(i32, 1n)), entry.constant(i32, 0n)),
    entry.edge(odd),
    entry.edge(even),
  );
  odd.jump(join, [x]);
  const y = even.int('add', x, even.constant(i32, 5n));
  even.store(even.constant(i64, 0x2008n), y);
  even.jump(join, [y]);
  const [p] = join.parameters as [Value];
  join.store(join.constant(i64, 0x2000n), p);
  if (interfere) join.store(join.constant(i64, 0x2004n), x);
  join.return([p]);
  return { input: b.finish(entry, [i32]), x, y, p };
}

const rsi = register('rsi', 64, 0, 'replace_root', 'x86_64:rsi');
/** `if (n) { p = *(uint64_t *)0x3000; } return *p;` where `p` is a formal typed
 * `uint32_t *` and the loaded address is a plain integer. With `interfere`, the
 * formal is written through after the load, so both are live there. */
function retyped(interfere: boolean) {
  const b = builder(`partition-retyped-${interfere}`),
    entry = b.block('entry'),
    other = b.block('other'),
    join = b.block('join');
  entry.branch(
    entry.compare('ne', entry.readRegister(rsi), entry.constant(i64, 0n)),
    entry.edge(other),
    entry.edge(join),
  );
  const loaded = other.load(i64, other.constant(i64, 0x3000n));
  if (interfere) other.store(other.readRegister(rdi), other.constant(i32, 0x55n));
  other.writeRegister(rdi, loaded);
  other.jump(join);
  join.return([join.cast('zero_extend', i64, join.load(i32, join.readRegister(rdi)))]);
  const ssa = constructSSA(b.finish(entry, [i64])).value as SSAForm;
  const formal = ssa.register_states
    .find((state) => state.block === ssa.entry)!
    .entry.find((binding) => binding.register.root === rdi.root)!.value;
  const record = { source: 'debug', status: 'established', evidence_ids: [] } as const;
  const types = recoverTypes(ssa, sysvAMD64Abi, createOperationContext(), {
    slice_id: slice,
    image_id: image,
    revision: 1,
    types: [
      { id: 'word', definition: { kind: 'integer', bits: 32, signed: false }, ...record },
      { id: 'word-pointer', definition: { kind: 'pointer', bits: 64, to: 'word' }, ...record },
    ],
    bindings: [{ subject_id: formal.id, type_id: 'word-pointer', ...record }],
  });
  return { ssa, types, loaded };
}

for (const language of ['c-like', 'python-like'] as const)
  describe(`variable partition ${language}`, () => {
    test('an incoming argument shares the parameter variable unless it is live at the join, where its edge copy stays', () => {
      for (const interfere of [false, true]) {
        const { input, x, y, p } = joined(interfere);
        const source = emit(input, language),
          checked = emit(input, language, 'checked');
        const text = source.emission.text;
        // The in-place update and its phi share one variable either way.
        assert.equal(name(source, y), name(source, p), text);
        if (interfere) {
          assert.notEqual(name(source, x), name(source, p), text);
          // The interfering pair keeps exactly one explicit copy on its edge.
          const copy = new RegExp(`\\b${name(source, p)} = ${name(source, x)}\\b`, 'g');
          assert.equal(text.match(copy)?.length, 1, text);
        } else assert.equal(name(source, x), name(source, p), text);
        for (const word of [0, 1, 6, 7, 0xfffffffe]) {
          const bytes = memory([word]);
          const expected = execute(checked.emission, new Map(), bytes),
            actual = execute(source.emission, new Map(), bytes);
          assert.deepEqual(actual.values, expected.values, `${interfere} ${word}`);
          assert.deepEqual([...actual.memory], [...expected.memory]);
        }
      }
    });

    test('a member presented with another type defines the variable through one exact conversion', () => {
      for (const interfere of [false, true]) {
        const { ssa, types, loaded } = retyped(interfere);
        const output = emitWith(ssa, { types, source: evidence }, language),
          checked = emitWith(ssa, { types, source: evidence }, language, 'checked');
        const text = output.emission.text;
        const pointer = emittedFormals(output.emission)[0]!.name;
        if (interfere) {
          // Both live after the load: the loaded value keeps its own variable
          // and the edge copies it into the formal's once.
          assert.notEqual(name(output, loaded), pointer, text);
          assert.equal(text.match(new RegExp(`^\\s*${pointer} = `, 'gm'))?.length, 1, text);
        } else {
          assert.equal(name(output, loaded), pointer, text);
          // The load defines the pointer variable itself, converted once (C).
          assert.match(
            text,
            language === 'c-like'
              ? new RegExp(`\\b${pointer} = \\(uint32_t\\*\\)\\*\\(uint64_t \\*\\)`)
              : new RegExp(`\\b${pointer} = memory\\.u64\\[`),
          );
        }
        const run = (emitted: EmissionResult, taken: bigint) => {
          // *(uint64_t *)0x3000 = 0x2010, *(uint32_t *)0x2010 = 0x11223344, formal 0x1008.
          const bytes = memory([0x11111111, 0x22222222, 0x33333333]);
          [0x10, 0x20, 0, 0, 0, 0, 0, 0].forEach((byte, i) => bytes.set(0x3000n + BigInt(i), byte));
          [0x44, 0x33, 0x22, 0x11].forEach((byte, i) => bytes.set(0x2010n + BigInt(i), byte));
          const inputs = new Map<string, bigint>();
          emittedFormals(emitted.emission).forEach((row, position) => {
            for (const id of row.semantic_ids) inputs.set(id, position === 0 ? 0x1008n : taken);
          });
          return execute(emitted.emission, inputs, bytes);
        };
        for (const taken of [0n, 1n]) {
          const expected = run(checked, taken),
            actual = run(output, taken);
          assert.deepEqual(actual.values, expected.values, text);
          assert.deepEqual([...actual.memory], [...expected.memory]);
          assert.deepEqual(actual.values, [taken ? 0x11223344n : 0x33333333n]);
        }
      }
    });
  });

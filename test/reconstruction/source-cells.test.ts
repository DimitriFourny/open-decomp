import assert from 'node:assert/strict';
import test from 'node:test';
import { darwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { simplifySSA } from '../../src/analysis/values/index.js';
import { createOperationContext, type RegisterDescriptor } from '../../src/core/index.js';
import {
  effectType,
  integer,
  type Expression,
  type RegisterBinding,
  type SSAForm,
  type Value,
} from '../../src/ir/index.js';
import type { BlockRegion, ParallelTransfer } from '../../src/presentation/index.js';
import { LocalValidationSession } from '../../src/reconstruction/local-validation.js';
import { recombineSourceCells } from '../../src/reconstruction/source-cells.js';
import type { InferredCallee } from '../../src/reconstruction/source-model.js';
import { emit, execute, type SourceCallOracle } from '../emitters/c/support.js';
import { builder, image, provenance, register } from '../ir/support.js';

/** The source planner's cell interface over one test's definition map; whole
 * instruction outputs are collected in `outputs`. */
function cellPlan(
  definitions: Map<string, Expression>,
  outputs = new Map<string, readonly RegisterBinding[]>(),
): Parameters<typeof recombineSourceCells>[5] {
  return {
    make: (key, type, _block, expression) => {
      if (expression) definitions.set(key, expression);
      return { id: key, type };
    },
    alias: (target, expression) => {
      definitions.set(target.id, expression);
    },
    outputs: (node, bindings) => {
      outputs.set(node.id, bindings);
    },
  };
}

const recombined = [
  'whole',
  'constant',
  'zero-extend',
  'sign-extend',
  'sign-extend-slice',
  'carried',
] as const;
for (const scenario of [
  ...recombined,
  'different-base',
  'wrong-offset',
  'independent-high',
  'unread',
  'partial-root',
  'missing-edge',
  'record-bound',
] as const) {
  test(`register cell recombination: ${scenario}`, () => {
    const value = (id: string, bits = 32): Value => ({ id, type: integer(bits) });
    const low = value('low'),
      high = value('high'),
      a = value('a', 64),
      b = value('b', 64),
      narrow = value('narrow'),
      extended = value('extended', 64),
      truncated = value('truncated'),
      widened = value('widened', 64);
    const aLow = value('a-low'),
      aHigh = value('a-high'),
      bLow = value('b-low'),
      bHigh = value('b-high');
    const effect = { id: 'effect', type: effectType };
    const block: BlockRegion = {
      id: 'join',
      kind: 'block',
      provenance,
      parameters: [low, high],
      effect_parameter: effect,
      dominator: null,
      register_exit: [],
      statements: [],
      register_entry: [
        { register: register('lo', 32), value: low },
        ...(scenario === 'partial-root' ? [] : [{ register: register('hi', 32, 32), value: high }]),
      ],
      control: { id: 'return', kind: 'return', provenance, values: [], effect },
    };
    const transfer = (lo: Value, hi: Value, omit = false): ParallelTransfer => ({
      kind: 'transfer',
      target: block.id,
      mode: 'next',
      effect: { source: effect, destination: effect },
      copies: [
        { destination: low, source: lo },
        ...(omit ? [] : [{ destination: high, source: hi }]),
      ],
    });
    // The first edge enters the loop; the second is its back edge.
    const first = transfer(aLow, aHigh),
      second =
        scenario === 'carried'
          ? transfer(low, high)
          : transfer(bLow, bHigh, scenario === 'missing-edge');
    const first32: Record<(typeof recombined)[number], [Expression, Expression]> = {
      whole: [
        { kind: 'extract', value: a, offset: 0 },
        { kind: 'extract', value: a, offset: 32 },
      ],
      carried: [
        { kind: 'extract', value: a, offset: 0 },
        { kind: 'extract', value: a, offset: 32 },
      ],
      // A 32-bit immediate write that clears the upper cell.
      constant: [
        { kind: 'constant', bits: 0x80000000n },
        { kind: 'constant', bits: 0n },
      ],
      // A 32-bit arithmetic write that clears the upper cell.
      'zero-extend': [
        { kind: 'cast', op: 'bitcast', value: narrow },
        { kind: 'constant', bits: 0n },
      ],
      // A sign-extending write: the upper cell slices sign_extend(low).
      'sign-extend': [
        { kind: 'cast', op: 'bitcast', value: narrow },
        { kind: 'extract', value: extended, offset: 32 },
      ],
      // movsxd from the low half of a 64-bit value: the low cells slice that
      // value, the upper cell slices sign_extend(its low half).
      'sign-extend-slice': [
        { kind: 'extract', value: a, offset: 0 },
        { kind: 'extract', value: widened, offset: 32 },
      ],
    };
    const [lowSource, highSource] = (recombined as readonly string[]).includes(scenario)
      ? first32[scenario as (typeof recombined)[number]]
      : first32.whole;
    const definitions = new Map<string, Expression>([
      [aLow.id, lowSource],
      [aHigh.id, highSource],
      [extended.id, { kind: 'cast', op: 'sign_extend', value: narrow }],
      [truncated.id, { kind: 'cast', op: 'truncate', value: a }],
      [widened.id, { kind: 'cast', op: 'sign_extend', value: truncated }],
      [bLow.id, { kind: 'extract', value: b, offset: 0 }],
      [
        bHigh.id,
        {
          kind: 'extract',
          value: scenario === 'different-base' ? a : b,
          offset: scenario === 'wrong-offset' ? 0 : 32,
        },
      ],
    ]);
    // An independently computed upper cell is an opaque 32-bit value.
    if (scenario === 'independent-high') definitions.delete(aHigh.id);
    // The loop reads both cells as one 64-bit register.
    if (scenario !== 'unread') definitions.set('read', { kind: 'concat', values: [low, high] });
    const incoming = new Map([
      [low.id, [aLow, second.copies[0]!.source]],
      [high.id, [aHigh, second.copies[1]?.source ?? bHigh]],
    ]);
    const blocks = new Map([[block.id, block]]),
      context = createOperationContext();
    const validation = new LocalValidationSession(context);
    if (scenario === 'record-bound')
      for (let index = 0; index < 256; index++)
        validation.presentation('fixture', String(index), `record capacity ${index}`);
    const result = recombineSourceCells(
      blocks,
      [
        { transfer: first, block },
        { transfer: second, block },
      ],
      definitions,
      new Map(),
      incoming,
      cellPlan(definitions),
      validation,
      context,
    );
    if ((recombined as readonly string[]).includes(scenario)) {
      const whole = result.get(first)![0]!.destination;
      const entered = result.get(first)![0]!.source;
      assert.deepEqual(result.get(first), [{ destination: whole, source: entered }]);
      const repeated = scenario === 'carried' ? whole : b;
      assert.deepEqual(result.get(second), [{ destination: whole, source: repeated }]);
      assert.deepEqual(definitions.get(low.id), { kind: 'extract', value: whole, offset: 0 });
      assert.deepEqual(definitions.get(high.id), { kind: 'extract', value: whole, offset: 32 });
      assert.deepEqual(incoming.get(whole.id), [entered, repeated]);
      assert.ok(blocks.get(block.id)!.parameters.includes(whole));
      assert.ok(validation.records.some((record) => record.rule === 'register_cell_recombination'));
      if (scenario === 'whole' || scenario === 'carried') assert.equal(entered, a);
      else if (scenario === 'sign-extend') assert.equal(entered, extended);
      else if (scenario === 'sign-extend-slice') assert.equal(entered, widened);
      else if (scenario === 'constant')
        assert.deepEqual(definitions.get(entered.id), { kind: 'constant', bits: 0x80000000n });
      else
        assert.deepEqual(definitions.get(entered.id), {
          kind: 'cast',
          op: 'zero_extend',
          value: narrow,
        });
    } else {
      assert.equal(result.size, 0);
      assert.equal(definitions.has(low.id), false);
      assert.equal(definitions.has(high.id), false);
      assert.equal(blocks.get(block.id), block);
    }
    assert.equal(first.copies.length, 2, 'original machine transfer remains immutable');
  });
}

type Unavailable = Extract<Expression, { kind: 'indeterminate' }>;
for (const scenario of ['same-reason', 'different-reason', 'undefined-state', 'mixed'] as const)
  test(`register cell recombination of unavailable cells: ${scenario}`, () => {
    const value = (id: string, bits = 32): Value => ({ id, type: integer(bits) });
    const low = value('low'),
      high = value('high'),
      b = value('b', 64),
      unknownLow = value('unknown-low'),
      unknownHigh = value('unknown-high'),
      bLow = value('b-low'),
      bHigh = value('b-high');
    const effect = { id: 'effect', type: effectType };
    const block: BlockRegion = {
      id: 'join',
      kind: 'block',
      provenance,
      parameters: [low, high],
      effect_parameter: effect,
      dominator: null,
      register_exit: [],
      statements: [],
      register_entry: [
        { register: register('lo', 32), value: low },
        { register: register('hi', 32, 32), value: high },
      ],
      control: { id: 'return', kind: 'return', provenance, values: [], effect },
    };
    const transfer = (lo: Value, hi: Value): ParallelTransfer => ({
      kind: 'transfer',
      target: block.id,
      mode: 'next',
      effect: { source: effect, destination: effect },
      copies: [
        { destination: low, source: lo },
        { destination: high, source: hi },
      ],
    });
    const first = transfer(unknownLow, unknownHigh),
      second = transfer(bLow, bHigh);
    const unavailable = (reason: string, state: Unavailable['state'] = 'unknown'): Expression => ({
      kind: 'indeterminate',
      state,
      reason,
    });
    const definitions = new Map<string, Expression>([
      [unknownLow.id, unavailable('non-argument entry register')],
      [
        unknownHigh.id,
        unavailable(
          scenario === 'different-reason' ? 'FPCR environment' : 'non-argument entry register',
          scenario === 'undefined-state' ? 'undefined' : 'unknown',
        ),
      ],
      [bLow.id, { kind: 'extract', value: b, offset: 0 }],
      [bHigh.id, { kind: 'extract', value: b, offset: 32 }],
    ]);
    if (scenario === 'mixed') definitions.set(unknownHigh.id, { kind: 'constant', bits: 1n });
    // The loop reads both cells as one 64-bit register.
    definitions.set('read', { kind: 'concat', values: [low, high] });
    const incoming = new Map([
      [low.id, [unknownLow, bLow]],
      [high.id, [unknownHigh, bHigh]],
    ]);
    const blocks = new Map([[block.id, block]]),
      context = createOperationContext();
    const validation = new LocalValidationSession(context);
    const result = recombineSourceCells(
      blocks,
      [
        { transfer: first, block },
        { transfer: second, block },
      ],
      definitions,
      new Map(),
      incoming,
      cellPlan(definitions),
      validation,
      context,
    );
    if (scenario !== 'same-reason') {
      assert.equal(result.size, 0);
      assert.deepEqual(blocks.get(block.id)!.parameters, [low, high]);
      return;
    }
    const whole = result.get(first)![0]!.destination;
    const entered = result.get(first)![0]!.source;
    assert.deepEqual(definitions.get(entered.id), unavailable('non-argument entry register'));
    assert.equal(entered.type.kind === 'integer' && entered.type.bits, 64);
    assert.deepEqual(result.get(second), [{ destination: whole, source: b }]);
    assert.deepEqual(definitions.get(low.id), { kind: 'extract', value: whole, offset: 0 });
    assert.deepEqual(definitions.get(high.id), { kind: 'extract', value: whole, offset: 32 });
    assert.ok(validation.records.some((record) => record.rule === 'register_cell_recombination'));
  });

// A pointer assembled per arm from two 32-bit cells: `lo = A; hi = 1` on one
// edge and `lo = B; hi = 1` on the other. Range analysis folds the upper cell
// to its one constant (`folded`) before cell recombination runs.
for (const scenario of [
  'varying-constants',
  'folded-high',
  'folded-high-nonconstant-edge',
  'nonconstant-edge',
] as const)
  test(`register cell recombination of constant cells: ${scenario}`, () => {
    const value = (id: string, bits = 32): Value => ({ id, type: integer(bits) });
    const low = value('low'),
      high = value('high'),
      narrow = value('narrow'),
      aLow = value('a-low'),
      aHigh = value('a-high'),
      bLow = value('b-low'),
      bHigh = value('b-high');
    const effect = { id: 'effect', type: effectType };
    const block: BlockRegion = {
      id: 'join',
      kind: 'block',
      provenance,
      parameters: [low, high],
      effect_parameter: effect,
      dominator: null,
      register_exit: [],
      statements: [],
      register_entry: [
        { register: register('lo', 32), value: low },
        { register: register('hi', 32, 32), value: high },
      ],
      control: { id: 'return', kind: 'return', provenance, values: [], effect },
    };
    const transfer = (lo: Value, hi: Value): ParallelTransfer => ({
      kind: 'transfer',
      target: block.id,
      mode: 'next',
      effect: { source: effect, destination: effect },
      copies: [
        { destination: low, source: lo },
        { destination: high, source: hi },
      ],
    });
    const first = transfer(aLow, aHigh),
      second = transfer(bLow, bHigh);
    const folded = scenario === 'folded-high' || scenario === 'folded-high-nonconstant-edge';
    const definitions = new Map<string, Expression>([
      [aLow.id, { kind: 'constant', bits: 0x60ce8n }],
      [aHigh.id, { kind: 'constant', bits: scenario === 'varying-constants' ? 2n : 1n }],
      [bLow.id, { kind: 'constant', bits: 0x60ae0n }],
      [bHigh.id, { kind: 'constant', bits: 1n }],
    ]);
    // The second edge's low cell is computed, not constant.
    if (scenario === 'nonconstant-edge' || scenario === 'folded-high-nonconstant-edge')
      definitions.set(bLow.id, { kind: 'cast', op: 'bitcast', value: narrow });
    if (folded) definitions.set(high.id, { kind: 'constant', bits: 1n });
    definitions.set('read', { kind: 'concat', values: [low, high] });
    const incoming = new Map([
      [low.id, [aLow, bLow]],
      [high.id, [aHigh, bHigh]],
    ]);
    const blocks = new Map([[block.id, block]]),
      context = createOperationContext();
    const validation = new LocalValidationSession(context);
    const result = recombineSourceCells(
      blocks,
      [
        { transfer: first, block },
        { transfer: second, block },
      ],
      definitions,
      new Map(),
      incoming,
      cellPlan(definitions),
      validation,
      context,
    );
    if (scenario !== 'varying-constants' && scenario !== 'folded-high') {
      // Any edge whose cells are not constants keeps every cell separate.
      assert.equal(result.size, 0);
      assert.deepEqual(blocks.get(block.id)!.parameters, [low, high]);
      assert.deepEqual(incoming.get(low.id), [aLow, bLow]);
      return;
    }
    const whole = result.get(first)![0]!.destination;
    const wholeFirst = result.get(first)![0]!.source,
      wholeSecond = result.get(second)![0]!.source;
    // One whole-width parameter, one whole constant per edge: low | high << 32.
    assert.deepEqual(definitions.get(wholeFirst.id), {
      kind: 'constant',
      bits: scenario === 'varying-constants' ? 0x2_00060ce8n : 0x1_00060ce8n,
    });
    assert.deepEqual(definitions.get(wholeSecond.id), { kind: 'constant', bits: 0x1_00060ae0n });
    assert.equal(whole.type.kind === 'integer' && whole.type.bits, 64);
    assert.deepEqual(incoming.get(whole.id), [wholeFirst, wholeSecond]);
    assert.equal(incoming.has(low.id) || incoming.has(high.id), false);
    assert.deepEqual(definitions.get(low.id), { kind: 'extract', value: whole, offset: 0 });
    assert.deepEqual(definitions.get(high.id), { kind: 'extract', value: whole, offset: 32 });
    assert.ok(blocks.get(block.id)!.parameters.includes(whole));
    // Every recombined constant was proved on its own edge.
    const proofs = validation.records.filter((record) => record.kind === 'bitvector');
    assert.equal(proofs.length, 2);
    assert.ok(proofs.every((record) => record.status === 'verified'));
    assert.deepEqual(
      proofs.map((record) => record.subject_ids),
      [
        [aLow.id, aHigh.id],
        [bLow.id, bHigh.id],
      ],
    );
    assert.ok(validation.records.some((record) => record.rule === 'register_cell_recombination'));
    assert.equal(first.copies.length, 2, 'original machine transfer remains immutable');
  });

// Calls on Darwin arm64 (analyzed IR, nothing native executes). `left` calls
// sub_2000, which clobbers the integer result register x0 (or vector v0); `right`
// writes the root, and the join reads it whole. The unprojected outputs of the
// call are one whole value of the root in the source view, never a pair of
// per-cell unknowns; a projected 32-bit result stays the low half of x0.
const clobbers = darwinArm64Abi.unknown_call_clobbers;
const x0 = clobbers.registers.find(
  ({ root, width_bits }) => root === 'arm64:x0' && width_bits === 64,
)!;
const w0: RegisterDescriptor = {
  ...x0,
  id: 'arm64:w0',
  width_bits: 32,
  write_rule: 'zero_extend_root',
};
const v0 = clobbers.registers.find(({ root }) => root === 'arm64:v0')!;
const s0: RegisterDescriptor = {
  ...v0,
  id: 'arm64:s0',
  width_bits: 32,
  write_rule: 'zero_extend_root',
};
const u128 = integer(128),
  mask64 = (1n << 64n) - 1n;

function callJoin(root: 'x0' | 'v0', returns: 'unprojected' | 'w0') {
  const b = builder(`source-cells-call-${root}-${returns}`),
    entry = b.block('entry'),
    left = b.block('left'),
    right = b.block('right'),
    join = b.block('join');
  const n = entry.readRegister(x0);
  entry.branch(
    entry.compare('eq', n, entry.constant(integer(64), 0n)),
    entry.edge(left),
    entry.edge(right),
  );
  left.call(
    { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
    [],
    [],
    clobbers,
  );
  left.jump(join);
  if (root === 'x0') {
    // `add w0, w0, #1` clears the upper cell; the join reads x0 whole.
    right.writeRegister(
      w0,
      right.int('add', right.cast('truncate', integer(32), n), right.constant(integer(32), 1n)),
    );
    right.jump(join);
    join.return([join.int('add', join.readRegister(x0), join.constant(integer(64), 5n))]);
  } else {
    // `ldr q0, [x0]`; the join reads s0 and all of v0.
    right.writeRegister(v0, right.load(u128, n));
    right.jump(join);
    const low = join.readRegister(s0),
      whole = join.readRegister(v0, u128);
    const high = join.cast(
      'truncate',
      integer(64),
      join.int('lshr', whole, join.constant(u128, 64n)),
    );
    join.return([
      join.int(
        'add',
        join.cast('zero_extend', integer(64), low),
        join.int('xor', high, join.cast('truncate', integer(64), whole)),
      ),
    ]);
  }
  const constructed = constructSSA(b.finish(entry, [integer(64)]));
  assert.equal(constructed.value.form, 'ssa');
  const ir = simplifySSA(constructed.value as SSAForm).value;
  const callees = ir.blocks.flatMap(({ instructions }) =>
    instructions.flatMap((node): InferredCallee[] =>
      node.kind === 'call'
        ? [
            {
              call_id: node.id,
              parameters: [],
              returns: returns === 'w0' ? [w0] : [],
              return_types: returns === 'w0' ? [integer(32)] : [],
              argument_list_complete: true,
              evidence_ids: [],
            },
          ]
        : [],
    ),
  );
  return { ir, source: { abi: darwinArm64Abi, callees, addresses: [] } };
}

/** What the call leaves in the root, named by every cell reason either view prints. */
function clobbered(root: 'x0' | 'v0', bits: bigint): Map<string, bigint> {
  const cells: [string, number, number][] =
    root === 'x0'
      ? [
          ['', 0, 64],
          ['_low32', 0, 32],
          ['_high32', 32, 32],
        ]
      : [
          ['', 0, 128],
          ['_low32', 0, 32],
          ['_bits32_63', 32, 32],
          ['_high64', 64, 64],
          ['_high96', 32, 96],
        ];
  return new Map(
    cells.map(([suffix, offset, width]) => [
      `call clobbers ${root}${suffix}`,
      BigInt.asUintN(width, bits >> BigInt(offset)),
    ]),
  );
}

for (const language of ['c-like', 'python-like'] as const)
  for (const [root, returns] of [
    ['x0', 'unprojected'],
    ['x0', 'w0'],
    ['v0', 'unprojected'],
  ] as const)
    test(`${language} a phi fed by a call's ${returns === 'w0' ? '32-bit result and clobbered x0 high cell' : `clobbered ${root} cells`} runs as the source`, () => {
      const { ir, source } = callJoin(root, returns);
      const output = emit(ir, { source }, language).emission;
      const checked = emit(ir, { source }, language, 'checked').emission;
      const recombined = (output.local_validation ?? []).some(
        (record) => record.rule === 'register_cell_recombination' && record.status === 'verified',
      );
      if (returns === 'unprojected') {
        // One whole unknown of the root, not one per cell.
        assert.ok(recombined, output.text);
        assert.match(output.text, new RegExp(`"call clobbers ${root}"`), output.text);
        assert.doesNotMatch(output.text, /call clobbers \w+_(?:low|high|bits)/, output.text);
        assert.doesNotMatch(output.text, /<< 32/, output.text);
      } else
        // The bound result is never folded into a whole clobber of x0.
        assert.doesNotMatch(output.text, /"call clobbers x0"/, output.text);
      const entryValue = ir.register_states
        .find((state) => state.block === ir.entry)!
        .entry.find((binding) => binding.register.root === 'arm64:x0')!.value.id;
      const table = 0x1000n,
        loaded = 0x0123456789abcdeffedcba9876543210n;
      const memory = new Map<bigint, number>();
      for (let byte = 0n; byte < 16n; byte++)
        memory.set(table + byte, Number((loaded >> (8n * byte)) & 0xffn));
      for (const [n, bits, result] of [
        [0n, 0xfedcba9876543210n, 0x89abcdefn],
        [0n, 0x00000001ffffffffn, 0xffffffffn],
        [0n, (1n << 128n) - 3n, 0n],
        [table, 0n, 0n],
        [0xffffffff00000000n | table, 0n, 0n],
      ] as const) {
        if (root === 'v0' && n !== 0n && n !== table) continue;
        // The source: x0 after the call is the result in its low half (w0) or
        // the clobbered register; v0 after the call is the clobbered register.
        const value =
          n === 0n
            ? root === 'x0' && returns === 'w0'
              ? (bits & ~0xffffffffn & mask64) | result
              : bits
            : root === 'x0'
              ? BigInt.asUintN(32, n + 1n)
              : loaded;
        const expected =
          root === 'x0'
            ? (BigInt.asUintN(64, value) + 5n) & mask64
            : (BigInt.asUintN(32, value) + ((value >> 64n) ^ (value & mask64))) & mask64;
        for (const emission of [output, checked]) {
          const observed = execute(
            emission,
            new Map([[entryValue, n]]),
            new Map(memory),
            0n,
            new Map(),
            clobbered(root, BigInt.asUintN(root === 'x0' ? 64 : 128, bits)),
            new Map<string, SourceCallOracle>([
              ['sub_2000', () => (returns === 'w0' ? result : [])],
            ]),
          );
          assert.equal(observed.exit, 'machine_return', emission.text);
          assert.equal(observed.values[0], expected, emission.text);
        }
      }
    });

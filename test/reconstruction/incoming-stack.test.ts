import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationContext,
  newIdentity,
  type AbiProfile,
  type AbiType,
} from '../../src/core/index.js';
import { darwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { recoverTypes } from '../../src/analysis/types/index.js';
import { floating, integer, type SSAForm, type Value } from '../../src/ir/index.js';
import { structureControlFlow } from '../../src/presentation/index.js';
import { reconstruct } from '../../src/reconstruction/index.js';
import type { StoredDecompilation } from '../../src/project/cache/index.js';
import { builder, image, slice } from '../ir/support.js';
import { project } from '../service/analysis/support.js';
import { emit, emittedFormals, execute, type EmittedFormal } from '../emitters/c/support.js';

type StoredEmission = StoredDecompilation['data']['emission'];

// Independent source oracle: fixtures/source/corpus.c fixture_stack_args uses
// unsigned 64-bit inputs and a + 2*b + ... + 10*j. All input bit patterns and
// wraparound are defined by C; no native target or arbitrary input is executed.
const cases = [
  Array.from({ length: 10 }, (_, index) => BigInt(index + 1)),
  Array<bigint>(10).fill(0n),
  Array<bigint>(10).fill(0xffffffffffffffffn),
  Array.from({ length: 10 }, (_, index) => 0x8000000000000000n + BigInt(index)),
  [
    0n,
    1n,
    0x7fffffffffffffffn,
    0x8000000000000000n,
    0xffffffffffffffffn,
    0x100000000n,
    0xffffffffn,
    0x123456789abcdef0n,
    0xfedcba9876543210n,
    0xffffffffffffffffn,
  ],
  ...Array.from({ length: 10 }, (_, active) =>
    Array.from({ length: 10 }, (_, index) => (index === active ? 0xffffffffffffffffn : 0n)),
  ),
  ...Array.from({ length: 10 }, (_, active) =>
    Array.from({ length: 10 }, (_, index) => (index === active ? 0x8000000000000000n : 0n)),
  ),
];

for (const fixture of ['macho-arm64-symbols', 'macho-arm64-stripped'])
  test(`${fixture}: default public output recovers ten actual incoming weighted-sum inputs`, async (t) => {
    const p = await project(t, fixture);
    const fn = p.functions.find((candidate) => candidate.entry.value === 0x100000640n);
    assert.ok(fn);
    for (const emitter of ['c-like', 'python-like'] as const) {
      // Deliberately use public defaults: no signature, source, debug facts or
      // raised analysis budget is supplied to function_decompile.
      const result: StoredDecompilation = p.payload(
        (await p.decompile(fn.id, { options: { emitter } })).result,
      ).result;
      assert.equal(result.state, 'complete');
      const emission: StoredEmission = result.data.emission;
      const formals: readonly EmittedFormal[] = emittedFormals(emission).filter(
        (formal) => formal.name !== 'entry_sp',
      );
      assert.equal(formals.length, 10, emission.text);
      assert.doesNotMatch(
        emission.text,
        /\bstack_frame\b/,
        'entry bytes are not private uninitialized storage',
      );
      for (const args of cases) {
        const inputs = new Map<string, bigint>(
          formals.map((mapping: EmittedFormal, index: number): [string, bigint] => [
            mapping.statement_id,
            args[index]!,
          ]),
        );
        const observation = execute(emission, inputs);
        const expected = BigInt.asUintN(
          64,
          args.reduce((sum, value, index) => sum + BigInt(index + 1) * value, 0n),
        );
        assert.equal(observation.exit, 'machine_return');
        assert.deepEqual(observation.values, [expected]);
        assert.deepEqual(
          observation.events,
          [],
          'incoming values need no fabricated local-memory reads',
        );
        if (args === cases[0]) assert.equal(expected, 385n);
      }
    }
  });

const u64 = integer(64),
  word: AbiType = { kind: 'integer', bits: 64, signed: false };

/** `f(p0, …, p[n-1])` with the last parameter on the caller's stack. Argument
 * 1 is a pointer stored through; an open call (receiving p0, or the incoming
 * slot's address when `passIncoming`) precedes the incoming load. Returns
 * sum((i + 1) * p[i]) mod 2^64. */
function incomingFixture(abi: AbiProfile, count: number, passIncoming: boolean) {
  const layout = abi.classifyCall({
    returns: word,
    parameters: Array.from({ length: count }, () => word),
    variadic: false,
    fixed_parameter_count: count,
  });
  const registers = layout.parameters.slice(0, -1).map((parameter) => {
    const location = parameter.locations[0]!;
    if (location.kind !== 'register') throw new Error('Expected a register parameter');
    return location.register;
  });
  const stack = layout.parameters.at(-1)!.locations[0]!;
  if (stack.kind !== 'stack') throw new Error('Expected a stack parameter');
  const b = builder(`incoming-formal-${abi.id}-${passIncoming}`),
    block = b.block('entry');
  const parameters: Value[] = registers.map((register) => block.readRegister(register));
  const entry = block.readRegister(abi.stack_pointer);
  const sp = block.int('sub', entry, block.constant(u64, 32n));
  block.writeRegister(abi.stack_pointer, sp);
  const incoming = block.int('add', sp, block.constant(u64, 32n + stack.offset));
  block.store(parameters[1]!, parameters[2]!);
  block.writeRegister(registers[0]!, passIncoming ? incoming : parameters[0]!);
  block.call(
    { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
    [],
    [],
    abi.unknown_call_clobbers,
    [newIdentity('evidence')],
  );
  parameters.push(block.load(u64, incoming));
  let sum = parameters[0]!;
  for (const [index, parameter] of parameters.entries())
    if (index)
      sum = block.int(
        'add',
        sum,
        block.int('mul', parameter, block.constant(u64, BigInt(index + 1))),
      );
  block.return([sum]);
  const ir = constructSSA(b.finish(block, [u64])).value as SSAForm;
  const types = recoverTypes(ir, abi, createOperationContext(), {
    image_id: image,
    slice_id: slice,
    revision: 0,
  });
  const callees = ir.blocks.flatMap((node) =>
    node.instructions.flatMap((instruction) =>
      instruction.kind === 'call'
        ? [
            {
              call_id: instruction.id,
              parameters: [registers[0]!],
              returns: [],
              argument_list_complete: false,
              argument_list_closure: 'callee_reads' as const,
              evidence_ids: [],
            },
          ]
        : [],
    ),
  );
  const extra = { types, source: { abi, callees, addresses: [] } };
  const structured = structureControlFlow(ir, createOperationContext());
  assert.ok(structured.value);
  return {
    ir,
    extra,
    offset: stack.offset,
    view: (view: 'source' | 'checked') =>
      reconstruct({ function: structured.value!, ...extra }, createOperationContext(), view),
  };
}

const weighted = (args: readonly bigint[]) =>
  BigInt.asUintN(
    64,
    args.reduce((sum, value, index) => sum + BigInt(index + 1) * value, 0n),
  );
const pointer = 0xa000n;
const pointee = () =>
  new Map<bigint, number>(Array.from({ length: 8 }, (_, index) => [pointer + BigInt(index), 0]));

for (const [abi, count] of [
  [darwinArm64Abi, 9],
  [sysvAMD64Abi, 7],
] as const) {
  test(`${abi.id}: an incoming stack argument read after an open call and an external store is a formal`, () => {
    const fixture = incomingFixture(abi, count, false);
    const source = fixture.view('source');
    assert.ok(
      source.local_validation?.some(
        (record) =>
          record.kind === 'presentation' &&
          record.rule === 'incoming_formal' &&
          record.subject === `stack:${fixture.offset}:${fixture.offset + 8n}`,
      ),
    );
    assert.ok(
      source.local_validation_session?.abiConformance.some(
        (site) => site.rule === 'incoming_arguments_private',
      ),
    );
    // The checked view keeps its whole-function gates: the store through an
    // unknown pointer leaves the incoming load in memory.
    const checked = fixture.view('checked');
    assert.ok(!checked.local_validation?.some((record) => record.rule === 'incoming_formal'));
    assert.match(emit(fixture.ir, fixture.extra, 'c-like', 'checked').emission.text, /entry_sp/);
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(fixture.ir, fixture.extra, language).emission;
      assert.doesNotMatch(output.text, /\bentry_sp\b/, output.text);
      const formals = emittedFormals(output);
      assert.equal(formals.length, count, output.text);
      for (const value of [0n, 0xffffffffffffffffn, 0x8000000000000000n])
        for (const args of [
          Array.from({ length: count }, (_, index) => (index === 1 ? pointer : value)),
          Array.from({ length: count }, (_, index) =>
            index === 1 ? pointer : index === count - 1 ? value : BigInt(index + 1),
          ),
        ]) {
          const received: bigint[][] = [];
          const observation = execute(
            output,
            new Map(formals.map((formal, index) => [formal.statement_id, args[index]!])),
            pointee(),
            0n,
            new Map(),
            new Map(),
            new Map([
              ['sub_2000', (values: readonly bigint[]) => (received.push([...values]), [])],
            ]),
          );
          assert.deepEqual(observation.values, [weighted(args)], `${language} ${args}`);
          assert.deepEqual(received, [[args[0]!]]);
          assert.equal(
            [...Array(8).keys()].reduce(
              (bits, index) =>
                bits |
                (BigInt(observation.memory.get(pointer + BigInt(index))!) << BigInt(8 * index)),
              0n,
            ),
            args[2],
          );
          // The store and the call stay; the incoming value needs no memory read.
          assert.deepEqual(observation.events, ['store', 'call']);
        }
    }
  });

  test(`${abi.id}: an incoming slot whose address reaches a call stays memory the call can write`, () => {
    const fixture = incomingFixture(abi, count, true);
    assert.ok(
      !fixture.view('source').local_validation?.some((record) => record.rule === 'incoming_formal'),
    );
    const entrySp = 0x8000n,
      slot = entrySp + fixture.offset,
      written = 0x0123456789abcdefn;
    // Darwin: the escaping address of the first incoming slot makes it a
    // `va_start` area, the same bytes spelled `va` after `...`.
    const variadic = abi.id === 'darwin-arm64' && fixture.offset === 0n;
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(fixture.ir, fixture.extra, language).emission;
      const formals = emittedFormals(output);
      assert.equal(formals.length, variadic ? count - 1 : count, output.text);
      if (variadic) assert.match(output.text, /\.\.\.\s*\)/, output.text);
      else assert.equal(formals.at(-1)!.name, 'entry_sp', output.text);
      for (const value of [0n, 0xffffffffffffffffn, 0x8000000000000000n]) {
        const args = Array.from({ length: count - 1 }, (_, index) =>
          index === 1 ? pointer : value,
        );
        const memory = pointee();
        for (let index = 0n; index < 8n; index++) memory.set(slot + index, 0x5a);
        const received: bigint[][] = [];
        const observation = execute(
          output,
          new Map([
            ...formals.map((formal: EmittedFormal, index): [string, bigint] => [
              formal.statement_id,
              formal.name === 'entry_sp' ? entrySp : args[index]!,
            ]),
            ['...', slot],
          ]),
          memory,
          0n,
          new Map(),
          new Map(),
          new Map([
            [
              'sub_2000',
              (values: readonly bigint[]) => {
                received.push([...values]);
                for (let index = 0n; index < 8n; index++)
                  memory.set(values[0]! + index, Number((written >> (8n * index)) & 0xffn));
                return [];
              },
            ],
          ]),
        );
        assert.deepEqual(received, [[slot]], output.text);
        assert.deepEqual(observation.values, [weighted([...args, written])], language);
        assert.deepEqual(observation.events, ['store', 'call', 'load']);
      }
    }
  });
}

// S4: SysV `aggregate f(aggregate input, u64 delta, double scale)` with
// `struct aggregate { u64 total; u32 count; double weight; }` (24 bytes, MEMORY
// class: the caller's copy at entry SP + 8..32), sret in rdi, delta in rsi,
// scale in xmm0. The body updates the copy in place and copies it to [rdi]:
// `input.total += delta; input.count++; input.weight *= scale; *out = input`.
const u32 = integer(32),
  f64 = floating(64),
  RESULT = 0xa000n,
  // At entry the SysV SP is 8 modulo 16: the copy (entry SP + 8) is 16-byte aligned.
  ENTRY = 0x8008n;

/** `o2`: accesses at entry-SP offsets, one 16-byte and one 8-byte copy;
 * `o0`: through a `lea`-computed base with a delta spill/reload and three
 * 8-byte copies; `escaped`: as `o2`, but the copy's address is handed to an
 * open call between the updates and the copy. */
function aggregateFixture(variant: 'o2' | 'o0' | 'escaped') {
  const abi = sysvAMD64Abi;
  const layout = abi.classifyCall({
    returns: word,
    parameters: [word, word, { kind: 'float', bits: 64 }],
    variadic: false,
    fixed_parameter_count: 3,
  });
  const register = (index: number) => {
    const location = layout.parameters[index]!.locations[0]!;
    if (location.kind !== 'register') throw new Error('Expected a register parameter');
    return location.register;
  };
  const b = builder(`incoming-object-${variant}`),
    block = b.block('entry');
  const result = block.readRegister(register(0)),
    delta = block.readRegister(register(1)),
    // The low 64 bits of xmm0.
    scale = block.readRegister(
      { ...register(2), id: `${register(2).root}:0:64`, width_bits: 64 },
      f64,
    );
  const entry = block.readRegister(abi.stack_pointer);
  let at = (offset: bigint) => block.int('add', entry, block.constant(u64, 8n + offset));
  let addend = delta;
  if (variant === 'o0') {
    const frame = block.int('sub', entry, block.constant(u64, 32n));
    block.writeRegister(abi.stack_pointer, frame);
    const spill = block.int('add', frame, block.constant(u64, 8n));
    block.store(spill, delta);
    // `lea rax, [rbp + 16]`: the copy's base, addressed from the allocated frame.
    const base = block.int('add', frame, block.constant(u64, 40n));
    at = (offset: bigint) => (offset ? block.int('add', base, block.constant(u64, offset)) : base);
    addend = block.load(u64, spill);
  }
  block.store(at(0n), block.int('add', block.load(u64, at(0n)), addend));
  block.store(at(8n), block.int('add', block.load(u32, at(8n)), block.constant(u32, 1n)));
  block.store(at(16n), block.fp('mul', block.load(f64, at(16n)), scale));
  if (variant === 'escaped') {
    block.writeRegister(register(0), at(0n));
    block.call(
      { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
      [],
      [],
      abi.unknown_call_clobbers,
      [newIdentity('evidence')],
    );
  }
  if (variant === 'o0')
    for (const offset of [0n, 8n, 16n])
      block.store(
        offset ? block.int('add', result, block.constant(u64, offset)) : result,
        block.load(u64, at(offset)),
      );
  else {
    block.store(result, block.load(integer(128), at(0n)));
    block.store(block.int('add', result, block.constant(u64, 16n)), block.load(u64, at(16n)));
  }
  block.return([result]);
  const ir = constructSSA(b.finish(block, [u64])).value as SSAForm;
  const types = recoverTypes(ir, abi, createOperationContext(), {
    image_id: image,
    slice_id: slice,
    revision: 0,
  });
  const callees = ir.blocks.flatMap((node) =>
    node.instructions.flatMap((instruction) =>
      instruction.kind === 'call'
        ? [
            {
              call_id: instruction.id,
              parameters: [register(0)],
              returns: [],
              argument_list_complete: false,
              argument_list_closure: 'callee_reads' as const,
              evidence_ids: [],
            },
          ]
        : [],
    ),
  );
  return { ir, extra: { types, source: { abi, callees, addresses: [] } } };
}

const bytesOf = (address: bigint, value: bigint, count: number): [bigint, number][] =>
  Array.from({ length: count }, (_, index) => [
    address + BigInt(index),
    Number((value >> BigInt(8 * index)) & 0xffn),
  ]);
const wordAt = (memory: ReadonlyMap<bigint, number>, address: bigint, count: number): bigint =>
  Array.from({ length: count }, (_, index) => BigInt(memory.get(address + BigInt(index))!)).reduce(
    (value, byte, index) => value | (byte << BigInt(8 * index)),
    0n,
  );
const doubleBits = (value: number): bigint => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, true);
  return view.getBigUint64(0, true);
};
const bitsDouble = (bits: bigint): number => {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, bits, true);
  return view.getFloat64(0, true);
};
/** Independent oracle: IEEE binary64 product, NaNs canonical (the emitted
 * arithmetic's documented NaN model). */
const product = (weight: bigint, scale: bigint): bigint => {
  const value = bitsDouble(weight) * bitsDouble(scale);
  return Number.isNaN(value) ? 0x7ff8000000000000n : doubleBits(value);
};

const PADDING = 0xa5a5a5a5n;
const aggregateCases = [
  // Wrapping total, count = 0xffffffff, a plain product.
  { total: 0xffffffffffffffffn, count: 0xffffffffn, weight: doubleBits(1.5), delta: 2n },
  { total: 0x8000000000000000n, count: 0n, weight: 0x7ff0123456789abcn, delta: 1n << 63n },
  { total: 0n, count: 41n, weight: 1n << 63n, delta: 0xffffffffffffffffn },
];

/** Runs `emission` with the copy at ENTRY + 8 (padding bytes 0xa5) and the
 * sret buffer at RESULT; the open call, when present, writes `written` through
 * its first argument. Returns the 24 result bytes as three words. */
function runAggregate(
  emission: Parameters<typeof execute>[0],
  input: (typeof aggregateCases)[number],
  scale: bigint,
  written?: bigint,
) {
  const memory = new Map<bigint, number>([
    ...bytesOf(ENTRY - 64n, 0n, 72),
    ...bytesOf(ENTRY + 8n, input.total, 8),
    ...bytesOf(ENTRY + 16n, input.count | (PADDING << 32n), 8),
    ...bytesOf(ENTRY + 24n, input.weight, 8),
    ...bytesOf(RESULT, 0n, 24),
  ]);
  const formals = emittedFormals(emission);
  const values = [RESULT, input.delta, scale];
  const received: bigint[][] = [];
  const observation = execute(
    emission,
    new Map(
      formals.map((formal, index) => [
        formal.statement_id,
        formal.name === 'entry_sp'
          ? ENTRY
          : formal.name === 'stack_args'
            ? ENTRY + 8n
            : values[index]!,
      ]),
    ),
    memory,
    0n,
    new Map(),
    clobbers,
    new Map([
      [
        'sub_2000',
        (args: readonly bigint[]) => {
          received.push([...args]);
          for (const [address, byte] of bytesOf(args[0]!, written!, 8)) memory.set(address, byte);
          return [];
        },
      ],
    ]),
  );
  return {
    values: observation.values,
    received,
    events: observation.events.filter((event) => event === 'load' || event === 'store'),
    words: [0n, 8n, 16n].map((offset) => wordAt(observation.memory, RESULT + offset, 8)),
  };
}

/** The checked view names each register the call clobbers; none reaches the
 * explicit result, so any value serves. */
const clobbers = new (class extends Map<string, bigint> {
  override get(): bigint {
    return 0n;
  }
})();

for (const variant of ['o2', 'o0'] as const)
  test(`sysv-amd64 ${variant}: a by-value aggregate updated in place prints as one stack_args struct formal`, () => {
    const fixture = aggregateFixture(variant);
    const checked = emit(fixture.ir, fixture.extra, 'c-like', 'checked').emission;
    assert.match(checked.text, /\bentry_sp\b/);
    assert.doesNotMatch(checked.text, /\bstack_args\b/);
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(fixture.ir, fixture.extra, language).emission;
      const text = output.text;
      assert.doesNotMatch(text, /\bentry_sp\b/, text);
      assert.match(
        text,
        language === 'c-like' ? /, struct (stack_args_\w+) stack_args\)/ : /stack_args: struct\{/,
        text,
      );
      if (language === 'c-like')
        assert.match(text, /^struct stack_args_\w+ \{ [^}]*arg_8[^}]*arg_18; \};$/m, text);
      assert.ok(output.local_validation?.some((record) => record.rule === 'incoming_object'));
      assert.ok(
        output.requirements?.some((requirement) =>
          requirement.explanation.includes('incoming stack-argument bytes'),
        ),
      );
      const formals = emittedFormals(output);
      assert.deepEqual(formals.map((formal) => formal.name).at(-1), 'stack_args', text);
      for (const input of aggregateCases)
        for (const scale of [doubleBits(2), doubleBits(-0.5)]) {
          const source = runAggregate(output, input, scale),
            machine = runAggregate(checked, input, scale);
          const expected = [
            BigInt.asUintN(64, input.total + input.delta),
            ((input.count + 1n) & 0xffffffffn) | (PADDING << 32n),
            product(input.weight, scale),
          ];
          assert.deepEqual(source.words, expected, `${language} ${variant}\n${text}`);
          assert.deepEqual(machine.words, expected, checked.text);
          assert.deepEqual(source.values, [RESULT]);
          // Every update and copy stays an ordered memory access: nothing is forwarded.
          assert.deepEqual(
            source.events,
            [
              ...['load', 'store', 'load', 'store', 'load', 'store'],
              ...(variant === 'o0' ? ['load', 'store'] : []),
              'load',
              'store',
              'load',
              'store',
            ],
            text,
          );
        }
    }
  });

test('sysv-amd64: an aggregate copy whose address escapes to a call keeps the entry-SP form', () => {
  const fixture = aggregateFixture('escaped');
  const written = 0x0123456789abcdefn;
  for (const language of ['c-like', 'python-like'] as const) {
    const output = emit(fixture.ir, fixture.extra, language).emission;
    assert.doesNotMatch(output.text, /\bstack_args\b/, output.text);
    assert.ok(!output.local_validation?.some((record) => record.rule === 'incoming_object'));
    assert.equal(emittedFormals(output).at(-1)!.name, 'entry_sp', output.text);
    for (const input of aggregateCases) {
      const observed = runAggregate(output, input, doubleBits(2), written);
      assert.deepEqual(observed.received, [[ENTRY + 8n]], output.text);
      // The call's write through the escaped address is what the copy reads.
      assert.deepEqual(observed.words, [
        written,
        ((input.count + 1n) & 0xffffffffn) | (PADDING << 32n),
        product(input.weight, doubleBits(2)),
      ]);
    }
  }
});

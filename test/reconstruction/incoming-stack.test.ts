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
import { declaredTypes, typeId } from './declared-support.js';

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
 * open call between the updates and the copy. `rax`: the exit also writes
 * the sret pointer to rax, as the ABI's result register requires. */
function aggregateFixture(variant: 'o2' | 'o0' | 'escaped', rax = false) {
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
  const returned = layout.returns[0]!;
  if (rax && returned.kind === 'register') block.writeRegister(returned.register, result);
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
      // The 16- or 8-byte copy over the u64 and the u32 keeps both scalar
      // members, the u32's padding explicit; the copy is a cast at the first.
      if (language === 'c-like') {
        assert.match(
          text,
          /^struct stack_args_\w+ \{ uint64_t arg_8; uint32_t arg_10; uint8_t arg_14\[4\]; uint64_t arg_18; \};$/m,
          text,
        );
      } else
        assert.match(
          text,
          /struct\{arg_8: uint64_t, arg_10: uint32_t, arg_14: array<uint8_t, 4>, arg_18: uint64_t\}/,
          text,
        );
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

// S9: DWARF-like declarations of the function itself.
const declaredU64 = { u64: { kind: 'integer', bits: 64, signed: false } } as const;

/** Darwin `u64 f(u64 w0, …, u64 w9)`: w8 and w9 on the caller's stack at
 * entry SP + 0 and + 8; returns sum((i + 1) * w[i]) mod 2^64. `extraSlot`
 * also reads entry SP + 16, which no ten-parameter declaration has. */
function tenParameterFixture(extraSlot: boolean) {
  const abi = darwinArm64Abi;
  const layout = abi.classifyCall({
    returns: word,
    parameters: Array.from({ length: 10 }, () => word),
    variadic: false,
    fixed_parameter_count: 10,
  });
  const b = builder(`declared-stack-${extraSlot}`),
    block = b.block('entry');
  const entry = block.readRegister(abi.stack_pointer);
  const parameters = layout.parameters.map((parameter) => {
    const location = parameter.locations[0]!;
    return location.kind === 'register'
      ? block.readRegister(location.register)
      : block.load(
          u64,
          block.int(
            'add',
            entry,
            block.constant(u64, location.kind === 'stack' ? location.offset : 0n),
          ),
        );
  });
  assert.deepEqual(
    layout.parameters.slice(8).map((parameter) => parameter.locations[0]),
    [0n, 8n].map((offset) => ({
      kind: 'stack',
      offset,
      size: 8n,
      alignment: 8,
      value_offset_bits: 0,
    })),
  );
  if (extraSlot)
    parameters.push(block.load(u64, block.int('add', entry, block.constant(u64, 16n))));
  let sum = parameters[0]!;
  for (const [index, parameter] of parameters.entries())
    if (index)
      sum = block.int(
        'add',
        sum,
        block.int('mul', parameter, block.constant(u64, BigInt(index + 1))),
      );
  // The ABI result register x0 carries the sum, as the declaration says.
  const x0 = layout.returns[0]!;
  if (x0.kind === 'register') block.writeRegister(x0.register, sum);
  block.return([sum]);
  return constructSSA(b.finish(block, [u64])).value as SSAForm;
}

const tenNames = Array.from({ length: 10 }, (_, index) => `w${index}`);
const tenDeclared = (ir: SSAForm, status?: 'hypothesis') => ({
  types: declaredTypes(ir, darwinArm64Abi, {
    types: declaredU64,
    returns: 'u64',
    parameters: tenNames.map((name) => [name, 'u64'] as const),
    ...(status ? { status } : {}),
  }),
  source: { abi: darwinArm64Abi, callees: [], addresses: [] },
});

test('darwin-arm64: a declared ten-parameter signature binds its two stack parameters', () => {
  const ir = tenParameterFixture(false),
    extra = tenDeclared(ir);
  for (const language of ['c-like', 'python-like'] as const) {
    const output = emit(ir, extra, language).emission;
    assert.doesNotMatch(output.text, /\bentry_sp\b/, output.text);
    assert.match(output.text, language === 'c-like' ? /\buint64_t w9\n\)/ : /\bw9: uint64_t\n\)/);
    const formals = emittedFormals(output);
    assert.deepEqual(
      formals.map((formal) => formal.name),
      tenNames,
      output.text,
    );
    for (const rule of ['declared_signature', 'incoming_formal'])
      assert.ok(
        output.local_validation?.some((record) => record.rule === rule),
        rule,
      );
    for (const args of cases) {
      const observation = execute(
        output,
        new Map(formals.map((formal, index) => [formal.statement_id, args[index]!])),
      );
      assert.deepEqual(observation.values, [weighted(args)], `${language} ${args}`);
      // The stack parameters are formals: no incoming memory is read.
      assert.deepEqual(observation.events, []);
    }
  }
  // The checked view never takes the declared stack parameters.
  assert.equal(
    emit(ir, extra, 'c-like', 'checked').emission.text,
    emit(ir, tenDeclared(ir, 'hypothesis'), 'c-like', 'checked').emission.text,
  );
});

test('darwin-arm64: a declaration contradicting the incoming stack reads keeps the inferred output', () => {
  // The body reads entry SP + 16, a slot the ten-parameter declaration lacks.
  const ir = tenParameterFixture(true);
  for (const language of ['c-like', 'python-like'] as const) {
    const output = emit(ir, tenDeclared(ir), language).emission;
    // Byte-identical to the same declaration without standing (never bound).
    assert.equal(output.text, emit(ir, tenDeclared(ir, 'hypothesis'), language).emission.text);
    assert.doesNotMatch(output.text, /\bw\d\b/, output.text);
    assert.ok(!output.local_validation?.some((record) => record.rule === 'declared_signature'));
    const formals = emittedFormals(output);
    const args = Array.from({ length: 11 }, (_, index) => 0xfffffffffffffff0n + BigInt(index));
    const observation = execute(
      output,
      new Map(
        formals.map((formal, index) => [
          formal.statement_id,
          formal.name === 'entry_sp' ? 0x8000n : args[index]!,
        ]),
      ),
      new Map(
        [0n, 8n, 16n].flatMap((offset, index) => bytesOf(0x8000n + offset, args[8 + index]!, 8)),
      ),
    );
    assert.deepEqual(observation.values, [weighted(args)], output.text);
  }
});

// S9 + S4: the SysV aggregate fixture declared as `struct aggregate
// f(struct aggregate input, uint64_t delta, double scale)`. The result is
// returned through the hidden pointer in rdi (sret), which rax returns.
const aggregateDeclaration = (ir: SSAForm, status?: 'hypothesis') => ({
  types: {
    ...declaredU64,
    u32: { kind: 'integer', bits: 32, signed: false },
    f64: { kind: 'float', bits: 64 },
    aggregate: {
      kind: 'structure',
      size: 24n,
      alignment: 8,
      fields: [
        ['total', 'u64', 0n],
        ['count', 'u32', 8n],
        ['weight', 'f64', 16n],
      ].map(([name, type, offset]) => ({
        id: typeId(`aggregate.${String(name)}`),
        name: String(name),
        offset: offset as bigint,
        type_id: typeId(String(type)),
      })),
    },
  } as const,
  returns: 'aggregate',
  parameters: [
    ['input', 'aggregate'],
    ['delta', 'u64'],
    ['scale', 'f64'],
  ] as const,
  ...(status ? { status } : {}),
});

test('sysv-amd64: a declared sret result and by-value aggregate bind the hidden pointer and the incoming object', () => {
  const fixture = aggregateFixture('o2', true);
  const extra = {
    ...fixture.extra,
    types: declaredTypes(fixture.ir, sysvAMD64Abi, aggregateDeclaration(fixture.ir)),
  };
  for (const language of ['c-like', 'python-like'] as const) {
    const output = emit(fixture.ir, extra, language).emission;
    const text = output.text;
    assert.doesNotMatch(text, /\bentry_sp\b|\bstack_args\b/, text);
    assert.match(
      text,
      language === 'c-like'
        ? /^(\w+)\* \w+\(\1\* result, struct stack_args_\w+ input, uint64_t delta, double scale\) \{/m
        : /^def \w+\(result: pointer\[(\w+)\], input: struct\{[^}]*\}, delta: uint64_t, scale: double\) -> pointer\[\1\]:/m,
      text,
    );
    for (const rule of ['declared_signature', 'incoming_object'])
      assert.ok(
        output.local_validation?.some((record) => record.rule === rule),
        rule,
      );
    assert.deepEqual(
      emittedFormals(output).map((formal) => formal.name),
      ['result', 'input', 'delta', 'scale'],
    );
    for (const input of aggregateCases)
      for (const scale of [doubleBits(2), doubleBits(-0.5)]) {
        const memory = new Map<bigint, number>([
          ...bytesOf(ENTRY + 8n, input.total, 8),
          ...bytesOf(ENTRY + 16n, input.count | (PADDING << 32n), 8),
          ...bytesOf(ENTRY + 24n, input.weight, 8),
          ...bytesOf(RESULT, 0n, 24),
        ]);
        const values: Record<string, bigint> = {
          result: RESULT,
          input: ENTRY + 8n,
          delta: input.delta,
          scale,
        };
        const observation = execute(
          output,
          new Map(
            emittedFormals(output).map((formal) => [formal.statement_id, values[formal.name]!]),
          ),
          memory,
        );
        assert.deepEqual(
          [0n, 8n, 16n].map((offset) => wordAt(observation.memory, RESULT + offset, 8)),
          [
            BigInt.asUintN(64, input.total + input.delta),
            ((input.count + 1n) & 0xffffffffn) | (PADDING << 32n),
            product(input.weight, scale),
          ],
          `${language}\n${text}`,
        );
        // rax returns the hidden pointer.
        assert.deepEqual(observation.values, [RESULT]);
      }
  }
});

test('darwin-arm64: a declared sret result binds x8 and returns nothing', () => {
  const abi = darwinArm64Abi;
  const hidden = abi.classifyCall({
    returns: {
      kind: 'aggregate',
      size: 24n,
      alignment: 8,
      fields: [0n, 8n, 16n].map((offset) => ({ offset, type: word })),
    },
    parameters: [word, word],
    variadic: false,
    fixed_parameter_count: 2,
  });
  assert.ok(hidden.hidden_result?.kind === 'indirect' && 'root' in hidden.hidden_result.pointer);
  const pointer = hidden.hidden_result.pointer;
  const b = builder('declared-sret-darwin'),
    block = b.block('entry');
  const [left, right] = hidden.parameters.map((parameter) => {
    const location = parameter.locations[0]!;
    assert.equal(location.kind, 'register');
    return block.readRegister(location.register);
  }) as [Value, Value];
  const out = block.readRegister(pointer);
  block.store(out, block.int('add', left, right));
  block.store(block.int('add', out, block.constant(u64, 8n)), block.int('mul', left, right));
  block.store(block.int('add', out, block.constant(u64, 16n)), left);
  block.return();
  const ir = constructSSA(b.finish(block)).value as SSAForm;
  const types = declaredTypes(ir, abi, {
    types: {
      ...declaredU64,
      triple: {
        kind: 'structure',
        size: 24n,
        alignment: 8,
        fields: ['sum', 'product', 'first'].map((name, index) => ({
          id: typeId(`triple.${name}`),
          name,
          offset: 8n * BigInt(index),
          type_id: typeId('u64'),
        })),
      },
    },
    returns: 'triple',
    parameters: [
      ['left', 'u64'],
      ['right', 'u64'],
    ],
  });
  const extra = { types, source: { abi, callees: [], addresses: [] } };
  for (const language of ['c-like', 'python-like'] as const) {
    const output = emit(ir, extra, language).emission;
    assert.match(
      output.text,
      language === 'c-like'
        ? /^void \w+\(\w+\* result, uint64_t left, uint64_t right\) \{/m
        : /^def \w+\(result: pointer\[\w+\], left: uint64_t, right: uint64_t\) -> void:/m,
      output.text,
    );
    assert.ok(output.local_validation?.some((record) => record.rule === 'declared_signature'));
    const values: Record<string, bigint> = {
      result: RESULT,
      left: 0xffffffffffffffffn,
      right: 3n,
    };
    const observation = execute(
      output,
      new Map(emittedFormals(output).map((formal) => [formal.statement_id, values[formal.name]!])),
      new Map(bytesOf(RESULT, 0n, 24)),
    );
    assert.deepEqual(
      [0n, 8n, 16n].map((offset) => wordAt(observation.memory, RESULT + offset, 8)),
      [2n, 0xfffffffffffffffdn, 0xffffffffffffffffn],
      output.text,
    );
    assert.deepEqual(observation.events, ['store', 'store', 'store']);
  }
});

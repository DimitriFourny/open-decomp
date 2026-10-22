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
import { integer, type SSAForm, type Value } from '../../src/ir/index.js';
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
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(fixture.ir, fixture.extra, language).emission;
      const formals = emittedFormals(output);
      assert.equal(formals.length, count, output.text);
      assert.equal(formals.at(-1)!.name, 'entry_sp', output.text);
      for (const value of [0n, 0xffffffffffffffffn, 0x8000000000000000n]) {
        const args = Array.from({ length: count - 1 }, (_, index) =>
          index === 1 ? pointer : value,
        );
        const memory = pointee();
        for (let index = 0n; index < 8n; index++) memory.set(slot + index, 0x5a);
        const received: bigint[][] = [];
        const observation = execute(
          output,
          new Map(
            formals.map((formal: EmittedFormal, index) => [
              formal.statement_id,
              formal.name === 'entry_sp' ? entrySp : args[index]!,
            ]),
          ),
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

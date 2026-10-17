import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationContext,
  decodeEmission,
  encodeEmission,
  type AbiProfile,
  type LoadedImage,
} from '../../../src/core/index.js';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { WindowsX64Abi } from '../../../src/abi/windows-x64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { simplifySSA } from '../../../src/analysis/values/index.js';
import { recoverTypes } from '../../../src/analysis/types/index.js';
import type { RegisterIR } from '../../../src/ir/index.js';
import { discover, lift, loadCorpus as loadDarwin } from '../../lifters/arm64/support.js';
import { loadCorpus as loadWindows } from '../../lifters/x86_64/helpers.js';
import { emit, execute } from './support.js';

/** Real fixtures are lifted and simplified, then only emitted text is evaluated.
 * Expected arithmetic/memory observations come from the trusted fixture formulas,
 * not a second evaluation of the IR supplied to the emitter. */
function check(
  image: LoadedImage,
  abi: AbiProfile,
  registerIR: RegisterIR,
  memoryFunction: boolean,
): void {
  const constructed = constructSSA(registerIR);
  assert.equal(constructed.state, 'complete');
  assert.equal(constructed.value.form, 'ssa');
  if (constructed.value.form !== 'ssa') throw new Error('Expected SSA');
  const simplified = simplifySSA(constructed.value);
  assert.equal(simplified.state, 'complete');
  const ir = simplified.value;
  const types = recoverTypes(ir, abi, createOperationContext(), {
    image_id: image.id,
    slice_id: image.selected_slice_id,
    revision: 0,
  });
  for (const language of ['c-like', 'python-like'] as const) {
    const output = emit(
      ir,
      {
        types,
        names: [
          { entity_id: ir.id, name: memoryFunction ? 'fixture_memory' : 'fixture_arithmetic' },
        ],
      },
      language,
    );
    const arm = abi.id === 'darwin-arm64',
      resultRoot = arm ? 'arm64:x0' : 'x86_64:rax';
    const entry = ir.blocks.find((block) => block.id === ir.entry)!,
      bindings = ir.register_states.find((state) => state.block === ir.entry)!.entry;
    for (const [a, b] of [
      [0n, 1n],
      [0xffffffffn, 3n],
      [123456789n, 987654321n],
    ] as const) {
      const roots = new Map<string, bigint>(
        arm
          ? [
              ['arm64:x0', memoryFunction ? 0x2000n : a],
              ['arm64:x1', b],
              ['arm64:sp', 0x9000n],
            ]
          : [
              ['x86_64:rcx', memoryFunction ? 0x2000n : a],
              ['x86_64:rdx', b],
              ['x86_64:rsp', 0x9000n],
            ],
      );
      const inputs = new Map(entry.parameters.map((value) => [value.id, 0n]));
      for (const binding of bindings)
        inputs.set(
          binding.value.id,
          BigInt.asUintN(
            binding.register.width_bits,
            (roots.get(binding.register.root) ?? 0n) >> BigInt(binding.register.offset_bits),
          ),
        );
      const memory = new Map<bigint, number>();
      for (let i = 0; i < 8; i++) {
        memory.set(0x2000n + BigInt(i), Number((a >> BigInt(i * 8)) & 255n));
        memory.set(0x9000n + BigInt(i), 0);
      }
      const observation = execute(
        output.emission,
        inputs,
        memory,
        0n,
        new Map([...roots].map(([root, bits]) => [root, { bits, known: 0xffffffffffffffffn }])),
      );
      assert.equal(observation.exit, 'machine_return');
      const expected = memoryFunction
        ? BigInt.asUintN(64, a + b)
        : BigInt.asUintN(32, a + 3n * b) ^ 0x55n;
      const returned = observation.registers.get(resultRoot)!,
        resultBits = memoryFunction ? 64 : 32;
      assert.equal(BigInt.asUintN(resultBits, returned.known), (1n << BigInt(resultBits)) - 1n);
      assert.equal(BigInt.asUintN(resultBits, returned.bits), expected);
      if (!arm && !memoryFunction)
        assert.equal(
          observation.registers.get('x86_64:rflags')!.known & 0x10n,
          0n,
          'XOR leaves AF indeterminate, not a fabricated zero',
        );
      if (memoryFunction) {
        let stored = 0n;
        for (let i = 0; i < 8; i++)
          stored |= BigInt(observation.memory.get(0x2000n + BigInt(i))!) << BigInt(i * 8);
        assert.equal(stored, expected);
        assert.ok(observation.events.indexOf('load') < observation.events.indexOf('store'));
      }
    }
    for (const block of ir.blocks)
      for (const node of [...block.instructions, block.terminator]) {
        const mapped = output.emission.mappings.filter(
          (mapping) => mapping.statement_id === node.id,
        );
        const instructions = new Set(mapped.flatMap((mapping) => mapping.instruction_ids));
        for (const id of node.provenance.instruction_ids)
          assert.ok(instructions.has(id), 'simplified machine origins remain navigable');
      }
    assert.deepEqual(decodeEmission(encodeEmission(output.emission)), output.emission);
  }
}

test('actual Mach-O arithmetic and memory outputs execute with recovered type facts and instruction mappings', () => {
  const image = loadDarwin(),
    graphs = new Map(discover(image).map((graph) => [graph.function.original_name, graph])),
    abi = new DarwinArm64Abi();
  check(image, abi, lift(graphs.get('_fixture_arithmetic')!).ir, false);
  check(image, abi, lift(graphs.get('_fixture_memory')!).ir, true);
});

test('actual PE arithmetic and memory outputs execute with recovered type facts and instruction mappings', () => {
  const corpus = loadWindows(),
    abi = new WindowsX64Abi();
  check(corpus.image, abi, corpus.lifted.get(0x180001030n)!.ir, false);
  check(corpus.image, abi, corpus.lifted.get(0x180001070n)!.ir, true);
});

test('source-level signed selections and loops preserve overflow and zero-trip boundaries in both dialects', () => {
  const armImage = loadDarwin(),
    armGraphs = discover(armImage),
    windows = loadWindows();
  for (const arm of [true, false]) {
    const abi = arm ? new DarwinArm64Abi() : new WindowsX64Abi();
    const image = arm ? armImage : windows.image,
      graphs = arm ? armGraphs : windows.graphs;
    for (const name of ['fixture_maximum', 'fixture_loop']) {
      const graph = graphs.find(
        (graph) => graph.function.original_name?.replace(/^_/, '') === name,
      );
      assert.ok(graph);
      const lifted = arm ? lift(graph).ir : windows.lifted.get(graph.function.entry.value)!.ir;
      const constructed = constructSSA(lifted);
      assert.equal(constructed.value.form, 'ssa');
      if (constructed.value.form !== 'ssa') assert.fail('Missing SSA');
      const ir = simplifySSA(constructed.value).value;
      const types = recoverTypes(ir, abi, createOperationContext(), {
        image_id: image.id,
        slice_id: image.selected_slice_id,
        revision: 0,
      });
      const entry = ir.blocks.find((block) => block.id === ir.entry)!,
        bindings = ir.register_states.find((state) => state.block === ir.entry)!.entry;
      const cases =
        name === 'fixture_maximum'
          ? [
              [0x80000000n, 0x7fffffffn],
              [0xffffffffn, 0n],
              [0n, 0xffffffffn],
              [0x80000000n, 0x80000000n],
            ]
          : [
              [0x2000n, 0n],
              [0x2000n, 1n],
              [0x2000n, 3n],
            ];
      for (const language of ['c-like', 'python-like'] as const) {
        const output = emit(ir, { types, source: { abi, callees: [], addresses: [] } }, language);
        for (const [a, b] of cases) {
          const roots = new Map<string, bigint>(
            arm
              ? [
                  ['arm64:x0', a!],
                  ['arm64:x1', b!],
                  ['arm64:sp', 0x9000n],
                ]
              : [
                  ['x86_64:rcx', a!],
                  ['x86_64:rdx', b!],
                  ['x86_64:rsp', 0x9000n],
                ],
          );
          const inputs = new Map(entry.parameters.map((value) => [value.id, 0n]));
          for (const binding of bindings)
            inputs.set(
              binding.value.id,
              BigInt.asUintN(
                binding.register.width_bits,
                (roots.get(binding.register.root) ?? 0n) >> BigInt(binding.register.offset_bits),
              ),
            );
          const memory = new Map<bigint, number>();
          for (let i = 0; i < 8; i++) memory.set(0x9000n + BigInt(i), 0);
          const words = [0xffffffffn, 7n, 9n];
          for (let i = 0; i < words.length; i++)
            for (let byte = 0; byte < 4; byte++)
              memory.set(
                0x2000n + BigInt(i * 4 + byte),
                Number((words[i]! >> BigInt(byte * 8)) & 255n),
              );
          const observed = execute(
            output.emission,
            inputs,
            memory,
            0n,
            new Map([...roots].map(([root, bits]) => [root, { bits, known: 0xffffffffffffffffn }])),
          );
          const expected =
            name === 'fixture_maximum'
              ? BigInt.asIntN(32, a!) > BigInt.asIntN(32, b!)
                ? a!
                : b!
              : words.slice(0, Number(b)).reduce((sum, word) => sum + word, 0n);
          assert.equal(observed.exit, 'machine_return');
          assert.deepEqual(observed.values, [BigInt.asUintN(32, expected)]);
        }
      }
    }
  }
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { z } from 'zod';
import {
  OracleMemory,
  evaluateIR,
  verifyIR,
  type MemoryRegion,
  type TrustedCall,
} from '../../../src/ir/index.js';
import {
  data,
  discover,
  floatBits,
  initialRegisters,
  lift,
  loadCorpus,
  machineRegister,
  registerBits,
  stack,
} from './support.js';

const expected = z
  .object({
    cases: z.array(
      z.object({
        function: z.string(),
        family: z.string(),
        arguments: z.array(z.union([z.string(), z.array(z.string())])),
        result: z.union([z.string(), z.array(z.string())]),
        memoryAfter: z.string().optional(),
      }),
    ),
  })
  .parse(JSON.parse(readFileSync('fixtures/expected.json', 'utf8')) as unknown);
const image = loadCorpus();
const graphs = discover(image);
const byName = new Map(graphs.map((graph) => [graph.function.original_name, graph]));
const imageMemory: MemoryRegion[] = image.mappings
  .filter((mapping) => mapping.memory_size > 0n && mapping.permissions.includes('read'))
  .map((mapping) => {
    const bytes = new Uint8Array(Number(mapping.memory_size));
    bytes.set(image.bytes.read(mapping.file_offset, Number(mapping.file_size)));
    return { base: mapping.va, bytes, writable: mapping.permissions.includes('write') };
  });

for (const [index, example] of expected.cases.entries())
  test(`ARM64 real corpus ${index}: ${example.function} ${JSON.stringify(example.arguments)}`, () => {
    const graph = byName.get(`_${example.function}`);
    assert.ok(graph, example.function);
    const lifted = lift(graph),
      ir = lifted.ir;
    assert.deepEqual(verifyIR(ir), []);
    assert.equal(
      lifted.coverage.completed_units,
      graph.instructions.length,
      lifted.diagnostics.map((d) => d.message).join('\n'),
    );
    const memory = new OracleMemory([
      ...imageMemory,
      { base: stack - 4096n, bytes: new Uint8Array(8192), writable: true },
      { base: data, bytes: new Uint8Array(4096), writable: true },
    ]);
    const inputs = new Map<string, bigint>();
    const scalar = (n: number): string => {
      const arg = example.arguments[n];
      assert.equal(typeof arg, 'string');
      return arg as string;
    };
    if (example.function === 'fixture_loop') {
      const values = example.arguments[0];
      assert.ok(Array.isArray(values));
      values.forEach((value, i) => memory.write(data + BigInt(i * 4), 32, BigInt(value)));
      inputs.set('arm64:x0', data);
      inputs.set('arm64:x1', BigInt(scalar(1)));
    } else if (example.function === 'fixture_memory') {
      memory.write(data, 64, BigInt(scalar(0)));
      inputs.set('arm64:x0', data);
      inputs.set('arm64:x1', BigInt(scalar(1)));
    } else if (example.function === 'fixture_indirect') {
      const target = byName.get(`_${scalar(0)}`);
      assert.ok(target);
      inputs.set('arm64:x0', target.function.entry.value);
      inputs.set('arm64:x1', BigInt(scalar(1)));
    } else if (example.function === 'fixture_float') {
      inputs.set('arm64:v0', floatBits(Number(scalar(0)), 64));
      inputs.set('arm64:v1', floatBits(Number(scalar(1)), 64));
    } else if (
      example.function === 'fixture_vector' ||
      example.function === 'fixture_vector_integer'
    ) {
      const fp = example.function === 'fixture_vector';
      example.arguments.forEach((argument, n) => {
        assert.ok(Array.isArray(argument));
        argument.forEach((value, i) =>
          memory.write(
            data + BigInt(64 + n * 64 + i * 4),
            32,
            fp ? floatBits(Number(value), 32) : BigInt(value),
          ),
        );
      });
      inputs.set('arm64:x0', data);
      inputs.set('arm64:x1', data + 64n);
      inputs.set('arm64:x2', data + 128n);
    } else if (example.function === 'fixture_variadic') {
      inputs.set('arm64:x0', BigInt(scalar(0)));
      example.arguments.slice(1).forEach((value, i) => {
        assert.equal(typeof value, 'string');
        memory.write(stack + BigInt(i * 8), 64, floatBits(Number(value), 64));
      });
    } else {
      example.arguments.forEach((value, i) => {
        assert.equal(typeof value, 'string');
        if (i < 8) inputs.set(`arm64:x${i}`, BigInt(value as string));
        else memory.write(stack + BigInt((i - 8) * 8), 64, BigInt(value as string));
      });
    }
    const calls = new Map<string, TrustedCall>();
    for (const block of ir.blocks)
      for (const node of block.instructions)
        if (node.kind === 'call') {
          assert.deepEqual(node.arguments, []);
          assert.deepEqual(node.results, []);
          calls.set(node.id, (call) => {
            const a = BigInt.asUintN(32, call.readRegister(machineRegister(0)));
            let value: bigint;
            if (call.target === byName.get('_fixture_stack')!.function.entry.value)
              value = BigInt.asUintN(32, a + 7n);
            else {
              assert.equal(call.target, byName.get('_fixture_arithmetic')!.function.entry.value);
              const b = BigInt.asUintN(32, call.readRegister(machineRegister(1)));
              value = BigInt.asUintN(32, a + b * 3n) ^ 85n;
            }
            return {
              results: [],
              writes: [],
              register_writes: [{ register: machineRegister(0), bits: value }],
            };
          });
        }
    const result = evaluateIR(ir, {
      registers: initialRegisters(ir, inputs),
      memory: memory.snapshot(),
      calls,
    });
    assert.equal(result.status, 'returned', result.reason ?? undefined);
    const finalMemory = new OracleMemory(result.memory);
    if (example.family === 'vector-float' || example.family === 'vector-integer') {
      assert.ok(Array.isArray(example.result));
      assert.deepEqual(
        example.result.map((_, i) => finalMemory.read(data + BigInt(i * 4), 32)),
        example.result.map((value) =>
          example.family === 'vector-float' ? floatBits(Number(value), 32) : BigInt(value),
        ),
      );
    } else if (example.family === 'scalar-float' || example.family === 'variadic-call') {
      assert.equal(registerBits(result, 'arm64:v0', 64), floatBits(Number(example.result), 64));
      assert.ok(
        lifted.diagnostics.some((diagnostic) => diagnostic.message.includes('canonicalized')),
      );
    } else if (example.function === 'fixture_string') {
      const pointer = registerBits(result);
      assert.equal(typeof example.result, 'string');
      const encoded = new TextEncoder().encode(`${example.result as string}\0`);
      assert.deepEqual(
        Array.from(encoded, (_, i) => Number(finalMemory.read(pointer + BigInt(i), 8))),
        [...encoded],
      );
    } else {
      assert.equal(typeof example.result, 'string');
      const width = ['fixture_width', 'fixture_memory', 'fixture_stack_args'].includes(
        example.function,
      )
        ? 64
        : 32;
      assert.equal(
        registerBits(result, 'arm64:x0', width),
        BigInt.asUintN(width, BigInt(example.result as string)),
      );
    }
    if (example.memoryAfter !== undefined)
      assert.equal(finalMemory.read(data, 64), BigInt(example.memoryAfter));
    if (result.registers.has('arm64:sp')) assert.equal(registerBits(result, 'arm64:sp'), stack);
    const ids = new Set(graph.instructions.map((instruction) => instruction.id));
    for (const block of ir.blocks)
      for (const node of [...block.instructions, block.terminator]) {
        assert.ok(node.provenance.instruction_ids.length > 0);
        assert.ok(node.provenance.instruction_ids.every((id) => ids.has(id)));
        for (const id of node.provenance.instruction_ids) {
          const instruction = graph.instructions.find((item) => item.id === id)!;
          assert.ok(
            node.provenance.ranges.some(
              (range) =>
                range.start.image_id === instruction.bytes.start.image_id &&
                range.start.space === instruction.bytes.start.space &&
                range.start.value === instruction.bytes.start.value &&
                range.size === instruction.bytes.size,
            ),
          );
        }
      }
  });

test('all corpus functions including the trusted check harness lift deterministically without unsupported instructions', () => {
  for (const graph of graphs.filter((graph) =>
    graph.function.original_name?.startsWith('_fixture_'),
  )) {
    const result = lift(graph);
    assert.equal(
      result.coverage.completed_units,
      graph.instructions.length,
      result.diagnostics.map((diagnostic) => diagnostic.message).join('\n'),
    );
    assert.deepEqual(result, lift(graph));
  }
});

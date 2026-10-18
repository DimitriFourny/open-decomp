import assert from 'node:assert/strict';
import { createOperationContext, expandEmission } from '../../../src/core/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { simplifySSA } from '../../../src/analysis/values/index.js';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import {
  bitWidth,
  integer,
  type Expression,
  type SSAForm,
  type Value,
} from '../../../src/ir/index.js';
import { structureControlFlow } from '../../../src/presentation/index.js';
import { reconstruct } from '../../../src/reconstruction/index.js';
import type { Reconstruction } from '../../../src/reconstruction/model.js';
import { builder, register } from '../../ir/support.js';
import { discover, lift, loadCorpus } from '../../lifters/arm64/support.js';
import { emit, execute } from './support.js';

const abi = new DarwinArm64Abi();
const source = { abi, callees: [], addresses: [] };
const i32 = integer(32),
  i64 = integer(64);
function ssa(input: Parameters<typeof constructSSA>[0]): SSAForm {
  const converted = constructSSA(input);
  assert.equal(converted.state, 'complete');
  assert.equal(converted.value.form, 'ssa');
  if (converted.value.form !== 'ssa') assert.fail('Expected SSA');
  const simplified = simplifySSA(converted.value);
  assert.equal(simplified.state, 'complete');
  return simplified.value;
}
function plan(ir: SSAForm): Reconstruction {
  const structured = structureControlFlow(ir, createOperationContext());
  assert.ok(structured.value);
  return reconstruct({ function: structured.value, source }, createOperationContext());
}
function expression(program: Reconstruction, value: Value): Expression | undefined {
  const seen = new Set<string>();
  while (!seen.has(value.id)) {
    seen.add(value.id);
    const result = program.expressions.get(value.id);
    if (result?.kind !== 'cast' || result.op !== 'bitcast') return result;
    value = result.value;
  }
  assert.fail('Expression identity cycle');
}
function inputs(ir: SSAForm, arguments_: readonly bigint[]) {
  const entry = ir.blocks.find((block) => block.id === ir.entry)!;
  const roots = new Map(arguments_.map((bits, index) => [`arm64:x${index}`, bits]));
  const values = new Map(entry.parameters.map((value) => [value.id, 0n]));
  for (const binding of ir.register_states.find((state) => state.block === ir.entry)!.entry)
    values.set(
      binding.value.id,
      BigInt.asUintN(
        binding.register.width_bits,
        (roots.get(binding.register.root) ?? 0n) >> BigInt(binding.register.offset_bits),
      ),
    );
  return values;
}
function registerDescriptor(index: number) {
  return register(`arm64:x${index}`, 64, 0, 'replace_root', `arm64:x${index}`);
}

/** Independent unsigned source contract: return p[index];
 * Pointer arithmetic is modulo 2^64 in the lowered machine program. Behavioral
 * cases only use mapped addresses, not out-of-bounds source pointer arithmetic.
 * The synthetic packing is the same split-cell pattern produced by register SSA.
 */
function indexedLoad(): SSAForm {
  const b = builder('source-width-indexed-load'),
    entry = b.block('entry');
  const pointer = entry.readRegister(registerDescriptor(0));
  const index = entry.readRegister(registerDescriptor(1));
  const address = entry.int('add', pointer, entry.int('shl', index, entry.constant(i64, 2n)));
  const low = entry.extract(address, 0, 32),
    high = entry.extract(address, 32, 32);
  const packed = entry.concat([low, high]);
  const loaded = entry.load(i32, packed);
  entry.return([loaded]);
  return ssa(b.finish(entry, [i32]));
}

/** Defined unsigned source helper: n < 64 ? x << n : 0. The lifted bitvector
 * shift has exactly this total behavior; an ISA mask must not be invented. */
function constantShift(count: bigint, unknown = false): SSAForm {
  const b = builder(`source-width-constant-shift-${count}-${unknown}`),
    entry = b.block('entry');
  const value = unknown
    ? entry.indeterminate(i64, 'unknown', 'unknown shift operand')
    : entry.readRegister(registerDescriptor(0));
  entry.return([entry.int('shl', value, entry.constant(i64, count))]);
  return ssa(b.finish(entry, [i64]));
}
/** Source: a=*volatile_p; b=distinct ? *volatile_p : a; return a+2*b.
 * Equal addresses are not proof that separately ordered reads are identical. */
function orderedLoads(distinct: boolean): SSAForm {
  const b = builder(`source-width-ordered-loads-${distinct}`),
    entry = b.block('entry');
  const pointer = entry.readRegister(registerDescriptor(0));
  const first = entry.load(i64, pointer, { volatile: true, endian: 'little', alignment: 8 });
  const second = distinct
    ? entry.load(i64, pointer, { volatile: true, endian: 'little', alignment: 8 })
    : first;
  entry.return([entry.int('add', first, entry.int('shl', second, entry.constant(i64, 1n)))]);
  return ssa(b.finish(entry, [i64]));
}
function sharedDag(): SSAForm {
  const b = builder('source-width-bounded-shared-dag'),
    entry = b.block('entry');
  let value = entry.readRegister(registerDescriptor(0));
  for (let index = 0; index < 24; index++) value = entry.int('add', value, value);
  entry.return([value]);
  return ssa(b.finish(entry, [i64]));
}

export function checkSourceWidths(): { observations: number; fixtures: number } {
  const image = loadCorpus(),
    graphs = discover(image);
  const selected = (name: string) => {
    const graph = graphs.find((candidate) => candidate.function.original_name === `_${name}`);
    assert.ok(graph);
    return ssa(lift(graph).ir);
  };
  const arithmetic = selected('fixture_arithmetic'),
    width = selected('fixture_width');
  const loop = selected('fixture_loop'),
    indexed = indexedLoad();
  const divide = selected('fixture_divide'),
    maximum = selected('fixture_maximum');
  const shifts = [0n, 1n, 63n, 64n, 65n, 0xffffffffffffffffn].map((count) => ({
    count,
    ir: constantShift(count),
  }));
  const unknown = constantShift(64n, true),
    reads = [false, true].map((distinct) => ({ distinct, ir: orderedLoads(distinct) }));
  const dag = sharedDag();
  let observations = 0;
  // Source formulas are fixtures/source/corpus.c:6,8-12,19, not evaluation of IR.
  for (const language of ['c-like', 'python-like'] as const) {
    const output = emit(arithmetic, { source }, language);
    for (const a of [0n, 1n, 0x7fffffffn, 0x80000000n, 0xffffffffn])
      for (const b of [0n, 1n, 3n, 0x80000000n, 0xffffffffn]) {
        const observed = execute(output.emission, inputs(arithmetic, [a, b]));
        assert.equal(observed.exit, 'machine_return');
        assert.deepEqual(observed.values, [BigInt.asUintN(32, a + 3n * b) ^ 0x55n]);
        assert.deepEqual(observed.events, []);
        observations++;
      }
    const wideOutput = emit(width, { source }, language);
    for (const [a, b] of [
      [0n, 0n],
      [0xffffffffn, 1n],
      [0xffffffffn, 0xffffffffn],
      [0x80000000n, 0x80000000n],
      [0x7fffffffn, 1n],
      [1n, 3n],
    ] as const)
      for (const shift of [0n, 1n, 31n, 32n, 63n, 64n, 65n, 0xffffffffffffffffn]) {
        const observed = execute(wideOutput.emission, inputs(width, [a, b, shift]));
        assert.equal(observed.exit, 'machine_return');
        assert.deepEqual(observed.values, [(a + b) >> (shift & 63n)]);
        assert.deepEqual(observed.events, []);
        observations++;
      }
    const loopOutput = emit(loop, { source }, language),
      indexedOutput = emit(indexed, { source }, language);
    const words = [0xffffffffn, 7n, 0x80000000n, 0x12345678n];
    const memory = () => {
      const bytes = new Map<bigint, number>();
      for (let index = 0; index < words.length; index++)
        for (let byte = 0; byte < 4; byte++)
          bytes.set(
            0x2000n + BigInt(index * 4 + byte),
            Number((words[index]! >> BigInt(byte * 8)) & 255n),
          );
      return bytes;
    };
    for (let count = 0; count <= words.length; count++) {
      const before = memory();
      const observed = execute(
        loopOutput.emission,
        inputs(loop, [0x2000n, BigInt(count)]),
        new Map(before),
      );
      assert.equal(observed.exit, 'machine_return');
      assert.deepEqual(observed.values, [
        BigInt.asUintN(
          32,
          words.slice(0, count).reduce((sum, value) => sum + value, 0n),
        ),
      ]);
      assert.deepEqual(observed.memory, before);
      assert.deepEqual(
        observed.events,
        Array.from({ length: count }, () => 'load'),
      );
      observations++;
    }
    for (let index = 0; index < words.length; index++) {
      const before = memory();
      const observed = execute(
        indexedOutput.emission,
        inputs(indexed, [0x2000n, BigInt(index)]),
        new Map(before),
      );
      assert.equal(observed.exit, 'machine_return');
      assert.deepEqual(observed.values, [words[index]!]);
      assert.deepEqual(observed.memory, before);
      assert.deepEqual(observed.events, ['load']);
      observations++;
    }
    for (const { count, ir } of shifts) {
      const emitted = emit(ir, { source }, language);
      for (const value of [0n, 1n, 0x8000000000000000n, 0xffffffffffffffffn]) {
        const observed = execute(emitted.emission, inputs(ir, [value]));
        assert.equal(observed.exit, 'machine_return');
        assert.deepEqual(observed.values, [count >= 64n ? 0n : BigInt.asUintN(64, value << count)]);
        observations++;
      }
    }
    const unknownOutput = emit(unknown, { source }, language);
    assert.equal(
      execute(unknownOutput.emission).exit,
      'unknown',
      'Replacing an oversized shift by multiplication by zero must retain its unknown operand',
    );
    observations++;
    for (const { distinct, ir } of reads) {
      const emitted = emit(ir, { source }, language);
      const bytes = new Map(
        Array.from({ length: 8 }, (_, index) => [0x2000n + BigInt(index), 255]),
      );
      const observed = execute(emitted.emission, inputs(ir, [0x2000n]), bytes);
      assert.equal(observed.exit, 'machine_return');
      assert.deepEqual(observed.values, [BigInt.asUintN(64, 3n * 0xffffffffffffffffn)]);
      assert.deepEqual(observed.events, distinct ? ['load', 'load'] : ['load']);
      observations++;
    }
    for (const [ir, cases] of [
      [
        divide,
        [
          [-2147483648n, 1n],
          [2147483647n, -1n],
          [-7n, 3n],
          [7n, -3n],
          [0n, 5n],
          [-7n, -3n],
        ],
      ],
      [
        maximum,
        [
          [-2147483648n, 2147483647n],
          [2147483647n, -1n],
          [-1n, 0n],
          [-7n, -3n],
        ],
      ],
    ] as const) {
      const emitted = emit(ir, { source }, language);
      for (const [a, b] of cases) {
        const observed = execute(
          emitted.emission,
          inputs(ir, [BigInt.asUintN(32, a), BigInt.asUintN(32, b)]),
        );
        assert.equal(observed.exit, 'machine_return');
        // Signed source signatures still expose the same low-word ABI bits.
        assert.deepEqual(
          observed.values.map((value) => BigInt.asUintN(32, value)),
          [BigInt.asUintN(32, ir === divide ? a / b : a > b ? a : b)],
        );
        observations++;
      }
    }
    const dagOutput = emit(dag, { source }, language);
    assert.ok(
      dagOutput.emission.text.length < 10000,
      'Shared expression DAGs remain bounded, not recursively expanded',
    );
    const dagResult = execute(dagOutput.emission, inputs(dag, [0x123456789abcdefn]));
    assert.deepEqual(dagResult.values, [BigInt.asUintN(64, 0x123456789abcdefn * (1n << 24n))]);
    observations++;
    for (const [ir, emitted] of [
      [arithmetic, output],
      [width, wideOutput],
      [loop, loopOutput],
      [indexed, indexedOutput],
    ] as const)
      for (const block of ir.blocks)
        for (const node of [...block.instructions, block.terminator]) {
          const origins = new Set(
            expandEmission(emitted.emission)
              .mappings.filter((mapping) => mapping.statement_id === node.id)
              .flatMap((mapping) => mapping.instruction_ids),
          );
          for (const id of node.provenance.instruction_ids) assert.ok(origins.has(id));
        }
  }
  const arithmeticPlan = plan(arithmetic);
  assert.ok(
    [...arithmeticPlan.live].some((id) => {
      const value = arithmeticPlan.values.get(id)!;
      const product = expression(arithmeticPlan, value);
      return (
        product?.kind === 'integer' &&
        product.op === 'mul' &&
        [product.left, product.right].some((operand) => {
          const constant = expression(arithmeticPlan, operand);
          return constant?.kind === 'constant' && constant.bits === 3n;
        })
      );
    }),
    'Compiler shifted-add is recovered as multiplication by three',
  );
  const widthPlan = plan(width),
    returned = [...widthPlan.returns.values()][0]!.results[0]!;
  const shifted = expression(widthPlan, returned);
  assert.ok(shifted?.kind === 'integer' && shifted.op === 'lshr');
  const sum = expression(widthPlan, shifted.left);
  assert.ok(
    sum?.kind === 'integer' && sum.op === 'add',
    'Whole zero-extended sum is not split into low/high reconstruction',
  );
  assert.equal(bitWidth(shifted.left.type), 64, 'The carry bit of the 32+32 sum is retained');
  const indexedPlan = plan(indexed);
  const load = [...indexedPlan.blocks.values()]
    .flatMap((block) => block.statements)
    .find((node) => node.kind === 'load')!;
  assert.equal(load.kind, 'load');
  if (load.kind !== 'load') assert.fail('Expected load');
  const address = expression(indexedPlan, load.address);
  assert.ok(
    address?.kind === 'integer' && address.op === 'add',
    'Pointer address is not exposed as register-cell packing',
  );
  assert.ok(
    [address.left, address.right].some((value) => {
      const scale = expression(indexedPlan, value);
      return scale?.kind === 'integer' && scale.op === 'mul';
    }),
    'Scaled pointer indexing retains its element-size multiplication',
  );
  return { observations, fixtures: 16 };
}

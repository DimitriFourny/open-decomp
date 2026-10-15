import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { evaluate as sourceEvaluate, expectedSchema } from '../fixtures/oracle.js';
import type { SemanticCase } from '../fixtures/oracle.js';
import { OracleMemory, bitsFloat, evaluateIR, floatBits, floating, integer, vector } from '../../src/ir/index.js';
import type { DataType, FunctionIR, TrustedCall } from '../../src/ir/index.js';
import { builder, image, returned } from './support.js';

const i32 = integer(32), i64 = integer(64), f64 = floating(64);
const clobbers = { registers: [], flags: [], memory: 'unknown_read_write' as const };
/** These programs encode fixture source semantics, not decoder output or expected-value constants. */
function fixtureProgram(name: string): FunctionIR {
  const ir = builder(name);
  switch (name) {
    case 'fixture_arithmetic': {
      const b = ir.block('entry', [i32, i32]);
      b.return([b.int('xor', b.int('add', b.parameters[0]!, b.int('mul', b.parameters[1]!, b.constant(i32, 3n))), b.constant(i32, 0x55n))]);
      return ir.finish(b, [i32]);
    }
    case 'fixture_maximum': {
      const b = ir.block('entry', [i32, i32]); b.return([b.select(b.compare('sgt', b.parameters[0]!, b.parameters[1]!), b.parameters[0]!, b.parameters[1]!)]); return ir.finish(b, [i32]);
    }
    case 'fixture_loop': case 'fixture_variadic': {
      const element = name === 'fixture_loop' ? i32 : f64;
      const b = ir.block('entry', [i64, i32]), loop = ir.block('loop', [i64, i32, element]), body = ir.block('body', [i64, i32, element]), exit = ir.block('exit', [element]);
      b.jump(loop, [b.parameters[0]!, b.parameters[1]!, b.constant(element, 0n)]);
      loop.branch(loop.compare('eq', loop.parameters[1]!, loop.constant(i32, 0n)), loop.edge(exit, [loop.parameters[2]!]), loop.edge(body, loop.parameters));
      const loaded = body.load(element, body.parameters[0]!);
      const sum = element.kind === 'float' ? body.fp('add', body.parameters[2]!, loaded) : body.int('add', body.parameters[2]!, loaded);
      body.jump(loop, [body.int('add', body.parameters[0]!, body.constant(i64, BigInt(element.bits / 8))), body.int('sub', body.parameters[1]!, body.constant(i32, 1n)), sum]);
      exit.return([exit.parameters[0]!]); return ir.finish(b, [element]);
    }
    case 'fixture_stack': {
      const b = ir.block('entry', [i32, i64]); b.store(b.parameters[1]!, b.parameters[0]!);
      const next = b.int('add', b.parameters[1]!, b.constant(i64, 4n)); b.store(next, b.constant(i32, 7n));
      b.return([b.int('add', b.load(i32, b.parameters[1]!), b.load(i32, next))]); return ir.finish(b, [i32]);
    }
    case 'fixture_memory': {
      const b = ir.block('entry', [i64, i64]); const sum = b.int('add', b.load(i64, b.parameters[0]!), b.parameters[1]!);
      b.store(b.parameters[0]!, sum); b.return([sum]); return ir.finish(b, [i64]);
    }
    case 'fixture_direct': {
      const b = ir.block('entry', [i32]);
      const stack = b.call({ kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } }, [b.parameters[0]!], [i32], clobbers)[0]!;
      const arithmetic = b.call({ kind: 'direct', address: { image_id: image, space: 'va', value: 0x2100n } }, [b.parameters[0]!, b.constant(i32, 2n)], [i32], clobbers)[0]!;
      b.return([b.int('add', stack, arithmetic)]); return ir.finish(b, [i32]);
    }
    case 'fixture_indirect': {
      const b = ir.block('entry', [i64, i32]); const result = b.call({ kind: 'indirect', value: b.parameters[0]! }, [b.parameters[1]!], [i32], clobbers)[0]!;
      b.return([b.int('add', result, b.constant(i32, 1n))]); return ir.finish(b, [i32]);
    }
    case 'fixture_divide': {
      const b = ir.block('entry', [i32, i32]); b.return([b.int('sdiv', b.parameters[0]!, b.parameters[1]!)]); return ir.finish(b, [i32]);
    }
    case 'fixture_width': {
      const b = ir.block('entry', [i32, i32, i32]); const sum = b.int('add', b.cast('zero_extend', i64, b.parameters[0]!), b.cast('zero_extend', i64, b.parameters[1]!));
      b.return([b.int('lshr', sum, b.int('and', b.parameters[2]!, b.constant(i32, 63n)))]); return ir.finish(b, [i64]);
    }
    case 'fixture_stack_args': {
      const b = ir.block('entry', Array<DataType>(10).fill(i64)); let sum = b.constant(i64, 0n);
      for (let index = 0; index < 10; index++) sum = b.int('add', sum, b.int('mul', b.parameters[index]!, b.constant(i64, BigInt(index + 1))));
      b.return([sum]); return ir.finish(b, [i64]);
    }
    case 'fixture_float': {
      const b = ir.block('entry', [f64, f64]); b.return([b.fp('add', b.fp('mul', b.parameters[0]!, b.constant(f64, floatBits(1.5, 64))), b.fp('mul', b.parameters[1]!, b.constant(f64, floatBits(0.5, 64))))]); return ir.finish(b, [f64]);
    }
    case 'fixture_vector': case 'fixture_vector_integer': {
      const element = name === 'fixture_vector' ? floating(32) : i32, type = vector(element, 4);
      const b = ir.block('entry', [i64, i64, i64]); const a = b.load(type, b.parameters[0]!), c = b.load(type, b.parameters[1]!);
      const result = element.kind === 'float' ? b.vectorFloat('add', b.vectorFloat('add', a, a), c) : b.vectorInt('xor', b.vectorInt('add', a, c), b.pack(type, [0, 1, 2, 3].map(() => b.constant(i32, 0x55n))));
      b.store(b.parameters[2]!, result); b.return(); return ir.finish(b);
    }
    case 'fixture_string': {
      const b = ir.block('entry'); b.return([b.address({ image_id: image, space: 'va', value: 0x3000n })]); return ir.finish(b, [i64]);
    }
    default: throw new TypeError(`Unmodeled fixture ${name}`);
  }
}

const expected = expectedSchema.parse(JSON.parse(await readFile(new URL('../../fixtures/expected.json', import.meta.url), 'utf8')));
for (const fixture of expected.cases) {
  test(`typed IR matches independent source oracle: ${fixture.function} ${JSON.stringify(fixture.arguments)}`, () => {
    const program = fixtureProgram(fixture.function);
    const memory = new OracleMemory([{ base: 0x1000n, bytes: new Uint8Array(256), writable: true }, { base: 0x3000n, bytes: new TextEncoder().encode('open-decomp trusted fixture v1\0'), writable: false }]);
    const scalar = (index: number): string => {
      const value = fixture.arguments[index]; if (typeof value !== 'string') throw new TypeError('Expected scalar fixture argument'); return value;
    };
    const array = (index: number): readonly string[] => {
      const value = fixture.arguments[index]; if (!Array.isArray(value)) throw new TypeError('Expected vector fixture argument'); return value;
    };
    let args: bigint[];
    switch (fixture.function) {
      case 'fixture_loop': array(0).forEach((value, index) => memory.write(0x1000n + BigInt(index * 4), 32, BigInt(value))); args = [0x1000n, BigInt(scalar(1))]; break;
      case 'fixture_stack': args = [BigInt(scalar(0)), 0x1000n]; break;
      case 'fixture_memory': memory.write(0x1000n, 64, BigInt(scalar(0))); args = [0x1000n, BigInt(scalar(1))]; break;
      case 'fixture_indirect': assert.equal(scalar(0), 'fixture_stack'); args = [0x2000n, BigInt(scalar(1))]; break;
      case 'fixture_float': args = [floatBits(Number(scalar(0)), 64), floatBits(Number(scalar(1)), 64)]; break;
      case 'fixture_vector': case 'fixture_vector_integer':
        for (let arrayIndex = 0; arrayIndex < 2; arrayIndex++) array(arrayIndex).forEach((value, index) => memory.write(0x1000n + BigInt(arrayIndex * 32 + index * 4), 32, fixture.function === 'fixture_vector' ? floatBits(Number(value), 32) : BigInt(value)));
        args = [0x1000n, 0x1020n, 0x1040n]; break;
      case 'fixture_variadic':
        for (let index = 1; index < fixture.arguments.length; index++) memory.write(0x1000n + BigInt((index - 1) * 8), 64, floatBits(Number(scalar(index)), 64));
        args = [0x1000n, BigInt(scalar(0))]; break;
      default: args = fixture.arguments.map((_, index) => BigInt(scalar(index))); break;
    }
    const calls = new Map<string, TrustedCall>();
    for (const block of program.blocks) for (const node of block.instructions) if (node.kind === 'call') calls.set(node.id, input => {
      // Explicit source-level test contracts, not signatures inferred from names.
      if (input.target === 0x2000n) return { results: [BigInt.asUintN(32, input.arguments[0]! + 7n)], writes: [] };
      if (input.target === 0x2100n) return { results: [BigInt.asUintN(32, input.arguments[0]! + 3n * input.arguments[1]!) ^ 0x55n], writes: [] };
      throw new TypeError('No trusted call target contract');
    });
    const evaluation = evaluateIR(program, { arguments: args, memory: memory.snapshot(), calls });
    const values = returned(evaluation);
    const after = new OracleMemory(evaluation.memory);
    let result: SemanticCase['result'];
    if (fixture.function === 'fixture_vector' || fixture.function === 'fixture_vector_integer') result = [0, 1, 2, 3].map(index => {
      const value = after.read(0x1040n + BigInt(index * 4), 32); return String(fixture.function === 'fixture_vector' ? bitsFloat(value, 32) : value);
    });
    else if (fixture.function === 'fixture_string') {
      const bytes: number[] = [];
      for (let offset = 0; offset < 64; offset++) { const value = after.read(values[0]! + BigInt(offset), 8); if (value === 0n) break; bytes.push(Number(value)); }
      result = new TextDecoder().decode(Uint8Array.from(bytes));
    } else if (fixture.function === 'fixture_float' || fixture.function === 'fixture_variadic') result = String(bitsFloat(values[0]!, 64));
    else if (fixture.function === 'fixture_maximum' || fixture.function === 'fixture_divide') result = String(BigInt.asIntN(32, values[0]!));
    else result = String(values[0]!);
    assert.deepEqual(result, fixture.result);
    assert.deepEqual(result, sourceEvaluate(fixture).result);
    if (fixture.memoryAfter !== undefined) assert.equal(String(after.read(0x1000n, 64)), fixture.memoryAfter);
  });
}

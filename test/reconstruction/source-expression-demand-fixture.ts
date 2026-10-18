import assert from 'node:assert/strict';
import { createOperationContext, type Emission } from '../../src/core/index.js';
import { sysvAMD64Abi } from '../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { integer, type RegisterIR, type SSAForm } from '../../src/ir/index.js';
import { structureControlFlow } from '../../src/presentation/index.js';
import { reconstruct } from '../../src/reconstruction/index.js';
import type { Reconstruction } from '../../src/reconstruction/model.js';
import { builder, image, register } from '../ir/support.js';
import { emit, emittedFormals, execute } from '../emitters/c/support.js';

const i64 = integer(64);
const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');
const rsi = register('rsi', 64, 0, 'replace_root', 'x86_64:rsi');
const rax = register('rax', 64, 0, 'replace_root', 'x86_64:rax');
const rdx = register('rdx', 64, 0, 'replace_root', 'x86_64:rdx');
const source = { abi: sysvAMD64Abi, callees: [], addresses: [] };

export function checkSourceExpressionDemand(): { outcomes: number; scenarios: number } {
  const prepare = (input: RegisterIR) => {
    const converted = constructSSA(input);
    assert.equal(converted.state, 'complete');
    assert.equal(converted.value.form, 'ssa');
    if (converted.value.form !== 'ssa') assert.fail('Expected SSA');
    const ir = converted.value;
    const structured = structureControlFlow(ir, createOperationContext());
    assert.ok(structured.value);
    return {
      ir,
      program: reconstruct({ function: structured.value, source }, createOperationContext()),
    };
  };
  const inputs = (emission: Emission, program: Reconstruction, x: bigint, second: bigint) => {
    const values = new Map<string, bigint>();
    for (const formal of emittedFormals(emission)) {
      const root = program.parameter_registers.get(formal.statement_id)?.root;
      assert.ok(
        root === rdi.root || root === rsi.root,
        `Unexpected source parameter ${formal.name}`,
      );
      values.set(formal.statement_id, root === rdi.root ? x : second);
    }
    return values;
  };
  const originalSubjects = (ir: SSAForm, emission: Emission): void => {
    const mapped = new Set(
      emission.mappings.flatMap((mapping) =>
        mapping.semantic_refs.map((ref) => emission.ids[ref]!),
      ),
    );
    for (const block of ir.blocks)
      for (const node of [...block.instructions, block.terminator])
        assert.ok(mapped.has(node.id), `Original subject lost from emitted provenance: ${node.id}`);
  };
  let outcomes = 0;
  const b = builder('source-demand-unused-pure-not-effects'),
    entry = b.block('entry');
  const x = entry.readRegister(rdi),
    pointer = entry.readRegister(rsi);
  const unused = entry.int('shl', x, entry.constant(i64, 1n));
  entry.load(i64, pointer);
  entry.load(i64, pointer, { endian: 'little', alignment: 8, volatile: true });
  entry.call(
    { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
    [x],
    [i64],
    { registers: [], flags: [], memory: 'unknown_read_write' },
  );
  entry.return([x]);
  const effects = prepare(b.finish(entry, [i64]));
  const unnormalized = effects.program.expressions.get(unused.id);
  assert.ok(
    unnormalized?.kind === 'integer' && unnormalized.op === 'shl',
    'undemanded pure operation remains original, not secretly rewritten',
  );
  assert.ok(
    !effects.program.local_validation?.some((record) => record.subject === unused.id),
    'no proof is omitted for a performed dead rewrite',
  );
  for (const node of effects.ir.blocks.flatMap((block) => block.instructions))
    if (node.kind === 'load' || node.kind === 'call')
      assert.ok(effects.program.retained.has(node.id));
  for (const language of ['c-like', 'python-like'] as const) {
    const emission = emit(effects.ir, { source }, language).emission;
    originalSubjects(effects.ir, emission);
    for (const value of [0n, 1n, 0x8000000000000000n, 0xffffffffffffffffn]) {
      let calls = 0;
      const callback = (args: readonly bigint[]) => {
        calls++;
        assert.deepEqual(args, [value]);
        return 9n;
      };
      const bytes = new Map(
        Array.from({ length: 8 }, (_, offset) => [0x3000n + BigInt(offset), offset + 1]),
      );
      const observed = execute(
        emission,
        inputs(emission, effects.program, value, 0x3000n),
        bytes,
        0n,
        new Map(),
        new Map(),
        new Map([
          ['sub_2000', callback],
          ['0x2000', callback],
        ]),
      );
      assert.equal(observed.exit, 'machine_return');
      assert.deepEqual(observed.values, [value]);
      assert.deepEqual(observed.events, ['load', 'load', 'call']);
      assert.equal(calls, 1, 'unused call results do not make the call disappear');
      outcomes++;
    }
  }

  // This unresolved tail has no recovered source interface. Its physical return
  // channel must stay rooted before identity/snapshot reduction, even though the
  // function has no explicit source return value.
  const tailBuilder = builder('source-demand-unknown-physical-channel'),
    tailEntry = tailBuilder.block('entry');
  const argument = tailEntry.readRegister(rdi),
    target = tailEntry.readRegister(rsi);
  tailEntry.writeRegister(rax, tailEntry.int('shl', argument, tailEntry.constant(i64, 1n)));
  tailEntry.terminate({
    kind: 'indirect',
    target,
    tail_call: true,
    reason: 'unresolved trusted fixture tail',
  });
  const tail = prepare(tailBuilder.finish(tailEntry));
  const exits = [...tail.program.physical_exits.values()].flat();
  assert.ok(exits.some((binding) => binding.register.root === rax.root));
  for (const language of ['c-like', 'python-like'] as const) {
    const emission = emit(tail.ir, { source }, language).emission;
    originalSubjects(tail.ir, emission);
    for (const value of [0n, 1n, 0x8000000000000000n, 0xffffffffffffffffn]) {
      const observed = execute(emission, inputs(emission, tail.program, value, 0x4000n));
      assert.equal(observed.exit, 'tail_call');
      assert.equal(observed.tail_target, 0x4000n);
      assert.deepEqual(observed.registers.get(rax.root), {
        bits: BigInt.asUintN(64, value * 2n),
        known: 0xffffffffffffffffn,
      });
      outcomes++;
    }
  }

  // Caller consumption keeps another changed ABI return word inline even
  // beside an explicit scalar result, without inventing an aggregate.
  const overlayBuilder = builder('source-demand-uncertain-return-overlay'),
    overlayEntry = overlayBuilder.block('entry');
  const overlayArgument = overlayEntry.readRegister(rdi);
  overlayEntry.writeRegister(
    rdx,
    overlayEntry.int('shl', overlayArgument, overlayEntry.constant(i64, 1n)),
  );
  overlayEntry.return([overlayArgument]);
  const overlay = prepare(overlayBuilder.finish(overlayEntry, [i64]));
  assert.ok(
    [...overlay.program.returns.values()].some((boundary) =>
      boundary.outputs.some((binding) => binding.register.root === rdx.root),
    ),
  );
  for (const language of ['c-like', 'python-like'] as const) {
    const emission = emit(
      overlay.ir,
      { source: { ...source, function_return_demands: [rdx] } },
      language,
    ).emission;
    originalSubjects(overlay.ir, emission);
    for (const value of [0n, 1n, 0x8000000000000000n, 0xffffffffffffffffn]) {
      const observed = execute(emission, inputs(emission, overlay.program, value, 0n));
      assert.equal(observed.exit, 'machine_return');
      assert.deepEqual(observed.values, [value]);
      assert.deepEqual(observed.registers.get(rdx.root), {
        bits: BigInt.asUintN(64, value * 2n),
        known: 0xffffffffffffffffn,
      });
      outcomes++;
    }
  }

  const unknownBuilder = builder('source-demand-unknown-effect'),
    unknownEntry = unknownBuilder.block('entry');
  const unknownArgument = unknownEntry.readRegister(rdi);
  unknownEntry.unknown('trusted unresolved effect boundary', {
    registers: [],
    flags: [],
    memory: 'unknown_read_write',
  });
  unknownEntry.return([unknownArgument]);
  const unknown = prepare(unknownBuilder.finish(unknownEntry, [i64]));
  for (const language of ['c-like', 'python-like'] as const) {
    const emission = emit(unknown.ir, { source }, language).emission;
    originalSubjects(unknown.ir, emission);
    const observed = execute(emission, inputs(emission, unknown.program, 17n, 0n));
    assert.equal(observed.exit, 'unknown');
    assert.deepEqual(observed.events, ['unknown']);
    outcomes++;
  }
  return { outcomes, scenarios: 4 };
}

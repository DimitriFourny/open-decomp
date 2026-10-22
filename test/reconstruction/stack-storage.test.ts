import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createOperationContext, newIdentity, type AbiProfile } from '../../src/core/index.js';
import { darwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import { windowsX64Abi } from '../../src/abi/windows-x64/index.js';
import { sysvAMD64Abi } from '../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { recoverTypes } from '../../src/analysis/types/index.js';
import { integer, type RegisterIR, type SSAForm } from '../../src/ir/index.js';
import { structureControlFlow } from '../../src/presentation/index.js';
import { reconstruct } from '../../src/reconstruction/index.js';
import type { StoredDecompilation } from '../../src/project/cache/index.js';
import { builder, image, register, slice } from '../ir/support.js';
import {
  acknowledgeRequirements,
  emit,
  emittedFormals,
  execute,
  type EmittedFormal,
} from '../emitters/c/support.js';
import { project } from '../service/analysis/support.js';

type StoredEmission = StoredDecompilation['data']['emission'];

const u32 = integer(32),
  u64 = integer(64);
const targets = [
  { abi: darwinArm64Abi, incoming: 0n },
  { abi: sysvAMD64Abi, incoming: 8n },
  { abi: windowsX64Abi, incoming: 40n },
];

function source(input: RegisterIR, abi: AbiProfile) {
  const constructed = constructSSA(input);
  assert.equal(constructed.value.form, 'ssa');
  const ir = constructed.value as SSAForm;
  const types = recoverTypes(ir, abi, createOperationContext(), {
    image_id: image,
    slice_id: slice,
    revision: 0,
  });
  assert.equal(types.state, 'complete');
  return { ir, extra: { types, source: { abi, callees: [], addresses: [] } } };
}

function bytes(memory: Map<bigint, number>, address: bigint, value: bigint, count: number): void {
  for (let index = 0; index < count; index++)
    memory.set(address + BigInt(index), Number((value >> BigInt(index * 8)) & 255n));
}

function formalInput(
  emission: Parameters<typeof execute>[0],
  name: string,
): EmittedFormal | undefined {
  return emittedFormals(emission).find((formal) => formal.name === name);
}

/** S4: incoming bytes kept as memory print as the `stack_args` struct formal,
 * the address of the first incoming byte; no `entry_sp` formal remains. */
function incomingObjectInput(
  emission: Parameters<typeof execute>[0],
  abi: AbiProfile,
  entry: bigint,
): Map<string, bigint> {
  assert.doesNotMatch(emission.text, /\bentry_sp\b/, emission.text);
  assert.ok(emission.local_validation?.some((record) => record.rule === 'incoming_object'));
  const input = formalInput(emission, 'stack_args');
  assert.ok(input, emission.text);
  return new Map([[input.statement_id, entry + abi.stack_return_address_bytes]]);
}

for (const { abi, incoming } of targets)
  for (const framed of [false, true])
    test(`${abi.id}: ${framed ? 'framed alias' : 'frameless'} unclassified incoming bytes are incoming-object memory`, () => {
      const b = builder(`incoming-packed-${abi.id}-${framed}`),
        block = b.block('entry');
      const entry = block.readRegister(abi.stack_pointer);
      let base = entry;
      if (framed) {
        const frame = block.int('sub', entry, block.constant(u64, 48n));
        block.writeRegister(abi.stack_pointer, frame);
        const fp = register('storage-fp', 64, 0, 'replace_root', `${abi.architecture}:storage-fp`);
        block.writeRegister(fp, frame);
        base = block.int('add', block.readRegister(fp), block.constant(u64, 48n));
      }
      // Byte-addressable input, deliberately not a whole scalar ABI word. The
      // independent oracle is little-endian memcpy of four supplied bytes.
      const pointer = block.int('add', base, block.constant(u64, incoming + 1n));
      block.return([block.load(u32, pointer)]);
      const { ir, extra } = source(b.finish(block, [u32]), abi);
      for (const language of ['c-like', 'python-like'] as const) {
        const output = emit(ir, extra, language);
        assert.doesNotMatch(output.emission.text, /\bstack_frame\b/);
        const memory = new Map<bigint, number>();
        bytes(memory, 0x9000n + incoming + 1n, 0x89abcdefn, 4);
        const observation = execute(
          output.emission,
          incomingObjectInput(output.emission, abi, 0x9000n),
          memory,
        );
        assert.deepEqual(observation.values, [0x89abcdefn]);
        assert.deepEqual(observation.events, ['load']);
      }
    });

for (const { abi } of targets.filter(({ abi }) => abi.stack_return_address_bytes !== 0n))
  test(`${abi.id}: an observed hardware return address is external entry storage`, () => {
    const b = builder(`observed-return-address-${abi.id}`),
      block = b.block('entry');
    block.return([block.load(u64, block.readRegister(abi.stack_pointer))]);
    const { ir, extra } = source(b.finish(block, [u64]), abi);
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(ir, extra, language);
      assert.doesNotMatch(output.emission.text, /\bstack_frame\b/);
      const input = formalInput(output.emission, 'entry_sp');
      assert.ok(input, output.emission.text);
      const memory = new Map<bigint, number>();
      bytes(memory, 0x9000n, 0x123456789abcdef0n, 8);
      assert.deepEqual(
        execute(output.emission, new Map([[input.statement_id, 0x9000n]]), memory).values,
        [0x123456789abcdef0n],
      );
    }
  });

test('Windows home space is incoming-object memory, not a fifth argument or a private local', () => {
  const b = builder('windows-home-space'),
    block = b.block('entry');
  const address = block.int(
    'add',
    block.readRegister(windowsX64Abi.stack_pointer),
    block.constant(u64, 8n),
  );
  block.return([block.load(u64, address)]);
  const { ir, extra } = source(b.finish(block, [u64]), windowsX64Abi);
  for (const language of ['c-like', 'python-like'] as const) {
    const output = emit(ir, extra, language);
    assert.doesNotMatch(output.emission.text, /\bstack_frame\b/);
    const memory = new Map<bigint, number>();
    bytes(memory, 0x9008n, 0xfedcba9876543210n, 8);
    assert.deepEqual(
      execute(output.emission, incomingObjectInput(output.emission, windowsX64Abi, 0x9000n), memory)
        .values,
      [0xfedcba9876543210n],
    );
  }
});

for (const { abi, incoming } of targets)
  test(`${abi.id}: overlapping writes and reads of incoming bytes retain one address space`, () => {
    const b = builder(`incoming-alias-${abi.id}`),
      block = b.block('entry');
    const address = block.int(
      'add',
      block.readRegister(abi.stack_pointer),
      block.constant(u64, incoming),
    );
    block.store(address, block.constant(u64, 0x123456789abcdef0n));
    const upper = block.int('add', address, block.constant(u64, 4n));
    block.return([block.load(u32, upper)]);
    const { ir, extra } = source(b.finish(block, [u32]), abi);
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(ir, extra, language);
      assert.doesNotMatch(output.emission.text, /\bstack_frame\b/);
      const memory = new Map<bigint, number>();
      bytes(memory, 0x9000n + incoming, 0n, 8);
      const observation = execute(
        output.emission,
        incomingObjectInput(output.emission, abi, 0x9000n),
        memory,
      );
      assert.deepEqual(observation.values, [0x12345678n]);
      assert.deepEqual(observation.events, ['store', 'load']);
      assert.equal(observation.memory.get(0x9000n + incoming), 0xf0);
    }
  });

test('SysV red-zone bytes with definite initialization remain private storage', () => {
  const b = builder('sysv-red-zone-private'),
    block = b.block('entry');
  const address = block.int(
    'sub',
    block.readRegister(sysvAMD64Abi.stack_pointer),
    block.constant(u64, 128n),
  );
  const access = { endian: 'little', alignment: 1, volatile: true } as const;
  block.store(address, block.constant(u64, 0x89abcdef01234567n), access);
  block.return([block.load(u64, address, access)]);
  const { ir, extra } = source(b.finish(block, [u64]), sysvAMD64Abi);
  for (const language of ['c-like', 'python-like'] as const) {
    const output = emit(ir, extra, language);
    assert.match(output.emission.text, /\bframe\.local_80\b/);
    assert.doesNotMatch(output.emission.text, /\bentry_sp\b/);
    const observation = execute(output.emission);
    assert.deepEqual(observation.values, [0x89abcdef01234567n]);
    assert.deepEqual(observation.events, ['store', 'load']);
  }
});

for (const { abi, incoming } of targets)
  test(`${abi.id}: alignment arithmetic retains the actual entry stack base`, () => {
    const b = builder(`stack-alignment-${abi.id}`),
      block = b.block('entry');
    const aligned = block.int(
      'and',
      block.readRegister(abi.stack_pointer),
      block.constant(u64, 0xfffffffffffffff0n),
    );
    const pointer = block.int('add', aligned, block.constant(u64, incoming));
    block.return([block.load(u32, pointer)]);
    const { ir, extra } = source(b.finish(block, [u32]), abi);
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(ir, extra, language);
      assert.doesNotMatch(output.emission.text, /\bstack_frame\b/);
      const input = formalInput(output.emission, 'entry_sp');
      assert.ok(input, output.emission.text);
      const memory = new Map<bigint, number>();
      bytes(memory, 0x9000n + incoming, 0x12345678n, 4);
      const observation = execute(
        output.emission,
        new Map([[input.statement_id, 0x9008n]]),
        memory,
      );
      assert.deepEqual(observation.values, [0x12345678n]);
    }
  });

// Consumer-visible compiler fixtures complement the focused storage IR cases.
// These are existing first-party C inputs, never supplied as analysis hints.
for (const fixture of [
  {
    path: 'fixtures/bin/corpus-symbols.dll',
    address: 0x1800010f0n,
    count: 10,
    weighted: true,
    elf: false,
  },
  {
    path: 'test/abi/sysv-amd64/fixtures/abi.so',
    address: 0x1760n,
    count: 8,
    weighted: false,
    elf: true,
  },
])
  test(`${fixture.path}: public mixed register/stack inputs obey their C oracle`, async (t) => {
    const p = await project(t, readFileSync(fixture.path));
    const fn = p.functions.find((candidate) => candidate.entry.value === fixture.address);
    assert.ok(fn);
    for (const emitter of ['c-like', 'python-like'] as const) {
      const result: StoredDecompilation = p.payload(
        (await p.decompile(fn.id, { options: { emitter } })).result,
      ).result;
      assert.equal(result.state, fixture.elf ? 'partial' : 'complete');
      assert.equal(
        result.coverage.find((coverage) => coverage.layer === 'reconstruction')?.state,
        'complete',
      );
      if (fixture.elf) {
        assert.equal(
          result.coverage.find((coverage) => coverage.layer === 'analysis')?.state,
          'partial',
        );
        assert.ok(
          result.diagnostics.every(
            (diagnostic) =>
              diagnostic.code === 'unavailable_semantics' && diagnostic.severity === 'warning',
          ),
        );
      }
      const emission: StoredEmission = result.data.emission;
      const formals: readonly EmittedFormal[] = emittedFormals(emission).filter(
        (formal) => formal.name !== 'entry_sp',
      );
      assert.equal(formals.length, fixture.count, emission.text);
      for (const values of [
        Array.from({ length: fixture.count }, (_, index) => BigInt(index + 1)),
        Array<bigint>(fixture.count).fill(0xffffffffffffffffn),
      ]) {
        const observation = execute(
          emission,
          new Map<string, bigint>(
            formals.map((mapping: EmittedFormal, index: number): [string, bigint] => [
              mapping.statement_id,
              values[index]!,
            ]),
          ),
        );
        const expected = BigInt.asUintN(
          64,
          values.reduce(
            (sum, value, index) => sum + value * (fixture.weighted ? BigInt(index + 1) : 1n),
            0n,
          ),
        );
        assert.deepEqual(observation.values, [expected]);
      }
    }
  });

test('Darwin stack varargs retain entry bytes across frame allocation and pointer updates', async (t) => {
  const p = await project(t, 'macho-arm64-symbols');
  const fn = p.functions.find((candidate) => candidate.entry.value === 0x1000006d0n);
  assert.ok(fn);
  const toBits = (value: number): bigint => {
    const buffer = new DataView(new ArrayBuffer(8));
    buffer.setFloat64(0, value, true);
    return buffer.getBigUint64(0, true);
  };
  for (const emitter of ['c-like', 'python-like'] as const) {
    const result: StoredDecompilation = p.payload(
      (await p.decompile(fn.id, { options: { emitter } })).result,
    ).result;
    // Unsupported FP environments remain explicit guarded unknown paths.
    assert.equal(result.state, 'partial');
    assert.equal(result.coverage.find((coverage) => coverage.layer === 'lift')?.state, 'partial');
    const emission: StoredEmission = result.data.emission;
    const declared: readonly EmittedFormal[] = emittedFormals(emission);
    const entry: EmittedFormal | undefined = declared.find((formal) => formal.name === 'entry_sp');
    const count: EmittedFormal | undefined = declared.find((formal) => formal.name !== 'entry_sp');
    assert.ok(entry, emission.text);
    assert.ok(count, emission.text);
    assert.doesNotMatch(emission.text, /\bstack_frame\b/);
    // Exactly representable finite IEEE binary64 values under the documented
    // default FP environment; fixture source sums count va_arg(double) values.
    const values = [1.25, 2.5, -0.5];
    for (let length = 0; length <= values.length; length++) {
      const memory = new Map<bigint, number>();
      for (let index = 0; index < values.length; index++)
        bytes(memory, 0x9000n + BigInt(index * 8), toBits(values[index]!), 8);
      // The native va_list cursor is a private slot at entry SP minus eight.
      bytes(memory, 0x8ff8n, 0n, 8);
      const observation = execute(
        emission,
        new Map([
          [entry.statement_id, 0x9000n],
          [count.statement_id, BigInt(length)],
        ]),
        memory,
        0n,
        new Map(),
        new Map(),
        new Map(),
        acknowledgeRequirements(emission),
      );
      const expected = values.slice(0, length).reduce((sum, value) => sum + value, 0);
      assert.deepEqual(observation.values, [toBits(expected)]);
    }
  }
});

test('source-built SysV red-zone and dynamic framed locals preserve definite initialization', async (t) => {
  const p = await project(t, readFileSync('test/abi/sysv-amd64/fixtures/abi.so'));
  for (const fixture of [
    { address: 0x17f0n, dynamic: false },
    { address: 0x1820n, dynamic: true },
  ]) {
    const fn = p.functions.find((candidate) => candidate.entry.value === fixture.address);
    assert.ok(fn);
    for (const emitter of ['c-like', 'python-like'] as const) {
      const result: StoredDecompilation = p.payload(
        (await p.decompile(fn.id, { options: { emitter } })).result,
      ).result;
      assert.equal(result.state, 'partial');
      assert.ok(
        result.diagnostics.every(
          (diagnostic) =>
            diagnostic.code === 'unavailable_semantics' && diagnostic.severity === 'warning',
        ),
      );
      assert.equal(
        result.coverage.find((coverage) => coverage.layer === 'analysis')?.state,
        'partial',
      );
      assert.equal(
        result.coverage.find((coverage) => coverage.layer === 'reconstruction')?.state,
        'complete',
      );
      const emission: StoredEmission = result.data.emission;
      const declared: readonly EmittedFormal[] = emittedFormals(emission);
      const sourceArguments = declared.filter((formal) => formal.name !== 'entry_sp');
      const argument = sourceArguments[0]!.statement_id;
      const index = fixture.dynamic ? sourceArguments[1]!.statement_id : null;
      const stack = declared.find((formal) => formal.name === 'entry_sp')?.statement_id;
      for (const a of [0n, 0x8000000000000000n, 0xffffffffffffffffn])
        for (const offset of fixture.dynamic ? [0n, 1n, 39n, 40n, 0xffffffffn] : [0n]) {
          const inputs = new Map([[argument, a]]);
          if (index) inputs.set(index, offset);
          if (stack) inputs.set(stack, 0x9000n);
          const memory = new Map<bigint, number>();
          if (fixture.dynamic)
            for (let byte = -328; byte < 0; byte++) memory.set(0x9000n + BigInt(byte), 0);
          const observation = execute(emission, inputs, memory);
          const expected = fixture.dynamic
            ? offset % 40n === 0n
              ? 7n
              : a
            : BigInt.asUintN(64, a + 16n);
          assert.deepEqual(observation.values, [expected]);
        }
    }
  }
});

for (const { abi } of targets)
  test(`${abi.id}: unproven call interfaces cannot erase candidate outgoing stores as dead locals`, () => {
    const first = abi.classifyCall({
      returns: { kind: 'void' },
      parameters: [{ kind: 'integer', bits: 64, signed: false }],
      variadic: false,
      fixed_parameter_count: 1,
    }).parameters[0]!.locations[0]!;
    assert.ok(first.kind === 'register');
    const b = builder(`outgoing-stack-${abi.id}`),
      block = b.block('entry');
    const stack = block.int('sub', block.readRegister(abi.stack_pointer), block.constant(u64, 64n));
    block.writeRegister(abi.stack_pointer, stack);
    block.store(stack, block.constant(u64, 77n));
    block.writeRegister(first.register, block.constant(u64, 33n));
    block.call(
      { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
      [],
      [],
      { registers: [], flags: [], memory: 'none' },
      [newIdentity('evidence')],
    );
    block.return([block.constant(u64, 0n)]);
    const { ir, extra } = source(b.finish(block, [u64]), abi);
    const call = ir.blocks[0]!.instructions.find((node) => node.kind === 'call')!;
    const store = ir.blocks[0]!.instructions.find((node) => node.kind === 'store')!;
    const structured = structureControlFlow(ir, createOperationContext());
    assert.ok(structured.value);
    const sourceEvidence = {
      abi,
      addresses: [],
      callees: [{ call_id: call.id, parameters: [first.register], returns: [], evidence_ids: [] }],
    };
    const projection = reconstruct(
      {
        function: structured.value,
        ...extra,
        source: sourceEvidence,
      },
      createOperationContext(),
    );
    assert.ok(
      projection.retained.has(store.id),
      'callee stack reads are not disproved by register-only observations',
    );
    assert.equal(projection.source?.locals.size, 0);
    assert.equal(projection.source?.stack?.kind, 'private');
    assert.equal(projection.calls.get(call.id)?.argument_list_complete, false);
    assert.equal(projection.calls.get(call.id)?.arguments.length, 1);
    assert.ok(
      projection.diagnostics.some((diagnostic) => diagnostic.code === 'unavailable_semantics'),
    );
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(ir, { ...extra, source: sourceEvidence }, language);
      // The call prints its one proven argument; the open arity is named once.
      assert.match(output.emission.text, /\w\(\w+\)/);
      assert.match(output.emission.text, /open arity \([^)]*\): \w+/);
      assert.doesNotMatch(output.emission.text, /, \.\.\.\)/);
    }
  });

for (const { abi, incoming } of targets)
  test(`${abi.id}: an escaped entry-relative address is not replaced by a newly allocated object`, () => {
    const b = builder(`escaped-entry-address-${abi.id}`),
      block = b.block('entry');
    block.return([
      block.int('add', block.readRegister(abi.stack_pointer), block.constant(u64, incoming + 16n)),
    ]);
    const { ir, extra } = source(b.finish(block, [u64]), abi);
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(ir, extra, language);
      assert.doesNotMatch(output.emission.text, /\bstack_frame\b/);
      const input = formalInput(output.emission, 'entry_sp');
      assert.ok(input, output.emission.text);
      const observation = execute(output.emission, new Map([[input.statement_id, 0x9000n]]));
      assert.deepEqual(observation.values, [0x9000n + incoming + 16n]);
    }
  });

for (const { abi } of targets)
  test(`${abi.id}: saved-register bytes are not invented source inputs or private source locals`, () => {
    const preserved = abi.preserved.find(
      (descriptor) => descriptor.bank === 'integer' && descriptor.width_bits === 64,
    );
    assert.ok(preserved);
    const b = builder(`saved-register-storage-${abi.id}`),
      block = b.block('entry');
    const slot = block.int('sub', block.readRegister(abi.stack_pointer), block.constant(u64, 16n));
    block.store(slot, block.readRegister(preserved));
    block.writeRegister(preserved, block.load(u64, slot));
    block.return([block.constant(u64, 0n)]);
    const { ir, extra } = source(b.finish(block, [u64]), abi);
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(ir, extra, language);
      assert.doesNotMatch(output.emission.text, /\b(?:entry_sp|stack_frame)\b/);
      assert.equal(emittedFormals(output.emission).length, 0);
      const observation = execute(output.emission);
      assert.deepEqual(observation.values, [0n]);
      assert.deepEqual(observation.events, []);
    }
  });

for (const { abi } of targets.filter(({ abi }) => abi.stack_return_address_bytes !== 0n))
  test(`${abi.id}: a dead return-address read does not turn actual private bytes into incoming storage`, () => {
    const b = builder(`dead-ra-private-${abi.id}`),
      block = b.block('entry');
    const entry = block.readRegister(abi.stack_pointer);
    block.load(u64, entry);
    const slot = block.int('sub', entry, block.constant(u64, 16n));
    const access = { endian: 'little', alignment: 1, volatile: true } as const;
    block.store(slot, block.constant(u64, 77n), access);
    block.return([block.load(u64, slot, access)]);
    const { ir, extra } = source(b.finish(block, [u64]), abi);
    const structured = structureControlFlow(ir, createOperationContext());
    assert.ok(structured.value);
    const projection = reconstruct(
      { function: structured.value, ...extra },
      createOperationContext(),
    );
    assert.equal(projection.source?.stack?.kind, 'private');
    assert.equal(projection.parameters.length, 0);
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(ir, extra, language);
      assert.doesNotMatch(output.emission.text, /\bentry_sp\b/);
      assert.deepEqual(execute(output.emission).values, [77n]);
    }
  });

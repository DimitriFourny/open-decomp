import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationContext,
  entityIdentity,
  newIdentity,
  type AbiProfile,
  type RegisterDescriptor,
} from '../../src/core/index.js';
import { darwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../src/abi/sysv-amd64/index.js';
import { windowsX64Abi } from '../../src/abi/windows-x64/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { recoverTypes } from '../../src/analysis/types/index.js';
import { integer, type Provenance, type RegisterIR, type SSAForm } from '../../src/ir/index.js';
import { structureControlFlow } from '../../src/presentation/index.js';
import { reconstruct, type Reconstruction } from '../../src/reconstruction/index.js';
import {
  fpEnvironmentGuard,
  stateRegister,
  unknownClobbers,
} from '../../src/lifters/arm64/semantics.js';
import { builder, image, provenance, slice } from '../ir/support.js';
import { emit, emittedFormals, execute, Parser } from '../emitters/c/support.js';

const u64 = integer(64),
  u32 = integer(32),
  f64 = { kind: 'float', bits: 64 } as const;
const targets = [darwinArm64Abi, sysvAMD64Abi, windowsX64Abi];
function prepare(
  input: RegisterIR,
  abi: AbiProfile,
  closure = false,
  parameters: RegisterDescriptor[] = [],
) {
  const ir = constructSSA(input).value as SSAForm;
  const types = recoverTypes(ir, abi, createOperationContext(), {
    image_id: image,
    slice_id: slice,
    revision: 0,
  });
  const structured = structureControlFlow(ir, createOperationContext());
  assert.ok(structured.value);
  const extra = {
    types,
    source: {
      abi,
      callees: closure
        ? ir.blocks.flatMap((block) =>
            block.instructions.flatMap((node) =>
              node.kind === 'call'
                ? [
                    {
                      call_id: node.id,
                      parameters,
                      returns: [],
                      argument_list_complete: false,
                      argument_list_closure: 'callee_reads' as const,
                      evidence_ids: [],
                    },
                  ]
                : [],
            ),
          )
        : [],
      addresses: [],
    },
  };
  return {
    ir,
    extra,
    view: (view: 'source' | 'checked') =>
      reconstruct({ function: structured.value!, ...extra }, createOperationContext(), view),
  };
}
function firstArgument(abi: AbiProfile) {
  const location = abi.classifyCall({
    returns: { kind: 'void' },
    parameters: [{ kind: 'integer', bits: 64, signed: false }],
    variadic: false,
    fixed_parameter_count: 1,
  }).parameters[0]!.locations[0]!;
  assert.equal(location.kind, 'register');
  if (location.kind !== 'register') throw new Error('Expected register argument');
  return location.register;
}
function rules(program: Reconstruction) {
  return (
    program.local_validation
      ?.filter((record) => record.kind === 'presentation')
      .map((record) => record.rule) ?? []
  );
}
/** Promoted frame slots (`offset:end` in entry-SP coordinates). */
function promoted(program: Reconstruction) {
  return new Set(
    (program.local_validation ?? []).flatMap((record) =>
      record.kind === 'presentation' &&
      (record.rule === 'private_stack_promotion' || record.rule === 'wide_slot_parts')
        ? [record.subject, ...(record.subject_ids ?? [])]
            .filter((id) => id.startsWith('stack:'))
            .map((id) => id.slice('stack:'.length))
        : [],
    ),
  );
}
function requirements(program: Reconstruction) {
  return program.local_validation_session?.abiConformance.map((site) => site.rule) ?? [];
}

for (const abi of targets) {
  test(`${abi.id}: private slots stay disjoint from external stores only before any escape`, () => {
    for (const escape of [false, true]) {
      const b = builder(`external-store-private-${abi.id}-${escape}`),
        block = b.block('entry');
      const pointer = block.readRegister(firstArgument(abi));
      const slot = block.int(
        'sub',
        block.readRegister(abi.stack_pointer),
        block.constant(u64, 24n),
      );
      block.store(slot, block.constant(u64, 77n));
      if (escape) block.store(pointer, slot);
      block.store(pointer, block.constant(u64, 19n));
      block.return([block.load(u64, slot)]);
      const fixture = prepare(b.finish(block, [u64]), abi);
      assert.equal(rules(fixture.view('source')).includes('private_stack_promotion'), !escape);
      assert.ok(!rules(fixture.view('checked')).includes('private_stack_promotion'));
      if (escape) continue;
      assert.ok(
        fixture
          .view('source')
          .local_validation_session?.abiConformance.some(
            (site) => site.rule === 'frame_private_to_activation',
          ),
      );
      for (const language of ['c-like', 'python-like'] as const) {
        const output = emit(fixture.ir, fixture.extra, language).emission;
        assert.doesNotMatch(output.text, /entry_sp|stack_frame/);
        const argument = emittedFormals(output)[0]!;
        const memory = new Map(
          Array.from({ length: 8 }, (_, index) => [0xa000n + BigInt(index), 0] as const),
        );
        const observation = execute(output, new Map([[argument.statement_id, 0xa000n]]), memory);
        assert.deepEqual(observation.values, [77n]);
        assert.equal(observation.memory.get(0xa000n), 19);
        assert.deepEqual(observation.events, ['store']);
      }
    }
  });

  test(`${abi.id}: an open call's argument area ends below a slot read back after it`, () => {
    // The call's stack arguments start just above its pushed return address.
    const low = -64n + abi.stack_return_address_bytes,
      high = low + 16n;
    for (const gate of ['after', 'overwritten', 'readback'] as const) {
      const b = builder(`open-call-area-${abi.id}-${gate}`),
        block = b.block('entry');
      const sp = block.int('sub', block.readRegister(abi.stack_pointer), block.constant(u64, 64n));
      block.writeRegister(abi.stack_pointer, sp);
      const lowSlot = block.int('add', sp, block.constant(u64, low + 64n)),
        highSlot = block.int('add', sp, block.constant(u64, high + 64n));
      if (gate !== 'after') {
        block.store(lowSlot, block.constant(u64, 1n));
        block.store(highSlot, block.constant(u64, 2n));
      }
      block.call(
        { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
        [],
        [],
        { registers: [], flags: [], memory: 'unknown_read_write' },
        [newIdentity('evidence')],
      );
      if (gate !== 'readback') block.store(highSlot, block.constant(u64, 2n));
      block.store(lowSlot, block.constant(u64, 3n));
      block.return([block.int('add', block.load(u64, lowSlot), block.load(u64, highSlot))]);
      const source = prepare(b.finish(block, [u64]), abi).view('source');
      // Pre-call contents read back after the call bound the open area: the
      // slot read back and everything above it are not argument storage.
      const expected =
        gate === 'after'
          ? [`${low}:${low + 8n}`, `${high}:${high + 8n}`]
          : gate === 'readback'
            ? [`${high}:${high + 8n}`]
            : [];
      assert.deepEqual([...promoted(source)].sort(), expected.sort());
      assert.equal(requirements(source).includes('open_call_argument_area'), gate === 'readback');
    }
  });

  test(`${abi.id}: an address passed to a call escapes only its slot and the bytes above it`, () => {
    const b = builder(`call-escape-${abi.id}`),
      block = b.block('entry');
    const sp = block.int('sub', block.readRegister(abi.stack_pointer), block.constant(u64, 48n));
    block.writeRegister(abi.stack_pointer, sp);
    const below = block.int('add', sp, block.constant(u64, 8n)),
      escaped = block.int('add', sp, block.constant(u64, 16n)),
      above = block.int('add', sp, block.constant(u64, 32n));
    block.store(escaped, block.constant(u64, 7n));
    block.writeRegister(firstArgument(abi), escaped);
    block.call(
      { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
      [],
      [],
      abi.unknown_call_clobbers,
      [newIdentity('evidence')],
    );
    // Fresh after the call: only the escape can keep these slots explicit.
    block.store(below, block.constant(u64, 5n));
    block.store(above, block.constant(u64, 6n));
    const sum = block.int('add', block.load(u64, below), block.load(u64, above));
    block.return([block.int('add', sum, block.load(u64, escaped))]);
    const fixture = prepare(b.finish(block, [u64]), abi, true, [firstArgument(abi)]);
    const source = fixture.view('source');
    assert.ok(rules(source).includes('arity_closure'));
    assert.deepEqual([...promoted(source)], ['-40:-32']);
    assert.ok(requirements(source).includes('frame_object_base'));
    assert.ok(requirements(source).includes('frame_object'));
    assert.deepEqual([...promoted(fixture.view('checked'))], []);
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(fixture.ir, fixture.extra, language).emission;
      // The escaped slot and the slot above it stay memory: members of the
      // frame object, the escaped one passed by address.
      assert.doesNotMatch(output.text, /entry_sp/);
      assert.match(
        output.text,
        language === 'c-like'
          ? /sub_2000\(&frame\.local_20\)/
          : /sub_2000\(address_of\(frame\.local_20\)\)/,
      );
      let calls = 0;
      const observation = execute(
        output,
        new Map(),
        new Map(),
        0n,
        new Map(),
        new Map(),
        new Map([['sub_2000', () => (calls++, [])]]),
      );
      // 5 + 6 + 7: the callee leaves the escaped slot unchanged.
      assert.deepEqual(observation.values, [18n]);
      assert.equal(calls, 1);
    }
  });

  test(`${abi.id}: a frame address stored to memory escapes, also through an escaped slot`, () => {
    for (const gate of ['direct', 'nested'] as const) {
      const b = builder(`stored-escape-${abi.id}-${gate}`),
        block = b.block('entry');
      const pointer = block.readRegister(firstArgument(abi)),
        entry = block.readRegister(abi.stack_pointer);
      const slot = (offset: bigint) => block.int('sub', entry, block.constant(u64, offset));
      const below = slot(48n),
        inner = slot(32n),
        outer = slot(16n),
        above = slot(8n);
      block.store(below, block.constant(u64, 5n));
      block.store(inner, block.constant(u64, 6n));
      block.store(above, block.constant(u64, 7n));
      block.store(outer, block.constant(u64, 8n));
      block.store(pointer, outer);
      // `inner` is reachable only through the escaped `outer` slot.
      if (gate === 'nested') block.store(outer, inner);
      // External code writes through the published addresses.
      const published = block.load(u64, pointer);
      if (gate === 'nested') block.store(block.load(u64, published), block.constant(u64, 77n));
      else block.store(published, block.constant(u64, 99n));
      block.store(block.int('add', published, block.constant(u64, 8n)), block.constant(u64, 98n));
      const loads = [below, inner, above].map((address) => block.load(u64, address));
      block.return([block.int('add', block.int('add', loads[0]!, loads[1]!), loads[2]!)]);
      const fixture = prepare(b.finish(block, [u64]), abi);
      const source = fixture.view('source');
      assert.deepEqual(
        [...promoted(source)].sort(),
        gate === 'direct' ? ['-32:-24', '-48:-40'] : ['-48:-40'],
      );
      for (const language of ['c-like', 'python-like'] as const) {
        const output = emit(fixture.ir, fixture.extra, language).emission;
        const inputs = new Map<string, bigint>();
        for (const formal of emittedFormals(output))
          inputs.set(formal.statement_id, formal.name === 'entry_sp' ? 0x8000n : 0xa000n);
        // The pointer cell and the frame bytes below the entry SP.
        const memory = new Map(
          [
            ...Array.from({ length: 8 }, (_, index) => 0xa000n + BigInt(index)),
            ...Array.from({ length: 48 }, (_, index) => 0x8000n - 48n + BigInt(index)),
          ].map((address) => [address, 0] as const),
        );
        const observation = execute(output, inputs, memory);
        // direct: 5 + 6 + 98 (above written through outer + 8)
        // nested: 5 + 77 (inner written through the reloaded address) + 98
        assert.deepEqual(observation.values, [gate === 'direct' ? 109n : 180n]);
      }
    }
  });

  test(`${abi.id}: indexed frame stores bound the escape only with a nonnegative index`, () => {
    for (const index of ['zero_extend', 'sign_extend'] as const) {
      const b = builder(`indexed-escape-${abi.id}-${index}`),
        block = b.block('entry');
      const argument = block.readRegister(firstArgument(abi)),
        entry = block.readRegister(abi.stack_pointer);
      const below = block.int('sub', entry, block.constant(u64, 48n)),
        base = block.int('sub', entry, block.constant(u64, 32n));
      block.store(below, block.constant(u64, 5n));
      const scaled = block.int(
        'shl',
        block.cast(index, u64, block.extract(argument, 0, 32)),
        block.constant(u64, 3n),
      );
      // Unknown extent above the base; a signed index may also step below it.
      block.store(block.int('add', base, scaled), block.constant(u64, 9n));
      block.return([block.load(u64, below)]);
      const source = prepare(b.finish(block, [u64]), abi).view('source');
      assert.deepEqual([...promoted(source)], index === 'zero_extend' ? ['-48:-40'] : []);
    }
  });

  test(`${abi.id}: possible open-call argument storage keeps its stores; reloads read the reaching store`, () => {
    const b = builder(`argument-slot-reload-${abi.id}`),
      block = b.block('entry');
    const argument = block.readRegister(firstArgument(abi));
    const sp = block.int('sub', block.readRegister(abi.stack_pointer), block.constant(u64, 32n));
    block.writeRegister(abi.stack_pointer, sp);
    // The first stack-argument position of the call below.
    const slot = block.int('add', sp, block.constant(u64, abi.stack_return_address_bytes));
    block.store(slot, argument);
    const spilled = block.load(u64, slot);
    block.store(slot, block.constant(u64, 0x55n));
    const rewritten = block.load(u64, slot);
    block.call(
      { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
      [],
      [],
      { registers: [], flags: [], memory: 'unknown_read_write' },
      [newIdentity('evidence')],
    );
    block.return([block.int('add', spilled, rewritten)]);
    const fixture = prepare(b.finish(block, [u64]), abi);
    const source = fixture.view('source');
    assert.deepEqual([...promoted(source)], []);
    assert.ok(rules(source).includes('argument_slot_reload'));
    assert.ok(!rules(fixture.view('checked')).includes('argument_slot_reload'));
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(fixture.ir, fixture.extra, language).emission;
      const inputs = new Map<string, bigint>();
      for (const formal of emittedFormals(output))
        inputs.set(formal.statement_id, formal.name === 'entry_sp' ? 0x8000n : 0x1234n);
      const memory = new Map(
        Array.from({ length: 32 }, (_, index) => [0x8000n - 32n + BigInt(index), 0] as const),
      );
      const observation = execute(
        output,
        inputs,
        memory,
        0n,
        new Map(),
        new Map(),
        new Map([['sub_2000', () => []]]),
      );
      assert.deepEqual(observation.values, [0x1234n + 0x55n]);
      // Both stores remain possible argument bytes; no reload reads memory.
      assert.deepEqual(
        observation.events.filter((event) => event === 'store' || event === 'load'),
        ['store', 'store'],
      );
    }
  });

  test(`${abi.id}: halves stored to possible argument storage reload as one concatenated value`, () => {
    const b = builder(`argument-slot-halves-${abi.id}`),
      block = b.block('entry');
    const argument = block.readRegister(firstArgument(abi));
    const sp = block.int('sub', block.readRegister(abi.stack_pointer), block.constant(u64, 32n));
    block.writeRegister(abi.stack_pointer, sp);
    const slot = block.int('add', sp, block.constant(u64, abi.stack_return_address_bytes));
    block.store(slot, block.extract(argument, 0, 32));
    // The high half carries the sign bit.
    block.store(block.int('add', slot, block.constant(u64, 4n)), block.constant(u32, 0x80000000n));
    const whole = block.load(u64, slot);
    block.call(
      { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
      [],
      [],
      { registers: [], flags: [], memory: 'unknown_read_write' },
      [newIdentity('evidence')],
    );
    block.return([whole]);
    const fixture = prepare(b.finish(block, [u64]), abi);
    const source = fixture.view('source');
    assert.deepEqual([...promoted(source)], []);
    assert.ok(rules(source).includes('argument_slot_reload'));
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(fixture.ir, fixture.extra, language).emission;
      const inputs = new Map<string, bigint>();
      for (const formal of emittedFormals(output))
        inputs.set(formal.statement_id, formal.name === 'entry_sp' ? 0x8000n : 0xfedcba98n);
      const memory = new Map(
        Array.from({ length: 32 }, (_, index) => [0x8000n - 32n + BigInt(index), 0] as const),
      );
      const observation = execute(
        output,
        inputs,
        memory,
        0n,
        new Map(),
        new Map(),
        new Map([['sub_2000', () => []]]),
      );
      assert.deepEqual(observation.values, [0x80000000fedcba98n]);
      assert.deepEqual(
        observation.events.filter((event) => event === 'store' || event === 'load'),
        ['store', 'store'],
      );
    }
  });

  test(`${abi.id}: a slot written as integer and IEEE bits is one local read through exact reinterpretation`, () => {
    for (const read of ['integer', 'float'] as const) {
      const b = builder(`punned-local-${abi.id}-${read}`),
        entry = b.block('entry'),
        other = b.block('other'),
        exit = b.block('exit');
      const argument = entry.readRegister(firstArgument(abi));
      const slot = entry.int(
        'sub',
        entry.readRegister(abi.stack_pointer),
        entry.constant(u64, 24n),
      );
      entry.store(slot, argument);
      entry.branch(
        entry.compare('eq', argument, entry.constant(u64, 0n)),
        entry.edge(other),
        entry.edge(exit),
      );
      // Negative zero: only the sign bit is set.
      other.store(slot, other.constant(f64, 0x8000000000000000n));
      other.jump(exit);
      exit.return([
        read === 'integer' ? exit.load(u64, slot) : exit.cast('bitcast', u64, exit.load(f64, slot)),
      ]);
      const fixture = prepare(b.finish(entry, [u64]), abi);
      assert.deepEqual([...promoted(fixture.view('source'))], ['-24:-16']);
      for (const language of ['c-like', 'python-like'] as const) {
        const output = emit(fixture.ir, fixture.extra, language).emission;
        assert.doesNotMatch(output.text, /entry_sp|stack_frame/);
        const formal = emittedFormals(output)[0]!;
        // Zero takes the IEEE store; a NaN payload passes through unchanged.
        for (const [input, expected] of [
          [0n, 0x8000000000000000n],
          [0x7ff8000000000001n, 0x7ff8000000000001n],
          [0xffffffffffffffffn, 0xffffffffffffffffn],
        ] as const) {
          const observation = execute(output, new Map([[formal.statement_id, input]]), new Map());
          assert.deepEqual(observation.values, [expected], `${read} ${language} ${input}`);
        }
      }
    }
  });

  test(`${abi.id}: an argument spill reloads as the argument only without an intervening write`, () => {
    for (const gate of ['clean', 'written', 'punned'] as const) {
      const b = builder(`argument-spill-${abi.id}-${gate}`),
        entry = b.block('entry'),
        next = b.block('next');
      const argument = entry.readRegister(firstArgument(abi));
      const slot = entry.int(
        'sub',
        entry.readRegister(abi.stack_pointer),
        entry.constant(u64, 24n),
      );
      entry.store(slot, argument);
      entry.jump(next);
      if (gate === 'written') next.store(slot, next.constant(u64, 0x55n));
      next.return([
        gate === 'punned' ? next.cast('bitcast', u64, next.load(f64, slot)) : next.load(u64, slot),
      ]);
      const fixture = prepare(b.finish(entry, [u64]), abi);
      assert.deepEqual([...promoted(fixture.view('source'))], ['-24:-16']);
      for (const language of ['c-like', 'python-like'] as const) {
        const output = emit(fixture.ir, fixture.extra, language).emission;
        assert.doesNotMatch(output.text, /entry_sp|stack_frame/);
        const formals = emittedFormals(output);
        const observation = execute(
          output,
          new Map(formals.map((formal) => [formal.statement_id, 0x1234n])),
          new Map(),
        );
        assert.deepEqual(observation.values, [gate === 'written' ? 0x55n : 0x1234n]);
      }
    }
  });

  test(`${abi.id}: closed native reads release pre-call private slots without dropping effects`, () => {
    const b = builder(`closed-call-private-${abi.id}`),
      block = b.block('entry');
    const slot = block.int('sub', block.readRegister(abi.stack_pointer), block.constant(u64, 32n));
    block.writeRegister(abi.stack_pointer, slot);
    block.store(slot, block.constant(u64, 77n));
    block.call(
      { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
      [],
      [],
      { registers: [], flags: [], memory: 'unknown_read_write' },
      [newIdentity('evidence')],
    );
    block.return([block.load(u64, slot)]);
    const fixture = prepare(b.finish(block, [u64]), abi, true);
    assert.ok(rules(fixture.view('source')).includes('arity_closure'));
    assert.ok(rules(fixture.view('source')).includes('private_stack_promotion'));
    assert.ok(!rules(fixture.view('checked')).includes('arity_closure'));
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(fixture.ir, fixture.extra, language).emission;
      assert.doesNotMatch(output.text, /entry_sp|unknown_argument_remainder|, \.\.\./);
      let calls = 0;
      const observed = execute(
        output,
        new Map(),
        new Map(),
        0n,
        new Map(),
        new Map(),
        new Map([
          [
            'sub_2000',
            (args, context) => {
              calls++;
              assert.deepEqual(args, []);
              assert.equal(context.arguments_complete, true);
              return [];
            },
          ],
        ]),
      );
      assert.equal(calls, 1);
      assert.deepEqual(observed.values, [77n]);
    }
  });

  test(`${abi.id}: mixed-width overlap and unknown effects retain explicit frame memory`, () => {
    for (const gate of ['overlap', 'unknown', 'volatile'] as const) {
      const b = builder(`private-gate-${abi.id}-${gate}`),
        block = b.block('entry');
      const slot = block.int(
        'sub',
        block.readRegister(abi.stack_pointer),
        block.constant(u64, 24n),
      );
      block.store(slot, block.constant(u64, 77n), {
        endian: 'little',
        alignment: 1,
        volatile: gate === 'volatile',
      });
      // A store straddling the slot's end is neither inside it nor a whole slot.
      if (gate === 'overlap')
        block.store(block.int('add', slot, block.constant(u64, 4n)), block.constant(u64, 5n));
      if (gate === 'unknown')
        block.unknown('unmodeled effect', {
          registers: [],
          flags: [],
          memory: 'unknown_read_write',
        });
      block.return([block.load(u64, slot)]);
      const fixture = prepare(b.finish(block, [u64]), abi);
      const recorded = rules(fixture.view('source'));
      assert.ok(!recorded.includes('private_stack_promotion'));
      assert.ok(!recorded.includes('wide_slot_parts'));
    }
  });

  test(`${abi.id}: named joined locals inline repeated reloads but never across their own write`, () => {
    for (const overwrite of [false, true]) {
      const b = builder(`joined-local-${abi.id}-${overwrite}`),
        entry = b.block('entry'),
        yes = b.block('yes'),
        no = b.block('no'),
        join = b.block('join');
      const pointer = entry.readRegister(firstArgument(abi));
      const slot = entry.int(
        'sub',
        entry.readRegister(abi.stack_pointer),
        entry.constant(u64, 56n),
      );
      entry.branch(
        entry.compare('eq', pointer, entry.constant(u64, 0xa000n)),
        entry.edge(yes),
        entry.edge(no),
      );
      yes.store(slot, yes.constant(u64, 7n));
      yes.jump(join);
      no.store(slot, no.constant(u64, 13n));
      no.jump(join);
      const first = join.load(u64, slot);
      join.store(pointer, join.constant(u64, 19n));
      if (overwrite) join.store(slot, join.constant(u64, 99n));
      const second = join.load(u64, slot);
      join.return([join.int('add', first, second)]);
      const fixture = prepare(b.finish(entry, [u64]), abi);
      for (const language of ['c-like', 'python-like'] as const) {
        const output = emit(fixture.ir, fixture.extra, language).emission;
        assert.match(output.text, /local_38/);
        if (!overwrite) assert.doesNotMatch(output.text, /value\\d+ = local_38/);
        const argument = emittedFormals(output)[0]!;
        for (const address of [0xa000n, 0xa008n]) {
          const memory = new Map(
            Array.from({ length: 8 }, (_, index) => [address + BigInt(index), 0] as const),
          );
          const observation = execute(output, new Map([[argument.statement_id, address]]), memory);
          const initial = address === 0xa000n ? 7n : 13n;
          assert.deepEqual(observation.values, [initial + (overwrite ? 99n : initial)]);
          assert.deepEqual(observation.events, ['store']);
        }
      }
    }
  });

  test(`${abi.id}: narrower accesses inside a whole-slot integer read and write its bytes`, () => {
    const input = 0x1122334455667788n;
    const cases = {
      // Narrower loads of a whole stored value read its bit ranges.
      parts: 0x5566778811223344n,
      // A narrower store replaces its bytes: the high half is all ones.
      'narrow-store': 0x55667788ffffffffn,
      // Two halves build the slot; the high half carries the sign bit.
      built: 0x8000000055667788n,
      // A middle store splits one value into three pieces.
      split: 0x11223344ffff7788n,
      joined: undefined,
    } as const;
    for (const [gate, expected] of Object.entries(cases)) {
      const b = builder(`slot-parts-${abi.id}-${gate}`),
        entry = b.block('entry');
      const argument = entry.readRegister(firstArgument(abi));
      const slot = entry.int(
        'sub',
        entry.readRegister(abi.stack_pointer),
        entry.constant(u64, 40n),
      );
      const high = (block: typeof entry) => block.int('add', slot, block.constant(u64, 4n));
      if (gate === 'built') {
        entry.store(slot, entry.extract(argument, 0, 32));
        entry.store(high(entry), entry.constant(u32, 0x80000000n));
      } else entry.store(slot, argument);
      if (gate === 'narrow-store') entry.store(high(entry), entry.constant(u32, 0xffffffffn));
      if (gate === 'split')
        entry.store(
          entry.int('add', slot, entry.constant(u64, 2n)),
          entry.constant(integer(16), 0xffffn),
        );
      let exit = entry;
      if (gate === 'joined') {
        // Differing reaching values: no forwarded value whose bits a part reads.
        const other = b.block('other');
        exit = b.block('exit');
        entry.branch(
          entry.compare('eq', argument, entry.constant(u64, 0n)),
          entry.edge(other),
          entry.edge(exit),
        );
        other.store(slot, other.constant(u64, 0x0102030405060708n));
        other.jump(exit);
      }
      exit.return([
        gate === 'parts' || gate === 'narrow-store' || gate === 'joined'
          ? exit.concat([exit.load(u32, high(exit)), exit.load(u32, slot)])
          : exit.load(u64, slot),
      ]);
      const fixture = prepare(b.finish(entry, [u64]), abi);
      const recorded = rules(fixture.view('source'));
      assert.equal(recorded.includes('wide_slot_parts'), expected !== undefined);
      assert.ok(!rules(fixture.view('checked')).includes('wide_slot_parts'));
      if (expected === undefined) {
        assert.ok(!recorded.includes('private_stack_promotion'));
        continue;
      }
      for (const language of ['c-like', 'python-like'] as const) {
        const output = emit(fixture.ir, fixture.extra, language).emission;
        assert.doesNotMatch(output.text, /entry_sp|stack_frame/);
        const formal = emittedFormals(output)[0]!;
        // Only the low half of the argument is read there: a 32-bit formal.
        const value = gate === 'narrow-store' || gate === 'built' ? input & 0xffffffffn : input;
        const observation = execute(output, new Map([[formal.statement_id, value]]), new Map());
        assert.deepEqual(observation.values, [expected], `${gate} ${language}`);
      }
    }
  });

  test(`${abi.id}: flags derived from frame arithmetic hand no callee a frame address`, () => {
    const flag = abi.unknown_call_clobbers.flags[0]!;
    assert.equal(flag.bank, 'flags');
    for (const carrier of ['flag', 'argument'] as const) {
      const b = builder(`flag-carrier-${abi.id}-${carrier}`),
        block = b.block('entry');
      const slot = block.int(
        'sub',
        block.readRegister(abi.stack_pointer),
        block.constant(u64, 32n),
      );
      block.writeRegister(abi.stack_pointer, slot);
      if (carrier === 'flag')
        block.writeRegister(
          flag,
          block.extract(block.int('and', slot, block.constant(u64, 0xfn)), 0, flag.width_bits),
        );
      else block.writeRegister(firstArgument(abi), slot);
      block.call(
        { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
        [],
        [],
        abi.unknown_call_clobbers,
        [newIdentity('evidence')],
      );
      block.store(slot, block.constant(u64, 77n));
      block.return([block.load(u64, slot)]);
      const fixture = prepare(b.finish(block, [u64]), abi);
      assert.equal(
        rules(fixture.view('source')).includes('private_stack_promotion'),
        carrier === 'flag',
      );
    }
  });
}

for (const abi of [sysvAMD64Abi, windowsX64Abi])
  test(`${abi.id}: a call's own return-address push is call mechanics, not a frame local`, () => {
    const site = (name: string): Provenance => ({
      instruction_ids: [entityIdentity(slice, 'instruction', name)],
      ranges: [{ start: { image_id: image, space: 'va', value: 0x1000n }, size: 5n }],
      evidence_ids: [],
      synthetic: [],
    });
    for (const gate of ['push', 'reread', 'constant', 'other-instruction'] as const) {
      const b = builder(`return-push-${abi.id}-${gate}`),
        block = b.block('entry');
      const entry = block.readRegister(abi.stack_pointer);
      const next = block.int('sub', entry, block.constant(u64, 8n));
      block.writeRegister(abi.stack_pointer, next);
      block.source(site('call'));
      const pushed =
        gate === 'constant'
          ? block.constant(u64, 0x1005n)
          : block.address({ image_id: image, space: 'va', value: 0x1005n });
      if (gate === 'other-instruction') block.source(site('other'));
      block.store(next, pushed);
      block.source(site('call'));
      block.call(
        { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
        [],
        [],
        abi.unknown_call_clobbers,
        [newIdentity('evidence')],
      );
      block.source(provenance);
      block.writeRegister(abi.stack_pointer, entry);
      block.return([gate === 'reread' ? block.load(u64, next) : block.constant(u64, 7n)]);
      const fixture = prepare(b.finish(block, [u64]), abi);
      const source = fixture.view('source');
      assert.equal(rules(source).includes('call_return_address'), gate === 'push');
      assert.equal(
        source.local_validation_session?.abiConformance.some(
          (requirement) => requirement.rule === 'call_return_address',
        ),
        gate === 'push',
      );
      assert.ok(!rules(fixture.view('checked')).includes('call_return_address'));
      for (const language of ['c-like', 'python-like'] as const) {
        const output = emit(fixture.ir, fixture.extra, language).emission;
        // A retained push slot is a frame object member, never entry-SP arithmetic.
        assert.doesNotMatch(output.text, /entry_sp/);
        assert.equal(/\bframe\.local_8\b/.test(output.text), gate !== 'push');
        assert.match(output.text, /sub_2000\(/);
      }
    }
  });

test('darwin-arm64: an FP-guard failure arm is no frame escape under its requirement', () => {
  for (const reason of [fpEnvironmentGuard.unsupported_effect, 'unmodeled effect']) {
    const b = builder(`fp-guard-frame-${reason}`),
      entry = b.block('entry'),
      supported = b.block('supported'),
      failure = b.block('failure');
    const slot = entry.int(
      'sub',
      entry.readRegister(darwinArm64Abi.stack_pointer),
      entry.constant(u64, 24n),
    );
    const input = entry.readRegister(firstArgument(darwinArm64Abi));
    entry.store(slot, input);
    const state = entry.readRegister(stateRegister('fpcr'));
    entry.branch(
      entry.compare(
        'eq',
        entry.int('and', state, entry.constant(u32, fpEnvironmentGuard.mask)),
        entry.constant(u32, 0n),
      ),
      entry.edge(supported),
      entry.edge(failure),
    );
    failure.unknown(reason, unknownClobbers);
    failure.terminate({ kind: 'unknown', reason: fpEnvironmentGuard.unsupported_exit });
    const product = supported.assign(f64, {
      kind: 'float',
      op: 'mul',
      left: supported.cast('bitcast', f64, supported.load(u64, slot)),
      right: supported.constant(f64, 0x3ff8000000000000n),
    });
    supported.return([supported.cast('bitcast', u64, product)]);
    const fixture = prepare(b.finish(entry, [u64]), darwinArm64Abi);
    const recorded = rules(fixture.view('source'));
    const guard = reason === fpEnvironmentGuard.unsupported_effect;
    assert.equal(recorded.includes('fp_guard_frame'), guard);
    assert.equal(recorded.includes('private_stack_promotion'), guard);
    assert.ok(!rules(fixture.view('checked')).includes('fp_guard_frame'));
    if (!guard) continue;
    for (const language of ['c-like', 'python-like'] as const)
      assert.doesNotMatch(
        emit(fixture.ir, fixture.extra, language).emission.text,
        /entry_sp|stack_frame/,
      );
  }
});

/** va_arg-like walk: the entry block stores a stack address (`entry SP + 8`,
 * or the frame array at `entry SP - 48` filled from arguments 1..3) into the
 * frame slot at `entry SP - 16` and reads it back; the loop dereferences the
 * reloaded pointer, sums `count` (>= 1) words and stores the advanced pointer
 * back into the slot. A call after the loop receives `entry SP - 32`, so the
 * slot is reachable through an escaped frame address and stays memory. */
function reloadWalk(abi: AbiProfile, base: 'incoming' | 'frame') {
  const registers = abi
    .classifyCall({
      returns: { kind: 'void' },
      parameters: Array.from({ length: 4 }, () => ({
        kind: 'integer' as const,
        bits: 64,
        signed: false,
      })),
      variadic: false,
      fixed_parameter_count: 4,
    })
    .parameters.map((parameter) => {
      const location = parameter.locations[0]!;
      if (location.kind !== 'register') throw new Error('Expected register argument');
      return location.register;
    });
  const [count, cursor, total] = registers as [
    RegisterDescriptor,
    RegisterDescriptor,
    RegisterDescriptor,
  ];
  const b = builder(`stack-reload-${abi.id}-${base}`),
    entry = b.block('entry'),
    loop = b.block('loop'),
    exit = b.block('exit');
  const sp = entry.readRegister(abi.stack_pointer);
  const frame = entry.int('sub', sp, entry.constant(u64, 64n));
  entry.writeRegister(abi.stack_pointer, frame);
  const at = (offset: bigint) => entry.int('add', frame, entry.constant(u64, 64n + offset));
  const slot = at(-16n);
  if (base === 'frame')
    for (const [index, register] of registers.slice(1).entries())
      entry.store(at(-48n + 8n * BigInt(index)), entry.readRegister(register));
  entry.store(slot, base === 'incoming' ? entry.int('add', sp, entry.constant(u64, 8n)) : at(-48n));
  const reloaded = entry.load(u64, slot);
  entry.writeRegister(cursor, reloaded);
  entry.writeRegister(total, entry.constant(u64, 0n));
  entry.jump(loop);
  const pointer = loop.readRegister(cursor);
  loop.writeRegister(total, loop.int('add', loop.readRegister(total), loop.load(u64, pointer)));
  const next = loop.int('add', pointer, loop.constant(u64, 8n));
  loop.store(loop.int('add', loop.readRegister(abi.stack_pointer), loop.constant(u64, 48n)), next);
  loop.writeRegister(cursor, next);
  const remaining = loop.int('sub', loop.readRegister(count), loop.constant(u64, 1n));
  loop.writeRegister(count, remaining);
  loop.branch(
    loop.compare('ne', remaining, loop.constant(u64, 0n)),
    loop.edge(loop),
    loop.edge(exit),
  );
  // Plus the bytes walked: 8 * count.
  const result = exit.int(
    'add',
    exit.readRegister(total),
    exit.int('sub', exit.readRegister(cursor), reloaded),
  );
  exit.writeRegister(
    count,
    exit.int('add', exit.readRegister(abi.stack_pointer), exit.constant(u64, 32n)),
  );
  exit.call(
    { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
    [],
    [],
    abi.unknown_call_clobbers,
    [newIdentity('evidence')],
  );
  exit.return([result]);
  return prepare(b.finish(entry, [u64]), abi, true, [count]);
}

/** Lines of the first loop: its header through the last line indented deeper
 * (and C's closing `} while (…);` at the header's indentation). */
function loopLines(text: string): string[] {
  const lines = text.split('\n'),
    start = lines.findIndex((line) => /^\s*(?:do \{|while \(|while True:|for \()/.test(line));
  assert.ok(start >= 0, text);
  const indent = /^\s*/.exec(lines[start]!)![0].length;
  let end = start + 1;
  while (end < lines.length && /^\s*/.exec(lines[end]!)![0].length > indent) end++;
  if (lines[end]?.trimStart().startsWith('}')) end++;
  return lines.slice(start, end);
}

for (const abi of targets)
  for (const base of ['incoming', 'frame'] as const)
    test(`${abi.id}: a stack address read back from a frame slot (${base}) prints through its load`, () => {
      const fixture = reloadWalk(abi, base);
      const entrySp = 0x8000n,
        words = [0x1111n, 0xffffffffffffffffn, 0x8000000000000000n];
      // The stored address spelled as a constant: entry-SP arithmetic for the
      // incoming area, the frame member for the negative frame address.
      const constant = base === 'incoming' ? /entry_sp \+ 8\b/ : /frame\.local_30\b/;
      for (const count of [1, 2, 3]) {
        const oracle = BigInt.asUintN(
          64,
          words.slice(0, count).reduce((sum, word) => sum + word, 0n) + 8n * BigInt(count),
        );
        const observed = new Map<string, readonly string[]>();
        for (const view of ['source', 'checked'] as const)
          for (const language of ['c-like', 'python-like'] as const) {
            const output = emit(fixture.ir, fixture.extra, language, view).emission;
            const formals = emittedFormals(output);
            if (view === 'source') {
              // Every assignment target is a declared local or a formal (a
              // Python-like frame object is declared by its constructor).
              const parser = new Parser(output.text),
                declared = new Set([...parser.symbols.keys(), ...formals.map(({ name }) => name)]);
              for (const op of parser.ops)
                if (
                  op.kind === 'assign' &&
                  !(op.expression?.kind === 'call' && op.expression.name.startsWith('stack_'))
                )
                  for (const name of op.names)
                    if (!name.startsWith('$'))
                      assert.ok(declared.has(name), `${name} undeclared\n${output.text}`);
              // The loop and the result read the reloaded variable, never the
              // stored address again.
              const lines = output.text.split('\n');
              for (const line of [
                ...loopLines(output.text),
                lines.find((line) => /^\s*return /.test(line))!,
              ])
                assert.doesNotMatch(line, constant, output.text);
            }
            // Formals in order: the count, the words (frame case), the entry SP.
            const inputs = new Map(
              formals.map((formal, index) => [
                formal.statement_id,
                formal.name === 'entry_sp' ? entrySp : index ? words[index - 1]! : BigInt(count),
              ]),
            );
            const memory = new Map<bigint, number>();
            for (let address = entrySp - 64n; address < entrySp + 32n; address++)
              memory.set(address, 0);
            if (base === 'incoming')
              for (const [index, word] of words.entries())
                for (let byte = 0n; byte < 8n; byte++)
                  memory.set(
                    entrySp + 8n + 8n * BigInt(index) + byte,
                    Number((word >> (8n * byte)) & 0xffn),
                  );
            const received: bigint[] = [];
            const observation = execute(
              output,
              inputs,
              memory,
              0n,
              new Map(),
              new Map(),
              new Map([['sub_2000', (args: readonly bigint[]) => (received.push(args[0]!), [])]]),
            );
            assert.deepEqual(observation.values, [oracle], `${view} ${language}\n${output.text}`);
            assert.equal(received.length, 1);
            // The checked view addresses the frame from the entry SP; beside a
            // live entry SP the source view passes the frame object's member (S2).
            if (view === 'checked' && formals.some(({ name }) => name === 'entry_sp'))
              assert.deepEqual(received, [entrySp - 32n]);
            observed.set(`${view} ${language}`, observation.events);
          }
        // The same loads and stores in the same order in every view.
        const events = [...observed.values()];
        for (const row of events) assert.deepEqual(row, events[0]);
      }
    });

/** A loop carries `entry SP - 0xb0` in a register (a proven stack-address phi
 * that is one frame address on every edge). One back edge rewrites the register
 * with the address recomputed from the live SP, a different SSA value. The loop
 * loads and stores through it: each round adds the stored word to a running
 * total and stores `total + 1` back. */
function rematerializedFrameAddress(abi: AbiProfile) {
  const [count, carried, total] = [1, 2, 3].map((index) => {
    const location = abi.classifyCall({
      returns: { kind: 'void' },
      parameters: Array.from({ length: 4 }, () => ({
        kind: 'integer' as const,
        bits: 64,
        signed: false,
      })),
      variadic: false,
      fixed_parameter_count: 4,
    }).parameters[index - 1]!.locations[0]!;
    if (location.kind !== 'register') throw new Error('Expected register argument');
    return location.register;
  }) as [RegisterDescriptor, RegisterDescriptor, RegisterDescriptor];
  const b = builder(`stack-address-phi-${abi.id}`),
    entry = b.block('entry'),
    loop = b.block('loop'),
    again = b.block('again'),
    redo = b.block('redo'),
    exit = b.block('exit');
  const frame = entry.int(
    'sub',
    entry.readRegister(abi.stack_pointer),
    entry.constant(u64, 0xc0n),
  );
  entry.writeRegister(abi.stack_pointer, frame);
  const address = entry.int('add', frame, entry.constant(u64, 0x10n));
  entry.store(address, entry.constant(u64, 5n));
  entry.writeRegister(carried, address);
  entry.writeRegister(total, entry.constant(u64, 0n));
  entry.jump(loop);
  const pointer = loop.readRegister(carried);
  const sum = loop.int('add', loop.readRegister(total), loop.load(u64, pointer));
  loop.writeRegister(total, sum);
  loop.store(pointer, loop.int('add', sum, loop.constant(u64, 1n)));
  const remaining = loop.int('sub', loop.readRegister(count), loop.constant(u64, 1n));
  loop.writeRegister(count, remaining);
  loop.branch(
    loop.compare('ne', remaining, loop.constant(u64, 0n)),
    loop.edge(again),
    loop.edge(exit),
  );
  again.branch(
    again.compare(
      'ne',
      again.int('and', again.readRegister(count), again.constant(u64, 1n)),
      again.constant(u64, 0n),
    ),
    again.edge(redo),
    again.edge(loop),
  );
  redo.writeRegister(
    carried,
    redo.int('add', redo.readRegister(abi.stack_pointer), redo.constant(u64, 0x10n)),
  );
  redo.jump(loop);
  exit.return([
    exit.int('add', exit.readRegister(total), exit.load(u64, exit.readRegister(carried))),
  ]);
  return prepare(b.finish(entry, [u64]), abi);
}

for (const abi of targets)
  test(`${abi.id}: a stack-address phi re-materialized on one edge takes no edge copy`, () => {
    const fixture = rematerializedFrameAddress(abi);
    const entrySp = 0x8000n;
    for (const view of ['source', 'checked'] as const) {
      // A proven phi that prints as its frame address never receives an edge copy.
      const program = fixture.view(view);
      assert.ok(program.local_validation_session, view);
      for (const language of ['c-like', 'python-like'] as const) {
        const output = emit(fixture.ir, fixture.extra, language, view).emission;
        assert.ok(output.text.length > 0, `${view} ${language}`);
        for (const rounds of [1, 2, 3, 4, 5]) {
          let stored = 5n,
            running = 0n;
          for (let round = 0; round < rounds; round++) {
            running += stored;
            stored = running + 1n;
          }
          const formals = emittedFormals(output);
          const inputs = new Map(
            formals.map((formal) => [
              formal.statement_id,
              formal.name === 'entry_sp' ? entrySp : BigInt(rounds),
            ]),
          );
          const memory = new Map<bigint, number>();
          for (let address = entrySp - 0x100n; address < entrySp + 0x20n; address++)
            memory.set(address, 0);
          const observation = execute(output, inputs, memory);
          assert.deepEqual(
            observation.values,
            [BigInt.asUintN(64, running + stored)],
            `${view} ${language} rounds=${rounds}\n${output.text}`,
          );
        }
      }
    }
  });

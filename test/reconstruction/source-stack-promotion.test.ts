import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationContext,
  entityIdentity,
  newIdentity,
  type AbiProfile,
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
import { emit, emittedFormals, execute } from '../emitters/c/support.js';

const u64 = integer(64),
  u32 = integer(32),
  f64 = { kind: 'float', bits: 64 } as const;
const targets = [darwinArm64Abi, sysvAMD64Abi, windowsX64Abi];
function prepare(input: RegisterIR, abi: AbiProfile, closure = false) {
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
                      parameters: [],
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

  test(`${abi.id}: open calls block preceding slots, not fresh post-call storage`, () => {
    for (const before of [false, true]) {
      const b = builder(`post-call-slot-${abi.id}-${before}`),
        block = b.block('entry');
      const slot = block.int(
        'sub',
        block.readRegister(abi.stack_pointer),
        block.constant(u64, 32n),
      );
      block.writeRegister(abi.stack_pointer, slot);
      if (before) block.store(slot, block.constant(u64, 77n));
      block.call(
        { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
        [],
        [],
        { registers: [], flags: [], memory: 'unknown_read_write' },
        [newIdentity('evidence')],
      );
      if (!before) block.store(slot, block.constant(u64, 77n));
      block.return([block.load(u64, slot)]);
      const fixture = prepare(b.finish(block, [u64]), abi);
      assert.equal(rules(fixture.view('source')).includes('private_stack_promotion'), !before);
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
      // A narrower store into the slot is a partial write, not a part read.
      if (gate === 'overlap')
        block.store(block.int('add', slot, block.constant(u64, 4n)), block.constant(u32, 5n));
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

  test(`${abi.id}: narrower loads inside a whole-slot integer read its bits`, () => {
    for (const gate of ['parts', 'narrow-store', 'joined'] as const) {
      const b = builder(`slot-parts-${abi.id}-${gate}`),
        entry = b.block('entry');
      const argument = entry.readRegister(firstArgument(abi));
      const slot = entry.int(
        'sub',
        entry.readRegister(abi.stack_pointer),
        entry.constant(u64, 40n),
      );
      entry.store(slot, argument);
      let exit = entry;
      if (gate === 'narrow-store')
        entry.store(entry.int('add', slot, entry.constant(u64, 4n)), entry.constant(u32, 5n));
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
      const high = exit.load(u32, exit.int('add', slot, exit.constant(u64, 4n)));
      exit.return([exit.concat([high, exit.load(u32, slot)])]);
      const fixture = prepare(b.finish(entry, [u64]), abi);
      const recorded = rules(fixture.view('source'));
      assert.equal(recorded.includes('wide_slot_parts'), gate === 'parts');
      assert.ok(!rules(fixture.view('checked')).includes('wide_slot_parts'));
      if (gate !== 'parts') {
        assert.ok(!recorded.includes('private_stack_promotion'));
        continue;
      }
      for (const language of ['c-like', 'python-like'] as const) {
        const output = emit(fixture.ir, fixture.extra, language).emission;
        assert.doesNotMatch(output.text, /entry_sp|stack_frame/);
        const formal = emittedFormals(output)[0]!;
        const observation = execute(
          output,
          new Map([[formal.statement_id, 0x1122334455667788n]]),
          new Map(),
        );
        assert.deepEqual(observation.values, [0x5566778811223344n]);
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
        assert.equal(/entry_sp/.test(output.text), gate !== 'push');
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

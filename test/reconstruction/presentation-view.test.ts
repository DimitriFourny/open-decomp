import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationContext,
  newIdentity,
  type RegisterDescriptor,
} from '../../src/core/index.js';
import { darwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { recoverTypes } from '../../src/analysis/types/index.js';
import { integer, type SSAForm } from '../../src/ir/index.js';
import { structureControlFlow } from '../../src/presentation/index.js';
import { reconstruct, type Reconstruction } from '../../src/reconstruction/index.js';
import type { InferredCallee, SourceEvidence } from '../../src/reconstruction/source-model.js';
import { builder, image, slice } from '../ir/support.js';
import { emit, emittedFormals, execute } from '../emitters/c/support.js';

const u64 = integer(64),
  abi = darwinArm64Abi;
const x = (index: number): RegisterDescriptor => {
  const found = [
    ...abi.preserved,
    ...abi.unknown_call_clobbers.registers,
    ...(abi.link_register ? [abi.link_register] : []),
  ].find((register) => register.root === `arm64:x${index}` && register.width_bits === 64);
  assert.ok(found, `x${index}`);
  return found;
};

/** stp x19, x30, [sp, #-16]!; x19 = x0; bl f; x0 += x19; ldp x19, x30; ret —
 * the save survives an unresolved call and the callee clobbers x1. */
function framed(name: string, options: { reloadX19?: boolean; closure?: boolean } = {}) {
  const b = builder(name),
    block = b.block('entry');
  const sp = block.readRegister(abi.stack_pointer);
  const frame = block.int('sub', sp, block.constant(u64, 16n));
  block.writeRegister(abi.stack_pointer, frame);
  block.store(frame, block.readRegister(x(19)));
  block.store(block.int('add', frame, block.constant(u64, 8n)), block.readRegister(x(30)));
  block.writeRegister(x(19), block.readRegister(x(0)));
  block.call(
    { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
    [],
    [],
    abi.unknown_call_clobbers,
    [newIdentity('evidence')],
  );
  block.writeRegister(x(0), block.int('add', block.readRegister(x(0)), block.readRegister(x(19))));
  const restored = block.load(u64, frame);
  if (options.reloadX19 !== false) block.writeRegister(x(19), restored);
  block.writeRegister(x(30), block.load(u64, block.int('add', frame, block.constant(u64, 8n))));
  block.writeRegister(abi.stack_pointer, block.int('add', frame, block.constant(u64, 16n)));
  block.readRegister(x(0));
  block.readRegister(x(1));
  block.return();
  const constructed = constructSSA(b.finish(block, []));
  const ir = constructed.value as SSAForm;
  const types = recoverTypes(ir, abi, createOperationContext(), {
    image_id: image,
    slice_id: slice,
    revision: 0,
  });
  const call = ir.blocks[0]!.instructions.find((node) => node.kind === 'call')!;
  const callee: InferredCallee = {
    call_id: call.id,
    parameters: [x(0)],
    returns: [x(0)],
    argument_list_complete: false,
    ...(options.closure ? { argument_list_closure: 'callee_reads' as const } : {}),
    evidence_ids: [],
  };
  const structured = structureControlFlow(ir, createOperationContext());
  assert.ok(structured.value);
  const input = {
    function: structured.value,
    types,
    source: { abi, callees: [callee], addresses: [] },
  };
  const memory = ir.blocks[0]!.instructions.filter(
    (node) => node.kind === 'store' || node.kind === 'load',
  );
  return {
    call: call.id,
    memory: memory.map((node) => node.id),
    emit: (language: 'c-like' | 'python-like') =>
      emit(ir, { types, source: input.source }, language),
    view: (view: 'source' | 'checked'): Reconstruction =>
      reconstruct(input, createOperationContext(), view),
  };
}

const rules = (program: Reconstruction): string[] =>
  (program.local_validation ?? [])
    .filter((record) => record.kind === 'presentation')
    .map((record) => record.rule!);

test('source view hides frame saves surviving unresolved calls; checked view keeps them', () => {
  const fixture = framed('frame-save-elision');
  const checked = fixture.view('checked'),
    source = fixture.view('source');
  for (const id of fixture.memory) assert.ok(checked.retained.has(id), 'checked keeps saves');
  assert.equal(checked.source?.frame_saves, undefined);
  assert.deepEqual(rules(checked), []);
  assert.ok(
    checked.parameters.some(
      (value) => checked.source?.parameter_names.get(value.id) === 'entry_sp',
    ),
  );

  for (const id of fixture.memory) assert.ok(!source.retained.has(id), 'source hides saves');
  assert.equal(source.source?.frame_saves?.stores.size, 2);
  assert.equal(source.source?.frame_saves?.reloads.size, 2);
  assert.equal(source.source?.stack, null);
  assert.ok(
    !source.parameters.some((value) => source.source?.parameter_names.get(value.id) === 'entry_sp'),
  );
  assert.deepEqual(rules(source).filter((rule) => rule === 'frame_save').length, 2);
  assert.equal(
    source.local_validation_session?.abiConformance.some((site) => site.rule === 'frame_save'),
    true,
  );
  // The save bytes are no possible stack argument, but the callee's list stays open.
  assert.equal(source.calls.get(fixture.call)?.argument_list_complete, false);
});

test('a save not restored on every exit is not a frame save; its dead reload is dropped', () => {
  const fixture = framed('frame-save-unrestored', { reloadX19: false });
  const source = fixture.view('source'),
    checked = fixture.view('checked');
  // x19's slot is not restored into x19, so its store remains ordered memory; the
  // frame record (x30) is still a save, as its slot does not overlap.
  assert.ok(source.retained.has(fixture.memory[0]!));
  assert.equal(source.source?.frame_saves?.stores.size, 1);
  // The unused reload is dominated by that store, so it cannot fault.
  assert.ok(checked.retained.has(fixture.memory[2]!));
  assert.ok(!source.retained.has(fixture.memory[2]!));
  assert.ok(rules(source).includes('dead_frame_reload'));
});

test('source view moves ABI-scratch exit clobbers out of line', () => {
  const fixture = framed('exit-scratch');
  const checked = fixture.view('checked'),
    source = fixture.view('source');
  const checkedReturn = [...checked.returns.values()][0]!,
    sourceReturn = [...source.returns.values()][0]!;
  assert.ok(checkedReturn.outputs.some((binding) => binding.register.root === 'arm64:x1'));
  assert.equal(checkedReturn.exit_scratch, undefined);
  assert.ok(!sourceReturn.outputs.some((binding) => binding.register.root === 'arm64:x1'));
  const slice = sourceReturn.exit_scratch?.find((item) => item.register.root === 'arm64:x1');
  assert.ok(slice);
  assert.deepEqual(slice.sources, [fixture.call]);
  assert.ok(!source.live.has(slice.value.id), 'scratch is no liveness root');
  assert.ok(rules(source).includes('exit_scratch'));
  for (const language of ['c-like', 'python-like'] as const) {
    const { emission } = fixture.emit(language);
    assert.match(emission.text, /exit x1, v0, v1, v2, v3: unspecified \(clobbered by calls\)/);
    assert.doesNotMatch(emission.text, /also at exit:.* = value\d/);
  }
});

test('complete-by-callee-reads closes an inferred argument list only in the source view', () => {
  const fixture = framed('arity-closure', { closure: true });
  assert.equal(fixture.view('checked').calls.get(fixture.call)?.argument_list_complete, false);
  const source = fixture.view('source');
  assert.equal(source.calls.get(fixture.call)?.argument_list_complete, true);
  assert.equal(source.calls.get(fixture.call)?.arguments.length, 1);
  assert.ok(rules(source).includes('arity_closure'));
});

function computedExit(evidence: Partial<SourceEvidence> = {}, primary = true, constant = false) {
  const b = builder('computed-exit'),
    block = b.block('entry');
  const loaded = block.load(u64, block.readRegister(x(2)));
  block.writeRegister(
    x(1),
    constant ? block.constant(u64, 8n) : block.int('add', loaded, block.constant(u64, 1n)),
  );
  if (primary) block.writeRegister(x(0), block.constant(u64, 7n));
  block.return();
  const ir = constructSSA(b.finish(block, [])).value as SSAForm;
  const types = recoverTypes(ir, abi, createOperationContext(), {
    image_id: image,
    slice_id: slice,
    revision: 0,
  });
  const source: SourceEvidence = { abi, callees: [], addresses: [], ...evidence };
  const structured = structureControlFlow(ir, createOperationContext());
  assert.ok(structured.value);
  return {
    ir,
    extra: { types, source },
    view: (view: 'source' | 'checked') =>
      reconstruct({ function: structured.value!, types, source }, createOperationContext(), view),
  };
}

test('undemanded computed exit slices move out of line without dropping load effects', () => {
  const fixture = computedExit(),
    source = fixture.view('source'),
    checked = fixture.view('checked'),
    projection = [...source.returns.values()][0]!;
  const slice = projection.exit_scratch?.find((item) => item.register.root === x(1).root);
  assert.ok(slice?.computed);
  assert.deepEqual(slice.sources, [slice.value.id]);
  assert.ok(!source.live.has(slice.value.id));
  assert.ok(
    [...checked.returns.values()][0]!.outputs.some((item) => item.register.root === x(1).root),
  );
  const load = fixture.ir.blocks[0]!.instructions.find((node) => node.kind === 'load')!;
  assert.ok(source.retained.has(load.id), 'potentially faulting loads remain ordered effects');
  assert.ok(source.diagnostics.some((item) => item.code === 'unavailable_semantics'));
  assert.ok(
    source.local_validation_session?.abiConformance.some((site) => site.rule === 'exit_scratch'),
  );
  for (const language of ['c-like', 'python-like'] as const) {
    const { emission } = emit(fixture.ir, fixture.extra, language);
    assert.match(
      emission.text,
      /also at exit: x1\[0:64\] = computed, not materialized \(not established as a result\)/,
    );
    assert.doesNotMatch(emission.text, /also at exit:.* = value\d/);
    assert.doesNotMatch(emission.text, /return physical_return/);
    // The out-of-line value does not rescue a faulting load from execution.
    const inputs = new Map(
      emittedFormals(emission).map((formal) => [formal.statement_id, 0x1000n]),
    );
    assert.equal(execute(emission, inputs).exit, 'fault');
    const memory = new Map(Array.from({ length: 8 }, (_, index) => [0x1000n + BigInt(index), 0]));
    assert.deepEqual(execute(emission, inputs, memory).values, [7n]);
  }
});

test('cheap exit expressions print without manufacturing a dead local', () => {
  const fixture = computedExit({}, true, true);
  for (const language of ['c-like', 'python-like'] as const) {
    const { emission } = emit(fixture.ir, fixture.extra, language);
    assert.match(
      emission.text,
      /also at exit: x1\[0:64\] = (?:0x)?8 \(not established as a result\)/,
    );
    const inputs = new Map(
      emittedFormals(emission).map((formal) => [formal.statement_id, 0x1000n]),
    );
    assert.equal(execute(emission, inputs).exit, 'fault');
    const memory = new Map(Array.from({ length: 8 }, (_, index) => [0x1000n + BigInt(index), 0]));
    assert.deepEqual(execute(emission, inputs, memory).values, [7n]);
  }
});

test('positive caller demand retains computed exit slices inline', () => {
  const source = computedExit({ function_return_demands: [x(1)] }).view('source');
  const projection = [...source.returns.values()][0]!;
  assert.ok(projection.outputs.some((item) => item.register.root === x(1).root));
  assert.ok(!projection.exit_scratch?.some((item) => item.register.root === x(1).root));
});

test('multi-register result evidence refuses the computed-slice assumption', () => {
  const source = computedExit({
    function_returns: { registers: [x(0), x(1)], types: [u64, u64] },
  }).view('source');
  assert.ok(![...source.returns.values()][0]!.exit_scratch?.some((item) => item.computed));
});

test('without an established primary result computed exit slices stay inline', () => {
  const source = computedExit({}, false).view('source');
  assert.ok(
    [...source.returns.values()][0]!.outputs.some((item) => item.register.root === x(1).root),
  );
});

test('wide integer or homogeneous floating result evidence retains other computed slices', () => {
  const floating = abi.unknown_call_clobbers.registers.filter(
    (register) => register.root === 'arm64:v0' || register.root === 'arm64:v1',
  );
  assert.equal(floating.length, 2);
  for (const function_returns of [
    { registers: [x(0)], types: [integer(128)] },
    {
      registers: floating,
      types: [
        { kind: 'float', bits: 64 },
        { kind: 'float', bits: 64 },
      ],
    },
  ] satisfies NonNullable<SourceEvidence['function_returns']>[]) {
    const projection = [...computedExit({ function_returns }).view('source').returns.values()][0]!;
    assert.ok(projection.outputs.some((item) => item.register.root === x(1).root));
    assert.ok(!projection.exit_scratch?.some((item) => item.computed));
  }
});

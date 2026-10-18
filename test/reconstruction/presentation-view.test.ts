import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationContext,
  newIdentity,
  type RegisterDescriptor,
} from '../../src/core/index.js';
import { darwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../src/abi/sysv-amd64/index.js';
import { windowsX64Abi } from '../../src/abi/windows-x64/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { recoverTypes } from '../../src/analysis/types/index.js';
import { bitWidth, integer, type DataType, type SSAForm } from '../../src/ir/index.js';
import { structureControlFlow } from '../../src/presentation/index.js';
import { reconstruct, type Reconstruction } from '../../src/reconstruction/index.js';
import type { InferredCallee, SourceEvidence } from '../../src/reconstruction/source-model.js';
import { builder, image, slice } from '../ir/support.js';
import { emit, emittedFormals, execute } from '../emitters/c/support.js';
import type { EmissionResult } from '../../src/emitters/model.js';

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

/** No scratch register is named in the text, so the scratch comment is omitted
 * under a recorded presentation; exit metadata keeps the slices. */
function scratchNoteOmitted(
  emission: EmissionResult['emission'],
  registers: readonly string[],
): void {
  assert.doesNotMatch(emission.text, /ABI scratch at return/);
  for (const name of registers) assert.doesNotMatch(emission.text, new RegExp(`\\b${name}\\b`));
  assert.ok(
    emission.local_validation?.some(
      (record) => record.kind === 'presentation' && record.rule === 'abi_scratch_note',
    ),
  );
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
    scratchNoteOmitted(emission, ['x1', 'v0', 'v1', 'v2', 'v3']);
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
    scratchNoteOmitted(emission, ['x1']);
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

test('exit expressions stay in metadata without manufacturing a dead local', () => {
  const fixture = computedExit({}, true, true);
  for (const language of ['c-like', 'python-like'] as const) {
    const { emission } = emit(fixture.ir, fixture.extra, language);
    scratchNoteOmitted(emission, ['x1']);
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

test('signature-approved void exits move computed nonprimary slices out of line', () => {
  const fixture = computedExit({}, false);
  const source = fixture.view('source');
  const projection = [...source.returns.values()][0]!;
  assert.equal(source.source?.return_type, null);
  assert.equal(projection.results.length, 0);
  assert.equal(projection.outputs.length, 0);
  assert.ok(projection.exit_scratch?.some((slice) => slice.computed));
  assert.ok(
    source.local_validation_session?.abiConformance.some(
      (site) => site.rule === 'exit_scratch' && site.explanation.includes('void-like'),
    ),
  );
  for (const language of ['c-like', 'python-like'] as const) {
    const { emission } = emit(fixture.ir, fixture.extra, language);
    assert.doesNotMatch(emission.text, /physical_return|also at exit:.* = value\d/);
    assert.match(emission.text, language === 'c-like' ? /\bvoid\b/ : /-> void:/);
    const inputs = new Map(
      emittedFormals(emission).map((formal) => [formal.statement_id, 0x1000n]),
    );
    assert.equal(execute(emission, inputs).exit, 'fault');
    const memory = new Map(Array.from({ length: 8 }, (_, index) => [0x1000n + BigInt(index), 0]));
    assert.deepEqual(execute(emission, inputs, memory).values, []);
  }
});

test('void-like exits with caller demand keep their explicit overlay', () => {
  const source = computedExit({ function_return_demands: [x(1)] }, false).view('source');
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

function registerExit(
  abi: SourceEvidence['abi'],
  type: DataType | null,
  evidence: Partial<SourceEvidence> = {},
  writtenPrimary = false,
  explicit = true,
) {
  const b = builder(`register-exit-${abi.id}-${type?.kind ?? 'void'}`),
    block = b.block('entry');
  const floating = abi.unknown_call_clobbers.registers.find(
    (register) => register.root === (abi.id === 'darwin-arm64' ? 'arm64:v0' : 'x86_64:zmm0'),
  )!;
  const secondary = abi.unknown_call_clobbers.registers.find(
    (register) => register.root === (abi.id === 'darwin-arm64' ? 'arm64:v1' : 'x86_64:zmm1'),
  )!;
  const primary = abi.classifyCall({
    returns: { kind: 'pointer' },
    parameters: [],
    variadic: false,
    fixed_parameter_count: 0,
  }).returns[0]!;
  assert.equal(primary.kind, 'register');
  if (primary.kind !== 'register') throw new Error('register primary required');
  const result = type ? block.constant(type, 7n) : undefined;
  if (result && type?.kind === 'integer') block.writeRegister(primary.register, result);
  else if (result || writtenPrimary)
    block.writeRegister(
      {
        ...floating,
        id: `${floating.root}:0:${type ? bitWidth(type) : 64}`,
        width_bits: type ? bitWidth(type) : 64,
        write_rule: 'preserve_other_bits',
      },
      result ?? block.constant(u64, 7n),
    );
  if (type?.kind !== 'vector')
    block.writeRegister(
      {
        ...floating,
        id: `${floating.root}:64:64`,
        offset_bits: 64,
        width_bits: 64,
        write_rule: 'preserve_other_bits',
      },
      block.constant(u64, 19n),
    );
  block.writeRegister(secondary, block.constant(integer(secondary.width_bits), 23n));
  if (abi.id !== 'darwin-arm64') {
    const rdx = abi.unknown_call_clobbers.registers.find(
      (register) => register.root === 'x86_64:rdx',
    )!;
    block.writeRegister(rdx, block.constant(u64, 29n));
  }
  block.return(result && explicit ? [result] : []);
  const ir = constructSSA(b.finish(block, type && explicit ? [type] : [])).value as SSAForm;
  const source: SourceEvidence = { abi, callees: [], addresses: [], ...evidence };
  const structured = structureControlFlow(ir, createOperationContext()).value!;
  return {
    ir,
    source,
    floating,
    view: (view: 'source' | 'checked') =>
      reconstruct({ function: structured, source }, createOperationContext(), view),
  };
}

for (const target of [abi, sysvAMD64Abi, windowsX64Abi]) {
  for (const type of [
    { kind: 'float', bits: 32 },
    { kind: 'float', bits: 64 },
    { kind: 'vector', element: integer(32), lanes: 4 },
  ] satisfies DataType[]) {
    test(`${target.id} ${type.kind}${bitWidth(type)} primary moves high lanes and undemanded vectors out of line`, () => {
      const fixture = registerExit(target, type);
      const projection = [...fixture.view('source').returns.values()][0]!;
      assert.equal(projection.outputs.length, 0);
      // Microsoft x64 has no secondary vector/pair return bank: a full XMM0
      // result already covers all possible vector return storage.
      const hasOverlay = target.id !== 'windows-x64' || type.kind === 'float';
      assert.equal(projection.exit_scratch?.some((slice) => slice.computed) ?? false, hasOverlay);
      assert.equal(
        [...fixture.view('checked').returns.values()][0]!.outputs.length > 0,
        hasOverlay,
      );
      for (const language of ['c-like', 'python-like'] as const) {
        const { emission } = emit(fixture.ir, { source: fixture.source }, language);
        assert.doesNotMatch(emission.text, /physical_return/);
        assert.deepEqual(execute(emission).values, [7n]);
      }
    });
  }

  test(`${target.id} untyped written FP primary refuses a void-like interface`, () => {
    const fixture = registerExit(target, null, {}, true);
    const projection = [...fixture.view('source').returns.values()][0]!;
    assert.equal(projection.results.length, 0);
    assert.ok(
      projection.outputs.some((binding) => binding.register.root === fixture.floating.root),
    );
  });

  test(`${target.id} high lanes without a written primary permit a void-like exit`, () => {
    const fixture = registerExit(target, null);
    const projection = [...fixture.view('source').returns.values()][0]!;
    assert.equal(projection.results.length, 0);
    assert.equal(projection.outputs.length, 0);
    assert.ok(projection.exit_scratch?.some((slice) => slice.computed));
    for (const language of ['c-like', 'python-like'] as const) {
      const { emission } = emit(fixture.ir, { source: fixture.source }, language);
      assert.doesNotMatch(emission.text, /physical_return/);
      assert.deepEqual(execute(emission).values, []);
    }
  });

  test(`${target.id} positive high-lane demand refuses FP overlay elision`, () => {
    const fixture = registerExit(target, { kind: 'float', bits: 64 });
    const high = { ...fixture.floating, offset_bits: 64, width_bits: 64 };
    const demanded = registerExit(
      target,
      { kind: 'float', bits: 64 },
      {
        function_return_demands: [high],
      },
    );
    const projection = [...demanded.view('source').returns.values()][0]!;
    assert.ok(
      projection.outputs.some(
        (binding) => binding.register.root === high.root && binding.register.offset_bits === 64,
      ),
    );
  });
}

test('System V RDX joins RAX inline only with positive pair evidence', () => {
  const target = sysvAMD64Abi;
  const rdx = target.unknown_call_clobbers.registers.find(
    (register) => register.root === 'x86_64:rdx',
  )!;
  for (const demanded of [false, true]) {
    const fixture = registerExit(target, u64, demanded ? { function_return_demands: [rdx] } : {});
    const projection = [...fixture.view('source').returns.values()][0]!;
    assert.equal(
      projection.outputs.some((binding) => binding.register.root === rdx.root),
      demanded,
    );
    assert.equal(
      projection.exit_scratch?.some((slice) => slice.register.root === rdx.root) ?? false,
      !demanded,
    );
  }
  const rax = target.unknown_call_clobbers.registers.find(
    (register) => register.root === 'x86_64:rax',
  )!;
  const pair = registerExit(
    target,
    u64,
    { function_returns: { registers: [rax, rdx], types: [u64, u64] } },
    false,
    false,
  );
  const projection = [...pair.view('source').returns.values()][0]!;
  assert.equal(projection.results.length, 2);
  assert.ok(!projection.exit_scratch?.some((slice) => slice.computed));
  for (const language of ['c-like', 'python-like'] as const) {
    const { emission } = emit(pair.ir, { source: pair.source }, language);
    assert.deepEqual(execute(emission).values, [7n, 29n]);
  }
});

test('x86 implicit division, multiplication, sign-extension and call RDX residue obey positive result evidence', () => {
  const target = sysvAMD64Abi;
  const rdx = target.unknown_call_clobbers.registers.find(
    (register) => register.root === 'x86_64:rdx',
  )!;
  const rax = target.unknown_call_clobbers.registers.find(
    (register) => register.root === 'x86_64:rax',
  )!;
  const rdi = target.unknown_call_clobbers.registers.find(
    (register) => register.root === 'x86_64:rdi',
  )!;
  for (const operation of ['div', 'mul', 'cqo', 'call'] as const)
    for (const demanded of [false, true]) {
      const b = builder(`rdx-${operation}-${demanded}`),
        block = b.block('entry');
      const input = block.readRegister(rdi);
      let primary = input;
      if (operation === 'div') {
        const divisor = block.constant(u64, 2n);
        primary = block.int('udiv', input, divisor);
        block.writeRegister(rdx, block.int('urem', input, divisor));
      } else if (operation === 'mul') {
        const product = block.int(
          'mul',
          block.cast('zero_extend', integer(128), input),
          block.constant(integer(128), 7n),
        );
        primary = block.cast('truncate', u64, product);
        block.writeRegister(
          rdx,
          block.cast(
            'truncate',
            u64,
            block.int('lshr', product, block.constant(integer(128), 64n)),
          ),
        );
      } else if (operation === 'cqo')
        block.writeRegister(rdx, block.int('ashr', input, block.constant(u64, 63n)));
      else
        block.call(
          { kind: 'direct', address: { image_id: image, space: 'va', value: 0x1234n } },
          [],
          [],
          target.unknown_call_clobbers,
        );
      block.writeRegister(rax, primary);
      block.return([primary]);
      const ir = constructSSA(b.finish(block, [u64])).value as SSAForm;
      const source: SourceEvidence = {
        abi: target,
        addresses: [],
        callees: ir.blocks
          .flatMap((item) => item.instructions)
          .filter((node) => node.kind === 'call')
          .map((node) => ({
            call_id: node.id,
            parameters: [],
            returns: [],
            argument_list_complete: true,
            evidence_ids: [],
          })),
        ...(demanded ? { function_return_demands: [rdx] } : {}),
      };
      const context = createOperationContext();
      const program = reconstruct(
        { function: structureControlFlow(ir, context).value!, source },
        context,
        'source',
      );
      const projection = [...program.returns.values()][0]!;
      assert.equal(
        projection.outputs.some((binding) => binding.register.root === rdx.root),
        demanded,
      );
      assert.equal(
        projection.exit_scratch?.some((binding) => binding.register.root === rdx.root) ?? false,
        !demanded,
      );
      for (const language of ['c-like', 'python-like'] as const) {
        const { emission } = emit(ir, { source }, language);
        const observed = execute(
          emission,
          new Map(
            emittedFormals(emission).flatMap((formal) =>
              formal.semantic_ids.map((id) => [id, 9n] as const),
            ),
          ),
          new Map(),
          0n,
          new Map(),
          new Map(),
          new Map([['sub_1234', () => []]]),
        );
        assert.deepEqual(observed.values, [
          operation === 'div' ? 4n : operation === 'mul' ? 63n : 9n,
        ]);
        assert.match(emit(ir, { source }, language, 'checked').emission.text, /physical_return\(/);
      }
    }
});

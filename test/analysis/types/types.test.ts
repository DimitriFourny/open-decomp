import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationContext,
  entityIdentity,
  type AbiProfile,
  type AbiSignature,
  type Annotation,
  type RecoveredType,
  type Signature,
} from '../../../src/core/index.js';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { WindowsX64Abi } from '../../../src/abi/windows-x64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import {
  recoverTypes,
  stackTypeSubject,
  type SuppliedSignature,
  type SuppliedTypeRecord,
  type TypeRecoveryOptions,
} from '../../../src/analysis/types/index.js';
import { integer, type RegisterIR, type SSAForm } from '../../../src/ir/index.js';
import type { DebugRecovery } from '../../../src/metadata/debug/index.js';
import type { LibraryContracts } from '../../../src/metadata/library-contracts/index.js';
import { builder, image, slice } from '../../ir/support.js';

const targets = [new DarwinArm64Abi(), new WindowsX64Abi()];
const i32 = integer(32),
  i64 = integer(64);
const baseOptions = { image_id: image, slice_id: slice, revision: 3 };
const entry = { image_id: image, space: 'va' as const, value: 0x1000n };
const target = { image_id: image, space: 'va' as const, value: 0x2000n };
const ids = {
  long: entityIdentity(slice, 'source-type', 'long'),
  int: entityIdentity(slice, 'source-type', 'int'),
  float: entityIdentity(slice, 'source-type', 'float'),
  object: entityIdentity(slice, 'source-type', 'record'),
  pointer: entityIdentity(slice, 'source-type', 'record-pointer'),
  void: entityIdentity(slice, 'source-type', 'void'),
  array: entityIdentity(slice, 'source-type', 'array'),
};
function ssa(program: RegisterIR): SSAForm {
  const result = constructSSA(program);
  assert.equal(result.state, 'complete');
  if (result.value.form !== 'ssa') throw new Error('Expected SSA');
  return result.value;
}
function sourceTypes(abi: AbiProfile): SuppliedTypeRecord[] {
  const definitions: [string, RecoveredType][] = [
    [ids.long, { kind: 'integer', bits: abi.layout.long_bits, signed: true }],
    [ids.int, { kind: 'integer', bits: 32, signed: true }],
    [ids.float, { kind: 'float', bits: 32 }],
    [ids.void, { kind: 'void' }],
    [
      ids.object,
      {
        kind: 'structure',
        size: 16n,
        alignment: 8,
        fields: [
          {
            id: entityIdentity(slice, 'source-field', 'long'),
            name: 'counter',
            offset: 0n,
            type_id: ids.long,
          },
          {
            id: entityIdentity(slice, 'source-field', 'int'),
            name: 'tag',
            offset: 8n,
            type_id: ids.int,
          },
        ],
      },
    ],
    [ids.pointer, { kind: 'pointer', bits: 64, to: ids.object }],
  ];
  return definitions.map(([id, definition]) => ({
    id,
    definition,
    source: 'debug',
    status: 'established',
    evidence_ids: [],
  }));
}
function signature(
  abi: AbiProfile,
  parameters: string[] = [ids.pointer],
  returns = ids.long,
): Signature {
  return {
    abi: abi.id,
    return_type: returns,
    parameters: parameters.map((type_id, index) => ({
      id: entityIdentity(slice, 'parameter', index),
      name: null,
      type_id,
    })),
    variadic: false,
    noreturn: false,
    evidence_ids: [],
  };
}
function parameterRegister(abi: AbiProfile) {
  const layout = abi.classifyCall({
    returns: { kind: 'void' },
    parameters: [{ kind: 'pointer' }],
    variadic: false,
    fixed_parameter_count: 1,
  });
  const location = layout.parameters[0]!.locations[0]!;
  if (location.kind !== 'register') throw new Error('Expected pointer register');
  return location.register;
}
function debugInput(types: SuppliedTypeRecord[], sig: Signature): DebugRecovery {
  return {
    status: 'complete',
    undecoded: false,
    uuid: null,
    content_sha256: 'a'.repeat(64),
    data: null,
    evidence: [],
    diagnostics: [],
    types: types.map((type) => ({
      id: type.id,
      definition: type.definition,
      dwarf_id: null,
      display_name: 'untrusted display name',
      evidence_ids: [],
    })),
    functions: [
      {
        id: entityIdentity(slice, 'debug-function', 'entry'),
        dwarf: { id: 'die', address: entry.value, name: 'display only' },
        signature: sig,
        conflicting: false,
        evidence_ids: [],
      },
    ],
  };
}

for (const abi of targets)
  test(`${abi.id}: debug signatures bind physical input/return and observed fields with target long width`, () => {
    const ir = builder(`type-fields-${abi.id}`),
      b = ir.block('entry');
    const pointer = b.readRegister(parameterRegister(abi));
    const counter = b.load(integer(abi.layout.long_bits), pointer);
    const tag = b.load(i32, b.int('add', pointer, b.constant(i64, 8n)));
    const returnLocation = abi.classifyCall({
      returns: { kind: 'integer', bits: abi.layout.long_bits, signed: true },
      parameters: [],
      variadic: false,
      fixed_parameter_count: 0,
    }).returns[0]!;
    assert.equal(returnLocation.kind, 'register');
    if (returnLocation.kind !== 'register') throw new Error('Expected return register');
    b.writeRegister(
      returnLocation.register,
      abi.layout.long_bits === returnLocation.register.width_bits
        ? counter
        : b.cast('zero_extend', integer(returnLocation.register.width_bits), counter),
    );
    b.return();
    const program = ssa(ir.finish(b)),
      original = structuredClone(program);
    const options: TypeRecoveryOptions = {
      ...baseOptions,
      entry_address: entry,
      debug: debugInput(sourceTypes(abi), signature(abi)),
    };
    const result = recoverTypes(program, abi, createOperationContext(), options);
    assert.equal(result.state, 'complete');
    assert.deepEqual(program, original);
    assert.equal(result.signatures[0]!.signature.parameters.length, 1);
    assert.equal(result.signatures[0]!.abi_state, 'complete');
    const shape = result.shapes.find((shape) => shape.base.kind === 'value')!;
    assert.deepEqual(
      shape.fields.map((field) => [field.offset, field.width_bits]),
      [
        [0n, abi.layout.long_bits],
        [8n, 32],
      ],
    );
    assert.deepEqual(shape.observed_extent, { start: 0n, end: 12n });
    const inferred = result.types.find((type) => type.id === shape.type_id)!.definition;
    assert.equal(inferred.kind, 'structure');
    if (inferred.kind !== 'structure') throw new Error('Expected structure');
    assert.equal(inferred.size, null);
    assert.equal(inferred.alignment, null);
    assert.equal(shape.alias, 'possible');
    assert.equal(shape.escape, 'unknown');
    for (const [subject, type_id] of [
      [counter.id, ids.long],
      [tag.id, ids.int],
    ])
      assert.ok(
        result.associations.some(
          (item) =>
            item.subject_id === subject && item.type_id === type_id && item.source === 'debug',
        ),
      );
    assert.ok(
      result.associations.some(
        (item) =>
          item.subject_id !== counter.id &&
          item.type_id === ids.long &&
          item.source === 'debug' &&
          item.width_bits === abi.layout.long_bits,
      ),
    );
    assert.ok(result.evidence.some((item) => item.derived_from.length > 0));
    const again = recoverTypes(program, abi, createOperationContext(), options);
    assert.deepEqual(again, result);
  });

for (const abi of targets)
  test(`${abi.id}: exact stack subjects preserve signed offsets, regions and escape uncertainty`, () => {
    const ir = builder(`type-stack-${abi.id}`),
      b = ir.block('entry');
    const sp = b.readRegister(abi.stack_pointer),
      object = b.int('sub', sp, b.constant(i64, 32n));
    const first = b.constant(integer(abi.layout.long_bits), 7n),
      second = b.constant(i32, 9n);
    b.store(object, first);
    b.store(b.int('add', object, b.constant(i64, 8n)), second);
    b.writeRegister(parameterRegister(abi), object);
    b.call({ kind: 'direct', address: target }, [], [], abi.unknown_call_clobbers);
    b.return();
    const program = ssa(ir.finish(b)),
      subject_id = stackTypeSubject(slice, program.id, -32n);
    const annotation: Annotation = {
      id: `annotation_${'1'.repeat(64)}`,
      entity_id: subject_id,
      author: 'analyst',
      origin: 'user',
      status: 'asserted',
      revision: 3,
      evidence_ids: [],
      value: {
        kind: 'type',
        type_id: ids.object,
        definition: sourceTypes(abi).find((type) => type.id === ids.object)!.definition,
      },
    };
    const result = recoverTypes(program, abi, createOperationContext(), {
      ...baseOptions,
      types: sourceTypes(abi).filter((type) => type.id !== ids.object),
      annotations: [annotation],
    });
    const shape = result.shapes.find((shape) => shape.base.kind === 'stack')!;
    assert.equal(shape.base_offset, -32n);
    assert.equal(shape.observed_extent!.start, -32n);
    assert.equal(shape.escape, 'observed');
    assert.equal(shape.alias, 'observed');
    assert.ok(shape.fields.every((field) => field.stack_region === 'local_candidate'));
    assert.ok(result.subjects.includes(subject_id));
    assert.ok(
      result.associations.some(
        (item) =>
          item.subject_id === first.id && item.type_id === ids.long && item.status === 'asserted',
      ),
    );
    assert.ok(
      result.associations.some(
        (item) =>
          item.subject_id === second.id && item.type_id === ids.int && item.status === 'asserted',
      ),
    );
  });

test('assertion alternatives retain conflict evidence; removal/retraction drops their complete influence', () => {
  const abi = targets[0]!,
    ir = builder('type-retraction'),
    b = ir.block('entry'),
    value = b.indeterminate(i32, 'unknown', 'input');
  b.return([value]);
  const program = ssa(ir.finish(b, [i32]));
  const annotation: Annotation = {
    id: `annotation_${'2'.repeat(64)}`,
    entity_id: value.id,
    author: 'user',
    origin: 'llm',
    status: 'asserted',
    revision: 3,
    evidence_ids: [],
    value: { kind: 'type', type_id: ids.float, definition: { kind: 'float', bits: 32 } },
  };
  const options: TypeRecoveryOptions = {
    ...baseOptions,
    types: sourceTypes(abi),
    bindings: [
      {
        subject_id: value.id,
        type_id: ids.int,
        source: 'debug',
        status: 'established',
        evidence_ids: [],
      },
    ],
  };
  const baseline = recoverTypes(program, abi, createOperationContext(), options);
  const asserted = recoverTypes(program, abi, createOperationContext(), {
    ...options,
    annotations: [annotation],
  });
  assert.ok(
    asserted.conflicts.some(
      (conflict) => conflict.subject_id === value.id && conflict.reason === 'incompatible_types',
    ),
  );
  assert.ok(
    asserted.evidence.some(
      (item) =>
        item.origin.kind === 'assertion' &&
        item.origin.agent === 'llm' &&
        item.origin.status === 'asserted',
    ),
  );
  assert.ok(
    asserted.associations.some(
      (item) => item.type_id === ids.float && item.status === 'conflicting',
    ),
  );
  const { work: baselineWork, ...baselineFacts } = baseline;
  const { work: retractedWork, ...retractedFacts } = recoverTypes(
    program,
    abi,
    createOperationContext(),
    { ...options, annotations: [{ ...annotation, status: 'retracted' }] },
  );
  assert.deepEqual(retractedFacts, baselineFacts);
  assert.deepEqual(
    recoverTypes(program, abi, createOperationContext(), { ...options, annotations: [] }),
    baseline,
  );
});

test('names and isolated casts do not establish source types or sizes; signed operations remain candidates', () => {
  const abi = targets[0]!,
    ir = builder('type-names-casts'),
    b = ir.block('entry');
  const value = b.indeterminate(i64, 'unknown', 'opaque'),
    cast = b.cast('truncate', i32, value);
  b.int('sdiv', cast, b.constant(i32, 3n));
  b.return();
  const program = ssa(ir.finish(b));
  const result = recoverTypes(program, abi, createOperationContext(), {
    ...baseOptions,
    annotations: [
      {
        id: `annotation_${'3'.repeat(64)}`,
        entity_id: value.id,
        author: 'analyst',
        origin: 'user',
        status: 'asserted',
        revision: 3,
        evidence_ids: [],
        value: { kind: 'name', value: 'struct HugeObject[999999]' },
      },
    ],
  });
  assert.deepEqual(result.shapes, []);
  assert.deepEqual(result.signatures, []);
  assert.equal(
    result.associations.some((item) => item.subject_id === value.id),
    false,
  );
  assert.ok(
    result.associations
      .filter((item) => item.subject_id === cast.id)
      .every((item) => item.status === 'candidate' && item.source === 'analysis'),
  );
  assert.ok(
    result.types.every(
      (type) => type.definition.kind !== 'structure' && type.definition.kind !== 'array',
    ),
  );
});

test('hypothesis signatures/types cannot supply an established ABI layout', () => {
  const abi = targets[0]!,
    ir = builder('type-hypothesis'),
    b = ir.block('entry');
  b.readRegister(parameterRegister(abi));
  b.return();
  const program = ssa(ir.finish(b));
  const declaration: SuppliedSignature = {
    id: 'hypothesis',
    subject_id: program.id,
    signature: signature(abi),
    source: 'user',
    status: 'hypothesis',
    evidence_ids: [],
  };
  const result = recoverTypes(program, abi, createOperationContext(), {
    ...baseOptions,
    types: sourceTypes(abi),
    signatures: [declaration],
  });
  assert.equal(result.calls!.function_contract_status, 'unknown');
  assert.equal(result.signatures[0]!.status, 'hypothesis');
  assert.equal(
    result.associations.some((item) => item.source === 'user'),
    false,
  );
  const uncertainTypes = sourceTypes(abi).map((type) => ({
    ...type,
    status: 'hypothesis' as const,
  }));
  const asserted = recoverTypes(program, abi, createOperationContext(), {
    ...baseOptions,
    types: uncertainTypes,
    signatures: [{ ...declaration, status: 'asserted' }],
  });
  assert.notEqual(asserted.signatures[0]!.abi_state, 'complete');
});

test('unknown parameter count is never emitted as a zero-argument source signature', () => {
  const abi = targets[0]!,
    ir = builder('type-unknown-count'),
    b = ir.block('entry');
  b.call({ kind: 'direct', address: target }, [], [], abi.unknown_call_clobbers);
  b.return();
  const program = ssa(ir.finish(b));
  const unknown: AbiSignature = {
    returns: { kind: 'unknown', size: null },
    parameters: null,
    variadic: false,
    fixed_parameter_count: 0,
  };
  const result = recoverTypes(program, abi, createOperationContext(), {
    ...baseOptions,
    contracts: [
      {
        id: 'unknown',
        target: { kind: 'address', address: target },
        signature: unknown,
        evidence_ids: [],
      },
    ],
  });
  assert.equal(result.calls!.calls[0]!.contracts[0]!.contract.signature.parameters, null);
  assert.deepEqual(result.signatures, []);
  const zero = recoverTypes(program, abi, createOperationContext(), {
    ...baseOptions,
    contracts: [
      {
        id: 'zero',
        target: { kind: 'address', address: target },
        signature: { ...unknown, returns: { kind: 'void' }, parameters: [] },
        evidence_ids: [],
      },
    ],
  });
  assert.deepEqual(zero.signatures[0]!.signature.parameters, []);
});

test('scaled accesses preserve unknown array count and do not invent a dynamic extent', () => {
  const abi = targets[0]!,
    ir = builder('type-array'),
    b = ir.block('entry');
  const pointer = b.indeterminate(i64, 'unknown', 'pointer'),
    index = b.indeterminate(i64, 'unknown', 'index');
  const address = b.int('add', pointer, b.int('mul', index, b.constant(i64, 4n)));
  b.load(i32, address);
  b.return();
  const result = recoverTypes(ssa(ir.finish(b)), abi, createOperationContext(), baseOptions);
  assert.equal(result.shapes[0]!.dynamic, true);
  assert.equal(result.shapes[0]!.observed_extent, null);
  assert.equal(result.shapes[0]!.fields[0]!.stride, 4n);
  assert.ok(
    result.types.some((type) => type.definition.kind === 'array' && type.definition.count === null),
  );
  assert.ok(
    result.types
      .filter((type) => type.definition.kind === 'structure')
      .every((type) => type.definition.kind === 'structure' && type.definition.size === null),
  );
});

test('overlapping access widths and mismatched source field layouts are visible, not silently unified', () => {
  const abi = targets[0]!,
    ir = builder('type-overlap'),
    b = ir.block('entry'),
    pointer = b.indeterminate(i64, 'unknown', 'pointer');
  b.load(i64, pointer);
  b.load(i32, pointer);
  b.load(i64, b.int('add', pointer, b.constant(i64, 12n)));
  b.return();
  const result = recoverTypes(ssa(ir.finish(b)), abi, createOperationContext(), {
    ...baseOptions,
    types: sourceTypes(abi),
    bindings: [
      {
        subject_id: pointer.id,
        type_id: ids.pointer,
        source: 'debug',
        status: 'established',
        evidence_ids: [],
      },
    ],
  });
  assert.ok(result.conflicts.some((item) => item.reason === 'overlapping_accesses'));
  assert.ok(result.conflicts.some((item) => item.reason === 'layout_mismatch'));
  assert.deepEqual(
    result.shapes[0]!.fields.map((field) => [field.offset, field.width_bits]),
    [
      [0n, 32],
      [0n, 64],
      [12n, 64],
    ],
  );
});

test('recursive pointers survive while cyclic by-value graphs and incomplete aggregate alignment remain ABI unknown', () => {
  const abi = targets[0]!,
    ir = builder('type-cycles'),
    b = ir.block('entry');
  b.readRegister(parameterRegister(abi));
  b.return();
  const program = ssa(ir.finish(b)),
    types = sourceTypes(abi);
  const recursive: SuppliedTypeRecord = {
    id: ids.object,
    source: 'debug',
    status: 'established',
    evidence_ids: [],
    definition: {
      kind: 'structure',
      size: 8n,
      alignment: null,
      fields: [
        {
          id: entityIdentity(slice, 'field', 'next'),
          name: 'next',
          offset: 0n,
          type_id: ids.pointer,
        },
      ],
    },
  };
  const declaration: SuppliedSignature = {
    id: 'recursive',
    subject_id: program.id,
    signature: signature(abi, [ids.object]),
    source: 'debug',
    status: 'established',
    evidence_ids: [],
  };
  const result = recoverTypes(program, abi, createOperationContext(), {
    ...baseOptions,
    types: [...types.filter((type) => type.id !== ids.object), recursive],
    signatures: [declaration],
  });
  assert.equal(result.state, 'complete');
  assert.notEqual(result.signatures[0]!.abi_state, 'complete');
  assert.ok(
    result.types.some(
      (type) => type.definition.kind === 'pointer' && type.definition.to === ids.object,
    ),
  );
  const cyclic: SuppliedTypeRecord = {
    ...recursive,
    definition: { kind: 'array', element: ids.object, count: 1n },
  };
  const bounded = recoverTypes(program, abi, createOperationContext(), {
    ...baseOptions,
    types: [...types.filter((type) => type.id !== ids.object), cyclic],
    signatures: [declaration],
  });
  assert.equal(bounded.state, 'complete');
  assert.notEqual(bounded.signatures[0]!.abi_state, 'complete');
});

test('work exhaustion and cancellation publish no half-recovered source conclusions', () => {
  const abi = targets[0]!,
    ir = builder('type-budget'),
    b = ir.block('entry'),
    pointer = b.indeterminate(i64, 'unknown', 'pointer');
  b.load(i32, pointer);
  b.return();
  const program = ssa(ir.finish(b));
  const bounded = recoverTypes(program, abi, createOperationContext(), {
    ...baseOptions,
    max_work: 1,
  });
  assert.equal(bounded.state, 'partial');
  assert.deepEqual(bounded.associations, []);
  assert.deepEqual(bounded.types, []);
  assert.ok(bounded.diagnostics.some((item) => item.code === 'resource_limit'));
  const controller = new AbortController();
  controller.abort();
  const cancelled = recoverTypes(
    program,
    abi,
    createOperationContext({ signal: controller.signal }),
    baseOptions,
  );
  assert.equal(cancelled.state, 'partial');
  assert.deepEqual(cancelled.shapes, []);
  assert.ok(cancelled.diagnostics.some((item) => item.code === 'cancelled'));
});

for (const abi of targets)
  test(`${abi.id}: exact library contracts bind physical call results, never import storage`, () => {
    const ir = builder(`type-library-${abi.id}`),
      b = ir.block('entry');
    const pointer = b.indeterminate(i64, 'unknown', 'pointer');
    b.writeRegister(parameterRegister(abi), pointer);
    b.call({ kind: 'direct', address: target }, [], [], abi.unknown_call_clobbers);
    b.return();
    const program = ssa(ir.finish(b)),
      types = sourceTypes(abi),
      sig = signature(abi);
    const abi_signature: AbiSignature = {
      parameters: [{ kind: 'pointer' }],
      returns: { kind: 'integer', bits: abi.layout.long_bits, signed: true },
      variadic: false,
      fixed_parameter_count: 1,
    };
    const library: LibraryContracts = {
      state: 'complete',
      evidence: [],
      diagnostics: [],
      types: types.map((type) => ({
        id: type.id,
        name: 'display',
        definition: type.definition,
        abi_type: { kind: 'unknown', size: null },
        evidence_ids: [],
      })),
      contracts: [
        {
          id: 'exact-contract',
          import_id: 'import-native',
          library: 'nominal-exact-library',
          linkage_name: 'native',
          slot: target,
          callable_entry: null,
          abi_state: 'supported',
          abi_signature,
          signature: sig,
          noreturn: false,
          effects: {
            memory: 'unknown_read_write',
            arguments: null,
            captures: null,
            returns_argument: null,
            allocates: null,
          },
          variadic_rule: null,
          source: 'fixture declaration',
          evidence_ids: [],
          conflicts_with: [],
        },
      ],
    };
    const slotOnly = recoverTypes(program, abi, createOperationContext(), {
      ...baseOptions,
      library,
    });
    assert.deepEqual(slotOnly.signatures, []);
    const result = recoverTypes(program, abi, createOperationContext(), {
      ...baseOptions,
      library: {
        ...library,
        contracts: [
          { ...library.contracts[0]!, slot: { ...target, value: 0x5000n }, callable_entry: target },
        ],
      },
    });
    assert.equal(result.signatures[0]!.source, 'library');
    const call = program.blocks[0]!.instructions.find((node) => node.kind === 'call')!;
    assert.equal(call.kind, 'call');
    if (call.kind !== 'call') throw new Error('Expected call');
    assert.ok(
      call.register_outputs.some((binding) =>
        result.associations.some(
          (item) =>
            item.subject_id === binding.value.id &&
            item.type_id === ids.long &&
            item.source === 'library',
        ),
      ),
    );
    assert.equal(
      result.associations.some(
        (item) => item.subject_id === pointer.id && item.type_id === ids.long,
      ),
      false,
    );
  });

test('SSA loops and mixed reaching definitions keep conditional types bounded and do not rewrite machine widths', () => {
  const abi = targets[0]!,
    ir = builder('type-ssa-cycle'),
    entryBlock = ir.block('entry'),
    loop = ir.block('loop', [i64]),
    exit = ir.block('exit');
  const pointer = entryBlock.indeterminate(i64, 'unknown', 'pointer');
  entryBlock.jump(loop, [pointer]);
  const loaded = loop.load(i32, loop.parameters[0]!);
  loop.branch(
    loop.indeterminate(integer(1), 'unknown', 'condition'),
    loop.edge(loop, [loop.parameters[0]!]),
    loop.edge(exit),
  );
  exit.return();
  const program = ssa(ir.finish(entryBlock));
  const result = recoverTypes(program, abi, createOperationContext(), {
    ...baseOptions,
    types: sourceTypes(abi),
    bindings: [
      {
        subject_id: pointer.id,
        type_id: ids.pointer,
        source: 'debug',
        status: 'established',
        evidence_ids: [],
      },
    ],
  });
  assert.equal(result.state, 'complete');
  assert.ok(result.work < 100000);
  assert.ok(
    result.associations.some(
      (item) =>
        item.subject_id === loop.parameters[0]!.id &&
        item.type_id === ids.pointer &&
        item.status === 'candidate',
    ),
  );
  assert.deepEqual(loaded.type, i32);
});

test('conflicting call-local declarations stay local and preserve source alternatives', () => {
  const abi = targets[0]!,
    ir = builder('type-call-local'),
    b = ir.block('entry');
  b.writeRegister(parameterRegister(abi), b.constant(i64, 7n));
  b.call({ kind: 'direct', address: target }, [], [], abi.unknown_call_clobbers);
  b.call({ kind: 'direct', address: target }, [], [], abi.unknown_call_clobbers);
  b.return();
  const program = ssa(ir.finish(b)),
    calls = program.blocks[0]!.instructions.filter((node) => node.kind === 'call');
  const first = calls[0]!;
  const declarations: SuppliedSignature[] = [
    {
      id: 'local-debug',
      subject_id: first.id,
      signature: signature(abi, [ids.long]),
      source: 'debug',
      status: 'established',
      evidence_ids: [],
    },
    {
      id: 'local-library',
      subject_id: first.id,
      signature: signature(abi, [ids.pointer]),
      source: 'library',
      status: 'established',
      evidence_ids: [],
    },
    {
      id: 'local-user',
      subject_id: first.id,
      signature: signature(abi, []),
      source: 'user',
      status: 'asserted',
      evidence_ids: [],
    },
  ];
  const result = recoverTypes(program, abi, createOperationContext(), {
    ...baseOptions,
    types: sourceTypes(abi),
    signatures: declarations,
  });
  assert.equal(result.signatures.length, 3);
  assert.ok(
    result.signatures.every(
      (item) => item.subject_id === first.id && item.status === 'conflicting',
    ),
  );
  assert.ok(
    result.conflicts.some(
      (item) => item.subject_id === first.id && item.reason === 'incompatible_signatures',
    ),
  );
  assert.ok(result.calls!.calls.every((call) => call.contracts.length === 0));
  assert.equal(
    result.signatures.some((item) => item.subject_id === calls[1]!.id),
    false,
  );
});

test('physical ABI fragments are not attached to arithmetic ancestors or silently expanded to machine width', () => {
  const abi = targets[1]!,
    ir = builder('type-fragments'),
    b = ir.block('entry'),
    left = b.indeterminate(i64, 'unknown', 'left'),
    right = b.constant(i64, 3n);
  const computed = b.int('add', left, right);
  b.writeRegister(parameterRegister(abi), computed);
  b.call({ kind: 'direct', address: target }, [], [], abi.unknown_call_clobbers);
  b.return();
  const program = ssa(ir.finish(b)),
    call = program.blocks[0]!.instructions.find((node) => node.kind === 'call')!;
  const result = recoverTypes(program, abi, createOperationContext(), {
    ...baseOptions,
    types: sourceTypes(abi),
    signatures: [
      {
        id: 'narrow',
        subject_id: call.id,
        signature: signature(abi, [ids.int], ids.int),
        source: 'debug',
        status: 'established',
        evidence_ids: [],
      },
    ],
  });
  assert.equal(
    result.associations.some((item) => item.subject_id === left.id || item.subject_id === right.id),
    false,
  );
  assert.ok(
    result.associations.some(
      (item) =>
        item.type_id === ids.int &&
        item.width_bits === 32 &&
        item.machine_type?.kind === 'integer' &&
        item.machine_type.bits === 64,
    ),
  );
});

test('out-of-scope annotation definitions cannot contaminate an in-scope type graph', () => {
  const abi = targets[0]!,
    ir = builder('type-out-of-scope'),
    b = ir.block('entry');
  b.return();
  const program = ssa(ir.finish(b));
  const result = recoverTypes(program, abi, createOperationContext(), {
    ...baseOptions,
    types: sourceTypes(abi),
    annotations: [
      {
        id: `annotation_${'4'.repeat(64)}`,
        entity_id: entityIdentity(slice, 'unrelated-value', 'other-function'),
        author: 'analyst',
        origin: 'user',
        status: 'asserted',
        revision: 3,
        evidence_ids: [],
        value: { kind: 'type', type_id: ids.long, definition: { kind: 'float', bits: 64 } },
      },
    ],
  });
  assert.equal(result.types.filter((type) => type.id === ids.long).length, 1);
  assert.ok(result.diagnostics.some((item) => item.code === 'unavailable_semantics'));
});

test('declared type and field subjects retain conflicting assertions while function anchors declare types', () => {
  const abi = targets[0]!,
    ir = builder('type-declaration-subjects'),
    b = ir.block('entry');
  b.return();
  const program = ssa(ir.finish(b)),
    original = structuredClone(program),
    types = sourceTypes(abi);
  const definition = types.find((type) => type.id === ids.object)!.definition;
  assert.equal(definition.kind, 'structure');
  if (definition.kind !== 'structure') throw new Error('Expected structure');
  const field = definition.fields.find((member) => member.type_id === ids.int)!.id;
  const declared = entityIdentity(slice, 'source-type', 'function-scoped-declaration');
  const annotations: Annotation[] = [
    {
      id: `annotation_${'5'.repeat(64)}`,
      entity_id: ids.object,
      author: 'analyst',
      origin: 'user',
      status: 'asserted',
      revision: 3,
      evidence_ids: [],
      value: { kind: 'type', type_id: ids.object, definition: { ...definition, size: 24n } },
    },
    {
      id: `annotation_${'6'.repeat(64)}`,
      entity_id: field,
      author: 'analyst',
      origin: 'user',
      status: 'asserted',
      revision: 3,
      evidence_ids: [],
      value: { kind: 'type', type_id: ids.float, definition: { kind: 'float', bits: 32 } },
    },
    {
      id: `annotation_${'7'.repeat(64)}`,
      entity_id: program.id,
      author: 'analyst',
      origin: 'user',
      status: 'asserted',
      revision: 3,
      evidence_ids: [],
      value: {
        kind: 'type',
        type_id: declared,
        definition: { kind: 'pointer', bits: 64, to: ids.object },
      },
    },
  ];
  const options = { ...baseOptions, types },
    baseline = recoverTypes(program, abi, createOperationContext(), options);
  const result = recoverTypes(program, abi, createOperationContext(), { ...options, annotations });
  assert.ok(result.subjects.includes(ids.object));
  assert.ok(result.subjects.includes(field));
  assert.deepEqual(
    new Set(
      result.types
        .filter((type) => type.id === ids.object)
        .map((type) => (type.definition.kind === 'structure' ? type.definition.size : null)),
    ),
    new Set([16n, 24n]),
  );
  const alternatives = result.associations.filter(
    (association) => association.subject_id === field,
  );
  assert.deepEqual(
    new Set(alternatives.map((association) => association.type_id)),
    new Set([ids.int, ids.float]),
  );
  assert.ok(alternatives.every((association) => association.status === 'conflicting'));
  assert.ok(
    result.conflicts.some(
      (conflict) => conflict.subject_id === field && conflict.reason === 'incompatible_types',
    ),
  );
  assert.ok(
    result.conflicts.some(
      (conflict) => conflict.subject_id === ids.object && conflict.reason === 'incompatible_types',
    ),
  );
  assert.ok(
    result.types.some(
      (type) => type.id === declared && type.source === 'user' && type.status === 'asserted',
    ),
  );
  assert.equal(
    result.associations.some((association) => association.subject_id === program.id),
    false,
  );
  assert.equal(
    result.diagnostics.some((diagnostic) => diagnostic.code === 'unavailable_semantics'),
    false,
  );
  const { work: _baselineWork, ...before } = baseline;
  const { work: _retractedWork, ...after } = recoverTypes(program, abi, createOperationContext(), {
    ...options,
    annotations: annotations.map((annotation) => ({ ...annotation, status: 'retracted' })),
  });
  assert.deepEqual(after, before);
  assert.deepEqual(program, original);
});

for (const abi of targets)
  test(`${abi.id}: a supplied call declaration preserves source identity only at its matching call`, () => {
    const ir = builder(`type-paired-call-${abi.id}`),
      b = ir.block('entry');
    b.writeRegister(parameterRegister(abi), b.constant(i64, 0x4000n));
    b.call({ kind: 'direct', address: target }, [], [], abi.unknown_call_clobbers);
    b.call({ kind: 'direct', address: target }, [], [], abi.unknown_call_clobbers);
    b.return();
    const program = ssa(ir.finish(b)),
      original = structuredClone(program);
    const calls = program.blocks
      .flatMap((block) => block.instructions)
      .filter((node) => node.kind === 'call');
    const sig = signature(abi),
      declaration: SuppliedSignature = {
        id: 'paired-source-contract',
        subject_id: calls[0]!.id,
        signature: sig,
        source: 'user',
        status: 'asserted',
        evidence_ids: [],
      };
    const abiSignature: AbiSignature = {
      returns: { kind: 'integer', bits: abi.layout.long_bits, signed: true },
      parameters: [{ kind: 'pointer' }],
      variadic: false,
      fixed_parameter_count: 1,
    };
    const result = recoverTypes(program, abi, createOperationContext(), {
      ...baseOptions,
      types: sourceTypes(abi),
      signatures: [declaration],
      contracts: [
        {
          id: declaration.id,
          target: { kind: 'address', address: target },
          signature: abiSignature,
          evidence_ids: [],
        },
      ],
    });
    const first = result.signatures.filter((signature) => signature.subject_id === calls[0]!.id);
    assert.deepEqual(first, [
      { ...declaration, abi_state: 'complete', implicit_register_inputs: [] },
    ]);
    assert.equal(
      result.conflicts.some((conflict) => conflict.subject_id === calls[0]!.id),
      false,
    );
    const second = result.signatures.find((signature) => signature.subject_id === calls[1]!.id)!;
    assert.equal(second.source, 'analysis');
    assert.equal(second.status, 'established');
    assert.notEqual(second.signature.parameters[0]!.type_id, ids.pointer);
    assert.deepEqual(program, original);
  });

for (const [op, count, expected] of [
  ['add', 2, -2n],
  ['add', 3, 0x7ffffffffffffffdn],
  ['sub', 2, 2n],
] as const)
  test(`pointer shape ${op} offsets wrap at machine width after ${count} operations`, () => {
    const abi = targets[0]!,
      ir = builder(`type-wrapping-offset-${op}-${count}`),
      b = ir.block('entry');
    const pointer = b.indeterminate(i64, 'unknown', 'pointer'),
      step = b.constant(i64, 0x7fffffffffffffffn);
    let address = pointer;
    for (let index = 0; index < count; index++) address = b.int(op, address, step);
    b.load(i32, address);
    b.return();
    const result = recoverTypes(ssa(ir.finish(b)), abi, createOperationContext(), baseOptions);
    assert.equal(result.state, 'complete');
    const shape = result.shapes[0]!;
    assert.equal(shape.fields[0]!.offset, expected);
    assert.deepEqual(shape.observed_extent, { start: expected, end: expected + 4n });
    const definition = result.types.find((type) => type.id === shape.type_id)!.definition;
    assert.equal(definition.kind, 'structure');
    if (definition.kind === 'structure')
      assert.equal(definition.fields[0]!.offset, expected < 0n ? 0n : expected);
  });

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationContext,
  entityIdentity,
  expandEmission,
  type AbiSignature,
  type Signature,
} from '../../../src/core/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import {
  recoverPointerEvidence,
  recoverTypes,
  type SuppliedTypeRecord,
  type TypeRecoveryOptions,
  type TypeRecoveryResult,
} from '../../../src/analysis/types/index.js';
import { integer, type SSAForm, type Value } from '../../../src/ir/index.js';
import type { BlockBuilder, IRBuilder } from '../../../src/ir/builder.js';
import { builder, image, register, slice } from '../../ir/support.js';
import { emit, emittedFormals, execute } from '../../emitters/c/support.js';

const i32 = integer(32),
  i64 = integer(64);
const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi'),
  rsi = register('rsi', 64, 0, 'replace_root', 'x86_64:rsi'),
  rdx = register('rdx', 64, 0, 'replace_root', 'x86_64:rdx'),
  rcx = register('rcx', 64, 0, 'replace_root', 'x86_64:rcx');
const options = { image_id: image, slice_id: slice, revision: 5 };

function analyze(ssa: SSAForm, extra: Partial<TypeRecoveryOptions> = {}): TypeRecoveryResult {
  const local = recoverTypes(ssa, sysvAMD64Abi, createOperationContext(), { ...options, ...extra });
  assert.equal(local.state, 'complete');
  return recoverPointerEvidence(ssa, local, createOperationContext(), {
    slice_id: slice,
    revision: options.revision,
    layout: sysvAMD64Abi.layout,
  });
}
function finish(b: IRBuilder, entry: BlockBuilder, n = 1): SSAForm {
  const result = constructSSA(
    b.finish(
      entry,
      Array.from({ length: n }, () => i64),
    ),
  );
  assert.equal(result.state, 'complete');
  return result.value as SSAForm;
}
/** The rule that proved `value` holds an address, or undefined. */
function pointerRule(types: TypeRecoveryResult, value: Value): string | undefined {
  const association = types.associations.find(
    (item) =>
      item.subject_id === value.id &&
      item.value_offset_bits === 0 &&
      item.width_bits === 64 &&
      types.evidence.some(
        (proof) =>
          item.evidence_ids.includes(proof.id) &&
          proof.origin.kind === 'analysis' &&
          proof.origin.analyzer === 'pointer-evidence',
      ),
  );
  const proof = types.evidence.find((item) => association?.evidence_ids.includes(item.id));
  return proof?.origin.kind === 'analysis' ? proof.origin.rule : undefined;
}

test('pointer ± integer derives a pointer; pointer - pointer and integer arithmetic do not', () => {
  const b = builder('pointer-derivation'),
    entry = b.block('entry');
  const p = entry.readRegister(rdi),
    n = entry.readRegister(rsi);
  entry.load(i32, p);
  const plus = entry.int('add', p, entry.constant(i64, 8n));
  const minus = entry.int('sub', p, n);
  const distance = entry.int('sub', p, plus);
  const count = entry.int('add', n, entry.constant(i64, 5n));
  entry.return([plus, minus, distance, count]);
  const types = analyze(finish(b, entry, 4));
  assert.equal(pointerRule(types, p), 'dereferenced address');
  assert.equal(pointerRule(types, plus), 'pointer arithmetic');
  assert.equal(pointerRule(types, minus), 'pointer arithmetic');
  assert.equal(pointerRule(types, distance), undefined, 'a pointer difference is an integer');
  assert.equal(pointerRule(types, n), undefined);
  assert.equal(pointerRule(types, count), undefined);
  // `p + 8` steps whole elements of the observed 32-bit view: same element type.
  const element = types.associations.find(
    (item) =>
      item.subject_id === plus.id &&
      types.types.some(
        (record) =>
          record.id === item.type_id &&
          record.definition.kind === 'pointer' &&
          types.types.some(
            (target) =>
              record.definition.kind === 'pointer' &&
              target.id === record.definition.to &&
              target.definition.kind === 'integer' &&
              target.definition.bits === 32,
          ),
      ),
  );
  assert.ok(element, 'p + 8 inherits the 32-bit element pointer');
});

test('comparison with a pointer proves an address; two integers compared prove nothing', () => {
  const b = builder('pointer-compare'),
    entry = b.block('entry');
  const p = entry.readRegister(rdi),
    a = entry.readRegister(rsi),
    c = entry.readRegister(rdx),
    end = entry.readRegister(rcx);
  entry.load(integer(8), p);
  const integers = entry.compare('ult', a, c);
  const bounded = entry.compare('ult', p, end);
  const zero = entry.compare('eq', p, entry.constant(i64, 0n));
  entry.return([
    entry.cast('zero_extend', i64, integers),
    entry.cast('zero_extend', i64, bounded),
    entry.cast('zero_extend', i64, zero),
  ]);
  const types = analyze(finish(b, entry, 3));
  assert.equal(pointerRule(types, end), 'compared with a pointer');
  assert.equal(pointerRule(types, a), undefined);
  assert.equal(pointerRule(types, c), undefined);
});

test('a declared pointer parameter makes the caller argument and its derivations pointers', () => {
  const abi = sysvAMD64Abi,
    target = { image_id: image, space: 'va' as const, value: 0x2000n };
  const b = builder('pointer-prototype-argument'),
    entry = b.block('entry');
  const table = entry.readRegister(rsi);
  const argument = entry.load(i64, table);
  entry.writeRegister(rdi, argument);
  entry.call({ kind: 'direct', address: target }, [], [], abi.unknown_call_clobbers);
  const next = entry.int('add', argument, entry.constant(i64, 16n));
  entry.return([next]);
  const ssa = finish(b, entry);
  const call = ssa.blocks
    .flatMap((block) => block.instructions)
    .find((node) => node.kind === 'call')!;
  const voidId = entityIdentity(slice, 'source-type', 'void'),
    pointerId = entityIdentity(slice, 'source-type', 'void-pointer'),
    intId = entityIdentity(slice, 'source-type', 'int');
  const records: SuppliedTypeRecord[] = [
    [voidId, { kind: 'void' as const }],
    [pointerId, { kind: 'pointer' as const, bits: 64, to: voidId }],
    [intId, { kind: 'integer' as const, bits: 32, signed: true }],
  ].map(([id, definition]) => ({
    id: id as string,
    definition: definition as SuppliedTypeRecord['definition'],
    source: 'library',
    status: 'established',
    evidence_ids: [],
  }));
  const signature: Signature = {
    abi: abi.id,
    return_type: intId,
    parameters: [{ id: entityIdentity(slice, 'parameter', 0), name: null, type_id: pointerId }],
    variadic: false,
    noreturn: false,
    evidence_ids: [],
  };
  const contract: AbiSignature = {
    returns: { kind: 'integer', bits: 32, signed: true },
    parameters: [{ kind: 'pointer' }],
    variadic: false,
    fixed_parameter_count: 1,
  };
  const types = analyze(ssa, {
    types: records,
    signatures: [
      {
        id: 'library-free',
        subject_id: call.id,
        signature,
        source: 'library',
        status: 'established',
        evidence_ids: [],
      },
    ],
    contracts: [
      {
        id: 'library-free',
        target: { kind: 'address', address: target },
        signature: contract,
        evidence_ids: [],
      },
    ],
  });
  assert.equal(pointerRule(types, argument), 'joined pointer values');
  assert.equal(pointerRule(types, next), 'pointer arithmetic');
  assert.equal(pointerRule(types, table), 'dereferenced address');
});

/** `0 | v` (AArch64 `mov`) split into two 32-bit cells of rdi, then a call whose
 * declaration types its first parameter as `parameter`. */
function cellSplitArgument(parameter: 'char-pointer' | 'integer') {
  const abi = sysvAMD64Abi,
    target = { image_id: image, space: 'va' as const, value: 0x2000n };
  const low = register('edi', 32, 0, 'preserve_other_bits', 'x86_64:rdi'),
    high = register('rdi_high', 32, 32, 'preserve_other_bits', 'x86_64:rdi');
  const b = builder(`pointer-cell-split-${parameter}`),
    entry = b.block('entry');
  const value = entry.readRegister(rsi);
  const copy = entry.int('or', entry.constant(i64, 0n), value);
  entry.writeRegister(low, entry.extract(copy, 0, 32));
  entry.writeRegister(high, entry.extract(copy, 32, 32));
  entry.call({ kind: 'direct', address: target }, [], [], abi.unknown_call_clobbers);
  entry.return([entry.constant(i64, 0n)]);
  const ssa = finish(b, entry);
  const call = ssa.blocks
    .flatMap((block) => block.instructions)
    .find((node) => node.kind === 'call')!;
  // The call reads rdi as two exact cells, never as one 64-bit value.
  assert.deepEqual(
    call.kind === 'call'
      ? call.register_inputs
          .filter((binding) => binding.register.root === 'x86_64:rdi')
          .map((binding) => binding.register.width_bits)
      : [],
    [32, 32],
  );
  const charId = entityIdentity(slice, 'source-type', 'char'),
    pointerId = entityIdentity(slice, 'source-type', 'char-pointer'),
    longId = entityIdentity(slice, 'source-type', 'long');
  const records: SuppliedTypeRecord[] = [
    [charId, { kind: 'integer' as const, bits: 8, signed: true }],
    [pointerId, { kind: 'pointer' as const, bits: 64, to: charId }],
    [longId, { kind: 'integer' as const, bits: 64, signed: true }],
  ].map(([id, definition]) => ({
    id: id as string,
    definition: definition as SuppliedTypeRecord['definition'],
    source: 'library',
    status: 'established',
    evidence_ids: [],
  }));
  const declared = parameter === 'char-pointer' ? pointerId : longId;
  const signature: Signature = {
    abi: abi.id,
    return_type: longId,
    parameters: [{ id: entityIdentity(slice, 'parameter', 0), name: null, type_id: declared }],
    variadic: false,
    noreturn: false,
    evidence_ids: [],
  };
  const contract: AbiSignature = {
    returns: { kind: 'integer', bits: 64, signed: true },
    parameters: [
      parameter === 'char-pointer'
        ? { kind: 'pointer' }
        : { kind: 'integer', bits: 64, signed: true },
    ],
    variadic: false,
    fixed_parameter_count: 1,
  };
  const types = analyze(ssa, {
    types: records,
    signatures: [
      {
        id: 'library-callee',
        subject_id: call.id,
        signature,
        source: 'library',
        status: 'established',
        evidence_ids: [],
      },
    ],
    contracts: [
      {
        id: 'library-callee',
        target: { kind: 'address', address: target },
        signature: contract,
        evidence_ids: [],
      },
    ],
  });
  return { types, value, copy, pointerId };
}

test('a declared pointer bound to split register cells types the whole value and its copies', () => {
  const { types, value, copy, pointerId } = cellSplitArgument('char-pointer');
  assert.equal(pointerRule(types, copy), 'joined pointer values');
  assert.equal(pointerRule(types, value), 'joined pointer values');
  for (const subject of [copy, value])
    assert.ok(
      types.associations.some(
        (item) =>
          item.subject_id === subject.id && item.type_id === pointerId && item.width_bits === 64,
      ),
      'the reassembled value keeps the declared char pointer type',
    );
});

test('an integer split across register cells stays an integer', () => {
  const { types, value, copy } = cellSplitArgument('integer');
  assert.equal(pointerRule(types, copy), undefined);
  assert.equal(pointerRule(types, value), undefined);
});

for (const language of ['c-like', 'python-like'] as const)
  test(`${language}: dereference beats an integer use; the integer use converts explicitly`, () => {
    const b = builder(`pointer-integer-use-${language}`),
      entry = b.block('entry');
    const p = entry.readRegister(rdi);
    const loaded = entry.load(i32, p);
    entry.store(entry.int('add', p, entry.constant(i64, 4n)), loaded);
    // An unsigned machine use of the same bits (`p >> 4`).
    const shifted = entry.int('lshr', p, entry.constant(i64, 4n));
    entry.return([shifted]);
    const ssa = finish(b, entry);
    const types = analyze(ssa);
    assert.equal(pointerRule(types, p), 'dereferenced address');
    const output = emit(
      ssa,
      { types, source: { abi: sysvAMD64Abi, callees: [], addresses: [] } },
      language,
    );
    const formals = emittedFormals(output.emission).filter((formal) => formal.name !== 'entry_sp');
    assert.equal(formals.length, 1);
    const declaration = expandEmission(output.emission).mappings.find(
      (mapping) => mapping.statement_id === formals[0]!.statement_id,
    )!;
    assert.match(
      output.emission.text.slice(declaration.start, declaration.end),
      language === 'c-like' ? /\*/ : /pointer\[/,
    );
    if (language === 'c-like') assert.match(output.emission.text, /\(uintptr_t\)/);
    const memory = new Map([
      [0x3000n, 0x11],
      [0x3001n, 0x22],
      [0x3002n, 0x33],
      [0x3003n, 0x44],
      ...[0x3004n, 0x3005n, 0x3006n, 0x3007n].map((address) => [address, 0] as [bigint, number]),
    ]);
    const observed = execute(
      output.emission,
      new Map([[formals[0]!.statement_id, 0x3000n]]),
      memory,
    );
    assert.deepEqual(observed.values, [0x300n]);
    assert.deepEqual(
      [0x3004n, 0x3005n, 0x3006n, 0x3007n].map((address) => memory.get(address)),
      [0x11, 0x22, 0x33, 0x44],
    );
  });

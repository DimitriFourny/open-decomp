import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StoredDecompilation } from '../../src/project/cache/index.js';
import { emittedFormals, execute, type EmittedFormal, type SourceCallOracle } from '../emitters/c/support.js';
import { project } from '../service/analysis/support.js';
import { createOperationContext, entityIdentity, expandEmission } from '../../src/core/index.js';
import { sysvAMD64Abi } from '../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { recoverTypes } from '../../src/analysis/types/index.js';
import { integer, type SSAForm } from '../../src/ir/index.js';
import { builder, image, register, slice } from '../ir/support.js';
import { emit } from '../emitters/c/support.js';
import { checkExecutableSource } from './source-executable.js';
import { checkSourceNameConflicts } from './source-names-fixture.js';

type StoredEmission = StoredDecompilation['data']['emission'];

// Independent source formulas and declarations are fixtures/source/corpus.c.
// Neither source names nor prototypes are supplied to public decompilation.
const fixtures = [
  { kind: 'arithmetic', address: 0x100000574n, count: 2 },
  { kind: 'loop', address: 0x100000594n, count: 2 },
  { kind: 'width', address: 0x100000630n, count: 3 },
  { kind: 'stack', address: 0x100000640n, count: 10 },
  { kind: 'callback', address: 0x100000608n, count: 2 },
] as const;

test('public semantic identifiers expose proven roles without changing source-backed behavior in either dialect', async (t) => {
  const p = await project(t, 'macho-arm64-symbols');
  const inputIdentities = new Map<bigint, readonly string[]>();
  for (const fixture of fixtures) {
    const fn = p.functions.find((candidate) => candidate.entry.value === fixture.address);
    assert.ok(fn);
    for (const emitter of ['c-like', 'python-like'] as const) {
      const response = await p.decompile(fn.id, { options: { emitter } });
      const result: StoredDecompilation = p.payload(response.result).result;
      const emission: StoredEmission = result.data.emission;
      const declared: readonly EmittedFormal[] = emittedFormals(emission);
      const formals: readonly EmittedFormal[] = declared.filter((formal) => formal.name !== 'entry_sp');
      const stack = declared.find((formal) => formal.name === 'entry_sp');
      assert.equal(formals.length, fixture.count);
      assert.equal(new Set(declared.map((formal) => formal.name)).size, declared.length);
      const previous = inputIdentities.get(fixture.address), identities = declared.map((formal) => formal.statement_id);
      if (previous) assert.deepEqual(identities, previous, 'dialects preserve the same input identities');
      else inputIdentities.set(fixture.address, identities);
      if (fixture.kind === 'loop') {
        assert.ok(formals.every((formal) => !/^arg\d+$/.test(formal.name)),
          'the actual memory base and consumed loop count have proven roles');
      } else if (fixture.kind === 'callback') {
        assert.doesNotMatch(formals[0]!.name, /^arg\d+$/, 'the actual indirect call target has a callable role');
      } else if (fixture.kind === 'width') {
        assert.doesNotMatch(formals[2]!.name, /^arg\d+$/, 'the actual shift operand has a proven role');
      } else {
        assert.ok(formals.every((formal) => /^arg\d+$/.test(formal.name)),
          'arbitrary arithmetic/weighted inputs have no proven semantic author names');
      }
      const inputs = (values: readonly bigint[]): Map<string, bigint> => {
        const bound = new Map(formals.map((formal, index): [string, bigint] => [formal.statement_id, values[index]!]));
        if (stack) bound.set(stack.statement_id, 0x10000n);
        return bound;
      };
      if (fixture.kind === 'loop') {
        for (const values of [[], [1], [1, 2, 3, 4], [0xffffffff, 1, 5]]) {
          const memory = new Map<bigint, number>();
          values.forEach((value, index) => {
            for (let byte = 0; byte < 4; byte++)
              memory.set(0x2000n + BigInt(index * 4 + byte), (value >>> (byte * 8)) & 255);
          });
          const observation = execute(emission, inputs([0x2000n, BigInt(values.length)]), memory);
          assert.deepEqual(observation.values, [BigInt.asUintN(32, values.reduce((sum, value) => sum + BigInt(value), 0n))]);
          assert.equal(observation.events.filter((event) => event === 'load').length, values.length);
        }
      } else if (fixture.kind === 'callback') {
        for (const value of [0n, 35n, 0x80000000n, 0xffffffffn]) {
          const memory = new Map<bigint, number>();
          for (let offset = -256; offset < 32; offset++) memory.set(0x10000n + BigInt(offset), 0xa5);
          const callback: SourceCallOracle = (arguments_, context) => {
            assert.equal(context.arguments_complete, false);
            assert.deepEqual(arguments_.map((argument) => BigInt.asUintN(32, argument)), [value]);
            return BigInt.asUintN(32, value * 3n + 7n);
          };
          const observation = execute(emission, inputs([0x6000n, value]), memory, 0n, new Map(),
            new Map([['non-argument entry register', 0x5a5a5a5a5a5a5a5an]]), new Map([['0x6000', callback]]));
          assert.deepEqual(observation.values, [BigInt.asUintN(32, value * 3n + 8n)]);
          assert.equal(observation.calls.length, 1);
        }
      } else if (fixture.kind === 'stack') {
        for (const values of [Array.from({ length: 10 }, (_, index) => BigInt(index + 1)), Array<bigint>(10).fill(0xffffffffffffffffn)]) {
          const expected = BigInt.asUintN(64, values.reduce((sum, value, index) => sum + BigInt(index + 1) * value, 0n));
          assert.deepEqual(execute(emission, inputs(values)).values, [expected]);
        }
      } else if (fixture.kind === 'width') {
        for (const [a, b, shift] of [[0xffffffffn, 1n, 0n], [0xffffffffn, 0xffffffffn, 32n], [1n, 3n, 64n]]) {
          const expected = (BigInt.asUintN(32, a!) + BigInt.asUintN(32, b!)) >> (shift! & 63n);
          assert.deepEqual(execute(emission, inputs([a!, b!, shift!])).values, [expected]);
        }
      } else {
        for (const [a, b] of [[0n, 1n], [0xffffffffn, 3n], [123456789n, 987654321n]]) {
          const expected = BigInt.asUintN(32, a! + 3n * b!) ^ 0x55n;
          assert.deepEqual(execute(emission, inputs([a!, b!])).values, [expected]);
        }
      }
    }
  }
});

test('conflicting callable/data roles stay neutral and explicit display names survive source value origins', checkSourceNameConflicts);

test('cross-dialect keywords, helper names and duplicate user display names cannot shadow real declarations', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'open-decomp-user-names-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const b = builder('source-name-reserved'), entry = b.block('entry'), u64 = integer(64);
  const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');
  const rsi = register('rsi', 64, 0, 'replace_root', 'x86_64:rsi');
  entry.return([entry.int('lshr', entry.readRegister(rdi), entry.readRegister(rsi))]);
  const constructed = constructSSA(b.finish(entry, [u64]));
  assert.equal(constructed.value.form, 'ssa');
  const ir = constructed.value as SSAForm;
  const physical = ir.register_states.find((state) => state.block === ir.entry)!.entry;
  const first = physical.find((binding) => binding.register.root === rdi.root)!.value.id;
  const second = physical.find((binding) => binding.register.root === rsi.root)!.value.id;
  for (const name of ['for', 'async', 'bv_lshr', 'transfer_0', 'stack_frame', 'entry_sp', 'true', 'repeated'])
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(ir, { source: { abi: sysvAMD64Abi, callees: [], addresses: [] },
        names: [{ entity_id: first, name }, { entity_id: second, name }] }, language);
      const formals = emittedFormals(output.emission);
      assert.equal(formals.length, 2);
      assert.notEqual(formals[0]!.name, formals[1]!.name);
      if (name !== 'repeated') assert.ok(formals.every((formal) => formal.name !== name));
      const observation = execute(output.emission,
        new Map([[formals[0]!.statement_id, 0x8000000000000000n], [formals[1]!.statement_id, 63n]]));
      assert.deepEqual(observation.values, [1n]);
      checkExecutableSource(output.emission, [{
        arguments: [0x8000000000000000n, 63n], expected: 1n,
      }], directory);
    }
});

test('supplied prototype names outrank inferred operation roles and user display overrides remain authoritative', () => {
  const b = builder('source-prototype-role-names'), entry = b.block('entry'), u64 = integer(64);
  const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');
  const rsi = register('rsi', 64, 0, 'replace_root', 'x86_64:rsi');
  const rax = register('rax', 64, 0, 'replace_root', 'x86_64:rax');
  entry.writeRegister(rax, entry.int('lshr', entry.readRegister(rdi), entry.readRegister(rsi)));
  entry.return();
  const constructed = constructSSA(b.finish(entry));
  assert.equal(constructed.value.form, 'ssa');
  const ir = constructed.value as SSAForm;
  const scalar = entityIdentity(slice, 'source-name-type', 'u64');
  const types = recoverTypes(ir, sysvAMD64Abi, createOperationContext(), {
    image_id: image, slice_id: slice, revision: 0,
    types: [{ id: scalar, definition: { kind: 'integer', bits: 64, signed: false },
      source: 'user', status: 'asserted', evidence_ids: [] }],
    signatures: [{
      id: entityIdentity(slice, 'source-name-signature', ir.id), subject_id: ir.id,
      source: 'user', status: 'asserted', evidence_ids: [],
      signature: { abi: sysvAMD64Abi.id, return_type: scalar,
        parameters: ['original_value', 'original_amount'].map((name, index) => ({
          id: entityIdentity(slice, 'source-name-parameter', index), name, type_id: scalar,
        })),
        variadic: false, noreturn: false, evidence_ids: [],
      },
    }],
  });
  const first = ir.register_states.find((state) => state.block === ir.entry)!.entry
    .find((binding) => binding.register.root === rdi.root)!.value.id;
  for (const language of ['c-like', 'python-like'] as const)
    for (const override of [false, true]) {
      const output = emit(ir, { types, source: { abi: sysvAMD64Abi, callees: [], addresses: [] },
        names: override ? [{ entity_id: first, name: 'user_value' }] : [] }, language);
      const formals = emittedFormals(output.emission);
      assert.deepEqual(formals.map((formal) => formal.name),
        [override ? 'user_value' : 'original_value', 'original_amount']);
      assert.deepEqual(execute(output.emission,
        new Map([[formals[0]!.statement_id, 0x8000000000000000n], [formals[1]!.statement_id, 63n]])).values, [1n]);
    }
});

test('an explicit entry stack input keeps its identity when an ordinary source annotation uses its reserved name', () => {
  const b = builder('source-reserved-entry-input'), entry = b.block('entry'), u64 = integer(64), u32 = integer(32);
  const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');
  const argument = entry.readRegister(rdi);
  const incoming = entry.int('add', entry.readRegister(sysvAMD64Abi.stack_pointer), entry.constant(u64, 9n));
  entry.return([entry.int('add', argument, entry.cast('zero_extend', u64, entry.load(u32, incoming)))]);
  const constructed = constructSSA(b.finish(entry, [u64]));
  assert.equal(constructed.value.form, 'ssa');
  const ir = constructed.value as SSAForm;
  const types = recoverTypes(ir, sysvAMD64Abi, createOperationContext(), {
    image_id: image, slice_id: slice, revision: 0,
  });
  const original = ir.register_states.find((state) => state.block === ir.entry)!.entry
    .find((binding) => binding.register.root === rdi.root)!.value.id;
  for (const language of ['c-like', 'python-like'] as const) {
    const output = emit(ir, { types, source: { abi: sysvAMD64Abi, callees: [], addresses: [] },
      names: [{ entity_id: original, name: 'entry_sp' }] }, language);
    const formals = emittedFormals(output.emission);
    const storage = formals.find((formal) => formal.name === 'entry_sp');
    const source = formals.find((formal) => formal.name !== 'entry_sp');
    assert.ok(storage); assert.ok(source);
    assert.notEqual(source.name, storage.name);
    const memory = new Map<bigint, number>([[0x9009n, 0xef], [0x900an, 0xcd], [0x900bn, 0xab], [0x900cn, 0x89]]);
    assert.deepEqual(execute(output.emission,
      new Map([[source.statement_id, 7n], [storage.statement_id, 0x9000n]]), memory).values, [0x89abcdf6n]);
  }
});

test('dead pure computations do not invent a role for otherwise unclassified arithmetic inputs', () => {
  const b = builder('source-dead-role-evidence'), entry = b.block('entry'), u64 = integer(64);
  const left = entry.readRegister(register('rdi', 64, 0, 'replace_root', 'x86_64:rdi'));
  const right = entry.readRegister(register('rsi', 64, 0, 'replace_root', 'x86_64:rsi'));
  entry.int('lshr', left, right);
  entry.return([entry.int('add', left, right)]);
  const constructed = constructSSA(b.finish(entry, [u64]));
  assert.equal(constructed.value.form, 'ssa');
  for (const language of ['c-like', 'python-like'] as const) {
    const output = emit(constructed.value as SSAForm, { source: { abi: sysvAMD64Abi, callees: [], addresses: [] } }, language);
    const formals = emittedFormals(output.emission);
    assert.ok(formals.every((formal) => /^arg\d+$/.test(formal.name)));
    assert.deepEqual(execute(output.emission,
      new Map([[formals[0]!.statement_id, 0xffffffffffffffffn], [formals[1]!.statement_id, 63n]])).values, [62n]);
  }
});

test('established field names reach loaded scalar locals without inventing a complete record layout', () => {
  const b = builder('source-field-local-name'), entry = b.block('entry'), u64 = integer(64);
  const pointer = entry.readRegister(register('rdi', 64, 0, 'replace_root', 'x86_64:rdi'));
  const address = entry.int('add', pointer, entry.constant(u64, 12n));
  entry.return([entry.int('add', entry.load(u64, address), entry.constant(u64, 1n))]);
  const constructed = constructSSA(b.finish(entry, [u64]));
  assert.equal(constructed.value.form, 'ssa');
  const ir = constructed.value as SSAForm;
  const original = ir.register_states.find((state) => state.block === ir.entry)!.entry
    .find((binding) => binding.register.root === 'x86_64:rdi')!.value.id;
  const evidence = 'evidence_' + 'd'.repeat(64);
  const types = recoverTypes(ir, sysvAMD64Abi, createOperationContext(), {
    image_id: image, slice_id: slice, revision: 0,
    types: [
      { id: 'source-name-word', definition: { kind: 'integer', bits: 64, signed: false },
        source: 'debug', status: 'established', evidence_ids: [evidence] },
      { id: 'source-name-record', definition: { kind: 'structure', size: null, alignment: null,
        fields: [{ id: 'source-balance-field', name: 'balance', offset: 12n, type_id: 'source-name-word' }] },
        source: 'debug', status: 'established', evidence_ids: [evidence] },
      { id: 'source-name-pointer', definition: { kind: 'pointer', bits: 64, to: 'source-name-record' },
        source: 'debug', status: 'established', evidence_ids: [evidence] },
    ],
    bindings: [{ subject_id: original, type_id: 'source-name-pointer',
      source: 'debug', status: 'established', evidence_ids: [evidence] }],
  });
  for (const language of ['c-like', 'python-like'] as const) {
    const output = emit(ir, { types, source: { abi: sysvAMD64Abi, callees: [], addresses: [] } }, language);
    assert.ok(output.identifiers.some((identifier) => identifier.identifier === 'balance'),
      'the supplied field name, not a guessed author variable name, describes this exact load');
    assert.ok(expandEmission(output.emission).mappings.some((mapping) => mapping.semantic_ids.includes('source-balance-field')));
    const parameter = emittedFormals(output.emission)[0]!;
    for (const value of [0n, 0x8000000000000000n, 0xffffffffffffffffn]) {
      const memory = new Map<bigint, number>();
      for (let byte = 0; byte < 8; byte++) memory.set(0x300cn + BigInt(byte), Number((value >> BigInt(byte * 8)) & 255n));
      assert.deepEqual(execute(output.emission, new Map([[parameter.statement_id, 0x3000n]]), memory).values,
        [BigInt.asUintN(64, value + 1n)]);
    }
  }
});

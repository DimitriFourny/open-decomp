import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, expandEmission } from '../../../src/core/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { recoverTypes, type TypeRecoveryOptions } from '../../../src/analysis/types/index.js';
import { buildStringIndex } from '../../../src/analysis/strings/index.js';
import { recoverDataAddress } from '../../../src/analysis/strings/source-data.js';
import { MachOLoader } from '../../../src/loaders/macho/index.js';
import { loadNavigationFixture } from '../../analysis/navigation-fixture.js';
import { integer, type SSAForm } from '../../../src/ir/index.js';
import { builder, image, register, slice } from '../../ir/support.js';
import { emit, execute } from './support.js';

const i32 = integer(32), i64 = integer(64);
const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');

for (const language of ['c-like', 'python-like'] as const)
  test(`${language} exact declared field evidence reaches pointer input, signed scalar result and access expression`, () => {
    const b = builder('source-declared-field-types'), block = b.block('entry');
    const pointer = block.readRegister(rdi);
    const address = block.int('add', pointer, block.constant(i64, 12n));
    const loaded = block.load(i32, address);
    block.return([loaded]);
    const input = constructSSA(b.finish(block, [i32])).value;
    assert.equal(input.form, 'ssa');
    const ssa = input as SSAForm;
    const binding = ssa.register_states.find((state) => state.block === ssa.entry)!.entry
      .find((entry) => entry.register.root === rdi.root)!;
    assert.ok(binding);
    const evidence = 'evidence_' + 'd'.repeat(64);
    const options: TypeRecoveryOptions = {
      slice_id: slice, image_id: image, revision: 1,
      types: [
        { id: 'signed-word', definition: { kind: 'integer', bits: 32, signed: true },
          source: 'debug', status: 'established', evidence_ids: [evidence] },
        { id: 'partial-record', definition: { kind: 'structure', size: null, alignment: null,
          fields: [{ id: 'balance-field', name: 'balance', offset: 12n, type_id: 'signed-word' }] },
          source: 'debug', status: 'established', evidence_ids: [evidence] },
        { id: 'record-pointer', definition: { kind: 'pointer', bits: 64, to: 'partial-record' },
          source: 'debug', status: 'established', evidence_ids: [evidence] },
      ],
      bindings: [{ subject_id: binding.value.id, type_id: 'record-pointer',
        source: 'debug', status: 'established', evidence_ids: [evidence] }],
    };
    const types = recoverTypes(ssa, sysvAMD64Abi, createOperationContext(), options);
    assert.equal(types.state, 'complete');
    const output = emit(ssa, { types,
      source: { abi: sysvAMD64Abi, callees: [], addresses: [] } }, language);
    assert.deepEqual(binding.value.type, i64, 'source pointer evidence must not rewrite machine storage type');
    const header = output.emission.text.split('\n').find((line) =>
      language === 'c-like' ? line.includes(' fn_') : line.startsWith('def '));
    assert.ok(header);
    assert.match(header, language === 'c-like' ? /^int32_t / : /-> int32_t:/);
    assert.match(header, language === 'c-like' ? /\*\s+[A-Za-z_]\w*/ : /:\s*pointer\[/);
    assert.ok(output.emission.helpers.some((helper) => helper.name === 'field_view'));
    assert.ok(expandEmission(output.emission).mappings.some((mapping) =>
      mapping.semantic_ids.includes('balance-field')), 'preserve exact declared field identity');
    assert.ok(types.types.some((type) => type.id === 'partial-record' &&
      type.definition.kind === 'structure' && type.definition.size === null));
    const parameter = expandEmission(output.emission).mappings.find((mapping) =>
      mapping.semantic_ids.includes(binding.value.id));
    assert.ok(parameter);
    for (const bits of [0n, 0x7fffffffn, 0x80000000n, 0xffffffffn]) {
      const memory = new Map<bigint, number>();
      for (let byte = 0; byte < 4; byte++) memory.set(0x300cn + BigInt(byte), Number((bits >> BigInt(8 * byte)) & 255n));
      const observed = execute(output.emission, new Map(parameter.semantic_ids.map((id) => [id, 0x3000n])), memory);
      assert.equal(observed.values.length, 1);
      assert.equal(BigInt.asUintN(32, observed.values[0]!), bits);
      assert.deepEqual(observed.events, ['load']);
    }
    const conflicting = recoverTypes(ssa, sysvAMD64Abi, createOperationContext(), {
      ...options,
      types: [...options.types!, { id: 'unsigned-address', definition: { kind: 'integer', bits: 64, signed: false },
        source: 'debug', status: 'established', evidence_ids: [evidence] }],
      bindings: [...options.bindings!, { subject_id: binding.value.id, type_id: 'unsigned-address',
        source: 'debug', status: 'established', evidence_ids: [evidence] }],
    });
    assert.ok(conflicting.conflicts.some((conflict) => conflict.subject_id === binding.value.id));
    const ambiguous = emit(ssa, { types: conflicting,
      source: { abi: sysvAMD64Abi, callees: [], addresses: [] } }, language);
    const ambiguousHeader = ambiguous.emission.text.split('\n').find((line) =>
      language === 'c-like' ? line.includes(' fn_') : line.startsWith('def '))!;
    assert.match(ambiguousHeader, language === 'c-like' ? /uint64_t\s+[A-Za-z_]\w*/ : /:\s*uint64_t/);
    assert.equal(ambiguous.emission.helpers.some((helper) => helper.name === 'field_view'), false);
    assert.equal(expandEmission(ambiguous.emission).mappings.some((mapping) => mapping.semantic_ids.includes('balance-field')), false);
    const hypothesis = recoverTypes(ssa, sysvAMD64Abi, createOperationContext(), {
      ...options, bindings: [{ subject_id: binding.value.id, type_id: 'record-pointer',
        source: 'llm', status: 'hypothesis', evidence_ids: [evidence] }],
    });
    const hypothetical = emit(ssa, { types: hypothesis,
      source: { abi: sysvAMD64Abi, callees: [], addresses: [] } }, language);
    const hypotheticalHeader = hypothetical.emission.text.split('\n').find((line) =>
      language === 'c-like' ? line.includes(' fn_') : line.startsWith('def '))!;
    assert.match(hypotheticalHeader, language === 'c-like' ? /^uint32_t / : /-> uint32_t:/);
    assert.equal(expandEmission(hypothetical.emission).mappings.some((mapping) => mapping.semantic_ids.includes('balance-field')), false);
  });

for (const language of ['c-like', 'python-like'] as const)
  test(`${language} a signed comparison does not invent declared signed parameter types`, () => {
    const b = builder('signed-operation-is-not-source-intent'), block = b.block('entry');
    const left = block.readRegister(rdi);
    const right = block.readRegister(register('rsi', 64, 0, 'replace_root', 'x86_64:rsi'));
    block.return([block.compare('slt', left, right)]);
    const input = constructSSA(b.finish(block, [integer(1)])).value;
    assert.equal(input.form, 'ssa');
    const ssa = input as SSAForm;
    const types = recoverTypes(ssa, sysvAMD64Abi, createOperationContext(), {
      slice_id: slice, image_id: image, revision: 1,
    });
    const output = emit(ssa, { types,
      source: { abi: sysvAMD64Abi, callees: [], addresses: [] } }, language);
    const header = output.emission.text.split('\n').find((line) =>
      language === 'c-like' ? line.includes(' fn_') : line.startsWith('def '));
    assert.ok(header);
    assert.match(header, language === 'c-like'
      ? /uint64_t\s+[A-Za-z_]\w*, uint64_t\s+[A-Za-z_]\w*/
      : /:\s*uint64_t,\s*[A-Za-z_]\w*:\s*uint64_t/);
    const entryBindings = ssa.register_states.find((state) => state.block === ssa.entry)!.entry;
    const parameters = [rdi.root, 'x86_64:rsi'].map((root) => {
      const id = entryBindings.find((binding) => binding.register.root === root)!.value.id;
      const mapping = expandEmission(output.emission).mappings.find((entry) => entry.semantic_ids.includes(id));
      assert.ok(mapping);
      return mapping;
    });
    for (const [a, b] of [[0x8000000000000000n, 0n], [0n, 0xffffffffffffffffn],
      [0x7fffffffffffffffn, 0x7fffffffffffffffn]] as const) {
      const inputs = new Map<string, bigint>();
      for (const [index, value] of [a, b].entries())
        for (const id of parameters[index]!.semantic_ids) inputs.set(id, value);
      assert.deepEqual(execute(output.emission, inputs).values,
        [BigInt.asIntN(64, a) < BigInt.asIntN(64, b) ? 1n : 0n]);
    }
  });

for (const language of ['c-like', 'python-like'] as const)
  test(`${language} declared array stride reaches source access without inventing an element count`, () => {
    const b = builder('source-unknown-array-count'), block = b.block('entry');
    const base = block.readRegister(rdi);
    const index = block.readRegister(register('rsi', 64, 0, 'replace_root', 'x86_64:rsi'));
    const scaled = block.int('mul', index, block.constant(i64, 4n));
    const address = block.int('add', block.int('add', base, scaled), block.constant(i64, 8n));
    block.return([block.load(i32, address)]);
    const input = constructSSA(b.finish(block, [i32])).value;
    assert.equal(input.form, 'ssa');
    const ssa = input as SSAForm;
    const binding = ssa.register_states.find((state) => state.block === ssa.entry)!.entry
      .find((entry) => entry.register.root === rdi.root)!;
    const types = recoverTypes(ssa, sysvAMD64Abi, createOperationContext(), {
      slice_id: slice, image_id: image, revision: 1,
      types: [
        { id: 'array-word', definition: { kind: 'integer', bits: 32, signed: false },
          source: 'debug', status: 'established', evidence_ids: [] },
        { id: 'unknown-array', definition: { kind: 'array', element: 'array-word', count: null },
          source: 'debug', status: 'established', evidence_ids: [] },
        { id: 'array-pointer', definition: { kind: 'pointer', bits: 64, to: 'unknown-array' },
          source: 'debug', status: 'established', evidence_ids: [] },
      ],
      bindings: [{ subject_id: binding.value.id, type_id: 'array-pointer',
        source: 'debug', status: 'established', evidence_ids: [] }],
    });
    assert.equal(types.state, 'complete');
    assert.ok(types.shapes.some((shape) => shape.fields.some((field) => field.stride === 4n) &&
      shape.observed_extent === null));
    const output = emit(ssa, { types,
      source: { abi: sysvAMD64Abi, callees: [], addresses: [] } }, language);
    assert.ok(output.emission.helpers.some((helper) => helper.name === 'field_view'));
    const entryBindings = ssa.register_states.find((state) => state.block === ssa.entry)!.entry;
    const parameters = [rdi.root, 'x86_64:rsi'].map((root) => {
      const id = entryBindings.find((binding) => binding.register.root === root)!.value.id;
      const mapping = expandEmission(output.emission).mappings.find((entry) => entry.semantic_ids.includes(id));
      assert.ok(mapping);
      return mapping;
    });
    for (const index of [0n, 1n, 3n, 4n]) {
      const memory = new Map<bigint, number>();
      for (let element = 0; element < 4; element++)
        for (let byte = 0; byte < 4; byte++)
          memory.set(0x4008n + BigInt(element * 4 + byte), byte === 0 ? element + 21 : 0);
      const inputs = new Map<string, bigint>();
      for (const [position, value] of [0x4000n, index].entries())
        for (const id of parameters[position]!.semantic_ids) inputs.set(id, value);
      const observed = execute(output.emission, inputs, memory);
      if (index === 4n) assert.equal(observed.exit, 'fault');
      else assert.deepEqual(observed.values, [index + 21n]);
    }
    assert.ok(types.types.some((type) => type.id === 'unknown-array' &&
      type.definition.kind === 'array' && type.definition.count === null));
  });

for (const language of ['c-like', 'python-like'] as const)
  test(`${language} pointer-valued fields retain full machine address width at source returns`, () => {
    const b = builder('source-pointer-field-result'), block = b.block('entry');
    const base = block.readRegister(rdi);
    block.return([block.load(i64, block.int('add', base, block.constant(i64, 8n)))]);
    const input = constructSSA(b.finish(block, [i64])).value;
    assert.equal(input.form, 'ssa');
    const ssa = input as SSAForm;
    const binding = ssa.register_states.find((state) => state.block === ssa.entry)!.entry
      .find((entry) => entry.register.root === rdi.root)!;
    const types = recoverTypes(ssa, sysvAMD64Abi, createOperationContext(), {
      slice_id: slice, image_id: image, revision: 1,
      types: [
        { id: 'word', definition: { kind: 'integer', bits: 32, signed: false },
          source: 'debug', status: 'established', evidence_ids: [] },
        { id: 'word-pointer', definition: { kind: 'pointer', bits: 64, to: 'word' },
          source: 'debug', status: 'established', evidence_ids: [] },
        { id: 'pointer-record', definition: { kind: 'structure', size: null, alignment: null,
          fields: [{ id: 'data-field', name: 'data', offset: 8n, type_id: 'word-pointer' }] },
          source: 'debug', status: 'established', evidence_ids: [] },
        { id: 'record-pointer', definition: { kind: 'pointer', bits: 64, to: 'pointer-record' },
          source: 'debug', status: 'established', evidence_ids: [] },
      ],
      bindings: [{ subject_id: binding.value.id, type_id: 'record-pointer',
        source: 'debug', status: 'established', evidence_ids: [] }],
    });
    const output = emit(ssa, { types,
      source: { abi: sysvAMD64Abi, callees: [], addresses: [] } }, language);
    const header = output.emission.text.split('\n').find((line) =>
      language === 'c-like' ? line.includes(' fn_') : line.startsWith('def '))!;
    assert.match(header, language === 'c-like' ? /^uint32_t\* / : /-> pointer\[uint32_t\]:/);
    const parameter = expandEmission(output.emission).mappings.find((mapping) =>
      mapping.semantic_ids.includes(binding.value.id))!;
    for (const address of [0n, 0x123456789abcdef0n, 0xffffffffffffffffn]) {
      const memory = new Map<bigint, number>();
      for (let byte = 0; byte < 8; byte++) memory.set(0x5008n + BigInt(byte),
        Number((address >> BigInt(byte * 8)) & 255n));
      const observed = execute(output.emission, new Map(parameter.semantic_ids.map((id) => [id, 0x5000n])), memory);
      assert.deepEqual(observed.values, [address]);
      assert.deepEqual(observed.events, ['load']);
    }
  });

for (const language of ['c-like', 'python-like'] as const)
  test(`${language} a narrow source fragment does not discard observable high machine bits`, () => {
    const b = builder('source-narrow-fragment-full-carrier'), block = b.block('entry');
    block.return([block.readRegister(rdi)]);
    const input = constructSSA(b.finish(block, [i64])).value;
    assert.equal(input.form, 'ssa');
    const ssa = input as SSAForm;
    const binding = ssa.register_states.find((state) => state.block === ssa.entry)!.entry
      .find((entry) => entry.register.root === rdi.root)!;
    const types = recoverTypes(ssa, sysvAMD64Abi, createOperationContext(), {
      slice_id: slice, image_id: image, revision: 1,
      types: [{ id: 'narrow-source', definition: { kind: 'integer', bits: 32, signed: true },
        source: 'debug', status: 'established', evidence_ids: [] }],
      bindings: [{ subject_id: binding.value.id, type_id: 'narrow-source',
        source: 'debug', status: 'established', evidence_ids: [] }],
    });
    const output = emit(ssa, { types,
      source: { abi: sysvAMD64Abi, callees: [], addresses: [] } }, language);
    const header = output.emission.text.split('\n').find((line) =>
      language === 'c-like' ? line.includes(' fn_') : line.startsWith('def '))!;
    assert.match(header, language === 'c-like' ? /^uint64_t / : /-> uint64_t:/);
    const parameter = expandEmission(output.emission).mappings.find((mapping) =>
      mapping.semantic_ids.includes(binding.value.id))!;
    for (const bits of [0x12345678ffffffffn, 0x8000000000000000n, 0xffffffffffffffffn])
      assert.deepEqual(execute(output.emission,
        new Map(parameter.semantic_ids.map((id) => [id, bits]))).values, [bits]);
  });

for (const language of ['c-like', 'python-like'] as const)
  test(`${language} unsigned machine-use constraints do not erase a proven literal pointer`, () => {
    const loadedImage = loadNavigationFixture('fixtures/bin/macho-arm64-symbols', new MachOLoader());
    const string = buildStringIndex({ image: loadedImage, revision: 1 }, createOperationContext())
      .strings.find((string) => string.text === 'open-decomp trusted fixture v1')!;
    assert.ok(string);
    const literal = recoverDataAddress(loadedImage, string.address, createOperationContext())!;
    const b = builder('source-literal-versus-machine-use'), block = b.block('entry');
    const pointer = block.address(string.address);
    block.compare('ult', pointer, block.constant(i64, 0xffffffffffffffffn));
    block.return([pointer]);
    const input = constructSSA(b.finish(block, [i64])).value;
    assert.equal(input.form, 'ssa');
    const ssa = input as SSAForm;
    const types = recoverTypes(ssa, sysvAMD64Abi, createOperationContext(), {
      slice_id: slice, image_id: loadedImage.id, revision: 1,
    });
    const output = emit(ssa, { types,
      source: { abi: sysvAMD64Abi, callees: [], addresses: [literal] } }, language);
    assert.match(output.emission.text, language === 'c-like' ? /^char\s*\*/m : /-> pointer\[char\]:/);
    assert.equal(execute(output.emission).string_result, 'open-decomp trusted fixture v1');
  });

for (const language of ['c-like', 'python-like'] as const)
  test(`${language} typed pointer phi swaps preserve simultaneous raw-bit transfers`, () => {
    const rsi = register('rsi', 64, 0, 'replace_root', 'x86_64:rsi');
    const rdx = register('rdx', 64, 0, 'replace_root', 'x86_64:rdx');
    const b = builder('source-pointer-phi-cycle'), entry = b.block('entry'),
      loop = b.block('loop'), swap = b.block('swap'), done = b.block('done');
    entry.jump(loop);
    loop.branch(loop.compare('eq', loop.readRegister(rdx), loop.constant(i64, 0n)),
      loop.edge(done), loop.edge(swap));
    const left = swap.readRegister(rdi), right = swap.readRegister(rsi);
    swap.writeRegister(rdi, right);
    swap.writeRegister(rsi, left);
    swap.writeRegister(rdx, swap.int('sub', swap.readRegister(rdx), swap.constant(i64, 1n)));
    swap.jump(loop);
    done.return([done.load(integer(8), done.readRegister(rdi))]);
    const input = constructSSA(b.finish(entry, [integer(8)])).value;
    assert.equal(input.form, 'ssa');
    const ssa = input as SSAForm;
    const entryBindings = ssa.register_states.find((state) => state.block === ssa.entry)!.entry;
    const types = recoverTypes(ssa, sysvAMD64Abi, createOperationContext(), {
      slice_id: slice, image_id: image, revision: 1,
      types: [
        { id: 'byte', definition: { kind: 'integer', bits: 8, signed: false },
          source: 'debug', status: 'established', evidence_ids: [] },
        { id: 'byte-pointer', definition: { kind: 'pointer', bits: 64, to: 'byte' },
          source: 'debug', status: 'established', evidence_ids: [] },
      ],
      bindings: [rdi.root, rsi.root].map((root) => ({
        subject_id: entryBindings.find((binding) => binding.register.root === root)!.value.id,
        type_id: 'byte-pointer', source: 'debug', status: 'established', evidence_ids: [],
      })),
    });
    const output = emit(ssa, { types,
      source: { abi: sysvAMD64Abi, callees: [], addresses: [] } }, language);
    const parameters = [rdi.root, rsi.root, rdx.root].map((root) => {
      const id = entryBindings.find((binding) => binding.register.root === root)!.value.id;
      const mapping = expandEmission(output.emission).mappings.find((entry) => entry.semantic_ids.includes(id));
      assert.ok(mapping);
      return mapping;
    });
    for (const count of [0n, 1n, 2n, 3n]) {
      const inputs = new Map<string, bigint>();
      for (const [index, value] of [0x8100n, 0x8200n, count].entries())
        for (const id of parameters[index]!.semantic_ids) inputs.set(id, value);
      const observed = execute(output.emission, inputs, new Map([[0x8100n, 11], [0x8200n, 22]]));
      assert.deepEqual(observed.values, [count % 2n === 0n ? 11n : 22n]);
      assert.deepEqual(observed.events, ['load']);
    }
  });

import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, type AbiLocation, type AbiProfile } from '../../../src/core/index.js';
import { darwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { windowsX64Abi } from '../../../src/abi/windows-x64/index.js';
import { abiObservableRegisterMasks } from '../../../src/analysis/ssa/observable-masks.js';
import { register } from '../../ir/support.js';

for (const abi of [darwinArm64Abi, sysvAMD64Abi, windowsX64Abi])
  test(`${abi.id}: source SSA capabilities retain preservation, SP and native argument/result banks`, () => {
    const masks = abiObservableRegisterMasks(abi, createOperationContext());
    assert.ok(masks.has(abi.stack_pointer.root));
    for (const preserved of abi.preserved) {
      const required = ((1n << BigInt(preserved.width_bits)) - 1n) << BigInt(preserved.offset_bits);
      assert.equal((masks.get(preserved.root) ?? 0n) & required, required, preserved.root);
    }
    if (abi === darwinArm64Abi) {
      for (const root of ['arm64:x0', 'arm64:x1', 'arm64:x7', 'arm64:x8', 'arm64:v0', 'arm64:v3', 'arm64:v7'])
        assert.ok(masks.has(root), root);
      assert.equal(masks.has('arm64:x18'), false, 'A reserved clobber-only register is not an inferred parameter');
      assert.equal(masks.has('arm64:v31'), false);
      for (let index = 8; index < 16; index++)
        assert.equal(masks.get(`arm64:v${index}`), (1n << 64n) - 1n);
      assert.equal(masks.get('arm64:v0'), (1n << 128n) - 1n);
    } else if (abi === sysvAMD64Abi) {
      for (const root of ['x86_64:rax', 'x86_64:rdx', 'x86_64:rdi', 'x86_64:r9', 'x86_64:zmm7'])
        assert.ok(masks.has(root), root);
      assert.equal(masks.has('x86_64:zmm31'), false);
      assert.equal(masks.has('x86_64:st0'), false, 'Unsupported x87 return reconstruction is not a fabricated capacity');
      assert.equal(masks.get('x86_64:zmm7'), (1n << 128n) - 1n);
    } else {
      for (const root of ['x86_64:rax', 'x86_64:rcx', 'x86_64:r9', 'x86_64:zmm3'])
        assert.ok(masks.has(root), root);
      assert.equal(masks.has('x86_64:zmm5'), false);
      for (let index = 6; index < 16; index++)
        assert.equal(masks.get(`x86_64:zmm${index}`), (1n << 128n) - 1n);
    }
  });

test('classifier-only mask discovery includes extended FP, HFA, hidden indirect and implicit boundary storage', () => {
  const physical = (root: string) => register(root, 64, 0, 'replace_root', root);
  const location = (root: string): AbiLocation => ({ kind: 'register', register: physical(root),
    width_bits: 64, value_offset_bits: 0 });
  const empty = darwinArm64Abi.classifyCall({ returns: { kind: 'void' }, parameters: [],
    variadic: false, fixed_parameter_count: 0 });
  const abi: AbiProfile = {
    ...darwinArm64Abi,
    stack_pointer: { ...physical('custom:sp'), role: 'stack_pointer' },
    preserved: [physical('custom:preserved')],
    classifyCall(signature) {
      const returned = signature.returns;
      const returns: AbiLocation[] = [];
      let hidden_result: AbiLocation | null = null;
      if (returned.kind === 'pointer') returns.push(location('custom:pointer-result'));
      else if (returned.kind === 'integer') returns.push(location(`custom:int-${returned.bits}-${returned.signed}`));
      else if (returned.kind === 'float') returns.push(location(`custom:fp-${returned.bits}`));
      else if (returned.kind === 'vector') returns.push(location(`custom:vector-${returned.element}-${returned.element_bits}-${returned.lanes}`));
      else if (returned.kind === 'aggregate') {
        const first = returned.fields[0]?.type;
        if (returned.fields.length === 2 && first?.kind === 'integer') returns.push(location('custom:secondary-result'));
        if (returned.fields.length === 4 && first?.kind === 'float') returns.push(location(`custom:hfa-${first.bits}`));
        if (returned.fields.length === 3 && first?.kind === 'integer') hidden_result = {
          kind: 'indirect', pointer: physical('custom:sret'), size: returned.size, alignment: returned.alignment };
      }
      return { ...empty, returns, hidden_result,
        parameters: (signature.parameters ?? []).map((type, index) => ({ index,
          locations: index >= 2 ? [{ kind: 'stack' as const, offset: BigInt(index * 8), size: 8n,
            alignment: 8, value_offset_bits: 0 }] : type.kind === 'aggregate' && type.fields.length === 3
            ? [{ kind: 'indirect' as const, pointer: physical(`custom:indirect-${index}`), size: type.size, alignment: type.alignment }]
            : [location(`custom:argument-${index}`)] })),
        implicit_register_inputs: signature.parameters === null ? [{ register: physical(signature.variadic
          ? 'custom:vararg' : 'custom:unprototyped'), unsigned_minimum: 0n, unsigned_maximum: 8n,
          purpose: 'vector_argument_register_upper_bound' as const }] : [],
      };
    },
  };
  const masks = abiObservableRegisterMasks(abi, createOperationContext());
  for (const root of ['custom:sp', 'custom:preserved', 'custom:pointer-result', 'custom:argument-0', 'custom:argument-1',
    'custom:secondary-result', 'custom:sret', 'custom:indirect-0', 'custom:indirect-1', 'custom:vararg', 'custom:unprototyped',
    'custom:vector-float-16-8', 'custom:vector-integer-64-2']) assert.ok(masks.has(root), root);
  for (const bits of [16, 32, 64, 80, 128]) {
    assert.ok(masks.has(`custom:fp-${bits}`));
    assert.ok(masks.has(`custom:hfa-${bits}`));
  }
  for (const bits of [1, 8, 16, 32, 64, 128])
    for (const signed of [false, true]) assert.ok(masks.has(`custom:int-${bits}-${signed}`));
});

test('missing preservation capability, cancellation and exhausted work fail closed', () => {
  assert.throws(() => abiObservableRegisterMasks({ ...darwinArm64Abi, preserved: undefined } as unknown as AbiProfile,
    createOperationContext()), { code: 'unavailable_semantics' });
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => abiObservableRegisterMasks(darwinArm64Abi,
    createOperationContext({ signal: controller.signal })), { code: 'cancelled' });
  assert.throws(() => abiObservableRegisterMasks(darwinArm64Abi,
    createOperationContext({ budget: { work: 1 } })), { code: 'resource_limit' });
});

test('ABI masks union physical slices and use location width rather than carrier or value offsets', () => {
  const physical = (root: string, width: number, offset: number) =>
    register(`${root}:${offset}:${width}`, width, offset, 'preserve_other_bits', root, 128);
  const empty = darwinArm64Abi.classifyCall({ returns: { kind: 'void' }, parameters: [],
    variadic: false, fixed_parameter_count: 0 });
  const abi: AbiProfile = {
    ...darwinArm64Abi,
    preserved: [physical('slice:combined', 16, 32), physical('slice:combined', 8, 48)],
    classifyCall(signature) {
      return { ...empty,
        returns: [{ kind: 'register', register: physical('slice:combined', 64, 16),
          width_bits: 8, value_offset_bits: 48 }],
        hidden_result: { kind: 'indirect', pointer: physical('slice:sret', 16, 96),
          size: 24n, alignment: 8 },
        parameters: (signature.parameters ?? []).map((_, index) => ({ index,
          locations: index < 2 ? [{ kind: 'register' as const, register: physical('slice:argument', 64, 32),
            width_bits: 16, value_offset_bits: 0 }] : [{ kind: 'stack' as const, offset: BigInt(index * 8),
            size: 8n, alignment: 8, value_offset_bits: 0 }] })),
        implicit_register_inputs: [{ register: physical('slice:implicit', 8, 8), unsigned_minimum: 0n,
          unsigned_maximum: 8n, purpose: 'vector_argument_register_upper_bound' }],
      };
    },
  };
  const masks = abiObservableRegisterMasks(abi, createOperationContext());
  assert.equal(masks.get('slice:combined'), (0xffffffn << 32n) | (0xffn << 16n));
  assert.equal(masks.get('slice:argument'), 0xffffn << 32n);
  assert.equal(masks.get('slice:sret'), 0xffffn << 96n);
  assert.equal(masks.get('slice:implicit'), 0xffn << 8n);
  assert.equal(masks.get(abi.stack_pointer.root), (1n << 64n) - 1n);
});

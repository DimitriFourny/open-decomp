import assert from 'node:assert/strict';
import test from 'node:test';
import { armPayloadSchema, x86PayloadSchema, flowSchema, registerSchema, instructionSchema } from '../../src/core/decoder.js';

const image = `image_${'a'.repeat(64)}`;
const address = { image_id: image, space: 'va', value: '0x1000' };
const root = { id: 'x86_64:eax', root: 'x86_64:rax', bank: 'integer', offset_bits: 0, width_bits: 32, root_width_bits: 64, role: 'general', write_rule: 'zero_extend_root' };

test('register descriptors preserve subregister behavior and ARM SP/ZR identity', () => {
  assert.equal(registerSchema.parse(root).write_rule, 'zero_extend_root');
  assert.equal(registerSchema.safeParse({ ...root, offset_bits: 40 }).success, false);
  const zero = registerSchema.parse({ ...root, id: 'arm64:wzr', root: 'arm64:xzr', role: 'zero', write_rule: 'discard' });
  const sp = registerSchema.parse({ ...root, id: 'arm64:wsp', root: 'arm64:sp', role: 'stack_pointer' });
  assert.notEqual(zero.role, sp.role);
  assert.equal(registerSchema.safeParse({ ...zero, write_rule: 'zero_extend_root' }).success, false);
});

test('discovery can distinguish unresolved control flow from a proven trap without a lifter', () => {
  assert.equal(flowSchema.parse({ kind: 'unknown', reason: 'unavailable decode feature', may_fallthrough: true }).kind, 'unknown');
  assert.equal(flowSchema.parse({ kind: 'indirect_branch', conditional: false, fallthrough: null }).kind, 'indirect_branch');
  assert.equal(flowSchema.parse({ kind: 'trap', reason: 'decoded unconditional architectural trap', conditional: false, fallthrough: null }).kind, 'trap');
  assert.equal(flowSchema.safeParse({ kind: 'branch', target: null, conditional: false, fallthrough: null }).success, false);
  assert.equal(flowSchema.safeParse({ kind: 'call', target: null, indirect: false, fallthrough: address }).success, false);
  assert.equal(flowSchema.safeParse({ kind: 'unknown', reason: 'no target', may_fallthrough: false, target: address }).success, false);
  assert.equal(flowSchema.safeParse({ kind: 'branch', target: address, conditional: true, fallthrough: null }).success, false);
});

test('ARM canonical identity and fields remain structured independently of display aliases', () => {
  const arm = { architecture: 'arm64', encoding: 'ADD_32_addsub_imm', canonical_encoding: 'ADD_32_addsub_imm', alias: null, word: '0x11000400', fields: { sf: '0x0', imm12: '0x1', Rn: '0x0', Rd: '0x0' }, operands: [{ kind: 'immediate', value: { negative: false, magnitude: '0x1' }, width_bits: 12 }], availability: 'available', behavior: 'instruction', required_features: [], registers: [] };
  assert.equal(armPayloadSchema.parse(arm).fields['imm12'], '0x1');
  assert.equal(armPayloadSchema.safeParse({ ...arm, word: '0x100000000' }).success, false);
  assert.equal(armPayloadSchema.safeParse({ ...arm, operands: ['w0, w0, #1'] }).success, false);
  const instruction = { id: `entity_${'b'.repeat(64)}`, address, bytes: { start: { ...address, space: 'file', value: '0x100' }, size: '0x4' }, size: 4, validity: 'valid', payload: arm, flow: { kind: 'fallthrough', next: { ...address, value: '0x1004' } }, diagnostics: [], evidence_ids: [] };
  assert.equal(instructionSchema.safeParse(instruction).success, true);
  assert.equal(instructionSchema.safeParse({ ...instruction, size: 3 }).success, false);
  assert.equal(instructionSchema.safeParse({ ...instruction, payload: null }).success, false);
  assert.equal(instructionSchema.safeParse({ ...instruction, bytes: { ...instruction.bytes, size: 'bad' } }).success, false);
});

test('x86 carries relative addressing, implicit register effects and flags without library enums', () => {
  const register = { ...root, id: 'x86_64:rax', width_bits: 64, write_rule: 'replace_root' };
  const payload = {
    architecture: 'x86_64', encoding: 'Mov_r64_rm64', mnemonic: 'mov', operand_bits: 64, address_bits: 64,
    prefixes: { bytes: [0x48], lock: false, rep: false, repne: false, rex: 0x48, segment: null, encoding: 'legacy', mask: null, zeroing: false, rounding: 'none', suppress_exceptions: false },
    operands: [{ kind: 'register', register, access: 'write' }, { kind: 'memory', memory: { segment: null, base: null, index: null, scale: 1, displacement: { negative: true, magnitude: '0x20' }, address_bits: 64, access_bits: 64, rip_relative_target: { ...address, value: '0xfe7' }, broadcast: false, access: 'read' } }],
    registers: [{ register, access: 'write', implicit: false }], memory: [],
    flags: { read: '0x0', written: '0x0', cleared: '0x0', set: '0x0', undefined: '0x0', preserved: '0xffff' }, fpu_flags: null, required_features: [], privileged: false,
  };
  const parsed = x86PayloadSchema.parse(payload);
  assert.equal(parsed.operands[1]?.kind, 'memory');
  assert.equal(parsed.registers[0]?.register.root, 'x86_64:rax');
  assert.equal(parsed.flags.preserved, '0xffff');
  assert.equal(x86PayloadSchema.safeParse({ ...payload, native_instruction: {} }).success, false);
});

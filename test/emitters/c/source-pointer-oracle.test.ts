import assert from 'node:assert/strict';
import test from 'node:test';
import { emittedFormals, execute } from './support.js';

const programs = {
  'c-like': `uint64_t pointer_bits(uint64_t address, uint64_t input) {
  type_3* opaque;
  uint32_t** typed;
  array<type_3, ?>* array_pointer;
  opaque = ((type_3*)(uintptr_t)(input));
  typed = ((uint32_t**)(uintptr_t)(opaque));
  array_pointer = ((array<type_3, ?>*)(uintptr_t)(typed));
  (*(unaligned_uint64_t *)(uintptr_t)(address)) = ((uintptr_t)(array_pointer));
  return (((uintptr_t)(opaque)), (*(unaligned_uint64_t *)(uintptr_t)(address)));
}`,
  'python-like': `def pointer_bits(address: uint64_t, input: uint64_t) -> uint64_t:
  opaque: pointer[type_3]
  typed: pointer[pointer[uint32_t]]
  array_pointer: pointer[array<type_3, ?>]
  opaque = uint64(input)
  typed = uint64(opaque)
  array_pointer = uint64(typed)
  memory.u64[address] = uint64(array_pointer)
  return (uint64(opaque), memory.u64[address])
`,
} as const;

function emission(text: string) {
  return { text, mappings: ['address', 'input'].map((name) => {
    const start = text.indexOf(name);
    const annotation = text.startsWith('def ') ? ': uint64_t'.length : 0;
    return { start, end: start + name.length + annotation, statement_id: name, semantic_ids: [name] };
  }) };
}

for (const language of ['c-like', 'python-like'] as const)
  test(`${language} opaque and nested pointer declarations preserve exact target bits through store/load`, () => {
    const emitted = emission(programs[language]);
    const formals = emittedFormals(emitted);
    assert.deepEqual(formals.map((formal) => formal.name), ['address', 'input']);
    for (const bits of [0n, 0x8000000000000000n, 0xffffffffffffffffn]) {
      const memory = new Map(Array.from({ length: 8 }, (_, index) => [0x3000n + BigInt(index), 0xa5]));
      const observed = execute(emitted, new Map([['address', 0x3000n], ['input', bits]]), memory);
      assert.equal(observed.exit, 'machine_return');
      assert.deepEqual(observed.values, [bits, bits]);
      assert.deepEqual(observed.events, ['store', 'load']);
      for (let byte = 0; byte < 8; byte++)
        assert.equal(observed.memory.get(0x3000n + BigInt(byte)), Number((bits >> BigInt(byte * 8)) & 255n));
    }
  });

for (const language of ['c-like', 'python-like'] as const)
  test(`${language} a pointer declaration alone does not invent initialization`, () => {
    const text = language === 'c-like'
      ? 'uint64_t pointer_bits(void) { type_3* uninitialized; return ((uintptr_t)(uninitialized)); }'
      : 'def pointer_bits() -> uint64_t:\n  uninitialized: pointer[type_3]\n  return uint64(uninitialized)\n';
    assert.throws(() => execute({ text, mappings: [] }), /Undeclared\/uninitialized emitted value/);
  });

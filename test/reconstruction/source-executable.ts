import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emittedFormals } from '../emitters/c/support.js';

export interface ExecutableSourceCase {
  readonly arguments: readonly bigint[];
  readonly expected: bigint;
  /** A real little-endian object passed as the first argument, not a guessed
   * object recovered from a target. Bounds and expected writes are source-known. */
  readonly memory?: {
    readonly bits: 32 | 64;
    readonly values: readonly bigint[];
    readonly expected?: readonly bigint[];
  };
}

const cHelpers = `#include <stdint.h>
#include <stdio.h>
#include <stddef.h>
#include <stdbool.h>
typedef uint32_t unaligned_uint32_t __attribute__((aligned(1), may_alias));
typedef uint64_t unaligned_uint64_t __attribute__((aligned(1), may_alias));
static uint64_t bv_lshr(unsigned bits, uint64_t value, uint64_t count) {
  const uint64_t mask = bits == 64 ? UINT64_MAX : (UINT64_C(1) << bits) - 1;
  return count >= bits ? 0 : (value & mask) >> count;
}
static uint64_t bv_shl(unsigned bits, uint64_t value, uint64_t count) {
  const uint64_t mask = bits == 64 ? UINT64_MAX : (UINT64_C(1) << bits) - 1;
  return count >= bits ? 0 : (value << count) & mask;
}
/* Views annotate an already computed address: adding displacement here again
   would change the emitter's actual byte-address semantics. */
static uintptr_t field_view(uintptr_t address, int64_t displacement, unsigned bits) {
  (void)displacement; (void)bits; return address;
}
static uintptr_t stack_slot(uintptr_t address, int64_t displacement, unsigned bits) {
  (void)displacement; (void)bits; return address;
}
`;

const pythonHelpers = `from __future__ import annotations

def uint32(value):
    return value & ((1 << 32) - 1)

def uint64(value):
    return value & ((1 << 64) - 1)

def bv_lshr(bits, value, count):
    return 0 if count >= bits else (value & ((1 << bits) - 1)) >> count

def bv_shl(bits, value, count):
    return 0 if count >= bits else (value << count) & ((1 << bits) - 1)

def field_view(address, displacement, bits):
    return uint64(address)

def stack_slot(address, displacement, bits):
    return uint64(address)

class _MemoryView:
    def __init__(self, memory, bits):
        self.memory = memory
        self.bits = bits

    def __getitem__(self, address):
        offset = uint64(address) - self.memory.base
        size = self.bits // 8
        if offset < 0 or offset + size > len(self.memory.data):
            raise IndexError('unmapped source object read')
        return int.from_bytes(self.memory.data[offset:offset + size], 'little')

    def __setitem__(self, address, value):
        offset = uint64(address) - self.memory.base
        size = self.bits // 8
        if offset < 0 or offset + size > len(self.memory.data):
            raise IndexError('unmapped source object write')
        self.memory.data[offset:offset + size] = (value & ((1 << self.bits) - 1)).to_bytes(size, 'little')

class _Memory:
    def __init__(self, bits, values):
        self.base = 0x2000
        self.data = bytearray().join((value & ((1 << bits) - 1)).to_bytes(bits // 8, 'little') for value in values)
        self.u32 = _MemoryView(self, 32)
        self.u64 = _MemoryView(self, 64)

    def values(self, bits):
        return [int.from_bytes(self.data[offset:offset + bits // 8], 'little')
                for offset in range(0, len(self.data), bits // 8)]
`;

/** Compile and execute only exact emitted bodies from trusted source fixtures.
 * The declared subset is unsigned 32/64-bit arithmetic/shifts and byte-addressed
 * loads/stores of supplied initialized scalar/array objects with structured
 * control. This does NOT claim unknown effects/storage, indirect calls, FP
 * environments, label/goto syntax, or by-value aggregate syntax compile. */
export function checkExecutableSource(
  emission: Parameters<typeof emittedFormals>[0] & { readonly language: 'c-like' | 'python-like' },
  cases: readonly ExecutableSourceCase[],
  directory: string,
): void {
  const python = emission.language === 'python-like';
  const functionName = python ? /^def\s+([A-Za-z_]\w*)\(/m.exec(emission.text)?.[1]
    : /^uint(?:32|64)_t\s+([A-Za-z_]\w*)\(/m.exec(emission.text)?.[1];
  assert.ok(functionName, 'declared executable subset has one scalar function');
  const formals = emittedFormals(emission);
  assert.ok(formals.every((formal) => formal.name !== 'entry_sp'), 'this subset has no unknown entry storage');
  const stem = `${functionName}-${emission.language}`;
  const path = join(directory, `${stem}.${python ? 'py' : 'c'}`);
  const integer = (value: bigint): string => `0x${BigInt.asUintN(64, value).toString(16)}${python ? '' : 'ULL'}`;
  const runners: string[] = [];
  for (const [index, scenario] of cases.entries()) {
    assert.equal(scenario.arguments.length, formals.length);
    const arguments_ = scenario.arguments.map(integer);
    const memory = scenario.memory;
    if (python) {
      if (memory) {
        runners.push(`memory = _Memory(${memory.bits}, [${memory.values.map(integer).join(', ')}])`);
        arguments_[0] = 'memory.base';
      }
      runners.push(`result = ${functionName}(${arguments_.join(', ')})`);
      runners.push(memory
        ? `print(' '.join(format(value, 'x') for value in [uint64(result)] + memory.values(${memory.bits})))`
        : "print(format(uint64(result), 'x'))");
    } else {
      if (memory) {
        runners.push(`uint${memory.bits}_t values_${index}[] = {${memory.values.length ? memory.values.map(integer).join(', ') : '0'}};`);
        const first = formals[0]!;
        const mapping = emission.mappings.find((mapping) => emission.ids[mapping.semantic_refs[0]!] === first.statement_id);
        assert.ok(mapping);
        const declaration = emission.text.slice(mapping.start, mapping.end);
        arguments_[0] = declaration.includes('*') ? `(void *)values_${index}` : `(uintptr_t)values_${index}`;
      }
      runners.push(`printf("%llx", (unsigned long long)${functionName}(${arguments_.join(', ')}));`);
      if (memory)
        for (let offset = 0; offset < memory.values.length; offset++)
          runners.push(`printf(" %llx", (unsigned long long)values_${index}[${offset}]);`);
      runners.push('puts("");');
    }
  }
  // Opaque pointer tags need only forward declarations: no object size, layout
  // or field is fabricated. A by-value incomplete type still fails compilation.
  const opaqueTags = [...new Set(emission.text.match(/\btype_\d+\b/g) ?? [])].sort();
  const source = python
    ? `${pythonHelpers}\n${emission.text}\n${runners.join('\n')}\n`
    : `${cHelpers}\n${opaqueTags.map((name) => `typedef struct ${name} ${name};`).join('\n')}\n${emission.text}\nint main(void) {\n${runners.join('\n')}\nreturn 0;\n}\n`;
  writeFileSync(path, source);
  const executable = join(directory, stem);
  const compile = spawnSync(python ? 'python3' : '/usr/bin/clang', python
    ? ['-m', 'py_compile', path]
    : ['-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function', path, '-o', executable],
  { encoding: 'utf8', timeout: 30000 });
  assert.equal(compile.status, 0, `${compile.error ?? ''}\n${compile.stderr}`);
  const run = spawnSync(python ? 'python3' : executable, python ? [path] : [], { encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 0, `${run.error ?? ''}\n${run.stderr}`);
  const observed = run.stdout.trim().split('\n').map((line) => line.trim().split(/\s+/).map((value) => BigInt(`0x${value}`)));
  const expected = cases.map((scenario) => [scenario.expected,
    ...(scenario.memory?.expected ?? scenario.memory?.values ?? [])]);
  assert.deepEqual(observed, expected, 'real compiled output agrees with the independent source oracle');
}

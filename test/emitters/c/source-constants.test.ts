import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { recoverDataAddress, recoverDataBytes } from '../../../src/analysis/strings/source-data.js';
import {
  createOperationContext,
  globalDataIdentity,
  type LoadedImage,
} from '../../../src/core/index.js';
import { integer, type SSAForm } from '../../../src/ir/index.js';
import { unknownClobbers } from '../../../src/lifters/arm64/semantics.js';
import { structureControlFlow } from '../../../src/presentation/index.js';
import { reconstruct } from '../../../src/reconstruction/index.js';
import { LocalValidationSession } from '../../../src/reconstruction/local-validation.js';
import { projectSourceConstants } from '../../../src/reconstruction/source-data.js';
import { navigationBytes } from '../../analysis/navigation-fixture.js';
import { builder, image, register, slice } from '../../ir/support.js';
import { emit, emittedFormals, execute } from './support.js';

function immutableImage(bytes: Uint8Array): LoadedImage {
  const loaded = navigationBytes(Uint8Array.of(0xc3), bytes);
  return {
    ...loaded,
    sections: loaded.sections.map((section) => ({ ...section, permissions: ['read'] })),
    mappings: loaded.mappings.map((mapping) => ({ ...mapping, permissions: ['read'] })),
  };
}

function fixture(
  bits: 32 | 64,
  payload: bigint,
  options: {
    floating?: boolean;
    volatile?: boolean;
    mutable?: boolean;
    short?: boolean;
    endian?: 'little' | 'big';
    write?: boolean;
    misaligned?: boolean;
    conflict?: boolean;
    unknownWrite?: boolean;
    call?: boolean;
  } = {},
) {
  const endian = options.endian ?? 'little';
  const bytes = Array.from({ length: bits / 8 }, (_, i) =>
    Number((payload >> BigInt((endian === 'little' ? i : bits / 8 - 1 - i) * 8)) & 255n),
  );
  const b = builder(`constant-pool-${bits}-${payload}-${JSON.stringify(options)}`),
    entry = b.block('entry');
  const address = {
    image_id: image,
    space: 'va' as const,
    value: options.misaligned ? 0x2001n : 0x2000n,
  };
  const pointer = entry.assign(integer(64), { kind: 'address', address });
  if (options.write) entry.store(pointer, entry.constant(integer(bits), 7n));
  if (options.unknownWrite)
    entry.store(
      entry.readRegister(register('rdi', 64, 0, 'preserve_other_bits', 'x86_64:rdi')),
      entry.constant(integer(bits), 7n),
    );
  if (options.call)
    entry.call(
      { kind: 'direct', address: { ...address, value: 0x3000n } },
      [],
      [],
      unknownClobbers,
    );
  const loaded = entry.load(integer(bits), pointer, {
    endian,
    alignment: bits / 8,
    volatile: options.volatile ?? false,
  });
  const value = options.floating ? entry.cast('bitcast', { kind: 'float', bits }, loaded) : loaded;
  entry.return([value]);
  const ir = constructSSA(b.finish(entry, [value.type])).value as SSAForm;
  const fact = {
    address,
    constant_bytes: options.short ? bytes.slice(1) : bytes,
    object: {
      address,
      entity_id: globalDataIdentity(slice, address),
      byte_length: BigInt(bytes.length),
      offset: 0n,
      mutable: options.mutable ?? false,
      kind: 'literal_pool' as const,
      evidence_ids: [],
    },
  };
  const source = {
    abi: sysvAMD64Abi,
    callees: [],
    addresses: [
      fact,
      ...(options.conflict ? [{ ...fact, constant_bytes: bytes.map((byte) => byte ^ 1) }] : []),
    ],
  };
  const memory = new Map(bytes.map((byte, i) => [address.value + BigInt(i), byte]));
  return { ir, source, memory };
}

test('immutable image bytes refuse mutable mappings, relocations, truncation and cross-section reads', () => {
  const image = immutableImage(Uint8Array.from([0, 0, 0, 0, 0, 0, 0xf8, 0x3f]));
  const address = { image_id: image.id, space: 'va' as const, value: 0x2000n };
  const recover = (input: LoadedImage, size = 8) =>
    recoverDataBytes(input, address, size, createOperationContext());
  assert.deepEqual(recover(image), [0, 0, 0, 0, 0, 0, 0xf8, 0x3f]);
  assert.equal(recover(image, 9), undefined);
  assert.equal(
    recover({
      ...image,
      mappings: image.mappings.map((mapping) => ({ ...mapping, permissions: ['read', 'write'] })),
    }),
    undefined,
  );
  assert.equal(
    recover({
      ...image,
      sections: image.sections.map((section) => ({ ...section, permissions: ['read', 'write'] })),
    }),
    undefined,
  );
  const section = image.sections[0]!;
  assert.equal(
    recover({
      ...image,
      sections: [
        section,
        {
          ...section,
          id: 'overlap',
          virtual_range: {
            start: { ...address, value: 0x2004n },
            size: 4n,
          },
        },
      ],
    }),
    undefined,
  );
  const relocation: LoadedImage['relocations'][number] = {
    id: 'relocation',
    address: { ...address, value: 0x2004n },
    width_bits: 32,
    kind: 'relocation',
    encoding: 'absolute',
    target: null,
    addend: 0n,
    symbol_id: null,
    authenticated: false,
    evidence_ids: [],
  };
  assert.equal(recover({ ...image, relocations: [relocation] }), undefined);
  assert.equal(
    recoverDataAddress(image, address, createOperationContext())?.object?.mutable,
    false,
  );
});

for (const language of ['c-like', 'python-like'] as const)
  for (const bits of [32, 64] as const)
    test(`${language}: exact integer and FP${bits} pool literals execute without a memory read`, () => {
      const finite = bits === 32 ? [0x3fc00000n, 0x3dcccccdn] : [0x3ff8000000000000n, 1n];
      for (const floating of [false, true])
        for (const payload of [...finite, 0n, 1n << BigInt(bits - 1)])
          for (const endian of ['little', 'big'] as const) {
            const f = fixture(bits, payload, { floating, endian });
            const source = emit(f.ir, { source: f.source }, language).emission;
            const checked = emit(f.ir, { source: f.source }, language, 'checked').emission;
            const baseline = emit(
              f.ir,
              {
                source: {
                  ...f.source,
                  addresses: f.source.addresses.map(({ address, object }) => ({ address, object })),
                },
              },
              language,
              'checked',
            ).emission;
            assert.equal(checked.text, baseline.text);
            assert.ok(
              source.local_validation?.some((record) => record.rule === 'constant_pool_literal'),
            );
            assert.doesNotMatch(
              source.text,
              /data_address\("|read_memory\(|\*\(uint(?:32|64)_t \*\)/,
            );
            if (floating && payload === finite[0]) assert.match(source.text, /1\.5f?/);
            assert.deepEqual(execute(source).values, [payload], source.text);
            const observed = execute(checked, new Map(), new Map(f.memory));
            assert.deepEqual(observed.values, [payload]);
          }
    });

for (const gate of ['volatile', 'mutable', 'short', 'write', 'misaligned', 'conflict'] as const)
  test(`constant pool refusal: ${gate}`, () => {
    const f = fixture(64, 0x3ff8000000000000n, { [gate]: true });
    for (const language of ['c-like', 'python-like'] as const) {
      const emission = emit(f.ir, { source: f.source }, language).emission;
      assert.ok(
        !emission.local_validation?.some((record) => record.rule === 'constant_pool_literal'),
      );
      if (gate !== 'misaligned')
        assert.deepEqual(
          execute(
            emission,
            new Map(emittedFormals(emission).map((formal) => [formal.statement_id, 0x2000n])),
            new Map(f.memory),
          ).values,
          [gate === 'write' ? 7n : 0x3ff8000000000000n],
        );
    }
  });

for (const gate of ['unknownWrite', 'call'] as const)
  for (const language of ['c-like', 'python-like'] as const)
    test(`${language} read-only constants fold despite ${gate}`, () => {
      // A call, or a store through an unknown address, cannot change bytes of a
      // read-only mapping; only a store to a constant overlapping address could.
      const f = fixture(64, 0x3ff8000000000000n, { [gate]: true });
      const emission = emit(f.ir, { source: f.source }, language).emission;
      assert.ok(
        emission.local_validation?.some((record) => record.rule === 'constant_pool_literal'),
      );
      assert.doesNotMatch(emission.text, /data_address\("|read_memory\(|\*\(uint64_t \*\)0x2000/);
    });

test('nonfinite constant pools retain NaN payloads and refused presentation records keep the load', () => {
  for (const bits of [32, 64] as const) {
    const payload = bits === 32 ? 0x7fa12345n : 0x7ff0123456789abcn;
    const f = fixture(bits, payload, { floating: true });
    for (const language of ['c-like', 'python-like'] as const) {
      const emitted = emit(f.ir, { source: f.source }, language).emission;
      assert.deepEqual(execute(emitted).values, [payload]);
      assert.match(emitted.text, /bit_pattern|__od_bitcast/);
    }
  }
  const f = fixture(64, 1n);
  const input = {
    function: structureControlFlow(f.ir, createOperationContext()).value!,
    source: f.source,
  };
  const program = reconstruct(input, createOperationContext(), 'checked');
  const context = createOperationContext(),
    validation = new LocalValidationSession(context);
  for (let i = 0; i < 256; i++)
    validation.presentation(`occupied-${i}`, `subject-${i}`, 'occupied');
  assert.equal(
    projectSourceConstants(
      program.blocks,
      new Map(program.expressions),
      new Map(),
      f.source.addresses,
      context,
      validation,
    ).size,
    0,
  );
});

test('exact emitted C pool literals round-trip binary32 and binary64 storage', () => {
  const directory = mkdtempSync(join(tmpdir(), 'od-constant-pool-'));
  try {
    for (const bits of [32, 64] as const)
      for (const payload of [
        0n,
        1n,
        1n << BigInt(bits - 1),
        bits === 32 ? 0x3dcccccdn : 0x3ff8000000000000n,
      ]) {
        const f = fixture(bits, payload, { floating: true });
        const text = emit(f.ir, { source: f.source }, 'c-like').emission.text;
        const file = join(directory, 'literal.c'),
          binary = join(directory, 'literal');
        writeFileSync(
          file,
          text +
            `\n#include <string.h>\nint main(void) {
  ${bits === 32 ? 'float' : 'double'} value = fn_function();
  uint${bits}_t observed; memcpy(&observed, &value, sizeof observed);
  return observed != UINT${bits}_C(0x${payload.toString(16)});
}\n`,
        );
        execFileSync('clang', [
          '-std=c11',
          '-O2',
          '-ffp-contract=off',
          '-include',
          'stdint.h',
          file,
          '-o',
          binary,
        ]);
        execFileSync(binary);
      }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

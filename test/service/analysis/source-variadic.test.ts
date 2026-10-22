import assert from 'node:assert/strict';
import test from 'node:test';
import { darwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { windowsX64Abi } from '../../../src/abi/windows-x64/index.js';
import {
  createOperationContext,
  type AbiSignature,
  type Address,
} from '../../../src/core/index.js';
import type { LibraryContracts } from '../../../src/metadata/library-contracts/index.js';
import type { SourceAddress } from '../../../src/reconstruction/source-model.js';
import {
  printfArgumentTypes,
  scanfArgumentTypes,
  variadicRuleFacts,
} from '../../../src/service/analysis/source-variadic.js';
import { image } from '../../ir/support.js';

for (const abi of [darwinArm64Abi, sysvAMD64Abi, windowsX64Abi]) {
  test(`${abi.id}: printf actual types include width/precision and default promotions`, () => {
    assert.deepEqual(printfArgumentTypes('%% %*.*f %hhd %hu %ld %llu %s %p %n', abi), [
      { kind: 'integer', bits: 32, signed: true },
      { kind: 'integer', bits: 32, signed: true },
      { kind: 'float', bits: 64 },
      { kind: 'integer', bits: 32, signed: true },
      { kind: 'integer', bits: 32, signed: false },
      { kind: 'integer', bits: abi.id === 'windows-x64' ? 32 : 64, signed: true },
      { kind: 'integer', bits: 64, signed: false },
      { kind: 'pointer' },
      { kind: 'pointer' },
      { kind: 'pointer' },
    ]);
    assert.deepEqual(printfArgumentTypes('plain %% text', abi), []);
  });
  test(`${abi.id}: unknown, positional, wide and malformed formats stay open`, () => {
    for (const format of ['%', '%2$d', '%*3$d', '%Lf', '%ls', '%lc', '%m', '%q', '%llf', '%Lx'])
      assert.equal(printfArgumentTypes(format, abi), null, format);
    assert.equal(printfArgumentTypes('%d'.repeat(65), abi), null);
  });
}

test('scanf formats store through one pointer per unsuppressed conversion', () => {
  const pointer = { kind: 'pointer' };
  assert.deepEqual(scanfArgumentTypes('%d %*s %hhu%%%5[^,]%lf %n'), [
    pointer,
    pointer,
    pointer,
    pointer,
    pointer,
  ]);
  assert.deepEqual(scanfArgumentTypes('literal %% only'), []);
  for (const format of ['%', '%1$d', '%q', '%[abc', '%*'])
    assert.equal(scanfArgumentTypes(format), null, format);
});

test('a format that could be either of two literals with different actual types closes no signature', () => {
  const at = (value: bigint): Address => ({ image_id: image, space: 'va', value });
  const literal = (value: bigint, text: string): SourceAddress => ({
    address: at(value),
    string: text,
    string_byte_length: BigInt(Buffer.byteLength(text)),
    string_encoding: 'ascii',
    string_start: true,
  });
  const abi_signature: AbiSignature = {
    returns: { kind: 'integer', bits: 32, signed: true },
    parameters: [{ kind: 'pointer' }, { kind: 'pointer' }],
    variadic: true,
    fixed_parameter_count: 2,
    argument_list_complete: false,
  };
  const contract = { abi_signature } as LibraryContracts['contracts'][number];
  const addresses = [
    literal(0x9000n, '%d B'),
    literal(0x9010n, '%0.3f KiB'),
    literal(0x9020n, '%d KiB'),
  ];
  const facts = (values: readonly bigint[]) =>
    variadicRuleFacts(
      [{ call_id: 'call', contract, kind: 'format', values }],
      addresses,
      darwinArm64Abi,
      createOperationContext(),
    ).signatures;
  assert.equal(facts([0x9000n, 0x9010n]).size, 0);
  assert.equal(facts([0x9000n, 0x9010n, 0x9020n]).size, 0);
  // The same candidate set with one shared actual list does close.
  assert.deepEqual(facts([0x9000n, 0x9020n]).get('call')?.parameters?.slice(2), [
    { kind: 'integer', bits: 32, signed: true },
  ]);
  assert.deepEqual(facts([0x9000n]).get('call')?.argument_list_complete, true);
});

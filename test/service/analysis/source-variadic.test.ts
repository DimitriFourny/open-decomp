import assert from 'node:assert/strict';
import test from 'node:test';
import { darwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { windowsX64Abi } from '../../../src/abi/windows-x64/index.js';
import { printfArgumentTypes } from '../../../src/service/analysis/source-variadic.js';

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

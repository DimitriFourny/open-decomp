import assert from 'node:assert/strict';
import test from 'node:test';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { integer, type DataType, type SSAForm } from '../../../src/ir/index.js';
import { builder } from '../../ir/support.js';
import { emit, execute } from './support.js';

/** `[bits, C spelling, Python spelling]`; exact shortest round-trip decimals. */
const FINITE: Record<32 | 64, readonly (readonly [bigint, string, string])[]> = {
  32: [
    [0n, '0.0f', '0.0'],
    [0x80000000n, '-0.0f', '-0.0'],
    [1n, '1e-45f', '1.401298464324817e-45'],
    [0x007fffffn, '1.1754942e-38f', '1.1754942106924411e-38'],
    [0x3fc00000n, '1.5f', '1.5'],
    [0xc0490fdbn, '-3.1415927f', '-3.1415927410125732'],
    [0x7f7fffffn, '3.4028235e+38f', '3.4028234663852886e+38'],
  ],
  64: [
    [0n, '0.0', '0.0'],
    [0x8000000000000000n, '-0.0', '-0.0'],
    [1n, '5e-324', '5e-324'],
    [0x000fffffffffffffn, '2.225073858507201e-308', '2.225073858507201e-308'],
    [0x3ff8000000000000n, '1.5', '1.5'],
    [0xbfb999999999999an, '-0.1', '-0.1'],
    [0x7fefffffffffffffn, '1.7976931348623157e+308', '1.7976931348623157e+308'],
  ],
};
const NONFINITE: Record<32 | 64, readonly bigint[]> = {
  32: [0x7f800000n, 0xff800000n, 0x7fc12345n],
  64: [0x7ff0000000000000n, 0xfff0000000000000n, 0x7ff8123456789abcn],
};

/** The `return <literal>` statement of a dialect. */
function returned(spelling: string, language: 'c-like' | 'python-like'): RegExp {
  return new RegExp(
    `return ${spelling.replace(/[+.-]/g, '\\$&')}${language === 'c-like' ? ';' : '$'}`,
    'm',
  );
}

/** Returns an FP value that is a typed constant, or the bitcast of an integer one. */
function constantReturn(bits: 32 | 64, value: bigint, carried: boolean) {
  const fp: DataType = { kind: 'float', bits };
  const b = builder(`literal-${bits}-${value}-${carried}`),
    entry = b.block('entry');
  const result = carried
    ? entry.cast('bitcast', fp, entry.constant(integer(bits), value))
    : entry.constant(fp, value);
  entry.return([result]);
  const ir = constructSSA(b.finish(entry, [fp])).value as SSAForm;
  return { ir, source: { abi: sysvAMD64Abi, callees: [], addresses: [] } };
}

for (const bits of [32, 64] as const)
  for (const carried of [false, true])
    test(`FP${bits} ${carried ? 'bitcast integer' : 'typed'} constants print exact literals`, () => {
      for (const [value, c, python] of FINITE[bits]) {
        const f = constantReturn(bits, value, carried);
        for (const language of ['c-like', 'python-like'] as const) {
          const { emission } = emit(f.ir, { source: f.source }, language);
          const spelling = language === 'c-like' ? c : python;
          if (language === 'c-like' || bits === 64)
            assert.match(emission.text, returned(spelling, language), emission.text);
          assert.doesNotMatch(
            emission.text,
            /bit_pattern|__od_bitcast|cast_bitcast/,
            emission.text,
          );
          // The literal denotes the same bits.
          if (language === 'c-like' || bits === 64)
            assert.deepEqual(execute(emission).values, [value], emission.text);
          const checked = emit(f.ir, { source: f.source }, language, 'checked').emission.text;
          assert.doesNotMatch(checked, returned(spelling, language));
        }
      }
    });

for (const bits of [32, 64] as const)
  test(`FP${bits} nonfinite constants keep their exact payload form`, () => {
    for (const value of NONFINITE[bits])
      for (const carried of [false, true]) {
        const f = constantReturn(bits, value, carried);
        for (const language of ['c-like', 'python-like'] as const) {
          const { emission } = emit(f.ir, { source: f.source }, language);
          assert.match(emission.text, new RegExp(`0x${value.toString(16)}\\b`), emission.text);
          assert.deepEqual(execute(emission).values, [value], emission.text);
        }
      }
  });

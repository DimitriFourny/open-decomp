import assert from 'node:assert/strict';
import { createOperationContext, DEFAULT_ANALYSIS_OPTIONS } from '../../../src/core/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { simplifySSA } from '../../../src/analysis/values/index.js';
import { structureControlFlow } from '../../../src/presentation/index.js';
import { reconstruct } from '../../../src/reconstruction/index.js';
import { emitC } from '../../../src/emitters/c/index.js';
import { emitPythonLike } from '../../../src/emitters/python-like/index.js';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { fromWords, lift } from '../../lifters/arm64/support.js';
import { execute } from './support.js';

/** SQLite 3.54.0, sqlite3.c:37261-37271 (public domain).
 * Source oracle:
 *   if (!zLeft) return zRight ? -1 : 0;
 *   if (!zRight) return 1;
 *   while (N-- > 0 && *a && UpperToLower[*a] == UpperToLower[*b]) { a++; b++; }
 *   return N < 0 ? 0 : UpperToLower[*a] - UpperToLower[*b];
 *
 * These are the exact 29 instruction words of the retained Homebrew ARM64
 * sqlite3_strnicmp at 0x10003d2ac, not a recompiled approximation or synthetic
 * CFG. Relocating the whole body to fromWords' 0x1000 preserves its relative
 * branches and relocates ADRP's lookup table to 0xf6f08. No analyzed binary is
 * executed: only the existing independent emitted-output evaluator runs.
 */
const words = [
  0xb4000280, 0xb40002c1, 0x7100045f, 0x540001eb, 0x11000449, 0xb00007a8, 0x913c2108, 0x3840140a,
  0xb400022a, 0x386a690a, 0x3940002b, 0x386b690b, 0x6b0b015f, 0x54000181, 0x91000421, 0x51000529,
  0x7100053f, 0x54fffec8, 0x52800000, 0xd65f03c0, 0xf100003f, 0x5a9f03e0, 0xd65f03c0, 0x52800020,
  0xd65f03c0, 0x39400029, 0x38696908, 0x4b080140, 0xd65f03c0,
];
const lower = (byte: number): number => (byte >= 65 && byte <= 90 ? byte + 32 : byte);

export const strnicmpCases: readonly (readonly [string | null, string | null, number])[] = [
  ['a', 'b', 1],
  ['z', 'a', 1],
  ['AbCdX', 'aBcDy', 5],
  ['AbCdZ', 'aBcDy', 5],
  ['a', 'b', 0],
  ['a', 'b', -1],
  ['a', 'b', -2147483647],
  ['AbCdX', 'aBcDy', 4],
  ['AbCdX', 'aBcDy', 0],
  ['a', 'A', 1],
  ['a', 'A', 2],
  ['a', 'A', 2147483647],
  ['', '', 0],
  ['', '', 1],
  ['', 'a', 1],
  ['a', '', 1],
  ['abcd', 'ABC', 3],
  ['abcd', 'ABC', 4],
  ['ABC', 'abcd', 4],
  ['ABC', 'abc', 3],
  ['ABC', 'abc', 4],
  [null, null, 1],
  [null, 'a', 1],
  ['a', null, 1],
  [null, '', 0],
  ['', null, -1],
  [null, null, -1],
  ['\x80A', '\x80b', 2],
  ['\xff', '\x80', 1],
  ['ab\0x', 'AB\0y', 4],
];

/** Independent source-level algorithm, not the IR interpreter or reconstruction. */
export function strnicmpOracle(left: string | null, right: string | null, count: number): bigint {
  if (left === null) return right === null ? 0n : -1n;
  if (right === null) return 1n;
  // INT_MIN is excluded: the original source's N-- would overflow signed int.
  assert.ok(Number.isInteger(count) && count > -2147483648 && count <= 2147483647);
  let index = 0;
  while (count-- > 0) {
    const a = left.charCodeAt(index) || 0,
      b = right.charCodeAt(index) || 0;
    if (a === 0 || lower(a) !== lower(b)) return BigInt(lower(a) - lower(b));
    index++;
  }
  return 0n;
}

export function checkStrnicmp(): { cases: number; dialects: number; transfers: number } {
  const graph = fromWords(words),
    constructed = constructSSA(lift(graph).ir);
  assert.equal(constructed.state, 'complete');
  assert.equal(constructed.value.form, 'ssa');
  if (constructed.value.form !== 'ssa') assert.fail('Expected SSA');
  const simplified = simplifySSA(constructed.value);
  assert.equal(simplified.state, 'complete');
  const ir = simplified.value,
    context = createOperationContext;
  const structured = structureControlFlow(ir, context());
  assert.equal(structured.state, 'complete');
  assert.ok(structured.value);
  const input = {
    function: structured.value,
    source: { abi: new DarwinArm64Abi(), callees: [], addresses: [] },
  };
  // Both dialects receive the very same shared region/source facts. Reconstruction
  // must retain the distinct native zero-return and mismatch destinations.
  const program = reconstruct(input, context());
  const mismatchAddress = 0x64n; // instruction provenance uses image-relative addresses
  const mismatch = [...program.blocks.values()].find((block) =>
    block.provenance.ranges.some((range) => range.start.value === mismatchAddress),
  );
  assert.ok(mismatch, 'Mismatch native block survives SSA, regions and reconstruction');
  const zero = [...program.blocks.values()].find((block) =>
    block.provenance.ranges.some((range) => range.start.value === 0x48n),
  );
  assert.ok(zero);
  const loopExits = [...program.blocks.values()]
    .flatMap((block) => {
      const control = block.control;
      return control.kind === 'if'
        ? [control.when_true.transfer, control.when_false.transfer]
        : control.kind === 'jump'
          ? [control.transfer]
          : [];
    })
    .filter((transfer) => transfer.mode === 'break');
  assert.ok(loopExits.some((transfer) => transfer.target === mismatch.id));
  assert.ok(loopExits.some((transfer) => transfer.target === zero.id));
  const entry = ir.blocks.find((block) => block.id === ir.entry)!;
  const bindings = ir.register_states.find((state) => state.block === ir.entry)!.entry;
  for (const language of ['c-like', 'python-like'] as const) {
    const output = (language === 'c-like' ? emitC : emitPythonLike)(
      input,
      { ...DEFAULT_ANALYSIS_OPTIONS, emitter: language },
      context(),
    );
    for (const [left, right, count] of strnicmpCases) {
      const memory = new Map<bigint, number>();
      const put = (base: bigint, text: string | null): bigint => {
        if (text === null) return 0n;
        for (let i = 0; i <= text.length; i++)
          memory.set(base + BigInt(i), text.charCodeAt(i) || 0);
        return base;
      };
      const roots = new Map([
        ['arm64:x0', put(0x2000n, left)],
        ['arm64:x1', put(0x3000n, right)],
        ['arm64:x2', BigInt.asUintN(32, BigInt(count))],
      ]);
      for (let byte = 0; byte < 256; byte++) memory.set(0xf6f08n + BigInt(byte), lower(byte));
      const before = new Map(memory),
        inputs = new Map(entry.parameters.map((value) => [value.id, 0n]));
      for (const binding of bindings)
        inputs.set(
          binding.value.id,
          BigInt.asUintN(
            binding.register.width_bits,
            (roots.get(binding.register.root) ?? 0n) >> BigInt(binding.register.offset_bits),
          ),
        );
      const observed = execute(output.emission, inputs, memory);
      const description = `${language}: ${JSON.stringify([left, right, count])}`;
      assert.equal(observed.exit, 'machine_return', description);
      assert.deepEqual(
        observed.values,
        [BigInt.asUintN(32, strnicmpOracle(left, right, count))],
        description,
      );
      assert.deepEqual(observed.memory, before, 'Comparison has no memory writes');
      assert.deepEqual(observed.calls, [], 'Comparison makes no calls');
    }
  }
  return { cases: strnicmpCases.length, dialects: 2, transfers: program.transfers.size };
}

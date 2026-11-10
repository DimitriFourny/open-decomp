import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationContext,
  type AbiProfile,
  type Evidence,
  type RegisterDescriptor,
} from '../../src/core/index.js';
import { darwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../src/abi/sysv-amd64/index.js';
import { windowsX64Abi } from '../../src/abi/windows-x64/index.js';
import type { SuppliedCallContract } from '../../src/analysis/calls/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { recoverTypes } from '../../src/analysis/types/index.js';
import { integer, type SSAForm, type Value } from '../../src/ir/index.js';
import { structureControlFlow } from '../../src/presentation/index.js';
import { reconstruct } from '../../src/reconstruction/index.js';
import { builder, image, slice } from '../ir/support.js';
import { acknowledgeRequirements, emit, execute } from '../emitters/c/support.js';
import { firstArgument } from './frame-support.js';

const u64 = integer(64),
  bit = integer(1);
const GUARD = 0x5000n,
  SLOT = 0x6000n,
  CHECKER = 0x3000n,
  CALLEE = 0x2000n;
const FS_BASE: RegisterDescriptor = {
  id: 'x86_64:fs_base',
  root: 'x86_64:fs_base',
  bank: 'control',
  offset_bits: 0,
  width_bits: 64,
  root_width_bits: 64,
  role: 'general',
  write_rule: 'replace_root',
};
type Shape =
  | 'valid'
  | 'trap'
  | 'xor'
  | 'flag-word'
  | 'segment'
  | 'import-slot'
  | 'writable-slot'
  | 'other-escapes'
  | 'slot-escapes'
  | 'extra-read'
  | 'second-store'
  | 'other-guard'
  | 'other-checker'
  | 'observable-failure'
  | 'shared-failure'
  | 'live-difference'
  | 'opaque-effect';

/** A function with a canary at entry-SP -16: `g = *guard; frame[-16] = g;
 * sub_2000(...); if (frame[-16] != *guard) { sub_3000(); <fallthrough> }
 * return 7;` where sub_3000 is the established noreturn library declaration
 * `__stack_chk_fail` (`other-checker`: a noreturn `abort`). */
function fixture(abi: AbiProfile, shape: Shape) {
  const b = builder(`stack-protector-${abi.id}-${shape}`),
    entry = b.block('entry'),
    failure = b.block('failure'),
    done = b.block('done');
  const sp = entry.int('sub', entry.readRegister(abi.stack_pointer), entry.constant(u64, 32n));
  entry.writeRegister(abi.stack_pointer, sp);
  const slot = entry.int('add', sp, entry.constant(u64, 16n));
  // Darwin: the guard's address is loaded from its GOT slot at each use.
  const guardAddress = (block: typeof entry): Value =>
    shape === 'segment'
      ? block.int('add', block.constant(u64, 0x28n), block.readRegister(FS_BASE))
      : shape === 'import-slot' || shape === 'writable-slot'
        ? block.load(u64, block.constant(u64, SLOT))
        : block.constant(u64, GUARD);
  entry.store(slot, entry.load(u64, guardAddress(entry)));
  const argument = firstArgument(abi);
  if (shape === 'other-escapes') entry.writeRegister(argument, sp);
  if (shape === 'slot-escapes') entry.writeRegister(argument, slot);
  if (shape === 'second-store') entry.store(slot, entry.constant(u64, 9n));
  if (shape === 'opaque-effect')
    entry.unknown('Opaque instruction', { registers: [], flags: [], memory: 'unknown_read_write' });
  entry.call(
    { kind: 'direct', address: { image_id: image, space: 'va', value: CALLEE } },
    [],
    [],
    abi.unknown_call_clobbers,
  );
  let extra: Value | undefined;
  if (shape === 'extra-read') extra = entry.load(u64, slot);
  const canary = entry.load(u64, slot);
  const guard =
    shape === 'other-guard'
      ? entry.load(u64, entry.constant(u64, GUARD + 8n))
      : entry.load(u64, guardAddress(entry));
  let differ: Value;
  if (shape === 'xor')
    differ = entry.compare('ne', entry.int('xor', guard, canary), entry.constant(u64, 0n));
  else if (shape === 'flag-word') {
    // AArch64: `subs` packs NZCV into one word, `b.ne` tests NOT Z (bit 30).
    const word = entry.insert(
      entry.insert(entry.constant(integer(32), 0n), entry.compare('ult', guard, canary), 29),
      entry.compare('eq', guard, canary),
      30,
    );
    differ = entry.unary('not', entry.extract(word, 30, 1));
  } else differ = entry.compare('ne', entry.int('sub', canary, guard), entry.constant(u64, 0n));
  const difference = entry.int('sub', canary, guard);
  entry.branch(differ, entry.edge(failure), entry.edge(done));
  if (shape === 'observable-failure') failure.store(failure.constant(u64, GUARD + 16n), canary);
  failure.call(
    { kind: 'direct', address: { image_id: image, space: 'va', value: CHECKER } },
    [],
    [],
    abi.unknown_call_clobbers,
  );
  if (shape === 'trap') failure.terminate({ kind: 'trap', reason: 'noreturn call' });
  else {
    const after = b.block('after');
    failure.jump(after);
    after.unknown('Missing or ambiguous discovered fallthrough', abi.unknown_call_clobbers);
    after.terminate({ kind: 'unknown', reason: 'Missing or ambiguous discovered fallthrough' });
  }
  done.writeRegister(abi.stack_pointer, done.int('add', sp, done.constant(u64, 32n)));
  if (shape === 'shared-failure') {
    // A second path enters the failure block: it is no longer the check's own.
    const other = b.block('other');
    done.branch(
      done.extract(done.readRegister(argument), 0, 1),
      done.edge(failure),
      done.edge(other),
    );
    other.return([other.constant(u64, 7n)]);
  } else
    done.return([
      shape === 'live-difference'
        ? difference
        : extra
          ? done.int('add', extra, done.constant(u64, 7n))
          : done.constant(u64, 7n),
    ]);
  const ir = constructSSA(b.finish(entry, [u64])).value as SSAForm;
  const contract: SuppliedCallContract = {
    id: 'contract-checker',
    target: { kind: 'address', address: { image_id: image, space: 'va', value: CHECKER } },
    signature: {
      parameters: [],
      returns: { kind: 'void' },
      variadic: false,
      fixed_parameter_count: 0,
    },
    noreturn: true,
    evidence_ids: ['evidence-checker'],
  };
  const types = recoverTypes(ir, abi, createOperationContext(), {
    image_id: image,
    slice_id: slice,
    revision: 0,
    contracts: [contract],
  });
  const declaration: Evidence = {
    id: 'evidence-checker',
    origin: {
      kind: 'library',
      library: 'libc',
      contract: shape === 'other-checker' ? 'abort' : '__stack_chk_fail',
      version: '2',
    },
    claim: 'Conditional library declaration from native import identity',
    derived_from: [],
    conflicts_with: [],
    revision: 0,
  };
  const extraInput = {
    types: { ...types, evidence: [...types.evidence, declaration] },
    source: {
      abi,
      callees: [],
      addresses:
        shape === 'import-slot'
          ? [
              {
                address: { image_id: image, space: 'va' as const, value: SLOT },
                import: {
                  id: 'import-guard',
                  name: '___stack_chk_guard',
                  source_name: '__stack_chk_guard',
                  library: 'libSystem',
                  evidence_ids: [],
                },
              },
            ]
          : [],
    },
  };
  const structured = structureControlFlow(ir, createOperationContext());
  assert.ok(structured.value);
  const plan = (view: 'source' | 'checked') =>
    reconstruct({ function: structured.value!, ...extraInput }, createOperationContext(), view);
  return { ir, extra: extraInput, source: plan('source'), checked: plan('checked') };
}

for (const abi of [sysvAMD64Abi, windowsX64Abi, darwinArm64Abi]) {
  for (const shape of [
    'valid',
    'trap',
    'xor',
    'flag-word',
    'other-escapes',
    'segment',
    'import-slot',
  ] as const) {
    if (shape === 'segment' && abi !== sysvAMD64Abi) continue;
    test(`${abi.id}: a proven stack protector is omitted (${shape})`, () => {
      const { ir, extra, source, checked } = fixture(abi, shape);
      const protector = source.source?.stack_protector;
      assert.ok(protector);
      assert.deepEqual(protector.offsets, [-16n]);
      assert.equal(protector.guards.size, 1);
      assert.ok(
        source.local_validation_session?.abiConformance.some(
          (site) => site.rule === 'stack_protector',
        ),
      );
      assert.equal(checked.source?.stack_protector, undefined);
      // The guard word: the emitted program never reads it.
      const memory = new Map<bigint, number>();
      for (let byte = 0n; byte < 8n; byte++) memory.set(GUARD + byte, Number(0x40n + byte));
      for (const language of ['c-like', 'python-like'] as const) {
        const output = emit(ir, extra, language).emission;
        assert.match(output.text, /stack protector: canary at entry-SP offset -0x10/);
        assert.doesNotMatch(output.text, /sub_3000|__stack_chk_fail|unknown_effect|unknown_exit/);
        assert.doesNotMatch(output.text, /0x5000|0x6000|fs_base|frame|stack_frame|entry_sp/);
        const result = execute(
          output,
          new Map(),
          memory,
          0n,
          new Map(),
          new Map(),
          new Map([['sub_2000', () => []]]),
          acknowledgeRequirements(output),
        );
        assert.deepEqual(result.values, [7n]);
        assert.ok(!result.events.includes('load'), result.events.join(','));
      }
      // The checked view keeps every guard read and the check.
      const literal = emit(ir, extra, 'c-like', 'checked').emission.text;
      assert.match(literal, /sub_3000/);
    });
  }
  for (const shape of [
    'slot-escapes',
    'extra-read',
    'second-store',
    'other-guard',
    'other-checker',
    'observable-failure',
    'shared-failure',
    'live-difference',
    'opaque-effect',
    'writable-slot',
  ] as const)
    test(`${abi.id}: ${shape} keeps the stack protector printed`, () => {
      const { ir, extra, source } = fixture(abi, shape);
      assert.equal(source.source?.stack_protector, undefined);
      assert.ok(
        !source.local_validation_session?.abiConformance.some(
          (site) => site.rule === 'stack_protector',
        ),
      );
      for (const language of ['c-like', 'python-like'] as const) {
        const output = emit(ir, extra, language).emission;
        assert.doesNotMatch(output.text, /stack protector/);
        assert.match(output.text, /sub_3000/);
      }
    });
}

test('equalityTest resolves comparisons, differences, negations and flag words', async () => {
  const { equalityTest } = await import('../../src/reconstruction/source-protector.js');
  const b = builder('equality-test'),
    block = b.block('entry');
  const left = block.readRegister(firstArgument(sysvAMD64Abi)),
    right = block.load(u64, block.constant(u64, GUARD));
  const zero = block.constant(u64, 0n);
  const cases: [Value, boolean | null][] = [
    [block.compare('ne', left, right), true],
    [block.compare('eq', block.int('sub', left, right), zero), false],
    [block.compare('ne', zero, block.int('xor', right, left)), true],
    [block.int('xor', block.compare('eq', left, right), block.constant(bit, 1n)), true],
    [block.compare('eq', block.compare('eq', left, right), block.constant(bit, 0n)), true],
    [block.compare('ne', block.compare('eq', left, right), block.constant(bit, 0n)), false],
    [block.unary('not', block.compare('ne', left, right)), false],
    // An ordering is no equality test; an `and` of differences is unknown.
    [block.compare('ult', left, right), null],
    [block.compare('ne', block.int('and', left, right), zero), true],
  ];
  block.return([]);
  const ir = constructSSA(b.finish(block, [])).value as SSAForm;
  const expressions = new Map(
    ir.blocks.flatMap((item) =>
      item.instructions.flatMap((node) =>
        node.kind === 'assign' ? [[node.result.id, node.expression] as const] : [],
      ),
    ),
  );
  for (const [index, [condition, differ]] of cases.entries()) {
    const found = equalityTest(condition, expressions, createOperationContext());
    if (differ === null) assert.equal(found, null, `case ${index}`);
    else {
      assert.ok(found, `case ${index}`);
      assert.equal(found.differ, differ, `case ${index}`);
    }
  }
});

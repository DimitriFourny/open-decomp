import assert from 'node:assert/strict';
import test from 'node:test';
import { darwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { windowsX64Abi } from '../../../src/abi/windows-x64/index.js';
import { recoverStack } from '../../../src/analysis/stack/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import {
  createOperationContext,
  type AbiProfile,
  type RegisterDescriptor,
} from '../../../src/core/index.js';
import { integer, type Expression, type SSAForm } from '../../../src/ir/index.js';
import {
  fpEnvironmentGuard,
  stateRegister,
  unknownClobbers,
} from '../../../src/lifters/arm64/semantics.js';
import { x86FpEnvironmentGuard } from '../../../src/lifters/x86_64/semantics.js';
import { fpEnvironmentFailures } from '../../../src/service/analysis/source-facts.js';
import { builder } from '../../ir/support.js';
import { project } from './support.js';

const mxcsr: RegisterDescriptor = {
  id: 'x86_64:mxcsr[6:16]',
  root: x86FpEnvironmentGuard.control_root,
  bank: 'control',
  offset_bits: x86FpEnvironmentGuard.offset_bits,
  width_bits: x86FpEnvironmentGuard.width_bits,
  root_width_bits: 32,
  role: 'general',
  write_rule: 'preserve_other_bits',
};

type Variant = 'guard' | 'other_constant' | 'failure_effect' | 'computed_state';

/** Lifter-shaped environment guard before one supported return; variants
 * change exactly one property of the guard. */
function failures(abi: AbiProfile, variant: Variant) {
  const arm = abi.id === darwinArm64Abi.id;
  const b = builder(`fp-environment-${abi.id}-${variant}`);
  const entry = b.block('entry'),
    supported = b.block('supported'),
    failure = b.block('failure');
  const state =
    variant === 'computed_state'
      ? entry.constant(
          integer(arm ? 32 : x86FpEnvironmentGuard.width_bits),
          arm ? 0n : x86FpEnvironmentGuard.supported_bits,
        )
      : entry.readRegister(arm ? stateRegister('fpcr') : mxcsr);
  if (arm) {
    const mask = variant === 'other_constant' ? 3n << 22n : fpEnvironmentGuard.mask;
    entry.branch(
      entry.compare(
        'eq',
        entry.int('and', state, entry.constant(integer(32), mask)),
        entry.constant(integer(32), 0n),
      ),
      entry.edge(supported),
      entry.edge(failure),
    );
    failure.unknown(fpEnvironmentGuard.unsupported_effect, unknownClobbers);
  } else {
    const expected = variant === 'other_constant' ? 0x7fn : x86FpEnvironmentGuard.supported_bits;
    entry.branch(
      entry.compare(
        'ne',
        state,
        entry.constant(integer(x86FpEnvironmentGuard.width_bits), expected),
      ),
      entry.edge(failure),
      entry.edge(supported),
    );
  }
  if (variant === 'failure_effect')
    failure.store(failure.constant(integer(64), 0x2000n), failure.constant(integer(64), 1n));
  failure.terminate({
    kind: 'unknown',
    reason: arm ? fpEnvironmentGuard.unsupported_exit : x86FpEnvironmentGuard.unsupported_exit,
  });
  supported.return([supported.constant(integer(64), 7n)]);
  const ir = constructSSA(b.finish(entry, [integer(64)])).value as SSAForm;
  const definitions = new Map<string, Expression>();
  const predecessors = new Map<string, SSAForm['blocks'][number][]>();
  for (const block of ir.blocks) {
    for (const node of block.instructions)
      if (node.kind === 'assign') definitions.set(node.result.id, node.expression);
    const control = block.terminator;
    const edges =
      control.kind === 'jump'
        ? [control.edge]
        : control.kind === 'branch'
          ? [control.when_true, control.when_false]
          : [];
    for (const edge of edges)
      predecessors.set(edge.target, [...(predecessors.get(edge.target) ?? []), block]);
  }
  const stack = recoverStack(ir, abi, createOperationContext());
  return {
    failure: failure.id,
    found: fpEnvironmentFailures(ir, abi, definitions, predecessors, stack.values),
  };
}

for (const abi of [sysvAMD64Abi, windowsX64Abi, darwinArm64Abi])
  test(`${abi.id}: only the lifter's exact FP environment guard failure is conditional`, () => {
    const accepted = failures(abi, 'guard');
    assert.deepEqual([...accepted.found], [accepted.failure]);
    for (const variant of ['other_constant', 'failure_effect', 'computed_state'] as const)
      assert.deepEqual([...failures(abi, variant).found], [], variant);
  });

// Real x86 callee bodies whose only unknown exits are MXCSR guard failures.
for (const fixture of ['corpus-symbols.dll', 'libcorpus-elf-x86_64-symbols.so'])
  test(
    `${fixture}: MXCSR-guarded callees keep closed FP interfaces and open va_list spills`,
    { timeout: 120000 },
    async (t) => {
      const p = await project(t, fixture),
        fn = p.functions.find((candidate) => candidate.original_name === 'fixture_check');
      assert.ok(fn);
      const response = await p.decompile(fn.id, { options: { emitter: 'c-like' } });
      assert.ok('data' in response.result);
      const text = p.payload(response.result).result.data.emission.text;
      // fixture_float reads two doubles: its guarded body closes the interface, so its
      // call prints both arguments and the callee is not named as open.
      assert.match(text, /fixture_float\(.+, .+\);/);
      assert.doesNotMatch(text, /fixture_float\([^;]*\.\.\./);
      assert.doesNotMatch(text, /open arity[^\n]*fixture_float/);
      // fixture_variadic reads its spilled register arguments through a
      // computed va_list address: no observed argument is dropped or closed. The
      // call prints the proven arguments and the open arity is named once.
      assert.match(
        text,
        fixture.endsWith('.dll')
          ? /fixture_variadic\(3, [^,()]+, [^,()]+, [^,()]+\)/
          : /fixture_variadic\(3\)/,
      );
      assert.match(text, /open arity \([^)]*\): [^\n]*fixture_variadic/);
    },
  );

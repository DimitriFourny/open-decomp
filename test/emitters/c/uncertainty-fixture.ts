import assert from 'node:assert/strict';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { integer } from '../../../src/ir/index.js';
import { fpEnvironmentGuard, gp, stateRegister, unknownClobbers } from '../../../src/lifters/arm64/semantics.js';
import { builder, image } from '../../ir/support.js';
import { acknowledgeRequirements, emit, emittedFormals, execute, type SourceCallOracle } from './support.js';

/** Trusted source-pipeline counterexample: a conservative call may change FP
 * state, followed by an explicit known unsupported state write. The public
 * native MSR fixture separately checks the production opaque-effect boundary. */
export function knownUnsupportedAfterCall() {
  const build = builder('known-unsupported-fp-after-unknown-call');
  const entry = build.block('entry'), supported = build.block('supported'), failure = build.block('failure');
  const pointer = entry.readRegister(gp(0));
  entry.store(pointer, entry.constant(integer(64), 47n));
  entry.call({ kind: 'direct', address: { image_id: image, space: 'va', value: 0x1234n } }, [], [], unknownClobbers);
  entry.store(pointer, entry.constant(integer(64), 53n));
  entry.writeRegister(stateRegister('fpcr'), entry.constant(integer(32), 1n << 22n));
  const state = entry.readRegister(stateRegister('fpcr'));
  const masked = entry.int('and', state, entry.constant(integer(32), fpEnvironmentGuard.mask));
  entry.branch(entry.compare('eq', masked, entry.constant(integer(32), 0n)), entry.edge(supported), entry.edge(failure));
  supported.return([supported.constant(integer(64), 59n)]);
  failure.unknown(fpEnvironmentGuard.unsupported_effect, unknownClobbers);
  failure.terminate({ kind: 'unknown', reason: fpEnvironmentGuard.unsupported_exit });
  const ssa = constructSSA(build.finish(entry, [integer(64)]));
  assert.equal(ssa.state, 'complete');
  assert.equal(ssa.value.form, 'ssa');
  if (ssa.value.form !== 'ssa') assert.fail('Expected SSA');
  const call = ssa.value.blocks.flatMap((block) => block.instructions).find((node) => node.kind === 'call')!;
  const source = { abi: new DarwinArm64Abi(), addresses: [], callees: [{ call_id: call.id,
    parameters: [], returns: [], argument_list_complete: false, evidence_ids: [] }] };
  return { ir: ssa.value, source };
}

export function checkKnownUnsupportedAfterCall(): number {
  const { ir, source } = knownUnsupportedAfterCall();
  let observations = 0;
  for (const language of ['c-like', 'python-like'] as const) {
    const emission = emit(ir, { source }, language).emission;
    const guards = emission.requirements?.filter((item) => item.kind === 'fp_environment')
      .flatMap((item) => item.sites.filter((site) => site.predicate_value_id !== undefined));
    assert.equal(guards?.length, 1, 'The exact original guard is still represented');
    const bytes = new Map(Array.from({ length: 8 }, (_, index) => [0x2000n + BigInt(index), 0]));
    const formal = emittedFormals(emission);
    assert.equal(formal.length, 1);
    const callback: SourceCallOracle = (_arguments, context) => {
      assert.equal(context.arguments_complete, false);
      assert.equal(bytes.get(0x2000n), 47);
      return [];
    };
    const observed = execute(emission, new Map([[formal[0]!.statement_id, 0x2000n]]), bytes, 0n, new Map(), new Map(),
      new Map([['sub_1234', callback]]), acknowledgeRequirements(emission));
    assert.equal(observed.exit, 'unknown', 'Matching acknowledgment cannot override known unsupported FP state');
    assert.equal(bytes.get(0x2000n), 53);
    assert.deepEqual(observed.events, ['store', 'call', 'store', 'unknown']); observations++;
  }
  return observations;
}

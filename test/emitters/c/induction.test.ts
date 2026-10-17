import test from 'node:test';
import { checkLoopInduction } from './induction-fixture.js';
import { checkGuardedRangeCounterexamples } from './induction-ranges-fixture.js';

test('actual ARM64 sum-loop countdown eliminates its proven zero high cell in both dialects', () => {
  checkLoopInduction();
});

test('edge-constrained countdown proofs preserve maximum counts, multiple exits, underflow counterexamples and unknown phi inputs', () => {
  checkGuardedRangeCounterexamples();
});

import test from 'node:test';
import { checkExitRegressions } from './exit-fixture.js';

test('both dialects preserve nested loop/switch exits, edge copies, short-circuit effects and source definition scope', () => {
  checkExitRegressions();
});

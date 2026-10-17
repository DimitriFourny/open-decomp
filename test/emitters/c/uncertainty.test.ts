import assert from 'node:assert/strict';
import test from 'node:test';
import { checkKnownUnsupportedAfterCall } from './uncertainty-fixture.js';

test('both source dialects retain known unsupported FP state after an unknown call despite acknowledgment', () => {
  assert.equal(checkKnownUnsupportedAfterCall(), 2);
});

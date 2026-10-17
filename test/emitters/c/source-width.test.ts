import test from 'node:test';
import { checkSourceWidths } from './source-width-fixture.js';

test('source-width arithmetic, carry-preserving additions, masked shifts and indexed loads survive both emitted dialects', () => {
  checkSourceWidths();
});

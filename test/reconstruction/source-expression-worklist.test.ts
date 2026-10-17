import test from 'node:test';
import { checkSourceExpressionWorklist } from './source-expression-worklist-fixture.js';

test('source normalization observes late definitions and new shared storage views in both emitted dialects', () => {
  checkSourceExpressionWorklist();
});

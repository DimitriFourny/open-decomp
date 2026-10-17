import test from 'node:test';
import { checkSourceExpressionDemand } from './source-expression-demand-fixture.js';

test('source normalization demand retains unused effects, unresolved physical channels and original pure definitions', () => {
  checkSourceExpressionDemand();
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { calleePartialMessage } from '../../../src/service/analysis/source-facts.js';

test('a callee-partial message keeps whole reasons in order within 8,192 characters', () => {
  const few = ['unresolved control flow', 'native dependency load work reserve (100)'];
  assert.equal(
    calleePartialMessage('f', few),
    'Native callee f remains partial: unresolved control flow; native dependency load work reserve (100)',
  );
  const many = Array.from(
    { length: 400 },
    (_, index) => `callee_${index}: native dependency load work reserve (${index})`,
  );
  const message = calleePartialMessage('sqlite3WhereEnd', many);
  assert.ok(message.length <= 8192);
  const match = /; … (\d+) more$/.exec(message);
  assert.ok(match, message.slice(-80));
  const kept = message
    .slice('Native callee sqlite3WhereEnd remains partial: '.length, match.index)
    .split('; ');
  assert.deepEqual(kept, many.slice(0, kept.length));
  assert.equal(kept.length + Number(match[1]), many.length);
});

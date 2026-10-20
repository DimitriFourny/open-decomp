import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCliArguments } from '../../src/mcp/cli.js';

test('--no-analysis-cache is a server-wide pool option and is off by default', () => {
  const defaults = parseCliArguments(['--root', '/tmp']);
  assert.ok(defaults.action === 'serve' && !('analysis_cache' in defaults.pool));
  const disabled = parseCliArguments([
    '--no-analysis-cache',
    '--root',
    '/tmp',
    '--max-workers',
    '1',
  ]);
  assert.ok(disabled.action === 'serve');
  assert.equal(disabled.pool.analysis_cache, false);
  assert.equal(disabled.pool.max_workers, 1);
  assert.throws(
    () => parseCliArguments(['--root', '/tmp', '--no-analysis-cache', '--no-analysis-cache']),
    /Duplicate --no-analysis-cache/,
  );
  // A flag, not an option with a value: it never consumes the next argument.
  assert.throws(() => parseCliArguments(['--no-analysis-cache', '/tmp']), /Unknown CLI argument/);
});

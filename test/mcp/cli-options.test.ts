import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCliArguments } from '../../src/mcp/cli.js';
import { DEFAULT_SETTINGS } from '../../src/settings/index.js';
import type { Settings } from '../../src/settings/index.js';

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

const fromFile: Settings = {
  ...DEFAULT_SETTINGS,
  cache_root: '/tmp/cache',
  analysis_cache: false,
  decompile: { language: 'python-like', view: 'checked' },
};

test('settings are server-wide defaults: analysis cache, decompile language/view and cache root', () => {
  const options = parseCliArguments(['--root', '/tmp'], fromFile);
  assert.ok(options.action === 'serve');
  assert.equal(options.pool.analysis_cache, false);
  assert.deepEqual(options.defaults, {
    decompile: { language: 'python-like', view: 'checked' },
    projects: { cache_root: '/tmp/cache', authorized_roots: ['/tmp'] },
  });
  const builtIn = parseCliArguments(['--root', '/tmp']);
  assert.ok(builtIn.action === 'serve' && !('analysis_cache' in builtIn.pool));
  assert.equal(builtIn.defaults.projects, undefined);
  assert.deepEqual(builtIn.defaults.decompile, { language: 'c-like', view: 'source' });
});

test('--analysis-cache overrides a file setting and --no-analysis-cache overrides the default', () => {
  const forced = parseCliArguments(['--root', '/tmp', '--analysis-cache'], fromFile);
  assert.ok(forced.action === 'serve' && !('analysis_cache' in forced.pool));
  const disabled = parseCliArguments(['--root', '/tmp', '--no-analysis-cache'], DEFAULT_SETTINGS);
  assert.ok(disabled.action === 'serve' && disabled.pool.analysis_cache === false);
  assert.throws(
    () => parseCliArguments(['--root', '/tmp', '--analysis-cache', '--no-analysis-cache']),
    /Specify only one of --analysis-cache and --no-analysis-cache/,
  );
  assert.throws(
    () => parseCliArguments(['--root', '/tmp', '--analysis-cache', '--analysis-cache']),
    /Duplicate --analysis-cache/,
  );
});

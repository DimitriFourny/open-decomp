import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import {
  DEFAULT_SETTINGS,
  SettingsError,
  defaultSettingsPath,
  inspectSettings,
  loadSettings,
} from '../../src/settings/index.js';
import * as api from '../../src/api/index.js';

async function directory(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-settings-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function write(path: string, value: unknown): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}
async function rejection(promise: Promise<unknown>): Promise<SettingsError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof SettingsError, String(error));
    return error;
  }
  return assert.fail('Expected the settings file to be rejected');
}

test('a missing default file means the built-in defaults and every source is default', async (t) => {
  const root = await directory(t);
  const report = await inspectSettings(undefined, { XDG_CONFIG_HOME: root });
  assert.equal(report.exists, false);
  assert.equal(report.explicit, false);
  assert.equal(report.path, join(root, 'open-decomp', 'settings.json'));
  assert.deepEqual(report.settings, DEFAULT_SETTINGS);
  assert.deepEqual(
    Object.values(report.sources).filter((source) => source !== 'default'),
    [],
  );
  assert.deepEqual(await loadSettings(undefined, { XDG_CONFIG_HOME: root }), DEFAULT_SETTINGS);
  assert.deepEqual(DEFAULT_SETTINGS.decompile, {
    language: 'c-like',
    view: 'source',
    inference: 'proven',
  });
  assert.equal(DEFAULT_SETTINGS.analysis_cache, true);
});

test('XDG_CONFIG_HOME is honored, then HOME/.config; a relative XDG_CONFIG_HOME is ignored', async (t) => {
  const root = await directory(t);
  assert.equal(
    defaultSettingsPath({ XDG_CONFIG_HOME: join(root, 'xdg'), HOME: join(root, 'home') }),
    join(root, 'xdg', 'open-decomp', 'settings.json'),
  );
  assert.equal(
    defaultSettingsPath({ HOME: join(root, 'home') }),
    join(root, 'home', '.config', 'open-decomp', 'settings.json'),
  );
  assert.equal(
    defaultSettingsPath({ XDG_CONFIG_HOME: 'relative', HOME: join(root, 'home') }),
    join(root, 'home', '.config', 'open-decomp', 'settings.json'),
  );
  await write(join(root, 'xdg', 'open-decomp', 'settings.json'), {
    version: 1,
    decompile: { language: 'python-like' },
  });
  const viaXdg = await loadSettings(undefined, {
    XDG_CONFIG_HOME: join(root, 'xdg'),
    HOME: join(root, 'home'),
  });
  assert.equal(viaXdg.decompile.language, 'python-like');
  await write(join(root, 'home', '.config', 'open-decomp', 'settings.json'), {
    version: 1,
    analysis_cache: false,
  });
  const viaHome = await loadSettings(undefined, { HOME: join(root, 'home') });
  assert.equal(viaHome.analysis_cache, false);
  assert.equal(viaHome.decompile.language, 'c-like');
});

test('every key is read with its source; unset keys keep default sources', async (t) => {
  const root = await directory(t);
  const path = await write(join(root, 'settings.json'), {
    version: 1,
    cache_root: join(root, 'cache'),
    analysis_cache: false,
    decompile: { language: 'python-like', view: 'checked', inference: 'likely' },
    export: { language: 'python-like', jobs: 3 },
  });
  const report = await inspectSettings(path, {});
  assert.equal(report.exists, true);
  assert.equal(report.explicit, true);
  assert.deepEqual(report.settings, {
    version: 1,
    cache_root: join(root, 'cache'),
    analysis_cache: false,
    decompile: { language: 'python-like', view: 'checked', inference: 'likely' },
    export: { language: 'python-like', jobs: 3 },
  });
  assert.deepEqual(Object.values(report.sources), Array(7).fill('file'));
  const partial = await inspectSettings(
    await write(join(root, 'partial.json'), { version: 1, export: { jobs: 2 } }),
    {},
  );
  assert.equal(partial.sources['export.jobs'], 'file');
  assert.equal(partial.sources['export.language'], 'default');
  assert.equal(partial.sources.cache_root, 'default');
  assert.equal(partial.settings.export.language, 'c-like');
});

test('a missing explicit settings file is an error naming the path', async (t) => {
  const root = await directory(t);
  const path = join(root, 'absent.json');
  const error = await rejection(inspectSettings(path, { XDG_CONFIG_HOME: root }));
  assert.ok(error.message.includes(path), error.message);
  assert.ok(error.message.includes('does not exist'), error.message);
});

test('a default file that exists but is invalid is an error, never ignored', async (t) => {
  const root = await directory(t);
  const path = await write(join(root, 'open-decomp', 'settings.json'), '{ nope');
  const error = await rejection(inspectSettings(undefined, { XDG_CONFIG_HOME: root }));
  assert.ok(error.message.includes(path) && error.message.includes('invalid JSON'), error.message);
});

test('a directory, an array and an oversized file are rejected with the path', async (t) => {
  const root = await directory(t);
  await mkdir(join(root, 'dir'));
  for (const path of [
    join(root, 'dir'),
    await write(join(root, 'array.json'), '[]'),
    await write(join(root, 'big.json'), `{"version":1,"pad":"${'x'.repeat(70_000)}"}`),
  ]) {
    const error = await rejection(inspectSettings(path, {}));
    assert.ok(error.message.includes(path), error.message);
  }
});

test('unknown keys and wrong versions are rejected with the path and the key', async (t) => {
  const root = await directory(t);
  const cases: readonly [unknown, string | undefined, RegExp][] = [
    [{ version: 1, colour: 'blue' }, 'colour', /key "colour": unknown key/],
    [{ version: 1, decompile: { lang: 'c-like' } }, 'decompile.lang', /key "decompile\.lang"/],
    [{ version: 1, export: { jobs: 4, extra: 1 } }, 'export.extra', /key "export\.extra"/],
    [{ version: 2 }, 'version', /unsupported version 2; expected 1/],
    [{ version: '1' }, 'version', /unsupported version "1"/],
    [{}, 'version', /key "version": required/],
    [{ version: 1, analysis_cache: 'no' }, 'analysis_cache', /key "analysis_cache"/],
    [{ version: 1, decompile: { language: 'rust' } }, 'decompile.language', /decompile\.language/],
    [{ version: 1, decompile: { view: 'raw' } }, 'decompile.view', /decompile\.view/],
    [
      { version: 1, decompile: { inference: 'guess' } },
      'decompile.inference',
      /decompile\.inference/,
    ],
    [{ version: 1, export: { language: 1 } }, 'export.language', /export\.language/],
    [{ version: 1, export: { jobs: 0 } }, 'export.jobs', /export\.jobs/],
    [{ version: 1, export: { jobs: 33 } }, 'export.jobs', /export\.jobs/],
    [{ version: 1, export: { jobs: 1.5 } }, 'export.jobs', /export\.jobs/],
    [{ version: 1, cache_root: 'relative/cache' }, 'cache_root', /cache_root.*absolute/],
    [{ version: 1, decompile: 'c-like' }, 'decompile', /key "decompile"/],
  ];
  for (const [index, [content, key, pattern]] of cases.entries()) {
    const path = await write(join(root, `bad-${index}.json`), content);
    const error = await rejection(inspectSettings(path, {}));
    assert.equal(error.path, path);
    assert.equal(error.key, key, JSON.stringify(content));
    assert.ok(error.message.includes(path), error.message);
    assert.match(error.message, pattern);
  }
});

test('the library exports loadSettings and never reads the home settings by itself', async (t) => {
  assert.equal(api.loadSettings, loadSettings);
  const root = await directory(t);
  // With an injected environment the real home is never consulted.
  assert.deepEqual(await api.loadSettings(undefined, { HOME: root }), DEFAULT_SETTINGS);
});

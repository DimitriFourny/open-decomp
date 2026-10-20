import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ToolResult } from '../../src/core/index.js';
import type { SettingsReport } from '../../src/settings/index.js';

interface CommandOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}
interface DecompileOutput {
  project_path: string;
  result: ToolResult<'function_decompile'>;
}
const entry = fileURLToPath(new URL('../../src/cli/entry.ts', import.meta.url));

/** Runs the real CLI entry. Every run gets an explicit XDG_CONFIG_HOME and HOME, so the
 * developer's real ~/.config is never read. */
async function run(
  args: readonly string[],
  env: { XDG_CONFIG_HOME: string; HOME?: string },
): Promise<CommandOutput> {
  const child = spawn(process.execPath, ['--import', 'tsx', entry, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: env.HOME ?? env.XDG_CONFIG_HOME, ...env },
    timeout: 120_000,
    killSignal: 'SIGKILL',
  });
  const closed = once(child, 'close');
  let stdout = '',
    stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const [code] = await closed;
  return { code, stdout, stderr };
}
async function directory(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-cli-settings-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function settingsFile(path: string, content: unknown): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}
function emission(output: CommandOutput): { language: string; text: string; cache: string } {
  assert.ok(output.code === 0 || output.code === 2, output.stderr);
  const { result } = JSON.parse(output.stdout) as DecompileOutput;
  assert.ok('data' in result && result.data.delivery === 'inline', output.stdout);
  return {
    language: result.data.emission.language,
    text: result.data.emission.text,
    cache: result.data.cache,
  };
}

test(
  'settings prints the resolved path, existence and the source of each value',
  {
    timeout: 120_000,
  },
  async (t) => {
    const root = await directory(t);
    const env = { XDG_CONFIG_HOME: join(root, 'xdg') };
    const missing = await run(['settings', '--json'], env);
    assert.equal(missing.code, 0, missing.stderr);
    const none = JSON.parse(missing.stdout) as SettingsReport;
    assert.equal(none.path, join(root, 'xdg', 'open-decomp', 'settings.json'));
    assert.equal(none.exists, false);
    assert.equal(none.explicit, false);
    assert.ok(Object.values(none.sources).every((source) => source === 'default'));
    assert.equal(none.settings.decompile.language, 'c-like');

    // XDG_CONFIG_HOME is honored for the default file.
    await settingsFile(none.path, {
      version: 1,
      decompile: { language: 'python-like' },
      export: { jobs: 2 },
    });
    const viaXdg = JSON.parse((await run(['settings', '--json'], env)).stdout) as SettingsReport;
    assert.equal(viaXdg.exists, true);
    assert.equal(viaXdg.settings.decompile.language, 'python-like');
    assert.equal(viaXdg.sources['decompile.language'], 'file');
    assert.equal(viaXdg.sources['decompile.view'], 'default');
    assert.equal(viaXdg.settings.export.jobs, 2);

    const text = await run(['settings'], env);
    assert.equal(text.code, 0, text.stderr);
    assert.ok(text.stdout.includes(none.path), text.stdout);
    assert.match(text.stdout, /exists: yes/);
    assert.match(text.stdout, /decompile\.language\s+python-like\s+\[file\]/);
    assert.match(text.stdout, /decompile\.view\s+source\s+\[default\]/);

    // --settings overrides the default location.
    const other = await settingsFile(join(root, 'other.json'), {
      version: 1,
      analysis_cache: false,
    });
    const explicit = JSON.parse(
      (await run(['settings', '--json', '--settings', other], env)).stdout,
    ) as SettingsReport;
    assert.equal(explicit.path, other);
    assert.equal(explicit.explicit, true);
    assert.equal(explicit.settings.analysis_cache, false);
    assert.equal(explicit.settings.decompile.language, 'c-like');

    const help = await run(['settings', '--help'], env);
    assert.equal(help.code, 0);
    assert.ok(help.stdout.includes('--settings PATH') && help.stdout.includes('XDG_CONFIG_HOME'));
    assert.ok((await run(['--help'], env)).stderr.includes('settings [--json] [--settings PATH]'));
  },
);

test(
  'settings errors name the path and key; a missing explicit file is an error',
  {
    timeout: 120_000,
  },
  async (t) => {
    const root = await directory(t);
    const env = { XDG_CONFIG_HOME: join(root, 'xdg') };
    const absent = join(root, 'absent.json');
    const missing = await run(['settings', '--settings', absent], env);
    assert.equal(missing.code, 1);
    assert.ok(missing.stderr.includes(absent) && missing.stderr.includes('does not exist'));
    const unknown = await settingsFile(join(root, 'unknown.json'), { version: 1, colour: 'blue' });
    const rejected = await run(['settings', '--settings', unknown], env);
    assert.equal(rejected.code, 1);
    assert.ok(rejected.stderr.includes(unknown) && rejected.stderr.includes('"colour"'));
    const version = await settingsFile(join(root, 'version.json'), { version: 2 });
    const wrongVersion = await run(['settings', '--settings', version], env);
    assert.equal(wrongVersion.code, 1);
    assert.ok(wrongVersion.stderr.includes(version) && wrongVersion.stderr.includes('"version"'));
    // An invalid file at the default location is never ignored either.
    const broken = await settingsFile(join(root, 'xdg', 'open-decomp', 'settings.json'), '{');
    const implicit = await run(['settings'], env);
    assert.equal(implicit.code, 1);
    assert.ok(implicit.stderr.includes(broken) && implicit.stderr.includes('invalid JSON'));
  },
);

test(
  'settings supply defaults to decompile; flags override them in both directions',
  {
    timeout: 280_000,
  },
  async (t) => {
    const root = await directory(t);
    const env = { XDG_CONFIG_HOME: join(root, 'xdg') };
    const binary = join(root, 'corpus');
    await copyFile(resolve('fixtures/bin/macho-arm64-symbols'), binary);
    const cache = join(root, 'cache');
    const file = await settingsFile(join(root, 'settings.json'), {
      version: 1,
      cache_root: cache,
      analysis_cache: false,
      decompile: { language: 'python-like', view: 'checked' },
    });
    const decompile = (extra: readonly string[] = [], json = true) =>
      run(
        [
          'decompile',
          binary,
          '--function',
          'fixture_arithmetic',
          ...(json ? ['--json'] : []),
          ...extra,
        ],
        env,
      );

    // File values apply: language, cache root, and no analysis caching.
    const fromFile = await decompile(['--settings', file]);
    const python = emission(fromFile);
    assert.equal(python.language, 'python-like');
    assert.ok((JSON.parse(fromFile.stdout) as DecompileOutput).project_path.startsWith(cache));
    assert.equal((await readdir(cache)).length, 1);
    await assert.rejects(readdir(`${binary}.open-decomp`), { code: 'ENOENT' });
    assert.equal(emission(await decompile(['--settings', file])).cache, 'computed');

    // Flags override the file.
    const c = emission(await decompile(['--settings', file, '--language', 'c-like']));
    assert.equal(c.language, 'c-like');
    const textFromFile = await decompile(['--settings', file], false);
    const textSource = await decompile(['--settings', file, '--view', 'source'], false);
    assert.notEqual(
      textFromFile.stdout,
      textSource.stdout,
      'the file view differs from a flag view',
    );
    assert.ok(textFromFile.stdout.startsWith('# Python-like'), 'the file language still applies');
    assert.ok(textSource.stdout.startsWith('# Python-like'), 'a flag view keeps the file language');
    const flagCache = join(root, 'flag-cache');
    const overridden = await decompile(['--settings', file, '--cache', flagCache]);
    assert.ok(
      (JSON.parse(overridden.stdout) as DecompileOutput).project_path.startsWith(flagCache),
    );

    // --analysis-cache overrides analysis_cache: false for one run.
    const forcedCache = join(root, 'forced-cache');
    const forced = ['--settings', file, '--analysis-cache', '--cache', forcedCache];
    assert.equal(emission(await decompile(forced)).cache, 'computed');
    assert.equal(emission(await decompile(forced)).cache, 'hit');

    // --no-analysis-cache still overrides a file that enables caching.
    const enabled = await settingsFile(join(root, 'enabled.json'), {
      version: 1,
      analysis_cache: true,
    });
    const disabledCache = join(root, 'disabled-cache');
    const disabled = ['--settings', enabled, '--no-analysis-cache', '--cache', disabledCache];
    assert.equal(emission(await decompile(disabled)).cache, 'computed');
    assert.equal(emission(await decompile(disabled)).cache, 'computed');

    const both = await decompile(['--analysis-cache', '--no-analysis-cache']);
    assert.equal(both.code, 1);
    assert.ok(both.stderr.includes('Specify only one of --analysis-cache and --no-analysis-cache'));
  },
);

test(
  'the default settings file is honored through XDG_CONFIG_HOME and bad files stop the command',
  {
    timeout: 200_000,
  },
  async (t) => {
    const root = await directory(t);
    const env = { XDG_CONFIG_HOME: join(root, 'xdg') };
    const binary = join(root, 'corpus');
    await copyFile(resolve('fixtures/bin/macho-arm64-symbols'), binary);
    const args = [
      'decompile',
      binary,
      '--function',
      'fixture_arithmetic',
      '--json',
      '--cache',
      join(root, 'cache'),
    ];
    assert.equal(emission(await run(args, env)).language, 'c-like', 'no file: built-in defaults');
    const path = await settingsFile(join(root, 'xdg', 'open-decomp', 'settings.json'), {
      version: 1,
      decompile: { language: 'python-like' },
    });
    assert.equal(emission(await run(args, env)).language, 'python-like');
    assert.equal(emission(await run([...args, '--language', 'c-like'], env)).language, 'c-like');
    await settingsFile(path, { version: 1, decompile: { language: 'cobol' } });
    const bad = await run(args, env);
    assert.equal(bad.code, 1);
    assert.ok(bad.stderr.includes(path) && bad.stderr.includes('decompile.language'), bad.stderr);
    assert.equal(bad.stdout, '');
    const absent = await run([...args, '--settings', join(root, 'absent.json')], env);
    assert.equal(absent.code, 1);
    assert.ok(absent.stderr.includes('absent.json'), absent.stderr);
  },
);

test(
  'export.language and export.jobs come from the file and the flags override them',
  {
    timeout: 280_000,
  },
  async (t) => {
    const root = await directory(t);
    const env = { XDG_CONFIG_HOME: join(root, 'xdg') };
    const binary = join(root, 'corpus');
    await copyFile(resolve('fixtures/bin/macho-arm64-symbols'), binary);
    const file = await settingsFile(join(root, 'settings.json'), {
      version: 1,
      cache_root: join(root, 'cache'),
      export: { language: 'python-like', jobs: 1 },
    });
    const extensions = async (out: string): Promise<Set<string>> =>
      new Set(
        (await readdir(join(out, 'functions'))).map((name) => name.slice(name.lastIndexOf('.'))),
      );
    const fromFile = await run(
      ['export', binary, '--out', join(root, 'py'), '--settings', file],
      env,
    );
    assert.equal(fromFile.code, 0, fromFile.stderr);
    assert.ok((await extensions(join(root, 'py'))).has('.py'));
    assert.ok(!(await extensions(join(root, 'py'))).has('.c'));
    const flagged = await run(
      ['export', binary, '--out', join(root, 'c'), '--settings', file, '--language', 'c-like'],
      env,
    );
    assert.equal(flagged.code, 0, flagged.stderr);
    assert.ok((await extensions(join(root, 'c'))).has('.c'));
    assert.ok(!(await extensions(join(root, 'c'))).has('.py'));
  },
);

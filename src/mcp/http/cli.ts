import { DEFAULT_SETTINGS } from '../../settings/index.js';
import type { Settings } from '../../settings/index.js';
import { loadHttpConfig } from './config.js';
import { startHttpServer } from './server.js';

/** Foreground HTTP transport selected by the unified MCP command. `settings` is the user's
 * settings file, already loaded once by the caller; flags beat it. */
export async function runHttpCli(
  args: readonly string[],
  settings: Settings = DEFAULT_SETTINGS,
): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    process.stderr.write(
      'Usage: open-decomp mcp start --transport http --config ABSOLUTE_JSON_PATH [--analysis-cache|--no-analysis-cache] [--no-open-job] [--unit-store-mib N] [--settings PATH]\n--no-analysis-cache: server-wide, read and write no derived analysis (see mcp start --help).\n--no-open-job: server-wide, project_open does not run the open-time job (see mcp start --help).\n--unit-store-mib N: server-wide byte cap per project on persisted callee units (see mcp start --help).\n--analysis-cache: server-wide, keep analysis caching on even if the settings file disables it.\n--settings PATH: user settings file (default $XDG_CONFIG_HOME/open-decomp/settings.json). Loaded once; analysis_cache and decompile.language/view/inference are server-wide defaults (a request argument wins). cache_root does not apply: each principal keeps its projects under its configured project_root.\nMandatory private hashed-bearer configuration; default 127.0.0.1:3000/mcp. Native TLS is required off loopback. See docs/REMOTE.md.\n',
    );
    return;
  }
  const enabled = args.filter((argument) => argument === '--analysis-cache').length;
  const disabled = args.filter((argument) => argument === '--no-analysis-cache').length;
  const noOpenJob = args.filter((argument) => argument === '--no-open-job').length;
  const unitStore = args.indexOf('--unit-store-mib');
  const unitStoreMib = unitStore < 0 ? undefined : args[unitStore + 1];
  if (
    unitStore >= 0 &&
    (args.lastIndexOf('--unit-store-mib') !== unitStore ||
      !/^[1-9][0-9]{0,6}$/.test(unitStoreMib ?? '') ||
      Number(unitStoreMib) > 1_048_576)
  )
    throw new Error('--unit-store-mib must be an integer from 1 to 1048576');
  const rest = args.filter(
    (argument, index) =>
      argument !== '--analysis-cache' &&
      argument !== '--no-analysis-cache' &&
      argument !== '--no-open-job' &&
      (unitStore < 0 || (index !== unitStore && index !== unitStore + 1)),
  );
  if (
    noOpenJob > 1 ||
    enabled > 1 ||
    disabled > 1 ||
    (enabled > 0 && disabled > 0) ||
    rest.length !== 2 ||
    rest[0] !== '--config' ||
    !rest[1] ||
    rest[1].startsWith('--') ||
    rest[1].includes('\0')
  )
    throw new Error('Expected --config ABSOLUTE_JSON_PATH');
  const analysisCache = disabled > 0 ? false : enabled > 0 ? true : settings.analysis_cache;
  if (settings.cache_root !== null)
    process.stderr.write(
      'open-decomp mcp start: settings key "cache_root" does not apply to --transport http; each principal keeps its projects under its configured project_root\n',
    );
  const server = await startHttpServer(
    await loadHttpConfig(rest[1]),
    {
      ...(analysisCache ? {} : { analysis_cache: false }),
      ...(unitStoreMib === undefined
        ? {}
        : { native_summary_bytes: Number(unitStoreMib) * 1024 * 1024 }),
      open_job: noOpenJob > 0 ? false : {},
    },
    {
      decompile: {
        language: settings.decompile.language,
        view: settings.decompile.view,
        inference: settings.decompile.inference,
      },
    },
  );
  const stop = (): void => {
    void server.close().then(
      () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      },
      () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        process.stderr.write(
          'open-decomp mcp start: shutdown failed after releasing owned resources\n',
        );
        process.exitCode = 1;
      },
    );
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.stderr.write(`open-decomp mcp start: listening on ${server.url.href}\n`);
}

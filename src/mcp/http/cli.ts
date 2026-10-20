import { loadHttpConfig } from './config.js';
import { startHttpServer } from './server.js';

/** Foreground HTTP transport selected by the unified MCP command. */
export async function runHttpCli(args: readonly string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    process.stderr.write(
      'Usage: open-decomp mcp start --transport http --config ABSOLUTE_JSON_PATH [--no-analysis-cache]\n--no-analysis-cache: server-wide, read and write no derived analysis (see mcp start --help).\nMandatory private hashed-bearer configuration; default 127.0.0.1:3000/mcp. Native TLS is required off loopback. See docs/REMOTE.md.\n',
    );
    return;
  }
  const analysisCache = !args.includes('--no-analysis-cache');
  const rest = args.filter((argument) => argument !== '--no-analysis-cache');
  if (
    args.length - rest.length > 1 ||
    rest.length !== 2 ||
    rest[0] !== '--config' ||
    !rest[1] ||
    rest[1].startsWith('--') ||
    rest[1].includes('\0')
  )
    throw new Error('Expected --config ABSOLUTE_JSON_PATH');
  const server = await startHttpServer(
    await loadHttpConfig(rest[1]),
    analysisCache ? {} : { analysis_cache: false },
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

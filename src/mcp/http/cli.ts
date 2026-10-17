import { loadHttpConfig } from './config.js';
import { startHttpServer } from './server.js';

/** Foreground HTTP transport selected by the unified MCP command. */
export async function runHttpCli(args: readonly string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    process.stderr.write('Usage: open-decomp mcp start --transport http --config ABSOLUTE_JSON_PATH\nMandatory private hashed-bearer configuration; default 127.0.0.1:3000/mcp. Native TLS is required off loopback. See REMOTE.md.\n');
    return;
  }
  if (args.length !== 2 || args[0] !== '--config' || !args[1] || args[1].startsWith('--') || args[1].includes('\0')) throw new Error('Expected --config ABSOLUTE_JSON_PATH');
  const server = await startHttpServer(await loadHttpConfig(args[1]));
  const stop = (): void => {
    void server.close().then(() => {
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
    }, () => {
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      process.stderr.write('open-decomp mcp start: shutdown failed after releasing owned resources\n');
      process.exitCode = 1;
    });
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  process.stderr.write(`open-decomp mcp start: listening on ${server.url.href}\n`);
}

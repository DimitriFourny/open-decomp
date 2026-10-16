import { serveStdio, StdioServerTransport, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { QueryService } from '../service/queries/index.js';
import type { WorkerPoolOptions } from '../workers/index.js';
import { createMcpServer } from './server.js';

export const MCP_VERSION = '0.1.0';
export const MAX_MCP_INPUT_BYTES = 2 * 1024 * 1024;

const HELP = `Usage: open-decomp-mcp --root PATH [--root PATH ...] [--max-workers N] [--max-queued N]

Serve the local analysis engine over MCP stdio. At least one explicit authorized
filesystem root is required; no working-directory or home-directory root is added.
Imported targets are analyzed as data and are never executed. Worker processes are
fault containment, not an operating-system sandbox.

  --root PATH       Authorize an existing directory (repeatable, at most 64)
  --max-workers N   Persistent project workers (1..32; default 2)
  --max-queued N    Queued jobs per worker (0..1024; default 16)
  --help            Print this help to stderr
  --version         Print the server version to stderr
`;

type CliOptions = { action: 'serve'; pool: WorkerPoolOptions } | { action: 'help' | 'version' };

export function parseCliArguments(args: readonly string[]): CliOptions {
  const roots: string[] = [];
  let max_workers: number | undefined, max_queued: number | undefined;
  let action: 'serve' | 'help' | 'version' = 'serve';
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === '--help' || flag === '--version') {
      if (action !== 'serve') throw new Error('Specify --help or --version only once');
      action = flag === '--help' ? 'help' : 'version';
      continue;
    }
    if (flag !== '--root' && flag !== '--max-workers' && flag !== '--max-queued') throw new Error('Unknown CLI argument');
    const value = args[++index];
    if (!value || value.startsWith('--') || value.includes('\0')) throw new Error(`Missing or malformed value for ${flag}`);
    if (flag === '--root') {
      if (roots.length === 64) throw new Error('At most 64 authorized roots are permitted');
      roots.push(value);
      continue;
    }
    if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Expected an integer for ${flag}`);
    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit < (flag === '--max-workers' ? 1 : 0) || limit > (flag === '--max-workers' ? 32 : 1024)) throw new Error(`Invalid resource limit for ${flag}`);
    if (flag === '--max-workers') {
      if (max_workers !== undefined) throw new Error('Duplicate --max-workers');
      max_workers = limit;
    } else {
      if (max_queued !== undefined) throw new Error('Duplicate --max-queued');
      max_queued = limit;
    }
  }
  if (action !== 'serve') return { action };
  if (!roots.length) throw new Error('At least one explicit --root PATH is required');
  return { action, pool: { authorized_roots: roots, ...(max_workers === undefined ? {} : { max_workers }), ...(max_queued === undefined ? {} : { max_queued }) } };
}

/** Keep SDK parsing/framing intact while observing every transport-close path. */
class OwnedStdioTransport extends StdioServerTransport {
  readonly #closed: () => void;
  constructor(closed: () => void) {
    super(process.stdin, process.stdout, { maxBufferSize: MAX_MCP_INPUT_BYTES });
    this.#closed = closed;
  }
  override async close(): Promise<void> {
    await super.close();
    // Pausing leaves an oversized writer blocked on an owned pipe. Closing the
    // descriptor releases that writer and lets this single-connection process exit.
    process.stdin.destroy();
    this.#closed();
  }
}

export async function runStdio(args: readonly string[]): Promise<void> {
  const options = parseCliArguments(args);
  if (options.action !== 'serve') {
    process.stderr.write(options.action === 'help' ? HELP : `${MCP_VERSION}\n`);
    return;
  }
  const service = await QueryService.create(options.pool);
  let shutdown: Promise<void> | undefined;
  let handle: StdioServerHandle | undefined;
  let reportedError = false;
  const stop = (): Promise<void> => {
    shutdown ??= Promise.resolve().then(async () => {
      try { await handle?.close(); }
      finally {
        await service.close('cancel');
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      }
    });
    return shutdown;
  };
  const report = (error: unknown): void => {
    process.exitCode = 1;
    if (!reportedError) {
      reportedError = true;
      const message = error instanceof Error ? error.message : 'MCP transport failure';
      process.stderr.write(`open-decomp-mcp: ${message.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 512)}\n`);
    }
  };
  const onSignal = (): void => { void stop().catch(report); };
  const transport = new OwnedStdioTransport(() => { void stop().catch(report); });
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    handle = serveStdio(() => createMcpServer(service), {
      transport,
      onerror: error => { report(error); void stop().catch(report); },
      maxSubscriptions: 16,
    });
  } catch (error) {
    await stop();
    throw error;
  }
}

import {
  serveStdio,
  StdioServerTransport,
  type StdioServerHandle,
} from '@modelcontextprotocol/server/stdio';
import type { JSONRPCMessage } from '@modelcontextprotocol/server';
import { Writable } from 'node:stream';
import { write as writeFd } from 'node:fs';
import { QueryService } from '../service/queries/index.js';
import { DEFAULT_SETTINGS } from '../settings/index.js';
import type { Settings } from '../settings/index.js';
import type { WorkerPoolOptions } from '../workers/index.js';
import { projectDefaults } from './defaults.js';
import type { McpServerDefaults } from './defaults.js';
import { createMcpServer } from './server.js';
import {
  MAX_MCP_INPUT_BYTES,
  MAX_MCP_PENDING_OUTPUTS,
  MAX_MCP_REQUEST_ID_BYTES,
  MAX_MCP_PENDING_REQUESTS,
} from './limits.js';

export const MCP_VERSION = '0.1.0';
const OUTPUT_STALL_MS = 30_000;

/** Test-only knobs for `runStdio`; the shipped CLI always uses the defaults. */
export interface RunStdioOptions {
  /** Deadline for one blocked output write (default 30,000 ms). */
  readonly outputStallMs?: number;
}

const HELP = `Usage: open-decomp mcp start [--transport stdio] --root PATH [--root PATH ...] [--max-workers N] [--max-queued N] [--analysis-cache|--no-analysis-cache] [--settings PATH]

Serve the local analysis engine over MCP stdio. At least one explicit authorized
filesystem root is required; no working-directory or home-directory root is added.
Imported targets are analyzed as data and are never executed. Worker processes are
fault containment, not an operating-system sandbox.

  --root PATH       Authorize an existing directory (repeatable, at most 64)
  --max-workers N   Persistent project workers (1..32; default 2)
  --max-queued N    Queued jobs per worker (0..1024; default 16)
  --no-analysis-cache
                    Server-wide: read and write no derived analysis (published results, reuse
                    candidates, persisted callee summaries) and reuse no in-process summaries.
                    Imports and indexes still persist; results are identical but slower on
                    repetition. An artifact-delivered result is held in memory for the session.
  --analysis-cache  Server-wide: keep analysis caching on even if the settings file sets
                    analysis_cache to false. Not valid together with --no-analysis-cache.
  --settings PATH   Read settings from PATH instead of $XDG_CONFIG_HOME/open-decomp/settings.json
                    (default ~/.config/open-decomp/settings.json). It must exist. Loaded once at
                    startup: analysis_cache is the server-wide default; decompile.language/view
                    apply when a function_decompile request omits options.emitter/view;
                    cache_root (an existing directory inside a --root) lets project_open import
                    omit project_path. A flag or request argument always wins.
  --help            Print this help to stderr
  --version         Print the server version to stderr
`;

type CliOptions =
  | { action: 'serve'; pool: WorkerPoolOptions; defaults: McpServerDefaults }
  | { action: 'help' | 'version' };

/** Parse `mcp start` arguments over the (already loaded) settings: flags beat the file. */
export function parseCliArguments(
  args: readonly string[],
  settings: Settings = DEFAULT_SETTINGS,
): CliOptions {
  const roots: string[] = [];
  let max_workers: number | undefined, max_queued: number | undefined;
  let action: 'serve' | 'help' | 'version' = 'serve';
  let enableCache = false,
    disableCache = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === '--analysis-cache' || flag === '--no-analysis-cache') {
      if (flag === '--analysis-cache' ? enableCache : disableCache)
        throw new Error(`Duplicate ${flag}`);
      if (flag === '--analysis-cache') enableCache = true;
      else disableCache = true;
      if (enableCache && disableCache)
        throw new Error('Specify only one of --analysis-cache and --no-analysis-cache');
      continue;
    }
    if (flag === '--help' || flag === '--version') {
      if (action !== 'serve') throw new Error('Specify --help or --version only once');
      action = flag === '--help' ? 'help' : 'version';
      continue;
    }
    if (flag !== '--root' && flag !== '--max-workers' && flag !== '--max-queued')
      throw new Error('Unknown CLI argument');
    const value = args[++index];
    if (!value || value.startsWith('--') || value.includes('\0'))
      throw new Error(`Missing or malformed value for ${flag}`);
    if (flag === '--root') {
      if (roots.length === 64) throw new Error('At most 64 authorized roots are permitted');
      roots.push(value);
      continue;
    }
    if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Expected an integer for ${flag}`);
    const limit = Number(value);
    if (
      !Number.isSafeInteger(limit) ||
      limit < (flag === '--max-workers' ? 1 : 0) ||
      limit > (flag === '--max-workers' ? 32 : 1024)
    )
      throw new Error(`Invalid resource limit for ${flag}`);
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
  const analysisCache = disableCache ? false : enableCache ? true : settings.analysis_cache;
  return {
    action,
    pool: {
      authorized_roots: roots,
      ...(max_workers === undefined ? {} : { max_workers }),
      ...(max_queued === undefined ? {} : { max_queued }),
      ...(analysisCache ? {} : { analysis_cache: false }),
    },
    defaults: {
      decompile: { language: settings.decompile.language, view: settings.decompile.view },
      ...(settings.cache_root === null
        ? {}
        : { projects: { cache_root: settings.cache_root, authorized_roots: roots } }),
    },
  };
}

/** Keep SDK parsing/framing intact while observing every transport-close path. */
class OwnedStdioTransport extends StdioServerTransport {
  readonly #closed: () => void;
  readonly #output: Writable;
  #pendingOutput = 0;
  #pendingWrite = false;
  #outputTail: Promise<void> = Promise.resolve();
  readonly #requests = new Set<string | number>();
  #closing = false;
  readonly #stallMs: number;
  constructor(closed: () => void, stallMs: number) {
    const output = new Writable({
      // SDK send must await the write callback even for a small blocked frame.
      highWaterMark: 1,
      write: (chunk: Buffer, _encoding, callback) => {
        if (chunk.byteLength > MAX_MCP_INPUT_BYTES) {
          callback(new Error('MCP output frame exceeds 2 MiB'));
          return;
        }
        // POSIX pipes are nonblocking: their stream owns readiness/EAGAIN handling.
        if (process.platform !== 'win32') {
          process.stdout.write(chunk, callback);
          return;
        }
        // Windows process.stdout pipe writes can block the event loop, preventing
        // the stall deadline and owned-worker shutdown from running. Keep the OS
        // write asynchronous; the single SDK send still owns backpressure.
        let offset = 0;
        const written = (error: NodeJS.ErrnoException | null, count: number): void => {
          this.#pendingWrite = false;
          if (error) {
            callback(error);
            return;
          }
          offset += count;
          if (offset === chunk.byteLength) {
            callback();
            return;
          }
          if (count === 0) {
            callback(new Error('MCP output write made no progress'));
            return;
          }
          this.#pendingWrite = true;
          writeFd(1, chunk, offset, chunk.byteLength - offset, null, written);
        };
        this.#pendingWrite = true;
        writeFd(1, chunk, 0, chunk.byteLength, null, written);
      },
    });
    super(process.stdin, output, { maxBufferSize: MAX_MCP_INPUT_BYTES });
    this.#output = output;
    this.#closed = closed;
    this.#stallMs = stallMs;
  }

  accept(message: JSONRPCMessage): boolean {
    if (this.#closing) return false;
    if (
      'id' in message &&
      typeof message.id === 'string' &&
      Buffer.byteLength(message.id) > MAX_MCP_REQUEST_ID_BYTES
    ) {
      throw new Error('MCP request ID exceeds 1,024 bytes');
    }
    if ('method' in message && 'id' in message) {
      if (this.#requests.has(message.id)) throw new Error('MCP request ID is already pending');
      if (this.#requests.size >= MAX_MCP_PENDING_REQUESTS)
        throw new Error(
          'MCP pending request limit exceeded; drain responses before submitting more work',
        );
      this.#requests.add(message.id);
    }
    return true;
  }

  override send(message: JSONRPCMessage): Promise<void> {
    if (this.#pendingOutput >= MAX_MCP_PENDING_OUTPUTS) {
      const error = new Error(
        'MCP output queue limit exceeded; the client is not draining responses',
      );
      this.onerror?.(error);
      void this.close().catch(() => {});
      return Promise.reject(error);
    }
    this.#pendingOutput++;
    // One SDK send owns backpressure listeners at a time. The bounded queue keeps
    // messages, not repeatedly serialized copies, until the previous write drains.
    const sent = this.#outputTail.then(async () => {
      const timer = setTimeout(
        () =>
          this.#output.destroy(new Error(`MCP output stalled for ${this.#stallMs / 1000} seconds`)),
        this.#stallMs,
      );
      try {
        await super.send(message);
      } finally {
        clearTimeout(timer);
      }
    });
    this.#outputTail = sent.catch(() => {});
    return sent.finally(() => {
      this.#pendingOutput--;
      if ('id' in message && message.id !== undefined && !('method' in message))
        this.#requests.delete(message.id);
    });
  }

  override async close(): Promise<void> {
    this.#closing = true;
    await super.close();
    // Pausing leaves an oversized writer blocked on an owned pipe. Closing the
    // descriptor releases that writer and lets this single-connection process exit.
    process.stdin.destroy();
    // EOF can arrive after the peer receives a frame but before its Windows
    // write callback runs. Keep that send and its existing deadline alive.
    if (process.platform === 'win32' && this.#pendingWrite && !this.#output.destroyed)
      await this.#outputTail;
    this.#output.destroy(new Error('MCP connection closed'));
    process.stdout.destroy();
    this.#closed();
  }

  /** Called only after the connection and all owned project workers have closed. */
  exit(): never {
    // Windows fs.write runs a synchronous OS write on libuv's thread pool.
    // Destroy cannot cancel it, and process.exit joins that pool indefinitely.
    // An abandoned write is a failed connection; self-termination on Windows
    // exits with code 1 without joining the pool. Drained connections exit normally.
    if (process.platform === 'win32' && this.#pendingWrite) process.kill(process.pid, 'SIGKILL');
    process.exit();
  }
}

export async function runStdio(
  args: readonly string[],
  testOptions: RunStdioOptions = {},
  settings: Settings = DEFAULT_SETTINGS,
): Promise<void> {
  const options = parseCliArguments(args, settings);
  if (options.action !== 'serve') {
    process.stderr.write(options.action === 'help' ? HELP : `${MCP_VERSION}\n`);
    return;
  }
  const { projects, ...rest } = options.defaults;
  const defaults: McpServerDefaults = {
    ...rest,
    ...(projects === undefined
      ? {}
      : { projects: await projectDefaults(projects.cache_root, projects.authorized_roots) }),
  };
  const service = await QueryService.create(options.pool);
  let shutdown: Promise<void> | undefined;
  let handle: StdioServerHandle | undefined;
  let reportedError = false;
  const stop = (): Promise<void> => {
    shutdown ??= Promise.resolve()
      .then(async () => {
        try {
          await transport.close();
          await handle?.close();
        } finally {
          await service.close('cancel');
          process.off('SIGINT', onSignal);
          process.off('SIGTERM', onSignal);
        }
      })
      .then(
        () => {
          // This entry owns the process. Node stdio can retain a blocked write after
          // destroy; exit only after every worker has released its durable project.
          transport.exit();
        },
        (error) => {
          report(error);
          transport.exit();
        },
      );
    return shutdown;
  };
  const report = (error: unknown): void => {
    process.exitCode = 1;
    if (!reportedError) {
      reportedError = true;
      const message = error instanceof Error ? error.message : 'MCP transport failure';
      process.stderr.write(
        `open-decomp mcp start: ${message.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 512)}\n`,
      );
    }
  };
  const onSignal = (): void => {
    void stop().catch(report);
  };
  const transport = new OwnedStdioTransport(() => {
    void stop().catch(report);
  }, testOptions.outputStallMs ?? OUTPUT_STALL_MS);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    handle = serveStdio(() => createMcpServer(service, { defaults }), {
      transport,
      onerror: (error) => {
        report(error);
        void stop().catch(report);
      },
      maxSubscriptions: 16,
    });
    const receive = transport.onmessage;
    transport.onmessage = (message) => {
      try {
        if (transport.accept(message)) receive?.(message);
      } catch (error) {
        report(error);
        void transport.close().catch(report);
      }
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

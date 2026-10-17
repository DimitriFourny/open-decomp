import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { isAbsolute } from 'node:path';
import type { Socket } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { QueryService } from '../../service/queries/index.js';
import { authorizePath } from '../../workers/paths.js';
import type { WorkerPoolOptions } from '../../workers/index.js';
import { createMcpServer, MCP_MAX_RESULT_BYTES } from '../server.js';
import { MAX_MCP_INPUT_BYTES, MAX_MCP_REQUEST_ID_BYTES } from '../limits.js';
import {
  readBoundedLocalFile,
  resolveHttpConfig,
  type HttpConfig,
  type ResolvedHttpConfig,
} from './config.js';

export interface HttpServerHandle {
  /** Actual bound endpoint (including an operating-system-selected port). */
  readonly url: URL;
  /** Idempotent: stop admission, close exchanges/sockets, settle dispatched calls, cancel remaining queued jobs and release all workers. */
  close(): Promise<void>;
}

class HttpRejection extends Error {
  constructor(readonly status: number) {
    super('HTTP request rejected');
  }
}

/** Fixed-size state per configured identity, never keyed by attacker-selected IPs or tokens. */
class RateBucket {
  #available: number;
  #updated = performance.now();
  constructor(readonly capacity: number) {
    this.#available = capacity;
  }
  take(): boolean {
    const now = performance.now();
    this.#available = Math.min(
      this.capacity,
      this.#available + ((now - this.#updated) * this.capacity) / 60000,
    );
    this.#updated = now;
    if (this.#available < 1) return false;
    this.#available--;
    return true;
  }
}

interface Principal {
  config: ResolvedHttpConfig['principals'][number];
  digest: Buffer;
  service: QueryService;
  handler: McpHttpHandler;
  requests: number;
  controls: number;
  work: number;
  admissions: number;
  requestRate: RateBucket;
  workRate: RateBucket;
}

function readBody(
  request: IncomingMessage,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Buffer<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const timer = setTimeout(() => finish(new HttpRejection(408)), timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      request.off('data', data);
      request.off('end', end);
      request.off('error', error);
      request.off('aborted', aborted);
      signal.removeEventListener('abort', aborted);
    };
    const finish = (reason?: Error): void => {
      cleanup();
      if (reason) {
        request.pause();
        reject(reason);
      } else resolve(Buffer.concat(chunks, length));
    };
    const data = (chunk: Buffer): void => {
      length += chunk.length;
      if (length > MAX_MCP_INPUT_BYTES) finish(new HttpRejection(413));
      else chunks.push(chunk);
    };
    const end = (): void => finish();
    const error = (): void => finish(new HttpRejection(400));
    const aborted = (): void => finish(new HttpRejection(408));
    if (signal.aborted) {
      aborted();
      return;
    }
    request.on('data', data);
    request.once('end', end);
    request.once('error', error);
    request.once('aborted', aborted);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

/** This is a size/shape guard only; all MCP validation and dispatch remains in the official SDK. */
function parseBoundedMessage(body: Buffer): unknown {
  let message: unknown;
  try {
    message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new HttpRejection(400);
  }
  if (!message || typeof message !== 'object' || Array.isArray(message))
    throw new HttpRejection(400);
  if ('id' in message) {
    const id = message.id;
    if (
      !(typeof id === 'string' && Buffer.byteLength(id) <= MAX_MCP_REQUEST_ID_BYTES) &&
      !(typeof id === 'number' && Number.isSafeInteger(id))
    )
      throw new HttpRejection(400);
  }
  if (
    'params' in message &&
    message.params &&
    typeof message.params === 'object' &&
    '_meta' in message.params
  ) {
    const meta = message.params._meta;
    if (meta && typeof meta === 'object' && 'progressToken' in meta) {
      const token = meta.progressToken;
      if (
        !(typeof token === 'string' && Buffer.byteLength(token) <= MAX_MCP_REQUEST_ID_BYTES) &&
        !(typeof token === 'number' && Number.isSafeInteger(token))
      )
        throw new HttpRejection(400);
    }
  }
  // Avoid deeply nested attacker data exhausting validators or JSON serialization stacks.
  const pending: { value: unknown; depth: number }[] = [{ value: message, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 100000 || item.depth > 64) throw new HttpRejection(413);
    if (item.value && typeof item.value === 'object') {
      for (const value of Object.values(item.value)) pending.push({ value, depth: item.depth + 1 });
      if (pending.length > 100000) throw new HttpRejection(413);
    }
  }
  return message;
}

async function writeResponse(
  response: Response,
  output: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  output.statusCode = response.status;
  for (const [key, value] of response.headers) output.setHeader(key, value);
  output.setHeader('cache-control', 'no-store');
  output.setHeader('x-content-type-options', 'nosniff');
  const reader = response.body?.getReader();
  const aborted = (): void => {
    void reader?.cancel().catch(() => {});
  };
  signal.addEventListener('abort', aborted, { once: true });
  let length = 0;
  try {
    if (signal.aborted) throw new HttpRejection(408);
    if (reader) {
      for (;;) {
        const item = await reader.read();
        if (signal.aborted) throw new HttpRejection(408);
        if (item.done) break;
        length += item.value.byteLength;
        if (length > MCP_MAX_RESULT_BYTES + 16384) throw new HttpRejection(413);
        await new Promise<void>((resolve, reject) => {
          const abort = (): void => reject(new HttpRejection(408));
          signal.addEventListener('abort', abort, { once: true });
          output.write(item.value, (error) => {
            signal.removeEventListener('abort', abort);
            if (error) reject(error);
            else resolve();
          });
        });
      }
    }
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => reject(new HttpRejection(408));
      signal.addEventListener('abort', abort, { once: true });
      output.end(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      });
    });
  } finally {
    signal.removeEventListener('abort', aborted);
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}

export async function startHttpServer(
  input: HttpConfig,
  workerRuntime: Pick<WorkerPoolOptions, 'entry_point' | 'exec_argv' | 'cancel_grace_ms'> = {},
): Promise<HttpServerHandle> {
  const config = await resolveHttpConfig(input);
  const principals: Principal[] = [];
  const sockets = new Set<Socket>();
  const requests = new Set<Promise<void>>();
  const work = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  const globalRate = new RateBucket(config.limits.requests_per_minute);
  let closing = false;
  let activeRequests = 0;
  let allowedHosts: readonly string[] = config.allowed_hosts ?? [];
  let closePromise: Promise<void> | undefined;

  function reserveAction(
    principal: Principal,
    control: boolean,
    signal: AbortSignal | undefined,
  ): () => void {
    if (
      closing ||
      signal?.aborted ||
      (control ? principal.controls : principal.work) >= principal.config.max_requests
    )
      throw new Error('Service admission unavailable');
    if (control) principal.controls++;
    else principal.work++;
    let settle!: () => void;
    const completion = new Promise<void>((resolve) => {
      settle = resolve;
    });
    work.add(completion);
    return () => {
      if (control) principal.controls--;
      else principal.work--;
      work.delete(completion);
      settle();
    };
  }

  try {
    for (const principalConfig of config.principals) {
      const service = await QueryService.create({
        ...workerRuntime,
        authorized_roots: [principalConfig.project_root, ...principalConfig.input_roots],
        max_workers: principalConfig.max_workers,
        max_queued: principalConfig.max_queued,
      });
      const principal: Principal = {
        config: principalConfig,
        digest: Buffer.from(principalConfig.token_sha256, 'hex'),
        service,
        requests: 0,
        work: 0,
        controls: 0,
        admissions: 0,
        requestRate: new RateBucket(principalConfig.requests_per_minute),
        workRate: new RateBucket(principalConfig.work_admissions_per_minute),
        handler: createMcpHandler(
          (context) =>
            createMcpServer(service, {
              preserveJobsOnDisconnect: true,
              authorizeResource: async () =>
                reserveAction(principal, false, context.requestInfo?.signal),
              authorizeTool: async (name, args) => {
                const control =
                  name === 'analysis_status' ||
                  name === 'analysis_cancel' ||
                  name === 'project_close';
                const release = reserveAction(principal, control, context.requestInfo?.signal);
                try {
                  for (const key of Object.keys(
                    principal.config.max_budget,
                  ) as (keyof typeof args.budget)[]) {
                    if (args.budget[key] > principal.config.max_budget[key])
                      throw new Error('Requested work budget exceeds principal ceiling');
                  }
                  if (name === 'project_open' && 'source' in args) {
                    if (!isAbsolute(args.source.project_path))
                      throw new Error('Project paths must be absolute');
                    const project = await authorizePath(
                      [principal.config.project_root],
                      args.source.project_path,
                      args.source.kind === 'import' && args.source.mode === 'create',
                    );
                    if (project === principal.config.project_root)
                      throw new Error('Use a project directory below the provisioned root');
                    if (args.source.kind === 'import') {
                      if (!isAbsolute(args.source.input_path))
                        throw new Error('Input paths must be absolute');
                      await authorizePath(principal.config.input_roots, args.source.input_path);
                    }
                  }
                  if (closing || context.requestInfo?.signal.aborted)
                    throw new Error('Exchange closed before authorization');
                  // Control/close operations remain available after a work quota is exhausted.
                  if (!control) {
                    if (
                      principal.admissions >= principal.config.max_work_admissions ||
                      !principal.workRate.take()
                    )
                      throw new Error('Principal work admission quota exhausted');
                    principal.admissions++;
                  }
                  return release;
                } catch (error) {
                  release();
                  throw error;
                }
              },
            }),
          {
            legacy: 'stateless',
            maxRequestBodySize: MAX_MCP_INPUT_BYTES,
            maxSubscriptions: 0,
            keepAliveMs: 0,
          },
        ),
      };
      principals.push(principal);
    }
  } catch (error) {
    await Promise.allSettled(
      principals.flatMap((principal) => [
        principal.handler.close(),
        principal.service.close('cancel'),
      ]),
    );
    throw error;
  }

  async function serve(request: IncomingMessage, output: ServerResponse): Promise<void> {
    const controller = new AbortController();
    controllers.add(controller);
    const abort = (): void => controller.abort();
    output.once('close', abort);
    request.once('aborted', abort);
    // Retain error listeners through late stream destruction; the request/response own their lifetime.
    request.on('error', abort);
    output.on('error', abort);
    const timer = setTimeout(() => {
      controller.abort();
      request.socket.destroy();
    }, config.limits.request_timeout_ms);
    let principal: Principal | undefined;
    let admitted = false;
    try {
      if (closing) throw new HttpRejection(503);
      if (!globalRate.take()) throw new HttpRejection(429);
      if (request.rawHeaders.length / 2 > config.limits.header_count) throw new HttpRejection(431);
      const seen = new Set<string>();
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index]!.toLowerCase();
        if (seen.has(name)) throw new HttpRejection(400);
        seen.add(name);
      }
      if (!request.headers.host || !allowedHosts.includes(request.headers.host))
        throw new HttpRejection(403);
      const origin = request.headers.origin;
      if (origin !== undefined && !config.allowed_origins.includes(origin))
        throw new HttpRejection(403);
      if (request.url !== '/mcp') throw new HttpRejection(404);
      const authorization = request.headers.authorization;
      const match = authorization && /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(authorization);
      if (!match) throw new HttpRejection(401);
      const digest = createHash('sha256').update(match[1]!).digest();
      // Visit every configured principal; no secret-dependent prefix comparison or early exit.
      for (const candidate of principals)
        if (timingSafeEqual(candidate.digest, digest)) principal = candidate;
      if (!principal) throw new HttpRejection(401);
      if (!principal.requestRate.take()) throw new HttpRejection(429);
      if (
        activeRequests >= config.limits.max_requests ||
        principal.requests >= principal.config.max_requests
      )
        throw new HttpRejection(429);
      activeRequests++;
      principal.requests++;
      admitted = true;
      if (request.method !== 'POST') throw new HttpRejection(405);
      if (request.headers['content-encoding'] !== undefined || request.headers.expect !== undefined)
        throw new HttpRejection(415);
      if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] ?? ''))
        throw new HttpRejection(415);
      const contentLength = request.headers['content-length'];
      if (contentLength !== undefined && !/^\d+$/.test(contentLength)) throw new HttpRejection(413);
      // Enforce size while consuming the bounded body. Closing solely from its
      // advertised length can reset an in-flight upload before 413 reaches it.
      const body = await readBody(request, controller.signal, config.limits.body_timeout_ms);
      const parsedBody = parseBoundedMessage(body);
      const headers = new Headers();
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const key = request.rawHeaders[index]!;
        if (key.toLowerCase() !== 'authorization') headers.set(key, request.rawHeaders[index + 1]!);
      }
      const sdkRequest = new Request(
        `${config.tls ? 'https' : 'http'}://${request.headers.host}/mcp`,
        {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        },
      );
      const fetching = principal.handler.fetch(sdkRequest, { parsedBody });
      void fetching.then(
        (response) => {
          if (controller.signal.aborted) void response.body?.cancel().catch(() => {});
        },
        () => {},
      );
      let rejectAborted!: () => void;
      const interrupted = new Promise<never>((_resolve, reject) => {
        rejectAborted = () => reject(new HttpRejection(408));
        controller.signal.addEventListener('abort', rejectAborted, { once: true });
        if (controller.signal.aborted) rejectAborted();
      });
      try {
        await writeResponse(await Promise.race([fetching, interrupted]), output, controller.signal);
      } finally {
        controller.signal.removeEventListener('abort', rejectAborted);
      }
    } catch (error) {
      if (!output.headersSent && !output.destroyed) {
        const status = error instanceof HttpRejection ? error.status : 500;
        output.writeHead(status, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'close',
          ...(status === 401 ? { 'www-authenticate': 'Bearer realm="open-decomp"' } : {}),
          ...(status === 429 ? { 'retry-after': '1' } : {}),
          ...(status === 405 ? { allow: 'POST' } : {}),
        });
        output.end(`Request rejected (${status})\n`);
      } else output.destroy();
    } finally {
      clearTimeout(timer);
      output.off('close', abort);
      request.off('aborted', abort);
      controller.abort();
      controllers.delete(controller);
      if (admitted) {
        activeRequests--;
        principal!.requests--;
      }
    }
  }

  let server: HttpServer | HttpsServer;
  try {
    const options = {
      maxHeaderSize: config.limits.header_bytes,
      headersTimeout: config.limits.body_timeout_ms,
      requestTimeout: config.limits.request_timeout_ms,
      keepAliveTimeout: config.limits.idle_timeout_ms,
    };
    server = config.tls
      ? createTlsServer({
          ...options,
          cert: await readBoundedLocalFile(config.tls.cert_path, 262144),
          key: await readBoundedLocalFile(config.tls.key_path, 65536),
          minVersion: 'TLSv1.2',
          handshakeTimeout: config.limits.body_timeout_ms,
        })
      : createServer(options);
    server.maxHeadersCount = config.limits.header_count + 1;
    server.maxRequestsPerSocket = 100;
    server.on('connection', (socket) => {
      if (closing || sockets.size >= config.limits.max_connections) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.setTimeout(config.limits.idle_timeout_ms, () => socket.destroy());
      // A hard connection lifetime bounds slow header drips as well as keep-alive reuse.
      const lifetime = setTimeout(() => socket.destroy(), config.limits.request_timeout_ms);
      socket.once('close', () => {
        clearTimeout(lifetime);
        sockets.delete(socket);
      });
    });
    server.on('request', (request, response) => {
      const task = serve(request, response);
      requests.add(task);
      void task.finally(() => requests.delete(task));
    });
    server.on('checkContinue', (request, response) => {
      // No 100 response is sent before authentication; normal guards reject Expect.
      const task = serve(request, response);
      requests.add(task);
      void task.finally(() => requests.delete(task));
    });
    server.on('checkExpectation', (request, response) => {
      const task = serve(request, response);
      requests.add(task);
      void task.finally(() => requests.delete(task));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    await Promise.allSettled(
      principals.flatMap((principal) => [
        principal.handler.close(),
        principal.service.close('cancel'),
      ]),
    );
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listening address');
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  const url = new URL(`${config.tls ? 'https' : 'http'}://${host}:${address.port}/mcp`);
  allowedHosts = config.allowed_hosts ?? [url.host];

  return {
    url,
    close() {
      closePromise ??= (async () => {
        closing = true;
        const stopped = new Promise<void>((resolve, reject) =>
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          }),
        );
        for (const controller of controllers) controller.abort();
        for (const socket of sockets) socket.destroy();
        const outcomes = await Promise.allSettled(
          principals.map((principal) => principal.handler.close()),
        );
        await Promise.allSettled([...requests]);
        // Dispatched wait:true calls retain ownership; their configured budgets bound this wait.
        await Promise.allSettled([...work]);
        const services = await Promise.allSettled(
          principals.map((principal) => principal.service.close('cancel')),
        );
        await stopped;
        for (const result of [...outcomes, ...services])
          if (result.status === 'rejected') throw result.reason;
      })();
      return closePromise;
    },
  };
}

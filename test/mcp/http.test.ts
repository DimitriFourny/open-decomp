import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  DEFAULT_BUDGET,
  newIdentity,
  toolNameSchema,
  validateToolRequest,
  validateToolResponse,
} from '../../src/core/index.js';
import type { ToolInput, ToolName, ToolResult } from '../../src/core/index.js';
import type { WorkerPoolOptions } from '../../src/workers/index.js';
import { startHttpServer } from '../../src/mcp/http/server.js';
import { loadHttpConfig, resolveHttpConfig, type HttpConfig } from '../../src/mcp/http/config.js';
import { artifactUri } from '../../src/mcp/resources.js';
import { MAX_MCP_INPUT_BYTES, MAX_MCP_REQUEST_ID_BYTES } from '../../src/mcp/limits.js';
import { resumeWorker, waitForWorkerPause } from '../workers/gate.js';

const fixtures = resolve('fixtures/bin');
const pauseEntry = new URL(
  import.meta.url.endsWith('.ts') ? '../workers/pause-running.ts' : '../workers/pause-running.js',
  import.meta.url,
);
const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });

async function setup(
  t: TestContext,
  options: {
    principal?: Partial<HttpConfig['principals'][number]>;
    limits?: HttpConfig['limits'];
    tls?: boolean;
    worker?: Pick<WorkerPoolOptions, 'entry_point' | 'exec_argv' | 'cancel_grace_ms'>;
  } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-http-')));
  const aliceRoot = join(root, 'alice'),
    bobRoot = join(root, 'bob'),
    inputRoot = join(root, 'input');
  await Promise.all([aliceRoot, bobRoot, inputRoot].map((path) => mkdir(path)));
  const tokens = [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')];
  const config: HttpConfig = {
    port: 0,
    limits: { idle_timeout_ms: 60000, request_timeout_ms: 120000, ...options.limits },
    ...(options.tls
      ? {
          tls: {
            cert_path: resolve('test/mcp/http-test-cert.pem'),
            key_path: resolve('test/mcp/http-test-key.pem'),
          },
        }
      : {}),
    principals: ['alice', 'bob'].map((id, index) => ({
      id,
      token_sha256: createHash('sha256').update(tokens[index]!).digest('hex'),
      project_root: index === 0 ? aliceRoot : bobRoot,
      input_roots: [fixtures, inputRoot],
      requests_per_minute: 1000,
      work_admissions_per_minute: 1000,
      ...(index === 0 ? options.principal : {}),
    })),
  };
  const clients: Client[] = [];
  const server = await startHttpServer(config, options.worker);
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  const tlsCa = options.tls ? await readFile(resolve('test/mcp/http-test-cert.pem')) : undefined;
  // A real native HTTPS fetch adapter supplies a private test CA without disabling certificate verification.
  const nativeTlsFetch: typeof fetch = async (input, init) => {
    const outgoing = new Request(input, init);
    const bytes = Buffer.from(await outgoing.arrayBuffer());
    return new Promise<Response>((resolveResponse, reject) => {
      const request = httpsRequest(
        outgoing.url,
        {
          method: outgoing.method,
          headers: Object.fromEntries(outgoing.headers),
          ca: tlsCa,
          signal: outgoing.signal,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('error', reject);
          response.on('end', () => {
            const headers = new Headers();
            for (let index = 0; index < response.rawHeaders.length; index += 2)
              headers.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
            resolveResponse(
              new Response(response.statusCode === 204 ? null : Buffer.concat(chunks), {
                status: response.statusCode!,
                headers,
              }),
            );
          });
        },
      );
      request.on('error', reject);
      request.end(bytes);
    });
  };
  async function client(index = 0): Promise<Client> {
    const result = new Client(
      { name: 'real-http-security-client', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    clients.push(result);
    await result.connect(
      new StreamableHTTPClientTransport(server.url, {
        requestInit: { headers: { authorization: `Bearer ${tokens[index]!}` } },
        ...(options.tls ? { fetch: nativeTlsFetch } : {}),
      }),
    );
    return result;
  }
  async function post(
    body = ping,
    headers: Record<string, string> = {},
    index = 0,
  ): Promise<Response> {
    return fetch(server.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens[index]!}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body,
    });
  }
  return {
    server,
    config,
    root,
    aliceRoot,
    bobRoot,
    inputRoot,
    tokens,
    client,
    post,
    nativeTlsFetch,
  };
}

async function call<K extends ToolName>(
  client: Client,
  name: K,
  input: ToolInput<K>,
): Promise<ToolResult<K>> {
  // Decompilations request the full envelope; text-first delivery is covered by server.test.ts.
  const response = await client.callTool({
    name,
    arguments: {
      ...(name === 'function_decompile' ? { detail: 'full' } : {}),
      ...(input as Record<string, unknown>),
    },
  });
  return validateToolResponse(name, response.structuredContent, validateToolRequest(name, input));
}

for (const fixture of [
  { name: 'macho-arm64-symbols', address: '0x100000574' },
  { name: 'corpus-stripped.dll', address: '0x180001030' },
])
  test(
    `actual SDK HTTP investigation, identity isolation and reopen: ${fixture.name}`,
    { timeout: 120000 },
    async (t) => {
      const { client, aliceRoot, bobRoot } = await setup(t);
      const alice = await client(),
        bob = await client(1);
      assert.deepEqual(
        (await alice.listTools()).tools.map((tool) => tool.name),
        toolNameSchema.options,
      );
      const path = join(aliceRoot, 'investigation');
      const opened = await call(alice, 'project_open', {
        wait: true,
        source: { kind: 'import', input_path: join(fixtures, fixture.name), project_path: path },
      });
      assert.ok(
        'data' in opened &&
          opened.data.image &&
          opened.project_id !== null &&
          opened.revision !== null,
      );
      const image = opened.data.image,
        scope = { project_id: opened.project_id, revision: opened.revision };
      const functions = await call(alice, 'functions_find', {
        ...scope,
        image_id: image.id,
        address: { image_id: image.id, space: 'va', value: fixture.address },
      });
      assert.ok('data' in functions);
      const fn = functions.data.items.find(
        (item) => item.entry.value.toLowerCase() === fixture.address,
      );
      assert.ok(fn);
      for (const view of ['summary', 'sections', 'mappings', 'entry_points'] as const)
        assert.ok('data' in (await call(alice, 'binary_info', { ...scope, view })));
      assert.ok('data' in (await call(alice, 'symbols_find', { ...scope, image_id: image.id })));
      assert.ok('data' in (await call(alice, 'strings_find', { ...scope, image_id: image.id })));
      assert.ok(
        'data' in (await call(alice, 'memory_read', { ...scope, address: fn.entry, length: 16 })),
      );
      assert.ok(
        'data' in
          (await call(alice, 'xrefs_get', { ...scope, target: { kind: 'entity', id: fn.id } })),
      );
      for (const view of ['metadata', 'disassembly', 'cfg'] as const)
        assert.ok(
          'data' in (await call(alice, 'function_get', { ...scope, function_id: fn.id, view })),
        );
      const decompiled = await call(alice, 'function_decompile', {
        ...scope,
        function_id: fn.id,
        wait: true,
      });
      assert.ok('data' in decompiled);
      const artifact = decompiled.artifacts[0];
      assert.ok(artifact);
      const page = await alice.readResource({ uri: artifactUri(artifact) });
      assert.ok(
        page.contents[0] && 'text' in page.contents[0] && page.contents[0].text.includes(fn.id),
      );
      await assert.rejects(bob.readResource({ uri: artifactUri(artifact) }));
      const denied = await call(bob, 'binary_info', scope);
      assert.equal(denied.state, 'failed');
      if (denied.state === 'failed') assert.equal(denied.error.code, 'not_found');
      for (const project_path of [path, join(aliceRoot, 'stolen')]) {
        const response = await bob.callTool({
          name: 'project_open',
          arguments: { source: { kind: 'resume', project_path } },
        });
        assert.equal(response.isError, true);
      }
      const forbiddenImport = await bob.callTool({
        name: 'project_open',
        arguments: {
          source: {
            kind: 'import',
            project_path: join(bobRoot, 'stolen-input'),
            input_path: join(path, 'project.sqlite'),
          },
        },
      });
      assert.equal(forbiddenImport.isError, true);
      await assert.rejects(stat(join(bobRoot, 'stolen-input')));
      const annotation = newIdentity('annotation');
      const edited = await call(alice, 'annotations_apply', {
        project_id: scope.project_id,
        expected_revision: scope.revision,
        author: 'remote-client',
        origin: 'llm',
        edits: [
          {
            operation: 'set',
            id: annotation,
            entity_id: fn.id,
            status: 'hypothesis',
            evidence_ids: [],
            value: {
              kind: 'note',
              value: 'Remote evidence remains an assertion, not a machine fact.',
            },
          },
        ],
      });
      assert.ok('data' in edited && edited.revision === scope.revision + 1);
      const reanalyzed = await call(alice, 'function_decompile', {
        ...scope,
        revision: edited.revision,
        function_id: fn.id,
        wait: true,
      });
      assert.ok('data' in reanalyzed && reanalyzed.artifacts[0]?.id !== artifact.id);
      await call(alice, 'project_close', { ...scope, revision: edited.revision });
      await alice.close();
      const reconnected = await client();
      const reopened = await call(reconnected, 'project_open', {
        source: { kind: 'resume', project_path: path },
      });
      assert.equal(reopened.project_id, scope.project_id);
      assert.equal(reopened.revision, edited.revision);
      const metadata = await call(reconnected, 'function_get', {
        ...scope,
        revision: edited.revision,
        function_id: fn.id,
      });
      assert.ok('data' in metadata && metadata.data.view === 'metadata');
      assert.equal(metadata.data.annotations[0]?.id, annotation);
    },
  );

test(
  'every method requires identity and exact Host/Origin; malformed requests fail before dispatch',
  { timeout: 30000 },
  async (t) => {
    const { server, post, tokens } = await setup(t);
    for (const method of ['POST', 'GET', 'DELETE', 'OPTIONS', 'PUT']) {
      const unauthenticated = await fetch(server.url, { method });
      assert.equal(unauthenticated.status, 401);
      await unauthenticated.text();
      // Native fetch replaces Host; use the HTTP client to put the hostile authority on the wire.
      const hostile = await new Promise<number>((resolveStatus, reject) => {
        const request = httpRequest(
          server.url,
          { method, headers: { host: 'attacker.invalid', authorization: `Bearer ${tokens[0]!}` } },
          (response) => {
            response.on('error', reject);
            response.once('end', () => resolveStatus(response.statusCode!));
            response.resume();
          },
        );
        request.on('error', reject);
        request.end();
      });
      assert.equal(hostile, 403);
    }
    for (const origin of [
      'null',
      'https://attacker.invalid',
      server.url.origin,
      `${server.url.origin}/path`,
    ]) {
      const response = await post(ping, { origin });
      assert.equal(response.status, 403);
      await response.text();
    }
    for (const authorization of [
      '',
      'Basic abc',
      `Bearer ${randomBytes(32).toString('base64url')}`,
      'Bearer short',
    ]) {
      const response = await post(ping, { authorization });
      assert.equal(response.status, 401);
      await response.text();
    }
    for (const body of [
      '{',
      '[]',
      'null',
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'x'.repeat(MAX_MCP_REQUEST_ID_BYTES + 1),
        method: 'ping',
      }),
      JSON.stringify({ jsonrpc: '2.0', id: 1.5, method: 'ping' }),
    ]) {
      const response = await post(body);
      assert.equal(response.status, 400);
      await response.text();
    }
    const oversized = await post(' '.repeat(MAX_MCP_INPUT_BYTES + 1));
    assert.equal(oversized.status, 413);
    await oversized.text();
    const compressed = await post(ping, { 'content-encoding': 'gzip' });
    assert.equal(compressed.status, 415);
    await compressed.text();
    const wrongType = await post(ping, { 'content-type': 'text/plain' });
    assert.equal(wrongType.status, 415);
    await wrongType.text();
    const hugeHeader = await post(ping, { 'x-abuse': 'x'.repeat(32768) });
    assert.equal(hugeHeader.status, 431);
    await hugeHeader.text();
    const healthy = await post();
    assert.equal(healthy.status, 200);
    await healthy.text();
  },
);

test(
  'strict canonical root/configuration rules reject aliasing and project-to-input leaks',
  { timeout: 30000 },
  async (t) => {
    const { config, root, aliceRoot, bobRoot, inputRoot, client } = await setup(t);
    await assert.rejects(resolveHttpConfig({ ...config, host: '0.0.0.0' }), /TLS/);
    await assert.rejects(resolveHttpConfig({ ...config, unknown: true } as HttpConfig));
    await assert.rejects(
      resolveHttpConfig({
        ...config,
        principals: [
          config.principals[0]!,
          { ...config.principals[1]!, token_sha256: config.principals[0]!.token_sha256 },
        ],
      }),
      /unique/,
    );
    await assert.rejects(
      resolveHttpConfig({
        ...config,
        principals: [config.principals[0]!, { ...config.principals[1]!, input_roots: [root] }],
      }),
      /disjoint/,
    );
    const alias = join(root, 'alias');
    await symlink(aliceRoot, alias, 'junction');
    await assert.rejects(
      resolveHttpConfig({
        ...config,
        principals: [config.principals[0]!, { ...config.principals[1]!, project_root: alias }],
      }),
      /disjoint/,
    );
    const escape = join(aliceRoot, 'escape');
    await symlink(bobRoot, escape, 'junction');
    const alice = await client();
    const denied = await alice.callTool({
      name: 'project_open',
      arguments: {
        source: {
          kind: 'import',
          input_path: join(fixtures, 'macho-arm64-symbols'),
          project_path: join(escape, 'outside'),
        },
      },
    });
    assert.equal(denied.isError, true);
    await assert.rejects(stat(join(bobRoot, 'outside')));
    const inputEscape = join(inputRoot, 'private');
    await symlink(bobRoot, inputEscape, 'junction');
    await writeFile(join(bobRoot, 'secret'), 'private');
    const inputDenied = await alice.callTool({
      name: 'project_open',
      arguments: {
        source: {
          kind: 'import',
          input_path: join(inputEscape, 'secret'),
          project_path: join(aliceRoot, 'input-escape'),
        },
      },
    });
    assert.equal(inputDenied.isError, true);
    await assert.rejects(stat(join(aliceRoot, 'input-escape')));
    const configPath = join(root, 'http.json');
    await writeFile(configPath, JSON.stringify(config));
    assert.equal((await loadHttpConfig(configPath)).principals[0]!.id, 'alice');
    await assert.rejects(loadHttpConfig('relative.json'));
    await writeFile(configPath, ' '.repeat(262145));
    await assert.rejects(loadHttpConfig(configPath), /byte limit/);
  },
);

test(
  'native TLS is verified by an actual SDK client and transport shutdown closes the listener',
  { timeout: 30000 },
  async (t) => {
    const { client, server, nativeTlsFetch, tokens } = await setup(t, { tls: true });
    const sdk = await client();
    assert.equal((await sdk.listTools()).tools.length, toolNameSchema.options.length);
    await assert.rejects(fetch(server.url), 'the private test CA is not implicitly trusted');
    const denied = await nativeTlsFetch(server.url, {
      method: 'POST',
      body: ping,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tokens[1]!}`,
        origin: 'null',
      },
    });
    assert.equal(denied.status, 403);
    await sdk.close();
    await server.close();
    await server.close();
    await assert.rejects(nativeTlsFetch(server.url));
  },
);

test(
  'fixed per-principal request rate does not let another principal spend its quota',
  { timeout: 30000 },
  async (t) => {
    const { post } = await setup(t, { principal: { requests_per_minute: 1 } });
    const first = await post();
    assert.equal(first.status, 200);
    await first.text();
    const limited = await post();
    assert.equal(limited.status, 429);
    await limited.text();
    const independent = await post(ping, {}, 1);
    assert.equal(independent.status, 200);
    await independent.text();
  },
);

test(
  'durable gated admission survives reconnect, rejects cross-principal jobs and leaves cancellation available after quota exhaustion',
  { timeout: 60000 },
  async (t) => {
    const { client, aliceRoot } = await setup(t, {
      principal: { max_work_admissions: 1, max_workers: 1, max_queued: 0 },
      worker: { entry_point: pauseEntry, cancel_grace_ms: 10 },
    });
    const alice = await client(),
      bob = await client(1);
    const opened = await call(alice, 'project_open', {
      source: {
        kind: 'import',
        input_path: join(fixtures, 'macho-arm64-symbols'),
        project_path: join(aliceRoot, 'gated'),
      },
    });
    assert.equal(opened.state, 'queued');
    if (opened.state !== 'queued') assert.fail('Expected durable admission');
    await waitForWorkerPause(opened.job.id, t);
    await alice.close();
    const reconnected = await client();
    const scope = {
      project_id: opened.project_id!,
      revision: opened.revision!,
      job_id: opened.job.id,
    };
    const status = await call(reconnected, 'analysis_status', scope);
    assert.ok('data' in status && ['queued', 'running'].includes(status.data.job.state));
    for (const name of ['analysis_status', 'analysis_cancel'] as const) {
      const denied = await call(bob, name, scope);
      assert.equal(denied.state, 'failed');
      if (denied.state === 'failed') assert.equal(denied.error.code, 'not_found');
    }
    const exhausted = await reconnected.callTool({
      name: 'binary_info',
      arguments: { project_id: scope.project_id, revision: scope.revision },
    });
    assert.equal(exhausted.isError, true);
    const cancelled = await call(reconnected, 'analysis_cancel', scope);
    assert.ok('data' in cancelled && cancelled.data.job.state === 'cancelled');
    const closed = await call(reconnected, 'project_close', {
      project_id: scope.project_id,
      revision: cancelled.data.known_revision,
    });
    assert.ok('data' in closed && closed.data.closed);
  },
);

test(
  'wait:true disconnect releases HTTP slots but preserves authorized work until explicit cancellation',
  { timeout: 60000 },
  async (t) => {
    const { client, aliceRoot, post } = await setup(t, {
      limits: { max_requests: 1 },
      principal: { max_requests: 1 },
      worker: { entry_point: pauseEntry, cancel_grace_ms: 10 },
    });
    const alice = await client();
    let entered!: (job: { project_id: string; job_id: string }) => void;
    const admission = new Promise<{ project_id: string; job_id: string }>((resolve) => {
      entered = resolve;
    });
    const pending = alice.callTool(
      {
        name: 'project_open',
        arguments: {
          wait: true,
          source: {
            kind: 'import',
            input_path: join(fixtures, 'macho-arm64-symbols'),
            project_path: join(aliceRoot, 'waiting'),
          },
        },
      },
      {
        onprogress: (progress) => {
          if (progress.message) {
            const message = JSON.parse(progress.message) as { project_id: string; job_id: string };
            entered(message);
          }
        },
      },
    );
    void pending.catch(() => {});
    const identity = await admission;
    await waitForWorkerPause(identity.job_id, t);
    const concurrent = await post();
    assert.equal(concurrent.status, 429);
    await concurrent.text();
    const globalConcurrent = await post(ping, {}, 1);
    assert.equal(globalConcurrent.status, 429);
    await globalConcurrent.text();
    // The peer's progress proves admission before this disconnect; no wall-clock sleep or mock worker.
    await alice.close();
    await assert.rejects(pending);
    const reconnected = await client();
    const scope = { project_id: identity.project_id, revision: 0, job_id: identity.job_id };
    const status = await call(reconnected, 'analysis_status', scope);
    assert.ok('data' in status && ['queued', 'running'].includes(status.data.job.state));
    const cancelled = await call(reconnected, 'analysis_cancel', scope);
    assert.ok('data' in cancelled && cancelled.data.job.state === 'cancelled');
  },
);

test(
  'gated asynchronous work is cancelled at full shutdown and the same project can be reopened by a new server',
  { timeout: 60000 },
  async (t) => {
    const { client, server, config, aliceRoot, tokens } = await setup(t, {
      worker: { entry_point: pauseEntry, cancel_grace_ms: 10 },
    });
    const sdk = await client(),
      path = join(aliceRoot, 'shutdown');
    const opened = await call(sdk, 'project_open', {
      source: {
        kind: 'import',
        input_path: join(fixtures, 'macho-arm64-symbols'),
        project_path: path,
      },
    });
    assert.equal(opened.state, 'queued');
    if (opened.state !== 'queued') assert.fail('Expected queued import');
    await waitForWorkerPause(opened.job.id, t);
    await sdk.close();
    await server.close();
    await resumeWorker(opened.job.id);
    const replacement = await startHttpServer(config);
    const fresh = new Client({ name: 'shutdown-reopen', version: '1.0.0' });
    try {
      await fresh.connect(
        new StreamableHTTPClientTransport(replacement.url, {
          requestInit: { headers: { authorization: `Bearer ${tokens[0]!}` } },
        }),
      );
      const reopened = await call(fresh, 'project_open', {
        source: { kind: 'resume', project_path: path },
      });
      assert.equal(reopened.project_id, opened.project_id);
      const saved = await call(fresh, 'analysis_status', {
        project_id: opened.project_id!,
        revision: reopened.revision!,
        job_id: opened.job.id,
      });
      assert.ok('data' in saved && saved.data.job.state === 'cancelled');
    } finally {
      await fresh.close();
      await replacement.close();
    }
  },
);

test(
  'incomplete bodies and idle sockets are bounded and all raw connections close on shutdown',
  { timeout: 10000 },
  async (t) => {
    const { server, tokens } = await setup(t, {
      limits: { body_timeout_ms: 100, idle_timeout_ms: 500, request_timeout_ms: 1000 },
    });
    const socket = connect(Number(server.url.port), '127.0.0.1');
    t.after(() => socket.destroy());
    await once(socket, 'connect');
    const ended = once(socket, 'close');
    let response = '';
    socket.on('data', (chunk) => {
      response += chunk.toString();
    });
    socket.write(
      `POST /mcp HTTP/1.1\r\nHost: ${server.url.host}\r\nAuthorization: Bearer ${tokens[0]!}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`,
    );
    await ended;
    assert.match(response, /HTTP\/1\.1 408/);
    const idle = connect(Number(server.url.port), '127.0.0.1');
    t.after(() => idle.destroy());
    let idleError: NodeJS.ErrnoException | undefined;
    idle.on('error', (error) => {
      idleError = error;
    });
    const closed = new Promise<void>((resolveClosed) => {
      idle.once('close', () => resolveClosed());
    });
    await once(idle, 'connect');
    await server.close();
    await closed;
    // Closing a just-connected idle peer may reset TCP rather than send a graceful FIN.
    if (idleError) assert.equal(idleError.code, 'ECONNRESET');
  },
);

test(
  'real worker and queue capacity cannot be bypassed by repeated HTTP admissions',
  { timeout: 60000 },
  async (t) => {
    const { client, aliceRoot } = await setup(t, {
      principal: { max_workers: 1, max_queued: 0 },
      worker: { entry_point: pauseEntry, cancel_grace_ms: 10 },
    });
    const sdk = await client();
    const opened = await call(sdk, 'project_open', {
      source: {
        kind: 'import',
        input_path: join(fixtures, 'corpus-symbols.dll'),
        project_path: join(aliceRoot, 'bounded'),
      },
    });
    assert.equal(opened.state, 'queued');
    if (opened.state !== 'queued') assert.fail('Expected queued import');
    await waitForWorkerPause(opened.job.id, t);
    const scope = { project_id: opened.project_id!, revision: opened.revision! };
    const queued = await call(sdk, 'binary_info', scope);
    assert.equal(queued.state, 'failed');
    if (queued.state === 'failed') assert.equal(queued.error.code, 'resource_limit');
    const second = await call(sdk, 'project_open', {
      source: {
        kind: 'import',
        input_path: join(fixtures, 'corpus-symbols.dll'),
        project_path: join(aliceRoot, 'second'),
      },
    });
    assert.equal(second.state, 'failed');
    if (second.state === 'failed') assert.equal(second.error.code, 'resource_limit');
    const budget = await sdk.callTool({
      name: 'binary_info',
      arguments: { ...scope, budget: { work: DEFAULT_BUDGET.work + 1 } },
    });
    assert.equal(budget.isError, true);
    assert.match(JSON.stringify(budget.structuredContent), /"code":"not_authorized"/);
    const cancelled = await call(sdk, 'analysis_cancel', { ...scope, job_id: opened.job.id });
    assert.ok('data' in cancelled && cancelled.data.job.state === 'cancelled');
  },
);

test(
  'HTTP annotation delivery preflight rejects overflow before commit and retains the exact requested budget',
  { timeout: 90000 },
  async (t) => {
    const { client, aliceRoot, post } = await setup(t, {
      principal: { max_budget: { output_bytes: 2000000 } },
    });
    const sdk = await client();
    const opened = await call(sdk, 'project_open', {
      wait: true,
      source: {
        kind: 'import',
        input_path: join(fixtures, 'corpus-symbols.dll'),
        project_path: join(aliceRoot, 'preflight'),
      },
    });
    assert.ok('data' in opened && opened.data.image);
    const scope = { project_id: opened.project_id!, revision: opened.revision! };
    const functions = await call(sdk, 'functions_find', {
      ...scope,
      image_id: opened.data.image.id,
    });
    assert.ok('data' in functions && functions.data.items[0]);
    const entity_id = functions.data.items[0].id;
    const edits = Array.from({ length: 20 }, () => ({
      operation: 'set' as const,
      id: newIdentity('annotation'),
      entity_id,
      status: 'asserted' as const,
      evidence_ids: [],
      value: { kind: 'note' as const, value: 'x'.repeat(60000) },
    }));
    const args = {
      project_id: scope.project_id,
      expected_revision: scope.revision,
      author: 'remote-preflight',
      origin: 'user' as const,
      edits,
      budget: { output_bytes: 2000000 },
    };
    const badId = await post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'x'.repeat(MAX_MCP_REQUEST_ID_BYTES + 1),
        method: 'tools/call',
        params: { name: 'annotations_apply', arguments: { ...args, edits: edits.slice(0, 1) } },
      }),
    );
    assert.equal(badId.status, 400);
    await badId.text();
    const rejected = await call(sdk, 'annotations_apply', args);
    assert.equal(rejected.state, 'failed');
    if (rejected.state === 'failed') {
      assert.equal(rejected.error.code, 'resource_limit');
      assert.equal(rejected.current_revision, scope.revision);
    }
    assert.equal(rejected.budget.output_bytes, 2000000);
    const accepted = await call(sdk, 'annotations_apply', { ...args, edits: edits.slice(0, 1) });
    assert.ok('data' in accepted && accepted.revision === scope.revision + 1);
    const metadata = await call(sdk, 'function_get', {
      ...scope,
      revision: accepted.revision,
      function_id: entity_id,
    });
    assert.ok('data' in metadata && metadata.data.view === 'metadata');
    assert.deepEqual(
      metadata.data.annotations.map((item) => item.id),
      [edits[0]!.id],
    );
  },
);

test(
  'deep JSON, duplicate credentials and excess header counts are rejected with bounded responses',
  { timeout: 30000 },
  async (t) => {
    const { server, tokens, post } = await setup(t);
    const nested = await post(
      '{"jsonrpc":"2.0","id":1,"method":"ping","params":' +
        '['.repeat(66) +
        '0' +
        ']'.repeat(66) +
        '}',
    );
    assert.equal(nested.status, 413);
    assert.ok((await nested.text()).length < 100);
    const headers = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`x-extra-${index}`, 'x']),
    );
    const excessive = await post(ping, headers);
    assert.equal(excessive.status, 431);
    await excessive.text();
    const socket = connect(Number(server.url.port), '127.0.0.1');
    t.after(() => socket.destroy());
    await once(socket, 'connect');
    const closed = once(socket, 'close');
    let response = '';
    socket.on('data', (chunk) => {
      response += chunk.toString();
    });
    socket.write(
      `POST /mcp HTTP/1.1\r\nHost: ${server.url.host}\r\nAuthorization: Bearer ${tokens[0]!}\r\nAuthorization: Bearer ${tokens[1]!}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(ping)}\r\n\r\n${ping}`,
    );
    await closed;
    assert.match(response, /HTTP\/1\.1 400/);
    assert.ok(response.length < 1024);
  },
);

test(
  'shutdown drains neither an unbounded pipelined backlog nor a stalled output peer',
  { timeout: 30000 },
  async (t) => {
    const { server, tokens } = await setup(t);
    const socket = connect(Number(server.url.port), '127.0.0.1');
    t.after(() => socket.destroy());
    await once(socket, 'connect');
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const request = `POST /mcp HTTP/1.1\r\nHost: ${server.url.host}\r\nAuthorization: Bearer ${tokens[0]!}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const firstOutput = once(socket, 'data');
    socket.write(request);
    await firstOutput;
    socket.pause();
    socket.write(request.repeat(32));
    const closed = once(socket, 'close').catch((error: NodeJS.ErrnoException) => {
      assert.equal(error.code, 'ECONNRESET');
    });
    await server.close();
    socket.resume();
    await closed;
  },
);

test(
  'work-rate exhaustion is principal-private and leaves the control lane usable',
  { timeout: 30000 },
  async (t) => {
    const { client } = await setup(t, { principal: { work_admissions_per_minute: 1 } });
    const alice = await client(),
      bob = await client(1);
    const scope = { project_id: newIdentity('project'), revision: 0 };
    const first = await call(alice, 'binary_info', scope);
    assert.equal(first.state, 'failed');
    const limited = await alice.callTool({ name: 'binary_info', arguments: scope });
    assert.equal(limited.isError, true);
    assert.match(JSON.stringify(limited.structuredContent), /"code":"not_authorized"/);
    const other = await call(bob, 'binary_info', scope);
    assert.equal(other.state, 'failed');
    if (other.state === 'failed') assert.equal(other.error.code, 'not_found');
    const control = await call(alice, 'analysis_status', { ...scope, job_id: newIdentity('job') });
    assert.equal(control.state, 'failed');
    if (control.state === 'failed') assert.equal(control.error.code, 'not_found');
  },
);

test(
  'native connection capacity includes authenticated TLS peers before any MCP request',
  { timeout: 30000 },
  async (t) => {
    const { server } = await setup(t, { tls: true, limits: { max_connections: 1 } });
    const options = {
      host: '127.0.0.1',
      port: Number(server.url.port),
      ca: await readFile(resolve('test/mcp/http-test-cert.pem')),
    };
    const first = tlsConnect(options);
    t.after(() => first.destroy());
    await once(first, 'secureConnect');
    // The completed real TLS handshake proves the first socket has occupied native admission.
    const excess = tlsConnect(options);
    t.after(() => excess.destroy());
    await assert.rejects(once(excess, 'secureConnect'));
    const closed = once(first, 'close').catch((error: NodeJS.ErrnoException) => {
      assert.equal(error.code, 'ECONNRESET');
    });
    await server.close();
    await closed;
  },
);

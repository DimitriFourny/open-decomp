import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const entry = fileURLToPath(new URL('../../src/cli/entry.ts', import.meta.url));

interface CliProcess {
  child: ChildProcessWithoutNullStreams;
  output: { stdout: string; stderr: string };
  closed: Promise<unknown[]>;
}

function launch(t: TestContext, args: readonly string[]): CliProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', entry, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk: Buffer) => {
    output.stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output.stderr += chunk.toString('utf8');
  });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  return { child, output, closed };
}

async function listening(server: CliProcess): Promise<URL> {
  const lines = createInterface({ input: server.child.stderr });
  try {
    for await (const line of lines) {
      const address = /listening on (https?:\/\/\S+)/.exec(line)?.[1];
      if (address) return new URL(address);
    }
  } finally {
    lines.close();
  }
  throw new Error(`HTTP process exited before listening: ${server.output.stderr}`);
}

test(
  'unified executable requires explicit commands and rejects malformed transport options',
  { timeout: 60000 },
  async (t) => {
    for (const args of [
      ['--root', '/tmp'],
      ['--help', 'extra'],
      ['mcp'],
      ['mcp', 'stop'],
      ['mcp', 'start', '--transport'],
      ['mcp', 'start', '--transport', 'unknown'],
      ['mcp', 'start', '--transport', 'stdio', '--transport', 'http'],
      ['mcp', 'start', '--transport', 'http'],
      ['mcp', 'start', '--transport', 'http', '--config', '--help'],
    ]) {
      const server = launch(t, args);
      await server.closed;
      assert.equal(server.child.exitCode, 1);
      assert.equal(server.output.stdout, '');
      assert.ok(server.output.stderr.length > 0 && server.output.stderr.length < 4096);
    }
  },
);

test(
  'HTTP startup errors do not disclose private configuration or credentials',
  { timeout: 30000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-private-cli-')));
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const secret = randomBytes(32).toString('base64url');
    const config = join(root, `${secret}.json`);
    await writeFile(config, JSON.stringify({ principals: [], credential: secret }));
    const server = launch(t, ['mcp', 'start', '--transport', 'http', '--config', config]);
    await server.closed;
    assert.equal(server.child.exitCode, 1);
    assert.equal(server.output.stdout, '');
    assert.ok(server.output.stderr.length > 0 && server.output.stderr.length < 4096);
    assert.ok(!server.output.stderr.includes(root));
    assert.ok(!server.output.stderr.includes(secret));
    assert.ok(!server.output.stderr.includes('credential'));
  },
);

test(
  'unified HTTP executable stays in foreground, serves the SDK and shuts down on termination',
  {
    timeout: 60000,
    skip:
      process.platform === 'win32'
        ? 'Windows child.kill does not deliver catchable POSIX signals'
        : false,
  },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-http-cli-')));
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const projects = join(root, 'projects'),
      inputs = join(root, 'inputs');
    await Promise.all([mkdir(projects), mkdir(inputs)]);
    const token = randomBytes(32).toString('base64url');
    const config = join(root, 'private.json');
    await writeFile(
      config,
      JSON.stringify({
        port: 0,
        principals: [
          {
            id: 'analyst',
            token_sha256: createHash('sha256').update(token).digest('hex'),
            project_root: projects,
            input_roots: [inputs],
          },
        ],
      }),
    );
    const server = launch(t, ['mcp', 'start', '--transport', 'http', '--config', config]);
    const address = await listening(server);
    assert.equal(server.child.exitCode, null);
    const client = new Client({ name: 'unified-http-cli-test', version: '0.1.0' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(address, {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      await client.ping();
      assert.ok((await client.listTools()).tools.length > 0);
    } finally {
      await client.close();
    }
    server.child.kill('SIGTERM');
    await server.closed;
    assert.equal(server.child.exitCode, 0, server.output.stderr);
    assert.equal(server.child.signalCode, null);
    assert.equal(server.output.stdout, '');
    assert.ok(!server.output.stderr.includes(token));
  },
);

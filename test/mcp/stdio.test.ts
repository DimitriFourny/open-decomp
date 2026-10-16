import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';
import { newIdentity, toolSchemas } from '../../src/core/index.js';
import { MAX_MCP_INPUT_BYTES, MAX_MCP_PENDING_REQUESTS, MAX_MCP_REQUEST_ID_BYTES, parseCliArguments } from '../../src/mcp/cli.js';
import { callMcpTool, resultData, runMcpWorkflows } from '../../scripts/mcp-workflow.js';

const entry = fileURLToPath(new URL('../../src/mcp/stdio.ts', import.meta.url));
const fixtures = resolve('fixtures/bin');
const nodeArgs = ['--import', 'tsx'];

function launch(t: TestContext, args: readonly string[]) {
  const child = spawn(process.execPath, [...nodeArgs, entry, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk: Buffer) => { output.stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { output.stderr += chunk.toString('utf8'); });
  // Oversized input may still be queued when the server closes its read end.
  child.stdin.on('error', () => {});
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  return { child, output, closed };
}

function rpcReader(child: ChildProcessWithoutNullStreams) {
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (reason: unknown) => void }>();
  lines.on('line', line => {
    let value: Record<string, unknown>;
    try { value = z.record(z.string(), z.unknown()).parse(JSON.parse(line)); }
    catch (error) {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      return;
    }
    if (typeof value['id'] === 'number') {
      pending.get(value['id'])?.resolve(value);
      pending.delete(value['id']);
    }
  });
  lines.on('close', () => {
    for (const request of pending.values()) request.reject(new Error('Server closed before answering lifecycle request'));
    pending.clear();
  });
  let id = 0;
  return {
    request(method: string, params: Record<string, unknown>) {
      const requestId = ++id;
      const response = new Promise<Record<string, unknown>>((resolve, reject) => { pending.set(requestId, { resolve, reject }); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
      return response;
    },
  };
}

test('CLI requires explicit roots and reuses worker resource limits without hidden flags', () => {
  for (const args of [[], ['--wat'], ['--root'], ['--root', '--version'], ['--root', 'x', '--max-workers', '0'], ['--root', 'x', '--max-workers', '33'], ['--root', 'x', '--max-queued', '-1'], ['--root', 'x', '--max-queued', '1025'], ['--root', 'x', '--max-workers', '1.5'], ['--root', 'x', '--max-workers', '01'], ['--root', 'x', '--max-workers', '1', '--max-workers', '2'], ['--root', 'x', '--worker-entry', 'foreign.js']]) {
    assert.throws(() => parseCliArguments(args), Error, JSON.stringify(args));
  }
});

test('CLI diagnostics, help and version never touch stdout', { timeout: 30000 }, async t => {
  for (const args of [[], ['--unknown'], ['--help'], ['--version']]) {
    const process = launch(t, args);
    await process.closed;
    assert.equal(process.output.stdout, '');
    assert.ok(process.output.stderr.length > 0 && process.output.stderr.length < 4096);
    assert.equal(process.child.exitCode, args[0] === '--help' || args[0] === '--version' ? 0 : 1);
  }
});

test('official SDK source-entry workflows analyze both targets, symbol-bearing and stripped, without dist or progress extensions', { timeout: 360000 }, async () => {
  await runMcpWorkflows({ serverEntry: entry, fixtures, nodeArgs });
});

for (const shutdown of ['eof', 'SIGINT', 'SIGTERM', 'backpressure', 'stalled-output', 'oversized-id'] as const) test(`source CLI ${shutdown} reaps a real owned worker and leaves its project resumable`, {
  timeout: shutdown === 'stalled-output' ? 120000 : 60000,
  skip: process.platform === 'win32' && (shutdown === 'SIGINT' || shutdown === 'SIGTERM') ? 'Windows child.kill terminates rather than delivering catchable POSIX signals; EOF and backpressure lifecycle remain covered' : false,
}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-mcp-lifecycle-')));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const process = launch(t, ['--root', root, '--root', fixtures]);
  const rpc = rpcReader(process.child);
  const initialized = await rpc.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'stdio-lifecycle-test', version: '0.1.0' } });
  assert.ok(initialized['result']);
  process.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const projectPath = join(root, 'project');
  const openedRpc = await rpc.request('tools/call', { name: 'project_open', arguments: { source: { kind: 'import', input_path: join(fixtures, 'corpus-symbols.dll'), project_path: projectPath }, wait: true } });
  const opened = z.object({ structuredContent: toolSchemas.project_open.output }).parse(openedRpc['result']);
  assert.equal(opened.structuredContent.state, 'complete');
  if (shutdown === 'backpressure' || shutdown === 'stalled-output') {
    // Keep the peer alive without draining large discovery replies. Resume only
    // after exit so the parent can consume EOF and observe the child's close event.
    // The single-response case exercises a real child/OS pipe deadline; fake
    // timers in this parent cannot advance the separate process's clock.
    process.child.once('exit', () => process.child.stdout.resume());
    process.child.stdout.pause();
    const requests = shutdown === 'backpressure' ? MAX_MCP_PENDING_REQUESTS + 4 : 1;
    for (let index = 0; index < requests; index++) {
      process.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 100 + index, method: 'tools/list', params: {} })}\n`);
    }
  } else if (shutdown === 'oversized-id') {
    assert.ok('data' in opened.structuredContent && opened.structuredContent.data.image);
    const found = await rpc.request('tools/call', { name: 'functions_find', arguments: {
      project_id: opened.structuredContent.project_id, revision: opened.structuredContent.revision,
      image_id: opened.structuredContent.data.image.id,
    } });
    const functions = z.object({ structuredContent: toolSchemas.functions_find.output }).parse(found['result']).structuredContent;
    assert.ok('data' in functions);
    process.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'i'.repeat(MAX_MCP_REQUEST_ID_BYTES + 1), method: 'tools/call', params: {
      name: 'annotations_apply', arguments: {
        project_id: opened.structuredContent.project_id, expected_revision: opened.structuredContent.revision,
        author: 'request-id-boundary', origin: 'user', edits: [{
          operation: 'set', id: newIdentity('annotation'), entity_id: functions.data.items[0]!.id,
          value: { kind: 'note', value: 'Must not be committed before rejecting the request ID' }, status: 'asserted', evidence_ids: [],
        }],
      },
    } })}\n`);
  } else if (shutdown === 'eof') process.child.stdin.end();
  else process.child.kill(shutdown);
  await process.closed;
  const rejectedPeer = shutdown === 'backpressure' || shutdown === 'stalled-output' || shutdown === 'oversized-id';
  assert.equal(process.child.exitCode, rejectedPeer ? 1 : 0, process.output.stderr);
  assert.equal(process.child.signalCode, null);
  if (rejectedPeer) assert.ok(process.output.stderr.length > 0 && process.output.stderr.length <= 1024);
  else assert.ok(process.output.stdout.endsWith('\n'));
  // A connection terminated for a non-draining peer may end inside its last frame.
  for (const line of process.output.stdout.split('\n').slice(0, -1)) {
    z.object({ jsonrpc: z.literal('2.0') }).parse(JSON.parse(line));
  }
  const client = new Client({ name: 'stdio-reopen-test', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: globalThis.process.execPath, args: [...nodeArgs, entry, '--root', root], stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport);
    const resumed = await callMcpTool(client, 'project_open', { source: { kind: 'resume', project_path: projectPath }, wait: true });
    assert.equal(resumed.state, 'complete');
    assert.equal(resumed.project_id, opened.structuredContent.project_id);
    assert.equal(resumed.revision, opened.structuredContent.revision);
    assert.equal(resultData(resumed).resumed, true);
    resultData(await callMcpTool(client, 'project_close', { project_id: resumed.project_id!, revision: resumed.revision! }));
  } finally { await client.close(); }
});

test('source CLI rejects oversized frames and invalid JSON-RPC with bounded stderr and no protocol pollution', { timeout: 30000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-mcp-bounds-')));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  for (const input of ['x'.repeat(MAX_MCP_INPUT_BYTES + 1), '{"jsonrpc":"2.0","method":123}\n'.repeat(1000)]) {
    const process = launch(t, ['--root', root]);
    process.child.stdin.write(input);
    await process.closed;
    assert.equal(process.child.exitCode, 1);
    assert.equal(process.output.stdout, '');
    assert.ok(process.output.stderr.length > 0 && process.output.stderr.length <= 1024);
  }
});

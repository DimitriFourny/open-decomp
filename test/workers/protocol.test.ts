import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BUDGET, newIdentity } from '../../src/core/index.js';
import {
  commandSchema,
  eventSchema,
  FrameDecoder,
  frame,
  MAX_FRAME_BYTES,
} from '../../src/workers/protocol.js';

test('length-prefixed decoding handles fragmentation and refuses oversized/truncated frames before JSON parsing', () => {
  const records: unknown[] = [];
  const decoder = new FrameDecoder((value) => records.push(value));
  const command = { kind: 'close', id: newIdentity('job') };
  const bytes = frame(command);
  for (const byte of bytes) decoder.push(Buffer.of(byte));
  decoder.end();
  assert.deepEqual(records, [command]);
  decoder.push(Buffer.concat([bytes, bytes]));
  assert.equal(records.length, 3);
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(MAX_FRAME_BYTES + 1);
  assert.throws(() => new FrameDecoder(() => {}).push(oversized), /frame length/);
  const partial = new FrameDecoder(() => {});
  partial.push(bytes.subarray(0, 6));
  assert.throws(() => partial.end(), /Truncated/);
  assert.throws(() => frame('too long', 2), /byte limit/);
});

test('coarse command schemas reject extra code, SQL, lifecycle dispatch and malformed wire job results', () => {
  const id = newIdentity('job');
  assert.equal(commandSchema.safeParse({ kind: 'close', id, sql: 'SELECT 1' }).success, false);
  assert.equal(
    commandSchema.safeParse({
      kind: 'admit',
      id,
      deadline: Date.now() + 1000,
      request: { kind: 'evaluate', source: 'process.exit()' },
    }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({
      kind: 'admit',
      id,
      deadline: Date.now() + 1000,
      request: {
        kind: 'execute',
        operation: 'project_open',
        args: { source: { kind: 'resume', project_path: '/outside' }, budget: DEFAULT_BUDGET },
        budget: DEFAULT_BUDGET,
      },
    }).success,
    false,
  );
  assert.equal(
    eventSchema.safeParse({ kind: 'job', id, job: { state: 'completed' } }).success,
    false,
  );
});

test('a decompile request names the budget fields to size, and only those', () => {
  const admit = (sized_budget: unknown) =>
    commandSchema.safeParse({
      kind: 'admit',
      id: newIdentity('job'),
      deadline: Date.now() + 1000,
      request: {
        kind: 'execute',
        operation: 'function_decompile',
        args: {
          project_id: newIdentity('project'),
          revision: 1,
          function_id: `entity_${'a'.repeat(64)}`,
          budget: DEFAULT_BUDGET,
        },
        budget: DEFAULT_BUDGET,
        sized_budget,
      },
    }).success;
  assert.equal(admit({ fields: ['work', 'deadline_ms'] }), true);
  assert.equal(admit({ fields: ['work'], ceiling: { work: 10_000_000 } }), true);
  assert.equal(admit({ fields: ['output_bytes'] }), false);
  assert.equal(admit({ fields: [] }), false);
});

test(
  'the real child process exits on an oversized frame rather than allocating the claimed payload',
  { timeout: 30000 },
  async (t) => {
    const source = import.meta.url.endsWith('.ts');
    const entry = new URL(
      source ? '../../src/workers/entry.ts' : '../../src/workers/entry.js',
      import.meta.url,
    );
    const child = spawn(
      process.execPath,
      [...(source ? ['--import', 'tsx'] : []), fileURLToPath(entry)],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    t.after(() => {
      child.kill('SIGKILL');
    });
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.on('error', () => {});
    const closed = once(child, 'close');
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(MAX_FRAME_BYTES + 1);
    child.stdin.end(oversized);
    const [code] = await closed;
    assert.equal(code, 1);
  },
);

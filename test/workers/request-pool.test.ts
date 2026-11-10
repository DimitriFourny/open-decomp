import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { openBinary } from '../../src/api/index.js';
import { DISK_FULL_MESSAGE, OperationError, diskFull } from '../../src/core/index.js';
import {
  removeStaleRequestDirectories,
  requestDirectoryPrefix,
} from '../../src/workers/request-pool.js';

/** The pid of a process that has exited. */
function exitedPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  });
  return Number(child.stdout);
}

test('stale request directories of exited owners on this host are removed; live and foreign ones stay', (t) => {
  const project = mkdtempSync(join(tmpdir(), 'open-decomp-request-pool-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const requests = join(project, 'requests');
  const dead = join(requests, `${requestDirectoryPrefix(exitedPid())}abc`),
    live = join(requests, `${requestDirectoryPrefix()}def`),
    foreign = join(requests, `000000000000-${exitedPid()}-ghi`);
  for (const directory of [dead, live, foreign])
    mkdirSync(join(directory, 'w0'), { recursive: true });
  removeStaleRequestDirectories(project);
  assert.equal(existsSync(dead), false);
  assert.equal(existsSync(live), true);
  assert.equal(existsSync(foreign), true);
  // A project without request directories is left alone.
  removeStaleRequestDirectories(join(project, 'absent'));
});

test('a full disk is one clear resource_limit naming the directory; other errors are not', () => {
  const enospc = Object.assign(new Error('ENOSPC: no space left on device, write'), {
    code: 'ENOSPC',
  });
  for (const error of [enospc, new Error('database or disk is full')]) {
    const full = diskFull(error, '/cache/project/requests');
    assert.ok(full instanceof OperationError);
    assert.equal(full.code, 'resource_limit');
    assert.ok(full.message.startsWith(`${DISK_FULL_MESSAGE} for /cache/project/requests: `));
  }
  assert.equal(diskFull(new Error('EACCES: permission denied')), undefined);
  assert.equal(diskFull('ENOSPC'), undefined);
});

test(
  'request workers keep their snapshot under the project, not in the temporary directory',
  { timeout: 300_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'open-decomp-request-root-'));
    const temporary = join(root, 'tmp');
    mkdirSync(temporary);
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = temporary;
    t.after(() => {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
      rmSync(root, { recursive: true, force: true });
    });
    const session = await openBinary(resolve('fixtures/bin/elf-x86_64-symbols'), {
      cachePath: join(root, 'cache'),
      requestWorkers: 2,
    });
    try {
      const result = await session.decompile({ name: 'fixture_arithmetic' }, { emitter: 'c-like' });
      assert.ok('data' in result, result.state);
      const projects = readdirSync(join(root, 'cache')).map((name) => join(root, 'cache', name));
      // The generation's directory lives until the session closes.
      assert.ok(
        projects.some(
          (project) =>
            existsSync(join(project, 'requests')) &&
            readdirSync(join(project, 'requests')).length > 0,
        ),
      );
      assert.deepEqual(
        readdirSync(temporary).filter((name) => name.startsWith('open-decomp-requests-')),
        [],
      );
    } finally {
      await session.close();
    }
  },
);

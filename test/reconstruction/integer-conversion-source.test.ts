import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test(
  'trusted integer conversion oracle covers native bits, flags, memory and both public dialects',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-integer-conversion-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const smoke = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve('scripts/bench/quality-matrix-conversions.ts'),
        join(root, 'run'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(smoke.status, 0, smoke.stderr);
    const evidence = JSON.parse(smoke.stdout);
    assert.equal(evidence.oracle_cases, 13);
    assert.equal(evidence.x86_machine_cases, 104);
    assert.equal(evidence.arm_machine_cases, 52);
    assert.equal(evidence.public_emissions, 18);
    assert.equal(evidence.both_dialect_output_cases, 234);
  },
);

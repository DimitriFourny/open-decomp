import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { evidenceArchiveSkip } from '../support/host-tools.js';
import { evidencePath } from '../../scripts/bench/evidence.js';
import { openBinary } from '../../src/api/index.js';

const baselineArchive = 'scripts/bench/quality-evidence/baseline-2026-10-17.tar.gz';

// SQLite (analyzed, never executed): `sqlite3BtreeCommitPhaseTwo` selects
// `getPageNormal` (0x100060ce8) or `getPageMMap` (0x100060ae0) per arm by
// writing the low cell and a constant high cell of one 64-bit register.
// `isDate` carries the table address 0x100132f08 (`sqlite3UpperToLower`) into
// its loops the same way: a low cell 0x132f08 beside a high cell 1.
test(
  'constant register cells are one whole constant per arm and name the function or table they address',
  { skip: evidenceArchiveSkip(baselineArchive), timeout: 300000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-decomp-cell-constants-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const extracted = spawnSync(
      '/usr/bin/tar',
      ['-xzf', evidencePath(baselineArchive), '-C', root, 'inputs/sqlite3-arm64'],
      { encoding: 'utf8' },
    );
    assert.equal(extracted.status, 0, extracted.stderr);
    const session = await openBinary(join(root, 'inputs/sqlite3-arm64'), {
      cachePath: join(root, 'cache'),
    });
    t.after(() => session.close());
    for (const emitter of ['c-like', 'python-like'] as const) {
      const result = await session.decompile({ name: '_sqlite3BtreeCommitPhaseTwo' }, { emitter });
      assert.ok('data' in result && result.data.delivery === 'inline', JSON.stringify(result));
      const { text, local_validation: validation } = result.data.emission;
      // Both whole constants print as the functions they are the entries of.
      assert.match(text, /getPageNormal/);
      assert.match(text, /getPageMMap/);
      // No per-cell reassembly of the two halves remains.
      assert.doesNotMatch(text, /<< 32/);
      // Every bitvector proof (each recombined edge constant is one) holds.
      const proofs = (validation ?? []).filter((record) => record.kind === 'bitvector');
      assert.ok(proofs.length > 0 && proofs.every((record) => record.status === 'verified'));
      assert.ok(
        (validation ?? []).some(
          (record) => record.rule === 'register_cell_recombination' && record.status === 'verified',
        ),
      );
    }
    for (const emitter of ['c-like', 'python-like'] as const) {
      const result = await session.decompile({ name: '_isDate' }, { emitter });
      assert.ok('data' in result && result.data.delivery === 'inline', JSON.stringify(result));
      const { text, local_validation: validation } = result.data.emission;
      // The address is one whole value, never its low cell `0x132f08` beside a
      // separate high cell, and no dereference reassembles a pointer from cells.
      assert.doesNotMatch(text, /\b0x132f08\b/);
      assert.match(text, /^\s+\w+ = \S*\bsqlite3UpperToLower\w*(?:;|, 0x0\))?$/m);
      assert.doesNotMatch(text, /\*\([^;\n]*<< 32\)\) \+|memory\.\w+\[[^\]\n]*<< 32/);
      assert.ok(
        (validation ?? []).some(
          (record) => record.rule === 'register_cell_recombination' && record.status === 'verified',
        ),
      );
    }
  },
);

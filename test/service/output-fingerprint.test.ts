import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  computeFingerprints,
  FINGERPRINT_FILE,
  type Fingerprints,
} from '../support/output-fingerprints.js';

// Cached emissions are keyed by the analysis identity (versions.ts) and emitter version. If the
// emitted output changes while that identity does not, stale cache entries would be served as
// current. This test pins one hash per fixture/function/dialect and ties it to the identity.
test(
  'emitted output changes only together with the analysis identity / emitter version',
  { timeout: 120000 },
  async () => {
    const recorded = JSON.parse(await readFile(FINGERPRINT_FILE, 'utf8')) as Fingerprints;
    const current = await computeFingerprints();
    assert.deepEqual(
      Object.keys(current.records),
      Object.keys(recorded.records),
      'Fingerprint fixture set changed: regenerate with `bun run fingerprints`',
    );
    const outputChanged: string[] = [];
    const identityChanged: string[] = [];
    for (const [key, now] of Object.entries(current.records)) {
      const before = recorded.records[key]!;
      const differing = Object.keys({ ...before.functions, ...now.functions }).filter(
        (name) => before.functions[name] !== now.functions[name],
      );
      if (before.identity !== now.identity) identityChanged.push(`${key}: ${now.identity}`);
      else if (differing.length > 0) outputChanged.push(`${key}: ${differing.join(', ')}`);
    }
    assert.deepEqual(
      outputChanged,
      [],
      'Emitted output changed but the analysis identity string is unchanged. Bump the relevant ' +
        'entry in src/service/analysis/versions.ts (and the emitter version if presentation ' +
        'changed), then regenerate with `bun run fingerprints` and commit the JSON.',
    );
    assert.deepEqual(
      identityChanged,
      [],
      'The analysis identity changed since the fingerprints were recorded. Regenerate with ' +
        '`bun run fingerprints`, review which outputs changed, and commit the JSON.',
    );
  },
);

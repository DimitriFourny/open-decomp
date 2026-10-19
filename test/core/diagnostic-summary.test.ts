import assert from 'node:assert/strict';
import { test } from 'node:test';
import { distinctDiagnostics } from '../../src/core/index.js';
import type { WireDiagnostic } from '../../src/core/index.js';

const base: WireDiagnostic = {
  severity: 'warning',
  code: 'unavailable_semantics',
  message: 'The source call interface is unresolved.',
  evidence_ids: [],
};

test('repeated diagnostics collapse to one counted entry in first-seen order', () => {
  const other: WireDiagnostic = { ...base, severity: 'info', message: 'other' };
  const summary = distinctDiagnostics([base, other, { ...base, evidence_ids: [] }, base]);
  assert.deepEqual(
    summary.map((item) => [item.diagnostic.message, item.count]),
    [
      [base.message, 3],
      ['other', 1],
    ],
  );
  assert.deepEqual(distinctDiagnostics([]), []);
});

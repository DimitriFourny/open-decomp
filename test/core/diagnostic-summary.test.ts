import assert from 'node:assert/strict';
import { test } from 'node:test';
import { caveats, distinctDiagnostics } from '../../src/core/index.js';
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

const call: WireDiagnostic = {
  ...base,
  message: 'The source call interface is unresolved; unknown call effects remain explicit.',
  details: { kind: 'call_interface' },
};
const callee = (name: string, code: WireDiagnostic['code']): WireDiagnostic => ({
  severity: 'warning',
  code,
  message: `Native callee ${name} remains partial: _x: native dependency load work reserve (123)`,
  evidence_ids: [],
  details: { kind: 'callee_partial', callee: name },
});

test('caveats group per-call, return-storage and callee diagnostics and drop info', () => {
  const result = caveats([
    call,
    callee('_a', 'resource_limit'),
    { ...base, severity: 'info', message: 'bookkeeping' },
    call,
    {
      ...base,
      message: 'The source return list is unresolved; storage: arm64:x1[0:64]',
      details: { kind: 'return_storage', storage: ['arm64:x1[0:64]', 'arm64:v0[0:64]'] },
    },
    callee('_b', 'resource_limit'),
    callee('_c', 'unavailable_semantics'),
    {
      ...base,
      message: 'Only a known argument prefix is supplied; total arity remains unknown.',
    },
    {
      ...base,
      details: { kind: 'return_storage', storage: ['arm64:v0[64:64]', 'arm64:v1[0:64]'] },
    },
  ]);
  assert.deepEqual(
    result.map((item) => item.text),
    [
      '2 calls with unresolved interface',
      'callee summaries cut by budget: _a, _b',
      'return list unresolved (possible storage: x1, v0, v1)',
      'callee summaries partial: _c',
      'Only a known argument prefix is supplied; total arity remains unknown',
    ],
  );
  assert.ok(result.every((item) => item.severity === 'warning'));
});

test('caveats list errors first with their whole message and cap long name lists', () => {
  const names = Array.from({ length: 9 }, (_, index) => `_f${index}`);
  const result = caveats([
    ...names.map((name) => callee(name, 'resource_limit')),
    {
      severity: 'error',
      code: 'internal_error',
      message: 'First sentence. Second sentence that matters.',
      evidence_ids: [],
    },
  ]);
  assert.deepEqual(
    result.map((item) => item.text),
    [
      'First sentence. Second sentence that matters.',
      'callee summaries cut by budget: _f0, _f1, _f2, _f3, _f4, _f5, +3',
    ],
  );
  assert.deepEqual(caveats([]), []);
});

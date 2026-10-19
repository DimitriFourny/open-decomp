import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportToolJsonSchemas, validateToolRequest } from '../../src/core/index.js';
import type { WireDiagnostic } from '../../src/core/index.js';
import { HANDLE_PLACEHOLDER, advertisedInputSchema, prepareRequest } from '../../src/mcp/handles.js';
import { bySeverity, diagnosticLine, shortIds } from '../../src/mcp/listing.js';

const scope = { project_id: `project_${'1'.repeat(64)}`, revision: 1 };

test('a function handle is validated as a handle, resolved later, and bound without touching other fields', () => {
  const prepared = prepareRequest('function_decompile', {
    ...scope,
    function_id: '_main',
    detail: 'full',
  });
  assert.ok('input' in prepared && prepared.site !== undefined);
  assert.equal(prepared.detail, 'full');
  assert.equal(prepared.site.handle, '_main');
  assert.equal(prepared.site.path, 'function_id');
  // The core schema validates everything else, with the handle replaced by a placeholder ID.
  const args = validateToolRequest('function_decompile', prepared.input);
  assert.equal(args.function_id, HANDLE_PLACEHOLDER);
  assert.equal(args.wait, 'auto', 'MCP waits briefly for the result by default');
  const resolved = `entity_${'a'.repeat(64)}`;
  assert.equal(prepared.site.bind(args, resolved).function_id, resolved);
  // An explicit wait is respected.
  const explicit = prepareRequest('function_decompile', { ...scope, function_id: '_main', wait: false });
  assert.ok('input' in explicit);
  assert.equal(validateToolRequest('function_decompile', explicit.input).wait, false);
});

test('full IDs need no resolution and malformed requests are left to the core schema', () => {
  const full = prepareRequest('function_get', { ...scope, function_id: `entity_${'b'.repeat(64)}` });
  assert.ok('input' in full);
  assert.equal(full.site, undefined);
  assert.deepEqual(prepareRequest('function_decompile', { ...scope, function_id: '_x', detail: 'x' }), {
    path: 'detail',
    hint: 'detail must be "text" (default) or "full"',
  });
  const huge = prepareRequest('function_get', { ...scope, function_id: 'x'.repeat(5000) });
  assert.ok(!('input' in huge) && huge.path === 'function_id');
  const notObject = prepareRequest('function_get', 'nope');
  assert.ok('input' in notObject && notObject.input === 'nope');
  const xrefs = prepareRequest('xrefs_get', { ...scope, target: { kind: 'entity', id: 'va:0x10' } });
  assert.ok('input' in xrefs && xrefs.site?.path === 'target.id');
  const bound = xrefs.site.bind(validateToolRequest('xrefs_get', xrefs.input), `entity_${'c'.repeat(64)}`);
  assert.deepEqual(bound.target, { kind: 'entity', id: `entity_${'c'.repeat(64)}` });
});

test('advertised input schemas offer handles, wait:"auto" and detail without mutating the core export', () => {
  const core = exportToolJsonSchemas();
  const decompile = core['function_decompile']!;
  const xrefsCore = core['xrefs_get']!;
  const advertised = advertisedInputSchema('function_decompile', decompile.inputSchema);
  const properties = advertised['properties'] as Record<string, Record<string, unknown>>;
  assert.equal(properties['function_id']?.['pattern'], undefined);
  assert.equal(properties['function_id']?.['type'], 'string');
  assert.equal(properties['wait']?.['default'], 'auto');
  assert.deepEqual(properties['detail']?.['enum'], ['text', 'full']);
  const original = decompile.inputSchema as { properties: Record<string, Record<string, unknown>> };
  assert.ok(original.properties['function_id']?.['pattern'], 'the core schema keeps the strict ID pattern');
  assert.equal(original.properties['detail'], undefined);
  const xrefs = advertisedInputSchema('xrefs_get', xrefsCore.inputSchema);
  assert.match(JSON.stringify(xrefs), /Function: exact name/);
});

test('short IDs stay short unless listed IDs collide, and diagnostics collapse to counted lines', () => {
  const a = `entity_${'a'.repeat(12)}${'0'.repeat(52)}`;
  const b = `entity_${'a'.repeat(12)}${'1'.repeat(52)}`;
  const c = `entity_${'c'.repeat(64)}`;
  const short = shortIds([a, b, c]);
  assert.equal(short.get(c), `entity_${'c'.repeat(12)}`);
  assert.notEqual(short.get(a), short.get(b));
  assert.ok(a.startsWith(short.get(a)!) && b.startsWith(short.get(b)!));
  const warning: WireDiagnostic = { severity: 'warning', code: 'unavailable_semantics', message: 'unresolved', evidence_ids: [] } ;
  const error: WireDiagnostic = { severity: 'error', code: 'internal_error', message: 'bad', evidence_ids: [] };
  const lines = bySeverity([warning, { ...warning, entity_id: c }, error, warning]).map(diagnosticLine);
  assert.deepEqual(lines, ['error internal_error: bad', 'warning unavailable_semantics ×3: unresolved']);
});

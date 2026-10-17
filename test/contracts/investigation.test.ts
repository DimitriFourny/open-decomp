import assert from 'node:assert/strict';
import test from 'node:test';
import { functionGetArgsSchema, functionDecompileArgsSchema } from '../../src/core/tools.js';

const scope = {
  project_id: `project_${'1'.repeat(64)}`,
  revision: 2,
  function_id: `entity_${'2'.repeat(64)}`,
};
const artifact_id = `artifact_${'3'.repeat(64)}`;
const subject_id = `entity_${'4'.repeat(64)}`;

test('investigation requires an explicit artifact, bounds pages, and retains exact subject and kind filters', () => {
  assert.equal(functionGetArgsSchema.safeParse({ ...scope, view: 'investigation' }).success, false);
  const args = functionGetArgsSchema.parse({ ...scope, view: 'investigation', artifact_id,
    subject_id, kinds: ['call', 'unresolved'], page: { limit: 1 } });
  assert.equal(args.artifact_id, artifact_id);
  assert.equal(args.subject_id, subject_id);
  assert.deepEqual(args.kinds, ['call', 'unresolved']);
  assert.equal(args.page.limit, 1);
  assert.equal(args.include_quotes, undefined);
  assert.equal(functionGetArgsSchema.safeParse({ ...args, kinds: ['source'], include_quotes: true }).success, true);
  assert.equal(functionGetArgsSchema.safeParse({ ...args, page: { limit: 0 } }).success, false);
  assert.equal(functionGetArgsSchema.safeParse({ ...args, page: { limit: 1001 } }).success, false);
  assert.equal(functionGetArgsSchema.safeParse({ ...args, kinds: [] }).success, false);
  assert.equal(functionGetArgsSchema.safeParse({ ...args, kinds: ['invented_fact'] }).success, false);
  assert.equal(functionGetArgsSchema.safeParse({ ...args, artifact_id: 'latest' }).success, false);
  assert.equal(functionGetArgsSchema.safeParse({ ...args, subject_id: 'display_name' }).success, false);
});

test('metadata keeps its default and accepts explicit original subject plus optional trusted artifact scope', () => {
  assert.equal(functionGetArgsSchema.parse(scope).view, 'metadata');
  const args = functionGetArgsSchema.parse({ ...scope, subject_id, artifact_id });
  assert.equal(args.view, 'metadata');
  assert.equal(args.subject_id, subject_id);
  assert.equal(args.artifact_id, artifact_id);
  assert.equal(functionGetArgsSchema.safeParse({ ...scope, kinds: ['call'] }).success, false);
  assert.equal(functionGetArgsSchema.safeParse({ ...scope, include_quotes: true }).success, false);
  for (const view of ['cfg', 'disassembly']) {
    assert.equal(functionGetArgsSchema.safeParse({ ...scope, view, subject_id }).success, false);
    assert.equal(functionGetArgsSchema.safeParse({ ...scope, view, artifact_id }).success, false);
  }
});

test('artifact delivery preference is top-level and never changes analysis options or budget', () => {
  const automatic = functionDecompileArgsSchema.parse(scope);
  const artifact = functionDecompileArgsSchema.parse({ ...scope, delivery: 'artifact' });
  assert.equal(automatic.delivery, 'auto');
  assert.equal(artifact.delivery, 'artifact');
  assert.deepEqual(artifact.options, automatic.options);
  assert.deepEqual(artifact.budget, automatic.budget);
  assert.equal(functionDecompileArgsSchema.safeParse({ ...scope, delivery: 'inline' }).success, false);
  assert.equal(functionDecompileArgsSchema.safeParse({ ...scope, options: { delivery: 'artifact' } }).success, false);
});

test('compact native detail is explicit and restricted to public disassembly', () => {
  assert.equal(functionGetArgsSchema.parse({ ...scope, view: 'disassembly' }).detail, undefined);
  for (const detail of ['full', 'compact'])
    assert.equal(functionGetArgsSchema.parse({ ...scope, view: 'disassembly', detail }).detail, detail);
  for (const view of ['metadata', 'cfg', 'investigation'])
    assert.equal(functionGetArgsSchema.safeParse({ ...scope, view, artifact_id, detail: 'compact' }).success, false);
});

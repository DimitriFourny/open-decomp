import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { entityIdentity, expandEmission, newIdentity, type ToolResult, type WireEmission } from '../../../src/core/index.js';
import { QueryService } from '../../../src/service/queries/index.js';

// Actual public operations, not a repository test runner. The image is never executed.
const root = await realpath(await mkdtemp(join(tmpdir(), 'native-context-annotations-')));
const binary = join(root, 'analyzed');
const compiled = spawnSync('/usr/bin/clang', ['-O1', '-g0', '-fno-builtin', '-fno-optimize-sibling-calls',
  resolve('test/service/analysis/native-context-source.c'), '-o', binary], { encoding: 'utf8' });
assert.equal(compiled.status, 0, compiled.stderr);
const service = await QueryService.create({ authorized_roots: [root], max_workers: 1 });
try {
  const opened = await service.execute('project_open', { source: { kind: 'import', input_path: binary,
    project_path: join(root, 'project') }, wait: true });
  assert.ok('data' in opened && opened.data.image && opened.project_id && opened.revision);
  const project_id = opened.project_id, image_id = opened.data.image.id;
  let revision = opened.revision;
  const functions = await service.execute('functions_find', { project_id, revision, image_id,
    query: { text: '_context_', match: 'contains', case_sensitive: true }, page: { limit: 100 } });
  assert.ok('data' in functions);
  const callee = functions.data.items.find((fn) => fn.original_name === '_context_choose');
  const caller = functions.data.items.find((fn) => fn.original_name === '_context_two');
  assert.ok(callee && caller);
  const decompile = async (function_id: string) => {
    const result = await service.execute('function_decompile', { project_id, revision, function_id, wait: true });
    assert.ok('data' in result && result.data.delivery === 'inline', JSON.stringify(result));
    assert.ok(expandEmission(result.data.emission).inferences);
    return { result, emission: result.data.emission };
  };
  const initialCallee = await decompile(callee.id), initialCaller = await decompile(caller.id);
  const parameter = expandEmission(initialCallee.emission).inferences!.find((inference) =>
    inference.details.kind === 'parameter' && inference.details.ordinal === 0);
  assert.ok(parameter && parameter.details.kind === 'parameter');
  const subject_id = parameter.details.value_ids[0]!;
  const annotation_id = newIdentity('annotation');
  const type_id = entityIdentity(opened.data.image.selected_slice_id, 'native-context-oracle-type', subject_id);
  const scopes = new Set<string>();
  const capture = (emission: WireEmission) => {
    assert.ok(emission.inferences);
    const calls = emission.inferences.filter((inference) => inference.details.kind === 'call');
    assert.equal(calls.length, 2);
    const scope = calls.map((inference) => inference.details.kind === 'call' ? inference.details.context_assumptions?.type_evidence_scope : undefined);
    assert.ok(scope[0] && scope[0] === scope[1]); scopes.add(scope[0]);
    assert.ok(calls.every((inference) => inference.details.kind === 'call' && !inference.details.arity_complete));
  };
  capture(initialCaller.emission);
  const lifecycle: { revision: number; status: string; annotations: unknown }[] = [];
  for (const [status, signed] of [['hypothesis', false], ['asserted', true], ['retracted', true]] as const) {
    const edits = status === 'retracted' ? [{ operation: 'retract' as const, id: annotation_id }] : [{
      operation: 'set' as const, id: annotation_id, entity_id: subject_id,
      value: { kind: 'type' as const, type_id, definition: { kind: 'integer' as const, bits: 64, signed } },
      status, evidence_ids: [],
    }];
    const applied = await service.execute('annotations_apply', { project_id, expected_revision: revision,
      author: 'native-context-trusted-oracle', origin: 'user', edits });
    assert.ok('data' in applied, JSON.stringify(applied)); revision = applied.revision!;
    const output = await decompile(caller.id); capture(output.emission);
    assert.equal(output.result.revision, revision);
    if (status !== 'retracted')
      assert.ok(output.result.evidence.some((proof) => proof.origin.kind === 'assertion' && proof.origin.status === status),
        'Dependent caller context must preserve the active annotation confidence in its proof closure');
    else assert.ok(!output.result.evidence.some((proof) => proof.origin.kind === 'assertion'),
      'Retracted assertions must not remain premises of an active native context');
    const currentCallee = await decompile(callee.id);
    const artifact_id = currentCallee.result.artifacts.find((artifact) =>
      artifact.media_type === 'application/vnd.open-decomp.function+json')?.id;
    assert.ok(artifact_id);
    const reviewed: ToolResult<'function_get'> = await service.execute('function_get', { project_id, revision, function_id: callee.id,
      view: 'metadata', subject_id, artifact_id });
    assert.ok('data' in reviewed && reviewed.data.view === 'metadata', JSON.stringify(reviewed));
    const annotation: (typeof reviewed.data.annotations)[number] | undefined =
      reviewed.data.annotations.find((item) => item.id === annotation_id);
    assert.ok(annotation); assert.equal(annotation.status, status);
    lifecycle.push({ revision, status, annotations: reviewed.data.annotations });
  }
  assert.equal(scopes.size, 4, 'Correction/retraction must not reuse an older evidence-scoped context');
  console.log(JSON.stringify({ contexts: scopes.size, lifecycle }, (_, value) => typeof value === 'bigint' ? value.toString() : value));
} finally {
  await service.close('cancel');
  await rm(root, { recursive: true, force: true });
}

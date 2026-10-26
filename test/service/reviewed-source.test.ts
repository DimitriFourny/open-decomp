import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { newIdentity, type ResultEnvelope, type ToolResult } from '../../src/core/index.js';
import { QueryService } from '../../src/service/queries/index.js';

const fixtures = resolve('fixtures/bin');
function data<T>(result: ResultEnvelope<T>): T {
  assert.ok('data' in result, JSON.stringify(result));
  return result.data;
}

/** One project of the arm64 corpus: `fixture_direct` calls `fixture_stack`. */
async function setup(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-reviewed-')));
  const service = await QueryService.create({
    authorized_roots: [root, fixtures],
    max_workers: 2,
    max_queued: 4,
  });
  t.after(async () => {
    await service.close('cancel');
    await rm(root, { recursive: true, force: true });
  });
  const opened = await service.execute('project_open', {
    wait: true,
    source: {
      kind: 'import',
      input_path: join(fixtures, 'libcorpus-arm64-symbols.dylib'),
      project_path: join(root, 'project'),
    },
  });
  const image = data(opened).image;
  assert.ok(image);
  const state = { project_id: opened.project_id!, revision: opened.revision!, image_id: image.id };
  async function find(name: string): Promise<string> {
    const items = data(
      await service.execute('functions_find', {
        ...state,
        query: { text: name, match: 'exact', case_sensitive: true },
      }),
    ).items;
    assert.equal(items.length, 1, name);
    return items[0]!.id;
  }
  async function decompile(
    function_id: string,
    extra: { source?: 'decompiled' | 'reviewed'; emitter?: 'c-like' | 'python-like' } = {},
  ) {
    const result = await service.execute('function_decompile', {
      project_id: state.project_id,
      revision: state.revision,
      function_id,
      wait: true,
      ...(extra.source === undefined ? {} : { source: extra.source }),
      ...(extra.emitter === undefined ? {} : { options: { emitter: extra.emitter } }),
    });
    const body = data(result);
    assert.equal(body.delivery, 'inline');
    return { result, body, artifact: result.artifacts[0]!.id };
  }
  async function apply(edits: unknown[]): Promise<ToolResult<'annotations_apply'>> {
    const result = await service.execute('annotations_apply', {
      project_id: state.project_id,
      expected_revision: state.revision,
      author: 'reviewer',
      origin: 'llm',
      edits,
    } as never);
    if ('data' in result) state.revision = result.data.revision;
    return result;
  }
  const source = (
    entity_id: string,
    base_artifact_id: string,
    text: string,
    extra: { id?: string; status?: 'asserted' | 'hypothesis'; language?: string } = {},
  ) => ({
    operation: 'set',
    id: extra.id ?? newIdentity('annotation'),
    entity_id,
    value: { kind: 'source', language: extra.language ?? 'c-like', text, base_artifact_id },
    status: extra.status ?? 'asserted',
    evidence_ids: [],
  });
  return { service, state, find, decompile, apply, source };
}

test(
  'reviewed source round trip: saved beside the decompilation, never recomputes anything, stale only when the text changes',
  { timeout: 120_000 },
  async (t) => {
    const { service, state, find, decompile, apply, source } = await setup(t);
    const stack = await find('_fixture_stack');
    const direct = await find('_fixture_direct');
    const first = await decompile(stack);
    const callerBefore = await decompile(direct);
    assert.equal(first.body.cache, 'computed');
    const text = 'uint32_t fixture_stack(uint32_t value) { return value + 7; } // cleaned';
    const saved = await apply([source(stack, first.artifact, text)]);
    const applied = data(saved).applied[0]!;
    assert.ok(applied.value.kind === 'source');
    assert.equal(applied.value.base_artifact_id, first.artifact);
    assert.equal(
      applied.value.base_text_sha256,
      createHash('sha256')
        .update(first.body.delivery === 'inline' ? first.body.emission.text : '')
        .digest('hex'),
    );

    // The saved source advanced the revision but changed no analysis input: both the function
    // and its caller are served by reuse, not recomputed.
    const metadata = data(
      await service.execute('function_get', {
        project_id: state.project_id,
        revision: state.revision,
        function_id: stack,
        view: 'metadata',
      }),
    );
    assert.ok(metadata.view === 'metadata');
    assert.deepEqual(
      metadata.annotations.map((item) => [item.id, item.value.kind]),
      [[applied.id, 'source']],
    );
    const again = await decompile(stack, { source: 'reviewed' });
    assert.equal(again.body.cache, 'hit');
    assert.ok(again.body.delivery === 'inline');
    assert.equal(
      again.body.emission.text,
      first.body.delivery === 'inline' ? first.body.emission.text : '',
    );
    assert.deepEqual(again.body.reviewed_source && { ...again.body.reviewed_source, revision: 0 }, {
      annotation_id: applied.id,
      language: 'c-like',
      text,
      author: 'reviewer',
      origin: 'llm',
      status: 'asserted',
      revision: 0,
      base_artifact_id: first.artifact,
      stale: false,
    });
    const caller = await decompile(direct);
    assert.equal(caller.body.cache, 'hit');
    assert.ok(caller.body.delivery === 'inline' && callerBefore.body.delivery === 'inline');
    assert.equal(caller.body.emission.text, callerBefore.body.emission.text);
    assert.equal(caller.body.reviewed_source, undefined);
    // Without asking for it, the field is absent; asking for another emitter finds nothing.
    assert.equal((await decompile(stack)).body.reviewed_source, undefined);
    const python = await decompile(stack, { source: 'reviewed', emitter: 'python-like' });
    assert.equal(python.body.reviewed_source, null);

    // A changed callee name changes the text `fixture_direct` decompiles to.
    // The base must be a decompilation published at the current revision (a reuse hit).
    const base = await decompile(direct);
    assert.equal(base.body.cache, 'hit');
    const reviewedDirect = await apply([source(direct, base.artifact, '// direct, cleaned')]);
    assert.ok('data' in reviewedDirect);
    const reviewedId = reviewedDirect.data.applied[0]!.id;
    assert.equal(
      (await decompile(direct, { source: 'reviewed' })).body.reviewed_source?.stale,
      false,
    );
    const renamed = await apply([
      {
        operation: 'set',
        id: newIdentity('annotation'),
        entity_id: stack,
        value: { kind: 'name', value: 'renamed_stack' },
        status: 'asserted',
        evidence_ids: [],
      },
    ]);
    assert.ok('data' in renamed);
    const stale = await decompile(direct, { source: 'reviewed' });
    assert.ok(stale.body.delivery === 'inline');
    assert.match(stale.body.emission.text, /renamed_stack/);
    assert.equal(stale.body.reviewed_source?.text, '// direct, cleaned');
    assert.equal(stale.body.reviewed_source?.stale, true);
    // Saving again under the same annotation ID, based on the new decompilation, is current.
    const rebased = await apply([
      source(direct, stale.artifact, '// direct, cleaned again', { id: reviewedId }),
    ]);
    assert.ok('data' in rebased);
    const current = await decompile(direct, { source: 'reviewed' });
    assert.equal(current.body.reviewed_source?.text, '// direct, cleaned again');
    assert.equal(current.body.reviewed_source?.stale, false);
  },
);

test(
  'reviewed source rejects forged, foreign and missing base artifacts and non-function subjects',
  { timeout: 120_000 },
  async (t) => {
    const { service, state, find, decompile, apply, source } = await setup(t);
    const stack = await find('_fixture_stack');
    const direct = await find('_fixture_direct');
    const own = await decompile(stack);
    const foreign = await decompile(direct);
    const rejected = async (edit: unknown, code: string) => {
      const before = state.revision;
      const result = await apply([edit]);
      assert.ok(result.state === 'failed', JSON.stringify(result));
      assert.equal(result.error.code, code);
      assert.equal(state.revision, before);
    };
    // Another function's artifact is not a base.
    await rejected(source(stack, foreign.artifact, 'x'), 'not_found');
    // An unpublished artifact ID.
    await rejected(source(stack, newIdentity('artifact'), 'x'), 'not_found');
    // A base of the other emitter.
    const python = await decompile(stack, { emitter: 'python-like' });
    await rejected(source(stack, python.artifact, 'x'), 'invalid_input');
    // The digest is server-computed: a client cannot supply it.
    const forged = {
      ...source(stack, own.artifact, 'x'),
      value: {
        kind: 'source',
        language: 'c-like',
        text: 'x',
        base_artifact_id: own.artifact,
        base_text_sha256: '0'.repeat(64),
      },
    };
    await assert.rejects(() =>
      service.execute('annotations_apply', {
        project_id: state.project_id,
        expected_revision: state.revision,
        author: 'forger',
        origin: 'llm',
        edits: [forged],
      } as never),
    );
    // Only a function can carry reviewed source.
    const symbols = data(await service.execute('symbols_find', { ...state, kinds: ['symbol'] }));
    const symbol = symbols.items[0];
    assert.ok(symbol?.kind === 'symbol');
    const subject = symbol.symbol.id;
    await rejected(source(subject, own.artifact, 'x'), 'invalid_input');
    // A well-formed one is accepted at the same revision after all of those.
    assert.ok(
      'data' in (await apply([source(stack, own.artifact.slice(0, 21), 'prefix handle ok')])),
    );
  },
);

test(
  'reviewed source is delivered only when exactly one asserted source exists for the emitter',
  { timeout: 120_000 },
  async (t) => {
    const { find, decompile, apply, source } = await setup(t);
    const stack = await find('_fixture_stack');
    const base = await decompile(stack);
    assert.equal((await decompile(stack, { source: 'reviewed' })).body.reviewed_source, null);
    const hypothesis = source(stack, base.artifact, 'draft', { status: 'hypothesis' });
    assert.ok('data' in (await apply([hypothesis])));
    const hypothetical = await decompile(stack, { source: 'reviewed' });
    assert.equal(hypothetical.body.reviewed_source, null);
    assert.ok(
      hypothetical.result.diagnostics.some((item) => /only a hypothesis/.test(item.message)),
    );
    const based = await decompile(stack);
    assert.ok('data' in (await apply([source(stack, based.artifact, 'first')])));
    const second = await decompile(stack);
    assert.ok('data' in (await apply([source(stack, second.artifact, 'second')])));
    const conflicting = await decompile(stack, { source: 'reviewed' });
    assert.equal(conflicting.body.reviewed_source, null);
    assert.ok(
      conflicting.result.diagnostics.some((item) =>
        /asserted c-like reviewed sources/.test(item.message),
      ),
    );
  },
);

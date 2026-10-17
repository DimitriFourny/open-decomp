import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOperationContext } from '../../src/core/index.js';
import type { LoadedImage } from '../../src/core/index.js';
import { discoverFunctions } from '../../src/analysis/discovery/index.js';
import { Arm64Decoder } from '../../src/decoders/arm64/index.js';
import { reconstructFunctionGraph } from '../../src/service/queries/graphs.js';
import { armWords, navigationBytes } from '../analysis/navigation-fixture.js';
import { SqliteProjectStore } from '../../src/project/store/index.js';
import { prepareQueryImport } from '../../src/service/queries/prepare.js';
import { QueryService } from '../../src/service/queries/index.js';
import { execute } from '../emitters/c/support.js';
import { sourceBuiltSelectedImage } from './selected-work-fixture.js';

/** Source oracle: `unsigned selected(void) { return 42; }`.
 * The body is always `mov w0, #42; ret`; extra roots have no dependency on it. */
function selectedImage(unrelated: number): LoadedImage {
  const words: number[] = [];
  for (let index = 0; index < unrelated; index++) words.push(0x52800000, 0xd65f03c0);
  words.push(0x52800540, 0xd65f03c0);
  const base = navigationBytes(armWords(words), new Uint8Array(), 'arm64');
  return {
    ...base,
    entry_points: [],
    hints: Array.from({ length: unrelated + 1 }, (_, index) => ({
      kind: 'function' as const,
      address: { image_id: base.id, space: 'va' as const, value: 0x1000n + BigInt(index * 8) },
      size: null,
      evidence_ids: [],
    })),
  };
}

test('unrelated seeded bodies do not consume a selected two-instruction graph budget', () => {
  const observed = [0, 64].map((unrelated) => {
    const image = selectedImage(unrelated);
    const decoder = new Arm64Decoder();
    try {
      const published = discoverFunctions({ image, decoder, revision: 2 }, createOperationContext());
      const entry = 0x1000n + BigInt(unrelated * 8);
      const fn = published.graphs.find((graph) => graph.function.entry.value === entry)!.function;
      assert.equal(fn.analysis, 'complete');
      assert.equal(fn.ranges.reduce((n, range) => n + range.size, 0n), 8n);
      const graph = reconstructFunctionGraph({
        project_id: `diagnosis-${unrelated}`, revision: 2, image,
        function: fn, functions: published.graphs.map((item) => item.function),
      }, createOperationContext({ budget: { instructions: 8 } }));
      return { instructions: graph.instructions.length, state: graph.coverage.state, budget_gaps: graph.gaps.filter((gap) => gap.reason === 'budget').length };
    } finally { decoder.dispose(); }
  });
  assert.deepEqual(observed[0], { instructions: 2, state: 'complete', budget_gaps: 0 });
  assert.deepEqual(observed[1], observed[0]);
});

test('direct native calls do not enlarge caller ownership', () => {
  // bl +8; ret; mov w0, #42; ret
  const base = navigationBytes(armWords([0x94000002, 0xd65f03c0, 0x52800540, 0xd65f03c0]), new Uint8Array(), 'arm64');
  const decoder = new Arm64Decoder();
  try {
    const discovered = discoverFunctions({ image: base, decoder, revision: 2 }, createOperationContext());
    const caller = discovered.graphs.find((graph) => graph.function.entry.value === 0x1000n)!;
    const callee = discovered.graphs.find((graph) => graph.function.entry.value === 0x1008n)!;
    assert.equal(caller.instructions.length, 2);
    assert.equal(callee.instructions.length, 2);
    assert.equal(discovered.overlaps.length, 0);
    assert.equal(discovered.references.filter((reference) => reference.kind === 'call').length, 1);
  } finally { decoder.dispose(); }
});

test('public selected refinement preserves historical metadata and executes both dialects independently of unrelated roots',
  { timeout: 60_000 }, async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-selected-regression-')));
    const service = await QueryService.create({ authorized_roots: [root], max_workers: 1 });
    t.after(async () => { await service.close('cancel'); await rm(root, { recursive: true, force: true }); });
    for (const unrelated of [0, 64]) {
      const { image, entry } = sourceBuiltSelectedImage(unrelated), path = join(root, `project-${unrelated}`);
      const store = SqliteProjectStore.open(path, 'create');
      let functionId: string;
      try {
        await store.importImage({ bytes: image.bytes, sha256: image.sha256, selected_slice_id: image.selected_slice_id });
        const prepared = await prepareQueryImport(image, {
          revision: 2, context: createOperationContext({ budget: { instructions: 8 } }),
        });
        const publication = store.transaction(1, (tx) => {
          tx.putImage(prepared.image); prepared.publish(tx);
        });
        assert.equal(publication.state, 'committed', JSON.stringify(publication));
        const fn = store.queryRecords({ kind: 'function', revision: 2, image_id: image.id, limit: 1000 }).items
          .find((item) => item.entry.value === entry.value)!;
        assert.ok(fn);
        functionId = fn.id;
        if (unrelated) {
          assert.equal(fn.analysis, 'partial');
          assert.equal(fn.ranges.reduce((n, range) => n + range.size, 0n), 0n);
        }
      } finally { await store.close(); }
      const opened = await service.execute('project_open', {
        source: { kind: 'resume', project_path: path }, wait: true,
      });
      assert.ok('data' in opened && opened.project_id && opened.revision);
      const scope = { project_id: opened.project_id, revision: opened.revision, function_id: functionId };
      const before = await service.execute('function_get', { ...scope, view: 'metadata' });
      const disassembly = await service.execute('function_get', {
        ...scope, view: 'disassembly', budget: { instructions: 8 },
      });
      assert.equal(disassembly.state, 'complete', JSON.stringify(disassembly));
      assert.ok('data' in disassembly && disassembly.data.view === 'disassembly');
      assert.equal(disassembly.data.items.length, 2);
      if (unrelated) {
        assert.ok(disassembly.diagnostics.some((item) => item.message.startsWith('Selected-local graph refinement')));
        assert.ok(disassembly.evidence.some((item) => item.origin.kind === 'analysis' &&
          item.origin.rule === 'selected-local graph reconstruction'));
      }
      for (const emitter of ['c-like', 'python-like'] as const) {
        const result = await service.execute('function_decompile', {
          ...scope, wait: true, budget: { instructions: 8 }, options: { emitter },
        });
        assert.ok('data' in result && result.data.delivery === 'inline', JSON.stringify(result));
        const observed = execute(result.data.emission);
        assert.deepEqual(observed.values, [42n]);
        assert.deepEqual(observed.calls, []);
        assert.deepEqual([...observed.memory], []);
        assert.equal(result.revision, scope.revision);
      }
      const after = await service.execute('function_get', { ...scope, view: 'metadata' });
      assert.ok('data' in before && 'data' in after);
      assert.deepEqual(after.data, before.data);
      assert.equal(after.revision, before.revision);
      await service.execute('project_close', { project_id: scope.project_id, revision: scope.revision, running_jobs: 'wait' });
    }
  });

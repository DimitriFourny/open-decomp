import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
      const published = discoverFunctions(
        { image, decoder, revision: 2 },
        createOperationContext(),
      );
      const entry = 0x1000n + BigInt(unrelated * 8);
      const fn = published.graphs.find((graph) => graph.function.entry.value === entry)!.function;
      assert.equal(fn.analysis, 'complete');
      assert.equal(
        fn.ranges.reduce((n, range) => n + range.size, 0n),
        8n,
      );
      const graph = reconstructFunctionGraph(
        {
          project_id: `diagnosis-${unrelated}`,
          revision: 2,
          image,
          function: fn,
          functions: published.graphs.map((item) => item.function),
        },
        createOperationContext({ budget: { instructions: 8 } }),
      );
      return {
        instructions: graph.instructions.length,
        state: graph.coverage.state,
        budget_gaps: graph.gaps.filter((gap) => gap.reason === 'budget').length,
      };
    } finally {
      decoder.dispose();
    }
  });
  assert.deepEqual(observed[0], { instructions: 2, state: 'complete', budget_gaps: 0 });
  assert.deepEqual(observed[1], observed[0]);
});

test('direct native calls do not enlarge caller ownership', () => {
  // bl +8; ret; mov w0, #42; ret
  const base = navigationBytes(
    armWords([0x94000002, 0xd65f03c0, 0x52800540, 0xd65f03c0]),
    new Uint8Array(),
    'arm64',
  );
  const decoder = new Arm64Decoder();
  try {
    const discovered = discoverFunctions(
      { image: base, decoder, revision: 2 },
      createOperationContext(),
    );
    const caller = discovered.graphs.find((graph) => graph.function.entry.value === 0x1000n)!;
    const callee = discovered.graphs.find((graph) => graph.function.entry.value === 0x1008n)!;
    assert.equal(caller.instructions.length, 2);
    assert.equal(callee.instructions.length, 2);
    assert.equal(discovered.overlaps.length, 0);
    assert.equal(discovered.references.filter((reference) => reference.kind === 'call').length, 1);
  } finally {
    decoder.dispose();
  }
});

test(
  'public selected refinement preserves historical metadata and executes both dialects independently of unrelated roots',
  { timeout: 60_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-selected-regression-')));
    const service = await QueryService.create({ authorized_roots: [root], max_workers: 1 });
    t.after(async () => {
      await service.close('cancel');
      await rm(root, { recursive: true, force: true });
    });
    for (const unrelated of [0, 64]) {
      const { image, entry } = sourceBuiltSelectedImage(unrelated),
        path = join(root, `project-${unrelated}`);
      const store = SqliteProjectStore.open(path, 'create');
      let functionId: string;
      try {
        await store.importImage({
          bytes: image.bytes,
          sha256: image.sha256,
          selected_slice_id: image.selected_slice_id,
        });
        const prepared = await prepareQueryImport(image, {
          revision: 2,
          context: createOperationContext({ budget: { instructions: 8 } }),
        });
        const publication = store.transaction(1, (tx) => {
          tx.putImage(prepared.image);
          prepared.publish(tx);
        });
        assert.equal(publication.state, 'committed', JSON.stringify(publication));
        const fn = store
          .queryRecords({ kind: 'function', revision: 2, image_id: image.id, limit: 1000 })
          .items.find((item) => item.entry.value === entry.value)!;
        assert.ok(fn);
        functionId = fn.id;
        if (unrelated) {
          assert.equal(fn.analysis, 'partial');
          assert.equal(
            fn.ranges.reduce((n, range) => n + range.size, 0n),
            0n,
          );
        }
      } finally {
        await store.close();
      }
      const opened = await service.execute('project_open', {
        source: { kind: 'resume', project_path: path },
        wait: true,
      });
      assert.ok('data' in opened && opened.project_id && opened.revision);
      const scope = {
        project_id: opened.project_id,
        revision: opened.revision,
        function_id: functionId,
      };
      const before = await service.execute('function_get', { ...scope, view: 'metadata' });
      const disassembly = await service.execute('function_get', {
        ...scope,
        view: 'disassembly',
        budget: { instructions: 8 },
      });
      assert.equal(disassembly.state, 'complete', JSON.stringify(disassembly));
      assert.ok('data' in disassembly && disassembly.data.view === 'disassembly');
      assert.equal(disassembly.data.items.length, 2);
      if (unrelated) {
        assert.ok(
          disassembly.diagnostics.some((item) =>
            item.message.startsWith('Selected-local graph refinement'),
          ),
        );
        assert.ok(
          disassembly.evidence.some(
            (item) =>
              item.origin.kind === 'analysis' &&
              item.origin.rule === 'selected-local graph reconstruction',
          ),
        );
      }
      for (const emitter of ['c-like', 'python-like'] as const) {
        const result = await service.execute('function_decompile', {
          ...scope,
          wait: true,
          budget: { instructions: 8 },
          options: { emitter },
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
      await service.execute('project_close', {
        project_id: scope.project_id,
        revision: scope.revision,
        running_jobs: 'wait',
      });
    }
  },
);

test(
  'a body whose tail reserve exceeds the remaining work still returns text, and the skipped stages are named',
  { timeout: 120_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-tail-reserve-'))),
      fixtures = resolve('fixtures/bin');
    const service = await QueryService.create({
      authorized_roots: [root, fixtures],
      max_workers: 1,
      // Every request computes: the repeated budget below is not a cache hit.
      analysis_cache: false,
    });
    t.after(async () => {
      await service.close('cancel');
      await rm(root, { recursive: true, force: true });
    });
    const opened = await service.execute('project_open', {
      wait: true,
      source: {
        kind: 'import',
        input_path: join(fixtures, 'macho-arm64-symbols'),
        project_path: join(root, 'project'),
      },
    });
    assert.ok('data' in opened && opened.data.image, JSON.stringify(opened));
    const image = opened.data.image;
    const scope = { project_id: opened.project_id!, revision: opened.revision! };
    // fixture_check calls every other fixture function: optional callee summaries
    // and image types compete with its tail for the request's work.
    const address = '0x100000714';
    const found = await service.execute('functions_find', {
      ...scope,
      image_id: image.id,
      address: { image_id: image.id, space: 'va', value: address },
    });
    assert.ok('data' in found);
    const fn = found.data.items.find((item) => item.entry.value === address);
    assert.ok(fn);
    const decompile = (work?: number) =>
      service.execute('function_decompile', {
        ...scope,
        function_id: fn.id,
        wait: true,
        // Inline delivery: the text itself, not an artifact reference.
        budget: { output_bytes: 8 << 20, ...(work === undefined ? {} : { work }) },
      });
    const full = await decompile();
    assert.ok('data' in full && full.data.delivery === 'inline' && full.data.work);
    // Only the tail reserve leaves a zero pool: half of any positive remainder is not.
    const skippedStage = /^Native dependency worklist stopped at its work sub-budget \(0\)/;
    assert.ok(!full.diagnostics.some((item) => skippedStage.test(item.message)));
    const skipped: { work: number; text: string }[] = [];
    for (let step = 8; step < 20; step++) {
      const work = Math.floor((full.data.work * step) / 20);
      const result = await decompile(work);
      if (!('data' in result)) continue;
      assert.equal(result.data.delivery, 'inline');
      if (!result.diagnostics.some((item) => skippedStage.test(item.message))) continue;
      // The optional stage had nothing above the tail reserve: it stopped at its
      // first charge with its own reason, and the request is partial for budget.
      assert.equal(result.state, 'partial');
      assert.equal(result.reason, 'budget');
      assert.ok(result.data.emission.text.includes('fixture_arithmetic'));
      skipped.push({ work, text: result.data.emission.text });
    }
    assert.ok(skipped.length > 0, 'some budget leaves no pool above the tail reserve');
    // A function of the request's own counters: the same budget, the same text.
    const again = await decompile(skipped[0]!.work);
    assert.ok('data' in again && again.data.delivery === 'inline');
    assert.equal(again.data.emission.text, skipped[0]!.text);
  },
);

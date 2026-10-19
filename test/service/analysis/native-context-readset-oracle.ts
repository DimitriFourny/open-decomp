import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createOperationContext, newIdentity, type Lifter } from '../../../src/core/index.js';
import type { RegisterIR } from '../../../src/ir/index.js';
import { SqliteProjectStore } from '../../../src/project/store/index.js';
import { AnnotationService } from '../../../src/project/annotations/index.js';
import {
  createAnalysisReadset,
  validateAnalysisReadset,
} from '../../../src/project/cache/dependencies.js';
import { prepareQueryImport } from '../../../src/service/queries/prepare.js';
import { loadFunctionIndex } from '../../../src/service/queries/scope.js';
import { pipelineComponents } from '../../../src/service/analysis/versions.js';
import { prepareNativeUnit } from '../../../src/service/analysis/native-prepare.js';
import { recoverSourceEvidence } from '../../../src/service/analysis/source-facts.js';
import { resolveCalls } from '../../../src/service/analysis/calls.js';
import { recoverDebugInfo } from '../../../src/metadata/debug/index.js';
import { recoverLibraryContracts } from '../../../src/metadata/library-contracts/index.js';
import { loadImage } from './support.js';

// Direct real-runtime cache consumer: no repository runner and no analyzed execution.
const root = await mkdtemp(join(tmpdir(), 'native-context-readset-'));
const binary = join(root, 'analyzed');
const compiled = spawnSync(
  '/usr/bin/clang',
  [
    '-O1',
    '-g0',
    '-fno-builtin',
    '-fno-optimize-sibling-calls',
    resolve('test/service/analysis/native-context-source.c'),
    '-o',
    binary,
  ],
  { encoding: 'utf8' },
);
assert.equal(compiled.status, 0, compiled.stderr);
const image = loadImage(await readFile(binary));
const store = SqliteProjectStore.open(join(root, 'project'), 'create');
try {
  await store.importImage({
    bytes: image.bytes,
    sha256: image.sha256,
    selected_slice_id: image.selected_slice_id,
  });
  const imported = await prepareQueryImport(image, {
    revision: 2,
    context: createOperationContext(),
  });
  assert.equal(
    store.transaction(1, (tx) => {
      tx.putImage(imported.image);
      imported.publish(tx);
    }).state,
    'committed',
  );
  const index = loadFunctionIndex({ store, context: createOperationContext() }, 2, image);
  const caller = index.functions.find((fn) => fn.original_name === '_context_same');
  const callee = index.functions.find((fn) => fn.original_name === '_context_alias');
  assert.ok(caller && callee);
  const native = pipelineComponents(image.target),
    lifts = new Map<string, number>();
  const lifter: Lifter<RegisterIR> = {
    name: native.lifter.name,
    version: native.lifter.version,
    architecture: native.lifter.architecture,
    lift(graph, abi, context) {
      lifts.set(graph.function.id, (lifts.get(graph.function.id) ?? 0) + 1);
      return native.lifter.lift(graph, abi, context);
    },
  };
  const components = { ...native, lifter };
  const run = (revision: number, collect: boolean) => {
    const stages: string[] = [],
      context = createOperationContext({ onProgress: (phase) => stages.push(phase) });
    const dependencies = collect ? createAnalysisReadset(store, revision, context) : undefined;
    const scope = {
      store: dependencies?.store ?? store,
      context,
      job_id: 'trusted-native-readset-oracle',
      ...(dependencies ? { dependencies } : {}),
    };
    const input = {
      scope,
      revision,
      image,
      ...index,
      components,
      native_types: [],
      debug: recoverDebugInfo(image, context),
      library: recoverLibraryContracts({ image, abi: components.abi, revision }, context),
    };
    const selected = prepareNativeUnit(input, caller, context, []);
    assert.ok(selected.ir && selected.types);
    const facts = recoverSourceEvidence({
      ...input,
      ir: selected.ir,
      types: selected.types,
      calls: resolveCalls(selected.ir, image, index.functions, index.references, false, context),
      instruction_count: selected.instructions,
      coverage_reasons: selected.reasons,
      required_nodes: selected.required_nodes,
    });
    assert.equal(facts.callees.filter((call) => call.target_subject_id === callee.id).length, 1);
    const call = facts.callees.find((item) => item.target_subject_id === callee.id)!;
    assert.equal(call.context_assumptions?.aliases.length, 1);
    const fields =
      facts.memory_transfers?.flatMap((transfer) => transfer.parameter_shape.fields) ?? [];
    assert.ok(fields.some((field) => field.offset === 0n && field.width_bits === 64));
    assert.ok(fields.some((field) => field.offset === 8n && field.width_bits === 64));
    return { facts, readset: dependencies?.finish(), stages, remaining: context.remainingWork?.() };
  };
  run(2, false); // Cache a valid immutable body, intentionally without a ledger.
  const before = lifts.get(callee.id) ?? 0;
  const collected = run(2, true);
  assert.equal(
    lifts.get(callee.id),
    before + 1,
    'A no-ledger native body must be reprepared, never backfilled by guessing',
  );
  const replayed = run(2, true);
  assert.equal(
    lifts.get(callee.id),
    before + 1,
    'A ledger-bearing immutable body must be reused without lifting',
  );
  assert.ok(replayed.stages.includes('native_summary_cache'));
  assert.deepEqual(
    replayed.readset,
    collected.readset,
    'A native cache hit must replay the entire positive and negative readset',
  );
  assert.deepEqual(replayed.facts.memory_transfers, collected.facts.memory_transfers);
  assert.deepEqual(replayed.facts.callees, collected.facts.callees);
  assert.equal(
    replayed.remaining,
    collected.remaining,
    'A native cache hit must charge exactly the work of preparing the body',
  );
  assert.ok(replayed.readset);
  assert.ok(
    replayed.readset.reads.some(
      (read) => read.selector.kind === 'annotations' && read.selector.id === callee.id,
    ),
  );
  const applied = new AnnotationService(store).apply(
    {
      expected_revision: 2,
      author: 'trusted-native-readset-oracle',
      origin: 'user',
      edits: [
        {
          operation: 'set',
          id: newIdentity('annotation'),
          entity_id: callee.id,
          value: { kind: 'name', value: 'alias_annotation_hypothesis' },
          status: 'hypothesis',
          evidence_ids: [],
        },
      ],
    },
    createOperationContext(),
  );
  assert.equal(applied.state, 'committed');
  assert.equal(
    validateAnalysisReadset(store, 3, replayed.readset, createOperationContext()),
    false,
    'A new annotation on a formerly negative native subject must invalidate the dependent caller',
  );
  const changed = run(3, true);
  const priorScope = replayed.facts.callees.find((call) => call.target_subject_id === callee.id)
    ?.context_assumptions?.type_evidence_scope;
  const changedScope = changed.facts.callees.find((call) => call.target_subject_id === callee.id)
    ?.context_assumptions?.type_evidence_scope;
  assert.ok(priorScope && changedScope && priorScope !== changedScope);
  console.log(
    JSON.stringify({
      noledger_reprepared: true,
      cached_body_reused: true,
      complete_ledger_replayed: true,
      negative_annotation_invalidated: true,
      recovered_fields: [0, 8],
      reads: replayed.readset.reads.length,
    }),
  );
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}

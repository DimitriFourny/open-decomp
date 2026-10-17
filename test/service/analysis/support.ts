import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import {
  DEFAULT_BUDGET,
  ImmutableBytes,
  contentHash,
  createOperationContext,
  decodeArtifact,
  imageIdentity,
  newIdentity,
  toolSchemas,
  type AnnotationEdit,
  type Budget,
  type LoadedImage,
  type ToolInput,
  type ToolResult,
} from '../../../src/core/index.js';
import { MachOLoader } from '../../../src/loaders/macho/index.js';
import { PELoader } from '../../../src/loaders/pe/index.js';
import { ELFLoader } from '../../../src/loaders/elf/index.js';
import { SqliteProjectStore } from '../../../src/project/store/index.js';
import { prepareQueryImport } from '../../../src/service/queries/prepare.js';
import { executeAnnotations, executeDecompilation } from '../../../src/service/analysis/index.js';
import type { AnnotationSubject } from '../../../src/project/annotations/index.js';
import type { StoredDecompilation } from '../../../src/project/cache/index.js';
import { encodeAnnotationEdit } from '../../../src/core/index.js';

export function loadImage(input: Uint8Array): LoadedImage {
  const bytes = new ImmutableBytes(input),
    sha256 = contentHash(input),
    image_id = imageIdentity(sha256);
  const loader = input[0] === 0x4d
    ? new PELoader()
    : input[0] === 0x7f
      ? new ELFLoader()
      : new MachOLoader();
  return loader.load({ bytes, sha256, image_id, slice_id: null }, createOperationContext());
}

export async function project(t: TestContext, fixture: string | Uint8Array) {
  const image = loadImage(
    typeof fixture === 'string' ? readFileSync(join('fixtures/bin', fixture)) : fixture,
  );
  const path = mkdtempSync(join(tmpdir(), 'open-decomp-pipeline-'));
  const state = { store: SqliteProjectStore.open(path, 'create') };
  t.after(async () => {
    await state.store.close();
    rmSync(path, { recursive: true, force: true });
  });
  await state.store.importImage({
    bytes: image.bytes,
    sha256: image.sha256,
    selected_slice_id: image.selected_slice_id,
  });
  const prepared = await prepareQueryImport(image, {
    revision: 2,
    context: createOperationContext(),
  });
  assert.equal(
    state.store.transaction(1, (tx) => {
      tx.putImage(prepared.image);
      prepared.publish(tx);
    }).state,
    'committed',
  );
  const functions = state.store.queryRecords({
    kind: 'function',
    revision: 2,
    image_id: image.id,
    limit: 1000,
  }).items;
  function job(
    operation: 'function_decompile' | 'annotations_apply',
    revision = state.store.snapshot().revision,
  ): string {
    const id = newIdentity('job');
    state.store.saveJob({
      id,
      project_id: state.store.project_id,
      input_revision: revision,
      operation,
      state: 'running',
      progress: { phase: 'running', completed: 0, total: null },
      diagnostics: [],
      artifacts: [],
      published_revision: null,
    });
    return id;
  }
  async function decompile(
    function_id: string,
    overrides: Partial<ToolInput<'function_decompile'>> = {},
    remaining: number = DEFAULT_BUDGET.deadline_ms,
  ) {
    const args = toolSchemas.function_decompile.input.parse({
      project_id: state.store.project_id,
      revision: state.store.snapshot().revision,
      function_id,
      ...overrides,
    });
    const job_id = job('function_decompile', args.revision);
    const result = await executeDecompilation(args, {
      store: state.store,
      job_id,
      context: createOperationContext({ budget: { ...args.budget, deadline_ms: remaining } }),
    });
    return { result, job_id, args };
  }
  async function annotate(
    edits: readonly AnnotationEdit[],
    budget: Budget = DEFAULT_BUDGET,
    expected_revision = state.store.snapshot().revision,
  ) {
    const args = toolSchemas.annotations_apply.input.parse({
      project_id: state.store.project_id,
      expected_revision,
      author: 'pipeline-regression',
      origin: 'user',
      edits: edits.map(encodeAnnotationEdit),
      budget,
    });
    const job_id = job('annotations_apply', expected_revision);
    const result = await executeAnnotations(args, {
      store: state.store,
      job_id,
      context: createOperationContext({ budget }),
    });
    return { result, job_id };
  }
  function payload(result: ToolResult<'function_decompile'>): {
    result: StoredDecompilation;
    catalog: { subjects: AnnotationSubject[]; types: { id: string; source: string }[] };
  } {
    const artifact = decodeArtifact(result.artifacts[0]!);
    return JSON.parse(Buffer.from(state.store.readArtifactBytes(artifact)).toString('utf8')) as {
      result: StoredDecompilation;
      catalog: { subjects: AnnotationSubject[]; types: { id: string; source: string }[] };
    };
  }
  async function reopen(): Promise<void> {
    await state.store.close();
    state.store = SqliteProjectStore.open(path, 'resume');
  }
  return { image, state, functions, job, decompile, annotate, payload, reopen };
}

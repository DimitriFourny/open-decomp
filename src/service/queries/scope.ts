import type { FunctionGraph, FunctionRecord, LoadedImage, OperationContext, ProjectStore, StoredRecordKinds } from '../../core/index.js';
import { reconstructFunctionGraph } from './graphs.js';
import { queryFailure } from './shared.js';

export type IndexState = 'complete' | 'partial' | 'not_started';
type ReadScope = { readonly store: ProjectStore; readonly context: OperationContext };
export interface LoadedFunctionScope {
  readonly image: LoadedImage;
  readonly function: FunctionRecord;
}

// Immutable metadata only; annotation presentation always reads the requested revision.
// Four entries of at most 16 MiB bound retained bytes to 64 MiB per child.
const imageCache = new Map<string, LoadedImage>();
export function loadImage(store: ProjectStore, revision: number, id: string): LoadedImage {
  const slices = store.snapshot(revision).images.filter(item => item.image_id === id);
  if (!slices.length) queryFailure('not_found', 'Image is absent from the requested snapshot');
  if (slices.length !== 1) queryFailure('ambiguous_slice', 'Image-only query cannot select among multiple imported slices');
  const key = `${store.project_id}:${revision}:${id}`;
  const cached = imageCache.get(key);
  if (cached) return cached;
  const image = store.readLoadedImage(id, slices[0]!.selected_slice_id, revision);
  if (image.bytes.length <= 16 * 1024 * 1024) {
    if (imageCache.size >= 4) imageCache.delete(imageCache.keys().next().value!);
    imageCache.set(key, image);
  }
  return image;
}
export function records<K extends keyof StoredRecordKinds>(scope: ReadScope, revision: number, image_id: string, kind: K): { items: StoredRecordKinds[K][]; state: IndexState } {
  const items: StoredRecordKinds[K][] = [];
  let cursor: string | undefined;
  let state: IndexState = 'not_started';
  do {
    scope.context.checkpoint(1);
    const page = scope.store.queryRecords({ kind, image_id, revision, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const item of page.items) { scope.context.checkpoint(1); items.push(item); }
    state = page.index_state; cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return { items, state };
}

/** Resolve identity before decoding; cache hits need no full function-index scan. */
export function loadFunctionScope(scope: ReadScope, revision: number, id: string): LoadedFunctionScope {
  for (const stored of scope.store.snapshot(revision).images) {
    scope.context.checkpoint(1);
    const fn = scope.store.queryRecords({ kind: 'function', image_id: stored.image_id, revision, ids: [id], limit: 1 }).items[0];
    if (fn) return { image: loadImage(scope.store, revision, stored.image_id), function: fn };
  }
  return queryFailure('not_found', 'Function is absent from the requested snapshot');
}

/** Navigation and semantic analysis consume the same durable discovery boundaries. */
export function loadFunctionGraph(scope: ReadScope, revision: number, loaded: LoadedFunctionScope): FunctionGraph {
  const image = loaded.image;
  const navigationImage = {
    ...image,
    symbols: records(scope, revision, image.id, 'symbol').items,
    imports: records(scope, revision, image.id, 'import').items,
    exports: records(scope, revision, image.id, 'export').items,
  };
  return reconstructFunctionGraph({ project_id: scope.store.project_id, revision, image: navigationImage, function: loaded.function, functions: records(scope, revision, image.id, 'function').items }, scope.context);
}

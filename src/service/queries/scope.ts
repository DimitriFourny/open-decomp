import type {
  FunctionRecord,
  LoadedImage,
  OperationContext,
  ProjectStore,
  ReferenceRecord,
  StoredRecordKinds,
} from '../../core/index.js';
import { reconstructFunctionGraph, type QueryFunctionGraph } from './graphs.js';
import { queryFailure } from './shared.js';

export type IndexState = 'complete' | 'partial' | 'not_started';
type ReadScope = { readonly store: ProjectStore; readonly context: OperationContext };
export interface LoadedFunctionScope {
  readonly image: LoadedImage;
  readonly function: FunctionRecord;
}

// One immutable native-record materialization per live loader image/revision.
// Weak keys retain no image bytes after the store's own bounded cache evicts them.
const navigation = new WeakMap<
  LoadedImage,
  {
    readonly project_id: string;
    readonly revision: number;
    readonly image: LoadedImage;
    readonly functions: readonly FunctionRecord[];
    references?: readonly ReferenceRecord[];
  }
>();
export function loadImage(store: ProjectStore, revision: number, id: string): LoadedImage {
  const slices = store.snapshot(revision).images.filter((item) => item.image_id === id);
  if (!slices.length) queryFailure('not_found', 'Image is absent from the requested snapshot');
  if (slices.length !== 1)
    queryFailure(
      'ambiguous_slice',
      'Image-only query cannot select among multiple imported slices',
    );
  return store.readLoadedImage(id, slices[0]!.selected_slice_id, revision);
}
export function records<K extends keyof StoredRecordKinds>(
  scope: ReadScope,
  revision: number,
  image_id: string,
  kind: K,
): { items: StoredRecordKinds[K][]; state: IndexState } {
  const items: StoredRecordKinds[K][] = [];
  let cursor: string | undefined;
  let state: IndexState = 'not_started';
  do {
    scope.context.checkpoint(1);
    const page = scope.store.queryRecords({
      kind,
      image_id,
      revision,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of page.items) {
      scope.context.checkpoint(1);
      items.push(item);
    }
    state = page.index_state;
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return { items, state };
}

/** Resolve identity before decoding; cache hits need no full function-index scan. */
export function loadFunctionScope(
  scope: ReadScope,
  revision: number,
  id: string,
): LoadedFunctionScope {
  for (const stored of scope.store.snapshot(revision).images) {
    scope.context.checkpoint(1);
    const fn = scope.store.queryRecords({
      kind: 'function',
      image_id: stored.image_id,
      revision,
      ids: [id],
      limit: 1,
    }).items[0];
    if (fn) return { image: loadImage(scope.store, revision, stored.image_id), function: fn };
  }
  return queryFailure('not_found', 'Function is absent from the requested snapshot');
}

/** Navigation and analysis share selected-local traversal rooted in the same
 * durable native facts. Published observed ranges remain immutable metadata. */
export function loadFunctionGraph(
  scope: ReadScope,
  revision: number,
  loaded: LoadedFunctionScope,
  formatting = false,
): QueryFunctionGraph {
  const image = loaded.image;
  let indexed = navigation.get(image);
  if (!indexed || indexed.project_id !== scope.store.project_id || indexed.revision !== revision) {
    indexed = {
      project_id: scope.store.project_id,
      revision,
      image: {
        ...image,
        symbols: records(scope, revision, image.id, 'symbol').items,
        imports: records(scope, revision, image.id, 'import').items,
        exports: records(scope, revision, image.id, 'export').items,
      },
      functions: records(scope, revision, image.id, 'function').items,
    };
    navigation.set(image, indexed);
  }
  return reconstructFunctionGraph(
    {
      project_id: scope.store.project_id,
      revision,
      image: indexed.image,
      function: loaded.function,
      functions: indexed.functions,
      formatting,
    },
    scope.context,
  );
}

/** Reuse the immutable native function/reference arrays already materialized for
 * graph reconstruction; annotation/name presentation stays revision-specific. */
export function loadFunctionIndex(
  scope: ReadScope,
  revision: number,
  image: LoadedImage,
): {
  readonly functions: readonly FunctionRecord[];
  readonly references: readonly ReferenceRecord[];
} {
  const indexed = navigation.get(image);
  if (!indexed || indexed.project_id !== scope.store.project_id || indexed.revision !== revision)
    return {
      functions: records(scope, revision, image.id, 'function').items,
      references: records(scope, revision, image.id, 'reference').items,
    };
  indexed.references ??= records(scope, revision, image.id, 'reference').items;
  return { functions: indexed.functions, references: indexed.references };
}

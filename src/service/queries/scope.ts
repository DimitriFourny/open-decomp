import { buildOnce, useBuilt } from '../../core/index.js';
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
/** Completed record scans per store, by revision, image and kind (most recent last). */
const scans = new WeakMap<
  ProjectStore,
  Map<
    string,
    { readonly items: readonly unknown[]; readonly state: IndexState; readonly charges: number }
  >
>();
const MAX_SCANS_PER_STORE = 32;

/** Every record of a kind at a revision. The records of a committed revision never change, so
 * a completed scan is kept per store and a repeat (every `xrefs_get` reads all references:
 * seconds per query on a 160 KB binary) costs one dependency read: the one `rereadScopes`
 * makes, with the same work charges as the scan, so readsets, budgets and results are
 * unchanged. */
export function records<K extends keyof StoredRecordKinds>(
  scope: ReadScope,
  revision: number,
  image_id: string,
  kind: K,
): { items: StoredRecordKinds[K][]; state: IndexState } {
  let kept = scans.get(scope.store);
  if (!kept) scans.set(scope.store, (kept = new Map()));
  const key = `${revision}:${image_id}:${kind}`;
  const hit = kept.get(key);
  if (hit) {
    scope.store.queryRecords({ kind, image_id, revision, limit: 1 });
    for (let charge = 0; charge < hit.charges; charge++) scope.context.checkpoint(1);
    kept.delete(key);
    kept.set(key, hit);
    return { items: [...hit.items] as StoredRecordKinds[K][], state: hit.state };
  }
  let charges = 0;
  const counted: ReadScope = {
    store: scope.store,
    context: {
      ...scope.context,
      checkpoint(work) {
        scope.context.checkpoint(work);
        charges++;
      },
    },
  };
  const scanned = scan(counted, revision, image_id, kind);
  if (kept.size >= MAX_SCANS_PER_STORE) kept.delete(kept.keys().next().value!);
  kept.set(key, { items: [...scanned.items], state: scanned.state, charges });
  return scanned;
}
function scan<K extends keyof StoredRecordKinds>(
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

/** The dependency reads of a `records` scan, without the scan: one row per kind. An
 * operation that finds a `buildOnce` structure built makes the store reads its build
 * made, so its readset (and their capture charges) equals the building operation's. */
function rereadScopes(
  scope: ReadScope,
  revision: number,
  image_id: string,
  kinds: readonly (keyof StoredRecordKinds)[],
): void {
  for (const kind of kinds) scope.store.queryRecords({ kind, image_id, revision, limit: 1 });
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
  if (indexed?.project_id === scope.store.project_id && indexed.revision === revision) {
    useBuilt(scope.context, indexed);
    rereadScopes(scope, revision, image.id, ['symbol', 'import', 'export', 'function']);
  } else {
    // Materialized once per image; every operation pays its recorded cost once.
    indexed = buildOnce(scope.context, 'records', (quiet) => {
      const read = { store: scope.store, context: quiet };
      return {
        project_id: scope.store.project_id,
        revision,
        image: {
          ...image,
          symbols: records(read, revision, image.id, 'symbol').items,
          imports: records(read, revision, image.id, 'import').items,
          exports: records(read, revision, image.id, 'export').items,
        },
        functions: records(read, revision, image.id, 'function').items,
      };
    });
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
  useBuilt(scope.context, indexed);
  if (indexed.references) {
    useBuilt(scope.context, indexed.references);
    rereadScopes(scope, revision, image.id, ['reference']);
  } else
    indexed.references = buildOnce(
      scope.context,
      'references',
      (quiet) =>
        records({ store: scope.store, context: quiet }, revision, image.id, 'reference').items,
    );
  return { functions: indexed.functions, references: indexed.references };
}

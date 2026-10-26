# Local JavaScript / TypeScript API

Import the supported task-oriented API from **`open-decomp/api`**. It runs on Node.js, not in a browser, and uses the same `QueryService`, worker processes, SQLite projects and analysis contracts as MCP. It statically analyzes target bytes; it does not execute or debug the target process.

## Decompile a function

```js
import { openBinary } from 'open-decomp/api';

const binary = await openBinary('./app');
try {
  const result = await binary.decompile({ name: 'main' });
  if ('data' in result && result.data.delivery === 'inline') {
    process.stdout.write(result.data.emission.text);
    console.error({ state: result.state, cache: result.data.cache });
  } else {
    console.error(result);
  }
} finally {
  await binary.close();
}
```

Names match **exactly and case-sensitively**, against the original or displayed name. Some formats retain prefixes such as `_main`; use `findFunctions()` or the CLI to discover names. Select a stable function ID or an explicit static address instead when appropriate:

```js
const result = await binary.decompile(
  { address: { space: 'va', value: '0x100000574' } },
  { emitter: 'python-like', budget: { deadline_ms: 60_000 } },
);
```

Address values are unsigned hexadecimal strings, not JavaScript numbers. `va` is the static/unslid virtual address, `rva` is image-relative and `file` is an original-container offset. An address can match a function entry or a containing indexed range. More than one indexed match raises `FunctionSelectionError` rather than choosing the first result.

## Persistent sidecar

`openBinary(inputPath, options?)` resolves the real input path and hashes its contents in bounded chunks. The default cache root is `<canonical input path>.open-decomp/`. Each content hash and slice selection has a project directory beneath it:

```text
app
app.open-decomp/
  <sha256>.default/
    project.sqlite
    images/
    artifacts/
```

An explicit slice selection uses `<sha256>.<slice_id>` instead of `<sha256>.default`. These are ordinary persistent Open Decomp projects, not a second cache format. `binary.projectPath` can be resumed through MCP after the JS session closes.

- First use imports the immutable image and builds navigation indexes. Later opens resume them without importing or discovering functions again.
- The binary is still read to verify its content hash on every open. Unchanged timestamps or file sizes are not trusted as identity.
- Decompilation reuses the existing versioned artifact cache. `result.data.cache` is `computed` or `hit`; `result.data.work` is the work this request consumed (the counter `budget.work` bounds; a `hit` reports the small cost of serving the stored result, not the run that computed it, and the number takes no part in cache identity or the emission); emitter, options, budgets, target, revisions and component versions remain part of its identity.
- Annotation edits still advance the global exact-snapshot identity. The core service may validate a complete positive/negative dependency ledger and publish a new artifact at the new revision for unchanged computation; old proofs keep their actual history. Legacy artifacts without ledgers conservatively recompute across revisions. This is not permission to reuse a stale target, component, option or budget scope.
- Changed bytes select a new project. The old project is retained; restoring the old bytes can reuse it again.
- `cachePath` overrides the cache **root**, not an individual project path. Use it for read-only input directories or to keep sidecars elsewhere. Relative paths resolve against the current directory. There is no silent fallback to another location.
- Sidecars contain a copy of the input and potentially sensitive pseudocode. There is no automatic eviction. Do not delete a project while another process owns it.
- A project has one exclusive SQLite owner. Close a session before another CLI/API/MCP process opens the same project; concurrent ownership can fail with a database-lock error.
- Failed or interrupted imports are retained and **not automatically replayed**. Inspect/repair the exact project through MCP, or choose another cache root. Corrupt, mismatched and unsupported projects fail rather than returning stale results or being silently replaced.
- Versioned decompilation invalidation is not automatic reparsing of imported image metadata. A fresh cache root creates a fresh import when needed after importer changes.

Automatically discovered cache roots and project leaves must be directories, not symlinks. The API authorizes the canonical input directory and selected cache root for its own service. This is local trusted application configuration, not a filesystem sandbox; use MCP's explicit authorization boundary for untrusted remote clients.

## Open options and session properties

```ts
openBinary(inputPath: string, options?: OpenBinaryOptions): Promise<BinarySession>
```

| Option                                         | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cachePath?: string`                           | Cache-root override. Missing directories are created.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `sliceId?: string`                             | Explicit validated slice ID, for example from universal-image metadata.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `analysisCache?: boolean`                      | `false` disables analysis caching for this session (default `true`): no published result, reuse candidate or callee summary is read or written, and no summary is reused in process. Import and indexes still persist; output is identical.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `budget?`                                      | Partial shared budget for the initial import/project summary; unspecified fields use core defaults.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `signal?: AbortSignal`                         | Cancels opening/importing. Pass a signal separately for later operations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `onProgress?: (job: WireJob) => void`          | Import progress; optional, not a durable status record.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `openJob?: { jobs?, work?, signal? } \| false` | The open-time job (default **off** for the library; the CLI and MCP turn it on): after the open, the generic native unit of every indexed function is prepared (callees first, in helper processes, default half the cores and at most 8) and persisted in the project's unit store, so later decompiles reuse it. Pass `{}` to run it; `jobs` sets the helper count, `work` the job's own work budget summed over helpers (default 1,000,000,000), `signal` cancels the job alone (the open's `signal` cancels it too). It never fails the open, never changes output or per-request work, does not complete function discovery, and is skipped when `analysisCache` is `false`. Its outcome is `session.openJob`. |
| `unitStoreBytes?: number`                      | Byte cap on the project's persisted native units (compressed payload); default 256 MiB (`--unit-store-mib N` on the CLI). Past it superseded revisions, then the oldest writes, are evicted and the open-time job keeps callees first; rows the cap drops are prepared on demand with identical output and work.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `requestWorkers?: number`                      | Request workers, 1–32 (default 1). Above 1, decompiles run in that many worker processes over a shared read-only snapshot of the project and may be awaited concurrently (call `decompile()` / `decompileFunction()` without awaiting each); the session's project owner stays the single writer and publishes every result. Texts and per-function work are identical for every count. Each worker holds its own decoded image and prepared units, so memory grows with the count. `open-decomp export --jobs N` uses this.                                                                                                                                                                                        |

With `analysisCache: false` every `decompile()` is `cache: "computed"` and nothing derived is stored in the sidecar (`artifacts/`, `analysis_*` and `native_summaries` stay empty). A result that has to be delivered as an artifact (large or `delivery: "artifact"`) is held in memory by the owning worker for the session only; reading it works as usual and it is never indexed. Annotation catalogs and the investigation view consume published analyses, so they see only what earlier cache-enabled runs published. The same switch is `--no-analysis-cache` on the CLI and `mcp start`.

Session properties are `inputPath`, `cachePath`, `projectPath`, `reused`, `opened`, `image`, `projectId`, `revision` and `openJob`. `opened` is the original `project_open` envelope, preserving import diagnostics and coverage. `reused` describes project reuse, not whether a particular decompilation is a cache hit. `revision` advances only when this session commits a whole-image discovery step (see `completeDiscovery()` below). `openJob` is the open-time job's report, or `null` when it did not run: `state` (`completed`, `limited` by the work budget or the unit-store cap, `cancelled`, `failed`, or `skipped` when nothing was pending, analysis caching is off or the store is nearly full), `ms`, `work`, `jobs` (helpers), `prepared`, `retained` (units kept; units that hit a limit keep only a marker), `bytes`, `stored` (rows imported into the store) and an optional `message`.

## Settings file

The library never reads the user's settings file implicitly: `openBinary()` behaves the same on every machine. A program that wants the user's defaults (the same optional JSON the CLI reads: location, schema and precedence are in the [user guide](README.md#settings-file)) loads it explicitly and passes the values it wants:

```ts
import { loadSettings, openBinary } from 'open-decomp/api';
import type { Settings } from 'open-decomp/api';

const settings: Settings = await loadSettings(); // default file, or built-in defaults when it is missing
const binary = await openBinary('./app', {
  ...(settings.cache_root === null ? {} : { cachePath: settings.cache_root }),
  analysisCache: settings.analysis_cache,
});
try {
  const result = await binary.decompile(
    { name: 'main' },
    {
      emitter: settings.decompile.language,
      view: settings.decompile.view,
      inference: settings.decompile.inference,
    },
  );
} finally {
  await binary.close();
}
```

`loadSettings(path?)` returns the validated effective `Settings` (`version`, `cache_root: string | null`, `analysis_cache`, `decompile.{language,view,inference}`, `export.{language,jobs: number | null}`). Without `path` it reads `$XDG_CONFIG_HOME/open-decomp/settings.json` (else `~/.config/open-decomp/settings.json`) and returns the built-in defaults when that file is missing; an explicit `path` must exist. Invalid JSON, an unknown key, a wrong type or a wrong version rejects with a `SettingsError` whose message names the file path and key (`error.path`, `error.key`). An optional second argument supplies the environment (`{ XDG_CONFIG_HOME, HOME }`) instead of `process.env`, which keeps tests off the real home directory.

Precedence stays with the caller: an option you pass explicitly (for example `{ emitter: 'c-like' }`) is applied after, and therefore beats, the file value you chose to read. `Settings` and `loadSettings` are also exported from the root `open-decomp` entry.

## Find functions and page results

```js
let cursor;
do {
  const result = await binary.findFunctions({
    query: { text: 'parse', match: 'contains' },
    page: { limit: 100, ...(cursor ? { cursor } : {}) },
  });
  if (!('data' in result)) {
    console.error(result);
    break;
  }
  for (const fn of result.data.items) {
    console.log(fn.id, fn.entry.value, fn.display_name ?? fn.original_name);
  }
  if (result.state === 'partial') {
    console.error(result.reason, result.data.page.index_state);
  }
  cursor = result.data.page.next_cursor ?? undefined;
} while (cursor);
```

`findFunctions(options?, callOptions?)` accepts the shared `functions_find` query/paging/budget fields; it supplies the session's project, revision and image IDs. `callOptions` accepts `signal` and `onProgress`. Keep query filters unchanged across cursor pages. A terminal cursor under a partial index means the known index was exhausted, **not** that all functions are known.

`findSymbols(options?, callOptions?)`, `findStrings(options?, callOptions?)` and `getReferences(options, callOptions?)` are the same pattern for `symbols_find`, `strings_find` and `xrefs_get` (the last takes the `target`, `direction` and `kinds` fields); `getFunction(functionId, options?, callOptions?)` returns `function_get` metadata, compact/full disassembly or CFG pages. `selectFunction(selector, options?)` resolves a selector to one `BinaryFunction` exactly as `decompile()` does, and `decompileFunction(functionId, options?)` decompiles a function ID already obtained from `findFunctions` or `selectFunction` without repeating selector resolution. `completeDiscovery(budget?, callOptions?)` continues whole-image function discovery step by step (`functions_discover`, each step under `budget`) until a step makes no progress and returns whether any step progressed; each progressing step commits one project revision and updates `session.revision`. The CLI `export` command is built from these methods.

A recognized import stub/thunk/PLT entry has `kind: "import_stub"` (omitted otherwise) and the import's name; `decompile({ name })` selects it by that name.

## Image structure types

```ts
binary.types(options?: { budget? }, callOptions?): Promise<ToolResult<'binary_info'>>
binary.typeDeclarations(callOptions?): Promise<string | null>
```

`types()` runs `binary_info` view `types`: `data.text` is a self-contained C header of the image-wide merged structure types (the `struct_<hex>` names `decompile()` output uses, with the complete merged layout and a `first seen: <function>_arg0` comment naming the anchor; each function's text declares only the members it accesses; observed members only, sizes unknown), with `data.functions.analyzed/total` and `data.types`. It is `partial` (`budget`) when not every function body was analyzed within the budget. `data.library_id` and `data.library` list the image's type library (declarations made with the `types_declare` tool through MCP or `QueryService`: `name`, `type_id`, `annotation_id`, `status` and the C `declaration`); `decompile()` output already uses those names wherever annotations reference the types. `typeDeclarations()` returns just `data.text` (or `null` on failure). This API has no annotation or type-declaration methods; use `QueryService.execute('types_declare' | 'annotations_apply', …)` from the root export.

## Decompile and handle results

```ts
binary.decompile(selector: FunctionSelector, options?: DecompileOptions)
  : Promise<ToolResult<'function_decompile'>>
```

Choose exactly one selector: `{name}`, `{id}`, or `{address: {space, value}}`. Options are `emitter: 'c-like' | 'python-like'`, `view: 'source' | 'checked'`, `inference: 'proven' | 'likely'` (default `proven`; `likely` closes open argument lists with the gated heuristics of [CORE.md](CORE.md#inference-mode-likely), marks every guess `likely_arity(...)` in the text and records it as a `guess` inference; its results are cached apart from `proven` ones and a guess may be wrong), `source: 'decompiled' | 'reviewed'` (default `decompiled`; `reviewed` adds `data.reviewed_source`, the function's unique asserted reviewed source for `emitter` or `null`, with `stale` when the decompilation changed since it was written; never part of the cache identity), `structures: 'inline' | 'external'` (default `inline`; C-like `external` leaves the `typedef` and `struct` declarations out of the text and returns them in `emission.structures`, which `open-decomp export` writes once to `types.h`), a partial shared `budget`, `signal`, and `onProgress`. Function resolution (shared with the MCP function handles, `src/service/queries/selector.ts`) is a separate bounded navigation query; the supplied decompilation budget applies to analysis, and to each discovery step when the selection has to complete whole-image discovery (below), not to the navigation query.

The method waits for the operation and assembles artifact-backed output automatically. It validates page metadata, size, SHA-256 and the stored result's request binding. The returned inline result retains the **semantic** state, diagnostics, coverage and source mappings. Consequently, a returned object can exceed `budget.output_bytes`: that field bounds individual service delivery, not the assembled artifact. The existing 16 MiB analysis-artifact limit still applies. Output is C-like or Python-like **pseudocode**, not recovered original source or necessarily executable code.

`result.data.emission` is the canonical compact form: each entity identity, proof identity and binary range is stated once in `emission.ids`, `emission.evidence` and `emission.ranges`, and mappings, inferences and requirements cite those tables by `*_refs` index (`semantic_refs[0]` is a mapping's statement). Call `expandEmission(result.data.emission)` from `open-decomp/api` when you want the string-identity view with `statement_id`, `semantic_ids`, `subject_ids`, `instruction_ids`, `evidence_ids` and `ranges`; it adds, drops or reorders nothing.

```ts
import { expandEmission } from 'open-decomp/api';
if ('data' in result && result.data.delivery === 'inline')
  for (const mapping of expandEmission(result.data.emission).mappings)
    console.log(mapping.statement_id, mapping.start, mapping.end, mapping.evidence_ids);
```

Do not equate a resolved promise with complete analysis. `complete`, `partial`, `failed`, `unsupported` and `cancelled` remain distinct shared result states. Partial results retain their reason; unresolved machine semantics are not suppressed. Check for `data` before reading pseudocode.

Selection by `{id}` or `{address}` accepts the single indexed function. Selection by `{name}` matches the native name or its C spelling (Mach-O symbols carry one leading underscore: `sqlite3_limit` and `_sqlite3_limit` both name `_sqlite3_limit`). When the function index is complete, one match resolves, several raise `FunctionSelectionError` with `reason: 'ambiguous'` and `candidates`, and none is `not_found`. When the function index is partial, a name is resolved only through the complete native symbol and export tables (the `Native symbol and export tables` format capability, which unrelated partial metadata such as DWARF CFI does not degrade): exactly one defining address with exactly one indexed function there resolves; two or more defining addresses, or a second indexed function carrying the name, are `ambiguous`; anything else, including a name known only from the partial index, or a symbol whose function is not yet indexed, is `incomplete` with the candidates found. These errors do not prove anything about undiscovered functions. An `incomplete` selection makes `decompile()` / `selectFunction()` run `completeDiscovery()` to its end and select again against the final index (a stripped image may need many steps, each a committed revision); `FunctionSelectionError` with `reason: 'incomplete'` is thrown only when discovery made no progress or the final index still cannot settle the selection (for example a root exceeds the instruction limit of the supplied `budget`).

Opening failures that return a service envelope throw `BinaryOpenError`, carrying `result`, `projectPath` and `reused`. Filesystem, invalid-argument and integrity errors can throw directly. Failed/unsupported function-resolution queries throw their diagnostic as `OperationError`; ordinary decompilation operation failures remain result envelopes. Cancellation can reject during local hashing, selection or artifact assembly, or return an operation's cancelled state; always close in `finally`.

`close(): Promise<void>` is idempotent. It cancels any remaining work, closes the database and releases the worker. It preserves the saved project. Calls after closing are rejected.

## Advanced integration

`ToolInput`, `ToolResult`, `WireJob`, `QueryCallOptions`, `OpenJobOptions`, `OpenJobReport`, `expandEmission` with its `Expanded*` view types, `loadSettings` / `SettingsError` / `Settings`, and the task-oriented API's option/query/selector types are exported from `open-decomp/api`, with TypeScript declarations. The existing root `open-decomp` entry exposes lower-level `QueryService`, schemas and engine components; use it when you need annotations (a global is annotated by `address` or by its `globalDataIdentity(slice, address)` entity ID), memory reads, durable asynchronous jobs or direct project ownership. See the [core contracts](CORE.md). Remote clients should use MCP rather than treating the local API as an authenticated network service.

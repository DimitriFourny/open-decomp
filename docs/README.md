# Open Decomp user guide

Open Decomp is a headless native-binary workbench for LLM clients and ordinary programs. It statically loads native images, exposes structured navigation and evidence, runs its own typed-IR decompiler, and saves revisioned investigations in SQLite. Instruction decoders are dependencies; they are not external decompiler backends. The current development checkout emits **C-like and Python-like machine-state pseudocode**, not recovered original source, necessarily recompilable C or executable Python.

**License and distribution:** Open Decomp's first-party code and documentation are licensed under [MIT](../LICENSE). Bundled dependencies retain their own rights and obligations; read [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Release archives are identified by their own hashes and sibling manifests, not merely by the current checkout. The package remains marked private to prevent accidental npm publication; that packaging setting does not restrict the MIT grant.

## Status and supported targets

- Targets: Mach-O ARM64 executables/dylibs, including explicit ARM64 selection in universal containers; PE32+ x86-64 executables/DLLs using Windows x64 ABI; ELF64 little-endian x86-64 ET_EXEC/ET_DYN images using System V AMD64 ABI. Target format/ISA/ABI are explicit, never inferred from the host.
- Execution hosts: **macOS arm64 with Node 24.22.0 is verified**. Linux, including **WSL using Linux Node**, is an intended execution environment but is **not yet host-qualified**. Native Windows/`win32` Node execution is outside the product requirement and remains unverified as a complete host. The package's engine range is not evidence that every allowed Node version was tested. `node:sqlite` is experimental in the exercised runtime and may emit a stderr warning.
- **Targets are not execution hosts.** Windows PE x64, macOS Mach-O ARM64 and Linux ELF/System V x64 are statically analyzed on macOS without executing those binaries or needing a Windows/Linux VM. Windows users are expected to run the tool inside WSL, with Linux Node/filesystem/process APIs, not `node.exe`. Cross-compilation does not establish Linux/WSL host qualification; no additional VM/native-Windows qualification is required for the current macOS first-local-release scope.

Completed plans, task boards, release verification records and legacy migration captures are retained in Git history rather than maintained alongside the code. Installed-run claims must identify the exact archive and its sibling release manifest; each fresh archive needs its own installed acceptance.

There is no GUI, target debugger/emulator, binary patcher, tool-exposed shell, symbol-server downloader or whole-program equivalence proof.

## Installation

See [INSTALLATION.md](INSTALLATION.md) for source-checkout setup, runtime and host requirements, and offline installation of a packaged release. The [root quickstart](../README.md) covers the shortest path to analyzing a binary.

## Task-oriented CLI and persistent cache

The development checkout adds human commands without requiring an AI or a manual MCP session:

```sh
open-decomp functions ./app --name main
open-decomp decompile ./app --function main
open-decomp decompile ./app --address va:0x100000574 --language python-like
open-decomp decompile ./app --function main --json --cache ./analysis-cache

open-decomp export ./app --out ./app-decomp --jobs 4
open-decomp types ./app > app-types.h
open-decomp decompile ./app --function main --no-analysis-cache

```

`functions --name` is a case-insensitive substring search; `decompile --function` is exact and case-sensitive. Use discovered original/display names (including format-specific prefixes), a stable `--id`, or an explicit `--address va:0x...`, `rva:0x...` or `file:0x...`. Multiple indexed matches are an error, not a first-match selection. `types` prints the image-wide merged structure types as C declarations, the same names `decompile` uses, with the complete merged layout (a function's text declares only the members it accesses; observed members only). All commands support `--help`, `--cache PATH`, and explicit `--slice ID`.

### Export a whole binary as a greppable directory

`export BINARY --out DIR [--language c-like|python-like] [--jobs N] [--name SUBSTRING] [--cache PATH] [--slice ID] [--no-analysis-cache]` is the fastest way for an agent with file tools to read a binary: one process decompiles every function and writes

- `DIR/functions/NAME@0xADDR.c` (`.py` for python-like): one header comment (name, address, state and reason, code bytes, caller and callee names; `?` marks an unresolved indirect call) followed by exactly the text `decompile` prints. Names are the C spelling of the native symbol (Mach-O's leading underscore dropped); unnamed functions are `sub_<hex>` (or the import a stub forwards to). Filenames are sanitized and unique.
- `DIR/functions/NAME@0xADDR.asm`: only for functions with no pseudocode (failed, unsupported, cancelled); the header states why and the body is the compact native disassembly, so no function is missing.
- `DIR/index.tsv` (address, name, file, state, reason, code_bytes = instruction bytes of the function body, callers, callees), `strings.tsv` (address, escaped text, referencing functions), `imports.tsv`, `exports.tsv`, `types.h` (the image-wide merged structure types the pseudocode names, as `open-decomp types` prints them) and a short `README.txt`.

Output order and content are deterministic, re-running overwrites generated files, and the exit status is 0 whenever everything was written; partial and failed functions are rows in `index.tsv`. Native indexes that are incomplete (function discovery and references usually are) are named on stderr and in `README.txt`: caller/callee/referenced-by lists are then lower bounds. `--jobs N` (default `min(4, CPUs/2)`) runs N workers; because a project database has one owner, extra workers analyze private copy-on-write copies of the finished import under the cache root and remove them afterwards, so only the first worker's decompilations are cached for later runs. `--name` limits the export to functions whose name contains the text. SIGINT/SIGTERM stop the export (exit 130/143) before the index files are written.

The default sidecar is **`<canonical binary path>.open-decomp/`**, containing content-addressed SQLite project directories, immutable input snapshots, navigation indexes and analysis artifacts. Unchanged bytes resume the existing project; matching decompilations return cache hits. Each invocation still reads/hashes the binary to validate identity. Changed bytes select a new entry without overwriting earlier investigations. `--cache` overrides the cache root for read-only input locations or centralized storage. There is no silent fallback, automatic eviction or automatic replay of failed imports.

Analysis is cached in the sidecar at two levels, both keyed to the exact project revision, image, target and component versions, and both validated against the project before use: published decompilation results (a repeated request returns a cache hit) and, since storage schema 6, **prepared callee summaries** (`native_summaries`), which let a later process skip re-analyzing callees an earlier process already analyzed. Summaries are capped at 64 MiB per project (compressed; superseded revisions go first, then the oldest write), are written in one batch per request and never on a pure cache hit; see [CORE.md](CORE.md#analysis-cache-and-persisted-callee-summaries). **`--no-analysis-cache`** (`functions`, `decompile`, `export`, `types`) disables both: no published result, reuse candidate or callee summary is read or written, and nothing is reused inside the process either. The import and its indexes still persist, and the pseudocode, state and diagnostics are identical; repeated and cross-process runs are slower (it is not `--cache PATH`, which only moves the sidecar). A result too large for the inline budget is still deliverable by artifact, held in memory for the session only.

Each project has one exclusive owner: close a CLI/API/MCP session before opening the same project elsewhere. The CLI prints the exact project path, which MCP can subsequently resume. Sidecars can contain sensitive target bytes and pseudocode; do not treat them as disposable while another process owns them.

Text decompilation goes to stdout; progress, cache/project information and diagnostics go to stderr. `--json` emits `{project_path,reused,result}`. For function listing, `result` is `{pages:[...]}`, preserving each original schema envelope while consuming all cursors. Decompilation returns the full result envelope, automatically assembling and checking artifact-backed output. Diagnostics on stderr are compacted to one line per distinct caveat (counts, one name list for partial callee summaries, no info-level lines); `--json` keeps every diagnostic. Results remain pseudocode, with partial/unknown semantics intact.

| Exit code    | Meaning                                                                           |
| ------------ | --------------------------------------------------------------------------------- |
| `0`          | Complete or empty requested result.                                               |
| `2`          | Semantic partial result, including an exhausted incomplete index.                 |
| `1`          | Usage, filesystem, integrity or operation error; unsupported/cancelled operation. |
| `130`, `143` | Interrupted by SIGINT or SIGTERM; owned workers are closed.                       |

For Node.js/TypeScript applications, use the small **`open-decomp/api`** entry: `openBinary()`, `findFunctions()`, `decompile()` and `close()`. It shares the CLI's persistent cache and the MCP service's contracts. See [API.md](API.md) for runnable usage patterns, lifecycle, paging, errors and cache policy.

## Launch and configure local MCP

Create separate existing directories for input binaries and persistent projects. Authorize only those directories. Run `open-decomp mcp start` for foreground stdio (the default transport), or invoke the installed entry directly:

```sh
node /absolute/app/node_modules/open-decomp/dist/src/cli/entry.js mcp start --root /absolute/inputs --root /absolute/projects
```

The only package binary is `open-decomp` (Bun installs its local executable under `node_modules/.bin`). Direct Node invocation avoids shell/PATH and Windows shim differences. Bare `open-decomp` prints command help; MCP requires the explicit `mcp start` subcommand.

A typical MCP host configuration is below; the outer configuration location/shape is host-specific. Use the absolute Node 24.22.0 executable and installed entry, not a source-checkout package script:

```json
{
  "mcpServers": {
    "open-decomp": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/app/node_modules/open-decomp/dist/src/cli/entry.js",
        "mcp",
        "start",
        "--root",
        "/absolute/inputs",
        "--root",
        "/absolute/projects",
        "--max-workers",
        "2",
        "--max-queued",
        "16"
      ]
    }
  }
}
```

For intended WSL use, the MCP process must execute Linux Node and the installed entry inside WSL, with Linux-visible absolute input/project paths. How an outer Windows MCP host launches WSL is host-specific; the configuration above describes the process inside that Linux environment. Native `C:\\...\\node.exe` launch is not the product execution model.

| CLI option            | Contract                                                                                                                                                                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--transport stdio`   | Optional explicit stdio selection; stdio is the default for `mcp start`.                                                                                                                                                                                                                  |
| `--root PATH`         | Repeatable, at most 64 existing authorized directories; at least one required. No cwd/home root is implicit.                                                                                                                                                                              |
| `--max-workers N`     | Persistent project workers, 1–32, default 2. Open projects consume owners; close unused ones.                                                                                                                                                                                             |
| `--max-queued N`      | Queued jobs per worker, 0–1,024, default 16.                                                                                                                                                                                                                                              |
| `--no-analysis-cache` | Server-wide: no published results, reuse candidates or persisted/in-process callee summaries are read or written. Imports, indexes and annotations still persist; output is identical but repetition is slower. Not a tool-request option. With `--transport http` it follows `--config`. |
| `--help`, `--version` | Print to stderr, not protocol stdout.                                                                                                                                                                                                                                                     |

For stdio, stdout must remain protocol traffic; help, version and diagnostics use stderr. The SDK owns framing and version negotiation. EOF and catchable termination signals cancel/reap project owners; use `project_close` for an orderly durable close before disconnecting.

Use `open-decomp mcp start --transport http --config /absolute/private/config.json` (or `bun run mcp:http --config ...` from a built checkout) for the same tools/resources over official-SDK Streamable HTTP. Both transports use `dist/src/cli/entry.js`; `mcp start --help` and `mcp start --transport http --help` show transport-specific options. [REMOTE.md](REMOTE.md) documents provisioning, exact limits and lifecycle. Authentication is private, operator-provisioned high-entropy bearer authentication with stored SHA256 hashes, **not OAuth/SSO**. Every request is authenticated; each principal has disjoint private project ownership, its own service/worker pool, and authorized input roots. Non-loopback listeners require native TLS; Host/Origin allowlists do not create CORS/browser support or an OS sandbox.

HTTP work transfers to the principal at validated, authorized service dispatch, not at a guaranteed durable commit. After dispatch, disconnects, HTTP deadlines and SDK cancellation do not automatically cancel work; use `analysis_cancel`, and inspect durable state after a lost acknowledgement rather than replaying mutations. This ownership differs from a local stdio process's EOF shutdown.

### Safety boundary

Inputs, symbols, strings and notes are untrusted data, not instructions to the LLM or host. The service never runs a target, loads a target-selected library/module or fetches an embedded URL. Authorized roots and bounded worker processes provide fault containment, **not an OS filesystem/network sandbox or a hard RSS limit**. Workers inherit the user's OS permissions. Use separate OS isolation for hostile inputs or untrusted local processes capable of modifying authorized directories. Never authorize an entire home directory just to bypass an access failure.

## Investigation, jobs and durable revisions

Use MCP tool discovery for exact live schemas, then follow this workflow:

1. **Import:** call `project_open` with `source: { kind: "import", input_path: ABSOLUTE_INPUT, project_path: ABSOLUTE_NEW_PROJECT }`. Both paths must be authorized. The project owns an immutable byte snapshot identified by content hash and selected slice; later modifications to the original input do not change it. Supply `slice_id` when selecting a universal slice.
2. **Follow admission:** import defaults to a durable `queued` job; `function_decompile` defaults to `wait: "auto"` (the finished result if it completes within seconds, else the job); `wait: false` always returns the job. Save `project_id`, the acknowledged `revision` and job ID. Use `analysis_status` with those handles; `known_revision` is the last host-acknowledged snapshot. A completed import's acknowledgement can briefly lag its terminal job state. `wait: true` requests a final response instead of admission-only delivery, not unlimited work.
3. **Inspect before inferring:** `function_decompile` and `function_get` select a function by exact name, `va:0x…` address or a unique `entity_` ID prefix (≥12 hex digits) as well as a full ID; search listings print short IDs. The default `function_decompile` reply is one header line (`name @ va | state(reason) | artifact_<12 hex>`), one `caveats:` line (distinct warnings in compact form: open-arity calls, uncertain return storage, callee summaries cut by budget) and the pseudocode; `detail: "full"` adds the complete structured envelope. Use `binary_info` and its capability/index views, search symbols/imports/exports and strings, follow xrefs, find stable function IDs, then get metadata/disassembly/CFG and decompile selected functions. `function_get` with `view: "disassembly"` takes `detail: "compact"` for mnemonic/operand text without raw bytes and structured operands (omitted means `full`; any other view rejects `detail`). Page until `next_cursor` is null, retaining the same normalized query and revision.
   To audit a decompilation, call `function_get` with `view: "investigation"` and the `artifact_id` of a published decompile result (the header's 12-hex handle or the full ID; required; it never reanalyzes or picks the latest artifact). It pages typed inference, requirement, source-mapping, signature and helper items (`kinds`, optional original `subject_id`), with proof locators that resolve in that artifact. See [CORE.md](CORE.md).
4. **Read the result state and evidence:** `complete` means the requested bounded operation finished, not exhaustive semantic or whole-image support. `partial` includes a reason (`budget`, `incomplete_index`, `unsupported_subset`, `output_limit`). On `function_decompile`, `output_limit` with inline delivery means only provenance metadata (mappings/inferences/requirements, named in `emission.omitted` and the `provenance` coverage layer) was bounded out; the pseudocode is complete. `empty` means a completely indexed, exhausted query with no items. `queued`, `running`, `unsupported`, `failed` and `cancelled` are distinct outcomes. A `null` component version means not run/loaded, not an invented version.
5. **Annotate and reanalyze:** submit one atomic `annotations_apply` batch at `expected_revision`. Success advances the project revision once and invalidates derived results conservatively. Use the returned revision for new requests; recompute before annotating another derived-only semantic ID. Durable functions/imports remain addressable. Old cursors and cached output are snapshot-bound, not reusable at a new revision.
6. **Close:** `project_close` takes the acknowledged revision and `running_jobs: "reject" | "wait" | "cancel"` (default `reject`). Waiting/cancelling may reconcile a newer committed revision; use the returned persisted revision. `analysis_cancel` distinguishes cancellation completed, cancellation requested and work already finished. Ending the admitting MCP request does not cancel an already-returned durable job.
7. **Resume:** call `project_open` with `source: { kind: "resume", project_path: ABSOLUTE_PROJECT }`. Ordinary resume does not retry unfinished imports: it may return `partial/incomplete_index` with `data.image: null`, so inspect saved jobs and close before repair. Explicit import `mode: "resume"` repairs only an empty/unfinished import with matching immutable bytes and slice; it is not general reimport/reindex.

After a lost mutation acknowledgement, inspect durable state/history and reconcile revisions; **do not blindly replay the edit**. Stale requests fail with the requested snapshot retained and current revision reported separately. Function splits/merges use new identities and lineage rather than transferring assertions silently.

### Evidence and annotation rules

Binary facts, debug records, library contracts, analysis deductions and user/LLM assertions have separate origins, revisions, dependencies and conflicts. A pretty demangled name is display information, not proof of a signature, object layout, argument count or nonreturning behavior. Unknown calls remain conservative.

Annotations can set a name, note, type declaration/structure or signature, or retract/remove a previous annotation. Supply stable annotation/subject IDs, the batch author and `origin: "user" | "llm"`; sets are `hypothesis` or `asserted` with supporting `evidence_ids`. An assertion does not become an immutable binary/debug fact. Conflicting alternatives remain visible. Retraction keeps a visible non-influencing assertion; removal is a separate historical event with its actor retained. Each annotation ID occurs at most once in a batch; stale/invalid/oversized batches roll back entirely.

Names are mutable labels, never identities. Derived values/fields require the current trusted analysis catalog. Source declarations, observed memory shapes and machine signatures are different evidence: a memory access extent is not an inferred object size, and missing source arity is not inferred from register liveness.

ABI argument lists distinguish a known prefix from a complete list of actual arguments. Ordinary prototyped nonvariadic lists may establish arity; variadic declarations and unprototyped prefixes do not. Complete variadic/unprototyped actuals require explicit `argument_list_complete: true`; unknown parameters remain unknown regardless. SysV variadic AL is an upper bound on vector-register usage (at most eight), not a source parameter or proof that unknown anonymous arguments are absent.

## Tool schemas and application API

All 14 MCP tools expose concrete input/output JSON Schemas and structured content with a text block (for navigation tools a lossless compact projection decoded by `decodeNavigationText`; see [CORE.md](CORE.md)). Requests reject extra keys. Machine integers/addresses are unsigned hexadecimal strings, not JSON numbers; an address includes `image_id`, `space: "va" | "rva" | "file"` and `value`. `file` is original-container offset, including a selected fat-slice offset; `va` is static/unslid and `rva` is image-relative. Ranges are half-open. Memory views distinguish real bytes, zero-fill and unmapped holes.

| Tool                                             | Main purpose                                                                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `project_open`, `project_close`                  | Import/resume, owner/job close policy and persistence.                                                                                                                   |
| `binary_info`                                    | Summary, headers, sections, mappings, entries, relocations, hints, capabilities, and merged image structure types as C declarations.                                     |
| `symbols_find`, `strings_find`, `functions_find` | Snapshot-bound filtered/paged navigation. Matching is exact/prefix/contains, not arbitrary regex; Mach-O names also match their C spelling (leading underscore removed). |
| `function_get`                                   | Metadata, structured disassembly with gaps, or CFG.                                                                                                                      |
| `function_decompile`                             | Bounded homemade analysis and C-like or Python-like output with source/evidence mappings.                                                                                |
| `xrefs_get`                                      | Incoming/outgoing references, including unresolved edges.                                                                                                                |
| `evidence_get`                                   | Resolve evidence IDs delivered by navigation results to records, optionally with ancestors.                                                                              |
| `memory_read`                                    | Bounded byte/integer/float/pointer interpretations; machine bits remain hexadecimal.                                                                                     |
| `annotations_apply`                              | Atomic revision-checked assertion edits.                                                                                                                                 |
| `analysis_status`, `analysis_cancel`             | Durable job inspection and cancellation.                                                                                                                                 |

Read the [core contract reference](CORE.md) for detailed tool semantics, result states, codecs, cache rules and schema/storage distinctions. The installed root ESM export includes `toolSchemas`, `exportToolJsonSchemas()`, request/response validators, `QueryService`, loaders, decoders, lifters and other engine APIs; TypeScript declarations ship with the compiled entry. For programmatic schema export:

The task-oriented local application entry is [`open-decomp/api`](API.md); use it to avoid manual project/revision/job handling for function listing and decompilation. The root exports below remain available for lower-level integration.

```js
import { exportToolJsonSchemas } from 'open-decomp';
console.log(JSON.stringify(exportToolJsonSchemas(), null, 2));
```

The wire schema is version 1. Exported JSON Schema is draft 2020-12; runtime Zod refinements additionally enforce cross-field and publication invariants. Clients must not bypass those invariants simply because JSON Schema accepts an object.

Set `function_decompile`'s `options.emitter` to `"c-like"` (default) or `"python-like"`. Both consume the same IR-backed source reconstruction in `src/reconstruction`; neither dialect rewrites the other's text. Native output projects ABI arguments and results before liveness analysis, folds flag comparisons and packed register fragments, and removes dead scratch-register and effect-token plumbing. Branches, loops, simultaneous transfers and ordered calls/memory operations remain shared between dialects.

Established source contracts take precedence. Without them, demanded ABI inputs and bounded observations of native callees produce explicitly **inferred interfaces**, not persisted or proven prototypes. Split register cells are assembled into source values. Grounded library contracts supply external calls; contextual rules can close a known variadic prefix, such as `open(path, 0)`. Unresolved arguments and live non-result clobbers remain explicit unknowns rather than fabricated values or purity claims.

Private, nonoverlapping, definitely initialized stack slots permit spill forwarding or scalar locals. Escaped, overlapping or potentially uninitialized storage retains a shared byte frame. Source-level output abstracts private frame save/restore traffic and caller-saved scratch state—not externally visible memory effects. Globals and immutable string literals use exact image/address evidence. Arithmetic retains widths through C-like casts or Python-like fixed-width helpers; floating/vector and unresolved semantics retain helpers. Output remains pseudocode rather than original source or universally executable C/Python. Hidden and synthesized values map back to original instruction/semantic subjects through final-text UTF-16 spans.

The development root API exports neutral `EmissionInput` / `EmissionResult` from `src/emitters/model.ts`, `CEmitter` / `emitC` / `C_EMITTER_VERSION`, and `PythonLikeEmitter` / `emitPythonLike` / `PYTHON_LIKE_EMITTER_VERSION`. Both entrypoints invoke the same reconstruction and renderer. Cache identities bind the full selected `Target` (format, ISA, ABI, endian, address width and features), image/slice, component versions, revisions, function, options and budgets, including selected emitter/version; mismatched payload language/version is rejected.

Current emitter identities are `reconstructed-c-4` and `reconstructed-python-like-4`; the composed analysis version includes `pipeline/4` and `reconstruction/2`, invalidating earlier snapshot-oriented artifacts for new requests. Versioned cache invalidation is not automatic native-image reparsing.

HTTP embedding exposes `startHttpServer` / `HttpServerHandle` and `loadHttpConfig` / `HttpConfig`; these are transport entry points, not a new public analysis protocol. `HttpServerHandle` reports the bound `url` and an idempotent asynchronous `close()`; trusted embedding-only worker options are never network configuration.

### Artifacts and delivery

Large decompilations return explicit `partial/output_limit` artifact delivery, not silently truncated pseudocode. Read the published resource link/template:

```text
open-decomp://artifact/{project_id}/{revision}/{artifact_id}?offset={offset}&length={length}
```

Use hexadecimal `offset`, length at most 524,288 bytes, and the returned next URI/offset until done. Resource metadata retains the exact artifact handle, consumed length and encoding. Text/JSON pages preserve UTF-8 scalar boundaries (length ≥4 fits every scalar); other media is base64. Verify the full handle's size/hash after assembly. Source-mapping spans count UTF-16 code units, whereas output limits count UTF-8 bytes. Artifact IDs are project/revision-bound, not arbitrary filesystem paths or access tokens; the project must be open under authorized roots.

## Limits and semantic coverage

| Request bound         |   Default |     Maximum |
| --------------------- | --------: | ----------: |
| Page items            |       100 |       1,000 |
| Memory-read bytes     |     4,096 |   1,048,576 |
| Instructions          |    10,000 |   1,000,000 |
| Blocks                |    10,000 |     100,000 |
| IR nodes              |   100,000 |  10,000,000 |
| Cumulative work units | 1,000,000 | 100,000,000 |
| Deadline milliseconds |    30,000 |     300,000 |
| Output bytes          | 1,048,576 |  16,777,216 |

Minimum output budget is 1,024 bytes. Defaults use conservative unknown calls, bounded indirect-target recovery, evidence included, C-like output and two-space indentation. Raising a budget is not proof of completeness and does not silently extend already-published partial function ranges. Full analysis artifacts are limited to 16 MiB. Image storage separately bounds individual records at 16 MiB, aggregate encoded metadata at 64 MiB and facts at one million; these are serialized-data bounds, **not process-memory ceilings**.

Local stdio frames/wrappers are capped at 2 MiB, pending requests and pending output messages at eight each, request string IDs at 1,024 UTF-8 bytes. Drain replies; a write stalled for 30 seconds closes the connection. Larger non-analysis delivery is an error, not silent truncation. HTTP has its own bounded connection/request/work lanes and deadlines documented in [REMOTE.md](REMOTE.md), while preserving the tool/resource delivery ceiling. Work/deadline/queue limits and artifact delivery limits are separate. [Performance evidence](PERFORMANCE.md) includes real partial imports, failed limit probes and observed worker RSS; do not extrapolate small-fixture latency or file size into a large-input SLA.

Recognition, lifting, ABI, analysis and reconstruction report **separate coverage**:

- **ARM64:** baseline integer/arithmetic/flags, shifts/bitfields, control flow, ordinary scalar/SIMD loads/stores and pairs, stack/calls, common fixed-lane integer SIMD, scalar FP32/64 and selected vector FP. FPCR guards restrict arithmetic to nearest-even/gradual-underflow/masked-exception behavior; NaNs/status are abstracted. Pointer authentication uses logical-address abstractions with diagnostics, not hardware authentication semantics. SVE/SME, atomics, barriers other than the modelled `DMB ISH` (lifted to an ordered inner-shareable `memory_fence`; other barrier encodings/domains remain unsupported, see the [ARM64 adapter](ARM64.md)), privileged state, fused/FP16 and unimplemented SIMD remain unknown boundaries. See the [ARM64 adapter](ARM64.md).
- **x86-64:** legacy long-mode register slices, integer arithmetic/flags, multiply/divide with explicit divide-error paths, shifts/conditions/control flow, memory/stack/calls, SSE scalar/packed FP and common packed integer moves/add/sub/bitwise. MXCSR is guarded; exact FP environment/status is not emulated. x87/MMX, REP/string, atomic LOCK/memory XCHG, AVX/later encodings, advanced bit/SIMD, crypto, privileged/transactional operations and CET enforcement are outside the implemented subset. See the [iced-x86 adapter](X86_64.md).
- **Metadata/ABI:** Darwin ARM64, Windows x64 and System V AMD64 retain LP64/LLP64, calling-convention, stack, aggregate and variadic distinctions. SysV models independent INTEGER/SSE banks, aggregate rollback/mixed returns, hidden result buffers, callee-entry stack offsets including the return address, no Windows shadow space, and a 128-byte red-zone capability—not proof that a negative access is owned or survives calls. SysV `long double` has an 80-bit value and 128-bit object storage; x87 value reconstruction remains unsupported. Unknown layouts do not establish later allocation certainty. Mach-O Objective-C metadata names methods (`-[Class sel]`), selector stubs and constant strings, and resolved sends print as messages (`[recv sel:arg]`, Python-like `recv.sel_(arg)`; see CORE.md); other debug/Objective-C/Swift/C++ metadata improves evidence, not full source-language recovery. PE CodeView identity is not full PDB reconstruction. Packed/encrypted, self-modifying, JIT and managed .NET bodies are not silently interpreted as ordinary native functions.
- **ELF boundary:** requires bounded valid program/section tables, unambiguous PT_LOAD translations, ELF64LE EM_X86_64 ET_EXEC/ET_DYN and OSABI 0 or 3; OSABI 0 does not prove Linux kernel behavior. Sectionless images, extended table counts/indexes and ELF DWARF recovery are unsupported. Native symbols, dynamic records, evidenced import slots and relocations remain usable; `DT_NEEDED` alone does not assign each import to a library. No dependency loading, relocation execution, ASLR bias, PLT callable-entry reconstruction, TLS runtime allocation or GNU IFUNC-selected target is guessed. Packed relocation/decompression gaps remain explicit. A symbol-bearing ELF arithmetic function can truthfully report aggregate `partial` because source metadata is unavailable while decode/lift/ABI are complete and all reconstruction units/mappings are present.

Unsupported instructions are not no-ops or invented guaranteed traps. Unknown effects, decode gaps, unresolved indirect transfers and conservative call clobbers stay visible. A printed instruction or `complete` query is not full-ISA support. The [fixture inventory and provenance](FIXTURES.md) describe the corpus, not a universal support guarantee.

## Troubleshooting

| Symptom                                           | Action / boundary                                                                                                                                                             |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No connection / CLI usage error                   | Use the installed stdio entry and correct Node executable; create authorized root directories first. Check stderr; do not redirect logs into protocol stdout.                 |
| Access denied / path outside roots                | Authorize the narrow input/project directories and use actual absolute paths. Cursors/artifact IDs do not confer filesystem authority.                                        |
| Worker/queue resource limit                       | Drain replies, inspect/cancel jobs and close unused projects. Increase only the documented CLI/request limits when appropriate.                                               |
| Empty search under partial indexes                | Inspect `page.index_state`, result reason and diagnostics. Zero returned items under an incomplete index are not evidence of absence.                                         |
| Stale revision/cursor or unavailable derived ID   | Adopt the acknowledged current revision, restart the query and reanalyze before editing derived-only IDs. Do not replay uncertain mutations.                                  |
| Failed import / image null after resume           | Inspect saved jobs/diagnostics; ordinary reopen does not retry. Close, then use explicit matching import repair if eligible, or create a fresh project.                       |
| Output limit / large pseudocode                   | Follow the artifact link and chunk metadata. Increasing inline budget cannot override the MCP frame ceiling.                                                                  |
| Partial/unsupported decompilation                 | Inspect per-layer coverage and original instruction evidence. Recognition/demangling does not establish semantics; do not erase unknown boundaries.                           |
| Experimental SQLite warning                       | Expected stderr under the exercised Node runtime; it is not protocol output. Do not suppress unrelated SQLite corruption/resource diagnostics.                                |
| Missing `dist/vendor/a64js` or WASM after install | Reject the incomplete artifact. Help-only success is inadequate; rebuild/package from the maintained driver and verify the resulting bytes, without source-tree fallbacks.    |
| High RSS or slow large input                      | Consult measured profiles and budgets; workers/serialized limits are not a hard heap sandbox. Reduce workload/isolate the process rather than claiming full-image completion. |

## Updating and backing up projects

Close projects and stop the MCP process before backing up the entire project directory (SQLite and project-owned images/artifacts together) or changing application versions. Retain the previous archive/manifest and a pre-upgrade project backup. Install the new reviewed private artifact in a separate application directory, validate its manifest/installed workflow, then change the MCP entry path and resume a copied project. Do not assume an older application can read storage migrated by a newer one; restore the matching backup to roll back.

Storage schema 6 (which adds the `native_summaries` table; schema 5 added `analysis_reuse`) transactionally migrates schemas 1–5 and preserves historical facts/revisions. This is **not automatic re-parsing by a new loader**. Versioned derived-cache invalidation and native-index refresh are separate concerns. When loader interpretations change, make a fresh project from the same immutable input and explicitly review/reapply assertions using stable evidence and lineage; no public reindex command or automatic historical metadata rewrite is promised. Do not copy cache files between projects or reinterpret old component-version output as newly verified analysis.

Dependency updates require reviewed exact pins/lockfile, full license/notices and WASM closure, changed component versions when semantics change, and new regression/compiled/installed/host evidence. Follow [a64js snapshot maintenance](../vendor/a64js/README.md), including source/emitted hashes and the recorded transformation; do not silently regenerate against a different Arm release. Unresolved public-redistribution questions in the notices remain unresolved by a successful build or private installation.

## Developer commands — source checkout only

These commands require the source repository and development dependencies. They are **not installed-app runtime requirements** and are not claims that a command has been run for your artifact. Use Node 24.22.0 for application/test execution and Bun 1.4.3 for package management, pinned by `.bun-version` and `package.json`'s `packageManager` field. Release packaging and installed acceptance also require native `tar` on PATH to inspect and stage archives; application execution does not. Install the checked-in `bun.lock` without changing its resolutions:

```sh
bun install --frozen-lockfile
node --import tsx scripts/bench/fetch-evidence.ts --from "$EVIDENCE_BACKUP" --only baseline-2026-10-17.tar.gz
bun run check
node dist/scripts/release-acceptance.js
bun run smoke:mcp
```

`check` runs typecheck, tests and compilation using the existing `tsc`, Node `node:test` and `tsx` toolchain. Run tests with `bun run test`, **not `bun test`**; Bun is not the application or test runtime. The release harness is the maintained official-SDK client driving the actual compiled server; its `--server-entry PATH --fixtures PATH` options select another entry/corpus. Fixture `bin`, sibling `manifest.json`, `elf-manifest.json` and `malformed` inputs must agree. It never executes analyzed binaries. General fixture rebuild/native trusted-execution commands are separate explicit developer actions documented in [FIXTURES.md](FIXTURES.md), not install/service behavior.

Formatting runs the exact-pinned local ESLint Stylistic fixer before Prettier; the pinned Bun 1.4.3 does not provide `bun fmt`. From the repository root:

```sh
bun run format        # Rewrite supported first-party files
bun run format:check  # Check without writing; exits 1 for formatting differences
bun run format src/emitters/renderer.ts
bun run format:check src/emitters/renderer.ts
```

Optional paths restrict both stages to those files or directories; without paths, both stages process the checkout. `eslint.config.js` requires blank lines between consecutive class methods, without requiring separators between fields or statements. It keeps TypeScript overload signatures grouped. ESLint inserts the method separators and Prettier preserves them.

`.prettierrc.json` uses two-space indentation, single quotes, semicolons, trailing commas and a 100-column print width. Both stages respect `.gitignore` and `.prettierignore`, excluding the Bun lockfile, vendored code, license snapshots, fixture corpora and hash-bound fixture generation recipes. Prettier-aware editors use the same local dependency and configuration; run the formatting command to apply the method-spacing rule too.

`bun run check` gates the whole tree: typecheck, `format:check` (type-aware `typescript-eslint` recommended rules including `no-floating-promises`, then Prettier), `test:unit`, `test:integration` and build. `bun run lint` runs ESLint alone; `bun run test` runs both test suites. Integration tests spawn clang, python3, the source CLI or MCP servers, extract tarballs or use real timers; they skip with an explicit reason when `/usr/bin/clang` or `python3` is unavailable. The list of integration files is in `scripts/test.ts`; any other `*.test.ts` is a unit test.

Retained benchmark archives are not in git. `scripts/bench/evidence-assets.json` pins their sizes and SHA256 hashes. The canonical store is `<repo>/.local/evidence/` (gitignored, so back it up yourself), preserving original repo-relative paths; `$OPEN_DECOMP_EVIDENCE_DIR` overrides the destination/resolver store. The fetch command above populates it from another copy of the archives: exactly one of `--from DIR` or `--url-base URL` (a published mirror) is required, and `--only NAME` selects one archive. No public mirror is currently configured. The SQLite interfaces regression explicitly skips with the fetch command when its baseline is absent; fetch it before `check` to run that test. Corrupt evidence fails rather than skips. See [evidence archive setup](PERFORMANCE.md#evidence-archive-setup).

`tsconfig.build.json` compiles `src`, vendored a64js and only the drivers that run from `dist` (`smoke`, `mcp-smoke`, `release-acceptance`, and the `pipeline`, `resources` and `incremental-controlled` benchmarks); other scripts and tests run from source with `node --import tsx`.

Output fingerprint guard: `test/service/output-fingerprint.test.ts` pins a hash of the canonical expanded emission of a fixed fixture/function/dialect set against the analysis identity (versions). If emitted output changes while the identity does not, it fails: bump `src/service/analysis/versions.ts` (and the emitter version when presentation changed) and regenerate with `bun run fingerprints`.

Produce and verify a private artifact:

```sh
bun run pack:release --out .local/release
bun run verify:installed --artifact /absolute/path/open-decomp-0.1.0.tgz --fixtures fixtures/bin
```

Packaging invokes the existing build after cleaning only declared generated `dist`, then uses Bun packing to create a true bundled `.tgz`; retain both archive and `<archive>.release.json`. To keep Bun 1.4.3 offline installation self-contained, the driver stages the Bun-packed contents, lists bundled packages explicitly and omits staged dependency/dev-dependency declarations before the final `bun pm pack --destination DIR --ignore-scripts --quiet`. It does not change source `package.json`; the manifest retains its SHA256 and original production declarations. Use a fresh output location if the driver rejects a collision. Installed acceptance verifies the sibling manifest, installs the actual archive outside the repository with an empty Bun cache and `--offline --ignore-scripts --production`, checks the public import, both real decoders and all three WASM demanglers, then reuses real MCP release scenarios with copied hash-bound fixture inputs. Harness/client SDK assets are developer-only; the installed server must not depend on them or on the source tree. Record actual results separately for each host; a script's existence is not an installed pass.

Earlier npm-built archives require their matching historical verifier; their manifests are not compatibility inputs for the current Bun release verifier.

For measured benchmark reproduction and reviewed external input setup, follow [PERFORMANCE.md](PERFORMANCE.md). The runtime does not fetch benchmark inputs, raw Arm references, symbol servers or target-selected URLs. Preserve manifests, host/runtime details, typed failures and partial states alongside successful measurements.

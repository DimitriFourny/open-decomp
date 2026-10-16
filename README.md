# Open Decomp — private local release

Open Decomp is a headless native-binary workbench for LLM clients and ordinary programs. It statically loads native images, exposes structured navigation and evidence, runs its own typed-IR decompiler, and saves revisioned investigations in SQLite. Instruction decoders are dependencies; they are not external decompiler backends. The current development checkout emits **C-like and Python-like machine-state pseudocode**, not recovered original source, necessarily recompilable C or executable Python.

**Distribution boundary:** the frozen private `open-decomp` 0.1.0 local artifacts are distinct from the current development checkout; no new F01/F02/F03 extension artifact has yet been built/installed. This is not an npm publication or an application-wide open-source license grant. Third-party rights remain separate; read [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). The fixture MIT grant is [fixture-only](fixtures/LICENSE).

## Status and supported targets

- Targets: Mach-O ARM64 executables/dylibs, including explicit ARM64 selection in universal containers; PE32+ x86-64 executables/DLLs using Windows x64 ABI; ELF64 little-endian x86-64 ET_EXEC/ET_DYN images using System V AMD64 ABI. Target format/ISA/ABI are explicit, never inferred from the host.
- Intended hosts: macOS arm64 and Windows x86-64. **Node 24.22.0 is the exercised runtime.** The package's engine range is not evidence that every allowed Node version was tested. `node:sqlite` is experimental in this runtime and may emit a stderr warning.
- Current macOS development evidence: strict typecheck, **852/852 tests** (six suites, zero skipped), build, and actual compiled stdio acceptance for **eight fixtures and both emitters**. Compiled HTTP/HTTPS ELF investigations additionally cover executable/shared, symbol-bearing/stripped, both emitters, hash-paged artifacts, annotations, cache reuse and full server restart. Earlier F01/F02 compiled HTTP/HTTPS Mach-O/PE evidence and frozen-release resource evidence remain separately scoped. See [release verification](RELEASE-VERIFICATION.md) and [performance evidence](PERFORMANCE.md) for hashes, options, limits and exact scope.
- The frozen pre-extension private artifact's public import, both decoders, all three WASM demanglers and all 24 maintained MCP scenarios passed on macOS after an external empty-cache offline installation. Those results do **not** qualify the extensions. Windows lifecycle failures, performance measurements and installed-artifact acceptance remain separate release gates; the focused frozen-candidate Windows stalled-output probe failed its 120-second watchdog.
- PE target analysis does not require a Windows host: macOS cross-compiles and statically analyzes PE fixtures. Windows-host qualification instead checks actual Windows process/pipe/filesystem/installation behavior with focused compiled acceptance and required decoder/ABI smoke, not repeated full core-suite runs. Windows-host support and A01–A12 remain required; QEMU is sufficient for focused host checks, but TCG observations are not native Windows throughput.

Bundled verification/plan/backlog documents are **build-time snapshots**, not evidence of a subsequent installation. Bind installed-run claims to the actual archive and its sibling release manifest; consult the coordinator's current evidence before calling the release gate complete. [PLAN.md](PLAN.md) describes direction and A01–A12; [TODO.md](TODO.md) records remaining gates.

**Development extensions:** F01 Python-like emission, F02 private authenticated MCP Streamable HTTP/native TLS, and F03 ELF/System V AMD64 are implemented and exercised on macOS as described above; installation and current Windows/release qualification are not complete. There is no GUI, target debugger/emulator, binary patcher, tool-exposed shell, symbol-server downloader or whole-program equivalence proof.

## Install the private artifact

Obtain the produced `.tgz` **and its sibling `<tgz filename>.release.json`**, for example `open-decomp-0.1.0.tgz` and `open-decomp-0.1.0.tgz.release.json`. Keep them together. The manifest binds SHA256, byte size, npm integrity, lockfile digest, Node/npm versions and package inventory to the archive. A worktree-derived build is not necessarily a clean Git commit; no bit-identical cross-host build is promised.

Install in an application directory outside the source checkout with Node/npm already available. For example, in a POSIX shell (substitute actual absolute paths):

```sh
mkdir open-decomp-local
cd open-decomp-local
npm init -y
npm install --offline --ignore-scripts --omit=dev /absolute/path/open-decomp-0.1.0.tgz
```

On Windows, run the same npm commands with the actual absolute Windows archive path. Production dependencies, their WASM assets, compiled `dist/src` and compiled `dist/vendor/a64js` are bundled. Installation requires neither a sibling repository, compiler, network fetch, fixture corpus nor development dependencies. It does not execute analyzed targets. Keep the archive and manifest as the installation/update provenance record; ordinary npm installation does not itself validate the separate manifest. The source-only installed-acceptance driver below performs that validation and the empty-cache offline closure check.

Do not use a registry `npx open-decomp` command or patch `node_modules` to compensate for a broken artifact. A successful `--help` alone does not establish runtime closure: package import, worker startup, both decoders and all three demangler WASM paths must also work.

## Launch and configure local MCP

Create separate existing directories for input binaries and persistent projects. Authorize only those directories. The installed entry can be launched directly:

```sh
node /absolute/app/node_modules/open-decomp/dist/src/mcp/stdio.js --root /absolute/inputs --root /absolute/projects
```

The package binary is `open-decomp` (npm installs its local executable under `node_modules/.bin`). Direct Node invocation avoids shell/PATH and Windows shim differences. The CLI help's usage label is `open-decomp-mcp`; this is not a second installed binary.

A typical MCP host configuration is below; the outer configuration location/shape is host-specific. Use the absolute Node 24.22.0 executable and installed entry, not a source-checkout npm script:

```json
{
  "mcpServers": {
    "open-decomp": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/app/node_modules/open-decomp/dist/src/mcp/stdio.js",
        "--root", "/absolute/inputs",
        "--root", "/absolute/projects",
        "--max-workers", "2",
        "--max-queued", "16"
      ]
    }
  }
}
```

On Windows use JSON-escaped paths such as `C:\\tools\\node\\node.exe`, `C:\\analysis\\app\\node_modules\\open-decomp\\dist\\src\\mcp\\stdio.js`, `C:\\analysis\\inputs` and `C:\\analysis\\projects`.

| CLI option | Contract |
| --- | --- |
| `--root PATH` | Repeatable, at most 64 existing authorized directories; at least one required. No cwd/home root is implicit. |
| `--max-workers N` | Persistent project workers, 1–32, default 2. Open projects consume owners; close unused ones. |
| `--max-queued N` | Queued jobs per worker, 0–1,024, default 16. |
| `--help`, `--version` | Print to stderr, not protocol stdout. |

The first local release uses **stdio**. Stdout must remain protocol traffic; consume stderr separately. The SDK owns framing and version negotiation. EOF and catchable termination signals cancel/reap project owners; use `project_close` for an orderly durable close before disconnecting.

The current development checkout also provides `open-decomp-mcp-http --config /absolute/private/config.json` (`dist/src/mcp/http/entry.js`, or `npm run mcp:http -- --config ...`) for the same tools/resources over official-SDK Streamable HTTP. [REMOTE.md](REMOTE.md) documents provisioning, exact limits and lifecycle. Authentication is private, operator-provisioned high-entropy bearer authentication with stored SHA256 hashes, **not OAuth/SSO**. Every request is authenticated; each principal has disjoint private project ownership, its own service/worker pool, and authorized input roots. Non-loopback listeners require native TLS; Host/Origin allowlists do not create CORS/browser support or an OS sandbox.

HTTP work transfers to the principal at validated, authorized service dispatch, not at a guaranteed durable commit. After dispatch, disconnects, HTTP deadlines and SDK cancellation do not automatically cancel work; use `analysis_cancel`, and inspect durable state after a lost acknowledgement rather than replaying mutations. This ownership differs from a local stdio process's EOF shutdown.

### Safety boundary

Inputs, symbols, strings and notes are untrusted data, not instructions to the LLM or host. The service never runs a target, loads a target-selected library/module or fetches an embedded URL. Authorized roots and bounded worker processes provide fault containment, **not an OS filesystem/network sandbox or a hard RSS limit**. Workers inherit the user's OS permissions. Use separate OS isolation for hostile inputs or untrusted local processes capable of modifying authorized directories. Never authorize an entire home directory just to bypass an access failure.

## Investigation, jobs and durable revisions

Use MCP tool discovery for exact live schemas, then follow this workflow:

1. **Import:** call `project_open` with `source: { kind: "import", input_path: ABSOLUTE_INPUT, project_path: ABSOLUTE_NEW_PROJECT }`. Both paths must be authorized. The project owns an immutable byte snapshot identified by content hash and selected slice; later modifications to the original input do not change it. Supply `slice_id` when selecting a universal slice.
2. **Follow admission:** import and `function_decompile` default to durable `queued` jobs. Save `project_id`, the acknowledged `revision` and job ID. Use `analysis_status` with those handles; `known_revision` is the last host-acknowledged snapshot. A completed import's acknowledgement can briefly lag its terminal job state. `wait: true` requests a final response instead of admission-only delivery, not unlimited work.
3. **Inspect before inferring:** use `binary_info` and its capability/index views, search symbols/imports/exports and strings, follow xrefs, find stable function IDs, then get metadata/disassembly/CFG and decompile selected functions. Page until `next_cursor` is null, retaining the same normalized query and revision.
4. **Read the result state and evidence:** `complete` means the requested bounded operation finished, not exhaustive semantic or whole-image support. `partial` includes a reason (`budget`, `incomplete_index`, `unsupported_subset`, `output_limit`). `empty` means a completely indexed, exhausted query with no items. `queued`, `running`, `unsupported`, `failed` and `cancelled` are distinct outcomes. A `null` component version means not run/loaded, not an invented version.
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

All 13 MCP tools expose concrete input/output JSON Schemas, structured content and readable JSON text. Requests reject extra keys. Machine integers/addresses are unsigned hexadecimal strings, not JSON numbers; an address includes `image_id`, `space: "va" | "rva" | "file"` and `value`. `file` is original-container offset, including a selected fat-slice offset; `va` is static/unslid and `rva` is image-relative. Ranges are half-open. Memory views distinguish real bytes, zero-fill and unmapped holes.

| Tool | Main purpose |
| --- | --- |
| `project_open`, `project_close` | Import/resume, owner/job close policy and persistence. |
| `binary_info` | Summary, headers, sections, mappings, entries, relocations, hints and capabilities. |
| `symbols_find`, `strings_find`, `functions_find` | Snapshot-bound filtered/paged navigation. Matching is exact/prefix/contains, not arbitrary regex. |
| `function_get` | Metadata, structured disassembly with gaps, or CFG. |
| `function_decompile` | Bounded homemade analysis and C-like or Python-like output with source/evidence mappings. |
| `xrefs_get` | Incoming/outgoing references, including unresolved edges. |
| `memory_read` | Bounded byte/integer/float/pointer interpretations; machine bits remain hexadecimal. |
| `annotations_apply` | Atomic revision-checked assertion edits. |
| `analysis_status`, `analysis_cancel` | Durable job inspection and cancellation. |

Read the [core contract reference](src/core/README.md) for detailed tool semantics, result states, codecs, cache rules and schema/storage distinctions. The installed root ESM export includes `toolSchemas`, `exportToolJsonSchemas()`, request/response validators, `QueryService`, loaders, decoders, lifters and other engine APIs; TypeScript declarations ship with the compiled entry. For programmatic schema export:

```js
import { exportToolJsonSchemas } from 'open-decomp';
console.log(JSON.stringify(exportToolJsonSchemas(), null, 2));
```

The wire schema is version 1. Exported JSON Schema is draft 2020-12; runtime Zod refinements additionally enforce cross-field and publication invariants. Clients must not bypass those invariants simply because JSON Schema accepts an object.

Set `function_decompile`'s `options.emitter` to `"c-like"` (default) or `"python-like"`. Both consume the same lifted IR, shared analysis and emitter-neutral structured presentation; Python-like output is not a rewrite of C text or a separate semantic pipeline. Finite-width helpers, effect tokens, physical-state snapshots, labels/gotos and indeterminate control remain explicit; Python-like spelling does not imply Python's unbounded integer semantics.

The development root API exports neutral `EmissionInput` / `EmissionResult` from `src/emitters/model.ts`, `CEmitter` / `emitC` / `C_EMITTER_VERSION`, and `PythonLikeEmitter` / `emitPythonLike` / `PYTHON_LIKE_EMITTER_VERSION`. Both dialects use a shared presentation renderer with direct final-text UTF-16 source mappings. Cache identities bind the full selected `Target` (format, ISA, ABI, endian, address width and features), image/slice, component versions, revisions, function, options and budgets, including selected emitter/version; mismatched payload language/version is rejected. Old C-specific emission input/result names are removed, not compatibility aliases.

Current emitter identities are `typed-machine-c-2` and `typed-machine-python-like-2`; changed ABI/call/type semantics also use `stack-calls/2`, `library/2` and `types/2` in the composed analysis version. Versioned cache invalidation is not automatic native-image reparsing.

HTTP embedding exposes `startHttpServer` / `HttpServerHandle` and `loadHttpConfig` / `HttpConfig`; these are transport entry points, not a new public analysis protocol. `HttpServerHandle` reports the bound `url` and an idempotent asynchronous `close()`; trusted embedding-only worker options are never network configuration.

### Artifacts and delivery

Large decompilations return explicit `partial/output_limit` artifact delivery, not silently truncated pseudocode. Read the published resource link/template:

```text
open-decomp://artifact/{project_id}/{revision}/{artifact_id}?offset={offset}&length={length}
```

Use hexadecimal `offset`, length at most 524,288 bytes, and the returned next URI/offset until done. Resource metadata retains the exact artifact handle, consumed length and encoding. Text/JSON pages preserve UTF-8 scalar boundaries (length ≥4 fits every scalar); other media is base64. Verify the full handle's size/hash after assembly. Source-mapping spans count UTF-16 code units, whereas output limits count UTF-8 bytes. Artifact IDs are project/revision-bound, not arbitrary filesystem paths or access tokens; the project must be open under authorized roots.

## Limits and semantic coverage

| Request bound | Default | Maximum |
| --- | ---: | ---: |
| Page items | 100 | 1,000 |
| Memory-read bytes | 4,096 | 1,048,576 |
| Instructions | 10,000 | 1,000,000 |
| Blocks | 10,000 | 100,000 |
| IR nodes | 100,000 | 10,000,000 |
| Cumulative work units | 1,000,000 | 100,000,000 |
| Deadline milliseconds | 30,000 | 300,000 |
| Output bytes | 1,048,576 | 16,777,216 |

Minimum output budget is 1,024 bytes. Defaults use conservative unknown calls, bounded indirect-target recovery, evidence included, C-like output and two-space indentation. Raising a budget is not proof of completeness and does not silently extend already-published partial function ranges. Full analysis artifacts are limited to 16 MiB. Image storage separately bounds individual records at 16 MiB, aggregate encoded metadata at 64 MiB and facts at one million; these are serialized-data bounds, **not process-memory ceilings**.

Local stdio frames/wrappers are capped at 2 MiB, pending requests and pending output messages at eight each, request string IDs at 1,024 UTF-8 bytes. Drain replies; a write stalled for 30 seconds closes the connection. Larger non-analysis delivery is an error, not silent truncation. HTTP has its own bounded connection/request/work lanes and deadlines documented in [REMOTE.md](REMOTE.md), while preserving the tool/resource delivery ceiling. Work/deadline/queue limits and artifact delivery limits are separate. [Performance evidence](PERFORMANCE.md) includes real partial imports, failed limit probes and observed worker RSS; do not extrapolate small-fixture latency or file size into a large-input SLA.

Recognition, lifting, ABI, analysis and reconstruction report **separate coverage**:

- **ARM64:** baseline integer/arithmetic/flags, shifts/bitfields, control flow, ordinary scalar/SIMD loads/stores and pairs, stack/calls, common fixed-lane integer SIMD, scalar FP32/64 and selected vector FP. FPCR guards restrict arithmetic to nearest-even/gradual-underflow/masked-exception behavior; NaNs/status are abstracted. Pointer authentication uses logical-address abstractions with diagnostics, not hardware authentication semantics. SVE/SME, atomics/barriers, privileged state, fused/FP16 and unimplemented SIMD remain unknown boundaries. See the [ARM64 adapter](src/decoders/arm64/README.md).
- **x86-64:** legacy long-mode register slices, integer arithmetic/flags, multiply/divide with explicit divide-error paths, shifts/conditions/control flow, memory/stack/calls, SSE scalar/packed FP and common packed integer moves/add/sub/bitwise. MXCSR is guarded; exact FP environment/status is not emulated. x87/MMX, REP/string, atomic LOCK/memory XCHG, AVX/later encodings, advanced bit/SIMD, crypto, privileged/transactional operations and CET enforcement are outside the implemented subset. See the [iced-x86 adapter](src/decoders/x86_64/README.md).
- **Metadata/ABI:** Darwin ARM64, Windows x64 and System V AMD64 retain LP64/LLP64, calling-convention, stack, aggregate and variadic distinctions. SysV models independent INTEGER/SSE banks, aggregate rollback/mixed returns, hidden result buffers, callee-entry stack offsets including the return address, no Windows shadow space, and a 128-byte red-zone capability—not proof that a negative access is owned or survives calls. SysV `long double` has an 80-bit value and 128-bit object storage; x87 value reconstruction remains unsupported. Unknown layouts do not establish later allocation certainty. Available debug/Objective-C/Swift/C++ metadata improves evidence, not full source-language recovery. PE CodeView identity is not full PDB reconstruction. Packed/encrypted, self-modifying, JIT and managed .NET bodies are not silently interpreted as ordinary native functions.
- **ELF boundary:** requires bounded valid program/section tables, unambiguous PT_LOAD translations, ELF64LE EM_X86_64 ET_EXEC/ET_DYN and OSABI 0 or 3; OSABI 0 does not prove Linux kernel behavior. Sectionless images, extended table counts/indexes and ELF DWARF recovery are unsupported. Native symbols, dynamic records, evidenced import slots and relocations remain usable; `DT_NEEDED` alone does not assign each import to a library. No dependency loading, relocation execution, ASLR bias, PLT callable-entry reconstruction, TLS runtime allocation or GNU IFUNC-selected target is guessed. Packed relocation/decompression gaps remain explicit. A symbol-bearing ELF arithmetic function can truthfully report aggregate `partial` because source metadata is unavailable while decode/lift/ABI are complete and all reconstruction units/mappings are present.

Unsupported instructions are not no-ops or invented guaranteed traps. Unknown effects, decode gaps, unresolved indirect transfers and conservative call clobbers stay visible. A printed instruction or `complete` query is not full-ISA support. The [fixture inventory and provenance](fixtures/README.md) describe the corpus, not a universal support guarantee.

## Troubleshooting

| Symptom | Action / boundary |
| --- | --- |
| No connection / CLI usage error | Use the installed stdio entry and correct Node executable; create authorized root directories first. Check stderr; do not redirect logs into protocol stdout. |
| Access denied / path outside roots | Authorize the narrow input/project directories and use actual absolute paths. Cursors/artifact IDs do not confer filesystem authority. |
| Worker/queue resource limit | Drain replies, inspect/cancel jobs and close unused projects. Increase only the documented CLI/request limits when appropriate. |
| Empty search under partial indexes | Inspect `page.index_state`, result reason and diagnostics. Zero returned items under an incomplete index are not evidence of absence. |
| Stale revision/cursor or unavailable derived ID | Adopt the acknowledged current revision, restart the query and reanalyze before editing derived-only IDs. Do not replay uncertain mutations. |
| Failed import / image null after resume | Inspect saved jobs/diagnostics; ordinary reopen does not retry. Close, then use explicit matching import repair if eligible, or create a fresh project. |
| Output limit / large pseudocode | Follow the artifact link and chunk metadata. Increasing inline budget cannot override the MCP frame ceiling. |
| Partial/unsupported decompilation | Inspect per-layer coverage and original instruction evidence. Recognition/demangling does not establish semantics; do not erase unknown boundaries. |
| Experimental SQLite warning | Expected stderr under the exercised Node runtime; it is not protocol output. Do not suppress unrelated SQLite corruption/resource diagnostics. |
| Missing `dist/vendor/a64js` or WASM after install | Reject the incomplete artifact. Help-only success is inadequate; rebuild/package from the maintained driver and verify the resulting bytes, without source-tree fallbacks. |
| High RSS or slow large input | Consult measured profiles and budgets; workers/serialized limits are not a hard heap sandbox. Reduce workload/isolate the process rather than claiming full-image completion. |

## Updating and backing up projects

Close projects and stop the MCP process before backing up the entire project directory (SQLite and project-owned images/artifacts together) or changing application versions. Retain the previous archive/manifest and a pre-upgrade project backup. Install the new reviewed private artifact in a separate application directory, validate its manifest/installed workflow, then change the MCP entry path and resume a copied project. Do not assume an older application can read storage migrated by a newer one; restore the matching backup to roll back.

Storage schema 4 transactionally migrates schemas 1/2/3 and preserves historical facts/revisions. This is **not automatic re-parsing by a new loader**. Versioned derived-cache invalidation and native-index refresh are separate concerns. When loader interpretations change, make a fresh project from the same immutable input and explicitly review/reapply assertions using stable evidence and lineage; no public reindex command or automatic historical metadata rewrite is promised. Do not copy cache files between projects or reinterpret old component-version output as newly verified analysis.

Dependency updates require reviewed exact pins/lockfile, full license/notices and WASM closure, changed component versions when semantics change, and new regression/compiled/installed/host evidence. Follow [a64js snapshot maintenance](vendor/a64js/README.md), including source/emitted hashes and the recorded transformation; do not silently regenerate against a different Arm release. Unresolved public-redistribution questions in the notices remain unresolved by a successful build or private installation.

## Developer commands — source checkout only

These commands require the source repository and development dependencies. They are **not installed-app runtime requirements** and are not claims that a command has been run for your artifact. Use Node 24.22.0 and the checked-in lockfile:

```sh
npm ci
npm run check
node dist/scripts/release-acceptance.js
npm run smoke:mcp
```

`check` runs typecheck, tests and compilation. The release harness is the maintained official-SDK client driving the actual compiled server; its `--server-entry PATH --fixtures PATH` options select another entry/corpus. Fixture `bin`, sibling `manifest.json`, `elf-manifest.json` and `malformed` inputs must agree. It never executes analyzed binaries. General fixture rebuild/native trusted-execution commands are separate explicit developer actions documented in [fixtures/README.md](fixtures/README.md), not install/service behavior.

Produce and verify a private artifact:

```sh
npm run pack:release -- --out .local/release
npm run verify:installed -- --artifact /absolute/path/open-decomp-0.1.0.tgz --fixtures fixtures/bin
```

Packaging invokes the existing build after cleaning only declared generated `dist`, then uses standard `npm pack --ignore-scripts --json`; retain both archive and `<archive>.release.json`. Use a fresh output location if the driver rejects a collision. Installed acceptance verifies the sibling manifest, installs the actual archive outside the repository with an empty npm cache and offline/ignore-scripts/omit-dev, checks the public import, both real decoders and all three WASM demanglers, then reuses real MCP release scenarios with copied hash-bound fixture inputs. Harness/client SDK assets are developer-only; the installed server must not depend on them or on the source tree. Record actual results separately for each host; a script's existence is not an installed pass.

For measured benchmark reproduction and reviewed external input setup, follow [PERFORMANCE.md](PERFORMANCE.md). The runtime does not fetch benchmark inputs, raw Arm references, symbol servers or target-selected URLs. Preserve manifests, host/runtime details, typed failures and partial states alongside successful measurements.

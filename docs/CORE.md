# Core contracts (schema version 1)

Import from `src/core/index.ts` or the owning module, using `.js` relative specifiers. Core has no MCP or decoder-library dependency. The root package export is owned by integration.

Module names in the interface map below are relative to `src/core/`.

## Interface map

| Module                     | Main exports / consumers                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `primitives.ts`            | Strict Zod schemas for IDs, branded `HexU64`, explicit wire addresses, target combinations, diagnostics, evidence origins, layer-specific coverage/capabilities, revisions, budgets, options and artifacts. `Internal<T>` converts only branded machine integers to `bigint`; ordinary names/notes remain strings.                                                                                                                                     |
| `integers.ts`, `codecs.ts` | Existing `parseHexU64` / `formatHexU64`; Zod 4 `hexU64Codec`, `addressCodec`, `rangeCodec` and internal bigint schemas. JSON Schema is exported from wire schemas, never bigint schemas/codecs.                                                                                                                                                                                                                                                        |
| `addresses.ts`             | `Address`, `AddressRange`, `ImageMapping`, `MappingContext`, `ImmutableBytes`, `AddressMap.translate` / `.spans`, checked arithmetic/index conversion, signed-magnitude and address/range codecs.                                                                                                                                                                                                                                                      |
| `identity.ts`              | Content-derived image identity; slice identity includes image, container offset, size and architecture; entity identity includes immutable birth information. Random durable project/job/annotation/evidence/artifact IDs; type-tagged canonical fingerprints; revision/query-bound cursor encoding and validation.                                                                                                                                    |
| `model.ts`                 | `LoadedImage`, slices, mappings, sections, structured header fields, symbols/imports/exports, relocations, function/unwind/data hints, navigation records, source types/signatures, annotations and split/merge lineage. Corresponding finite wire schemas are exported.                                                                                                                                                                               |
| `decoder.ts`               | `RegisterDescriptor`, `DecodedFlow`, `DecodedInstruction`, `DecodeGap`, `Arm64Payload`, `X86Payload`, and structured wire schemas. ARM canonical fields, aliases, SP/ZR and feature validity are distinct from x86 operands, prefixes, register/memory accesses and flags.                                                                                                                                                                             |
| `contracts.ts`             | `Loader`, `Decoder`, `Lifter<RegisterIR>`, `AbiProfile`, `AbiType`, `AbiCallLayout`, `Emitter<Presentation>`, `ProjectStore`, `StoreTransaction`, `StoredRecordKinds`, `RecordQuery`, `StoreFactory`, `AnalysisService`, `WorkerCommand`, `WorkerEvent`, `WorkerPool`, `ComponentRegistry`. Semantic IR lives in `src/ir/`; presentation lives in `src/presentation/`. Generic parameters are those integration boundaries, not unknown tool payloads. |
| `tools.ts`                 | `toolSchemas` (all 13 tools), each named argument/result schema, `ToolName`, `ToolInput<K>` (before defaults), `ToolArgs<K>` (validated/defaulted), `ToolResult<K>`, jobs, pseudocode source mappings, and `exportToolJsonSchemas()`.                                                                                                                                                                                                                  |
| `validation.ts`            | `validateToolRequest`, `validateToolResponse`, `assertRevision`, `nextRevision`, `RevisionConflict`, evidence/diagnostic codecs, `cacheIdentitySchema` / `cacheIdentityKey`.                                                                                                                                                                                                                                                                           |
| `serialization.ts`         | Explicit recovered-type/annotation, artifact, job and emission codecs. Internal domain records use bigint; wire schemas and `Wire*` aliases use validated hexadecimal strings.                                                                                                                                                                                                                                                                         |
| `operation.ts`             | `createOperationContext` owns one monotonic deadline and cumulative work counter per operation; `OperationError` carries typed cancellation/resource diagnostics across component boundaries.                                                                                                                                                                                                                                                          |

## ABI boundary facts

`AbiProfile` owns source layout and physical call classification. System V AMD64
uses the [AMD64 psABI §3.2.3](https://gitlab.com/x86-psABIs/x86-64-ABI/-/blob/master/x86-64-ABI/low-level-sys-info.tex):
independent INTEGER/SSE banks, recursive eightbyte merging, whole-argument
register rollback, mixed-bank returns, and RDI hidden-result storage with its
pointer returned in RAX. Source associations distinguish that returned pointer
from the aggregate bytes (also for Microsoft x64). Field alignment is checked at
its absolute enclosing offset, including primitive leaves inside packed records;
an unaligned leaf makes the enclosing aggregate MEMORY-class.

`DataLayout.long_double_bits` describes precision representation, while
`long_double_storage_bits` describes object storage: SysV is 80/128, existing
Darwin ARM64 and Microsoft x64 profiles are 64/64. An 80-bit source float therefore
occupies 16 bytes on SysV, including in arrays; it is never relabeled binary128.
x87 reconstruction, AVX argument types, nontrivial C++ and syscall conventions
remain unsupported. Incomplete aggregate layouts do not imply allocation of
later parameters.

Stack locations are callee-entry offsets. `stack_return_address_bytes` is eight
for both x86 ABIs and zero for Darwin ARM64; the lifter already performs x86's
push, so consumers never add it again. SysV has no shadow space; the first stack
argument starts at +8. `stack_bytes` excludes the push and is only a lower bound
for partial layouts. `red_zone_bytes` records ABI capability, not ownership of
negative offsets or survival across calls. Over-aligned stack objects can raise
the outgoing alignment beyond the default 16 bytes.

`AbiSignature.parameters` can be a known prefix, not necessarily all actuals.
Source/library/service variadic declarations supply their fixed parameters and
set `argument_list_complete: false`. Explicit complete variadic or unprototyped
actual lists must set it to `true`; omission defaults to completeness only for
ordinary prototyped nonvariadic calls. `AbiCallLayout.argument_count` is null for
incomplete lists, while known prefix locations survive in a partial layout.
A complete list retains its count even if a type prevents physical allocation.
Anonymous actuals remain call observations, not synthesized fixed formal
parameters in a source signature.

`AbiCallLayout.implicit_register_inputs` records machine requirements separately
from source parameters. SysV variadic/unprototyped calls require AL to be an
unsigned upper bound on vector-register usage, from the established count to
eight, not an exact count. Call analysis retains the actual register fact,
evidence, and satisfied/violated/unknown conformance; partial layouts cannot
establish satisfaction. Both emitters render these facts only as inert metadata.
Existing ABIs have no such implicit inputs.

ELF library contracts require explicit recognized ELF library attribution; a
needed-library list or Darwin path is not symbol attribution. ELF DWARF recovery
is explicitly unavailable (partial diagnostic, no recovered debug declarations),
without suppressing native symbols or treating Mach-O section rules as ELF rules.

## Address and byte ownership rules

`file` always means an offset into the original immutable **container**, including the selected slice offset. `rva` is relative to the explicit image base; `va` is static virtual address. No runtime slide is guessed. Ranges are half-open; the exclusive end may equal 2^64, but neither an address nor a size may exceed unsigned 64-bit representation.

Construct `AddressMap` once from validated loader mappings. Invalid backing ranges, duplicate mapping identities and overlapping virtual or file-backed mappings are rejected rather than resolved by order. A zero-filled VA has no file address: translation to `file` reports `zero_fill` and retains a memory coordinate. Unmapped translations retain their source coordinate. File-to-file reads may access unmapped header/container bytes inside the selected slice; file-to-VA translation requires actual mapping backing. `spans` partitions requested reads into backed bytes, virtual zero-fill, and holes without silently shortening them.

`ImmutableBytes` makes one owned copy on construction. It exposes checked scalar reads and explicit copied range reads, not a mutable buffer/view. Decoded instructions reference image ranges instead of copying instruction bytes.

Instruction byte references are normally container-file ranges. An instruction spanning adjacent virtual mappings with disjoint file backing instead carries a VA range; consumers resolve it with `AddressMap.spans` rather than assuming contiguous file bytes.

Decoder metadata preserves raw x86 prefix bytes and separates architectural RFLAGS from x87 status-word masks (C0/C1/C2/C3 at bits 8/9/10/14). `read_conditional_write` means an unconditional read with a conditional write. A zero memory `access_bits` means unknown or address-only, not a zero-byte memory operation; x86 immediate `encoded_bits: 0` means an implied constant. ARM availability and execution behavior are distinct: feature-disabled hints can behave as NOPs. Scalable and opaque operands retain information without claiming supported lifting semantics.

## Tool arguments and results

All objects reject extra keys. All operations except `project_open` identify a project and snapshot revision; `annotations_apply` instead supplies `expected_revision`. Every request has a validated work/output budget. Search/list views have a page limit and optional cursor. Query filters use exact/prefix/contains text matching, not arbitrary regular expressions or code.

- `project_open`: import via authorized input/project paths and optional selected slice ID, or resume via project path. Imports default to a durable `queued` result; `wait: true` requests the final image summary. Explicit import `mode: "resume"` repairs only an empty project or one unfinished image with matching bytes/slice. Ordinary resume never retries: unfinished projects return `partial` / `incomplete_index` with `data.image: null`, permitting saved-job inspection and close before repair.
- `project_close`: revision plus running-job policy (`reject`, `wait`, `cancel`); returns persisted revision and closed status. The precondition checks the acknowledged snapshot. Waiting/cancelling may reveal a newer already-committed revision; successful close reports that reconciled revision, not stale cached metadata.
- `binary_info`: image and selected `summary`, `headers`, `sections`, `mappings`, `entry_points`, `relocations`, `hints`, or `capabilities` view. Each non-summary view is independently paged. Omit `image_id` only when the requested snapshot contains exactly one image; absent/ambiguous images fail explicitly.
- `symbols_find`: image, symbol/import/export kinds, name query, optional exact address.
- `strings_find`: image, query, encodings, candidate/referenced filter, optional location range.
- `functions_find`: image, optional stable ID, query, address, boundary certainty and analysis status.
- `function_get`: stable function ID and metadata/disassembly/CFG view; metadata includes signature, ranges, annotations and lineage. Disassembly carries explicit gaps.
- `function_decompile`: function ID, conservative analysis and presentation options, including `options.emitter: "c-like" | "python-like"` (default `"c-like"`). Defaults to a durable `queued` result; `wait: true` awaits inline or artifact delivery and is not part of cache identity. Inline data contains pseudocode, signature, statement spans, original instruction/range mappings, capabilities and cache status. Oversized delivery is explicitly `partial` / `output_limit` with `data.delivery: "artifact"` and a matching published artifact handle; no empty or truncated emission is labeled complete.
- `xrefs_get`: stable entity or explicit address, direction, reference kinds, unresolved-edge inclusion.
- `memory_read`: address, byte length, endian, and bytes/integer/float/pointer interpretation. Typed values retain hexadecimal machine bits (including floating-point bit patterns). Segments distinguish real bytes, zero-fill and unmapped holes; partial reads require a continuation address.
- `annotations_apply`: atomic set/retract/remove edits with stable annotation IDs, author, user/LLM origin and assertion status. Returns one revision increment and conservative project-wide derived-result invalidation. An annotation ID occurs at most once in a batch.
- `analysis_status`: project revision and job ID; returns the durable job and `known_revision`, the last acknowledged project revision. A completed import may have its final snapshot acknowledgement briefly in flight. Imports and annotations do not use the artifact-only `published_revision` field.
- `analysis_cancel`: same handle and acknowledged revision; explicitly distinguishes completed cancellation, requested cancellation and work already finished.

Each result includes schema version, project/revision, backend/component versions, options, budget, per-layer coverage, diagnostics, evidence and artifacts. A component version is `null` when that component has not been loaded/run; do not invent a version. `complete` means the requested bounded operation finished, not that all architecture semantics are supported. Per-layer coverage remains authoritative. `empty` is reserved for a fully indexed, exhausted query with zero items. `partial`, `unsupported`, `failed`, `cancelled`, `queued` and `running` are separate states. Stale-revision failures retain the requested snapshot in the envelope and report the current revision separately.

`exportToolJsonSchemas()` produces draft-2020-12 schemas with object roots used by MCP registration. JSON Schema covers structural constraints; Zod refinements additionally enforce cross-field invariants (ranges, job publication, empty/partial distinctions, spans, revision increments). Call `validateToolRequest` before work and `validateToolResponse` before transport delivery; the latter checks snapshot/job bindings and actual UTF-8 output size.

`QueryService.execute()` transfers ownership of asynchronous work to the project after durable admission. Its request signal/progress callbacks apply only until the response returns; ending an MCP exchange cannot cancel an already-returned job. Use ordinary `analysis_status` / `analysis_cancel` afterward. `QueryService.submit()` exposes the lower-level ticket with full-lifecycle signal/progress handling. Fixed-width admission envelopes fit the minimum 1,024-byte output budget; analysis publication and artifact delivery have separate output checks.

## Defaults and bounds

| Setting               |   Default |     Maximum |
| --------------------- | --------: | ----------: |
| Page items            |       100 |       1,000 |
| Read bytes            |     4,096 |   1,048,576 |
| Instructions          |    10,000 |   1,000,000 |
| Blocks                |    10,000 |     100,000 |
| IR nodes              |   100,000 |  10,000,000 |
| Work units            | 1,000,000 | 100,000,000 |
| Deadline milliseconds |    30,000 |     300,000 |
| Output bytes          | 1,048,576 |  16,777,216 |

Analysis defaults: conservative unknown calls, bounded indirect-target recovery, C-like emitter, evidence included, two-space indentation. String search defaults to all supported encodings and both candidates/referenced records. Search defaults to case-insensitive contains with empty query. Closing defaults to rejecting active jobs. Page ordering is explicit (`address_id`, `name_id`, or `id`) with stable identity as the final tie breaker.

A cursor binds project, revision, operation and normalized query fingerprint to a composite last-seen sort key. Exclude the cursor itself from the query fingerprint. Validate bindings before accessing indexes. Cursors are not authorization tokens: forged keyset positions must never grant access. The host still authorizes project roots and artifacts. Artifact reads use project/revision/artifact IDs, bounded offsets/lengths, and never arbitrary file paths.

Successful annotation transactions advance once; stale or invalid batches roll back entirely. Splits/merges mint new entity identities and preserve lineage instead of transferring user assertions silently. Cache identity includes input hash/slice, the full selected `Target` (format, architecture, ABI, endian, address width and features), all component versions, evidence and annotation revisions, function identity, options and original request budgets. The selected emitter and its own version participate in identity; neither host/ISA-only dispatch nor the C emitter's version can stand in for another target/dialect. Publishing an artifact must recheck both job cancellation and current revision atomically.

The SQLite implementation is `src/project/store/index.ts`. Record indexes have explicit completion state; writing records marks an index partial until the producer declares it complete. Historical queries and annotation tombstones are revision-bound; `readLoadedImage(imageId, sliceId, revision?)` cannot expose metadata published after the requested snapshot. Store transactions are synchronous and escaped transaction handles are revoked. `readType`, `readSignature`, and `readLineage` retrieve persisted evidence-bearing metadata; `setIndexState` never infers completeness from an empty filtered page. Image and artifact hashes are checked on read, and foreign project/revision artifact handles are rejected.

`queryAnnotations` pages the latest nonremoved annotations at a fixed revision, optionally by annotation/subject IDs; retracted assertions remain visible but must not affect inference. `queryAnnotationHistory` pages set/retract/remove events and their actors without reattaching an annotation to another entity. Empty ID filters differ from omitted filters in both execution and cursor identity. Removal requires an explicit author/origin. Persistence schema 4 migrates schemas 1/2/3 transactionally without changing wire schema 1 or the project revision. It preserves removal actors and historical image snapshots, adds the analysis-catalog index where absent, and normalizes ordered image facts rather than encoding an entire image's metadata as one record. Old removal authors remain explicitly unknown; old artifacts do not receive invented catalog entries. Newer persistence versions are rejected before mutation.

Image metadata retains the 16 MiB individual encoded-record limit, with a separate 64 MiB aggregate encoded-byte limit and one-million-fact limit per loaded snapshot. Counts/order are checked on read; oversized SQLite fact blobs are rejected before transfer to JavaScript. Replacements, facts, index publication and completed jobs commit atomically; failed writes or migrations roll back. Storage resource failures retain their typed diagnostic at the worker boundary rather than becoming a generic internal error. These are serialized-data bounds, not a claim of a 64 MiB process-memory ceiling.

Cache-hit jobs may reference an artifact published by another job in the same project/input snapshot; the stored artifact metadata must match exactly. This reuses the immutable artifact rather than republishing its bytes. Unpublished/forged handles, foreign snapshots, and transitions out of cancelled or other terminal states remain rejected.

`src/project/cache/` stores versioned `application/vnd.open-decomp.function+json` artifacts with the full decompilation envelope and an internal semantic catalog. Type sizes/offsets and evidence addresses use explicit hexadecimal codecs. Full artifacts are limited to 16 MiB; catalog reconstruction reads at most 128 artifacts / 32 MiB and requires the exact current revision and current component versions. Payload identity, target, metadata, type dependencies and evidence closure are validated before use. `findAnalysisArtifacts` pages snapshot-bound indexed identities; worker-only `readArtifactBytes` validates the exact published handle and hash. Response sizing precedes atomic artifact/index/completed-job publication; no cancellable checkpoint follows durable success.

Cached decompilation payloads additionally validate `emission.language === identity.options.emitter` and `emission.emitter_version === identity.versions.emitter`. A current project revision alone does not authorize a stale component composition or a different selected emitter. The full-target pipeline/version lookup rejects unregistered format/ISA/ABI combinations; it does not infer them from the host.

ABI profiles own register preservation, unknown-call clobbers, stack arguments/alignment, Windows shadow space, variadic/aggregate classification and LP64/LLP64 differences. Decoder flow deliberately separates unknown transfer from proven trap. Discovery can consume flow/register metadata without a lifter; formatting is never semantics.

`AbiSignature.parameters: null` means unknown count, not zero arguments. Omitted convention/prototype flags mean the ordinary prototyped C ABI; unsupported conventions and nontrivial aggregates are explicit. ABI classifiers apply supported C default promotions to anonymous source arguments. Stack locations are callee-entry-SP-relative; `stack_bytes` excludes a pushed return address and caller-chosen indirect-object storage. A partial layout's stack allocation is only a known-prefix lower bound. Recovered source structures may retain known sizes/fields with `alignment: null`; resolved ABI aggregate layouts still require established alignment.

Discovery returns shared `FunctionGraph` records consumed directly by lifters; no lifter rebuilds a separate discovery graph from assembly text. Its `complete` state describes seeded traversal, never proof that every function exists in the index. Direct calls are references rather than intraprocedural successors. Unwind coverage is a region, not a single-function ownership claim: Mach-O compact unwind can coalesce adjacent functions. Debug recovery accepts supplied bytes only, requires a host-owned artifact identity for external evidence, and validates UUID/CPU/subtype/content pins without opening referenced source paths.

## Recovered types and navigation implementations

`src/analysis/types/` consumes SSA plus explicit ABI, debug, library and annotation evidence without rewriting machine IR. Associations retain source status and exact machine/source bit ranges. Observed memory shapes preserve signed, machine-width-wrapped offsets, access widths, alias/escape uncertainty and dynamic strides; their observed extent is not an inferred object size. Declared type and field IDs are valid subjects; a function-anchored type annotation declares a type in scope rather than assigning the function a scalar machine type. Conflicting declarations remain alternatives. A supplied call declaration matches both the exact call node and contract ID, preserving source provenance without leaking a call-local assertion to another call. Retractions recompute from the requested snapshot instead of retaining prior conclusions.

`src/project/annotations/` validates names, notes, type declarations and signatures against durable subjects or a trusted, project/revision-bound semantic catalog. A batch commits annotations, assertion evidence and an optional synchronous job-completion hook atomically; cancellation or a hook failure rolls everything back. The hook receives prepared proof bodies so the complete response can be validated before commit without reading an uncommitted future snapshot. Active entity-filtered views retain local alternatives and reachable type dependencies, not unrelated declarations from other functions. User/LLM assertions never become immutable type/signature facts. Retraction, removal and stale revisions remain distinct.

`src/emitters/model.ts` owns neutral `EmissionInput` / `EmissionResult`, also exported at the package root. Inputs contain a structured function with optional recovered types, resolved display names, active notes and native `SourceEvidence`. Source evidence carries the selected target ABI, bounded native-callee observations, exact symbolic/literal addresses and proven contextual argument counts. Results contain emission, diagnostics, mapping coverage and stable-identity identifier records. The root exposes `CEmitter` / `emitC` / `C_EMITTER_VERSION` and `PythonLikeEmitter` / `emitPythonLike` / `PYTHON_LIKE_EMITTER_VERSION`.

`src/reconstruction/` and the shared renderer produce both dialects from one source projection. The native pipeline supplies source evidence: physical register slices become ABI arguments/results, private stack spills become forwarded values or scalar locals, and unchanged phi/clobber plumbing disappears before rendering. Inferred interfaces are labeled and never promoted into established source signatures. Escapes, overlaps and uninitialized paths retain shared storage; unknown calls and live non-result clobbers remain explicit. Pure synthetic definitions are bounded and materialized at their original SSA definition sites. C-like casts and Python-like width helpers preserve integer storage; floating/vector helpers retain exact payload semantics. Source-level behavior observes ABI-visible values and ordered external effects, not scratch-register snapshots at every fault. Internal callers without native source evidence retain machine-boundary rendering. Names/notes are escaped, and final-dialect UTF-16 mappings resolve synthesized values to original catalogued subjects.

Structured loop exits retain exact CFG destinations. Only an exit targeting the loop's lexical successor renders as `break`; other exits retain explicit labels/gotos. The source-backed SQLite 3.54.0 `strnicmp` regression evaluates both emitted dialects over 30 boundary cases without executing analyzed code.

Focused emitted-output regressions exercise nested loop/switch exits, edge-specific cyclic copies, guarded effects and faults, split-register joins and synthetic source-definition scope in both dialects and both source/machine modes. The four independent source-derived fixtures cover 544 observations; this is bounded regression evidence, not a whole-program equivalence proof.

Pure expression reconstruction recomposes contiguous register-cell slices before source-width distribution, preserving full-width carries. Source normalization recovers constant shifted-add multiplication and scaled addresses without duplicating effects or expanding shared expression DAGs. Dynamic shift masks and unknown dependencies remain explicit. Independent emitted-output checks cover 240 observations across 16 fixtures.

Source-data recovery distinguishes exact storage identities from literal presentation. Globals, pools and tables retain their own base, byte offset, proven extent, mutability and evidence. Immutable bounded ASCII/UTF-8 strings may acquire character-pointer presentation; writable, conflicting, unterminated, relocated-slot and unsupported-encoding storage remains symbolic. Section ownership does not establish one source array, and memory addresses are never rebased onto a neighboring literal. Public Mach-O executable/dylib and PE outputs return the exact fixture literal in both dialects; table regressions retain ordered reads, writes and one-past faults.

Incoming stack arguments use callee-entry-SP coordinates. Exact, unchanged ABI scalar slots become provenance-backed source inputs, not freshly allocated private frame bytes. The symbol-bearing and stripped Mach-O ten-input fixture is evaluated in both dialects against 25 independent uint64 cases, including `1..10 → 385`, high-bit values and modulo-overflow boundaries. Broader aliased and unresolved incoming storage remains a separate recovery requirement.

`src/service/queries/index.ts` exposes the lightweight host `QueryService`; import this module directly in protocol hosts rather than the root engine barrel. Its persistent child atomically publishes loader metadata and derived navigation indexes. Reads retain the requested revision and bound pages, evidence, memory output and artifact chunks; image-only queries reject ambiguous imported slices. Graph reconstruction retains discovery gaps and never extends published function ranges. Native names remain searchable after demangling or a unique asserted rename. Annotation completions immediately advance the host's known revision; status/cancel never queue a snapshot read behind a stopped owner. A lost post-commit mutation response is not retried: inspect the durable job, saved revision and annotation IDs.

Import preparation persists its loader, runtime and name diagnostics with the loaded image. Partial supported-metadata recovery marks native symbol/import/export indexes incomplete; `project_open` and summary queries then return `partial` / `incomplete_index` with the ready image still available. Explicitly unsupported optional features remain capability records rather than falsely making an otherwise finished native-name index incomplete. Reopening preserves this report; native names remain immutable facts and decorated/runtime names remain separate derived records.
For a universal Mach-O image, unsupported **nonselected** architectures remain visible as slice facts and diagnostics; they do not make the selected ARM64 slice's native indexes incomplete. Selected-slice metadata loss still produces the partial state above.
Mach-O header/load-command bytes have explicit binary-evidenced data ownership even inside executable mappings. Symbol section association alone does not establish code: the address must fall within the referenced instruction/stub section. Native names and exports remain visible; weak header guesses do not become functions, while contradictory explicit code claims remain reported conflicts. Universal-slice data ranges retain container-file offsets.

PE AMD64 unwind handlers are image-relative metadata references, not proof of executable file-backed code. Mapped non-executable or zero-fill targets retain their address, permissions and record provenance with an unavailable-code capability; they do not become function seeds. Unmapped references and truncated records remain errors. `UWOP_SET_FPREG` obtains its register/offset from the header and ignores reserved OpInfo bits, as specified by [Microsoft's x64 unwind format](https://learn.microsoft.com/en-us/cpp/build/exception-handling-x64?view=msvc-170); defined operands, frame-register requirements, ordering and chain bounds remain checked. Language-specific handler payloads and unsupported unwind versions are not interpreted.

Trusted statically registered worker handlers return the named `PreparedImport` contract from `prepareImport`: the final image report plus `publish(transaction)`. Expensive preparation happens before the SQLite transaction; image metadata, indexes and terminal import state publish atomically. This extension point accepts no target-selected code or module paths.

`src/service/analysis/` composes shared function discovery, the architecture lifter/ABI, SSA/value/effect passes, debug/library evidence, stack/call/type recovery, native source facts and structuring, then selects either dialect over the same reconstruction. Native callee observations are single-level, deduplicated by exact address and bounded by the operation's remaining instruction/IR/block budgets. Decode, lifting, ABI, combined discovery/type analysis and reconstruction report separate coverage; a readable source projection does not erase unresolved contract diagnostics. Every stage shares cumulative work/deadline/cancellation. Cache identity retains the original request budget. `include_evidence: false` suppresses wire proof bodies and emission proof references without discarding the trusted annotation catalog.

IR construction reserves block/parameter/terminator capacity and checks instructions before allocating them. Lifters reject oversized input graphs before preprocessing; SSA checks block×register expansion before materializing parameters. The node count is `3 + parameters + instructions` per block. Provenance unions and verification charge cumulative work without argument-spread fan-in. A discovery graph stopped by a resource budget cannot publish a successful semantic artifact; unsupported-instruction partial semantics remain a separate valid outcome.

Derived-only annotations require analysis published at the current revision and component versions. After an edit, reanalyze before annotating another derived-only ID; durable functions/imports remain directly addressable. Source metadata, assertions and library contracts retain their provenance. Inferred presentation interfaces from ABI/dataflow observations remain distinct from proven source declarations and do not authorize signature annotations as immutable facts. `versions.ts` records composition versions that change with reconstruction semantics.

Worker recovery tests use a private, job-ID-scoped filesystem gate to block the actual child event loop on both operating systems. Kill, cancellation, deadline, queue, commit-before-response and reopen checks no longer depend on Unix stop signals; production workers have no client-selectable gate.
Outer test watchdogs are distinct from service deadlines: the three multi-owner lifecycle scenarios allow 120 seconds and the oversized-frame process test allows 30 seconds after measured Windows CPU-emulation timeouts. The operation budgets and the real 200 ms blocked-worker deadline assertion are unchanged.

## Local MCP launch and artifact access

Use Node 24.22.0 as the runtime and Bun 1.4.3 as the package manager. After `bun install --frozen-lockfile` and `bun run build`:

```sh
bun run mcp --root /absolute/input-directory --root /absolute/project-directory
bun run smoke:mcp
```

The compiled entry is `dist/src/cli/entry.js`; the only package binary is `open-decomp`. Use `open-decomp mcp start` for foreground stdio, optionally with `--transport stdio`; bare invocation prints root help instead of starting a server. At least one existing authorized root is required. `--root` is repeatable; `--max-workers` accepts 1–32 and `--max-queued` accepts 0–1,024. No cwd/home root is implicit. Help, version and diagnostics go to stderr; stdout is SDK protocol traffic only. EOF and catchable termination signals cancel/reap project owners. Closing the owned stdin descriptor also releases a writer blocked on oversized input.

All 13 tools expose concrete schemas, structured content and readable JSON text. Large inline decompilations use `projectDecompilationArtifactResult`, the same projection as cache delivery: original options/budgets and semantic completeness remain in the published full artifact. The delivery envelope explicitly reports `output_limit`. Tool/resource wrappers are bounded to 2 MiB; arbitrary non-analysis responses that cannot fit return a delivery error, never silent truncation. MCP annotation responses are checked inside the transaction against a conservative text-plus-structured delivery ceiling, including JSON escaping, so an oversized response rolls back the entire batch. The private `max_result_bytes` delivery policy never changes the requested budget or cache identity. A disconnected client can still lose a committed acknowledgement: inspect the durable revision/job rather than replaying a mutation.

Published handles have resource links and the template `open-decomp://artifact/{project_id}/{revision}/{artifact_id}?offset={offset}&length={length}`. Offset is hexadecimal; length is at most 524,288 bytes. Resource `_meta[\"open-decomp/artifact\"]` retains the exact handle, offset, consumed length, next offset/URI and encoding. JSON/text pages preserve UTF-8 scalar boundaries and never exceed the requested byte allowance; use length ≥4 to fit every scalar. Other media uses explicit base64. Resource access resolves IDs through the owning worker, never filesystem paths. Raw URI syntax, project, revision and stored hash are checked.

The SDK owns framing and protocol negotiation. Local stdio limits input/output frames to 2 MiB, string request IDs to 1,024 UTF-8 bytes, and both pending requests and pending output messages to eight. Drain responses before submitting more work. Writes are serialized; a write stalled for 30 seconds closes the connection. Invalid JSON-RPC, oversized input/IDs and queue exhaustion produce bounded stderr diagnostics and shutdown; the pinned SDK discards non-JSON lines. The CLI releases all project workers before exiting, including when one owner close fails. Forced process exit occurs only after shutdown cleanup because a blocked Node stdio write can otherwise keep the process alive.

The output wrapper awaits the actual write callback, including small frames. Windows uses asynchronous file-descriptor writes because `process.stdout.write` on a pipe can block the event loop and prevent the stall timer from firing. POSIX retains its readiness-driven stream writer rather than applying file writes to a nonblocking descriptor; partial Windows writes preserve every remaining byte. The same serialized queue and deadline govern both paths.

Native Windows writer code is retained, but native `win32` Node execution is not a product requirement or a fully qualified host. **macOS arm64 / Node 24.22.0 is the verified execution host.** Linux/WSL using Linux Node is intended but unverified. PE x64, Mach-O ARM64 and ELF/SysV x64 are statically analyzed targets, not required execution hosts; cross-compilation requires no Windows/Linux VM or target execution.

Target strings, names and notes remain untrusted data. Workers do not execute targets, load target libraries or fetch embedded URLs, but inherit the host user's OS permissions. Authorized-root checks, bounded queues/work and process termination are fault containment, not an OS filesystem/network sandbox or a hard RSS/heap limit. A hostile local process able to modify authorized directories is outside this boundary; use separate OS isolation when that threat is relevant.

`scripts/mcp-smoke.ts` drives the compiled server with the official SDK client and no optional progress/task extensions. `--server-entry` and `--fixtures` select installed-entry verification inputs. The workflow covers both architectures with symbol-bearing and stripped fixtures, navigation, mappings/evidence, asynchronous jobs, artifact paging/hash checks, annotations/retractions, stale revisions, cache invalidation and close/resume.

## Authenticated HTTP entry

The same unified entry serves these tools/resources with official SDK 2.3.1 `createMcpHandler` via `open-decomp mcp start --transport http --config ABSOLUTE_JSON_PATH`, or `bun run mcp:http --config ABSOLUTE_JSON_PATH` from a built checkout. Transport-specific help is `open-decomp mcp start --transport http --help`. The root embedding surface is `startHttpServer` / `HttpServerHandle` and `loadHttpConfig` / `HttpConfig`; the handle exposes the actual bound `url` and idempotent `close(): Promise<void>`. No new public analysis protocol or transport executable alias is introduced.

See [REMOTE.md](REMOTE.md) for exact provisioning, limits and ownership. Every request uses private operator-provisioned high-entropy bearer authentication against stored hashes, not OAuth/SSO. Each principal has a separate service/worker pool, disjoint canonical private project root and authorized input roots; artifact/job/project IDs and annotation authors are not login credentials. Non-loopback listeners require native TLS; exact Host/Origin checks do not imply CORS support or an OS sandbox.

HTTP ownership transfers at validated, authorized service dispatch, before any guaranteed durable commit. Transport loss, HTTP deadline and SDK cancellation do not automatically cancel dispatched work; use durable `analysis_status` / `analysis_cancel` and inspect state after a lost acknowledgement instead of replaying mutations. Network slots and dispatched work slots are separately bounded; status/cancel/close retain a control lane. Shutdown stops admission, aborts exchanges, closes sockets, settles dispatched bounded service calls, then cancels remaining queued jobs and closes all principal workers. Embedding-only worker runtime options remain trusted host code and are not accepted from JSON/network metadata.

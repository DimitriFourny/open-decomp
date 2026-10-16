# Core contracts (schema version 1)

Import from `src/core/index.ts` or the owning module, using `.js` relative specifiers. Core has no MCP or decoder-library dependency. The root package export is owned by integration.

## Interface map

| Module | Main exports / consumers |
| --- | --- |
| `primitives.ts` | Strict Zod schemas for IDs, branded `HexU64`, explicit wire addresses, target combinations, diagnostics, evidence origins, layer-specific coverage/capabilities, revisions, budgets, options and artifacts. `Internal<T>` converts only branded machine integers to `bigint`; ordinary names/notes remain strings. |
| `integers.ts`, `codecs.ts` | Existing `parseHexU64` / `formatHexU64`; Zod 4 `hexU64Codec`, `addressCodec`, `rangeCodec` and internal bigint schemas. JSON Schema is exported from wire schemas, never bigint schemas/codecs. |
| `addresses.ts` | `Address`, `AddressRange`, `ImageMapping`, `MappingContext`, `ImmutableBytes`, `AddressMap.translate` / `.spans`, checked arithmetic/index conversion, signed-magnitude and address/range codecs. |
| `identity.ts` | Content-derived image identity; slice identity includes image, container offset, size and architecture; entity identity includes immutable birth information. Random durable project/job/annotation/evidence/artifact IDs; type-tagged canonical fingerprints; revision/query-bound cursor encoding and validation. |
| `model.ts` | `LoadedImage`, slices, mappings, sections, structured header fields, symbols/imports/exports, relocations, function/unwind/data hints, navigation records, source types/signatures, annotations and split/merge lineage. Corresponding finite wire schemas are exported. |
| `decoder.ts` | `RegisterDescriptor`, `DecodedFlow`, `DecodedInstruction`, `DecodeGap`, `Arm64Payload`, `X86Payload`, and structured wire schemas. ARM canonical fields, aliases, SP/ZR and feature validity are distinct from x86 operands, prefixes, register/memory accesses and flags. |
| `contracts.ts` | `Loader`, `Decoder`, `Lifter<RegisterIR>`, `AbiProfile`, `AbiType`, `AbiCallLayout`, `Emitter<Presentation>`, `ProjectStore`, `StoreTransaction`, `StoredRecordKinds`, `RecordQuery`, `StoreFactory`, `AnalysisService`, `WorkerCommand`, `WorkerEvent`, `WorkerPool`, `ComponentRegistry`. T04 owns semantic IR; T21 owns presentation. Generic parameters are those integration boundaries, not unknown tool payloads. |
| `tools.ts` | `toolSchemas` (all 13 tools), each named argument/result schema, `ToolName`, `ToolInput<K>` (before defaults), `ToolArgs<K>` (validated/defaulted), `ToolResult<K>`, jobs, pseudocode source mappings, and `exportToolJsonSchemas()`. |
| `validation.ts` | `validateToolRequest`, `validateToolResponse`, `assertRevision`, `nextRevision`, `RevisionConflict`, evidence/diagnostic codecs, `cacheIdentitySchema` / `cacheIdentityKey`. |
| `serialization.ts` | Explicit recovered-type/annotation, artifact, job and emission codecs. Internal domain records use bigint; wire schemas and `Wire*` aliases use validated hexadecimal strings. |
| `operation.ts` | `createOperationContext` owns one monotonic deadline and cumulative work counter per operation; `OperationError` carries typed cancellation/resource diagnostics across component boundaries. |

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
- `function_decompile`: function ID, conservative analysis and C-like presentation options. Defaults to a durable `queued` result; `wait: true` awaits inline or artifact delivery and is not part of cache identity. Inline data contains pseudocode, signature, statement spans, original instruction/range mappings, capabilities and cache status. Oversized delivery is explicitly `partial` / `output_limit` with `data.delivery: "artifact"` and a matching published artifact handle; no empty or truncated emission is labeled complete.
- `xrefs_get`: stable entity or explicit address, direction, reference kinds, unresolved-edge inclusion.
- `memory_read`: address, byte length, endian, and bytes/integer/float/pointer interpretation. Typed values retain hexadecimal machine bits (including floating-point bit patterns). Segments distinguish real bytes, zero-fill and unmapped holes; partial reads require a continuation address.
- `annotations_apply`: atomic set/retract/remove edits with stable annotation IDs, author, user/LLM origin and assertion status. Returns one revision increment and conservative project-wide derived-result invalidation. An annotation ID occurs at most once in a batch.
- `analysis_status`: project revision and job ID; returns the durable job and `known_revision`, the last acknowledged project revision. A completed import may have its final snapshot acknowledgement briefly in flight. Imports and annotations do not use the artifact-only `published_revision` field.
- `analysis_cancel`: same handle and acknowledged revision; explicitly distinguishes completed cancellation, requested cancellation and work already finished.

Each result includes schema version, project/revision, backend/component versions, options, budget, per-layer coverage, diagnostics, evidence and artifacts. A component version is `null` when that component has not been loaded/run; do not invent a version. `complete` means the requested bounded operation finished, not that all architecture semantics are supported. Per-layer coverage remains authoritative. `empty` is reserved for a fully indexed, exhausted query with zero items. `partial`, `unsupported`, `failed`, `cancelled`, `queued` and `running` are separate states. Stale-revision failures retain the requested snapshot in the envelope and report the current revision separately.

`exportToolJsonSchemas()` produces draft-2020-12 schemas with object roots used by MCP registration. JSON Schema covers structural constraints; Zod refinements additionally enforce cross-field invariants (ranges, job publication, empty/partial distinctions, spans, revision increments). Call `validateToolRequest` before work and `validateToolResponse` before transport delivery; the latter checks snapshot/job bindings and actual UTF-8 output size.

`QueryService.execute()` transfers ownership of asynchronous work to the project after durable admission. Its request signal/progress callbacks apply only until the response returns; ending an MCP exchange cannot cancel an already-returned job. Use ordinary `analysis_status` / `analysis_cancel` afterward. `QueryService.submit()` exposes the lower-level ticket with full-lifecycle signal/progress handling. Fixed-width admission envelopes fit the minimum 1,024-byte output budget; analysis publication and artifact delivery have separate output checks.

## Defaults and bounds

| Setting | Default | Maximum |
| --- | ---: | ---: |
| Page items | 100 | 1,000 |
| Read bytes | 4,096 | 1,048,576 |
| Instructions | 10,000 | 1,000,000 |
| Blocks | 10,000 | 100,000 |
| IR nodes | 100,000 | 10,000,000 |
| Work units | 1,000,000 | 100,000,000 |
| Deadline milliseconds | 30,000 | 300,000 |
| Output bytes | 1,048,576 | 16,777,216 |

Analysis defaults: conservative unknown calls, bounded indirect-target recovery, C-like emitter, evidence included, two-space indentation. String search defaults to all supported encodings and both candidates/referenced records. Search defaults to case-insensitive contains with empty query. Closing defaults to rejecting active jobs. Page ordering is explicit (`address_id`, `name_id`, or `id`) with stable identity as the final tie breaker.

A cursor binds project, revision, operation and normalized query fingerprint to a composite last-seen sort key. Exclude the cursor itself from the query fingerprint. Validate bindings before accessing indexes. Cursors are not authorization tokens: forged keyset positions must never grant access. The host still authorizes project roots and artifacts. Artifact reads use project/revision/artifact IDs, bounded offsets/lengths, and never arbitrary file paths.

Successful annotation transactions advance once; stale or invalid batches roll back entirely. Splits/merges mint new entity identities and preserve lineage instead of transferring user assertions silently. Cache identity includes input hash/slice, target/features, all component versions, evidence and annotation revisions, function identity, options and budgets. Publishing an artifact must recheck both job cancellation and current revision atomically.

The SQLite implementation is `src/project/store/index.ts`. Record indexes have explicit completion state; writing records marks an index partial until the producer declares it complete. Historical queries and annotation tombstones are revision-bound; `readLoadedImage(imageId, sliceId, revision?)` cannot expose metadata published after the requested snapshot. Store transactions are synchronous and escaped transaction handles are revoked. `readType`, `readSignature`, and `readLineage` retrieve persisted evidence-bearing metadata; `setIndexState` never infers completeness from an empty filtered page. Image and artifact hashes are checked on read, and foreign project/revision artifact handles are rejected.

`queryAnnotations` pages the latest nonremoved annotations at a fixed revision, optionally by annotation/subject IDs; retracted assertions remain visible but must not affect inference. `queryAnnotationHistory` pages set/retract/remove events and their actors without reattaching an annotation to another entity. Empty ID filters differ from omitted filters in both execution and cursor identity. Removal requires an explicit author/origin. Persistence schema 3 migrates schema 1/2 transactionally, preserving removal actors and adding the analysis-catalog index without changing wire schema 1 or the project revision. Old removal authors remain explicitly unknown; old artifacts do not receive invented catalog entries. Newer persistence versions are rejected before mutation.

Cache-hit jobs may reference an artifact published by another job in the same project/input snapshot; the stored artifact metadata must match exactly. This reuses the immutable artifact rather than republishing its bytes. Unpublished/forged handles, foreign snapshots, and transitions out of cancelled or other terminal states remain rejected.

`src/project/cache/` stores versioned `application/vnd.open-decomp.function+json` artifacts with the full decompilation envelope and an internal semantic catalog. Type sizes/offsets and evidence addresses use explicit hexadecimal codecs. Full artifacts are limited to 16 MiB; catalog reconstruction reads at most 128 artifacts / 32 MiB and requires the exact current revision and current component versions. Payload identity, target, metadata, type dependencies and evidence closure are validated before use. `findAnalysisArtifacts` pages snapshot-bound indexed identities; worker-only `readArtifactBytes` validates the exact published handle and hash. Response sizing precedes atomic artifact/index/completed-job publication; no cancellable checkpoint follows durable success.

ABI profiles own register preservation, unknown-call clobbers, stack arguments/alignment, Windows shadow space, variadic/aggregate classification and LP64/LLP64 differences. Decoder flow deliberately separates unknown transfer from proven trap. Discovery can consume flow/register metadata without a lifter; formatting is never semantics.

`AbiSignature.parameters: null` means unknown count, not zero arguments. Omitted convention/prototype flags mean the ordinary prototyped C ABI; unsupported conventions and nontrivial aggregates are explicit. ABI classifiers apply supported C default promotions to anonymous source arguments. Stack locations are callee-entry-SP-relative; `stack_bytes` excludes a pushed return address and caller-chosen indirect-object storage. A partial layout's stack allocation is only a known-prefix lower bound. Recovered source structures may retain known sizes/fields with `alignment: null`; resolved ABI aggregate layouts still require established alignment.

Discovery returns shared `FunctionGraph` records consumed directly by lifters; no lifter rebuilds a separate discovery graph from assembly text. Its `complete` state describes seeded traversal, never proof that every function exists in the index. Direct calls are references rather than intraprocedural successors. Unwind coverage is a region, not a single-function ownership claim: Mach-O compact unwind can coalesce adjacent functions. Debug recovery accepts supplied bytes only, requires a host-owned artifact identity for external evidence, and validates UUID/CPU/subtype/content pins without opening referenced source paths.

## Recovered types and navigation implementations

`src/analysis/types/` consumes SSA plus explicit ABI, debug, library and annotation evidence without rewriting machine IR. Associations retain source status and exact machine/source bit ranges. Observed memory shapes preserve signed, machine-width-wrapped offsets, access widths, alias/escape uncertainty and dynamic strides; their observed extent is not an inferred object size. Declared type and field IDs are valid subjects; a function-anchored type annotation declares a type in scope rather than assigning the function a scalar machine type. Conflicting declarations remain alternatives. A supplied call declaration matches both the exact call node and contract ID, preserving source provenance without leaking a call-local assertion to another call. Retractions recompute from the requested snapshot instead of retaining prior conclusions.

`src/project/annotations/` validates names, notes, type declarations and signatures against durable subjects or a trusted, project/revision-bound semantic catalog. A batch commits annotations, assertion evidence and an optional synchronous job-completion hook atomically; cancellation or a hook failure rolls everything back. The hook receives prepared proof bodies so the complete response can be validated before commit without reading an uncommitted future snapshot. Active entity-filtered views retain local alternatives and reachable type dependencies, not unrelated declarations from other functions. User/LLM assertions never become immutable type/signature facts. Retraction, removal and stale revisions remain distinct.

`src/emitters/c/` emits explicit machine-state C-like pseudocode, not recovered or necessarily recompilable C. Finite-width arithmetic, physical register slices, faulting memory operations, call clobbers, simultaneous edge copies and unknown effects remain visible; an empty formal IR signature does not become a guessed zero-argument source function. Source declarations and observed layouts are separately labeled evidence. The caller resolves active display names; the emitter escapes names/notes and retains their stable identities. Statement/control mappings preserve original instruction ranges after simplification, use UTF-16 text offsets, and are bounded separately from UTF-8 output bytes. Full physical-state output can be verbose.

`src/service/queries/index.ts` exposes the lightweight host `QueryService`; import this module directly in protocol hosts rather than the root engine barrel. Its persistent child atomically publishes loader metadata and derived navigation indexes. Reads retain the requested revision and bound pages, evidence, memory output and artifact chunks; image-only queries reject ambiguous imported slices. Graph reconstruction retains discovery gaps and never extends published function ranges. Native names remain searchable after demangling or a unique asserted rename. Annotation completions immediately advance the host's known revision; status/cancel never queue a snapshot read behind a stopped owner. A lost post-commit mutation response is not retried: inspect the durable job, saved revision and annotation IDs.

`src/service/analysis/` composes shared function discovery, the real architecture lifter/ABI, SSA/value/effect passes, debug/library evidence, stack/call/type recovery, structuring and C emission. Decode, lifting, ABI, combined discovery/type analysis and reconstruction report separate coverage. Architectural undefined values are not mislabeled as unimplemented instructions. Every stage shares the operation's cumulative work/deadline/cancellation context; only full-artifact output capacity is larger than inline delivery. Cache identity retains the original request budget, not the remaining queue deadline. `include_evidence: false` suppresses inline proof bodies and emission proof references without discarding the trusted catalog needed for later annotations.

Derived-only annotations require analysis published at the current revision and component versions. After an edit, reanalyze before annotating another derived-only ID; durable functions/imports remain directly addressable. Source metadata, annotation assertions and library contracts retain their provenance; missing source arity is never guessed from machine register liveness. `versions.ts` records the composition versions that must change when component semantics change.

Worker recovery tests use a private, job-ID-scoped filesystem gate to block the actual child event loop on both operating systems. Kill, cancellation, deadline, queue, commit-before-response and reopen checks no longer depend on Unix stop signals; production workers have no client-selectable gate.
Outer test watchdogs are distinct from service deadlines: the three multi-owner lifecycle scenarios allow 120 seconds and the oversized-frame process test allows 30 seconds after measured Windows CPU-emulation timeouts. The operation budgets and the real 200 ms blocked-worker deadline assertion are unchanged.

## Local MCP launch and artifact access

Use Node 24 LTS; integration verification pins 24.22.0. After `npm ci` and `npm run build`:

```sh
npm run mcp -- --root /absolute/input-directory --root /absolute/project-directory
npm run smoke:mcp
```

The compiled entry is `dist/src/mcp/stdio.js`; the package binary is `open-decomp`. At least one existing authorized root is required. `--root` is repeatable; `--max-workers` accepts 1–32 and `--max-queued` accepts 0–1,024. No cwd/home root is implicit. Help, version and diagnostics go to stderr; stdout is SDK protocol traffic only. EOF and catchable termination signals cancel/reap project owners. Closing the owned stdin descriptor also releases a writer blocked on oversized input.

All 13 tools expose concrete schemas, structured content and readable JSON text. Large inline decompilations use `projectDecompilationArtifactResult`, the same projection as cache delivery: original options/budgets and semantic completeness remain in the published full artifact. The delivery envelope explicitly reports `output_limit`. Tool/resource wrappers are bounded to 2 MiB; arbitrary non-analysis responses that cannot fit return a delivery error, never silent truncation. A mutation may already have committed when delivery fails: inspect the durable revision/job rather than replaying it.

Published handles have resource links and the template `open-decomp://artifact/{project_id}/{revision}/{artifact_id}?offset={offset}&length={length}`. Offset is hexadecimal; length is at most 524,288 bytes. Resource `_meta[\"open-decomp/artifact\"]` retains the exact handle, offset, consumed length, next offset/URI and encoding. JSON/text pages preserve UTF-8 scalar boundaries and never exceed the requested byte allowance; use length ≥4 to fit every scalar. Other media uses explicit base64. Resource access resolves IDs through the owning worker, never filesystem paths. Raw URI syntax, project, revision and stored hash are checked.

The SDK owns framing and protocol negotiation. Its pinned stdio implementation discards non-JSON lines; invalid JSON-RPC objects and oversized buffered input trigger bounded stderr diagnostics and shutdown. Target strings/names/notes remain untrusted data. Child processes are fault containment, not an OS sandbox; they do not execute targets, load target libraries or fetch embedded URLs.

`scripts/mcp-smoke.ts` drives the compiled server with the official SDK client and no optional progress/task extensions. `--server-entry` and `--fixtures` select installed-entry verification inputs. The workflow covers both architectures with symbol-bearing and stripped fixtures, navigation, mappings/evidence, asynchronous jobs, artifact paging/hash checks, annotations/retractions, stale revisions, cache invalidation and close/resume.

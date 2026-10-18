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
| `tools.ts`                 | `toolSchemas` (all 14 tools), each named argument/result schema, `ToolName`, `ToolInput<K>` (before defaults), `ToolArgs<K>` (validated/defaulted), `ToolResult<K>`, jobs, pseudocode source mappings, and `exportToolJsonSchemas()`.                                                                                                                                                                                                                  |
| `validation.ts`            | `validateToolRequest`, `validateToolResponse`, `assertRevision`, `nextRevision`, `RevisionConflict`, evidence/diagnostic codecs, `cacheIdentitySchema` / `cacheIdentityKey`.                                                                                                                                                                                                                                                                           |
| `serialization.ts`         | Explicit recovered-type/annotation, artifact, job and emission codecs, plus `expandEmission` (string-identity view of the compact emission tables). Internal domain records use bigint; wire schemas and `Wire*` aliases use validated hexadecimal strings.                                                                                                                                                                                            |
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

Indirect callback observations can preserve an ABI-register argument prefix
without establishing a source prototype. The observed `fixture_indirect`
register transfers establish the independent value input passed to the callback;
the caller's subsequent 32-bit arithmetic establishes which result bits it
consumes. Neither fact establishes a complete argument list or defined upper
result bits. Both dialects retain the known argument, the consumed result and an
explicit `unknown_argument_remainder()` marker. Unknown callback memory effects
and potentially outgoing stack storage remain conservative. These observations
do not follow or execute arbitrary callback targets.

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
- `functions_find`: image, optional stable ID, query, address, boundary certainty and analysis status. Name queries (here and in `symbols_find`) match a native name or its C spelling: for Mach-O one leading underscore is removed (`cSourceName`, the rule library contracts already use); other formats compare names unchanged.
- `function_get`: stable function ID and metadata/disassembly/CFG/investigation view. Metadata retains signature, ranges, annotations and lineage; an original `subject_id` may be reviewed through an exact trusted `artifact_id`, with annotation eligibility reported separately. Disassembly retains explicit gaps and accepts `detail: "full" | "compact"` (omitted means `full`; rejected for every other view). `compact` items carry only `id`, address, size, validity, flow, diagnostics, evidence IDs, `architecture` and the decoder `presentation` (`mnemonic`/`operands`, required for valid instructions); `full` additionally returns the raw bytes and structured operands. The page's `detail` field discriminates the two shapes. Investigation requires an explicit current published artifact, pages typed inference/requirement/source/signature/helper items by kind (14 kinds) and subject, and never reanalyzes or guesses the latest artifact. The `helper` kind pages every actual helper used by the selected artifact as its original `artifact_helper_index` plus exact helper name and untruncated explanation, labelled a renderer pseudocode semantic contract (not original source or an executable helper definition); an unfiltered query includes them, the per-page `helpers` list stays a name/index menu only, and `selection.counts.helpers` reports selected/total. Proof locators resolve into the full immutable artifact.
- `function_decompile`: function ID, conservative analysis/presentation options and `options.emitter: "c-like" | "python-like"` (default `"c-like"`). Defaults to a durable `queued` result; `wait: true` awaits delivery. Top-level `delivery: "auto" | "artifact"` is delivery-only, outside cache identity and analysis budgets. Requested artifact delivery retains actual semantic state/reason and reports `delivery_reason: "requested"`; automatic overflow reports `partial` / `output_limit` and `delivery_reason: "output_limit"`. Both require the matching published handle. Full artifacts retain pseudocode, signature, exact spans/mappings, capabilities and original state; no empty or truncated emission is labeled complete.
- `xrefs_get`: stable entity or explicit address, direction, reference kinds, unresolved-edge inclusion.
- `evidence_get`: evidence IDs (1–1,000) and `derivation: "direct" | "closure"` (default `direct`); `closure` also returns every record reachable through `derived_from`/`conflicts_with`. Records are paged by ID in `data.items`. An absent requested ID fails `not_found`; an absent ancestor adds a `not_found` warning naming it. Navigation results (`binary_info`, `symbols_find`, `strings_find`, `functions_find`, `xrefs_get`, `function_get` metadata) keep every `evidence_ids` linkage but leave the envelope `evidence` empty, marked `page.evidence_delivery: "by_reference"` (metadata: `data.evidence_delivery`); resolve IDs here. `inline` (function_get disassembly/CFG local proofs, which have no durable record) and `artifact` (investigation) mark the other two deliveries.
- `memory_read`: address, byte length, endian, and bytes/integer/float/pointer interpretation. Typed values retain hexadecimal machine bits (including floating-point bit patterns). Segments distinguish real bytes, zero-fill and unmapped holes; partial reads require a continuation address.
- `annotations_apply`: atomic set/retract/remove edits with stable IDs, author, user/LLM origin and assertion status. Each successful batch advances one global revision, invalidating old exact-snapshot authorization. An unchanged complete dependency ledger may authorize a new current-revision publication, never serving an old artifact as current. An annotation ID occurs at most once in a batch.
- `analysis_status`: project revision and job ID; returns the durable job and `known_revision`, the last acknowledged project revision. A completed import may have its final snapshot acknowledgement briefly in flight. Imports and annotations do not use the artifact-only `published_revision` field.
- `analysis_cancel`: same handle and acknowledged revision; explicitly distinguishes completed cancellation, requested cancellation and work already finished.

Each result includes schema version, project/revision, backend/component versions, options, budget, per-layer coverage, diagnostics, evidence and artifacts. A component version is `null` when that component has not been loaded/run; do not invent a version. `complete` means the requested bounded operation finished, not that all architecture semantics are supported. Per-layer coverage remains authoritative. `empty` is reserved for a fully indexed, exhausted query with zero items. `partial`, `unsupported`, `failed`, `cancelled`, `queued` and `running` are separate states. Stale-revision failures retain the requested snapshot in the envelope and report the current revision separately.

`exportToolJsonSchemas()` produces draft-2020-12 schemas with object roots used by MCP registration. Repeated schema nodes use local `$defs` / `$ref`; consumers must resolve references rather than depend on inline property paths. Structural constraints are unchanged, and the real SDK discovery, validation, artifact and investigation workflows were exercised with these references. JSON Schema covers structural constraints; Zod refinements additionally enforce cross-field invariants (ranges, job publication, empty/partial distinctions, spans, revision increments). Call `validateToolRequest` before work and `validateToolResponse` before transport delivery; the latter checks snapshot/job bindings and actual UTF-8 output size.

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

`queryAnnotations` pages the latest nonremoved annotations at a fixed revision, optionally by annotation/subject IDs; retracted assertions remain visible but must not affect inference. `queryAnnotationHistory` pages set/retract/remove events and their actors without reattaching an annotation to another entity. Empty ID filters differ from omitted filters in both execution and cursor identity. Removal requires an explicit author/origin. Persistence schema 5 migrates schemas 1–4 transactionally without changing wire schema 1 or the project revision. It preserves removal actors and historical image snapshots, adds the analysis-catalog index where absent, adds the `analysis_reuse` table (scope, revision, artifact) that lets a newer annotation revision find prior artifacts as bounded reuse candidates, and normalizes ordered image facts rather than encoding an entire image's metadata as one record. Old removal authors remain explicitly unknown; old artifacts do not receive invented catalog entries. Newer persistence versions are rejected before mutation.

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

The emission wire form is compact and canonical. `emission.ids` (entity identities), `emission.evidence` (proof identities) and `emission.ranges` (binary ranges) are duplicate-free per-emission tables in first-use order. Mappings, inferences, requirements and requirement sites cite them by index: `semantic_refs`/`subject_refs`/`instruction_refs` index `ids`, `evidence_refs` indexes `evidence`, `range_refs` indexes `ranges`. A mapping's `semantic_refs[0]` is its mapped statement. `emission.review` names the one `function_get` metadata review route for every inference subject (`subject_id = ids[subject_refs[0]]`). The schema rejects out-of-table references and duplicate table entries. The renderer interns while writing, so each identity/proof/range is serialized and byte-charged once; the analysis catalog reads proof closure seeds directly from `emission.evidence`. `expandEmission` (core and `open-decomp/api`) returns a string-identity view with the original `statement_id`/`semantic_ids`/`subject_ids`/`instruction_ids`/`evidence_ids`/`ranges` fields; it is a view, not a second wire form. Published analysis artifacts use format version 2.

`src/reconstruction/` and the shared renderer produce both dialects from one source projection. The native pipeline supplies source evidence: physical register slices become ABI arguments/results, private stack spills become forwarded values or scalar locals, and unchanged phi/clobber plumbing disappears before rendering. Inferred interfaces are labeled and never promoted into established source signatures. Escapes, overlaps and uninitialized paths retain shared storage; unknown calls and live non-result clobbers remain explicit. Pure synthetic definitions are bounded and materialized at their original SSA definition sites. C-like casts and Python-like width helpers preserve integer storage; floating/vector helpers retain exact payload semantics. Source-level behavior observes ABI-visible values and ordered external effects, not scratch-register snapshots at every fault. Internal callers without native source evidence retain machine-boundary rendering. Names/notes are escaped, and final-dialect UTF-16 mappings resolve synthesized values to original catalogued subjects.

Structured loop exits retain exact CFG destinations. Source layout orders acyclic sibling regions by their CFG dependencies (`loop_exit_layout`), placing shared continuations after their predecessors without moving instructions across a dynamic edge. Transfers to the nearest loop's header/successor use `continue`/`break` regardless of an obsolete outer-loop annotation. Small acyclic return tails (at most four blocks, four assignments/loads/stores and four copies per block) may be copied onto an exiting edge; each path executes its original effects exactly once and in order. Otherwise an exit to an enclosing loop's exact successor may use one boolean and immediate propagation guards after intervening loops/switches (`multi_level_loop_exit`). Control validation checks the complete scope chain, flag initialization and emitted guards. Entries bypassing initialization and irreducible sibling cycles keep explicit gotos. Exhausted presentation capacity keeps the original layout; checked output is unchanged. The source-backed SQLite 3.54.0 `strnicmp` regression evaluates both emitted dialects over 30 boundary cases without executing analyzed code.

Natural-loop header backedges do not constrain sibling order. Projection-exposed
successors whose external incoming edges all belong to one owned region move
to the smallest such region, immediately after any containing loop. Fixed-point
placement exposes further joins; bounded ownership depth keeps complex regions
explicit. `loop_transfer_target` records
nearest-loop target normalization separately, and exhausted record capacity
retains the original labeled edge.

Source presentation coalesces noninterfering unsigned widening copies with phi
storage, retaining the original narrow definition/read conversions and choosing
the widest declaration. Signed extensions, incompatible declarations and live-range
interference keep separate storage. The `phi_copy_coalescing` presentation record
names the affected values; simultaneous edge copies still pass the existing move
validator.

Source presentation expands single-use integer computations at their dominated
SSA uses, including pure synthesized pointer increments. Nonvolatile loads may
expand only at unconditional same-block uses when no store, call, fence, unknown
effect or independent load intervenes. Dependent nested loads retain their
address/data evaluation order; independent faulting loads never become
unsequenced C operands. Both explicit addresses and symbolic-table indices
participate in use/liveness accounting. `single_use_inlining` records one
function-level presentation inference, and original load/definition identities
map to their consuming expression.

Source-only `private_stack_promotion` gives exact, initialized, nonvolatile
negative entry-SP slots stable location names (`local_38` means offset -0x38),
unless a proven role supplies a better name. Mixed-width overlaps, outgoing
argument slots, unknown effects and escaping frame addresses stay explicit.
External-pointer stores are disjoint from an activation's nonescaping private
frame only under the recorded `frame_private_to_activation` / `abi_conformance`
requirement; the original alias facts remain in checked output. Open-arity
calls do not block fresh slots accessed only after those calls, but any slot
access from which an open call is reachable remains possible argument storage.
Loop-invariant entry stores may forward through loops. Initialized private-local
reads may inline across unrelated effects, never across a write to the same
local. Byte-path validation remains independent, including its explicit
loop/path bounds; exhausted presentation capacity retains the explicit form.

Source-view `call_effects` records a visible call's unchanged memory, register
and flag clobber contract rather than printing a redundant `boundary(...)`
marker. Separate unknown instructions are never folded into neighboring calls:
`compact_unknown_effect` prints one ordered `__unknown_effect(reason,
physical_inputs(...), memory_contract, output_keys)` statement. Its mapped
presentation record retains the exact physical clobber contract as JSON in
`reason`; its explicit inputs and requested outputs keep their original values.
Neither rewrite claims purity or permits motion across memory accesses, calls
or fences. Unsupported FP-environment effects remain opaque unless the existing
requirement projection independently applies; memory fences remain explicit.
At the presentation-record bound the full `boundary(...)` contract remains
visible, and unknown instructions retain `opaque_effect(...)`. Checked rendering
is unchanged.

After inlining, both source dialects may combine an initial single-entry chain
of expression-only loop tests. Short-circuit conditions preserve load order and
all tests leave to the same lexical continuation without exit copies. Assignment,
comma and copy-smuggling conditional expressions are never introduced into loop
conditions. Stages needing temporaries, exit copies, effects or shared entries
remain explicit; unrelated early returns stay inside the body. `loop_form`
records the conditions and existing control/move validation remains mandatory.
Checked rendering is unchanged.

Return-tail copies remain owned by the edge that enters them. When all incoming
edges use copies and a tail's original home is removed, its copied continuation
is removed with it; no orphan return remains after a terminal statement.
Independently reachable labeled blocks are not truncated. The existing
`return_tail_duplication` record and control validation cover this source-only
layout change, preserving original tail identities through loop shaping.

Focused emitted-output regressions exercise nested loop/switch exits, edge-specific cyclic copies, guarded effects and faults, split-register joins and synthetic source-definition scope in both dialects and both source/machine modes. The four independent source-derived fixtures cover 544 observations; this is bounded regression evidence, not a whole-program equivalence proof.

Publication validates reconstructed ownership, actual rendered transfer destinations, edge-specific copies, emitted definition order/dominance, definite local initialization, incoming-storage identity and result width/bank consistency. Failures reject publication with `unavailable_semantics`, original statement identity, instruction address when available and evidence IDs. Independent counterexamples cover multi-exit misdirection, omitted phi copies, missing/branch-local synthesized definitions, private-frame invention and wrong-bank returns. These bounded invariants are not an equivalence proof: operation completion, semantic coverage and any future translation-validation status remain distinct.

Optional `emission.local_validation` records distinguish verified local fragments, unverified scope and rejected candidates. A pure-TypeScript reduced ordered BDD checker independently compares supported integer rewrites; symbolic checks compare actual sequential phi moves with simultaneous transfers, bounded private-byte paths with proposed scalar storage, and recorded rendered edges with original control. Source counterexamples preserve the original candidate; emitted move/control counterexamples prevent publication. Unknown operations, loop/path complexity and exhausted proof allowance stay unverified. One shared optional allowance is bounded by `min(8000, floor(actual remaining work / 64))`; outer cancellation/deadlines/limits still propagate. Thirty trusted-native emitted-output outcomes and independent carry, signed-shift, copy-order, storage and exit counterexamples passed. No external solver or whole-function equivalence claim is involved.

Optional `emission.inferences` explain parameters, type alternatives, signed operations, partial fields, data identities, calls and local rewrites. Each record retains original subjects, decoded instruction IDs, evidence, binary ranges and nonempty UTF-16 spans in the final output. Exact operation-site mappings distinguish an access from its declaration. Synthetic source values resolve to original subjects; annotations retain asserted, hypothetical, conflicting and retracted status rather than becoming established facts. Instruction provenance and raw disassembly remain accessible separately from pseudocode.

A type inference record carries every `association_ids` member whose assertion details (type, status, source, offsets, width, kind and display state) are exactly equal; its subjects, evidence, instruction/range references and output spans are the union of those members' individual records, so no subject or proof is dropped. Records are split before any wire bound is exceeded. Set-valued inference `evidence_refs`/`instruction_refs`/`range_refs` are in ascending table-index order; identical sets share one immutable array within a render.

Parameter roles distinguish observed source inputs, physical-register inputs and explicit entry-storage environment inputs; an entry-SP formal is not evidence of authored arity. Interpretation widths describe reconstructed IR, not necessarily a decoder operand or source declaration. Call constants expose exact unsigned bit patterns with explicit widths, without inventing signedness. Partial fields retain unknown bounds and observed callback targets; local checks retain their bounded scope and counterexamples. Metadata uses the same operation/output budget and cancellation as rendering, and omits evidence IDs when evidence was not requested. Five focused regressions and 12 public both-dialect observations cover these boundaries; they do not establish whole-function equivalence.

Optional `emission.requirements` localize assumptions, unresolved values/effects/calls/control and conflicts at original subjects and instruction-backed output spans. One function-level `fp_environment` explanation names every affected guard/operation and its original state epoch. Source-only `fp_environment_guard` presentation selects the supported edge of an exact lifter guard when its state is an unchanged entry value or call clobber, there are no explicit environment writes, and the unsupported arm is exclusively owned. This is conditional on the recorded requirement at **each** epoch, not proof that calls preserve FP state. Omitted guard/failure provenance maps to the top requirement comment; checked guards and ordered effects remain intact. Computed, loaded, known unsupported, or opaque-written control state retains explicit guards.

Source-only `fp_native_operations` prints scalar IEEE arithmetic/comparisons and compatible conversions under the FP requirement plus the target IEEE representation, no-excess-precision and disabled-contraction (`-ffp-contract=off`) contract. Backwards consumer tracing retains helpers where arithmetic payloads escape through integer operations, memory, calls or physical boundaries. Float-to-integer conversions, fused operations, payload-sensitive operations, Python binary32 arithmetic and Python division retain explicit helpers; their rounding, NaN or exceptional behavior is not silently changed. Finite floating literals retain exact target bits. FP/integer copies preserve representation bitcasts, never numeric assignment conversions. Exhausted presentation records retain the explicit form.

Source-only `exit_scratch` presentation keeps exact exit slices and provenance
in reconstruction facts while summarizing register names once at the function
header. Exact values and entry/call/computation origins remain in exit metadata
instead of repeated exit-state dumps; dead values never acquire invented names.
Locally computed slices qualify outside an established single-register integer,
FP or vector primary result, without gathered caller demand, multi-register/HFA
evidence, or a conflicting/unprojectable declared return contract. Undemanded
x86 RDX slices are not presumed to form a pair with RAX; positive pair/wide-result
evidence keeps them inline.
High slices above an established narrow integer result in the same ABI carrier
also qualify when no positive evidence demands them: the C ABI leaves those
bits unspecified even when they are not zero. Their exact values remain metadata.
With no result-use evidence, no written integer/FP
primary storage, and agreement from source-signature inference (no declared
result, projected result or tail interface), computed nonprimary slices may
instead accompany a void-like `return;`. This is an explicit ABI assumption,
not a recovered authored void prototype. Positive
consumption evidence from already prepared native units keeps slices inline;
callers are not exhaustively scanned. The inference explicitly records
“no result-use evidence gathered; callers not scanned” and requires
`abi_conformance`; it is an assumption, not proof of non-consumption. The existing
`unavailable_semantics` diagnostic remains. These slices cease to be source
liveness roots, but potentially faulting loads and other ordered effects remain;
checked output retains the full overlay.

Source-only `arity_closure` records its per-call basis before stack promotion.
Complete native machine call/stack summaries close register-only, nonrecursive
callees even when optional debug/type metadata is unavailable; those metadata
diagnostics remain visible. Machine coverage gaps, work/refinement limits and
incomplete dependencies propagate separately and prevent closure. A closed
callee cannot read additional caller spills, so those private slots are eligible
for ordinary validated promotion and an unused `entry_sp` disappears. Unknown
indirect calls, escaping incoming-stack addresses and variadic native callees
remain open; written stack extent is never interpreted as an argument count.
Proven invocation constants and identity aliases remain actual ABI inputs before
the source-only prefix-gap check. Substitution therefore cannot manufacture a
missing leading argument. These refinements use the existing work budget and
leave the original checked summary unchanged.
Discovery-established tails to uniquely resolved imported callable entries may
use complete nonvariadic register-only library contracts. Their interfaces
propagate through the same bounded native dependency worklist as source-only
overlays, never replacing checked interfaces. Conflicting targets/contracts,
unknown indirect branches, stack/aggregate library layouts and variadic tails
retain the explicit form; a loader slot is not mistaken for a callable address.

Repeated callable-entry/import observations may use one complete signature only
when every established contract agrees. For established printf-family contracts,
an exact immutable terminated format literal supplies promoted actual types,
including `*` width/precision arguments. Register and stack actuals must bind to
original caller storage; unavailable bytes never become synthetic loads.
Positional formats, unsupported extensions, wide conversions, long double,
malformed directives and excessive actual lists keep the explicit call.
Library/format closure records `arity_closure` plus `abi_conformance`; refusal at
the presentation-record bound preserves the open form. Checked text and original
call/stack/type facts retain their conservative interfaces.

Source-only `frame_save` uses the ABI's preserved register slices (including
Windows x64 XMM6–XMM15 low 128 bits), not architecture-specific register lists.
One nonvolatile entry-value store must dominate every same-slot reload; every
return/tail exit must restore exactly those bits, including ordered concatenated
reload slices. Overlaps, escaping addresses and outgoing argument storage refuse
the rewrite. Proven saves take precedence over scalar-local promotion, so leaf
push/pop and frame-pointer saves do not create unknown-valued source locals.
Each applied slot records `frame_save` and requires `abi_conformance`; bounded
inference exhaustion retains the explicit form. Checked-view memory facts stay
unchanged. Entry-SP return-address bytes are never save slots or promoted locals;
observed return-address reads remain external entry storage.

Source pointer null tests use the declared pointer directly under an explicit
zero-null-address ABI requirement. Scalar dereferences consult actual declarations
(including const formals and coalesced representatives), stripping only unchanged
bitcasts. Whole pointer copies avoid integer round trips. Noninterfering parameter
copies may reuse the formal itself after its last original-value use; interfering
live ranges and incompatible declarations remain separate. Each rewrite retains
its presentation validation record, and checked rendering is unchanged.

`requirement_predicate(requirement_id, site_id, state_epoch, original_pure_predicate, supported_predicate_result)` first preserves the original predicate's known result. Only an unknown result may be resolved by an explicit matching acknowledgment; a known unsupported state cannot be acknowledged away. ARM supported state is true, x86 supported state false. Unknown calls invalidate earlier epoch acknowledgments. Three focused regressions and 26 deterministic source/helper observations cover both dialects, store/call ordering, wrong epochs, known unsupported state and ARM/x86 polarity. General exceptional FP environments and status fidelity remain unmodeled.

`test/cli/source-quality.test.ts` exercises the real CLI, BinarySession API and SDK stdio MCP against a newly built trusted source fixture, with no supplied source/debug/types/prototypes or raised budgets. Both dialects undergo independent emitted-text evaluation against native source returns, memory writes, branch outcomes and call arguments/order: 36 emissions and 474 behavioral comparisons cover stack10, finite FP, SQLite string comparison, memory, loops and effects. The FP source view states one `fp_environment` assumption covering every guard site; six checked-view results fetched through the same surfaces keep those guards, leave unacknowledged FP environments unknown and match native results when acknowledged. Only the isolated, locally source-built oracle executes natively; retained SQLite and arbitrary analyzed targets never execute. The native oracle is explicitly macOS ARM64; unsupported hosts skip it. FP and unresolved call interfaces retain their actual partial states.

Pure expression reconstruction recomposes contiguous register-cell slices before source-width distribution, preserving full-width carries. Source normalization recovers constant shifted-add multiplication and scaled addresses without duplicating effects or expanding shared expression DAGs. Dynamic shift masks and unknown dependencies remain explicit. Independent emitted-output checks cover 240 observations across 16 fixtures.

Source-view register-cell recombination also transports a whole integer phi when
its contiguous cells cover one complete architectural root and every predecessor
supplies the corresponding slices of the same whole value on that edge. Original
SSA cells and transfers remain immutable; source aliases extract slices from the
new whole phi, preserving parallel copies and full-width arithmetic carries.
Missing cells, differing whole values, mismatched offsets and exhausted
presentation-record capacity retain the split form. The
`register_cell_recombination` presentation record documents this exact bitvector
identity without an ABI assumption; checked output does not apply it.

The same source-only rule also follows straight-line integer bit wiring through
identity casts, extracts, extensions, concatenations, inserts, constant shifts,
power-of-two multiplies, and nonconflicting masked AND/OR/XOR lanes. Corresponding
slices rejoin their original whole value; preserved outside bits plus one changed
contiguous slice become a masked insert. Proven zero/sign upper lanes become
extensions, including a zero-extended 64-bit value in a 128-bit pair carrier.
Packing multiplications print as shifts. No formal or return width is changed by
this rule. The structural proof retains the ordered opaque SSA dependencies
(including unknown/undefined producers); unrelated or overlapping bits cannot
be mistaken for a whole value. Analysis is bounded to 128-bit integers, 128
visited definitions and depth 24 per candidate. Unsupported wiring and exhausted
presentation-record capacity retain the explicit form. The independent local
bitvector checker may veto a candidate; its 64-bit symbolic limit is unchanged.
Known-zero concat/insert lanes become zero extensions; neutral OR operands and
zero shift counts disappear, and shifted literal zeros become constants. A
numerically zero lane carrying an unknown/undefined dependency is not a literal
zero and cannot be discarded. These bit-wiring identities carry a structural
presentation proof even after the optional BDD allowance is exhausted; the
independent BDD veto still runs while its allowance remains. Nonstructural
candidates retain the exhausted-proof fallback and record-capacity limits do
not change.
Masked lowering retains the exact pre-lowering concat/insert view for subsequent
slice normalization. An extract contained in one established slice therefore
does not acquire dependencies on unrelated unknown upper bits through a newly
introduced `unknown & 0` mask. External replacements invalidate retained views
on the replaced subject and on views that observed it; full-width expressions
still preserve their ordered opaque dependencies.
Checked-view normalization keeps its original rules and text.

Source-only unsigned range analysis combines edge guards, definedness and parallel phi transfers before removing proven singleton register-cell plumbing. It widens unresolved loops and preserves unsupported signed guards, underflow paths and unknown definitions. The emitted-output induction smoke covers 294 observations, including zero trips, maximal counts, early exits, wrong guards and additional phi inputs; this is not a proof for arbitrary loops.

Source names use live dataflow roles and established field evidence, with deterministic neutral fallbacks. Explicit user displays and supplied prototype names outrank inferred roles; conflicting callable/data uses do not invent intent. Cross-dialect keywords, helper names and duplicate displays cannot shadow declarations, and the explicit `entry_sp` storage input remains protected. Trusted regressions compile and execute the declared integer/structured-memory subset as C11 and Python with real width and byte-memory helpers; incomplete indirect calls and general pseudocode are not claimed compilable.

Scalar/vector ABI projection tracks typed low lanes independently of integer banks and SIMD root capacity. Darwin variadic doubles retain entry-stack bytes; the count-zero path does not load anonymous arguments. Canonical ARM64 SIMD ORR/MOV aliases preserve packed lanes, and source-backed checks retain vector results, ordered vector stores and mixed integer/FP call arguments. FP environment guards remain explicit; supported observations assume nearest-even rounding, gradual underflow and disabled traps, without claiming general FPCR/FPSR/MXCSR status or exceptional-environment modeling. An unannotated store-only routine can be indistinguishable from a store-plus-vector-return routine; its return interface remains inferred, not a guessed proven `void`.

Source-data recovery distinguishes exact storage identities from literal presentation. Globals, pools and tables retain their own base, byte offset, proven extent, mutability and evidence. Immutable bounded ASCII/UTF-8 strings may acquire character-pointer presentation; writable, conflicting, unterminated, relocated-slot and unsupported-encoding storage remains symbolic. Section ownership does not establish one source array, and memory addresses are never rebased onto a neighboring literal. Public Mach-O executable/dylib and PE outputs return the exact fixture literal in both dialects; table regressions retain ordered reads, writes and one-past faults.

Source-only `constant_pool_literal` replaces exact-width, aligned, nonvolatile
scalar reads when their constant address names available bytes in one read-only,
file-backed image section and mapping. Overlapping relocations, mutable storage,
ambiguous bounds, possible local writes, calls and exhausted presentation capacity
retain the load. Each applied record includes the image/address, exact bytes and
load endianness; the original ordered load remains in checked view and metadata.
Integer results use integer literals. Independently recorded `fp_literal` spelling
uses round-tripping finite IEEE decimals (shortest binary32 decimals with a C `f`
suffix; exact binary64-valued decimals in Python); negative zero is preserved.
Nonfinite constants keep explicit payload-preserving bit patterns. Literal
spelling itself does not require a default FP arithmetic environment.

Source-only `indexed_data_load` prints mapped constant-base scalar loads as named
array views. Native (including local) symbols use their C spelling; otherwise a
neutral `data_<VA>` identifies the exact base. Interior symbol displacements
remain explicit in element units. Access width determines the element type, and
the index stride must be an integral multiple of that width; unsigned range bounds
must exclude address wrap. Volatile, big-endian, mis-scaled and ambiguous accesses
retain explicit memory syntax. C declarations are `extern` arrays of unknown
bound (const only for immutable storage); Python-like `memory_view` declarations
refer to the same image bytes without sequence bounds or negative-index rebasing.
Known byte extents are annotations, never inferred from the index. The bounded
presentation record and target unaligned-access requirement preserve provenance;
checked view does not apply the rewrite.

Source type views interpret unchanged machine storage only when complete, compatible associations support them. Signed operation constraints alone do not declare signed inputs; hypotheses and conflicting layouts do not establish source declarations. Narrow fragments never discard observable high carrier bits. Typed pointer arithmetic and cyclic transfers retain exact target bits; field/array views preserve original access ordering, aliasing, faults and provenance without inventing object bounds or element counts. Dedicated C/Python regressions cover signed fields, unknown-count arrays, full-width pointer returns and typed phi swaps; public Mach-O/PE memory and loop cases retain their results and ordered accesses.

Synthetic source structure views use deterministic `struct_N` names, unified by
observed member types and offsets within the function. Their C typedefs expose
`f_<hex offset>` members and explicit byte gaps, with `observed members only;
size unknown` annotations. `observed_struct_layout` records nonoverlap and exact
width checks and a target-layout ABI requirement; overlapping, unsupported or
budget-exhausted layouts stay opaque. Nested pointer types retain their complete
declaration closure. Proven scalar array strides produce array members without
invented counts, and a common observed record stride may size a repeating access
view, never an allocation extent. `partial_struct_member` keeps the original
access offset, width and ordering; `strided_struct_pointer` retains exact address
bits across typed temporaries. A single offset-zero integer, float or pointer
member (including a proven-stride scalar array) uses `natural_scalar_pointee`.
Checked output and the recovered type/shape facts are unchanged.

Presentation validation is function-scoped: identical rule/scope/reason premises
aggregate their original subjects into records of at most 64 references, splitting
only when that existing wire bound requires another record. Every subject still
maps to its rewrite inference; distinct reasons (including exact effect contracts)
remain separate. Admission is atomic and the 256-record cap is unchanged.
ABI assumptions likewise group identical rule/explanation premises in bounded
anchor chunks, and requirement spans include every mapped anchor, not just the
first. Source-only verified bitvector results with identical rule/scope/reason
premises use the same bounded batching, after every original proof executes.
Counterexamples, rejected and unverified checks remain individual records;
neither the proof-work allowance nor the record cap increases. Checked sessions
retain their original machine-validation records and rendering.
Once the shared source proof-work allowance is exhausted, further speculative
bitvector candidates retain their original forms without another doomed check.
One function-level unverified summary counts these unattempted candidates; the
limitation remains visible rather than consuming one record per skipped rewrite.
Exact source wiring is not speculative and still applies: same-type identity
operand resolution, offset-zero/same-width bitcasts and extracts reselected from a
contained slice, extension or extract relocate existing bits without arithmetic.
Arithmetic, narrowing and folding candidates keep the retained-original fallback.

The source C renderer emits declarations for direct calls from recovered source
signatures (including library variadic tails), or labels a consistent observed
interface `unknown prototype`. Conflicting call-site interfaces and exhausted
`call_declaration` records retain the explicit fallback. Declarations never
close an unknown argument remainder or manufacture an authored prototype.
`library_string_parameter` obtains C `char*` identity from the evidence-backed
library contract, not a guessed symbol name or arbitrary byte pointer. A
read-only parameter footprint permits `const char*`. Proven immutable string
literals pass directly to character/void pointers, and use one pointer cast
only for incompatible byte-pointer types; no pointer-to-integer round trip is
inserted. Failed literal proof or exhausted presentation capacity retains the
original image-backed address.
Named image addresses without an established C object/function type retain their
exact VA and display name under `symbolic_address`; the renderer does not invent
a global's source type just to declare its symbol.
Exact scalar division, remainder, rotation, full-count shifts, integer slice
insertion, addition carry and signed subtraction overflow have C inline implementations;
128-bit intermediates use the compiler's native integer extension. Signed
minimum/-1 remains undefined at every width, not a defined widened quotient.
Original helper names and contracts stay in metadata.
`c_bitcast` uses same-width `memcpy` helpers for integer/IEEE32/IEEE64
reinterpretation under an explicit native-representation ABI requirement.
`c_integer_storage` uses ordinary C scalar storage for nonstandard-width integer
locals while keeping explicit masks/sign interpretation and single operand
evaluation; nonstandard-width memory accesses keep their original spelling.
Unknown values, physical state, exceptional memory views and unsupported machine
effects remain genuine semantic helpers, not fabricated declarations or no-ops.
Checked rendering is unchanged.

The source-only signature projection keeps those machine values unchanged.
`formal_pointer` follows whole-value copies, constant byte steps and phi edges to
observed integer accesses of one consistent 8/16/32/64-bit width; byte accesses
use `uint8_t*`, never invented character types. Mixed-width accesses remain explicit.
It adds C `const` only without writes through that formal, escape to a potentially
writing call, or unknown effects; unrelated stores and known read-only calls do
not remove the qualifier. Python annotations use `pointer[T]`; the presentation
record retains the read-only/write-capable formal observation in both dialects.
`formal_low_word` requires every live carrier use to discard the upper bits first
and an unchanged low word to participate in a signed comparison, division,
extension, remainder or arithmetic shift. `return_low_word`
requires all returns to be low-word values or explicit extensions, with no
gathered caller demand for high bits; constants can join but cannot alone prove a
narrow carrier. Byte differences (both operands proved in `[0,255]`), explicit
sign extension, signed division/remainder/arithmetic shift, or selection of the
same operands compared by a signed predicate establish signed result interpretation;
otherwise it stays unsigned.
Separate high slices of that same primary result register may be omitted above
an established narrow integer result when there is no positive demand for them;
the recorded ABI/result-use requirement covers nonzero scratch high bits as well.
Demanded or otherwise unproven slices retain their explicit return overlay.
Independent supplied declarations and conflicts block these inferred replacements.
Each applied rule records a bounded presentation inference and an
`abi_conformance` requirement; absent caller evidence is not an exhaustive caller
scan. Signed return constants use that context (`-1`, not `0xffffffff`).
Checked-view signatures and expressions do not use these projections.

`fp_source_types` uses typed IEEE FP32/FP64 evidence to spell inferred FP formals
and ABI-classified primary results as `float`/`double`. Integer-typed locals may
share that spelling only in closed same-width bitcast/phi/select transport
components whose nonliteral incoming paths are established FP values and whose
consumers never interpret the carrier as an integer. Literal joins cannot
establish FP interpretation alone; independently approved finite `fp_literal`
spelling preserves exact bits, while nonfinite payloads retain bit-pattern constructors.
A store, integer operation, unresolved
boundary use, conflicting type or unknown incoming value keeps that component
explicit. Redundant bitcasts between approved FP spellings disappear; actual
integer/FP reinterpretations and exact NaN payload constants remain explicit.
This type projection alone does not rewrite arithmetic helpers or environment
guards; their independent presentation gates apply separately. One bounded
presentation inference and `abi_conformance` requirement record the native IEEE representation assumption;
failure to record it keeps all original spellings. Supplied signatures are not
overridden, and checked-view types and bitcasts are unchanged.

Bounded native parameter summaries refine the caller's existing memory shapes without rerunning its ABI/stack analysis. Compatible partial fields accumulate; overlapping alternatives, unknown size/alignment, dynamic indices, aliases and escapes remain explicit. Exact full-width copies and split entry cells retain one original pointer identity, while distinct incoming pointer bases remain distinct phi views. Callback fields retain the actual target and prepared whole argument carriers, not a guessed prototype. Source-built caller regressions cover alias/non-alias storage, strides, union conflicts and callback effects in both dialects.

Incoming stack arguments use callee-entry-SP coordinates. Exact, unchanged ABI scalar slots become provenance-backed source inputs, not freshly allocated private frame bytes. The symbol-bearing and stripped Mach-O ten-input fixture is evaluated in both dialects against 25 independent uint64 cases, including `1..10 → 385`, high-bit values and modulo-overflow boundaries.

Source storage distinguishes private allocations from an entry-backed view with one explicit `entry_sp` base. Incoming bytes, observed return-address/shadow-space bytes, dynamic alignment and escaped aliases retain that original address space; observed bounds do not imply a complete dynamic footprint. Extra storage inputs mark the interface inferred rather than preserving an exact source-signature claim. Saved-register traffic is not a source argument. Unknown outgoing stack arity retains ordered stores, established argument prefixes and an explicit unknown remainder, not a guessed complete call signature. Framed/frameless, overlap, alignment, Windows shadow-space, SysV return-address/red-zone/dynamic-local and Darwin vararg cases execute through the shared representation in both dialects. ELF debug metadata and unsupported FP environments remain separately partial.

`src/service/queries/index.ts` exposes the lightweight host `QueryService`; import this module directly in protocol hosts rather than the root engine barrel. Its persistent child atomically publishes loader metadata and derived navigation indexes. Reads retain the requested revision and bound pages, evidence, memory output and artifact chunks; image-only queries reject ambiguous imported slices. Graph reconstruction retains discovery gaps and never extends published function ranges. Native names remain searchable after demangling or a unique asserted rename. Annotation completions immediately advance the host's known revision; status/cancel never queue a snapshot read behind a stopped owner. A lost post-commit mutation response is not retried: inspect the durable job, saved revision and annotation IDs.

Import preparation persists its loader, runtime and name diagnostics with the loaded image. Partial supported-metadata recovery marks native symbol/import/export indexes incomplete; `project_open` and summary queries then return `partial` / `incomplete_index` with the ready image still available. Explicitly unsupported optional features remain capability records rather than falsely making an otherwise finished native-name index incomplete. Reopening preserves this report; native names remain immutable facts and decorated/runtime names remain separate derived records.
For a universal Mach-O image, unsupported **nonselected** architectures remain visible as slice facts and diagnostics; they do not make the selected ARM64 slice's native indexes incomplete. Selected-slice metadata loss still produces the partial state above.
Mach-O header/load-command bytes have explicit binary-evidenced data ownership even inside executable mappings. Symbol section association alone does not establish code: the address must fall within the referenced instruction/stub section. Native names and exports remain visible; weak header guesses do not become functions, while contradictory explicit code claims remain reported conflicts. Universal-slice data ranges retain container-file offsets.

PE AMD64 unwind handlers are image-relative metadata references, not proof of executable file-backed code. Mapped non-executable or zero-fill targets retain their address, permissions and record provenance with an unavailable-code capability; they do not become function seeds. Unmapped references and truncated records remain errors. `UWOP_SET_FPREG` obtains its register/offset from the header and ignores reserved OpInfo bits, as specified by [Microsoft's x64 unwind format](https://learn.microsoft.com/en-us/cpp/build/exception-handling-x64?view=msvc-170); defined operands, frame-register requirements, ordering and chain bounds remain checked. Language-specific handler payloads and unsupported unwind versions are not interpreted.

Trusted statically registered worker handlers return the named `PreparedImport` contract from `prepareImport`: the final image report plus `publish(transaction)`. Expensive preparation happens before the SQLite transaction; image metadata, indexes and terminal import state publish atomically. This extension point accepts no target-selected code or module paths.

`src/service/analysis/` composes shared function discovery, the architecture lifter/ABI, SSA/value/effect passes, debug/library evidence, stack/call/type recovery, native source facts and structuring, then selects either dialect over the same reconstruction. Native callees use one explicit bounded dependency worklist for nested calls, recursion and direct tails; direct calls remain outside intraprocedural traversal. Prepared bodies, typed argument/result observations and portable partial memory constraints are reused under exact immutable image/revision/target/component/capacity scope. Actual written-result guarantees remain distinct from caller-consumed widths; optional preparation limits retain proven entry-read prefixes and explicit unresolved arity rather than inventing zero arguments or upper bits. Trusted source checks cover 132 native outcomes and 36 direct-call outcomes across both dialects and the supported ABIs. Decode, lifting, ABI, discovery/type analysis and reconstruction retain separate coverage; every stage shares cumulative work/deadline/cancellation. Cache identity retains the requested budget. `include_evidence: false` suppresses wire proof bodies and emission proof references without discarding the trusted annotation catalog.

Native recovery distinguishes whole proven ABI-input constants, identity aliases and exact type/evidence scopes. One immutable baseline SSA body supports bounded invocation-specific views; a backedge does not reapply invocation constants. Context-assumed arguments survive simplification. Limits remain cumulative: four contexts per function, 64 contexts/functions/refinements per operation, and one bounded optional-work pool. Exhaustion retains a reasoned generic interface. Call arity, object extents, alias disjointness and author field names are not invented. Caller-level field proofs retain actual callee access origins rather than treating a call instruction as a load.

Caller-demanded, actually written result channels remain distinct from possible ABI return storage. Uncovered changed slices retain explicit physical overlays, including V0 upper bits beyond a scalar D0 result; unchanged storage is excluded and unknown call storage is not zero-filled. Without a supplied source contract, uncertain return storage produces a partial diagnostic and an unresolved requirement at the original RET/effect. A spare register is not proof of an authored aggregate. This repaired a standalone two-word result loss exposed by the paired comparison.

Native reuse replays complete positive/negative dependency ledgers, including annotations, signatures, types, proofs and entry-address frontiers. Ledgerless prepared bodies are re-lifted, not guessed into current validity. New exact-revision artifacts preserve original evidence history; global cache identity is not relaxed. The complete dependency/publication and artifact-scoped subject-review implementations are prerequisites of contextual recovery; their separate performance and investigation-byte acceptance gates are not implied. Focused source consumers passed 84 native and 24 FP/raw-storage emitted outcomes, four annotation lifecycle scopes and a 256-selector replay/invalidation scenario. See `PERFORMANCE.md` for the paired scope and retained counterexamples.

IR construction reserves block/parameter/terminator capacity and checks instructions before allocating them. Lifters reject oversized input graphs before preprocessing; SSA reserves each block's merge parameters before materializing them. SSA is minimal and dominance-based: a block receives a register-cell parameter only on the iterated dominance frontier of that cell's definitions (every cell at the entry and unreachable-component roots), other uses reference dominating definitions, and non-exit blocks record only merged/rebound cells, so SSA values scale with actual reads/writes/merges rather than blocks × tracked registers. Binding rows do not scale that way everywhere: every call/unknown effect, load, store and function exit snapshots the full tracked register state (`register_inputs` / exit rows), so those rows grow with memory-and-call operations × tracked cells; function-wide cost therefore depends on both the cell count and the number of such operations. Full per-block register state at block boundaries is derived along dominators. The node count is `3 + parameters + instructions` per block. Provenance unions and verification charge cumulative work without argument-spread fan-in. A discovery graph stopped by a resource budget cannot publish a successful semantic artifact; unsupported-instruction partial semantics remain a separate valid outcome.

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

All 14 tools expose concrete schemas and structured content with a text block. For the navigation tools (`binary_info`, `symbols_find`, `strings_find`, `functions_find`, `function_get`, `xrefs_get`, `evidence_get`) that text is a lossless, reversible projection of the structured result, not a second copy of it: a string of at least 24 characters that occurs two or more times (IDs, image IDs) is stored once in `refs` and cited as `{"$ref": index}`, and an array of two or more identically keyed objects becomes `{"$table": [keys], "rows": [[values]]}`. `decodeNavigationText` (`src/mcp/navigation.ts`) restores the exact result; a result that would not shrink, or that already uses a `$ref`/`$table` key, is delivered as plain JSON. The MCP SDK 2.3.1 requires only `structuredContent` for a tool with an output schema and appends text itself only for non-object structured values (`appendTextFallbackForNonObject`), so the serialized-JSON text block is the protocol's backwards-compatibility convention, not a requirement. Other tools return the structured result as JSON text. Investigation text is a compact factual projection, not a duplicate of its full structured envelope; original graphs, declarations and helper definitions remain in the exact artifact. The emission's producer-recorded `declaration_span` lets body quotations exclude only the function header, preserving notes/effects outside it without parsing generated text. Large inline decompilations use `projectDecompilationArtifactResult`: original options/budgets and semantic state remain in the full artifact. Explicit artifact preference preserves semantic state; only overflow reports `output_limit`. Tool/resource wrappers remain bounded to 2 MiB; arbitrary non-analysis overflow is a delivery error, never silent truncation. Annotation responses are checked inside the transaction against the conservative escaped text-plus-structured ceiling, so oversized delivery rolls back the batch. Private `max_result_bytes` and requested artifact delivery do not alter analysis budgets/cache identity. After a lost acknowledgement, inspect the durable revision/job rather than replaying a mutation.

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

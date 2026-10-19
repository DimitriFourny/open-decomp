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
explicit `...` open-argument marker (C `f(a, ...)`, Python-like `f(a, ...)` with the Ellipsis literal; the file header states its meaning once, and the `unknown_argument_remainder`/`unknown_arguments` helper entries stay in the emission metadata). Unknown callback memory effects
and potentially outgoing stack storage remain conservative. These observations
do not follow or execute arbitrary callback targets.

`AbiCallLayout.implicit_register_inputs` records machine requirements separately
from source parameters. SysV variadic/unprototyped calls require AL to be an
unsigned upper bound on vector-register usage, from the established count to
eight, not an exact count. Call analysis retains the actual register fact,
evidence, and satisfied/violated/unknown conformance; partial layouts cannot
establish satisfaction. Both emitters render these facts only as inert metadata.
Existing ABIs have no such implicit inputs.

Library prototypes: `catalog.ts` holds the hand-curated contracts (effects, argument
footprints, captures, variadic rules, noreturn); they are authoritative. Behind them,
`generated/data/*.ts` carries about 6,900 header-derived interfaces (ISO C, POSIX,
Darwin libSystem incl. `dispatch_*`/`os_unfair_lock_*`/`malloc_zone_*`/`mach_*`/`CC_*`,
CoreFoundation, glibc/Itanium-ABI support symbols, MSVC/UCRT CRT and
kernel32/user32/advapi32/ws2_32/shell32), each with its library family, header
provenance and parameter names. They are loaded lazily per family and have no memory
footprint, so pointed-to memory and global effects stay `unknown_read_write`; they never
imply purity. Types cover fixed-width and ABI-dependent integers (`long`, `size_t`,
`mode_t`, `time_t`...), `float`/`double`/`long double` (FP register bank), named opaque
types (`FILE`) and named pointer typedefs (`HANDLE`, `CFStringRef`); function pointers
stay opaque. Functions that pass or return structs by value are not declared. Lookup
removes loader decoration: Mach-O `_` and `$INODE64`/`$UNIX2003`/`$DARWIN_EXTSN`/
`$NOCANCEL`, ELF `@VERSION`, PE `__imp_`; Windows `A`/`W` names are distinct. printf-family
`format`, scanf-family `scanf_format` and `open`/`openat` `open_flags` rules close
variadic tails from literal formats. Header `const` and `char` identity are printed in
extern prototypes (`FILE* fopen(const char*, const char*)`). Regenerate with
`bun run prototypes`.

Extern data: generated modules also carry `=name|type|flags|header` lines for header
`extern` objects (`__stderrp`, `optind`, glibc `stderr`/`environ`, `kCF*` constants;
`findVariable`, lazy like functions). The Mach-O/ELF import binding of such an object
carries its declaration (`SourceAddress.import.variable`), and the C declaration prints
its type (`extern FILE* __stderrp;`; Python-like `pointer[FILE]`) when every access in
the function is one whole-width element at offset 0 and a pointer object is only read;
loads then read as pointer values (`(uintptr_t)__stderrp` in integer context, bare as
a `FILE*` argument). Weak or relocation-adjusted imports, arrays, aggregates and code
pointers keep the access-derived type. Windows data imports and Darwin
`__stack_chk_guard` (an array no public header declares) are not covered.

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
- `binary_info`: image and selected `summary`, `headers`, `sections`, `mappings`, `entry_points`, `relocations`, `hints`, `capabilities` or `types` view. Each list view is independently paged; `types` returns `text` (C declarations of the merged image structure types), the analyzed/total function counts and the type count, `partial` (`budget`) when not every body was analyzed or the text was cut. Omit `image_id` only when the requested snapshot contains exactly one image; absent/ambiguous images fail explicitly.
- `symbols_find`: image, symbol/import/export kinds, name query, optional exact address.
- `strings_find`: image, query, encodings, candidate/referenced filter, optional location range.
- `functions_find`: image, optional stable ID or `id_prefix`, query, address, boundary certainty and analysis status. Name queries (here and in `symbols_find`) match a native name or its C spelling: for Mach-O one leading underscore is removed (`cSourceName`, the rule library contracts already use); other formats compare names unchanged.
- `function_get`: stable function ID and metadata/disassembly/CFG/investigation view. Metadata retains signature, ranges, annotations and lineage; an original `subject_id` may be reviewed through an exact trusted `artifact_id` (the full ID or a unique `artifact_` prefix of at least 12 hex digits, as printed in the `function_decompile` header), with annotation eligibility reported separately. Disassembly retains explicit gaps and accepts `detail: "full" | "compact"` (omitted means `full`; rejected for every other view). `compact` items carry only `id`, address, size, validity, flow, diagnostics, evidence IDs, `architecture` and the decoder `presentation` (`mnemonic`/`operands`, required for valid instructions); `full` additionally returns the raw bytes and structured operands. The page's `detail` field discriminates the two shapes. Investigation requires an explicit current published artifact, pages typed inference/requirement/source/signature/helper items by kind (14 kinds) and subject, and never reanalyzes or guesses the latest artifact. The `helper` kind pages every actual helper used by the selected artifact as its original `artifact_helper_index` plus exact helper name and untruncated explanation, labelled a renderer pseudocode semantic contract (not original source or an executable helper definition); an unfiltered query includes them, the per-page `helpers` list stays a name/index menu only, and `selection.counts.helpers` reports selected/total. Proof locators resolve into the full immutable artifact.
- `function_decompile`: function ID, conservative analysis/presentation options and `options.emitter: "c-like" | "python-like"` (default `"c-like"`). Core default `wait: false` returns a durable `queued` result; `wait: true` awaits delivery; `wait: "auto"` (MCP default) awaits briefly, then returns the job. Top-level `delivery: "auto" | "artifact"` is delivery-only, outside cache identity and analysis budgets. Requested artifact delivery retains actual semantic state/reason and reports `delivery_reason: "requested"`; automatic overflow reports `partial` / `output_limit` and `delivery_reason: "output_limit"`. Both require the matching published handle. Full artifacts retain pseudocode, signature, exact spans/mappings, capabilities and original state; no empty or truncated emission is labeled complete.

Provenance metadata limits never cost the pseudocode. Source mappings, inference records and requirement proofs are bounded separately from the text (reference tables, per-record cardinalities, a metadata byte budget, and the 16 MiB analysis artifact). When a bound is hit the renderer or artifact assembly sheds only that metadata — an oversized artifact first drops its incremental-reuse readset (it then reuses only at its exact revision), then whole inference records, mappings and requirements — and keeps the identical text. Every omission is stated in `emission.omitted` (`kind`, `reason: "output_limit"`, `omitted` count or `null` when unknown), in a partial `provenance` coverage entry/capability, and in the result state: a function that is otherwise complete becomes `partial` with `reason: "output_limit"` and `delivery: "inline"` (nothing further to continue; the code is whole), while a semantically partial result keeps its semantic reason. A single inference record beyond its wire bound is skipped and counted. Diagnostic lists beyond 1000 entries keep the first 999 and one summary diagnostic with per-code counts. Only the text itself (output byte budget, nesting, expression-expansion budget) can still fail a render.

- `xrefs_get`: stable entity or explicit address, direction, reference kinds, unresolved-edge inclusion.
- `evidence_get`: evidence IDs (1–1,000) and `derivation: "direct" | "closure"` (default `direct`); `closure` also returns every record reachable through `derived_from`/`conflicts_with`. Records are paged by ID in `data.items`. An absent requested ID fails `not_found`; an absent ancestor adds a `not_found` warning naming it. Navigation results (`binary_info`, `symbols_find`, `strings_find`, `functions_find`, `xrefs_get`, `function_get` metadata) keep every `evidence_ids` linkage but leave the envelope `evidence` empty, marked `page.evidence_delivery: "by_reference"` (metadata: `data.evidence_delivery`); resolve IDs here. `inline` (function_get disassembly/CFG local proofs, which have no durable record) and `artifact` (investigation) mark the other two deliveries.
- `memory_read`: address, byte length, endian, and bytes/integer/float/pointer interpretation. Typed values retain hexadecimal machine bits (including floating-point bit patterns). Segments distinguish real bytes, zero-fill and unmapped holes; partial reads require a continuation address.
- `annotations_apply`: atomic set/retract/remove edits with stable IDs, author, user/LLM origin and assertion status. Each successful batch advances one global revision, invalidating old exact-snapshot authorization. An unchanged complete dependency ledger may authorize a new current-revision publication, never serving an old artifact as current. An annotation ID occurs at most once in a batch.
- `analysis_status`: project revision and job ID; returns the durable job and `known_revision`, the last acknowledged project revision. A completed import may have its final snapshot acknowledgement briefly in flight. Imports and annotations do not use the artifact-only `published_revision` field.
- `analysis_cancel`: same handle and acknowledged revision; explicitly distinguishes completed cancellation, requested cancellation and work already finished.

Each result includes schema version, project/revision, backend/component versions, options, budget, per-layer coverage, diagnostics, evidence and artifacts. A component version is `null` when that component has not been loaded/run; do not invent a version. `complete` means the requested bounded operation finished, not that all architecture semantics are supported. Per-layer coverage remains authoritative. `empty` is reserved for a fully indexed, exhausted query with zero items. `partial`, `unsupported`, `failed`, `cancelled`, `queued` and `running` are separate states. Stale-revision failures retain the requested snapshot in the envelope and report the current revision separately.

`exportToolJsonSchemas()` produces draft-2020-12 schemas with object roots (MCP advertises only the input schemas, patched for function handles, `wait: "auto"` and `detail`). Repeated schema nodes use local `$defs` / `$ref`; consumers must resolve references rather than depend on inline property paths. Structural constraints are unchanged, and the real SDK discovery, validation, artifact and investigation workflows were exercised with these references. JSON Schema covers structural constraints; Zod refinements additionally enforce cross-field invariants (ranges, job publication, empty/partial distinctions, spans, revision increments). Call `validateToolRequest` before work and `validateToolResponse` before transport delivery; the latter checks snapshot/job bindings and actual UTF-8 output size.

`QueryService.execute()` transfers ownership of asynchronous work to the project after durable admission. Its request signal/progress callbacks apply only until the response returns; ending an MCP exchange cannot cancel an already-returned job. Use ordinary `analysis_status` / `analysis_cancel` afterward. `QueryService.submit()` exposes the lower-level ticket with full-lifecycle signal/progress handling. Fixed-width admission envelopes fit the minimum 1,024-byte output budget; analysis publication and artifact delivery have separate output checks.

## Defaults and bounds

| Setting               |    Default |     Maximum |
| --------------------- | ---------: | ----------: |
| Page items            |        100 |       1,000 |
| Read bytes            |      4,096 |   1,048,576 |
| Instructions          |     10,000 |   1,000,000 |
| Blocks                |     10,000 |     100,000 |
| IR nodes              |    100,000 |  10,000,000 |
| Work units            | 10,000,000 | 100,000,000 |
| Deadline milliseconds |     30,000 |     300,000 |
| Output bytes          |  1,048,576 |  16,777,216 |

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

Image types (`src/analysis/types/image-types.ts`, `src/service/analysis/image-types.ts`) give structure types one image-wide identity. Each function contributes its local object views: memory shapes at displacement zero plus pointer values at exact flows — integer argument registers on entry and at direct calls, the result register at returns and direct calls, entry-SP-relative stack addresses. A bounded, deterministic exploration (12 neighbor bodies, 4 callers per flow, two pointee hops) loads the callees and callers of the selected function's flows through the shared native-unit cache. Views unify (Steensgaard-style; members holding unified pointees unify their pointees) only through flows the callee itself confirms by dereferencing, forwarding or returning the value, so a stale caller register joins nothing. Overlapping incompatible members refuse the union and stay separate classes with recorded conflicts. Classes are named after the lowest-address function owning a flow (`OpenFiles_arg0`, `X_ret`, `X_local_40`, pointees `X_arg0_f20`, private views `X_objN`). A class with an unexplored flow — exploration cut, absent callee body, or an image reference index that is not complete — is `bounded` and its name carries a 4-hex layout digest, so one name never denotes two layouts. The selected function declares the merged layout of every class it has a view of (a pointee class it never dereferences is declared by name only; its layout is in the image types): its own members keep their IDs and types; other members are added where they do not overlap, an unbounded indexed member before others keeps only its first element (indexed accesses stay explicit), and a member another view proves to hold an object pointer becomes that pointer. Single-view private layouts keep layout-digest names (`struct_3fa2c1`), shared by equal layouts. A loop-carried byte offset `c + k*s` beside a lockstep 0-based counter `k` (strength-reduced `a[k].f`) gives the access a constant element stride and the counter as its index, rendered `p->f_20[k].f_8`. `binary_info` view `types` (CLI `open-decomp types`, API `types()` / `typeDeclarations()`) analyzes every function body within the budget and prints all non-private classes as C declarations (`partial` when bodies remain).

`src/project/annotations/` validates names, notes, type declarations and signatures against durable subjects or a trusted, project/revision-bound semantic catalog. A batch commits annotations, assertion evidence and an optional synchronous job-completion hook atomically; cancellation or a hook failure rolls everything back. The hook receives prepared proof bodies so the complete response can be validated before commit without reading an uncommitted future snapshot. Active entity-filtered views retain local alternatives and reachable type dependencies, not unrelated declarations from other functions. User/LLM assertions never become immutable type/signature facts. Retraction, removal and stale revisions remain distinct.

`src/emitters/model.ts` owns neutral `EmissionInput` / `EmissionResult`, also exported at the package root. Inputs contain a structured function with optional recovered types, resolved display names, active notes and native `SourceEvidence`. Source evidence carries the selected target ABI, bounded native-callee observations, exact symbolic/literal addresses and proven contextual argument counts. Results contain emission, diagnostics, mapping coverage and stable-identity identifier records. The root exposes `CEmitter` / `emitC` / `C_EMITTER_VERSION` and `PythonLikeEmitter` / `emitPythonLike` / `PYTHON_LIKE_EMITTER_VERSION`.

The emission wire form is compact and canonical. `emission.ids` (entity identities), `emission.evidence` (proof identities) and `emission.ranges` (binary ranges) are duplicate-free per-emission tables in first-use order. Mappings, inferences, requirements and requirement sites cite them by index: `semantic_refs`/`subject_refs`/`instruction_refs` index `ids`, `evidence_refs` indexes `evidence`, `range_refs` indexes `ranges`. A mapping's `semantic_refs[0]` is its mapped statement. `emission.review` names the one `function_get` metadata review route for every inference subject (`subject_id = ids[subject_refs[0]]`). The schema rejects out-of-table references and duplicate table entries. The renderer interns while writing, so each identity/proof/range is serialized and byte-charged once; the analysis catalog reads proof closure seeds directly from `emission.evidence`. `expandEmission` (core and `open-decomp/api`) returns a string-identity view with the original `statement_id`/`semantic_ids`/`subject_ids`/`instruction_ids`/`evidence_ids`/`ranges` fields; it is a view, not a second wire form. Published analysis artifacts use format version 2.

`src/reconstruction/` and the shared renderer produce both dialects from one source projection. The native pipeline supplies source evidence: physical register slices become ABI arguments/results, private stack spills become forwarded values or scalar locals, and unchanged phi/clobber plumbing disappears before rendering. Inferred interfaces are labeled and never promoted into established source signatures. Escapes, overlaps and uninitialized paths retain shared storage; unknown calls and live non-result clobbers remain explicit. Pure synthetic definitions are bounded and materialized at their original SSA definition sites. C-like casts and Python-like width helpers preserve integer storage; floating/vector helpers retain exact payload semantics. Source-level behavior observes ABI-visible values and ordered external effects, not scratch-register snapshots at every fault. Internal callers without native source evidence retain machine-boundary rendering. Names/notes are escaped, and final-dialect UTF-16 mappings resolve synthesized values to original catalogued subjects.

Structured loop exits retain exact CFG destinations. Source layout orders acyclic sibling regions by their CFG dependencies (`loop_exit_layout`), placing shared continuations after their predecessors without moving instructions across a dynamic edge. Transfers to the nearest loop's header/successor use `continue`/`break` regardless of an obsolete outer-loop annotation. Small acyclic return, tail-call or trap tails (at most four blocks, four assignments/loads/stores/calls and four copies per block) may be copied onto an exiting edge; each path executes its original effects exactly once and in order. When the only code lexically between a goto and its target is such tail homes, they are copied onto every incoming edge, fallthroughs included, and their homes are no longer printed, so the goto falls through and the copies read as early returns (`goto_path_tail_duplication`; kept only when fewer gotos remain). Otherwise an exit to an enclosing loop's exact successor may use one boolean and immediate propagation guards after intervening loops/switches (`multi_level_loop_exit`). Control validation checks the complete scope chain, flag initialization and emitted guards. Entries bypassing initialization and irreducible sibling cycles keep explicit gotos. When no exit is reached by most loop edges but some exit is no duplicable tail, each exit (including the continuation after the enclosing statement list) is tried as the loop's successor so the others can move onto their edges (`loop_exit_merge`). After loop forms, a short-circuit test whose operands all leave for the next statement X, entered by those edges only, prints as `if (a && b) {…} else {X}`, or `if (a || b) {X} else {…}` when every operand leaves on its true arm (`shared_condition_arm`): X becomes the `shared` body of the head's leaving arm and the other operands' leaving arms `join` it (emitted edge kind `shared-arm`). Operands are copy-free tests that print nothing but their condition, with only silent copy-free jumps between them; the last operand's staying edge may carry copies. Both control validators accept a `shared-arm` edge only from an operand on the structural chain of its head (the head's other arm, then the last element after jumps of each staying arm) and require it to reach the shared body's first block. An else arm may hold another such condition. The rewrite is kept only when an edge leaving the remaining branch now falls through, and it is tried before breakable blocks. Afterwards, a remaining forward goto to a later element of an enclosing statement list becomes `break` out of a block run once (`breakable_block`: C `do { } while (0)`, Python-like `while True:` ending in `break`) that holds the elements from the goto up to its target. The block starts at a plain block no inner edge re-enters, nothing continues it (both control validators reject a `continue` that would target it, and its body falls through to its follow), and a wrap is kept only when the number of printed gotos drops, so outer breaks and continues are never turned into gotos; edges crossing it to an outer loop's continuation use the multi-level exit flag. Both searches charge at most a sixteenth of the remaining work and keep their best layout when it runs out. Remaining gotos are backward edges, entries into loops (irreducible regions), loop exits to a non-continuation target that no block run once can reach without crossing a loop, and edges inside C `switch` arms. Exhausted presentation capacity keeps the original layout; checked output is unchanged. The source-backed SQLite 3.54.0 `strnicmp` regression evaluates both emitted dialects over 30 boundary cases without executing analyzed code.

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

`copy_coalescing` then shares storage for in-place updates: a value defined from
a printed variable that is not read after that definition (`y = f(x)`, the next
version of `x`) prints as `x = f(x)`. Unrelated values never share storage.
Interference is the SSA live-range check including loop-carried liveness, values
defined together and block parameters bound simultaneously on an edge. Every
member must have the same presented type and width, source name and role name,
so a coalesced variable keeps a role name only when every member carries it. The
pass is bounded work and gives up (keeping separate variables) when its graph
exceeds its allowance.

Library names (`library-names.ts`): a value passed to a library-declared parameter takes
that header parameter name (leading underscores removed; `a1`, `arg`, `p`, `ptr`, ...
skipped) when every library use of it, through same-width copies and conversions, agrees;
conflicts stay neutral. A library result takes, in order, its curated role (`fopen` ->
`stream`, `open` -> `fd`, `malloc` -> `buffer`, `strlen` -> `length`, `strerror` ->
`message`, `__error` -> `errno_ptr`, `read`/`fwrite` -> `count`, ...), the declared result
type (`FILE*` -> `stream`, `char*` -> `str`, named handles -> snake case), else
`<callee>_result`. Loop/shift/callback roles, element/condition definitions, field names
and supplied names outrank these; only the `address` pointer view is weaker.

A block parameter that carries only a constant to a return, on an edge every printed
occurrence of which is followed by its own copy of the return tail, prints as
`return <constant>;` with the edge copy and the carrier dropped (`return_constant`
validation record); an edge that still reaches the shared tail keeps its copy.

Loop role names (`index`, `count`, `remaining`, `limit`, `accumulator`) never
describe a parameter by what the loop later does to it. A coalesced variable's
initial-value exception (a member that only enters a loop header phi with the
role) does not apply to a parameter or a conversion of one; a parameter that is
itself the loop variable (the loop starts at function entry) keeps its neutral
`argN` name unless it is a unit countdown ending at zero, whose start is the
iteration count (`count`); a countdown stopping elsewhere, an up-counting or
folded parameter stays neutral. A loop bound is `count` only for a unit step
from 0 that stops strictly below it, tested where the variable has taken its
steps so far; any other start or an inclusive test makes it a `limit`.

Source presentation expands single-use pure integer and IEEE scalar computations
at their dominated SSA uses, including pure synthesized pointer increments.
FP-environment-dependent ones (arithmetic, compares, conversions) move only when
no call, unknown effect or register write lies on any path from definition to
use; each FP site keeps its recorded environment requirement (which excludes
contraction). Reads in hidden FP-guard failure blocks are not uses. Nonvolatile
loads may expand only at unconditional same-block uses when no store, call,
fence, unknown effect or independent load intervenes; private-local reads and
writes are no memory and may intervene. Dependent nested loads retain their
address/data evaluation order; independent faulting loads never become
unsequenced C operands. Both explicit addresses and symbolic-table indices
participate in use/liveness accounting. `single_use_inlining` records one
function-level presentation inference, and original load/definition identities
map to their consuming expression. `copy_propagation` reads a plain multi-use
copy (same presented type) as its source variable at every use; liveness and
phi coalescing treat each read as a read of the source.

`local_load_reuse` prints a load of a private local that exactly one write to
that local and one other same-block statement read as the local itself at both
readers (`t = i; i = t + 1; out[t] = x` becomes `out[i] = x; i = i + 1`). The
write must be a pure function of the loaded value alone with no register input,
nothing else may touch the local between the load and its last reader, and a
write that follows its reader prints right after that reader (private-local
traffic cannot fault or alias, so no effect reorders); otherwise the temporary
stays.

`nested_condition_merge` prints `if (A) { if (B) S }` as `if (A && B) S` when
nothing else prints in either `if` (no statements, definitions, labels, notes or
edge copies) and neither has an `else`; short-circuit evaluation keeps B
conditional on A. When the merged tests are inline predicates over shared
operands, `merged_condition_flags` replaces the conjunction by the exact
enumerated-outcome fold (integer relations; IEEE less/equal/greater/unordered),
e.g. `!(x < 0 || x > 0) && !isunordered(x, 0)` is `x == 0`, using only leaves
the merged tests already read. Header notes: the ABI scratch comment is printed
only when a scratch register name occurs in the text (`abi_scratch_note`), and
the FP-environment assumption trails the signature with an unambiguous
requirement ID prefix (`requirement_note`); full records stay in metadata.

`short_circuit_flag` prints a condition that unoptimized code carries through a
promoted private flag local (`flag = 0; if (a) { flag = 0; if (b) flag = c; }
if (!(flag & 1)) ...`) as one test, `!(a && b && c)`: each stage writing 0
contributes `continue && rest`, each writing 1 `leave || rest`, and a last stage
copying a nested chain's flag contributes that chain in parentheses. The flag's
only retained accesses are those stores, each ending its block, and one load read
only by the merge test, which tests exactly its bit; later stages print nothing
and are entered only from the previous one, the merge only from the chain, all
edges copy-free, and the outermost head may print statements before its store.
Operands keep their order and each is evaluated only when the earlier ones
continue the chain, so guarded loads stay guarded. The merged test feeds loop
forms (`while (a && b && c)`, `do { } while (...)`) and `nested_condition_merge`
like any plain test; the dead flag storage is not declared.

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

A single-test loop (`while`, `for` or C `do`/`while`) may print its exit edge's
copies right after the loop when that edge is the only one from inside the loop
to its continuation; outer-loop exit flags are tested before them, and a
do/while's repeat copies (moved before its test) must not be read by them
(`loop_exit_copies`). The bottom test is found through nested lexical
sequences. `loop_test_restatement` also restates an unsigned range test
`x < 2^c` (or `x <= 2^c - 1`, or a negation) after a repeat copy `x = x >> c`
(logical or arithmetic, `0 < c < width`) as `x ==/!= 0`. Restatements are exact
derivations over the IR; while the shared allowance remains, the bit-vector
checker re-proves them and may veto. Python-like keeps `while True` for bottom
tests.

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

Optional `emission.requirements` localize assumptions, unresolved values/effects/calls/control and conflicts at original subjects and instruction-backed output spans. One function-level `fp_environment` explanation names every affected guard/operation and its original state epoch. Source-only `fp_environment_guard` presentation selects the supported edge of an exact lifter guard when its state is an unchanged entry value or call clobber, there are no explicit environment writes, and the unsupported arm is exclusively owned. This is conditional on the recorded requirement at **each** epoch, not proof that calls preserve FP state. Omitted guard/failure provenance maps to the top requirement comment; checked guards and ordered effects remain intact. Computed, loaded, known unsupported, or opaque-written control state retains explicit guards. An opaque effect that is the last statement of a block ending in an unresolved exit changes no recorded epoch (no modeled operation follows it) and does not retain them (`fp_terminal_effect`); an opaque effect elsewhere, such as an unsupported encoding inside the function, still does.

Source-only `fp_native_operations` prints scalar IEEE arithmetic, negation, absolute value, square root, comparisons and compatible conversions under the FP requirement plus the target IEEE representation, no-excess-precision and disabled-contraction (`-ffp-contract=off`) contract. Every operation the recorded `fp_environment` requirement covers prints natively unless a rule below keeps it explicit: C uses `-x`, `__builtin_fabs[f]`/`__builtin_sqrt[f]` (no header, so no clash with an analyzed libm callee) and `(intN_t)x`/`(uintN_t)x`; Python-like prints `-x` and `abs(x)` for binary64. Backwards consumer tracing retains helpers for operations whose arithmetic NaN payload escapes through integer operations, memory, calls or physical boundaries; a promoted local slot is private storage, so a store to it is exactly as observable as the loads that read it back. Comparisons and float-to-integer conversions never observe a payload (a NaN converts to an undefined value, as in the IR), and negation/absolute value change only the sign bit, so none of them forces helpers on their operands or their own result. Float-to-integer conversion truncates toward zero and is undefined for NaN, infinities and out-of-range values, exactly as the IR specifies. Helpers remain for fused and vector operations, payload-escaping arithmetic and square roots, whole functions whose environment is not a recorded default epoch (explicit environment writes or unknown environment effects keep every guard and every FP helper), Python binary32 arithmetic, Python division, square root and float-to-integer conversion (Python raises where the IR yields a value). Finite floating literals retain exact target bits, including integer constants that join an established FP value as a bitcast operand, phi copy or select arm. FP/integer copies preserve representation bitcasts, never numeric assignment conversions. Exhausted presentation records retain the explicit form.

Source-only `condition_flags` folds compare flags and their condition-code
consumers into native relations (`src/reconstruction/source-conditions.ts`).
NZCV/EFLAGS bit insertion and extraction, condition-code logic, conditional
compare (CCMP/CCMN) selects and cset/csel/setcc/cmov selects of zero-extended
one-bit arms are traced to their compares. Each flag is a function of a few
outcomes of its operands: equal, unsigned no-borrow, signed less (N != V) and
the wrapped sign N for integers (ADDS/CMN with a constant k other than 0 and the
signed minimum is SUBS with -k; with a register addend Z/N describe the wrapped
sum and C is `sum < addend`); less/equal/greater/unordered for IEEE compares.
The condition is tabulated over every feasible outcome (constant operands
remove only impossible rows) and every opaque one-bit leaf, then rebuilt by a
Shannon decomposition into predicates joined by `&&`/`||` (Python `and`/`or`);
a decomposition is accepted only when it reproduces every row. N alone prints as
the sign of the wrapped difference; V/OF alone and PF keep their exact flag
helper; anything else keeps the explicit form. FP predicates obey native C/Python
NaN rules (`!=` true, other relations false): complements print as `!(a < b)`,
`isunordered(a, b)` (C99 `<math.h>`, a documented Python-like helper) or the
self-comparison `x != x`. Derived FP compares print natively only when every
compare they derive from is a site of the recorded `fp_environment`
requirement. One-bit `not`/`and`/`or` print as logical operators. Checked output
does not apply the rule; `test/reconstruction/condition-flags-source.test.ts`
executes both dialects against a host oracle for every ARM64 and x86-64
condition code, CCMP/CCMN chains and FP ordered/unordered compares with NaN
inputs.

Call-clobbered FP environment values (FPCR/MXCSR epochs) whose only demand was an
omitted environment guard print no `unknown_value` placeholder or local; the
epoch stays in the requirement site and checked view.

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
Complete native machine call/stack summaries close register-only callees even
when optional debug/type metadata is unavailable; those metadata diagnostics
remain visible. A body's argument list closes when nothing outside its observed
register prefix can be read: every call (and tail transfer) that an unobserved
entry argument may reach — through registers, phis, private spills or a stack
pointer at or above entry SP — must target a closed callee or carry a complete
library contract. Calls reached only by observed parameters and computed values
(for example an indirect call after another call clobbered the argument
registers) add no input and do not block closure. Machine arity completeness is
inherited only through those reaching calls; coverage gaps, work/refinement
limits and incomplete dependencies of other callees stay in the reasons but do
not reopen the list. Recursive groups close coinductively: every member is
re-observed once assuming the group closed with its current parameters, and
the assumption is kept only if every member then closes with exactly those
parameters (a tail-call chain such as an append/grow pair forwarding its
arguments closes this way when the grow path's other callees are closed).
A closed callee cannot read additional caller spills, so those private slots are
eligible for ordinary validated promotion and an unused `entry_sp` disappears.
Indirect calls an unobserved argument reaches, escaping incoming-stack addresses
and variadic native callees remain open; written stack extent is never
interpreted as an argument count.
Proven invocation constants and identity aliases remain actual ABI inputs before
the source-only prefix-gap check. Substitution therefore cannot manufacture a
missing leading argument. These refinements use the existing work budget and
leave the original checked summary unchanged.

The native dependency worklist loads bodies breadth-first (each load at most a
quarter of the remaining optional work; no new body once half of the initial
allowance is spent) and then refines strongly connected components callees
first: a non-recursive body is observed once against its finished callees, and
only recursive groups are seeded and iterated. Memory shapes are not transferred
along recursive edges (content-addressed shape evidence derived around a cycle
would be new every round and never converge). When the refinement share runs
out, finished components keep their facts and only unfinished ones (and their
callers) are cut with a `native interface refinement work limit` reason. A callee
summary cut by any bounded share is reported as a `resource_limit` diagnostic,
and a selected function left partial with such a diagnostic reports reason
`budget` instead of `unsupported_subset`.

Darwin variadic stack arguments stored in different predecessors of one shared
call resolve when, on every incoming edge, the owning store wrote the same SSA
value (it dominates the join) or a value — through identity moves, concat
components, or an equal rematerialized constant — that the edge copies into one
block parameter of the join.
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
reload slices. An exit that never ran the save (shrink wrapping: the save sits in
one branch) qualifies when its register still holds the unmodified entry value on
that path, alone or through phis with the reload. Overlaps, outgoing argument
storage and a frame address of unknown offset anywhere in possible argument/result
storage refuse the rewrite; an escaped address of known offset (a local passed to
a callee, directly, indexed, as register-cell halves or spilled) designates its
own object and refuses only a save slot containing that offset. This rests on the
recorded `abi_conformance` requirement that such an address never designates a
save slot. Proven saves take precedence over scalar-local promotion, so leaf
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

Source-view register-cell recombination also transports a whole integer phi
(loop-carried or join) when its cells are read and written together. All cells of
the architectural root must be phis of the block. General-purpose cells join only
as far as some register read concatenates them with the cell below. A web of phi
cells carried unchanged between blocks counts as one variable, so the joined low
run may be narrower than the root; cells above it and cells read only as separate
slices keep their own phis. Every incoming edge must write the joined cells
jointly. Accepted edges are: corresponding slices of one value; low slices of v
with upper cells that slice `sign_extend(v)`/`zero_extend(v)`; low slices with
literal-zero upper cells, i.e. a 32-bit or narrower write that zero-extends; all
literal constants; cells that are each an unknown (unavailable) value of the same
reason (for example non-argument entry registers), which jointly form one unknown
value of the full width; or the unchanged cells of another recombined phi, which is
resolved as a fixpoint. Other register banks keep the complete-root rule with
identical whole values. Original SSA cells and transfers remain immutable;
source aliases extract slices from the new whole phi, preserving parallel copies
and full-width arithmetic carries. Independently written cells (for example a
partial write that preserves the other half), missing cells, differing whole
values, mismatched offsets and exhausted presentation-record capacity retain the
split form. The `register_cell_recombination` presentation record documents this
exact bitvector identity without an ABI assumption; checked output does not
apply it. `test/reconstruction/source-loop-cells.test.ts` executes both dialects
against independent oracles for a 32-bit-immediate-entered 64-bit loop variable,
CRC-style byte/24-bit lanes and an independently written-halves refusal.

The same source-only rule also follows straight-line integer bit wiring through
identity casts, extracts, extensions, concatenations, inserts, constant shifts,
power-of-two multiplies, and nonconflicting masked AND/OR/XOR lanes. Corresponding
slices rejoin their original whole value; preserved outside bits plus one changed
contiguous slice become a masked insert. Proven zero/sign upper lanes become
extensions, including a zero-extended 64-bit value in a 128-bit pair carrier and a
contiguous interior slice such as the high 64 bits of a 128-bit product.
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

Source-only exact integer simplification removes trivially reducible forms in
both dialects. Reconstruction (`integer_identity`, `extension_fold`; both in
`normalizeSourceExpressions`, not applied to checked normalization) rewrites a
same-width `x & x`, `x | x`, `x & ones`, `ones & x`, `x | 0`, `x + 0`, `x - 0`,
`x ^ 0`, `x * 1`, `x << 0`/`>> 0` to the operand itself and a sign extension of a
strictly narrower zero extension to the zero extension of the original operand
(its sign bit is zero), each behind the bitvector veto. `x ^ x`, `x - x`, `x * 0`
and `x & 0` are never rewritten: they would drop an unknown/undefined operand.
Source-only `shift_idiom` (`source-shifts.ts`, recorded presentation, no
bitvector check because the checker models neither rotates nor selects) rewrites
bitfield-move lowering back to shifts for a constant rotate count `0<k<w`:
`ror(x,k) & (ones>>k)` is `x>>k`, `ror(x,k) & (ones<<(w-k))` is `x<<(w-k)` (`rol`
by the complementary count); `lshr(x,k)` OR-ed with the top bit of `x` (an
`extract` at `w-1` or `x < 0`) selected into exactly the vacated top `k` bits is
the arithmetic shift `ashr(x,k)`; a bit field lying wholly in the non-wrapped or
the wrapped part of a rotation is that field of the rotated operand, and a
masked field whose mask bits all lie in the non-wrapped part is the same field of
`x>>k`. Every mask must match exactly (one bit more or fewer keeps the rotate),
so a true rotate stays a rotate and its helper is still emitted.
The printer applies the width- and signedness-exact rules below only when its
recorder accepts a presentation record, so checked text never changes:
`zero_high_join` (constant-zero concat parts are omitted; one remaining lowest
part is its zero extension), `conversion_collapse` (an inner conversion keeps the
operand's value modulo 2^bits, so a later conversion to no more bits converts the
operand itself, and any conversion of a zero extension converts the narrow
operand; `(uint32_t)(uint64_t)x32` is `x32`, but `(int64_t)(uint32_t)x64` keeps
both casts because the inner conversion discards bits the outer one reads),
`double_negation` (`!!x` of a one-bit value), `redundant_mask` (`x & m` where `m`
holds every bit of x's unsigned type), `idempotent_bitwise` (`v & v`/`v | v` of
one bare variable under identical conversions), `complement_xor` (`x ^ ones` is
`~x`), `negative_addend` (`x + c` with `c` in the upper half of the width is
`x - (2^width - c)`, the same value modulo 2^width), `bounded_shift_count` (a
`shl`/`lshr`/`ashr` whose count is proven at most width-1 by its own definition,
for example `b & 0x3f` at 64 bits, a narrow zero extension or a constant mask,
prints as the native `a << (b & 0x3f)`; the oversize-count helper and its preamble
appear only for a count that is not so bounded) and `bounded_mask` (`x & m` where
the unsigned upper bound derived from `x`'s definition, `source-bounds.ts`, is
covered by `m`). Those two list the operands they applied to rather than the
function, so their records stay local. Reconstruction's `strength_reduced_multiply`
(`normalizeSourceExpressions`, source view only, recorded presentation without a
bitvector check) folds `x + (x << k)`, `x + c*x`, `(x << k) - x` and `c*x - x` of
one SSA value `x` into `x * k'` with `k'` the exact constant modulo 2^width, only
for `2 <= k' < 2^(width-1)`; a lone `x << k`, `x - (x << k)`, `x + (y << k)` and a
multiplier that would read as a negated or wrapped constant stay as written. A
source-view switch prints `case N:` arms without braces unless the arm may declare
(a parallel-copy cycle temporary, a loop exit flag, or no source reconstruction);
the checked view keeps its braced arms. A value used both as a shift count and as
an ordinary arithmetic/bitwise operand (an `add`, `xor`, negation... of the count
itself, not the mask or `w - n` that derives another count) carries two roles and
keeps its neutral name instead of `shift_count`. One aggregated presentation
record per rule and function lists the simplified subjects. A narrowed
zero-extended operand shifted right by a count its C type cannot shift by is
widened first (shifting a `uint32_t` by 32 is undefined), and a negated negation
is parenthesized (`--x` is the C decrement).
`test/emitters/source-simplify-oracle.test.ts` compiles (UB-sanitized) and
evaluates randomly generated typed expressions in both dialects against the IR
semantics and the unsimplified printing; `test/emitters/c/source-simplify.test.ts`
and `test/reconstruction/source-integer-identity.test.ts` pin the signed/width
edge cases where a cast or an unknown operand must stay.

Source-only unsigned range analysis combines edge guards, definedness and parallel phi transfers before removing proven singleton register-cell plumbing. It widens unresolved loops and preserves unsupported signed guards, underflow paths and unknown definitions. The emitted-output induction smoke covers 294 observations, including zero trips, maximal counts, early exits, wrong guards and additional phi inputs; this is not a proof for arbitrary loops.

Source names use live dataflow roles and established field evidence, with deterministic neutral fallbacks. Explicit user displays and supplied prototype names outrank inferred roles; conflicting callable/data uses do not invent intent. Cross-dialect keywords, helper names and duplicate displays cannot shadow declarations, and the explicit `entry_sp` storage input remains protected. Trusted regressions compile and execute the declared integer/structured-memory subset as C11 and Python with real width and byte-memory helpers; incomplete indirect calls and general pseudocode are not claimed compilable.

Scalar/vector ABI projection tracks typed low lanes independently of integer banks and SIMD root capacity. Darwin variadic doubles retain entry-stack bytes; the count-zero path does not load anonymous arguments. Canonical ARM64 SIMD ORR/MOV aliases preserve packed lanes, and source-backed checks retain vector results, ordered vector stores and mixed integer/FP call arguments. FP environment guards remain explicit; supported observations assume nearest-even rounding, gradual underflow and disabled traps, without claiming general FPCR/FPSR/MXCSR status or exceptional-environment modeling. An unannotated store-only routine can be indistinguishable from a store-plus-vector-return routine; its return interface remains inferred, not a guessed proven `void`.

Source-data recovery distinguishes exact storage identities from literal presentation. Globals, pools and tables retain their own base, byte offset, proven extent, mutability and evidence. Immutable bounded ASCII/UTF-8 strings may acquire character-pointer presentation; writable, conflicting, unterminated, relocated-slot and unsupported-encoding storage remains symbolic. Section ownership does not establish one source array, and memory addresses are never rebased onto a neighboring literal. Public Mach-O executable/dylib and PE outputs return the exact fixture literal in both dialects; table regressions retain ordered reads, writes and one-past faults.

Value positions name what a pointer-width constant is: the exact entry of a
function of the image (symbol or discovered; `function_entry`) prints as
`(uintptr_t)name` with an `extern void name();` declaration of unknown prototype
(`function_address("name")` in Python-like), a named data object as its address,
and an immutable string literal added to a variable offset in a load/store address
as `(uintptr_t)"create" + i`. Unnamed data addresses stay numbers.

Indexed read-only tables (`indexed_data_load`) print their contents as
`static const uintN_t name[N] = {...}` (16 bytes per line, decimal below 2^32). `N`
is the smaller of the accessed range (width, masks and dominating unsigned
comparisons bound the index) and the extent: symbol size, else the distance to the next
symbol/data record/relocation or section end (`object.span_bound`, a bound rather
than a size). Tables up to 512 bytes print in full; larger ones a 256-byte prefix and
`/* ... K more */`; an unbounded index over an unsized object shows its first 16 elements
(`extent not established`). Writable storage, storage with a relocation slot and
a per-function budget of 1536 content bytes keep the `extern` view. Synthesized
struct members are `field_0xOFFSET` and gaps `pad_0xOFFSET` (hexadecimal, never `f_36`).

Source-only `constant_pool_literal` replaces exact-width, aligned, nonvolatile
scalar reads when their constant address names available bytes in one read-only,
file-backed image section and mapping. Overlapping relocations, mutable storage,
ambiguous bounds, a store to a constant overlapping address and exhausted
presentation capacity retain the load. Calls and stores through unknown addresses
do not: they cannot change bytes of a read-only mapping (the model assumes no
`mprotect`-style remapping of immutable image data). Each applied record includes the image/address, exact bytes and
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
must exclude address wrap, where the bound is the index width lowered by
zero-extension/bitcast chains and constant `and` masks (`x & c <= c`), so a byte-masked
index carried in a 64-bit register keeps the array view. Volatile, big-endian, mis-scaled and ambiguous accesses
retain explicit memory syntax. C declarations are `extern` arrays of unknown
bound (const only for immutable storage); Python-like `memory_view` declarations
refer to the same image bytes without sequence bounds or negative-index rebasing.
Known byte extents are annotations, never inferred from the index. The bounded
presentation record and target unaligned-access requirement preserve provenance;
checked view does not apply the rewrite.

Source-only `global_data_access` prints constant-address scalar accesses to image
objects as declared globals instead of an address helper. Each global used by the
function is declared once before it: C `extern T name;` (one element at offset 0),
`extern T name[];` (one scalar type at element-multiple offsets, never a bound) or
`extern uint8_t name[];` (anything else, accessed through explicit casts); Python-like
uses `memory_view`. Native names use their C spelling (Mach-O drops one underscore;
leading `__` is kept); otherwise a neutral `data_<VA>` names the object. The trailing
comment carries the VA (omitted when the printed `data_<VA>` name or a `memory_view(0x…)` already states it) and any known byte extent or data kind; declarations are mapped
with the object's evidence. Checked view still prints the explicit `data_address(...)`
identity and declares nothing.

Loader-bound import slots (Mach-O GOT/chained-fixup binds, ELF GLOB_DAT, PE IAT; not
lazy-bound slots or stub entries) carry `SourceAddress.import`. In the source view a
pointer-width read of such a slot is the imported symbol's address (`&sym`) and a
read through it is the symbol itself (`sym`), declared once with a compact comment
(`import from <library basename>`) and the bind records as evidence. The declared type is
the header-declared type when the library catalog knows the variable, otherwise the
width of the accesses seen; a function that writes the
slot keeps explicit memory accesses. Python-like declares them with `import_view`.

Import stubs (Mach-O `__stubs`, ELF PLT entries, PE thunks) are recognized from
their decoded body (address materialization, slot read, one indirect branch) plus an
established branch through a single non-weak import slot. They are published under the
import's name with `kind: "import_stub"`, boundary `established` and analysis
`complete`; `--function <import name>` selects them. Every Mach-O import with a
loader-established stub entry is also a discovery root named after the import, so a
tail branch into a stub is a tail call to the import, not stub code merged into its caller.

Objective-C (Mach-O ARM64, static metadata only): method implementations are named
`-[Class selector]` / `+[Class selector]` (category methods under their class; stripped
images keep these names). `__objc_stubs` entries are published as `_objc_msgSend$sel`
only when their selector slot lies in `__objc_selrefs` and their transfer reaches the
bound `_objc_msgSend` import; `__cfstring` objects with a bound
`___CFConstantStringClassReference` isa yield their decoded contents. In the source view:
a call to a selector stub, or to `objc_msgSend` with an exact 64-bit `__objc_selrefs` load
in x1, takes the selector's colon count as its keyword arity, argument classes from the
image's single type encoding for that selector (integer/pointer otherwise; results narrower
than 32 bits keep their observed storage), and closes its argument list
(`objc_selector`, an `abi_conformance` requirement) only when the caller prepares no
further argument register. It prints as `[recv kw:a kw2:b]` (Python-like
`recv.kw_kw2_(a, b)`); a receiver read from a class reference (`__objc_classrefs` or a
bound `_OBJC_CLASS_$_X` slot) prints as the class name, a selector-slot read as
`@selector(x)`, a class-slot read as `[X class]`, a constant string as `@"…"`
(`NSString("…")`). `objc_alloc`, `objc_alloc_init`, `objc_opt_new/class/self/
isKindOfClass/respondsToSelector` print as the equivalent messages (`[[cls alloc] init]`).
Tail transfers render `return [recv sel]` when their selector has a type encoding (or no
keywords). Known Foundation variadic selectors (`stringWithFormat:`, `predicateWithFormat:`,
`raise:format:` …) whose format argument is an exact `__cfstring` constant take their
printf actuals (`%@` = object pointer) from Darwin's anonymous-argument stack slots and
print complete (`[NSString stringWithFormat:@"%@=%ld", a, b]`); otherwise they keep an
explicit `...` remainder. Unresolved selectors, `objc_msgSendSuper2` (shown with
`@selector(...)`) and ARC calls (`objc_retain`/`objc_release`/`objc_storeStrong`/…,
catalogued libobjc contracts) remain explicit calls; nothing is dropped. A function that is
a method implementation is headed `-[Class sel](… self, … _cmd, …)` (Python-like
`def Class.sel_(self, _cmd, …)`, `@classmethod` for class methods). Its unique method type
encoding is an established `runtime`-source signature (unless debug info or a durable
signature declares one): `id`/`Class`/`SEL`/`char*`/scalar formals and result, `void` for
`v`. `self` of an instance method points to `struct Class`, declared from the class's (and
in-image superclasses') ivars at their static offset-variable values, so accesses print as
`self->_ivar`; the isa word and unrepresentable ivars stay gaps and no size is claimed. A
tail call into a proven-void callee (library contract, `v` encoding, or any tail of a void
method) prints as `f(…); return;`.

Source type views interpret unchanged machine storage only when complete, compatible associations support them. Signed operation constraints alone do not declare signed inputs; hypotheses and conflicting layouts do not establish source declarations. Narrow fragments never discard observable high carrier bits. Typed pointer arithmetic and cyclic transfers retain exact target bits; field/array views preserve original access ordering, aliasing, faults and provenance without inventing object bounds or element counts. Dedicated C/Python regressions cover signed fields, unknown-count arrays, full-width pointer returns and typed phi swaps; public Mach-O/PE memory and loop cases retain their results and ordered accesses.

Source-view locals take their printed pointer type from every definition and use of a connected set of integer locals (phi copies): typed library/prototype parameters, header-declared pointer globals and results (`char *`/`const char *`/`FILE *`), identity tests against null or a same-typed pointer, and member or slot reads. `local_source_type` records the choice. A set becomes pointers only when typed uses and definitions save more printed conversions than integer uses (arithmetic, comparison, raw dereference, stores, untyped definitions) add; conflicting pointee types, scalar-typed members and ties keep the integer declaration. A pointer read as an integer prints `(uintptr_t)p`, so pointer-typed locals never change arithmetic or scaling. The printer drops conversions that C's own rules make no-ops for the printed operand types: a declared pointer passed where its own (or `void *`, or a `const`-adding) pointer type is wanted, pointer identity tests, a signed variable passed to a signed parameter or compared for equality (C converts the mixed pair to the unsigned type of the same bits; Python-like keeps its explicit reduction), and reductions of a struct member read to its own declared integer type; ordered comparisons keep their signed/unsigned conversion. A constant that reaches a `return` through a variable that is dead after it (`index = 0; return index;`) prints as `return 0;` whenever the return is entered by exactly one printed edge (`return_constant`); a join entered by several arms keeps its carrier. A trailing bare `return;` of a `void` function is not printed (falling off the end returns).

Synthetic source structure views use deterministic `struct_N` names, unified by
observed member types and offsets within the function. Their C typedefs expose
`f_<hex offset>` members and explicit byte gaps, with a `/* partial; N fns */` note (`partial`: only the members the text uses; `N fns`: merged from that many functions; conflicts are listed): a function declares only the members its text accesses (byte gaps keep every offset; a structure the text never accesses stays an incomplete typedef), the image-wide layout lives in the types view / `types.h`. `observed_struct_layout` records nonoverlap and exact
width checks and a target-layout ABI requirement; overlapping, unsupported or
budget-exhausted layouts stay opaque. Nested pointer types retain their complete
declaration closure. Proven scalar array strides produce array members without
invented counts, and a common observed record stride may size a repeating access
view, never an allocation extent. `partial_struct_member` keeps the original
access offset, width and ordering; `strided_struct_pointer` retains exact address
bits across typed temporaries. A single offset-zero integer, float or pointer
member (including a proven-stride scalar array) uses `natural_scalar_pointee`.
Members that are all one integer or float type at contiguous element-aligned offsets,
with no declared size and no proven record stride (for example the `p[0]..p[7]`
accesses of an unrolled loop), are an array, not a structure:
`scalar_array_pointee` prints a plain `T*` with subscripts. Differing widths or
kinds, gaps, misaligned offsets, a stride or a size keep the structure. Typedefs of
structures and opaque types without a printed body are written only when the
finished text refers to their name.
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
signatures (including library variadic tails), or marks a consistent observed
interface `/* inferred */` (an open argument list already prints `...`, so it needs no mark). Conflicting call-site interfaces and exhausted
`call_declaration` records retain the explicit fallback. Declarations never
close an unknown argument remainder or manufacture an authored prototype.
`library_string_parameter` obtains C `char*` identity from the evidence-backed
library contract, not a guessed symbol name or arbitrary byte pointer. A
read-only parameter footprint permits `const char*`. Proven immutable string
literals pass directly to character/void pointers, and use one pointer cast
only for incompatible byte-pointer types; no pointer-to-integer round trip is
inserted. Failed literal proof or exhausted presentation capacity retains the
original image-backed address.
Source-view `string_literal` (recorded per site) prints any pointer-width
constant that addresses the start or an interior of an immutable, NUL-terminated
string as that literal in value positions: call arguments, stores, returns,
copies, select arms and equality comparisons, whatever the callee type
(`fopen(path, "rb")`, `value == 0 ? "con" : value`). The receiving type decides
the spelling: a character/void pointer takes the bare literal, another pointer a
cast, an integer destination or operand `(uintptr_t)"..."` (Python-like:
`string_address("...")`), so a pointer is never silently converted. Arithmetic
operands keep the integer. Strings longer than 200 characters show their prefix
and a marker keeping the address and the omitted byte count. Escapes follow each
dialect (control, format and bidirectional characters are never printed raw).
`character_literal` prints a constant as `'/'`, `'\\'`, `'.'` or `'\0'` (Python-like
`ord('/')`) only with character evidence: a byte loaded through a pointer to
bytes (inferred formal, declared `char`/`uint8_t` pointer, library `char*`
parameter or result, offsets of those), widened or narrowed; or a library
parameter marked `character` in the contract catalog (`strchr`, `strrchr`,
`memchr`, ctype and `putc` families; not `memset`'s fill byte). Equality
comparisons and call arguments also admit `'\n'`-style escapes and NUL; ordered
comparisons and add/subtract keep to printable codes. Arbitrary integers are never
character-ified.
Named image addresses without an established C object/function type retain their
exact VA and display name under `symbolic_address`; the renderer does not invent
a global's source type just to declare its symbol.
Exact scalar division, remainder, rotation, full-count shifts, integer slice
insertion, addition carry and signed subtraction overflow have C inline implementations;
128-bit intermediates use the compiler's native integer extension. Signed
minimum/-1 remains undefined at every width, not a defined widened quotient.
Original helper names and contracts stay in metadata.
Only the helper definitions, `#include` and `#define` lines that the finished
function text references (directly or through another helper) precede it, in a
fixed order; the text is scanned outside comments and string literals after
rendering, so unused or speculative expressions never add one. The FP environment
requirement appears as one comment line citing its id; its full explanation is in
the `requirements` metadata, and checked rendering keeps the full text.
`c_bitcast` uses same-width `memcpy` helpers for integer/IEEE32/IEEE64
reinterpretation under an explicit native-representation ABI requirement.
`c_integer_storage` uses ordinary C scalar storage for nonstandard-width integer
locals while keeping explicit masks/sign interpretation and single operand
evaluation; nonstandard-width memory accesses keep their original spelling.
Unknown values, physical state, exceptional memory views and unsupported machine
effects remain genuine semantic helpers, not fabricated declarations or no-ops.
Checked rendering is unchanged.

The source-only signature projection keeps those machine values unchanged.
`formal_pointer` follows whole-value copies, phi edges, promoted frame-private
slots (every stored value reaches each reload), constant byte steps and index
terms (a constant-scaled or extended addend) to the retained accesses through a
formal. One consistent 8/16/32/64-bit integer or 32/64-bit IEEE element kind
yields `uintN_t*` / `float*` / `double*`; byte accesses use `uint8_t*`, never
invented character types. Mixed widths or kinds remain explicit.
It adds C `const` only without writes through that formal, escape to a potentially
writing call, or unknown effects; unrelated stores and known read-only calls do
not remove the qualifier. Python annotations use `pointer[T]`; the presentation
record retains the read-only/write-capable formal observation in both dialects.
C `typed_index` prints `p[i]` / `p[k]` / `p[i + k]` / `p[i - k]` for an access
through a declared scalar pointer (integer or IEEE element) of exactly the
accessed width and kind. The address is flattened through nested inline
additions and constant subtractions into one pointer base, at most one index
scaled by the element size (unscaled for bytes) and a constant byte displacement
that is an exact multiple of the element size; the constant is added in the
index's own 64-bit unsigned arithmetic, so the scaling wraps like the address.
A misaligned displacement, a second or unscaled index, a signed or narrower
index joined to a constant, a mismatched width or kind, or a volatile,
big-endian or aligned access keeps the explicit `*(T *)(...)` address. Python
memory views are byte-addressed, so `typed_address_sum` prints the same address
as one modular sum `uint64(p + i * size + bytes)` instead of nested reductions.
The `scaled_pointer_arithmetic` assignment form of a typed pointer update
extends the same way: `p = p + index * size + k` prints `p + index + k/size`.
`slot_pointer_type` gives a promoted frame-private slot, and its reloads, the
type of a pointer formal when every value stored to the slot is such a formal,
a reload of a slot of the same element kind, or a whole-element constant step of
one (an optimistic start shrunk to a fixpoint). Any other store keeps the integer
slot. C then assigns, dereferences and subscripts the slot as that pointer and
reads its address bits through `uintptr_t` only in integer contexts.
`formal_low_slice` narrows a formal to 8/16/32 bits when every live use, through
copies, promoted slots and bitcasts, reads only that low slice (truncation, an
extract inside it or a constant mask within it). Calls, returns, stores,
addresses, conditions, physical or open-arity register inputs and unresolved
exits (outside a recorded requirement's failure arm) observe the whole carrier
and refuse. The formal is signed only when an unchanged low slice of the
presented width participates in a signed comparison, division, extension,
remainder or arithmetic shift; a Python caller passes the annotated value.
`return_low_word`
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
A store outside `fp_memory_access`, an integer operation, unresolved
boundary use, conflicting type or unknown incoming value keeps that component
explicit. Redundant bitcasts between approved FP spellings disappear; actual
integer/FP reinterpretations and exact NaN payload constants remain explicit.
This type projection alone does not rewrite arithmetic helpers or environment
guards; their independent presentation gates apply separately. One bounded
presentation inference and `abi_conformance` requirement record the native IEEE representation assumption;
failure to record it keeps all original spellings. Supplied signatures are not
overridden, and checked-view types and bitcasts are unchanged.

`fp_memory_access` extends those components to ordinary memory: little-endian,
non-volatile, IR-alignment-1 32/64-bit loads and stores outside promoted and
hidden frame-save slots. A load joins a component only by consumer evidence (a
same-width bitcast to an IEEE value, or an edge/select transport into an
established carrier) and like a literal cannot establish a carrier through its
own incoming path. A store of a component member is a whole-bit FP write. Any
other consumer of the loaded value (integer arithmetic, a narrowing store, an
address, a boundary or control use) keeps the whole component, the integer
access and its bitcast explicit; a load/store copy without IEEE evidence stays
integer. Approved accesses print through `*(double *)` / `*(float *)` lvalues
(Python `memory.f64[...]` / `memory.f32[...]`) and never as integer data tables.
They count as IEEE element accesses for `formal_pointer` and
`slot_pointer_type`, so formals become `const double*` / `float*` and use
`typed_index` subscripts. One bounded presentation inference and an
`abi_conformance` requirement (same IEEE bytes, unaligned access permitted by
IR alignment 1) record the rewrite; failing to record it re-projects without
memory typing. Checked view is unchanged.

`fp_slot_type` treats a promoted frame-private slot (`private_stack_promotion`
local) of 32/64 bits as storage between its stores and reloads, like a phi:
when every stored value is a same-width IEEE value, closed FP carrier member or
literal and every reload is a member of that carrier component, the local is
declared `float`/`double` and its stores and reloads print as plain assignments
without bitcasts. An integer consumer of any reload, or a stored integer value,
keeps the integer local and every bitcast. A scalar-width (32/64-bit) FP-bank
argument register formal is always IEEE (`float`/`double`): every supported C ABI
passes an integer-typed formal in an integer register or another stack slot, so
an integer spelling would misroute it. Its integer uses read the bits through an
explicit bitcast; partial register cells slice its whole-bit integer view, never a
lane of the float value. An incoming-stack word formal joins FP components by
consumer evidence only, like an ordinary memory read, and only where classifying
the presented interface with that formal as IEEE keeps its original stack slot
(Win64 positions; SysV/AAPCS64 once the FP argument registers are exhausted).
The rule records a presentation inference and
an `abi_conformance` requirement (an assignment to a float/double local keeps the
exact bits; no excess precision, no signaling-NaN quieting); failing to record it
re-projects without slot typing. Raw (unpromoted) slots already use
`fp_memory_access` lvalues. Checked view is unchanged.

`primary_result` chooses between the ABI integer and FP primary result registers
of an undeclared function whose returns carry no explicit IR values. A register
qualifies only when it is defined on every exit path: an unknown entry value of a
non-argument register, an unprojected call clobber, an unknown-effect output or
an address into the returning frame disqualifies it. The integer register must
be written on some exit (an unchanged argument register may join); the FP
register needs typed IEEE FP32/FP64 writes on some exit, with literal bits or a
typed argument allowed elsewhere. A load from an exact private stack slot whose
every direct store holds typed FP bits, literal bits or a reload of another such
slot (an O0 slot-to-slot copy, also through same-width bitcasts) counts as a
typed write. When only the integer register qualifies but the FP register is
written on every exit, after the integer register on every exit path, the
explicit form remains instead of an integer result.
When both qualify, positive caller demand decides; then the register written last
on every path into every exit wins: a definition whose block is dominated by the
other's definition (or follows it in the same block) is later, and merges compare
per incoming edge. A counter updated after an FP temporary therefore stays the
integer result. Only for mixed or unclear ordering does a native written-result
interface naming exactly one of them decide.
Otherwise the explicit `physical_return` form remains. With neither qualifying,
no register result is inferred and the existing void-like/explicit exit handling
applies. Chosen results record a bounded presentation inference and an
`abi_conformance` requirement; the rejected register keeps its exact value in
exit metadata (moved out of line only under `exit_scratch`) and in the checked
view. Native written-result storage that the rule rejects stops counting as
result evidence for exit overlays. Vector-typed FP carriers, supplied signatures
and checked views keep the existing projection.

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

MCP delivery is text-first and advertises no `outputSchema` (it was 316 KB of the tools/list; results are still validated by `validateToolResponse` before delivery, and `exportToolJsonSchemas()` keeps the output schemas for library callers). Every successful result carries a text block; most also carry `structuredContent`.

- **`function_decompile`** (default `detail: "text"`): `content` is one text block, no `structuredContent`, no resource link. It starts with at most two comment lines (`//` for c-like, `#` for python-like): `NAME @ va:0x… | state(reason) | artifact_<12 hex>` (state `complete`, or `partial(unsupported_subset)` etc.; the artifact handle is what `function_get` `view: "investigation"` takes as `artifact_id`, a unique prefix being accepted), then `caveats: …` listing the distinct warnings and errors in compact form, most severe first: `N calls with unresolved interface`, `return list unresolved (possible storage: x1, v0, …)`, `callee summaries cut by budget: a, b` (or `partial` for non-budget causes; one name list instead of each callee's internal reasons), any other diagnostic by its first sentence with a `×N` count (an error keeps its whole message). Cache state, entity ID, dialect (the comment character and the renderer's own first comment line state it; that line adds `source interface` only when the interface comes from debug info, otherwise parameters and results are ABI-inferred) and info diagnostics are not in the text; every diagnostic stays in the artifact and in the `detail: "full"` envelope. The pseudocode follows. A decompilation whose metadata-laden envelope exceeded the delivery bound is still delivered as text (read back from its verified artifact); pseudocode over 512 KiB, or `delivery: "artifact"`, delivers the header only and says why. `detail: "full"` adds `structuredContent` = the complete envelope (emission mappings, evidence, inferences, coverage; artifact projection above 256 KiB as before) and the artifact resource link; the text block is the same header + pseudocode. Queued/running results carry `structuredContent` plus a one-line next step; failures carry `{state, error, current_revision}` text and the full structured envelope.
- **`wait`** on `function_decompile` is `"auto" | true | false`. MCP defaults to `"auto"`: the call returns the finished result when the job completes within `QueryCallOptions.auto_wait_ms` (default 10 s), otherwise the durable `queued` job (admission ownership transfers exactly as for `wait: false`). The core/API default stays `false`. `true` awaits the terminal result; `false` returns the job at admission.
- **Function handles.** `function_get.function_id`, `function_decompile.function_id` and `xrefs_get` `target: {kind: "entity", id}` accept, besides a full entity ID: an exact function name (`_main`; a Mach-O name also matches its C spelling), `va:0x…` / `rva:0x…` / `file:0x…`, or `entity_` plus at least 12 hex digits of a unique ID prefix. Handles are resolved after authorization by the shared `selectFunction` (`src/service/queries/selector.ts`, also used by `BinarySession.decompile`) against the function index of the project's sole image (multi-image projects need full IDs). Absence, ambiguity and an index too partial to prove either are distinct failures; none is guessed. `functions_find` accepts `id_prefix` (same ≥12-digit rule) for the same lookup.
- **Failures** produced by the MCP layer (invalid arguments, unresolved/ambiguous function handle, host-policy rejection, oversized delivery) are `{code, path?, hint}` with `isError: true` in both the text and `structuredContent`; an ambiguous handle adds `candidates: [{id, name, entry}]` with short IDs. Core failures keep their `failed` envelope in `structuredContent` and a compact `{state, error, current_revision}` text.
- **Search tools** (`functions_find`, `symbols_find`, `strings_find`): the text is a compact row listing, not a projection of the envelope: a header (state/reason, index state, row count, `next_cursor`), distinct caveats (`! warning code: …`, the same compaction as the decompile header), then one row per record (`va:0x… name size boundary/analysis[/import-stub] signature short-ID`; symbols/imports/exports with kind, library, ordinal; strings with encoding, length, status and JSON-escaped text). Per-record evidence IDs, ranges and image IDs are in `structuredContent` only. Short IDs are `entity_` + 12 hex digits (longer only to separate IDs in the same page) and are accepted as function handles.
- **Other navigation tools** (`binary_info`, `function_get`, `xrefs_get`, `evidence_get`): the text is a lossless, reversible projection of the structured result: a string of at least 24 characters that occurs two or more times is stored once in `refs` as `{"$ref": index}`, and an array of two or more identically keyed objects becomes `{"$table": [keys], "rows": [[values]]}`. `decodeNavigationText` (`src/mcp/navigation.ts`) restores the exact result; a result that would not shrink, or that already uses a `$ref`/`$table` key, is plain JSON. Other tools return the structured result as JSON text. Investigation text is a compact factual projection, not a duplicate of its full structured envelope; original graphs, declarations and helper definitions remain in the exact artifact. The emission's producer-recorded `declaration_span` lets body quotations exclude only the function header, preserving notes/effects outside it without parsing generated text. Large inline decompilations use `projectDecompilationArtifactResult`: original options/budgets and semantic state remain in the full artifact. Explicit artifact preference preserves semantic state; only overflow reports `output_limit`. Tool/resource wrappers remain bounded to 2 MiB; arbitrary non-analysis overflow is a delivery error, never silent truncation. Annotation responses are checked inside the transaction against the conservative escaped text-plus-structured ceiling, so oversized delivery rolls back the batch. Private `max_result_bytes` and requested artifact delivery do not alter analysis budgets/cache identity. After a lost acknowledgement, inspect the durable revision/job rather than replaying a mutation.

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

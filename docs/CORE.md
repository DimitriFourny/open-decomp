# Core contracts (schema version 1)

Import from `src/core/index.ts` or the owning module, using `.js` relative specifiers. Core has no MCP or decoder-library dependency. The root package export is owned by integration.

Module names in the interface map below are relative to `src/core/`.

## Interface map

| Module                     | Main exports / consumers                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `primitives.ts`            | Strict Zod schemas for IDs, branded `HexU64`, explicit wire addresses, target combinations, diagnostics, evidence origins, layer-specific coverage/capabilities, revisions, budgets, options and artifacts. `Internal<T>` converts only branded machine integers to `bigint`; ordinary names/notes remain strings.                                                                                                                                               |
| `integers.ts`, `codecs.ts` | Existing `parseHexU64` / `formatHexU64`; Zod 4 `hexU64Codec`, `addressCodec`, `rangeCodec` and internal bigint schemas. JSON Schema is exported from wire schemas, never bigint schemas/codecs.                                                                                                                                                                                                                                                                  |
| `addresses.ts`             | `Address`, `AddressRange`, `ImageMapping`, `MappingContext`, `ImmutableBytes`, `AddressMap.translate` / `.spans`, checked arithmetic/index conversion, signed-magnitude and address/range codecs.                                                                                                                                                                                                                                                                |
| `identity.ts`              | Content-derived image identity; slice identity includes image, container offset, size and architecture; entity identity includes immutable birth information. Random durable project/job/annotation/evidence/artifact IDs; type-tagged canonical fingerprints; revision/query-bound cursor encoding and validation.                                                                                                                                              |
| `model.ts`                 | `LoadedImage`, slices, mappings, sections, structured header fields, symbols/imports/exports, relocations, function/unwind/data hints, navigation records, source types/signatures, annotations and split/merge lineage. Corresponding finite wire schemas are exported.                                                                                                                                                                                         |
| `decoder.ts`               | `RegisterDescriptor`, `DecodedFlow`, `DecodedInstruction`, `DecodeGap`, `Arm64Payload`, `X86Payload`, and structured wire schemas. ARM canonical fields, aliases, SP/ZR and feature validity are distinct from x86 operands, prefixes, register/memory accesses and flags.                                                                                                                                                                                       |
| `contracts.ts`             | `Loader`, `Decoder`, `Lifter<RegisterIR>`, `AbiProfile`, `AbiType`, `AbiCallLayout`, `Emitter<Presentation>`, `ProjectStore`, `StoreTransaction`, `StoredRecordKinds`, `RecordQuery`, `StoreFactory`, `AnalysisService`, `WorkerCommand`, `WorkerEvent`, `WorkerPool`, `ComponentRegistry`. Semantic IR lives in `src/ir/`; presentation lives in `src/presentation/`. Generic parameters are those integration boundaries, not unknown tool payloads.           |
| `tools.ts`                 | `toolSchemas` (all 14 tools), each named argument/result schema, `ToolName`, `ToolInput<K>` (before defaults), `ToolArgs<K>` (validated/defaulted), `ToolResult<K>`, jobs, pseudocode source mappings, and `exportToolJsonSchemas()`.                                                                                                                                                                                                                            |
| `validation.ts`            | `validateToolRequest`, `validateToolResponse`, `assertRevision`, `nextRevision`, `RevisionConflict`, evidence/diagnostic codecs, `cacheIdentitySchema` / `cacheIdentityKey`.                                                                                                                                                                                                                                                                                     |
| `serialization.ts`         | Explicit recovered-type/annotation, artifact, job and emission codecs, plus `expandEmission` (string-identity view of the compact emission tables). Internal domain records use bigint; wire schemas and `Wire*` aliases use validated hexadecimal strings.                                                                                                                                                                                                      |
| `operation.ts`             | `createOperationContext` owns one monotonic deadline and cumulative work counter per operation; `OperationError` carries typed cancellation/resource diagnostics across component boundaries. `consumedWork()` (beside `remainingWork()`) reads the same counter; `function_decompile` delivers it as `data.work` (per delivery: a cache `hit` reports the cost of serving the stored result), outside the stored artifact, the cache identity and the emission. |

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
explicit open-argument marker: an indirect call's function-pointer type spells it (C `((T (*)(A, ...))target)(a)`, Python-like `function_pointer(target, "T (*)(A, ...)")(a)`), and a direct callee without an established prototype is named once on the `open arity` comment line while its calls print only the proven arguments. An interface that proves no argument, a callee that also has a closed or guessed call, and a callee with an established prototype keep an inline `...` (the file header states its meaning once). The `unknown_argument_remainder`/`unknown_arguments` helper entries stay in the emission metadata and the checked view keeps the named helper. Unknown callback memory effects
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
is explicitly unavailable (partial diagnostic, no recovered debug declarations;
local types are withheld only when `.debug_*`/`.zdebug_*` sections are present),
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
- `functions_discover`: project, current revision and image. Continues a budget-limited whole-image function discovery (the persisted frontier of the import or the previous step) under this request's budget; a step that progresses publishes the roots it traversed, their references and cited evidence and advances one revision (`data.revision`). `progressed: false` (nothing committed) means the enumeration is complete or no pending root fits the instruction limit. The function index is `complete` only when every executable byte is explained (see docs/internals/discovery.md); only then is "No function matches the selector" an absence proof, otherwise selection reports `incomplete`. `BinarySession.decompile` (API/CLI) answers an `incomplete` selection by running steps to the end under the request's budget (`completeDiscovery`), then selects again; MCP clients call the tool themselves. Example (`fixtures/bin/elf-x86_64-stripped`, 200-instruction budget, `test/api/discovery-resume.test.ts`): import partial, continuation steps, then the same 19 functions as a default-budget import and a `not_found` for padding between functions; the same sequence in a cold project gives identical records, revision and text.
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

`queryAnnotations` pages the latest nonremoved annotations at a fixed revision, optionally by annotation/subject IDs; retracted assertions remain visible but must not affect inference. `queryAnnotationHistory` pages set/retract/remove events and their actors without reattaching an annotation to another entity. Empty ID filters differ from omitted filters in both execution and cursor identity. Removal requires an explicit author/origin. Persistence migrations run transactionally without changing wire schema 1 or the project revision; the current store schema is 6 (see [Analysis cache and persisted callee summaries](#analysis-cache-and-persisted-callee-summaries)). The migration to schema 5 preserves removal actors and historical image snapshots, adds the analysis-catalog index where absent, adds the `analysis_reuse` table (scope, revision, artifact) that lets a newer annotation revision find prior artifacts as bounded reuse candidates, and normalizes ordered image facts rather than encoding an entire image's metadata as one record. Old removal authors remain explicitly unknown; old artifacts do not receive invented catalog entries. Newer persistence versions are rejected before mutation.

Image metadata retains the 16 MiB individual encoded-record limit, with a separate 64 MiB aggregate encoded-byte limit and one-million-fact limit per loaded snapshot. Counts/order are checked on read; oversized SQLite fact blobs are rejected before transfer to JavaScript. Replacements, facts, index publication and completed jobs commit atomically; failed writes or migrations roll back. Storage resource failures retain their typed diagnostic at the worker boundary rather than becoming a generic internal error. These are serialized-data bounds, not a claim of a 64 MiB process-memory ceiling.

Cache-hit jobs may reference an artifact published by another job in the same project/input snapshot; the stored artifact metadata must match exactly. This reuses the immutable artifact rather than republishing its bytes. Unpublished/forged handles, foreign snapshots, and transitions out of cancelled or other terminal states remain rejected.

`src/project/cache/` stores versioned `application/vnd.open-decomp.function+json` artifacts with the full decompilation envelope and an internal semantic catalog. Type sizes/offsets and evidence addresses use explicit hexadecimal codecs. Full artifacts are limited to 16 MiB; catalog reconstruction reads at most 128 artifacts / 32 MiB and requires the exact current revision and current component versions. Payload identity, target, metadata, type dependencies and evidence closure are validated before use. `findAnalysisArtifacts` pages snapshot-bound indexed identities; worker-only `readArtifactBytes` validates the exact published handle and hash. Response sizing precedes atomic artifact/index/completed-job publication; no cancellable checkpoint follows durable success.

Cached decompilation payloads additionally validate `emission.language === identity.options.emitter` and `emission.emitter_version === identity.versions.emitter`. A current project revision alone does not authorize a stale component composition or a different selected emitter. The full-target pipeline/version lookup rejects unregistered format/ISA/ABI combinations; it does not infer them from the host.

### Analysis cache and persisted callee summaries

Store schema 6 adds `native_summaries(scope, function_id, revision, seq, allowance, work, bytes, digest, payload)` (migration 5→6 creates it; schemas 1–5 still migrate transactionally; an older application cannot open a schema-6 project). Prepared native callee units (`source-facts.ts`, `PreparedUnitEntry`) are the largest cold cost of a decompilation, and the in-process `WeakMap` that reuses them is lost with every CLI process. The persisted tier sits behind it and obeys exactly the same contract: a unit is stored only when `reusablePreparation` holds (no limit hit, no reason, complete call analysis), together with the work it charged, the smallest allowance under which preparing it provably returns it, and the ordered dependency reads (`TracedRead`) it made. A reuse still requires `allowance ≥ stored allowance`, the instruction/block/node capacities and `fits(work, reads)`, then charges the same work and replays the same reads in the same order as preparing would, so a result and later budgets never depend on what an earlier process prepared. The fresh preparation path is untouched; a stored unit is only an input to the existing reuse check.

- **Identity.** `scope` is the digest of the format, the project **revision**, image SHA-256, selected slice, target, pipeline component versions, lifter, ABI and the supplied native type records; the row key is `(scope, function_id)`. The revision is part of the key because prepared evidence embeds it (evidence IDs and `revision` fields), so a unit prepared at another revision is not the unit preparing would return now; an annotation or any other revision change therefore invalidates every stored unit, and the next write drops the superseded rows. A row is authentic only for exactly its identity: `digest` is SHA-256 over scope, function, revision and the compressed payload, so a swapped, moved or damaged row is a miss (and replaced when the function is prepared again), never served.
- **Validation.** Before use the payload envelope is schema-checked, its identity fields must equal the request's, dependency targets must resolve in the current function list, and `verifyTracedReads` re-reads every stored dependency read from the project at the current revision (selector well formed, key = digest of the selector, fingerprint equal to the store's value now). Any mismatch is a miss and the unit is prepared normally. Verification never charges the request (only preparing's charges are replayed) and memoizes verified reads per store/revision, so units sharing proof/type/function closures verify each read once. Callee units whose dependencies changed (or whose trace cannot be replayed) fall back to preparing, exactly as in process.
- **Encoding and bound.** Payloads use the store encoding extended for analysis results (`encodeStoredGraph`: `Map`, bigint, object identity so aliased substructure such as `types.calls`/`analysis` and copy-on-write stack memory stays aliased, and string interning of identifiers), then Brotli quality 4, about 5× smaller than the raw JSON. A unit of prepared size above 8,192 (instructions + IR nodes + evidence + traced reads) is not stored: encoding it costs more on the first run than a later reuse returns (see `PERFORMANCE.md`). A unit that cannot be encoded exactly (non-plain values, over the 128 MiB / 12 M-node graph bound) or is larger than 16 MiB compressed is simply not stored. The per-project cap is 64 MiB of compressed payload (`DEFAULT_NATIVE_SUMMARY_BYTES`); past it the oldest revision, then the oldest write (`seq`), is evicted first, deterministically, in the same transaction.
- **Writes.** Hits write nothing. Units prepared by a request are queued in memory (at most 8 MiB before an early flush) and written in the request's existing transaction (`publishArtifact`), or, when the request publishes nothing (`types`, `export` helpers, failures), in one batched transaction at the end of the request and at store close. A failed cache write never fails a request.
- **Result-cache hits** validate each stored payload once: the payload bytes are verified against the stored artifact hash on every hit, parsed once (and memoized by that hash for the process, 16 MiB bound; damaged bytes are still rejected on every hit), and not re-parsed by `validateComputation`, the response wrapper, the handler, the worker runtime or the host (results that the producing code has already schema-validated are marked and not parsed again). Every store-dependent check (snapshot/image/target/function, type and proof closure, catalog trust, readset) still runs on each hit.

`--no-analysis-cache` (CLI `functions/decompile/export/types`, `mcp start`, `openBinary({ analysisCache: false })`, `WorkerPoolOptions.analysis_cache`) is a trusted host setting, not a tool-request field. It disables every read and write of derived analysis: `findArtifact`, reuse candidates, `publishArtifact`, `native_summaries` and the in-process unit cache. The dependency collector still runs so work charges, and therefore results, are identical. Imports, indexes, annotations and jobs persist. A response that has to be delivered by artifact is published as a **transient** artifact (`publishTransientArtifact`: held in the owning worker's memory, newest within 64 MiB, readable like a published one, never indexed or written). Annotation catalogs and the investigation view read only what earlier cache-enabled runs published.

ABI profiles own register preservation, unknown-call clobbers, stack arguments/alignment, Windows shadow space, variadic/aggregate classification and LP64/LLP64 differences. Decoder flow deliberately separates unknown transfer from proven trap. Discovery can consume flow/register metadata without a lifter; formatting is never semantics.

`AbiSignature.parameters: null` means unknown count, not zero arguments. Omitted convention/prototype flags mean the ordinary prototyped C ABI; unsupported conventions and nontrivial aggregates are explicit. ABI classifiers apply supported C default promotions to anonymous source arguments. Stack locations are callee-entry-SP-relative; `stack_bytes` excludes a pushed return address and caller-chosen indirect-object storage. A partial layout's stack allocation is only a known-prefix lower bound. Recovered source structures may retain known sizes/fields with `alignment: null`; resolved ABI aggregate layouts still require established alignment.

Discovery returns shared `FunctionGraph` records consumed directly by lifters; no lifter rebuilds a separate discovery graph from assembly text. Its `complete` state describes seeded traversal, never proof that every function exists in the index. Direct calls are references rather than intraprocedural successors. Unwind coverage is a region, not a single-function ownership claim: Mach-O compact unwind can coalesce adjacent functions. Debug recovery accepts supplied bytes only, requires a host-owned artifact identity for external evidence, and validates UUID/CPU/subtype/content pins without opening referenced source paths.

## Recovered types and navigation implementations

`src/analysis/types/` consumes SSA plus explicit ABI, debug, library and annotation evidence without rewriting machine IR. Associations retain source status and exact machine/source bit ranges. Observed memory shapes preserve signed, machine-width-wrapped offsets, access widths, alias/escape uncertainty and dynamic strides; their observed extent is not an inferred object size. Declared type and field IDs are valid subjects; a function-anchored type annotation declares a type in scope rather than assigning the function a scalar machine type. Conflicting declarations remain alternatives. A supplied call declaration matches both the exact call node and contract ID, preserving source provenance without leaking a call-local assertion to another call. Retractions recompute from the requested snapshot instead of retaining prior conclusions.

Pointer evidence (`src/analysis/types/pointers.ts`, `recoverPointerEvidence`) runs once per decompilation after local, callee-summary (`refineMemoryShapes`) and image types (`recoverImageTypes`), so declared prototype parameters, library results (allocators included), transferred callee shapes and image flows are already associations. A whole 64-bit value, or each exact register cell of one, holds an address when it is dereferenced (the load/store address or its affine base within ±64 KiB, so `table + i` never makes the index a pointer), carries a declared or observed pointer association, is `pointer ± integer` (`pointer − pointer` is an integer; a variable subtrahend counts only once every other rule settled), is a same-width copy, phi or select of a pointer, or is compared with a pointer. Two integers compared, an integer used in arithmetic and constants never become pointers; stack addresses stay frame storage. Each member gets one analysis-candidate `void *` association with its rule (`pointer-evidence` evidence); a member reached only from pointers to one scalar element by whole-element steps also gets that element pointer (C typing of `p ± k`). Projection (`src/reconstruction/source-types.ts`) resolves alternatives by weight instead of dropping them: a declaration beats analysis except that a declared `void *` is refined by an observed object pointer; an object pointer beats the bare address; equal or nested observed layouts merge into the widest; unrelated views and values conflicted only through a layout keep the bare address their dereferences prove. Overlapping constant/strided accesses of one view compete by access count (then lower offset, narrower width): the layout keeps the heavier member, only the losing member is conflicted and its accesses keep explicit casts; an overlap with a dynamically indexed access still conflicts the whole view. The source view spells an analysis `void *` byte-addressed (`uint8_t*`, `pointer[uint8_t]`; presentation `byte_addressed_pointer`), so `p + k` and `*(T *)(p + k)` are exact byte arithmetic; integer uses of a pointer print `(uintptr_t)p`. On AAPCS64 the hidden-result register (x8) read at entry and stored through anchors the function's own `return` role, so its object is named `<function>_ret`. Library allocators carry their header `alloc_size` parameters (catalog `allocates`); a call whose size arguments are constants gives its whole result value a fresh object of that byte size (`TypeRecoveryResult.allocations`), which sizes the memory shape on that value (`MemoryShape.allocation`, structure `size`) only when every constant-displacement access lies inside it, and names its image class `<function>_alloc_0x<size>` (ranked after argument/result roles, before stack slots). `applyImageTypes` also types every value of the selected body that flows at displacement zero into a class some view dereferences, so caller arguments and call results become pointers without a callee-summary transfer; pointer evidence keeps one object pointer type through exact copies, phis and selects whose other sources are null, and rebuilds a whole value from register cells that each carry the pointer's bits at their own position (concat parts or narrow extracts), keeping the declared type when every cell carries the same one; `x | 0`, `x ^ 0`, `x ± 0` and `x & ~0` are exact copies. An object passed unchanged (displacement zero) where an established declaration expects a pointer records that declared type (`ImageTypeObject.declared`); it confirms the object's argument/result flows like a dereference, and a class with no observed members but one declared pointer type binds flowing caller values to that type (integer declarations prove nothing). Register cells of a whole that carries an object pointer type carry it too at their offsets, so formals built from cells project it. Source-view stack reloads forwarded to exactly one stored value (`forwarded_reloads`) contribute their type evidence to that value. Debug recovery reports `undecoded` when debug data exists that it did not decode; only then is type recovery partial and local types withheld, since unread declarations could contradict them. An ELF image without `.debug_*`/`.zdebug_*` sections keeps debug status `partial` (DWARF recovery stays explicitly unavailable and the analysis coverage partial) but hides no declaration, so its local types are used.

Image types (`src/analysis/types/image-types.ts`, `src/service/analysis/image-types.ts`) give structure types one image-wide identity. Each function contributes its local object views: memory shapes at displacement zero plus pointer values at exact flows — integer argument registers on entry and at direct calls, the result register at returns and direct calls, entry-SP-relative stack addresses. A bounded, deterministic exploration (12 neighbor bodies, 4 callers per flow, two pointee hops) loads the callees and callers of the selected function's flows through the shared native-unit cache. Views unify (Steensgaard-style; members holding unified pointees unify their pointees) only through flows the callee itself confirms by dereferencing, forwarding or returning the value, so a stale caller register joins nothing. Overlapping incompatible members refuse the union and stay separate classes with recorded conflicts. Classes carry two names. `ImageTypeClass.name` is metadata: the first anchor, from the lowest-address function owning a flow (`OpenFiles_arg0`, `X_ret`, `X_local_40`, pointees `X_arg0_f20`, private views `X_objN`). `ImageTypeClass.label` is the identifier printed everywhere, `struct_<6 hex>`: a digest of the class name (so exactly the classes that shared a name share a label), the same scheme as layout-digest names, so it names no function and is the same in every function's text and in both dialects; classes of one solution whose digests collide extend by two hex digits (`imageTypeLabels`), and a layout-digest name never reuses a reserved image label. The types view and `types.h` print the anchor as a `/* first seen: setSectorSize_arg0; ... */` comment on the declaration; function texts do not. A class with an unexplored flow — exploration cut, absent callee body, or an image reference index that is not complete — is `bounded` and its anchor name carries a 4-hex layout digest, so one printed name never denotes two layouts. The selected function declares the merged layout of every class it has a view of (a pointee class it never dereferences is declared by name only; its layout is in the image types): its own members keep their IDs and types; other members are added where they do not overlap, an unbounded indexed member before others keeps only its first element (indexed accesses stay explicit), and a member another view proves to hold an object pointer becomes that pointer. Single-view private layouts keep layout-digest names (`struct_3fa2c1`), shared by equal layouts. A loop-carried byte offset `c + k*s` beside a lockstep 0-based counter `k` (strength-reduced `a[k].f`) gives the access a constant element stride and the counter as its index, rendered `p->f_20[k].f_8`. `binary_info` view `types` (CLI `open-decomp types`, API `types()` / `typeDeclarations()`) analyzes every function body within the budget and prints all non-private classes as C declarations (`partial` when bodies remain).

Integer and floating accesses of the same bytes (`ObservedField.float`, `src/analysis/types/index.ts`): a 32/64-bit load whose every consumer is an exact same-width IEEE reinterpretation (or a float/vector register binding; register snapshots of loads, stores and opaque effects are not consumers), or a store of a reinterpreted float or float value, is a floating access; every other access is an integer access. Non-stack accesses get one field per kind (the kind is part of the field ID), and accesses of one offset and width never conflict across kinds, so `buildMemoryShape` declares both members (`field_10`, `field_10_f`); other widths or partial overlaps keep the `overlapping_accesses` conflict and the explicit cast at the losing access. Image types treat the two kinds as one compatible member and merge both into the class layout (`sameMember`, `layout` in `src/service/analysis/image-types.ts`). `SourceStructs.layout` accepts exactly this overlap (scalar members of one offset and size, one integer then one floating, no declared member names) as the two members of an anonymous union and records the `struct_member_overlay` presentation rule with an ABI requirement (reading one member after writing the other reinterprets the same little-endian bytes, C11 type punning; neither representation has trap values, so negative zero, NaN payloads and all-ones patterns are unchanged). A function declares only the members its text uses, as `union { uint64_t field_0x10; double field_0x10_f; };` when both are used; the floating member is named `field_0x<offset>_f` whenever the layout has an integer sibling. The renderer selects the member of the printed access's kind (integer, or a float lvalue for `float_accesses`) and keeps the explicit cast when the layout has no member of that kind. Python-like prints no structure declarations or members: its `memory.u64[...]` and `memory.f64[...]` views already name the access kind. The header (`types.h`) declares the same union.

`src/project/annotations/` validates names, notes, type declarations and signatures against durable subjects or a trusted, project/revision-bound semantic catalog. A batch commits annotations, assertion evidence and an optional synchronous job-completion hook atomically; cancellation or a hook failure rolls everything back. The hook receives prepared proof bodies so the complete response can be validated before commit without reading an uncommitted future snapshot. Active entity-filtered views retain local alternatives and reachable type dependencies, not unrelated declarations from other functions. User/LLM assertions never become immutable type/signature facts. Retraction, removal and stale revisions remain distinct.

`src/emitters/model.ts` owns neutral `EmissionInput` / `EmissionResult`, also exported at the package root. Inputs contain a structured function with optional recovered types, resolved display names, active notes and native `SourceEvidence`. Source evidence carries the selected target ABI, bounded native-callee observations, exact symbolic/literal addresses and proven contextual argument counts. Results contain emission, diagnostics, mapping coverage and stable-identity identifier records. The root exposes `CEmitter` / `emitC` / `C_EMITTER_VERSION` and `PythonLikeEmitter` / `emitPythonLike` / `PYTHON_LIKE_EMITTER_VERSION`.

The emission wire form is compact and canonical. `emission.ids` (entity identities), `emission.evidence` (proof identities) and `emission.ranges` (binary ranges) are duplicate-free per-emission tables in first-use order. Mappings, inferences, requirements and requirement sites cite them by index: `semantic_refs`/`subject_refs`/`instruction_refs` index `ids`, `evidence_refs` indexes `evidence`, `range_refs` indexes `ranges`. A mapping's `semantic_refs[0]` is its mapped statement. `emission.review` names the one `function_get` metadata review route for every inference subject (`subject_id = ids[subject_refs[0]]`). The schema rejects out-of-table references and duplicate table entries. The renderer interns while writing, so each identity/proof/range is serialized and byte-charged once; the analysis catalog reads proof closure seeds directly from `emission.evidence`. `expandEmission` (core and `open-decomp/api`) returns a string-identity view with the original `statement_id`/`semantic_ids`/`subject_ids`/`instruction_ids`/`evidence_ids`/`ranges` fields; it is a view, not a second wire form. Published analysis artifacts use format version 2.

`src/reconstruction/` and the shared renderer produce both dialects from one source projection. The native pipeline supplies source evidence: physical register slices become ABI arguments/results, private stack spills become forwarded values or scalar locals, and unchanged phi/clobber plumbing disappears before rendering. Inferred interfaces are labeled and never promoted into established source signatures. Escapes, overlaps and uninitialized paths retain shared storage; unknown calls and live non-result clobbers remain explicit. Pure synthetic definitions are bounded and materialized at their original SSA definition sites. C-like casts and Python-like width helpers preserve integer storage; floating/vector helpers retain exact payload semantics. Source-level behavior observes ABI-visible values and ordered external effects, not scratch-register snapshots at every fault. Internal callers without native source evidence retain machine-boundary rendering. Names/notes are escaped, and final-dialect UTF-16 mappings resolve synthesized values to original catalogued subjects.

Structuring (`src/presentation/index.ts`, `structure/8`) is an iterative region collapse over the whole CFG, shared by both dialects and both views. Loops are cyclic strongly connected components; a component with several entries (irreducible) loops at the entry first in reverse postorder and its other entries stay labeled transfers into the loop body (exit flags are refused for a loop entered that way). A loop's follow is the exit leaving the fewest labeled exits (then not a small tail, then a single bottom test's exit only the loop enters, so the loop prints as `do-while` with the code after it; then fewer tails, the header's exit, a latch's), and acyclic blocks entered only from its body join the body, so their edges to the follow are breaks. Inside the function and each loop body, nodes collapse by priority: a node whose structured successors are one node entered only from it becomes a sequence (a switch's last case target stays its arm); a successor entered by one arm becomes that arm's owned body when it has no structured exit (if-no-exit), when every other successor is its sole exit or a clause leaving only for it (proper if, if/else, switch cases; several case arms alone entering one target give it to the first), or when it is a short-circuit operand sharing an exit with the node; a single-entry successor of a nested jump extends that jump's arm body. A node all of whose incoming edges are labeled follows the closest node before it that does not fall through. In a loop body, a branch whose other arm repeats the loop owns a terminal exit path as its arm instead of being followed by it, so the repeat edge stays the body's lexical end (bottom tests and `for` loops). When nothing applies, the edge group between two nodes is labeled whose removal unblocks the most collapses. Edges into small function tails (straight-line chains of at most four blocks with at most four stores/calls each, ending in a return, trap, unknown or indirect transfer) are labeled first; the source view copies them as early returns (return splitting). Otherwise every candidate group is ranked by whether its target is a small tail, whether labeling leaves the target without structured entry (an orphan, ranked worse), and a one-step lookahead (collapses enabled at the source, its predecessors and the target's remaining predecessors); the best eight are simulated on a copy, and their key is the tail rank, the orphan rank, the collapses the simulation enables, whether the target would then become a nested arm body (worse), then the one-step key, group size, number of sources and reverse postorder, so ties keep the edge from a join's latest predecessor as its fallthrough. Selection work is bounded by `64 * (blocks + edges) + 20000`; past it, the remaining nodes of a scope follow each other in dependency order. Every CFG edge keeps exactly one transfer with its own copies and effect (structured edges `next`, labeled `goto`, loop edges `break`/`continue`); `test/presentation/structuring.test.ts` checks this on every case and that 300 random reducible programs with only innermost break/continue structure without any label. The former source-view repairs `loop_exit_layout`, `loop_exit_merge` and `terminal_block_placement` are subsumed and deleted. Labeled targets stay after their sources, below. Printed-goto counts per structurer round, with their losses, are in docs/PERFORMANCE.md ("Readability roadmap round"); no per-function goto guarantee holds, and a later round can print more gotos in one function while printing fewer overall.

Labeled transfers stay forward. Every labeled edge, and every exit of a loop to a target other than its follow, is recorded as pending on its target; a target is absorbed (sequence, arm or append) or placed after a non-falling-through node only by a node already holding every pending source, at a position after them (arms of one branch are unordered, since the source view may print either first), and the fallback linearization orders by pending labels as well as structured edges. `test/presentation/structuring.test.ts` checks on 300 random acyclic graphs with shared joins that every labeled transfer of a reachable block jumps forward in text order; on the structure-gotos sample the only backward gotos left are two jumps to a loop header from inside irreducible or nested loops (counts in docs/PERFORMANCE.md).

Source-view return-tail copies still remove gotos the structurer labels and are kept: on the structure-gotos sample (`structure/6`, 214 functions) the build printed 200 gotos, 362 without tail copies. Run-once blocks (`do { } while (0)`, Python-like `while True:` … `break`) are not printed in either dialect (readability roadmap 2, G6); a forward edge the structurer labels prints as `goto` to its forward label (the same sample printed 333 gotos without them, 200 with them). Small acyclic return, tail-call or trap tails (at most four blocks, four assignments/loads/stores/calls and four copies per block) may be copied onto an exiting edge; each path executes its original effects exactly once and in order. Transfers to the nearest loop's header/successor use `continue`/`break` regardless of an obsolete outer-loop annotation (`loop_transfer_target` records this normalization; exhausted record capacity retains the original labeled edge). The former copying of tails lexically between a goto and its target onto every incoming edge (`goto_path_tail_duplication`) changed no printed goto on that sample with this structurer or the previous one and is deleted. An exit to an enclosing loop's exact successor may use one boolean and immediate propagation guards after intervening loops/switches (`multi_level_loop_exit`); an edge keeps the boolean only if every guard it passes decides something, i.e. some printed edge (or a flagged exit to that loop's own successor) reaches the guard with the flag clear and the guard is not followed by a silent `break` leaving the same scope, otherwise it prints as a `goto` to the continuation's label. Both rules are exercised by hand-laid-out regions in `test/emitters/c/source-control.test.ts`; the structurer's own layouts on the checked functions (SQLite `allocateBtreePage`, `whereLoopAddBtree`, `btreeBeginTrans`, `sqlite3BtreeOpen`; brotli `main`) produce neither case since breakable blocks are gone, and the two flags left (`whereLoopAddBtreeIndex`, `main`) are tested after inner loops that also exit normally. Control validation checks the complete scope chain, flag initialization and emitted guards. Entries bypassing initialization and irreducible sibling cycles keep explicit gotos. After loop forms, a short-circuit test whose operands all leave for the next statement X, entered by those edges only, prints as `if (a && b) {…} else {X}`, or `if (a || b) {X} else {…}` when every operand leaves on its true arm (`shared_condition_arm`): X becomes the `shared` body of the head's leaving arm and the other operands' leaving arms `join` it (emitted edge kind `shared-arm`). Operands are copy-free tests that print nothing but their condition, with only silent copy-free jumps between them; the last operand's staying edge may carry copies. Both control validators accept a `shared-arm` edge only from an operand on the structural chain of its head (the head's other arm, then the last element after jumps of each staying arm) and require it to reach the shared body's first block. An else arm may hold another such condition. The rewrite is kept only when an edge leaving the remaining branch now falls through, and it is tried before breakable blocks. Afterwards, a remaining forward goto to a later element of an enclosing statement list becomes `break` out of a block run once (`breakable_block`: C `do { } while (0)`, Python-like `while True:` ending in `break`) that holds the elements from the goto up to its target. The block starts at a plain block no inner edge re-enters, nothing continues it (both control validators reject a `continue` that would target it, and its body falls through to its follow), and a wrap is kept only when the number of printed gotos drops, so outer breaks and continues are never turned into gotos; edges crossing it to an outer loop's continuation use the multi-level exit flag. Both searches charge at most a sixteenth of the remaining work and keep their best layout when it runs out. Remaining gotos are forward jumps out of acyclic regions (joins entered from arms of different branches), loop exits to a non-continuation target that no block run once can reach without crossing a loop, edges inside C `switch` arms, and backward jumps to loop headers from irreducible or nested loops. Exhausted presentation capacity keeps the original layout; checked output is unchanged. The source-backed SQLite 3.54.0 `strnicmp` regression evaluates both emitted dialects over 30 boundary cases without executing analyzed code.

Source presentation coalesces noninterfering unsigned widening copies with phi
storage, retaining the original narrow definition/read conversions and choosing
the widest declaration. Widening copies are retained `zero_extend` assignments and
edge copies whose source is an inline zero extension of a variable (`v = ~arg0;`
then `p = (uint64_t)v` on each edge into a 64-bit phi prints `p = ~arg0;` with no
edge copies). The edge-copy form applies only when those extensions are the
narrow variable's only reads, so the merge never adds a conversion at a read; only
when the narrow variable is at least 32 bits wide (a narrower unsigned value
promotes to signed `int`, so its definition into wider storage would print one);
and only when the narrow variable carries no role name (`accumulator`, `index`, ...)
that the phi lacks. A dropped widening edge copy is validated under the stated
invariant that the class storage holds exactly the zero extension of its live
narrow member: that member's definition stores its narrow value with the narrow
conversion (`(uint16_t)~(uint16_t)x`, never a promoted negative `int`), and no
other member is defined while it is live. Signed extensions and truncations keep
separate storage. An `if` or `switch` arm whose edge and blocks then print nothing
is dropped like an arm without a body (`branch_layout`), in both dialects.

These widening pairs are part of one variable partition (`partitionVariables`,
`src/emitters/source-control.ts`; readability roadmap 2, G1), computed before
source control planning from exact SSA live-range interference: two values
conflict when one is live where the other is defined (values defined together,
block parameters bound simultaneously on an edge and loop-carried liveness
included; a source at a definition equal to it, a same-width alias or a plain
zero extension, does not). In order it joins each block parameter with the
variables its incoming edge arguments read (Ghidra `mergeMarker`), each retained
same-width alias or widening assignment with its source, each definition with an
operand variable of the same presented type (in-place update `y = f(x)` prints
`x = f(x)`; Ghidra `mergeAdjacent`), and values one machine register holds at
block boundaries with the same presented type (register reuse; Ghidra
`mergeByDatatype` kept to one register). An interfering pair keeps its explicit
edge copy; an edge copy or alias statement inside one variable prints nothing.
Members share one machine storage type and FP presentation. Names are chosen per
variable and never decide a merge. Presented types may differ when every member
is an integer spelled as a pointer or an integer of its own width: a formal or
other rigid definition (call result, register output) fixes the declared type,
otherwise the widest member of the most-read spelling declares it, and a member
presented differently is converted exactly at its definition
(`address = (uint32_t*)*(uint64_t *)0x3000;`) and read through the variable's
type. The `variable_partition` presentation record names the members;
simultaneous edge copies still pass the move validator, and `planLayout`,
loop-form and flag planning read every edge's copy count from the partition
(`edgeCopies`). A `for` header whose induction variable shares the entry value's
variable prints an empty init clause. The interference matrix is optional work
(at most 1/8 of the remaining budget); past it no values share a variable.
Evidence (2026-10-21, 25-function subset of the structure sample: 12 SQLite, 10
brotli, 3 ELF fixtures): C local declarations 429 -> 342 and plain `x = y;` /
`x = (T)y;` copies 120 -> 61 (Python-like 435 -> 347 and 104 -> 43), gotos and
loop forms unchanged; `whereLoopAddBtree` no longer prints its six `address_32 =
(uint8_t*)address_22; goto label_169;` arms (674 -> 605 lines). Counted work of a
fresh `decompile`: brotli `main` 8,013,804 -> 7,967,605, SQLite
`whereLoopAddBtreeIndex` 9,638,349 -> 9,564,098.

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

`repeated_operation` prints a cheap pure integer operation of one printed
variable (add, subtract, bitwise or shift with a constant; negation, complement,
integer conversion) at each occurrence in its single reader instead of a
temporary, at most four occurrences: `t = x >> 1; x = c ? t : t ^ k` becomes
`x = c ? x >> 1 : (x >> 1) ^ k`. The reader is one statement, test or edge copy
(the copy only through one consumer); a value also read by a second statement
or another copy stays a variable. Liveness counts every occurrence as a read at
the reader.

`single_use_call_inlining` prints a call whose one live result is read once by
the next printed statement, return, `if` test or `switch` selector as that
reader's operand (`if (fseek(stream, 0, 2) == 0)`). Its text must occur exactly
once in the reader's first printed line: an `if` header before its arms and edge
copies. A do-while test printed after its repeat copies, or any other layout that
separates the call from its reader, re-renders with that call as a statement;
after four such retries every call prints as a statement. Every attempt renders
from one reconstruction (computed and validated once per emission); each starts
from its own fork of the local-validation session state reconstruction left, so
a failed attempt's records never reach the published result. A load addressed
through the call's own result is sequenced after it and may share the reader
(`strerror(*__error())`); an independent load keeps the call a statement.
Measured on the Homebrew brotli 1.2.0 CLI export (64 functions): 131,052 →
126,589 bytes, `main` 1,688 → 1,592 lines; one do-while test call
(`BrotliEncoderIsFinished`) stays a statement through the retry.

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

`else_if` prints an `else` arm that is exactly one `if` statement (no statement,
definition, label, note or edge copy before or after it; the arm's own `else`
chain included) as `} else if (B) {` (Python-like `elif B:`) at the outer depth,
recursively for chains. The decision follows what the arm prints: an `if` whose
layout also prints a sibling after it (an early-exit arm followed by the other
arm), a loop test or a shared-arm condition keeps the nested `else` block. Only
braces and indentation change; the checked view keeps the nested form.

The source view structures twice (readability roadmap 2, G2). The service's
first layout skips the goto search (`provisional`); after the variable partition
the renderer structures the same CFG again with block contents
(`short_circuit_structure`): Ghidra's `collapseConditions` runs first, joining a
branch entered only from one condition that prints its test alone or exactly one
statement the test reads (`comma_condition`: an assignment, load or single-result
call; C `(x = f(), x != 0)` or `(x = f()) != 0`, Python-like only
`(x := f()) != 0`), and the condition's exits to one clause count as one edge so
the clause may become its arm. Operand and exit edges must be copy-free. Branch
edges that copy only constants their small return tail returns are labeled
first, so the tail is copied onto them (`return k`). `joined_exit_condition`
prints `if (a) goto L; if ((x = f()) == 0) goto L;` as one
`if (a || (x = f()) == 0) goto L;` when the exits are copy-free and leave by the
same jump for the same target. The comma operator is a sequence point and `||`
evaluates left to right, so each statement runs exactly when its test runs;
nothing is hoisted. Checked rendering is unchanged.

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
unless a proven role supplies a better name. Promotion is decided per slot, not
per frame (`src/reconstruction/source-stack.ts`). Each frame address that
escapes (a call argument or open argument register, a store to memory outside
the private frame, a result, an indirect exit, an access at unknown offset)
contributes the lowest entry-SP offset it can take: exact offsets, constant
steps, nonnegative (zero-extended, masked or shifted) index addends, cell halves,
phis and exact spill/reload copies keep that bound; signed or other arithmetic,
and cycles that keep lowering it, lose it. A phi proven to be one frame address on
every incoming edge prints as that address, so no edge copy assigns it. The stack grows downward, so an object
designated by an escaped pointer extends toward the entry SP and the caller
frame: bytes at or above the lowest escaped offset stay explicit frame memory
(members of the frame object, below), slots wholly below it promote under the recorded
`frame_object_base` requirement (code reached through an escaped address never
steps below it; `container_of` or negative indexing from an interior pointer is
outside this premise). A frame address stored into bytes an escaped address
reaches escapes too. No current fact bounds an escaped object's extent
(library contracts carry no size relation), so every escape covers everything
above its base: when the lowest-addressed object escapes, as in optimized frames
that place aggregates below scalars (SQLite `renameColumnFunc`, brotli `main`),
all slots above it stay explicit; a 21-function SQLite/brotli sample of the LLM task set
showed no change. Unknown effects and unbounded escapes keep the whole frame
explicit. Accesses straddling a slot's end, outgoing argument slots and volatile
accesses stay explicit. Same-width accesses of differing types (an O0
integer/IEEE pun through memory) forward a bitcast of the reaching stored value;
when the reaching values differ, the slot is one local of its stores' common type
(else its first access's type) and every other-typed 32/64-bit access converts by
exact bit reinterpretation (C `__od_bitcast_*` under `c_bitcast`, Python-like
`cast_bitcast`). Narrower integer loads and stores wholly inside a whole-slot
integer slot (`wide_slot_parts`) are tracked per byte: each load forwards the
bytes its reaching stores wrote, as a bit range of one stored value or adjacent
stored pieces concatenated low to high (two 32-bit halves building a 64-bit slot,
a 16-bit store inside a 64-bit value). A slot whose reaching bytes differ by path
keeps its memory form; parts never become a scalar local.
External-pointer stores are disjoint from an activation's nonescaping private
frame only under the recorded `frame_private_to_activation` / `abi_conformance`
requirement; the original alias facts remain in checked output. Open-arity
calls do not block fresh slots accessed only after those calls. Any slot access
from which an open call is reachable remains possible argument storage, except
above the call's bounded argument area (`open_call_argument_area`): a call's
stack arguments form one contiguous callee-owned area from its callee-entry SP
(above a pushed return address) that the callee may overwrite, so a slot written
before the call and read back after it, with no write, call or unknown effect
between, lies above that area, and so does every slot at or above it. A
possible argument slot keeps its stores in memory, but `argument_slot_reload`
forwards each reload that reads the one store reaching it on every path with no
call, unknown effect or other write between; an O0 argument spill reloaded
before an open call reads as the argument. A spill rewritten in between keeps
its local or memory form. Loop-invariant entry stores may forward through loops.
Initialized private-local reads may inline across unrelated effects, never
across a write to the same local. Byte-path validation remains independent,
including its explicit loop/path bounds; exhausted presentation capacity retains
the explicit form. The checked view keeps the frame-wide conservative gate.

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
visible, and unknown instructions retain `opaque_effect(...)`. A call printed as
a short-circuit comma operand has its `call_effects` record admitted when the
operand is planned, with the same scope and contract the printed call asks for:
a call whose record is refused never becomes a comma operand, so its boundary
statement never lands inside a test. Checked rendering is unchanged.

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
Copies keep the original transfer objects and the renderer prints one action
per transfer, so a copied jump (which falls into the copy of its target) must
also fall through at its home. When the home occurrence prints anything else (a
`break` out of the loop that holds the home, a goto), the labeled edge whose copy
holds that jump is refused and keeps its goto; refusal repeats until every
transfer prints one way (`planLayout`, `src/emitters/source-control.ts`).

Focused emitted-output regressions exercise nested loop/switch exits, edge-specific cyclic copies, guarded effects and faults, split-register joins and synthetic source-definition scope in both dialects and both source/machine modes. The four independent source-derived fixtures cover 544 observations; this is bounded regression evidence, not a whole-program equivalence proof.

Publication validates reconstructed ownership, actual rendered transfer destinations, edge-specific copies, emitted definition order/dominance, definite local initialization, incoming-storage identity and result width/bank consistency. Failures reject publication with `unavailable_semantics`, original statement identity, instruction address when available and evidence IDs. Independent counterexamples cover multi-exit misdirection, omitted phi copies, missing/branch-local synthesized definitions, private-frame invention and wrong-bank returns. These bounded invariants are not an equivalence proof: operation completion, semantic coverage and any future translation-validation status remain distinct.

Optional `emission.local_validation` records distinguish verified local fragments, unverified scope and rejected candidates. A pure-TypeScript reduced ordered BDD checker independently compares supported integer rewrites; symbolic checks compare actual sequential phi moves with simultaneous transfers, bounded private-byte paths with proposed scalar storage, and recorded rendered edges with original control. Source counterexamples preserve the original candidate; emitted move/control counterexamples prevent publication. Unknown operations, loop/path complexity and exhausted proof allowance stay unverified. One shared optional allowance is bounded by `min(8000, floor(actual remaining work / 64))`; outer cancellation/deadlines/limits still propagate. Thirty trusted-native emitted-output outcomes and independent carry, signed-shift, copy-order, storage and exit counterexamples passed. No external solver or whole-function equivalence claim is involved.

Optional `emission.inferences` explain parameters, type alternatives, signed operations, partial fields, data identities, calls and local rewrites. Each record retains original subjects, decoded instruction IDs, evidence, binary ranges and nonempty UTF-16 spans in the final output. Exact operation-site mappings distinguish an access from its declaration. Synthetic source values resolve to original subjects; annotations retain asserted, hypothetical, conflicting and retracted status rather than becoming established facts. Instruction provenance and raw disassembly remain accessible separately from pseudocode.

A type inference record carries every `association_ids` member whose assertion details (type, status, source, offsets, width, kind and display state) are exactly equal; its subjects, evidence, instruction/range references and output spans are the union of those members' individual records, so no subject or proof is dropped. Records are split before any wire bound is exceeded. Set-valued inference `evidence_refs`/`instruction_refs`/`range_refs` are in ascending table-index order; identical sets share one immutable array within a render.

Parameter roles distinguish observed source inputs, physical-register inputs and explicit entry-storage environment inputs; an entry-SP formal is not evidence of authored arity. Interpretation widths describe reconstructed IR, not necessarily a decoder operand or source declaration. Call constants expose exact unsigned bit patterns with explicit widths, without inventing signedness. Partial fields retain unknown bounds and observed callback targets; local checks retain their bounded scope and counterexamples. Metadata uses the same operation/output budget and cancellation as rendering, and omits evidence IDs when evidence was not requested. Five focused regressions and 12 public both-dialect observations cover these boundaries; they do not establish whole-function equivalence.

Optional `emission.requirements` localize assumptions, unresolved values/effects/calls/control and conflicts at original subjects and instruction-backed output spans. One function-level `fp_environment` explanation names every affected guard/operation and its original state epoch. Source-only `fp_environment_guard` presentation selects the supported edge of an exact lifter guard when its state is an entry value or call clobber, unchanged or carried through phis and bitcasts, there are no explicit environment writes, and the unsupported arm is exclusively owned. Transport acceptance is coinductive (a greatest fixpoint over the phi/bitcast web, so loop cycles through a call qualify): a member is accepted when each input is an entry/call epoch or an accepted member; one input of any other kind rejects the guards of the whole function. Each guard record lists the accepted transports its epoch passes through. This is conditional on the recorded requirement at **each** epoch, not proof that calls preserve FP state. Omitted guard/failure provenance maps to the top requirement comment; checked guards and ordered effects remain intact. Computed, loaded, known unsupported, or opaque-written control state retains explicit guards. An opaque effect that is the last statement of a block ending in an unresolved exit changes no recorded epoch (no modeled operation follows it) and does not retain them (`fp_terminal_effect`); an opaque effect elsewhere, such as an unsupported encoding inside the function, still does.

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

FP environment values (FPCR/MXCSR epochs: entry bindings, call clobbers, their
phis and the pure definitions between) that only omitted environment guards
demand print nothing: no `unknown_value` placeholder, local or edge copy
(`fp_unobserved_epoch` lists the hidden placeholders and phi destinations). A
mark pass decides it: a value of the web the omitted conditions reach is
observed when it has a use outside that web or an observed member reads it, so
cycles release too. The epoch stays in the requirement site and checked view.

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
callers are not exhaustively scanned. A self-recursive call is one of those
callers: its result demand counts only where it is _semantic_ (reached from a
load, store, call argument, branch, switch, indirect target or explicit return
value). Bits it only forwards to the function's own return-exit snapshot are
circular and gather no evidence; demand from other prepared callers still
counts in full, forwarded bits included. The inference explicitly records
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

The native dependency worklist loads bodies demand-first (each load at most a
quarter of the remaining optional work; no new body once half of the initial
allowance is spent). A requested call's arity relies only on its target's own
reads and, transitively, on the callees an unobserved entry argument may reach
(a callee-independent superset of `argument_reaching_calls`, probed once per
loaded body); a body whose own graph cannot close (unit coverage gaps, budget
truncation, context fallback) relies on none. That sub-closure loads first,
breadth-first; dependencies needed only for effects, results and shapes load
afterwards from whatever the reserve still allows and stay explicit reasons when
cut. Refinement then runs over strongly connected components callees
first: a non-recursive body is observed once against its finished callees, and
only recursive groups are seeded and iterated. Memory shapes are not transferred
along recursive edges (content-addressed shape evidence derived around a cycle
would be new every round and never converge). When the refinement share runs
out, finished components keep their facts and only unfinished ones (and their
callers) are cut with a `native interface refinement work limit` reason. A callee
summary cut by any bounded share is reported as a `resource_limit` diagnostic,
and a selected function left partial with such a diagnostic reports reason
`budget` instead of `unsupported_subset`.

Most open arities on SQLite are not budget cuts: an unobserved argument register
forwarded untouched to an indirect call (configuration function pointers in
`sqlite3Malloc`, `sqlite3_free`, mutex hooks) may be read by the unknown target,
so every caller that reaches it keeps `...`. Even a 10x budget does not close
them. Caller consensus would be sound for the source interface (when every call
site is known, registers no caller sets carry garbage at entry and are not source
parameters), but "every call site known" needs an image-wide escape proof that
existing block-local address recovery and partial discovery cannot give (on ARM64
a linear sweep for B/BL/ADR/ADRP to the callee or its page plus complete
chained-fixup relocations and export exclusion), exported functions have unknown
external callers, and internal hubs such as `sqlite3Malloc` receive their callers'
own forwarded registers, so consensus depends on the callers' arities in turn (a
coinductive caller/callee fixed point over every caller body). Proven mode
therefore never closes these lists. The opt-in `likely` mode (next section)
applies two measured, gated approximations of these ideas and marks every result.

### Inference mode (`likely`)

`options.inference` (`proven` by default; CLI `--inference`, MCP `options.inference`,
settings `decompile.inference`) is part of the cache identity, so `proven` and `likely`
results never share a row; `proven` output is byte-identical to a build without the option
(dev-loop texts compared file by file). In `likely` mode, source view, a heuristic may close
the open argument list of one direct call or direct tail transfer after its observed prefix
(the caller-prepared registers plus the callee's observed reads). The closure is
presentation only: the call keeps `argument_list_complete: false`, so storage escape,
requirement and stack analyses stay as conservative as in `proven` mode, a caller that wrote
outgoing stack bytes never closes (they may be arguments or Darwin variadic arguments), and
`arity_complete` in the call inference stays false.

Heuristics (`src/service/analysis/likely-arity.ts`):

- `callee_reads`: the callee's complete body reads exactly its observed argument registers
  once unobserved arguments forwarded into an indirect call or indirect tail are taken not to
  be read by the unknown target (every direct callee they reach is closed or itself
  qualifies), has no incoming stack parameters, no escaping incoming-stack address (not
  variadic), and the call site prepares nothing beyond those registers. `observeParameters`
  records the basis as `likely_closure` on the native interface (mode independent, never used
  by `proven`).
- `caller_consensus`: every discovered direct call site of the target (a function, or an
  import without a contract) prepares the same argument-register prefix, the callee's
  observed reads (when its body is known) lie inside it, and an empty prefix needs a known
  callee. Callers are loaded as native units under the request's optional-work share; a tail
  transfer abstains (it forwards the caller's registers), a site this scan cannot read (no
  owning function, unanalyzable caller, incomplete or capacity-limited unit) or more than 32
  caller functions leaves the list open, and an exhausted share is a `resource_limit`
  diagnostic. A caller that passes its own parameter register unchanged is not "prepared",
  so such sites disagree and the list stays open.

Each firing heuristic is recorded as a `guess` inference (`details.kind: "guess"`, status
`hypothesis`: call id, target, heuristics, `arity`, agreeing `sites`, `applied`). A
heuristic prints only if `LIKELY_GATE` says it passed the precision gate; a failing one
still records its guess with `applied: false` and leaves the text open. Printed guesses are
wrapped `likely_arity(f(a, b))` in both dialects, the C call declaration of the callee is
suffixed `/* likely */`, the file header states the marker once and the helper stays in the
emission metadata. Unsupported or unscored: indirect calls (callbacks), variadic callees,
callees reading incoming stack arguments and tail-call consensus voting.

Likely types. Four more heuristics (`src/service/analysis/likely-types.ts` for caller evidence,
`src/reconstruction/source-likely.ts` for the body) guess that an integer formal, or the
result, of the selected function is an address, only where every proven rule left it a plain
unsigned machine-width integer (never over a declared, pointer, narrowed, float or conflicting
type, a supplied signature, or an escaped-frame spill whose reloads this scan cannot attribute).
`caller_argument_pointer` / `caller_result_pointer`: every discovered direct caller passes a value
(or consumes a result) its own proven pointer evidence holds as an address; null constants
abstain; caller discovery and limits are those of `caller_consensus`. `indirect_call_target`: the
formal, through unchanged copies, is an indirect call or tail target. `opaque_word_formal`: the
formal's copies are only carried (call argument, store, return), never computed with (no
arithmetic, mask, narrowing, ordered or non-null comparison, switch, library-integer argument,
nor an argument narrower than the register). `carried_word_formal`: that, and null-tested or in
the first argument register. Each firing guess records `guess` inference with
`subject: "parameter_type" | "result_type"`, `ordinal`, `guessed_type: "pointer"`, heuristics,
`applied` and caller `sites`. An applied guess prints `likely_type(T)` around the declared type
of the formal or result (both dialects; the header states it once; connected locals inherit the
type) and types the formal `void *` (spelled as the existing untyped pointer); an unapplied one
leaves the proven text byte-for-byte. `LIKELY_GATE` (`src/core/inference.ts`) currently enables
`callee_reads` (arity) and `carried_word_formal` (types) only; `caller_consensus` measured 86.4%
on the larger corpus and is disabled. Measurements and the failing heuristics are in
docs/PERFORMANCE.md.
Proven mode is untouched by all of this.

Discovery ends intraprocedural flow at a direct call to a callable import whose
supported, unconflicted library declaration is noreturn (`libraryNoreturnCalls`;
weak, addend-adjusted and Swift-runtime imports excluded). The return address is
not followed — after a final `bl ___stack_chk_fail` it is the next function's
entry, formerly a `conflicting boundaries` gap — and the call block ends with a
`trap` edge whose derived evidence cites the import binding; lifters terminate it
as a trap instead of an unresolved continuation. The source view prints only the
call (C declares the callee `extern _Noreturn …`) when the call analysis
establishes the callee noreturn; the trap keeps a `noreturn_call_exit`
presentation record and header mapping, still terminates its region for
structuring, and the checked view prints the explicit `trap_exit`.

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

Source-only `indirect_tail_call`: an unresolved indirect branch (no proven table,
no discovery `tail_call` marker) is a tail call of its runtime target when the
exit SP is the entry SP, the target's expression cone (at most 128 values; loads
are leaves) has a non-constant leaf and holds no constant inside an executable
mapping (`adr` + table entry, or a destination that folds to a constant, stays
`indirect_exit`), no frame address escapes (the frame is released before
the transfer), and the return location holds the entry return address. With a
link register (ARM64) that is its unmodified entry value, or a reload of a slot
that qualifies as a `frame_save` with this exit included; the latter records an
`abi_conformance` requirement (callees never write the saved slot). With a pushed
return address (x86-64) no store may overlap those entry-SP bytes and no store may
have an unknown address. Accepted exits count as tail exits for frame saves and
print the indirect-call function-pointer spelling with the observed
argument-register prefix and an open list: `((R (*)(uint64_t, ...))target)(a)`
returned when the function has a result type R, else the call and a plain
`return;` (`function_pointer_call` record). The runtime target is no result
evidence, so a void-like interface stays void. The checked view keeps
`indirect_exit`.

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
value of the full width; the unprojected register outputs of one call or unknown
effect whose outputs of the root are integer cells that tile it from bit 0; or the
unchanged cells of another recombined phi, which is resolved as a fixpoint. An
instruction-output edge gives the instruction one whole output of the root and makes
its original cells slices of it: a source call prints one
`unknown_value("uint64_t", "call clobbers x0")` instead of the `x0_low32`/`x0_high32`
pair, and a physical call or unknown effect lists one boundary key
(`"arm64:x27:0:64"`). Adjacent cells of one such instruction that a concat reads
together outside any phi get the same whole output. A projected call result is a
definition, never an unprojected output: a callee result bound to `w0` stays the low
half of `x0` (`call_result | (uint64_t)high << 32`). A cell that range analysis
already folded to a constant (`value7 = 1` on every edge) still counts as a cell of
the group. When every edge writes one constant per cell, the group becomes one
whole-width parameter with one whole constant per edge (`0x100060ce8`, not
`value6 | value7 << 32`), and source-fact discovery also offers each such whole
constant as a candidate address, so function-pointer and global naming applies to it.
Each constant is proved on its own
edge by exact interpreter evaluation (a `bitvector` record: the cells' concatenation
equals the constant; no BDD allowance is spent). Otherwise a folded group needs some
edge that carries a wider value (corresponding slices of one value, or another
recombined group), and its other edges may be zero extensions or carried groups. Each
folded cell's slice on those edges must be a non-constant value, which the interval
fixed point over the reachable incoming copies proves equal to the folded constant,
or a constant equal to it. Unknown and instruction-output edges keep a folded group
split. `matrix_multi_exit` `-O2` (ELF/PE) keeps its sum below 0x10000 inside the loop,
and its accumulator prints as one `uint64_t` instead of `value0 | value1 << 32`;
`isDate` names its `sqlite3UpperToLower` table address (0x100132f08) instead of
reassembling it from `0x132f08` and an upper cell at each dereference; loops that
only zero-extend a 32-bit counter keep their cells. Other register banks
keep the complete-root rule with identical whole values or one instruction's whole
output, so a phi covering only part of a vector root (`isDate`'s `v0` double) keeps
its cells. Original SSA cells and transfers remain immutable;
source aliases extract slices from the new whole phi, preserving parallel copies
and full-width arithmetic carries. Independently written cells (for example a
partial write that preserves the other half), missing cells, differing whole
values, mismatched offsets and exhausted presentation-record capacity retain the
split form. A whole carried unchanged on an edge (its own loop edge, say) prints no
copy: publication validation accepts that edge only when the original edge copies
every cell aliased to a slice of the whole to itself and those cells cover all of its
bits (`sqlite3PagerSavepoint`, and `jsonTranslateTextToBlob` once its table proves,
were rejected before). The `register_cell_recombination` presentation record documents this
exact bitvector identity without an ABI assumption (its subjects include each
instruction whose whole output an edge uses, and a second scope covers joint reads
of one instruction's cells); checked output does not apply it.
`test/reconstruction/source-loop-cells.test.ts` executes both dialects against
independent oracles for a 32-bit-immediate-entered 64-bit loop variable, CRC-style
byte/24-bit lanes, an independently written-halves refusal and the `multi_exit`
loop (including its overflow path and a carry into the upper cell);
`test/reconstruction/source-cells.test.ts` executes phis fed by a call's clobbered
`x0` and `v0` cells and by a bound 32-bit result.

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

A return join of a narrow and a full-width write (`default: return a` sharing one
`ret` with an arm that writes `eax`/`w0` and then a 64-bit conditional move) leaves
the join exit with two phi cells of the result register. Without a declared
signature, every integer exit is first harmonized to the function width W, the
widest exit result. In the source view, an exit narrower than W that was bound from
the integer return location, and whose remaining changed cells of that root cover
exactly bits [narrow, W), returns the concatenation of its cells up to W instead of
a zero extension plus a `physical_return` overlay. This is bit-exact (the
concatenation is the register value) and needs no ABI premise; the
`exit_result_width` presentation record names the exit, its narrow result and the
dropped cells. W is never raised by this rule, so a function whose exits are all
narrow keeps its narrow type. The concatenation is a joint read of the phi cells,
so the register-cell recombination above merges the join's phi web (`matrix_switch` `-O2` ELF and
PE: `case 9: arg1 = arg1 == arg2 ? 42 : 99; break; } return arg1;`). The checked
view keeps the zero extension and the overlay. `source-loop-cells.test.ts` executes
both dialects, SysV and AAPCS64, with `a = 0x123456789abcdef0` against an oracle,
with an all-narrow negative that keeps `uint32_t`.

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
The same rule folds the ARM64 bitfield-move aliases (`SXTB`/`SXTH`/`SXTW`,
`SBFIZ`, `UBFIZ`: the generic `SBFM`/`UBFM` lowering) as bit-exact field algebra
for a field of 8, 16 or 32 bits (a native C integer type) that starts at bit 0 of
its source. Masks are accumulated through nested `and`s, and a rotation masked to
one run of `n` bits that does not cross the wrap point reads `n` consecutive bits
of `x`: `ror(x,w-k) & (mask(n)<<k)` with `0<k` and `k+n<w` is
`zero_extend(trunc_n(x)) << k`, and a field of `n` bits at `k` OR-ed with its own
top bit selected into exactly the bits above it (`(sign ? ones : 0) & ~mask(k+n)`,
the condition being that very bit of the same source) is
`sign_extend(trunc_n(x)) << k`, for example `(uint64_t)(int32_t)count`. A fill that
leaves a gap or overlaps the field, a sign bit that is not the field's top bit, a
field of another value, a hole in a mask, a field crossing the wrap point, a field
of another width (it would print as masks and xor/subtract pairs) and a field not
starting at bit 0 (`SBFX`/`UBFX`, whose `SBFM` form the division and signed-shift
recognizers read) keep the original form. The sign extension makes the existing
narrow-formal/`return_low_word` presentations see an explicit 32-bit extension: an
operand used only through `(int32_t)` becomes an `int32_t` formal, under their own
records and ABI requirements.
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

All of these source-normalization rewrites form one ordered rule pool
(`src/reconstruction/source-rules.ts`, `EXPRESSION_RULES`). Each rule names its
presentation record (or none for exact wiring), its views and its proof class:
`structural` (exact wiring; the BDD may veto while its allowance remains),
`bitvector` (the original form stays once the allowance is exhausted) or `own`
(side conditions are the proof and are pinned by counterexample tests).
`normalizeSourceExpressions` applies the first matching rule per value and
revisits it to a fixpoint, at most 32 rewrites per value. Source-only rules added
with the pool: `magic_division` (floor(x*M/2^s) of a zero-extended x through
multiply-high, shifts and high slices, or the add-back form t + ((x-t)>>1) of a
2^w+M multiplier, is x / d when d = ceil(2^s/M) passes an exact closed-form bound
over every residue; a shifted quotient folds into the divisor), `division_narrowing`
(unsigned division/remainder of a zero extension by 0 < c < 2^N, and signed of a
sign extension by c other than 0 and -1, is the extended narrow operation),
`remainder_idiom` (x - (x/c)*c of one SSA value and one constant c is x % c),
`compare_canonical` (constant to the right; comparisons of matching extensions,
or of one extension with a representable constant, use the narrow operands) and
`low_bits_narrowing` (the former BDD-checked low-slice narrowing, now its own
lemma; the checked view keeps the BDD check). The division recognizer tracks each
step of floor(x*M/2^s) as its exact integer while the step's width holds it and
otherwise only the low bits it provably preserves (extensions, including x86's
register-cell joins, and slices of one value are recognized as the same x).
Signed quotients floor(x*M/2^s) + [x*M < 0] (the sign bit added, the replicated
sign of x subtracted, or the quotient subtracted from it for a negated divisor)
are x / d when `exactSignedMagicDivisor` proves d = ±ceil(2^s/|M|) on both sides
of zero (2 <= |d| < 2^(w-1)); signed powers of two below 2^(w-1) through the bias
`x < 0 ? 2^k-1 : 0` (select or shift spelling), `-(x / d)` as `x / -d`, and the
remainders x - q*d over any product spelling, x - ((x + bias) & -2^k),
((x + bias) & (2^k-1)) - bias (checked modulo 2^k) and the csneg form
`x > 0 ? x & m : -((-x) & m)`. A quotient or remainder known only modulo 2^b is
used only where no other bits are read (`r << (w-b)`): x86 O2 adler32's 32-bit
tail over a 64-bit sum prints `(uint32_t)(sum % 0xfff1) << 16`; the sum's high
half is not proven zero. The printer spells a 128-bit product of sign-extended
64-bit operands as the exact signed `(int128_t)(int64_t)a * b`
(`signed_wide_product`). Two value-level rules (`src/analysis/values/rules.ts`) run in
`simplifySSA` for both views: `zext(trunc v)` is `v` when `v` is proven below the
narrow width, and `x OP x` of one value is OP's reflexive truth value unless an
indeterminate definition can reach `x` (through definitions or phi inputs, 128
values bounded). x86's quotient-overflow guard after a division of a zero-extended
dividend by a constant thus folds and its unreachable trap disappears. The printer
prints division by a constant other than 0 (signed: other than -1) natively
(`native_division`; Python-like keeps the helper for signed operands, whose floor
division differs) and an integer insert as `(base & kept) | (value << offset)`
(`mask_insert`). `test/reconstruction/source-division.test.ts` checks both magic
divisor bounds against exhaustive 8-bit and sampled 16-bit search, compiler
constants and off-by-one multipliers, and the narrowing/remainder/power-of-two
lemmas at INT_MIN, -1 and width edges;
`test/reconstruction/source-division-rules.test.ts` runs the rule pool on signed
magic, power-of-two and remainder sequences (and near misses) and compares the
rewritten DAG with the original on every 8-bit and sampled 32-bit dividend.

The bitvector checker first accepts the same operator over identity-equal
operands (congruence) without BDD work, then compiles both sides with every
subterm common to both cones as one leaf and only then the whole bounded cone; a
proof that adds or drops a leaf is accepted only when no added/dropped cone can
reach an indeterminate definition, and a counterexample is reported only over true
inputs. Bits are ordered most-significant first (a ripple-carry adder is linear),
results compare by canonical node identity, a verified shared-leaf formula is
cached per session by its leaf-renamed shape, and parallel moves of whole
variables are checked by identity. On the development matrix this lowered
allowance exhaustion from 186 to 29 of 200 functions.

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
Source phi-copy emission checks after exhaustion fold the same way: one
function-level `parallel-copy` record states "N later phi-copy emissions not
validated; local validation allowance exhausted" (each such check charges the
allowance before any proof step, so its outcome is that limitation), and the
printed copies are unchanged. Each kind keeps one summary slot; at the record
bound the summaries take the terminal slots and keep the bound in their reason.
Without the fold these unverified records filled the 256-record bound in large
functions, after which every presentation was refused (for example 9, 27 and 23
`boundary(...)` statements in brotli `main`, `isDate` and
`sqlite3Fts3Incrmerge`; 0 after).
Exact source wiring is not speculative and still applies: same-type identity
operand resolution, offset-zero/same-width bitcasts and extracts reselected from a
contained slice, extension or extract relocate existing bits without arithmetic.
Arithmetic, narrowing and folding candidates keep the retained-original fallback.

The source C renderer emits `extern` declarations only for direct calls with an
established prototype (library, debug or recovered source signatures, including variadic
tails). A call interface observed only at its call sites is not declared: the call prints
it, and an open list is stated once per function on the `open arity (calls show proven args
only): f, g` comment line (both dialects) while the calls print only their proven
arguments. Declarations never close an unknown argument remainder or manufacture an
authored prototype; exhausted `call_declaration` records leave the call undeclared.
`options.structures: "external"` (the export's C-like mode) leaves the structure `typedef`
lines and partial bodies out of the text, which then carries one `/* struct declarations:
types.h */` line, and returns them in `emission.structures` (`{ name, declaration }`); the
export writes each typedef once and each distinct body with the functions that print it
after the merged image types in `types.h`. `decompile` and MCP keep them inline: the
merged image types of `types`/`types.h` are a bounded whole-image pass and omit most
structures a function names (SQLite 3.54 `btree` export, structure sample: 442 bytes of `types.h`,
one structure, against 230 distinct structures printed by its 78 functions).
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
explicit form remains instead of an integer result, unless the untyped FP
register is an incidental vector copy or fill temporary: no caller demands it
and, on every exit, each slice leaf of every FP-root cell is the datum of a store
of at least 128 bits (through lossless transport), a constant whose defining
instruction also defines such a datum (folding gives each cell of a `movi`
zero-fill its own constant), or a call result left in place before later
effects; unchanged and undefined cells are neutral and typed FP cells
disqualify. A scalar FP value stored at its own width stays explicit. The
integer register then decides as if the FP register were undefined: an echoed
hidden result pointer (SysV `rdi`, Win64 `rcx` in `rax`) is the exact pointer
result, otherwise the void-like `incidental_result` rule applies. This records
an `incidental_result` presentation inference and an `abi_conformance`
requirement that callers read no FP result register; the FP register keeps its
exact exit value in exit metadata and the checked view.
Otherwise an untyped scalar FP value built in integer registers (`fmov d0, x8`
after the integer register on every exit path) is the `double`/`float` result
when, on every exit, the FP-root cells tile the register and every slice leaf is
consumed only by exits: no call or register-read output, load, stored datum (of
any width), vector-store constant, or value that also addresses memory or feeds
calls or branches; unchanged entry bits, frame addresses and undefined cells
disqualify. Exits whose cells are all literals (`movi v0.2d, #0`) are neutral;
every other exit has literal-zero cells above a 32- or 64-bit scalar write and
the widths agree (64 gives `double`, 32 `float`); at least one such exit exists.
It records the `primary_result` inference ("… written before an untyped scalar
FP value consumed only by exits on every exit path") and an `abi_conformance`
requirement that a scalar FP-bank result is IEEE and callers read no integer
result. Without type evidence the value prints through the exact bit
reinterpretation helper, so NaN payloads, −0.0 and infinities keep their bits.
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

A context-specialized callee summary (constant/alias call-site assumptions)
keeps the callee's result root. The context unit carries the baseline body's
result, proven on every baseline exit, where an FP/vector exit whose write is
proven but has no IEEE type of its own (a literal zero) counts as a write of the
root another exit types. When the context's own result and that generic result
are both non-empty and name different roots, the context summary and its
`source_interface` take the generic roots; widths and types on a root both prove
stay the context's, and an empty context result stays empty. Values at the call
stay context-precise; only the storage classification is inherited, because the
context's exits are a subset of the baseline exits. Thus both tail calls of the
SysV/Win64 `-O2` `matrix_variadic_call` (`matrix_variadic(0)` returns through
`xorpd %xmm0,%xmm0` alone) return the callee's `double`.

The native return interface (`nativeReturnInterface`) types an unoptimized FP
result like the source planner: when an FP/vector root has no expression or
contract type on an exit and its low 64 (or 32) bits are, through lossless
transport, phis and lane projections, a load of an exact local stack slot
(negative callee-entry SP offset), the type is the slot's typer result
(`createSlotTyper`, `source-slot-types.ts`, shared with the planner). Every direct
store to the slot must be typed FP of the same width, literal bits, or a reload
of an exact slot that is itself so typed; at least one store must be typed (a
slot of literals or of only the slot's width is no type), and an integer store,
an overlapping or dynamic stack write, or a load that a frame address may have
reached a call or unresolved memory before (`StackSnapshot.escaped` at the load)
leaves the root untyped. The existing typed-result precedence then replaces the
integer root (an `-O0` loop counter in `eax`). Thus the `-O0` variadic
`matrix_variadic` summary is `double`, and its callers print
`double r = matrix_variadic(…); return r;` through their own frame slot.

Bounded native parameter summaries refine the caller's existing memory shapes without rerunning its ABI/stack analysis. Compatible partial fields accumulate; overlapping alternatives, unknown size/alignment, dynamic indices, aliases and escapes remain explicit. Exact full-width copies and split entry cells retain one original pointer identity, while distinct incoming pointer bases remain distinct phi views. Callback fields retain the actual target and prepared whole argument carriers, not a guessed prototype. Source-built caller regressions cover alias/non-alias storage, strides, union conflicts and callback effects in both dialects.

Incoming stack arguments use callee-entry-SP coordinates. Exact, unchanged ABI scalar slots become provenance-backed source inputs, not freshly allocated private frame bytes. The symbol-bearing and stripped Mach-O ten-input fixture is evaluated in both dialects against 25 independent uint64 cases, including `1..10 → 385`, high-bit values and modulo-overflow boundaries. The source view decides per slot (`incoming_formal`, ABI premise `incoming_arguments_private`): the stack plan's _incoming floor_ is the lowest entry-SP offset that any escaping or indexing address that can designate incoming bytes (a known base ≥ 0, a mixed-sign phi or reload, an unknown base, or a floor ≥ 0) can take; a word-sized ABI parameter slot that is only loaded, exact, nonvolatile, not overlapped by another access and wholly below that floor is the formal, even after open calls, unknown stores or a frame address that escaped elsewhere, as long as no unbounded escape or unknown effect exists. Callers, callees, globals and loaded or returned pointers are assumed never to designate this activation's incoming area; only addresses derived from it can. The checked view keeps the whole-function gates (no escape, no store through an unknown address, clear per-load alias facts). `test/reconstruction/incoming-stack.test.ts` executes, for AAPCS64 (9 parameters) and SysV (7), a slot read after an open call and a store through argument 1 (formal, oracle-equal for 0, 2^64−1 and 2^63, events `store, call` only) and the same slot whose address is passed to the call (memory read through `entry_sp`, observing the call oracle's write). SQLite `createFunctionApi` now prints `arg8, arg9, opaque_1* arg10` and no `entry_sp`.

Source storage distinguishes this activation's frame from an entry-backed view with one explicit `entry_sp` base. In the source view, frame bytes kept as memory below the entry SP print as one local frame object (`_Alignas(16) struct { ... } frame;`, Python-like `frame = stack_frame(size, alignment)` with `frame.local_N: T` members): it ends at the entry SP and starts stack-aligned; each exact (offset, width) access set is a scalar member; a wider access that covers whole narrower scalar members (two `uint32_t` halves under a `uint64_t` load, or a `uint32_t` and its padding under one) keeps them as members when every wider access in the group only moves bytes (a load whose every use is a store's datum, possibly through bitcast/extract/concat, or a store of a constant or a load result: copies, zero and constant initialization; a wide value that is computed on or dereferenced stays a byte array), the uncovered bytes of its span become byte-array padding members, and the wide access is a cast at the member holding its first byte (`*(uint64_t *)&frame.local_d4`, `*(uint64_t *)frame.local_d8` over padding); partially overlapping accesses, a wide access cutting a member, interior addresses and indexed bases (with the accesses continuing them without a gap) are byte arrays, gaps are padding. Accesses print `frame.local_38`, `&frame.local_38`, `*(uint32_t *)&frame.local_1ac[4]` or `(uint8_t *)&frame + k`; every load and store keeps its address, width, order and aliasing, and an escaped frame records the `frame_object` ABI premise (frame addresses stay inside the frame; no outside pointer designates it). Only live addresses at or above the entry SP (incoming bytes, observed return-address/shadow-space bytes) that the incoming object below does not hold keep `entry_sp`; that view retains the original address space, observed bounds do not imply a complete dynamic footprint, and the extra storage input marks the interface inferred rather than preserving an exact source-signature claim. A stack address read back from memory by a load that stays in the program (a `va_list` cursor, a spilled pointer) prints through that load's declared variable (`address = frame.local_10;` … `*(uint64_t *)address`), not as the stored address constant again; only the store of the address spells it. An assignment statement targets only a declared formal or local. Such addresses coexist with the frame object (`frame_object_beside_entry_sp` presentation record; the object's `entry` is the live entry SP): offsets ≥ 0 print `entry_sp + k`, negative ones `frame.*`, and an escaped frame adds a second `frame_object` premise (arithmetic on an address at or above the entry SP never reaches the frame object). A retained access spanning the entry SP, or no member below it (no frame byte kept as memory and no live frame address), keeps the whole frame in entry-SP form, so no memberless `struct { } frame;` is printed. The checked view keeps the entry-SP form. Saved-register traffic is not a source argument. Unknown outgoing stack arity retains ordered stores, established argument prefixes and an explicit unknown remainder, not a guessed complete call signature. Framed/frameless, overlap, alignment, Windows shadow-space, SysV return-address/red-zone/dynamic-local, Darwin vararg, escaped/indexed/overlapping frame-object and reloaded incoming/frame-address walk cases, a frame object beside a live entry SP (an incoming address stored in a frame slot and dereferenced) and frame objects beside the incoming object below (an escaped slot, an indexed base, each with a stored and reloaded incoming slot) execute through the shared representation in both dialects with the checked view's values and event order. ELF debug metadata and unsupported FP environments remain separately partial.

Incoming bytes the function keeps as memory (a SysV MEMORY-class by-value aggregate updated in place, or any incoming byte that is no incoming formal because it is stored, narrower, overlapped, misaligned or Win64 home space) print as one source-only struct formal, last in the parameter list, when no exposure can designate incoming bytes (no incoming floor), no frame escape is unbounded and no retained access spans the first incoming byte (`incoming_object` presentation record and ABI premise: caller-supplied pointers such as the sret pointer, globals, loaded pointers and stores through unknown addresses never designate the incoming area). C prints a preamble `struct stack_args_XXXX { uint64_t arg_8; uint8_t arg_10[8]; double arg_18; };` and the formal `struct stack_args_XXXX stack_args`; Python-like annotates `stack_args: struct{arg_8: uint64_t, arg_10: array<uint8_t, 8>, arg_18: double}`. The struct starts at the first incoming byte (SysV and Win64 entry SP + 8, AAPCS64 + 0), members are named by entry-SP offset and laid out like frame members, and accesses print `stack_args.arg_8`, `&stack_args.arg_8`, `*(uint32_t *)&stack_args.arg_8[8]`. Nothing is forwarded: every load and store keeps its address, width, order and aliasing. Only inferred interfaces gain it; the entry SP, when no other address needs it, is then no formal. The checked view keeps the entry-SP form. SysV IR fixtures (an in-place add, increment and multiply of a 24-byte copy at +8 copied to the sret buffer, `-O2`-style with a 16-byte copy and `-O0`-style through a `lea`-computed base) execute in both dialects with wrapping totals, `count = 0xffffffff`, NaN and −0.0 weights byte-equal to an independent oracle and to the checked view; when the copy's address reaches a call, the entry-SP form stays and the call's write is observed. `test/reconstruction/stack-storage.test.ts` executes misaligned, overlapping and home-space incoming bytes through `stack_args` on all three ABIs.

A callee-side variadic area prints as `...` and `va` in the source view (`va_start` presentation record, ABI premise `variadic_convention`; Darwin arm64 and Win64, `classifyVariadicArea` in `src/reconstruction/source-variadic.ts`). Its start `a` is the incoming floor, which must be reached by an exposure derived from the incoming area alone (every base known and ≥ 0: an escaping or indexed pointer, so a base read only at constant offsets is no variadic area); every known-offset access below `a` is a bound named formal (the return's own return-address load excepted). Darwin: `a` is 0 or the end of the named stack formals, which tile `[0, a)`. Win64: `a = 8 + 8n` with `1 ≤ n ≤ 4`, and for each `i` in `[n, 4)` exactly one store of the whole entry value of the `i`-th integer argument register to home slot `8 + 8i` in the entry block (no edge reenters it), with no call, unknown effect or access to `[a, 40)` (or of unknown offset) before the last of them; the argument bits of the integer and FP argument registers of positions ≥ n have no other use (effects, control, call or tail arguments, projected results and non-pass-through exits; memory-access register snapshots excluded), and no named position uses both banks. Rewrite: the named formals (Win64: the register of each named position, kept even if unused) followed by `...`; a source-only `va` (`va_list`, `char *` on both ABIs) declared after the locals with `va_list va; va_start(va, <last named>);` (Python-like `va = va_start(arg0)`) replaces the entry SP as the base of every address: entry-SP offset `k` prints as `(uintptr_t)va + (k - a)` (the entry SP itself is `va - a`); Win64's home stores are `va_start`'s own effect and are hidden. Every other load and store keeps its address, width and order; the checked view keeps the entry-SP form and the home stores. The six `matrix_variadic` texts (Win64 and Darwin, `-O0`, `-O2`, stripped) and the Mach-O and PE `fixture_variadic` print `(uint32_t count, ...)` / `(uint32_t arg0, ...)` with no `entry_sp`; the fixtures execute against the C oracle for counts 0..9 with doubles laid out at `va`, and a Win64 IR fixture sums registers and stack slots with no store left, while a missing home store or a direct use of `rdx` leaves the entry-SP form. A non-variadic Darwin function whose first stack argument's address escapes satisfies the same footprint and prints as variadic; the machine behavior is identical (`va` is that slot's address).

SysV AMD64 callee-side variadics (S7, `classifySysvVaStart` in `source-variadic.ts`) match the exact `va_start` lowering: for the `g` named integer and `f` named vector argument registers, one unconditional 64-bit store of each anonymous integer argument register at R + 8i of a 16-aligned register save area R, one 128-bit store of each anonymous vector argument register at R + 48 + 16j in the one block the entry block's `al != 0` test enters, and the `va_list` at v (`gp_offset = 8g`, `fp_offset = 48 + 16f` as one 64-bit or two 32-bit stores, `overflow_arg_area` = entry SP + 8 + s, `reg_save_area` = R), all before any other access to these areas, call, escape or unknown effect; the saved registers and `al` have no other use, every other `va_list` access is exactly one field, and no save-area address is used except as the base of another printed address. The source view then prints the named formals and `...`, hides those stores (`va_start` presentation record listing them, ABI premise `variadic_convention`), drops the `al` guard (no liveness root, no printed test; both arms must print nothing), keeps the `va_list` as the frame-object member `va` (`va_list va;`, Python-like `frame.va: va_list  # at entry-SP offset -0xN`), prints `va_start(frame.va, <last named>);` in place of the last hidden store, and spells its fields `frame.va[0].gp_offset` / `fp_offset` / `overflow_arg_area` / `reg_save_area` (C reads the two pointers as `(uintptr_t)` and stores them from `(void *)`). The register save area is no frame member: `va_arg` reaches it only through `reg_save_area`. Anything else keeps today's output; the checked view is unchanged.

Callers see a callee's variadic interface (S8). A native unit whose body passes a cheap SSA gate (an incoming-stack address escapes, or on Darwin/Win64 a non-constant access derives from an address at or above the first possible anonymous slot) runs the same source-view classification (`reconstruct` with physical calls, so every register a call may receive counts as a use) and keeps its `va_start` footprint with the prepared unit (`nativeVariadicFootprint`, `src/service/analysis/native-variadic.ts`): the named argument registers in position order (Darwin: the observed register prefix) and the named stack bytes. `NativeInterface.variadic` = `{named_integer, named_vector, named_stack_bytes, named}`; the physical interface fields and the checked view are unchanged. In the source view the planner (`createVariadicCallBinder`) binds the named prefix exactly and appends the anonymous arguments the caller provably sets up for that call or tail: SysV, the integer argument registers after the named ones that this body writes (a prefix: an untouched entry value or a call's clobber ends it), then the vector registers after the named ones up to the constant `al`, each as its low double; Win64, the positions after the named ones whose integer register this body writes, as the double of the FP register when it holds the same bits, else the integer; Darwin, the outgoing stack slots from SP + named stack bytes (`planVariadicStackArguments`), only when the call writes no integer argument register beyond the bound prefix. A store whose own value has unknown initialization counts as a slot's owner only when no call, unknown effect or unknown-offset store lies between it and the call in one block. The list stays open (the `open arity` comment): a forwarded entry value may still be an argument. Records: `variadic_call_arguments` presentation, `variadic_call_convention` ABI premise (SysV: anonymous vector arguments are doubles, at most `al` of them; Win64: FP anonymous arguments are duplicated in their integer register; Darwin: anonymous arguments in consecutive slots after the named stack bytes).

A function's own declaration (DWARF, user annotation) with stack, variadic or hidden-result parameters (S9) binds in the source view only where these rules confirm it: a declared scalar stack parameter is the incoming formal S1 binds at its ABI slot (same width, `incoming_formal`), one declared by-value aggregate is the S4 incoming object (named and placed as declared, `incoming_object`), a declared `...` needs the S6/S7 `va_start` footprint of exactly its named formals (named registers, first anonymous offset; `va_start`), and a declared hidden result (sret) binds its pointer register at entry as the first formal `result`, typed as a pointer to the declared result type; the function then returns that pointer where the ABI returns it (SysV, Win64: `struct_X* f(struct_X* result, …)`) and otherwise nothing (`void`). The `declared_signature` presentation record covers the bound signature. When any declared part is not confirmed (an undeclared or differently sized incoming read, an incoming address through the entry SP, a missing or different footprint), the function is reconstructed again without these parts: the output is exactly the output without them, and the signature is dropped as before. The checked view never takes them.

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

## Todo

The design contract is [PLAN.md](PLAN.md). Task IDs are stable; move whole task blocks between the three board sections rather than duplicating them. Git commits record integrated work and verification milestones.

### Assignment and integration rules

- A task is ready when its dependency implementations are integrated and verified. Required acceptance remains blocking; explicitly out-of-scope host qualification does not. Cross-compiling an analysis target never establishes execution-host compatibility.
- On assignment, move the block to `Doing` and add `Owner`. On completion, record changed paths and verification evidence before moving it to `Done`. Keep blockers explicit.
- Give each subagent PLAN.md, its full task block, and the completed dependency contracts. The agent owns investigation and implementation within that slice; it must not invent a second interface or edit sibling-owned modules without coordination.
- One integration owner controls `src/core/` contracts, dependency manifests, shared fixture manifests, and cross-slice integration. Request contract changes rather than silently changing another task's assumptions.
- Agents prepare behavior tests but skip repository-wide builds, lint, tests, and formatters while a wave is in flight. The integration owner runs combined checks once after the wave, exercises the actual changed path, and resolves failures before marking tasks done.
- Acceptance means working behavior, not stubs, mock echoes, compilation alone, or source-text assertions. Reuse relevant existing regressions; do not pin incidental pseudocode wording.
- First-release work is T01–T31 and must satisfy PLAN.md A01–A12. F01–F03 are explicitly later extensions. Future work does not excuse unfinished first-release behavior.
- User-corrected host scope: intended execution hosts are macOS and Linux/WSL; the first local release is qualified on macOS arm64. Native Windows execution is not required. Windows PE remains an analysis target; Linux/WSL host execution remains unverified until actually exercised. No Windows VM is required for engine acceptance.
- Initial concurrency: after T01, T02 and T03 can proceed independently. After their contracts/fixtures land, store, loader, and decoder slices can proceed independently; ABI and lifter tasks follow the IR contract. Use the dependency graph, not task-number order, to schedule subsequent waves.

### Foundation and contracts

### Independent loading, decoding, storage, and ABI slices

### Metadata, presentation, and durable annotations

### Worker execution, service, and MCP integration


### Integration, containment, and delivery

### Later extensions — not first-release blockers

## Doing

No active tasks. T01–T31 and F01–F03 are complete under the documented execution-host scope.

## Done
- [x] **T31 — Package and document the first local release**
  - Depends on: T29, T30.
  - Owns: distribution scripts/metadata, user/developer documentation, license/provenance notices, final backlog/plan status updates.
  - Work: Produce the compiled installable application and document local MCP launch/configuration, project lifecycle, tool schemas, annotation/evidence rules, limits, supported semantic families, and troubleshooting. Include decoder revisions/licenses, a64js generated-data provenance review, fixture redistribution notices, update procedures, and benchmark/host verification evidence. Do not bundle separately licensed Arm reference downloads.
  - Acceptance: Install from the produced artifact in a clean macOS arm64 environment and complete real investigations for every supported target without source-tree/sibling dependencies. All A01–A12 have recorded evidence under the user-corrected host scope. Documentation distinguishes verified macOS execution, intended/unverified Linux/WSL execution and unsupported native Windows qualification. No obsolete aliases, duplicate legacy pipeline or migration-only scaffold remains.
  - Owner: ReleaseArtifact (sol-worker: package/isolated-install drivers), ReleaseDocs and MacIntegration (sol-worker: documentation, packaging and installed qualification), WindowsNativeOps (sol-worker: preserved historical native evidence and VM shutdown), Coordinator (distribution contracts, acceptance decisions, task board, Git and final evidence).
  - Scope: T29/T30 cross-target acceptance and recorded macOS performance are verified. This private local release is qualified on macOS arm64; Linux/WSL is intended but unverified, and native Windows execution is not required.
  - Implemented and verified: Source/docs milestone `a1698357f62644c07bd62d92d5e7b18179f100dc` produced `.local/release/local-0.1.0-macos-a169835/open-decomp-0.1.0.tgz` (7,510,639 bytes, SHA256 `3cc8029c73d7ef233dd9740ada7b56a838fa6703c77096643f4080f50421baff`) and its hash-bound inventory manifest. The exact archive passed clean external empty-cache offline installation and **40 JSON evidence records**, including public import, three formats/both decoders, all three demanglers, all eight target investigations/both dialects and **28 maintained scenarios plus completion**. Node 24.22.0/npm 11.20.0; no source fallback or target execution. RELEASE-VERIFICATION.md records commands, complete hashes and post-build qualification without rewriting the sealed pair.
  - Distribution boundary: The application remains private/UNLICENSED. Retained notices and unresolved public Arm generated-data/Swift WASM source provenance boundaries are explicit; this is not authorization for public redistribution.

- [x] **T29 — Run cross-target release acceptance on the verified host**
  - Depends on: T28.
  - Owns: end-to-end acceptance suite, host verification configuration, release evidence.
  - Work: Execute PLAN.md A01–A11 with real fixtures and the compiled MCP server on macOS arm64. Analyze Mach-O ARM64, PE x86-64 and ELF/System V x86-64 without running targets. Include stripped/symbol-bearing cases, persistence, annotation-driven reanalysis, unsupported semantics, malformed files, source mappings, cancellation and decoder/ABI semantic regressions. Integrate outstanding migration fixes and remove obsolete migration scaffolding.
  - Acceptance: Record actual commands/scenarios and outcomes for the cross-target matrix. All required behavior works without `../disass_arm`, private inputs, undeclared developer tools or a public decompiler. Linux/WSL execution is an intended but unverified host capability; native Windows qualification is outside the user-corrected release scope. Contributes A01–A11.
  - Owner: ReleaseWorkflows (sol-worker: compiled acceptance scenarios), MigrationAudit (scout: read-only migration/provenance coverage), WindowsProgress (sol-worker: event-driven verification evidence), WindowsNativeOps (sol-worker: exclusive Windows execution, management and raw evidence), MacIntegration (sol-worker: macOS integration/verification), WindowsStdioFix (astra-worker: native shutdown correction), Coordinator (contracts, acceptance decisions, task board and Git).
  - macOS verification: Current source milestone `0d3e40b` passed Node 24.22.0 strict typecheck, **852/852 tests**, build and **28 compiled MCP scenarios plus completion** across eight Mach-O/PE/ELF fixtures and both dialects. Actual HTTP/trusted-CA HTTPS workflows covered ELF artifacts, mappings, revision invalidation, process restart and principal isolation. RELEASE-VERIFICATION.md retains exact evidence and distinguishes current results from historical Windows candidates.
  - Migration cleanup: Retired the sibling-API collector and redundant captured C files; retained frozen historical JSON, current source oracles/fixture generation and durable-store migrations. Updated recipe hashes and documentation. Evidence and criterion boundaries are in RELEASE-VERIFICATION.md.
  - Scope correction: The user explicitly removed native Windows-host qualification from release requirements and identified Linux/WSL as the likely runtime for Windows users. Cross-compilation plus actual macOS analysis supplies target-engine evidence, not a Linux/Windows host pass.
  - Historical native investigation: A focused current-artifact probe ultimately passed stalled exit 1, durable revision-2 resume and healthy EOF 0; that narrow correction is not whole Windows-host qualification. The owned remaining command was stopped under the user's scope correction, then the guest shut down gracefully and QEMU exited. VM disk, logs and artifacts remain preserved. Exact historical failures, final probe and shutdown evidence are in RELEASE-VERIFICATION.md; no further Windows VM work is required.

- [x] **T30 — Measure end-to-end performance and resource bounds**
  - Depends on: T29.
  - Owns: benchmark workloads/harness and performance evidence; coordinate implementation fixes with owning modules.
  - Work: Measure cold import/indexing, per-function decode/lift/analysis/emission, cached queries, IPC/serialization, and peak memory for representative small/large binaries on recorded hosts. Check bounded concurrency and WASM lifecycle under sustained use. Optimize only measured bottlenecks, preserving semantic regression results; document practical limits and regression methodology.
  - Acceptance: Reproducible reports distinguish stages, cold/warm behavior, binary sizes, runtime/hardware, and memory. Work/output limits are exercised, sustained jobs do not accumulate unbounded resources, and any claimed improvement has before/after evidence. Do not claim a Rust-vs-JS speed ratio without a comparable implementation. Contributes A12.
  - Owner: PipelineBench (astra-worker: pipeline/worker stages), ResourceBench (sol-worker: sustained WASM, admission and IPC), PELargerImage and PEUnwindCompatibility (astra-worker: real-PE unwind compatibility), BenchmarkInputs (sol-worker: pinned SQLite inputs), ImportScaling and DiscoveryScaling (astra-worker: native-index amplification), X86PreparedRanges (sol-worker: indexed decoder preparation), MachOMetadataOwnership (astra-worker: native code/data ownership), Coordinator (measurement contracts and acceptance decisions).
  - Scope: Measurements qualify the recorded macOS execution host. Linux/WSL is intended but not measured; native Windows benchmarks are outside the user-corrected release scope.
  - macOS verified: At the recorded performance milestone, **695/695 tests**, build, actual SQLite workflows for both ISAs, a 100-batch sustained resource run and all 24 then-current compiled scenarios passed. Mach-O loader 1.0.3 no longer promotes header metadata to code; genuine complete discovered bodies emit. PE SQLite publishes bounded metadata and emits selected bodies with explicit partial semantics. Schema-4 historical migration/rollback and unchanged individual-record bounds are covered. PERFORMANCE.md retains exact inputs, stages, cache/IPC/serialization, memory, real cap failures and limits. These are measured historical results, not invented measurements for later extensions; no native-Windows SLA or Rust/JS ratio is claimed.

- [x] **F03 — Add Linux x86-64 ELF / System V ABI support**
  - Depends on: T31.
  - Selected by user: Linux x86-64, ELF, System V AMD64 ABI. Corpus: compile the existing scalar/control/memory/call/FP/vector sources into symbol-bearing and stripped ELF executables/shared objects; add compiler-backed SysV cases for mixed register banks, aggregate classification/rollback, stack/red-zone use, variadic calls and indirect results before integrating the new target.
  - Owns: ELF loading, System V AMD64 ABI classification, x86-64 adapter/lifter target integration and the selected conformance/acceptance corpus.
  - Work: Add only the components required by the selected combination, reusing existing semantic analysis, persistence, tools, and emitters. Publish exact capabilities and unsupported cases. If replacing a decoder, implement its architecture adapter and adjudicate semantic conformance rather than assuming a drop-in swap.
  - Acceptance: The complete investigation workflow works for the selected target with evidence-backed semantics, and existing targets remain correct. Public tools require no architecture-specific command fork.
  - Owner: ElfLoader (sol-worker: bounded native loader), SysVAbi (astra-worker: ABI and semantic integration), ElfCorpus (sol-worker: compiler fixtures and standard workflows), MacIntegration (sol-worker: integrated verification, compiled workflows and documentation), Coordinator (shared contracts, acceptance decisions, task board and Git).
  - Scope: Linux target analysis uses cross-compiled fixtures and does not require executing targets in a Linux or Windows VM. This is independent of Linux/WSL execution-host qualification, which remains unverified.
  - Implemented and verified: Bounded ELF64 loading, System V AMD64 ABI and compiler-backed corpora reuse the existing decoder, lifter, analysis, storage, tools and both emitters. Five reviewed semantic/native-boundary defects were reproduced failing-before and corrected. Node 24.22.0 strict typecheck, **852/852 tests** and build passed; compiled stdio passed **28 scenarios plus completion** across all eight fixtures. Actual HTTP and trusted-CA HTTPS covered all four ELF variants, both dialects, hash-paged artifacts, mappings, cross-principal denial, revision invalidation and full-process restart/cache recovery. Machine coverage is complete while unavailable ELF DWARF/source metadata remains explicitly partial. Eight concurrent compiled overflow probes now return 413 without the previously observed connection reset. Exact evidence is retained in RELEASE-VERIFICATION.md.

- [x] **F01 — Add a Python-like pseudocode emitter**
  - Depends on: T31.
  - Owns: `src/emitters/python-like/`, emitter selection/capability integration and semantic mapping cases.
  - Work: Define a readable Python-like pseudocode dialect over the existing presentation model. Make finite-width arithmetic, loads/stores, labels/unstructured flow, and unknown effects explicit; do not imply ordinary Python runtime semantics. Add emitter selection and versioned cache identity without changing the semantic pipeline.
  - Acceptance: The same analyzed functions render in both styles with equivalent effects and source mappings. No decoder/lifter/type-recovery fork is introduced, and the output is clearly labeled pseudocode rather than recovered or directly executable Python.
  - Owner: PythonEmitter (astra-worker), PythonSemanticReview (reviewer), ExtensionDocs (sol-worker), Coordinator (shared integration and actual verification).
  - Scheduling: Used integrated macOS-verified interfaces; later cross-target and installed evidence is recorded in T29/T31. No native Windows or Linux/WSL runtime pass is inferred.
  - Implemented and verified: Shared presentation-model rendering, neutral public emission types, finite-width Python-like pseudocode, final-text UTF-16 mappings and full-target/emitter cache integrity. Node 24.22.0 strict typecheck, **730/730 tests** and build passed. Actual compiled stdio/HTTP/HTTPS clients emitted both dialects for Mach-O ARM64 and stripped PE x64, compared instruction mappings, verified artifact hashes, invalidated caches through revision-3 annotations and recovered Python cache hits after process restart. Existing emitter suites independently observe arithmetic/memory/control effects. Documentation and exact evidence are in RELEASE-VERIFICATION.md; no new extension artifact installation or Windows pass is claimed.

- [x] **F02 — Add authenticated MCP Streamable HTTP transport**
  - Depends on: T31.
  - Owns: HTTP transport, authorization integration, remote deployment documentation and security scenarios.
  - Work: Reuse the same service/tools with authentication, project authorization, origin/DNS-rebinding protection, conservative binding defaults, bounded uploads/import access if offered, and request/work quotas. Define remote artifact and job access under the same identity. Keep transport lifecycle separate from persisted project identity.
  - Acceptance: An authorized client completes the existing workflow remotely; unauthenticated/cross-project access, malicious origins, and resource abuse are rejected. Local stdio behavior remains intact, and no custom public socket protocol is required.
  - Owner: HttpTransport (astra-worker), HttpSecurityReview (security-reviewer), ExtensionDocs (sol-worker), Coordinator (shared integration and actual verification).
  - Scheduling: Developed independently against the integrated service, with actual macOS stdio/HTTP/HTTPS verification. Host qualification remains separate from analysis-target support.
  - Implemented and verified: Official SDK HTTP handling, per-request private identity, disjoint canonical project roots, native TLS/Host/Origin checks, bounded admission/output and principal-owned work surviving exchange loss. Node 24.22.0 **730/730 tests** and build passed, including real SDK security and deterministic worker lifecycle cases. Separate compiled HTTP and HTTPS CLI clients completed both target workflows, rejected unauthenticated/hostile-origin/cross-principal access and retained projects/artifacts across full server restart; certificate verification stayed enabled. Local compiled stdio also passed. REMOTE.md documents private bearer provisioning, limits and trust boundaries; no OAuth issuer, upload, public deployment or Windows qualification is implied.

- [x] **T28 — Verify input containment and enforce resource/error boundaries**
  - Depends on: T27.
  - Owns: containment integration cases and documented limits; coordinate fixes in owning modules rather than duplicating validation.
  - Work: Exercise authorized-root checks, canonical/symlink paths, project/artifact isolation, parser arithmetic/count limits, work/IR/output budgets, cancellation, crashes, and transactional recovery through the real service. Check that strings/symbols/notes remain data and that no target execution, dynamic target-library load, remote fetch, or arbitrary file access is reachable. Document actual worker/OS restrictions without overstating sandbox guarantees.
  - Acceptance: Hostile/malformed fixtures and denied paths produce bounded, typed errors; unrelated project artifacts remain inaccessible. Worker termination cannot corrupt saved analysis, flood stdout, or leave requests hanging indefinitely. Existing legitimate binaries still complete their workflows. Contributes A10.
  - Owner: ParserContainment (sol-worker: hostile loader/metadata inputs), AnalysisBounds (astra-worker: preallocation and cumulative semantic bounds), Coordinator (MCP/worker/path/control/output boundaries, integration and documentation).
  - Implemented: Typed Mach-O parser failures; durable import diagnostics and partial native indexes; preallocation IR/lifter/SSA capacity checks and cumulative provenance/verification work; budget-truncated graph rejection; transactional MCP annotation delivery preflight without budget mutation; bounded stdio IDs/request/output queues and stalled-write shutdown; all-owner shutdown completion even when one close fails. Changes span loaders, IR/lifters/shared analysis, service/worker/MCP boundaries and semantic integration regressions; limits and OS-isolation exclusions are documented in PLAN.md and src/core/README.md.
  - Verification: Node 24.22.0 strict typecheck, **668/668 tests**, build and all four compiled symbol-bearing/stripped Mach-O arm64/PE x86-64 MCP workflows passed. Actual compiled probes changed oversized annotations from a hidden revision-3 commit to typed resource_limit at unchanged revision 2; rejected a 2,000,000-byte request ID before mutation; bounded a non-draining request backlog; and exited a single stalled output at **30,108 ms** without an external kill. A compiled two-owner failure probe now returns only with the second worker dead and no pending job. Earlier reproduction observed 5,364,216 queued stdout bytes and listener warnings, ARM64 allocation of 500 assignments before a one-node rejection, x86-64 success with 1,502 assignments under that limit, and argument-stack overflow at 150,000 provenance sources; the semantic/boundary regressions pass after construction-time fixes. Current Windows coverage remains T29's gate.

- [x] **T27 — Expose the complete local MCP tool surface**
  - Depends on: T23, T25, T26.
  - Owns: `src/mcp/`, compiled server entry point, deterministic stdio smoke client.
  - Work: Use the official TypeScript SDK to publish every tool named in PLAN.md with validated input/output schemas and structured results. Connect real project/query/analysis/annotation operations, job status/cancel, progress where supported, and bounded artifact/resource reads. Add an actual launch command; reserve stdout for protocol traffic and send diagnostics to stderr.
  - Acceptance: Launch the compiled server and discover/call its tools through a real MCP client. For each target, open → inspect/search → follow references → decompile → annotate → reanalyze → close/resume succeeds with correct revisions/evidence. Long jobs can be inspected/cancelled without depending on optional client extensions. No mock backend, generic shell, or arbitrary SQL tool is exposed. Contributes A09.
  - Owner: McpTools (sol-worker: SDK tool/resource adapter), McpLaunch (sol-worker: compiled stdio launch/client workflows), Coordinator (async service contracts, dependency pins, integration and verification).
  - Decision: Pin official SDK v2.3.1 server/core/client packages for MCP 2026-07-28, not the maintenance-only v1 package. Import and decompilation expose ordinary project-owned jobs by default (`wait: true` requests a final inline response); job controls report the acknowledged revision, and a sole imported image can be inspected without guessing its ID.
  - Implemented: Official SDK tool/resource adapter, explicit-root compiled stdio CLI, bounded readable artifact pages, default async job ownership, explicit unfinished-import inspection/repair, copied-project identity rejection, typed path errors and truthful close-revision reconciliation. SDK exchange teardown cannot cancel admitted jobs; closing stdin releases oversized blocked writers.
  - Verification: Node 24.22.0 strict typecheck, **632/632 tests**, and build passed. The official SDK client launched the compiled server and completed all four symbol-bearing/stripped Mach-O arm64 and PE x86-64 workflows at revisions 2→3→4, including 15–23 artifact pages, cancellation and reopened cache hits. Rebuilt smoke passed again with a 2 MiB client buffer. Real probes reproduced/fixed close revision 0→1 mismatch and oversized-input process hang; copied-project routing rejection is covered by a real-directory regression. Windows f059a44 independently passed 589/589 earlier-milestone tests and cross-target decode; T27 Windows verification remains T29 work.

- [x] **T25 — Integrate the complete decompilation pipeline and revision-aware cache**
  - Depends on: T15, T22, T23, T24.
  - Owns: `src/service/analysis/`, `src/project/cache/`, pipeline integration cases.
  - Work: Connect loaders, discovery, architecture lifters, ABI/metadata evidence, shared passes, presentation, and emission into real per-function analysis jobs. Implement completeness reporting and caches keyed by input identity, versions, features/ABI, analysis policy, revisions, and emitter options. Publish results atomically and prevent old-revision jobs from becoming current after edits.
  - Acceptance: The service decompiles real functions for both targets without using an external decompiler. Repeated requests use valid cached results; annotation edits/retractions and option/version changes invalidate them. Cancellation/crashes never publish partial artifacts as complete. ARM64 behavior no longer relies on a legacy C-string pipeline or sibling runtime import. Contributes A04–A08.
  - Owner: Pipeline (astra-worker: service analysis/annotation composition), AnalysisCache (sol-worker: cache/store/catalog persistence), Coordinator (shared contracts, child routing and integration).
  - Decision: Large decompilations use an explicit artifact delivery variant, not an empty/truncated emission masquerading as complete. Published semantic catalogs are indexed at the exact project revision; after an edit, reanalyze before adding annotations to derived-only IDs.
  - Implemented: Real analysis/annotation handlers, explicit inline/artifact wire delivery, schema-3 transactional cache/catalog publication and migrations, exact-revision/component-version authorization, complete proof closure, original-budget cache identity, and host mutation-revision propagation. Source type/field/function declarations and exact call-local provenance retain their identities; undefined values remain distinct from unsupported semantics.
  - Verification: Node 24.22.0 strict typecheck, **617/617 tests**, and compiled build passed. Compiled `QueryService` children completed Mach-O arm64 and PE x86-64 open/search/xref/decompile/cache-hit/annotate/reanalyze/retract/artifact-read/cancel/close/reopen workflows at revisions 2→3→4. Source runtime probes demonstrated and corrected lost type subjects, false call-signature conflicts and stale host revision propagation. Real stopped-owner tests cover future-revision rejection and commit-before-response loss without mutation retry.
- [x] **T22 — Implement C-like pseudocode emission and instruction mappings**
  - Depends on: T20, T21.
  - Owns: `src/emitters/c/`, emitter interface implementation and behavioral mapping tests.
  - Work: Port useful emission/presentation/runtime-helper behavior into the first emitter. Handle precedence, declarations, signedness/widths, identifiers, structures/signatures, labels, and helper explanations. Emit text plus statement/span-to-IR/instruction mappings and explicit reconstruction/coverage diagnostics. Formatting must not perform semantic analysis.
  - Acceptance: Both target corpora yield readable C-like output with correct expression grouping and observable semantics. Mappings still identify original instructions after simplification; names are escaped without losing original identities. Outputs do not claim to be original or necessarily recompilable C. Tests assert semantics/mappings, not incidental wording. Contributes A07.
  - Owner: CEmitter (astra-worker).
  - Integrated: `src/emitters/c/`, `test/emitters/c/`, public exports and core documentation. Explicit finite-width machine-state pseudocode, separate source evidence, escaped identities/notes, simultaneous edge copies, physical effects and bounded UTF-16 instruction mappings.
  - Verified: macOS Node 24.22.0 full check 589/589, strict typecheck and build; compiled emission for arithmetic/memory/stack/vector on both targets within default budgets, with codec round-trips and every surviving statement/control mapped to original instructions. Independent emitted-text execution covers arithmetic, memory, loops, switches, call slices and faults; undefined x86 AF remains indeterminate. Full physical-state output is deliberately explicit and can be verbose.

- [x] **T23 — Implement transactional annotation edits and revision semantics**
  - Depends on: T05, T20.
  - Owns: `src/project/annotations/`, revision/conflict/invalidation contract tests.
  - Work: Implement atomic name, note, type/structure, and signature edits using stable IDs and `expected_revision`. Store author/origin, evidence references, and assertion status; support retraction/removal without deleting immutable binary facts. Produce conservative dependency invalidation signals and preserve edit history.
  - Acceptance: A successful batch advances revision once; a stale or invalid batch makes no partial edits. Names/types/notes and provenance survive reopen. Retraction removes the assertion from subsequent analysis rather than leaving stale inferred facts, and function-ID changes do not silently reattach notes to unrelated entities. Contributes A08.
  - Owner: AnnotationService (sol-worker).
  - Integrated: `src/project/annotations/`, `test/project/annotations/`, public exports and core documentation. Trusted snapshot-bound semantic catalogs, atomic edits/evidence/job hooks, scoped reachable type declarations, immutable assertion identities and retained removal/retraction history.
  - Verified: 10 annotation regressions within the 589/589 full check. Compiled Mach-O and PE lifecycles import → assert types/signature/name/note → reopen → reject stale edit → recover complete ABI → emit renamed/noted output → retract/remove → reopen. No assertion enters immutable fact tables; unrelated function type declarations do not leak into the selected function.

- [x] **C02 — Allow revision-scoped artifact reuse by cache-hit jobs**
  - Depends on: T05, T24, T26; integration prerequisite for T25.
  - Owns: Existing store artifact/job validation and focused persistence regressions.
  - Work: Permit a cache-hit job to reference an already published artifact from the same project/input snapshot, without duplicating artifact bytes or relaxing publication, identity, revision or terminal-state checks.
  - Acceptance: Producer and cache-hit job retain the same artifact across reopen; unpublished, forged, foreign-project and wrong-revision references fail without changing the job.
  - Owner: Coordinator.
  - Evidence: Source-runtime PE discovery/artifact publication reproduced the rejected cache-hit reference before the fix and preserved the same artifact in both completed jobs after reopen afterward. All 8 store tests and focused strict contract/store typechecking passed, including forged/unpublished/project/revision and cancellation boundaries. Paths: `src/project/store/index.ts`, `test/project/store/store.test.ts`.

- [x] **T20 — Implement recovered types and constraint/evidence handling**
  - Depends on: T17, T18, T19.
  - Owns: `src/analysis/types/`, type-recovery behavior tests.
  - Work: Port type recovery onto typed IR and combine memory access shapes, ABI rules, debug types, library contracts, and explicit annotations. Represent pointers, arrays, structures/fields, signatures, and scalar/vector types within supported semantics. Separate machine widths from reconstructed source types, and track why each constraint exists.
  - Acceptance: Structure/field and signature recovery improves fixture decompilation while respecting offsets, widths, aliases, and both data layouts. Conflicting evidence is surfaced, user assertions remain labeled, and names or isolated casts cannot establish object sizes/types without evidence. Contributes A06/A08.
  - Owner: TypeRecovery (astra-worker).
  - Evidence: `src/analysis/types/`, real-corpus and constraint regressions; Node 24.22.0 strict typecheck/build and all 561 integrated tests passed. Compiled APIs recovered asserted 64-bit read/write fields, signed stack offsets and four-lane vector access shapes from both target binaries without changing SSA. Coordinator fixed finite-width pointer displacement wrapping and kept observed stack extents distinct from frame allocation.

- [x] **T26 — Implement bounded project inspection and navigation services**
  - Depends on: T15, T18, T19, T24.
  - Owns: `src/service/queries/`, query/result and artifact-access behavior tests.
  - Work: Implement project open/close, binary-info views, symbol/string/function searches, function metadata/disassembly/CFG views, references, and bounded byte/typed reads. Add deterministic ordering, server-side filtering, revision-bound cursors, and project-scoped artifact retrieval. Reuse loader address translation and indexes; do not introduce a second program model.
  - Acceptance: A direct client navigates from import/string to referencing function and reads correct headers, disassembly, CFG, and bytes on both targets. Pagination covers results without duplication/omission at a fixed revision and rejects stale cursors. Unmapped/zero-filled data, incomplete indexes, and truncation are explicit. Contributes A01/A03/A08.
  - Owner: ProjectQueries (sol-worker).
  - Evidence: `src/service/queries/`, worker integration and direct-child tests; all 561 tests passed with no skips on macOS. Compiled clients followed native imports/strings to exact instructions, CFGs and bytes on both targets, paged 19 ARM64 and 16 x64 functions, and preserved identities on reopen. Integration corrected coalesced unwind-region ownership and added portable real-child cancellation/crash gates. Windows re-verification remains part of the release matrix; the earlier 00f5e15 run exposed the now-corrected fixture-license hash.


- [x] **T01 — Establish the TypeScript project and runnable development toolchain**
  - Depends on: None.
  - Owns: `package.json`, lockfile, TypeScript configuration, development/build scripts, initial `src/` and `test/` layout.
  - Work: Set up strict TypeScript, ESM, pinned Node 24 LTS tooling, npm, compiled distribution, `tsx` development execution, and `node:test`. Enable strict optional/indexed-access handling. Establish commands for build, type checking, behavior tests, and smoke clients without creating fake analysis endpoints. Keep first-party implementation TypeScript.
  - Acceptance: A clean checkout installs reproducibly and compiles/runs a real TypeScript module and test client under the pinned runtime. Production imports resolve from built output rather than the source checkout. No dependency on files outside this repository is required by the toolchain.
  - Owner: Coordinator.
  - Evidence: Node v24.22.0; reproducible `npm ci`, strict typecheck, two integer-boundary tests, and compiled build passed. Compiled smoke decoded a binary uint64 and preserved `0x20000000000001` through the public codec. Paths: package/config files, `src/core/integers.ts`, `src/index.ts`, `test/core/integers.test.ts`, `scripts/smoke.ts`.

- [x] **T02 — Establish redistributable fixtures and the ARM64 behavioral baseline**
  - Depends on: T01.
  - Owns: `fixtures/`, fixture manifest/build recipes, `test/fixtures/`, baseline migration checks.
  - Work: Inspect the existing `../disass_arm/test/` behavior coverage and capture applicable ARM64 results before migration. Provide small real Mach-O ARM64 and PE32+ x86-64 executables/libraries, stripped and symbol-bearing variants, an ARM64 fat-container case, and malformed/boundary fixtures. Record source, tool versions, flags, hashes, expected semantics, and redistribution terms. Include integer/control-flow, stack/calls, memory, scalar floating-point, and common vector examples; build the exact semantic inventory used by later lifters. Supply an isolated test-only semantic oracle/evaluator strategy, never target execution in the service.
  - Acceptance: A fixture manifest resolves every input and expected behavior; rebuilding or verifying checked-in fixtures is documented. The existing ARM64 decompiler has been exercised directly on the applicable corpus with recorded capabilities/gaps. Tests can run without private binaries, network access, or an installed cross-compiler when prebuilt fixtures are provided.
  - Owner: FixtureBaseline (sol-worker).
  - Evidence: 9 compiler/linker images, 32 extracted function ranges, 13 malformed inputs, 24 source semantic cases, and captured direct API baseline committed with provenance. Node 24.22.0 integration typecheck/build and fixture tests passed in the 34-test foundation suite; actual trusted macOS executable variants all exited 0. Windows native execution is reserved for T29 and remains unavailable. Historical output text/log assertions were excluded from permanent tests.

- [x] **T03 — Define shared identities, addresses, evidence, and service contracts**
  - Depends on: T01.
  - Owns: `src/core/`, shared schema definitions, contract fixtures.
  - Work: Define project/image/slice/entity IDs; address spaces and validated translation inputs; target/ABI/features; structured diagnostics; evidence origins; capability/completeness states; revision and job identities; query paging and artifact references. Define loader, architecture-specific decoder payload, ABI, emitter, store, worker-command, and service-operation boundaries. Publish the exact arguments/results for the tools listed in PLAN.md, with reusable runtime schema validation and lossless bigint wire codecs.
  - Acceptance: Contract checks distinguish VA/RVA/file offsets, reject unsafe numeric addresses, round-trip full-width unsigned values, and separate empty/partial/unsupported/failed/cancelled results. Schemas cover all planned tools and revision-bound cursors without MCP types leaking into the core. Architecture-specific decoder information is not flattened into assembly text or a least-common-denominator operand type.
  - Owner: CoreContracts (astra-worker), integrated by coordinator.
  - Evidence: Node 24.22.0 strict typecheck, all 34 foundation tests, build, and compiled-core smoke passed. Smoke read a real Mach-O header, translated the fixture function VA to file offset 1396, distinguished zero-fill, validated an import request, and exported all 13 tool schemas. Coordinator fixed Zod branded reverse-codec typing and generic result narrowing without weakening validation.

- [x] **T04 — Implement typed semantic IR, provenance, and invariant verification**
  - Depends on: T02, T03.
  - Owns: `src/ir/`, IR behavior/invariant tests.
  - Work: Implement discriminated semantic nodes, typed builders, bit-vector widths, register slices, float/vector types, memory/effect ordering, flags, calls, branches, and unknown-effect boundaries. Define register-form lifting and shared SSA/CFG interfaces, stable value/block identities, and source provenance. Provide validation and semantic fixture evaluation for supported primitives; do not use C-expression strings as IR.
  - Acceptance: The verifier rejects incompatible widths, invalid value/block references, broken control-flow arity, and illegal effect ordering. Semantic checks exercise wrapping, extension, signed operations, register slices, and memory effects. Provenance survives replacement/combination of nodes, and unsupported effects cannot be mistaken for a no-op or established trap.
  - Owner: SemanticIR (astra-worker).
  - Evidence: `src/ir/`, `test/ir/`; strict typecheck/build and 175-test integrated suite passed on Node 24.22.0. Compiled public API smoke evaluated uint64 wrapping plus ordered memory store/load to exactly `1`; fixture semantic programs matched the independent source oracle. No target code execution occurs in service code.

- [x] **T05 — Implement durable project storage and immutable image import**
  - Depends on: T03.
  - Owns: `src/project/store/`, schema migrations, project-store behavior tests.
  - Work: Implement SQLite persistence behind the store contract using the pinned runtime's `node:sqlite` API. Import one immutable project-owned snapshot per content identity, record selected slices, and store entities/evidence/revisions/artifact metadata losslessly. Add transactional mutation primitives, versioned migrations, conservative project locking, and atomic artifact publication. Do not expose arbitrary SQL.
  - Acceptance: Import, close, and reopen preserve identity and facts; changed input bytes produce a new identity without overwriting the old image. Full-width addresses survive persistence. Interrupted transactions/artifact writes do not publish partial state; newer unsupported schema versions fail without modifying the project.
  - Owner: Coordinator.
  - Evidence: `src/project/store/`, store/core operation regressions; import/reopen, full-width addresses, history, stale cursors, cancelled/stale artifact publication, exclusive locking, schema-version nonmutation, and actual process-exit rollback passed. Compiled PE import → persist metadata/evidence → close/reopen → export query recovered `fixture_arithmetic` at `0x180001030` and file offset `1072`.

- [x] **T06 — Port Mach-O ARM64 loading and address mapping**
  - Depends on: T02, T03.
  - Owns: `src/loaders/macho/`, Mach-O loader tests.
  - Work: Reuse applicable behavior from `executable.ts`, `dyld.ts`, `imports.ts`, `image-memory.ts`, and `address.ts` in the existing project. Support thin/fat containers and explicit ARM64 slice selection; expose headers/load commands, segments/sections, entry points, symbols, imports/exports, relocations/bindings/fixups, function starts, unwind hints, and data-in-code boundaries. Preserve loader evidence and unsupported-format diagnostics. Remove browser/UI coupling.
  - Acceptance: Fixture metadata and VA/file translations match independently established expectations, including zero-filled memory and nontrivial image bases. Ambiguous slices, truncated commands, invalid ranges, and unsupported subtype/features are explicit. The loader never decodes embedded data simply because its section is executable. Contributes A01.
  - Owner: MachOLoader (sol-worker).
  - Evidence: `src/loaders/macho/`, loader regressions; actual API smoke loaded four thin fixtures and the universal ARM slice at container offset `0x8000`, retained entry `0x100000a8c`, bindings/fixups/unwind hints, and zero-fill. Independent LLVM binding inspection confirmed the dylibs have no imports; executable-only `_puts` expectations were corrected.

- [x] **T07 — Implement PE32+ x86-64 loading and address mapping**
  - Depends on: T02, T03.
  - Owns: `src/loaders/pe/`, PE loader tests.
  - Work: Parse DOS/PE/COFF/optional headers, sections/data directories, image mapping and entry point, imports including ordinal/delay imports, exports including forwarders, base relocations, exception/unwind records, TLS metadata, and debug-directory references. Retain raw offsets and evidence. Identify managed/unsupported inputs without pretending their bodies are supported native code.
  - Acceptance: Native EXE/DLL fixtures expose correct headers/imports/exports and distinguish RVA, VA, and file offsets; virtual zero-fill and file-backed bounds are correct. Malformed counts/ranges, missing directory data, and unsupported machine types fail or report partial data explicitly. No target DLL is loaded. Contributes A01.
  - Owner: PELoader (sol-worker).
  - Evidence: `src/loaders/pe/`, loader regressions; actual DLL/EXE smoke reported 19 DLL exports, 2 EXE imports, preferred VAs, zero-fill, relocation and unwind metadata. Non-RSDS CodeView records are diagnosed without an invented PDB identity. Integrated malformed/count/unwind/cancellation tests passed.

- [x] **T08 — Integrate and pin the a64js decoder adapter**
  - Depends on: T02, T03.
  - Owns: `src/decoders/arm64/`, `vendor/a64js/`, ARM64 decoder conformance fixtures.
  - Work: Import a pinned source snapshot from the existing a64js checkout with provenance and license notices, not a runtime `../` import. Adapt structured decoding to the shared contract while preserving canonical encodings/fields, widths, SP/ZR, aliases, relative addresses, availability, and invalid/undefined distinctions. Migrate justified decoder completion behavior from the existing adapter with regression coverage. Keep formatting optional.
  - Acceptance: Real ARM64 byte ranges decode through the new adapter with expected instruction identities/operands, including authentication-related and feature-gated cases from the corpus. Trailing bytes and address gaps remain explicit. Compare selected cases with an independent decoder where available and adjudicate differences; do not claim complete conformance from recognition counts. Contributes A02/A04.
  - Owner: ArmDecoder (sol-worker).
  - Evidence: `src/decoders/arm64/`, `vendor/a64js/`, conformance tests; snapshot `aa0e547ca5313779c87e1e52d75687b12e985615` with MIT/provenance hashes. Actual Mach-O → decoder smoke decoded five arithmetic instructions including the migrated logical completion. Alias/SP/ZR, PAuth, feature gating, gaps, width and split-backing tests passed. Loader profiles use canonical FP/AdvSIMD feature keys and ARM64e enables FEAT_PAuth; a reproduced PACIASP feature-disabled error now decodes as an instruction, with subtype regressions passing in the 307-test integration run.

- [x] **T10 — Implement the Darwin ARM64 ABI profile**
  - Depends on: T04.
  - Owns: `src/abi/darwin-arm64/`, Darwin ABI behavior tests.
  - Work: Extract Darwin-specific argument/return rules, preserved registers, stack alignment/arguments, scalar floating-point and supported aggregate rules, variadic behavior, and target data layout from the existing implementation and ABI evidence. Define conservative call clobbers and unsupported-contract diagnostics. Keep library-name lookup outside the ABI profile.
  - Acceptance: Fixtures establish integer/FP parameters and returns, stack arguments, preserved/clobbered state, variadic stack handling, and supported aggregate boundaries. Unknown signatures do not acquire argument counts from names. Existing applicable Darwin behavior remains represented without generic passes inspecting ARM register names. Contributes A04/A06.
  - Owner: DarwinABI (sol-worker).
  - Evidence: `src/abi/darwin-arm64/` and behavior tests; completed-component strict check and 122 focused tests passed on Node 24.22.0. Actual API smoke confirmed integer/FP layouts and callee-entry stack offsets 0/8 for arguments 9/10. Unknown counts, nontrivial/foreign conventions, HFA/HVA boundaries and partial SIMD preservation remain explicit.

- [x] **T11 — Implement the Windows x64 ABI profile**
  - Depends on: T04.
  - Owns: `src/abi/windows-x64/`, Windows ABI behavior tests.
  - Work: Implement parameter/return locations, shadow space, stack alignment/arguments, volatile/nonvolatile integer and SIMD state, scalar floating-point and supported aggregate rules, variadic behavior, and LLP64 data layout. Connect unwind metadata as evidence rather than an unconditional function/signature oracle. Explicitly reject or mark unsupported alternative conventions.
  - Acceptance: Compiler fixtures exercise register and stack parameters, shadow-space handling, FP/variadic cases, structure-return boundaries, and preserved registers. Windows `long` and pointer widths are distinct and correct. Unknown calls retain conservative memory/register effects. Contributes A05/A06.
  - Owner: WindowsABI (sol-worker).
  - Evidence: `src/abi/windows-x64/`, ABI tests and compiler-produced test-local PE fixture; focused Node 24 checks passed. Actual API smoke confirmed fifth-argument offset 40 and shadow space 32; compiler bytes establish mixed slots, aggregate returns, variadic duplication and SIMD preservation. This is ABI evidence on macOS, not a Windows-host pass.

- [x] **T14 — Implement function discovery and control-flow graph construction**
  - Depends on: T04, T06, T07, T08, T09.
  - Owns: `src/analysis/discovery/`, `src/analysis/cfg/`, discovery/CFG tests.
  - Work: Seed discovery from entry points, exports/symbols, trustworthy loader metadata, and discovered calls; traverse bounded code regions using structured decoder flow. Preserve noncontiguous ranges, data-in-code, tail calls, returns, invalid bytes, and unresolved indirect transfers. Attach function-boundary evidence and define deterministic identity changes for splits/merges.
  - Acceptance: Stripped and symbol-bearing fixtures produce expected reachable blocks/edges without linear-sweeping known data into functions. Loops, shared tails, gaps, jump-table candidates, unresolved edges, and conflicting boundary evidence remain navigable and explicit. Contributes A03.
  - Owner: DiscoveryCFG (astra-worker).
  - Evidence: `src/analysis/discovery/`, `src/analysis/cfg/`, discovery tests; compiled API smoke now finds 19 functions in the symbol-bearing Mach-O and 16 in the PE DLL, retaining arithmetic returns and explicit partial coverage for unresolved flow. T12–T16 integration fixed export-only guesses into Mach-O constants inside executable segments; symbol-bearing/stripped section data and zero-sized object symbols are covered without overriding explicit assertions. Shared tails, block splitting, calls, lineage and resource limits remain exercised.

- [x] **T18 — Port Mach-O DWARF and debug-location evidence**
  - Depends on: T06.
  - Owns: `src/metadata/dwarf/`, `src/metadata/debug/`, DWARF regression tests.
  - Work: Reuse `debug-info.ts`, `dwarf*.ts`, and applicable `decompiler-debug.ts` behavior without browser coupling. Import supported signatures/types, line/source mappings, scoped variable locations, and inline-scope evidence from local authorized debug inputs. Validate image/debug identity; keep display names separate from structural contracts and unsupported encodings explicit.
  - Acceptance: Existing applicable debug regressions retain supported signatures, scoped storage names, and source mappings. Conflicting/mismatched debug files do not silently alter semantics. Missing debug information leaves native analysis usable. No symbol-server access occurs automatically. Contributes A04/A06.
  - Owner: DebugEvidence (astra-worker).
  - Evidence: `src/metadata/dwarf/`, `src/metadata/debug/`, test-local Clang/dwarfdump fixture and regressions; Node 24 smoke recovered 4 functions, 8 core types, 9 variables, 17 source rows and 2 inline scopes. Unsupported entry-value location opcode 0xa3 remains diagnosed. Known structure fields survive missing alignment as null; UUID/CPU/content conflicts are rejected.

- [x] **T24 — Implement bounded project workers and job lifecycle**
  - Depends on: T05, T06, T07.
  - Owns: `src/workers/`, worker lifecycle/resource behavior tests.
  - Work: Run real project import/load/store work in persistent bounded child processes. Implement typed coarse-grained IPC, project write ownership, job IDs/states, progress, cancellation, queue limits, deadlines, and crash recovery. Keep synchronous SQLite and CPU work off the MCP event loop; avoid serializing whole IR graphs per instruction/request.
  - Acceptance: Actual Mach-O/PE imports execute through workers and survive close/resume. Cancellation, queued-work limits, forced worker failure, and interrupted writes produce explicit states without corrupting the project. Completed/cancelled races have deterministic outcomes, and the host remains responsive. Contributes A08/A10.
  - Owner: WorkerRuntime (astra-worker).
  - Evidence: `src/workers/`, lifecycle/protocol tests and public exports; Node 24.22.0 full typecheck, 307 tests and compiled build passed. Actual compiled API imported the PE DLL in a child, durably completed at revision 2, then closed/resumed with identical image identity and completed job. Tests cover real import boundaries, forced termination, deadlines, queue limits, ownership, cancellation/publication races and oversized IPC. Process isolation is not an OS filesystem sandbox; Windows-specific execution remains V01/T29 work.


- [x] **T12 — Port ARM64 instruction semantics to typed IR**
  - Depends on: T04, T08, T10, T14.
  - Owns: `src/lifters/arm64/`, ARM64 semantic regressions.
  - Work: Migrate supported behavior from the existing `lift.js` into typed nodes, not a C-string compatibility layer. Cover the agreed corpus's integer/control-flow, loads/stores, stack, scalar FP/common vector, flags, and call behavior. Preserve width/SP/ZR rules and explicit pointer-authentication abstraction diagnostics. Inventory unsupported families and conservatively bound them.
  - Acceptance: Applicable baseline functions retain semantic behavior and instruction provenance. Boundary checks cover carry/overflow, signed shifts/division, W-register writes, writeback, and indirect/authenticated transfers. Unsupported instructions are neither silently dropped nor converted to invented guaranteed traps. Contributes A04/A06.
  - Owner: ArmLifter (astra-worker).
  - Evidence: `src/lifters/arm64/`, semantic/corpus tests; Node 24.22.0 integration passed 452 tests, strict checking and build. All 24 real-byte semantic cases passed. Compiled load → discover → lift → SSA → simplify produced the arithmetic result 0x5a unchanged. FPCR guards, canonical-NaN/FPSR abstractions and logical pointer authentication remain explicit; unsupported families are documented in the module.

- [x] **T13 — Implement x86-64 instruction semantics in typed IR**
  - Depends on: T04, T09, T11, T14.
  - Owns: `src/lifters/x86_64/`, x86 semantic regressions.
  - Work: Lift the agreed corpus's integer/control-flow, effective-address, stack/load/store, scalar FP/common SIMD, and call instructions. Implement subregister writes, zero extension, implicit operands, flags/conditions, sign/zero extension, and relevant prefix behavior from architectural semantics. Preserve trap/undefined/unknown distinctions and declare unsupported instruction families honestly.
  - Acceptance: Semantic oracles cover AL/AH/AX/EAX/RAX interactions, arithmetic/carry/overflow, shifts with edge counts, MUL/DIV effects, conditional branches/moves, RIP-relative accesses, stack operations, and FP/vector corpus cases. Metadata about reads/writes is not used as a substitute for instruction semantics. Contributes A05/A06.
  - Owner: X86Lifter (astra-worker).
  - Evidence: `src/lifters/x86_64/`, semantic/corpus tests; the 452-test integration includes all 24 PE semantic cases and the full decoded fixture_check success path. Compiled arithmetic remained 0x5a through SSA/simplification. Partial-register/flags/division/stack cases passed; MXCSR status descriptors now agree with the ABI. FP control guards and unsupported families remain explicit. Windows-host acceptance is still separate.

- [x] **T15 — Build strings, cross-reference indexes, and bounded target recovery**
  - Depends on: T14.
  - Owns: `src/analysis/strings/`, `src/analysis/references/`, `src/analysis/targets/`.
  - Work: Reuse applicable string/reference/value-recovery behavior and extend it to PE/x86. Index code/data references, calls, imports/stubs/IAT slots, referenced strings, and supported jump-table/indirect-target patterns. Track candidate versus established references, read/write kinds, origin instruction, and unresolved edges. Keep search/pagination deterministic.
  - Acceptance: Starting from a known fixture string or imported routine locates the expected referencing function on both targets. Direct and supported indirect targets have evidence; unknown targets are not omitted or invented. Bounded searches distinguish incomplete indexing from an empty result. Contributes A03.
  - Owner: NavigationIndexes (sol-worker).
  - Evidence: `src/analysis/{strings,references,targets}/`, navigation tests; full Node 24 checks passed. Compiled Mach-O and PE navigation each linked the known string to fixture_string. Real callable-stub/IAT cases, source-instruction IDs, candidate versus established targets, bounded jump tables and cursor invalidation passed. Pointer storage is not a callable entry; unresolved edges remain visible.

- [x] **T16 — Implement SSA construction and shared value/effect analysis**
  - Depends on: T04, T14.
  - Owns: `src/analysis/ssa/`, `src/analysis/values/`, `src/analysis/effects/`.
  - Work: Build SSA over lifted register-form CFGs, including joins/loops and explicit effect ordering. Port comparison recovery, propagation, expression simplification, branch threading, and dead-assignment elimination to typed nodes. Use bounded worklists/fixed points and conservative alias/call effects. Maintain provenance and diagnostics through rewrites.
  - Acceptance: Semantic checks cover joins, loops, signed/unsigned distinctions, overflow/wrapping, flag dependencies, unknown calls, aliased stores/loads, and unreachable blocks. Eliminating a value never eliminates a required side effect, and analysis budgets yield explicit partial results. Contributes A06.
  - Owner: SSAAnalysis (astra-worker).
  - Evidence: `src/analysis/{ssa,values,effects}/`, IR state-binding/oracle integration and behavior tests; 452 tests/check/build passed. Compiled cross-target arithmetic preserved results before/after SSA and simplification. Disjoint register cells, pre-fault/call snapshots, observable exit roots, partial clobbers, joins/loops/irreducible flow, alias barriers, undefined-dominant concatenation, provenance and bounded partial results are exercised.

- [x] **V01 — Provision the supplied Windows ISO and run Windows acceptance**
  - Depends on: Integrated component milestone; full release checks follow T28.
  - Owns: Isolated VM and test artifacts under ignored `.local/windows/`.
  - Work: Install `/Users/df0/Downloads/tiny10 x64 23h2.iso` into a fresh QEMU disk; expose no host home folder or credentials. Use a read-only project snapshot and pinned Node runtime. Record real Windows command results and retain a way to rerun the final release matrix.
  - Acceptance: Windows x86-64 executes the decoder/behavior checks and compiled API smoke; later T29/T31 checks run against the completed application. No emulation-only claim substitutes for guest Windows execution.
  - Owner: WindowsVM (sol-worker).
  - Evidence: Frozen 36f3fb2 passed on Windows 10 Enterprise LTSC 10.0.19044.3324, official Node 24.22.0 win32/x64: unmodified npm run check (175 tests, typecheck/build), explicit four-process full suite, and compiled PE/ARM64 decoding smoke. QEMU 11.1.2 TCG, qemu64, one vCPU, 4096 MiB RAM; no network or host shares. Initial max/four-vCPU native crashes remain recorded; exact emulator defect is unproven. Raw exits/results are in ignored `.local/windows/evidence/guest-serial.log` and `results.json`; retained launch/refresh/rerun scripts support T29/T31. This is foundation compatibility evidence, not completed-application acceptance or native performance.
  - Follow-up: Frozen `beda23a` ran 561 checks on the same Windows guest: 557 passed, zero assertion failures, four outer-watchdog cancellations, zero skips; iced-x86 21/21, compiled build and cross-target decode smoke passed. Extended only the four observed test watchdogs, preserving production deadlines and the 200 ms blocked-worker assertion; all 16 affected macOS cases passed. Corrected Windows rerun is pending. Raw run: ignored `milestone-beda23a.json` / guest serial log; not release acceptance.

- [x] **T09 — Integrate the iced-x86 WASM decoder adapter**
  - Depends on: T02, T03.
  - Owns: `src/decoders/x86_64/`, x86 decoder conformance tests; request dependency-manifest changes through the integration owner.
  - Work: Pin the official package and adapt structured instruction identities, sizes, operands, effective addresses, prefixes, widths, implicit register/memory effects, flags metadata, and control flow. Decode bounded buffers, reuse wrappers where practical, and free all WASM-owned objects. Keep native decoder details available to the x86 lifter without exposing them as public API dependencies.
  - Acceptance: Exercise RIP-relative addressing, direct/indirect branches, partial-register writes, implicit MUL/DIV operands, flag reads/writes/undefined flags, and truncated/invalid encodings. Repeat decoding without accumulating unreleased WASM objects. The adapter runs on both planned hosts without building a native addon. Contributes A02.
  - Owner: X86Decoder (sol-worker).
  - Evidence: Implementation and macOS verification integrated: `src/decoders/x86_64/`, official iced-x86 1.21.0 WASM; lifecycle/boundary tests passed. Compiled PE → decoder smoke produced LEA, ADD, XOR, RET for the real arithmetic fixture. CMOV32 false-condition upper-half clearing was checked against architectural pseudocode; 64-bit conditional writes remain distinct.
  - Windows evidence: V01 ran the unchanged frozen foundation suite, including iced conformance/ownership tests, on Node 24.22.0 Windows x64 without a native addon. All 175 tests and compiled cross-target decoder smoke passed. Full completed-application acceptance remains T29/T31.


- [x] **T17 — Implement shared stack recovery and ABI-aware call analysis**
  - Depends on: T10, T11, T12, T13, T16.
  - Owns: `src/analysis/stack/`, `src/analysis/calls/`.
  - Work: Port useful `stack.js`/`calls.js` behavior into architecture-independent passes consuming ABI profiles and typed effects. Recover stack slots/frames, parameters, outgoing arguments, returns, nonreturning calls, and supported indirect/variadic calls. Preserve escaped stack addresses, dynamic stack changes, call-time initialization evidence, and uncertainty.
  - Acceptance: Both target corpora recover expected call arguments and stack objects without conflating Windows shadow space with locals or Darwin rules. Unknown/unsupported contracts do not invent signatures or initialized arguments; escapes and writes inhibit unsafe transformations. Contributes A04/A05/A06.
  - Owner: StackCalls (astra-worker).
  - Evidence: `src/analysis/{stack,calls}/` and behavior/corpus tests; Node 24.22.0 strict checks, 522 tests and build passed. Compiled Mach-O/PE APIs recovered the local at entry-SP−16 and all ten outgoing constants 1–10; Windows shadow space remained 32 bytes versus Darwin zero. Regressions cover exact callee-entry +40, unknown arity, partial initialization, aliases, dynamic frames, distinct outgoing/return escapes, variadic/indirect contracts, conflicts and bounded uncertainty.

- [x] **T21 — Implement emitter-neutral control-flow structuring**
  - Depends on: T16.
  - Owns: `src/presentation/`, structured-control-flow tests.
  - Work: Port CFG simplification/structuring into a presentation model for sequences, conditionals, loops, switches where established, calls, returns, and explicit labeled transfers. Preserve irreducible flow, exceptional/unknown boundaries, stable statement identity, and semantic source mappings. The model must contain no C syntax strings.
  - Acceptance: Structured output represents the same paths and side effects as the input CFG on reducible and irreducible fixtures. Unknown edges and unsupported semantics remain visible; inability to form a loop/if does not trigger invented control flow. Contributes A06/A07.
  - Owner: ControlStructuring (astra-worker).
  - Evidence: `src/presentation/`, semantic region-lowering tests; integrated 522-test checks/build passed. Compiled real loops on both targets structured five blocks and retained results 0/26 after lowering the actual presentation representation. Reducible/irreducible flow, simultaneous copies, unknown boundaries and mapping identities are exercised. Coordinator corrected reverse-topological region reduction and flattened-sequence depth accounting; the 64-block depth-bound regression passes.

- [x] **T19 — Integrate symbol names, runtime metadata, and library contracts**
  - Depends on: T06, T07, T10, T11.
  - Owns: `src/metadata/symbols/`, `src/metadata/runtime/`, `src/metadata/library-contracts/`, `src/metadata/codeview/`.
  - Work: Preserve original names and add supported demangling/display names; migrate applicable Mach-O runtime metadata and library prototype evidence. Expose PE CodeView/PDB identity references without claiming unimplemented PDB type recovery. Provide structured, ABI-specific library contracts with provenance; distinguish imported callable entries from pointer-storage slots and display declarations.
  - Acceptance: Native names remain addressable after demangling/renaming. Supported runtime metadata improves navigation without implying full Swift/Objective-C/C++ reconstruction. Pointer imports and names alone do not create function signatures; conflicting contracts are retained as conflicts. Contributes A01/A03/A06.
  - Owner: Coordinator.
  - Evidence: `src/metadata/{symbols,runtime,library-contracts,codeview}/`, real compiler fixtures with recipes/hashes and boundary tests; integrated 522-test checks/build passed. Compiled APIs recovered 25 Objective-C and 32 Swift records, all three mangling styles, the LLVM-confirmed RSDS GUID/age, and actual puts/ExitProcess contracts. Tests retain native identities, NB10 identity semantics, conflicting references/contracts, LP64/LLP64 widths, inert paths, per-field relative offsets, symbolic-string embedded NULs, section/encryption/fixup bounds and non-code IMP rejection. Swift calling conventions stay unsupported; runtime names do not imply full source layouts or PDB type recovery.

- [x] **C01 — Complete revision-safe metadata reads and annotation history storage**
  - Depends on: T05; shared prerequisite for T23/T26.
  - Owns: Core store contracts, `src/project/store/`, storage regressions.
  - Work: Prevent historical reads from exposing later loader publications; add bounded snapshot annotation/history queries and durable removal authorship with a transactional schema migration.
  - Acceptance: Historical facts remain snapshot-bound, annotation pages/history preserve identity and provenance across reopen/migration, and invalid batches/cursors do not mutate state.
  - Owner: Coordinator.
  - Evidence: Focused strict typecheck and all ten store/history regressions passed on Node 24.22.0. The actual API probe changed a future-metadata leak to not_found at the pre-publication revision. A project created by compiled 00f5e15 migrated from persistence schema 1 to 2, retained old snapshots and a wire-schema-1 artifact, and preserved new set/retract/remove actors across reopen; old removal actors remain null. Empty versus omitted ID-filter cursor collisions are rejected. Full combined wave verification follows T20/T26.

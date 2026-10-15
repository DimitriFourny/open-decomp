## Todo

The design contract is [PLAN.md](PLAN.md). All tasks below are planned, not implemented. Task IDs are stable; move whole task blocks between the three board sections rather than duplicating them.

### Assignment and integration rules

- A task is ready only when every task in its `Depends on` field is integrated and in `Done`. `None` means no prerequisite.
- On assignment, move the block to `Doing` and add `Owner`. On completion, record changed paths and verification evidence before moving it to `Done`. Keep blockers explicit.
- Give each subagent PLAN.md, its full task block, and the completed dependency contracts. The agent owns investigation and implementation within that slice; it must not invent a second interface or edit sibling-owned modules without coordination.
- One integration owner controls `src/core/` contracts, dependency manifests, shared fixture manifests, and cross-slice integration. Request contract changes rather than silently changing another task's assumptions.
- Agents prepare behavior tests but skip repository-wide builds, lint, tests, and formatters while a wave is in flight. The integration owner runs combined checks once after the wave, exercises the actual changed path, and resolves failures before marking tasks done.
- Acceptance means working behavior, not stubs, mock echoes, compilation alone, or source-text assertions. Reuse relevant existing regressions; do not pin incidental pseudocode wording.
- First-release work is T01–T31 and must satisfy PLAN.md A01–A12. F01–F03 are explicitly later extensions. Future work does not excuse unfinished first-release behavior.
- Initial concurrency: after T01, T02 and T03 can proceed independently. After their contracts/fixtures land, store, loader, and decoder slices can proceed independently; ABI and lifter tasks follow the IR contract. Use the dependency graph, not task-number order, to schedule subsequent waves.

### Foundation and contracts

- [ ] **T01 — Establish the TypeScript project and runnable development toolchain**
  - Depends on: None.
  - Owns: `package.json`, lockfile, TypeScript configuration, development/build scripts, initial `src/` and `test/` layout.
  - Work: Set up strict TypeScript, ESM, pinned Node 24 LTS tooling, npm, compiled distribution, `tsx` development execution, and `node:test`. Enable strict optional/indexed-access handling. Establish commands for build, type checking, behavior tests, and smoke clients without creating fake analysis endpoints. Keep first-party implementation TypeScript.
  - Acceptance: A clean checkout installs reproducibly and compiles/runs a real TypeScript module and test client under the pinned runtime. Production imports resolve from built output rather than the source checkout. No dependency on files outside this repository is required by the toolchain.

- [ ] **T02 — Establish redistributable fixtures and the ARM64 behavioral baseline**
  - Depends on: T01.
  - Owns: `fixtures/`, fixture manifest/build recipes, `test/fixtures/`, baseline migration checks.
  - Work: Inspect the existing `../disass_arm/test/` behavior coverage and capture applicable ARM64 results before migration. Provide small real Mach-O ARM64 and PE32+ x86-64 executables/libraries, stripped and symbol-bearing variants, an ARM64 fat-container case, and malformed/boundary fixtures. Record source, tool versions, flags, hashes, expected semantics, and redistribution terms. Include integer/control-flow, stack/calls, memory, scalar floating-point, and common vector examples; build the exact semantic inventory used by later lifters. Supply an isolated test-only semantic oracle/evaluator strategy, never target execution in the service.
  - Acceptance: A fixture manifest resolves every input and expected behavior; rebuilding or verifying checked-in fixtures is documented. The existing ARM64 decompiler has been exercised directly on the applicable corpus with recorded capabilities/gaps. Tests can run without private binaries, network access, or an installed cross-compiler when prebuilt fixtures are provided.

- [ ] **T03 — Define shared identities, addresses, evidence, and service contracts**
  - Depends on: T01.
  - Owns: `src/core/`, shared schema definitions, contract fixtures.
  - Work: Define project/image/slice/entity IDs; address spaces and validated translation inputs; target/ABI/features; structured diagnostics; evidence origins; capability/completeness states; revision and job identities; query paging and artifact references. Define loader, architecture-specific decoder payload, ABI, emitter, store, worker-command, and service-operation boundaries. Publish the exact arguments/results for the tools listed in PLAN.md, with reusable runtime schema validation and lossless bigint wire codecs.
  - Acceptance: Contract checks distinguish VA/RVA/file offsets, reject unsafe numeric addresses, round-trip full-width unsigned values, and separate empty/partial/unsupported/failed/cancelled results. Schemas cover all planned tools and revision-bound cursors without MCP types leaking into the core. Architecture-specific decoder information is not flattened into assembly text or a least-common-denominator operand type.

- [ ] **T04 — Implement typed semantic IR, provenance, and invariant verification**
  - Depends on: T02, T03.
  - Owns: `src/ir/`, IR behavior/invariant tests.
  - Work: Implement discriminated semantic nodes, typed builders, bit-vector widths, register slices, float/vector types, memory/effect ordering, flags, calls, branches, and unknown-effect boundaries. Define register-form lifting and shared SSA/CFG interfaces, stable value/block identities, and source provenance. Provide validation and semantic fixture evaluation for supported primitives; do not use C-expression strings as IR.
  - Acceptance: The verifier rejects incompatible widths, invalid value/block references, broken control-flow arity, and illegal effect ordering. Semantic checks exercise wrapping, extension, signed operations, register slices, and memory effects. Provenance survives replacement/combination of nodes, and unsupported effects cannot be mistaken for a no-op or established trap.

### Independent loading, decoding, storage, and ABI slices

- [ ] **T05 — Implement durable project storage and immutable image import**
  - Depends on: T03.
  - Owns: `src/project/store/`, schema migrations, project-store behavior tests.
  - Work: Implement SQLite persistence behind the store contract using the pinned runtime's `node:sqlite` API. Import one immutable project-owned snapshot per content identity, record selected slices, and store entities/evidence/revisions/artifact metadata losslessly. Add transactional mutation primitives, versioned migrations, conservative project locking, and atomic artifact publication. Do not expose arbitrary SQL.
  - Acceptance: Import, close, and reopen preserve identity and facts; changed input bytes produce a new identity without overwriting the old image. Full-width addresses survive persistence. Interrupted transactions/artifact writes do not publish partial state; newer unsupported schema versions fail without modifying the project.

- [ ] **T06 — Port Mach-O ARM64 loading and address mapping**
  - Depends on: T02, T03.
  - Owns: `src/loaders/macho/`, Mach-O loader tests.
  - Work: Reuse applicable behavior from `executable.ts`, `dyld.ts`, `imports.ts`, `image-memory.ts`, and `address.ts` in the existing project. Support thin/fat containers and explicit ARM64 slice selection; expose headers/load commands, segments/sections, entry points, symbols, imports/exports, relocations/bindings/fixups, function starts, unwind hints, and data-in-code boundaries. Preserve loader evidence and unsupported-format diagnostics. Remove browser/UI coupling.
  - Acceptance: Fixture metadata and VA/file translations match independently established expectations, including zero-filled memory and nontrivial image bases. Ambiguous slices, truncated commands, invalid ranges, and unsupported subtype/features are explicit. The loader never decodes embedded data simply because its section is executable. Contributes A01.

- [ ] **T07 — Implement PE32+ x86-64 loading and address mapping**
  - Depends on: T02, T03.
  - Owns: `src/loaders/pe/`, PE loader tests.
  - Work: Parse DOS/PE/COFF/optional headers, sections/data directories, image mapping and entry point, imports including ordinal/delay imports, exports including forwarders, base relocations, exception/unwind records, TLS metadata, and debug-directory references. Retain raw offsets and evidence. Identify managed/unsupported inputs without pretending their bodies are supported native code.
  - Acceptance: Native EXE/DLL fixtures expose correct headers/imports/exports and distinguish RVA, VA, and file offsets; virtual zero-fill and file-backed bounds are correct. Malformed counts/ranges, missing directory data, and unsupported machine types fail or report partial data explicitly. No target DLL is loaded. Contributes A01.

- [ ] **T08 — Integrate and pin the a64js decoder adapter**
  - Depends on: T02, T03.
  - Owns: `src/decoders/arm64/`, `vendor/a64js/`, ARM64 decoder conformance fixtures.
  - Work: Import a pinned source snapshot from the existing a64js checkout with provenance and license notices, not a runtime `../` import. Adapt structured decoding to the shared contract while preserving canonical encodings/fields, widths, SP/ZR, aliases, relative addresses, availability, and invalid/undefined distinctions. Migrate justified decoder completion behavior from the existing adapter with regression coverage. Keep formatting optional.
  - Acceptance: Real ARM64 byte ranges decode through the new adapter with expected instruction identities/operands, including authentication-related and feature-gated cases from the corpus. Trailing bytes and address gaps remain explicit. Compare selected cases with an independent decoder where available and adjudicate differences; do not claim complete conformance from recognition counts. Contributes A02/A04.

- [ ] **T09 — Integrate the iced-x86 WASM decoder adapter**
  - Depends on: T02, T03.
  - Owns: `src/decoders/x86_64/`, x86 decoder conformance tests; request dependency-manifest changes through the integration owner.
  - Work: Pin the official package and adapt structured instruction identities, sizes, operands, effective addresses, prefixes, widths, implicit register/memory effects, flags metadata, and control flow. Decode bounded buffers, reuse wrappers where practical, and free all WASM-owned objects. Keep native decoder details available to the x86 lifter without exposing them as public API dependencies.
  - Acceptance: Exercise RIP-relative addressing, direct/indirect branches, partial-register writes, implicit MUL/DIV operands, flag reads/writes/undefined flags, and truncated/invalid encodings. Repeat decoding without accumulating unreleased WASM objects. The adapter runs on both planned hosts without building a native addon. Contributes A02.

- [ ] **T10 — Implement the Darwin ARM64 ABI profile**
  - Depends on: T04.
  - Owns: `src/abi/darwin-arm64/`, Darwin ABI behavior tests.
  - Work: Extract Darwin-specific argument/return rules, preserved registers, stack alignment/arguments, scalar floating-point and supported aggregate rules, variadic behavior, and target data layout from the existing implementation and ABI evidence. Define conservative call clobbers and unsupported-contract diagnostics. Keep library-name lookup outside the ABI profile.
  - Acceptance: Fixtures establish integer/FP parameters and returns, stack arguments, preserved/clobbered state, variadic stack handling, and supported aggregate boundaries. Unknown signatures do not acquire argument counts from names. Existing applicable Darwin behavior remains represented without generic passes inspecting ARM register names. Contributes A04/A06.

- [ ] **T11 — Implement the Windows x64 ABI profile**
  - Depends on: T04.
  - Owns: `src/abi/windows-x64/`, Windows ABI behavior tests.
  - Work: Implement parameter/return locations, shadow space, stack alignment/arguments, volatile/nonvolatile integer and SIMD state, scalar floating-point and supported aggregate rules, variadic behavior, and LLP64 data layout. Connect unwind metadata as evidence rather than an unconditional function/signature oracle. Explicitly reject or mark unsupported alternative conventions.
  - Acceptance: Compiler fixtures exercise register and stack parameters, shadow-space handling, FP/variadic cases, structure-return boundaries, and preserved registers. Windows `long` and pointer widths are distinct and correct. Unknown calls retain conservative memory/register effects. Contributes A05/A06.

### Homemade lifting and shared analysis

- [ ] **T12 — Port ARM64 instruction semantics to typed IR**
  - Depends on: T04, T08, T10.
  - Owns: `src/lifters/arm64/`, ARM64 semantic regressions.
  - Work: Migrate supported behavior from the existing `lift.js` into typed nodes, not a C-string compatibility layer. Cover the agreed corpus's integer/control-flow, loads/stores, stack, scalar FP/common vector, flags, and call behavior. Preserve width/SP/ZR rules and explicit pointer-authentication abstraction diagnostics. Inventory unsupported families and conservatively bound them.
  - Acceptance: Applicable baseline functions retain semantic behavior and instruction provenance. Boundary checks cover carry/overflow, signed shifts/division, W-register writes, writeback, and indirect/authenticated transfers. Unsupported instructions are neither silently dropped nor converted to invented guaranteed traps. Contributes A04/A06.

- [ ] **T13 — Implement x86-64 instruction semantics in typed IR**
  - Depends on: T04, T09, T11.
  - Owns: `src/lifters/x86_64/`, x86 semantic regressions.
  - Work: Lift the agreed corpus's integer/control-flow, effective-address, stack/load/store, scalar FP/common SIMD, and call instructions. Implement subregister writes, zero extension, implicit operands, flags/conditions, sign/zero extension, and relevant prefix behavior from architectural semantics. Preserve trap/undefined/unknown distinctions and declare unsupported instruction families honestly.
  - Acceptance: Semantic oracles cover AL/AH/AX/EAX/RAX interactions, arithmetic/carry/overflow, shifts with edge counts, MUL/DIV effects, conditional branches/moves, RIP-relative accesses, stack operations, and FP/vector corpus cases. Metadata about reads/writes is not used as a substitute for instruction semantics. Contributes A05/A06.

- [ ] **T14 — Implement function discovery and control-flow graph construction**
  - Depends on: T04, T06, T07, T08, T09.
  - Owns: `src/analysis/discovery/`, `src/analysis/cfg/`, discovery/CFG tests.
  - Work: Seed discovery from entry points, exports/symbols, trustworthy loader metadata, and discovered calls; traverse bounded code regions using structured decoder flow. Preserve noncontiguous ranges, data-in-code, tail calls, returns, invalid bytes, and unresolved indirect transfers. Attach function-boundary evidence and define deterministic identity changes for splits/merges.
  - Acceptance: Stripped and symbol-bearing fixtures produce expected reachable blocks/edges without linear-sweeping known data into functions. Loops, shared tails, gaps, jump-table candidates, unresolved edges, and conflicting boundary evidence remain navigable and explicit. Contributes A03.

- [ ] **T15 — Build strings, cross-reference indexes, and bounded target recovery**
  - Depends on: T14.
  - Owns: `src/analysis/strings/`, `src/analysis/references/`, `src/analysis/targets/`.
  - Work: Reuse applicable string/reference/value-recovery behavior and extend it to PE/x86. Index code/data references, calls, imports/stubs/IAT slots, referenced strings, and supported jump-table/indirect-target patterns. Track candidate versus established references, read/write kinds, origin instruction, and unresolved edges. Keep search/pagination deterministic.
  - Acceptance: Starting from a known fixture string or imported routine locates the expected referencing function on both targets. Direct and supported indirect targets have evidence; unknown targets are not omitted or invented. Bounded searches distinguish incomplete indexing from an empty result. Contributes A03.

- [ ] **T16 — Implement SSA construction and shared value/effect analysis**
  - Depends on: T04, T14.
  - Owns: `src/analysis/ssa/`, `src/analysis/values/`, `src/analysis/effects/`.
  - Work: Build SSA over lifted register-form CFGs, including joins/loops and explicit effect ordering. Port comparison recovery, propagation, expression simplification, branch threading, and dead-assignment elimination to typed nodes. Use bounded worklists/fixed points and conservative alias/call effects. Maintain provenance and diagnostics through rewrites.
  - Acceptance: Semantic checks cover joins, loops, signed/unsigned distinctions, overflow/wrapping, flag dependencies, unknown calls, aliased stores/loads, and unreachable blocks. Eliminating a value never eliminates a required side effect, and analysis budgets yield explicit partial results. Contributes A06.

- [ ] **T17 — Implement shared stack recovery and ABI-aware call analysis**
  - Depends on: T10, T11, T12, T13, T16.
  - Owns: `src/analysis/stack/`, `src/analysis/calls/`.
  - Work: Port useful `stack.js`/`calls.js` behavior into architecture-independent passes consuming ABI profiles and typed effects. Recover stack slots/frames, parameters, outgoing arguments, returns, nonreturning calls, and supported indirect/variadic calls. Preserve escaped stack addresses, dynamic stack changes, call-time initialization evidence, and uncertainty.
  - Acceptance: Both target corpora recover expected call arguments and stack objects without conflating Windows shadow space with locals or Darwin rules. Unknown/unsupported contracts do not invent signatures or initialized arguments; escapes and writes inhibit unsafe transformations. Contributes A04/A05/A06.

### Metadata, presentation, and durable annotations

- [ ] **T18 — Port Mach-O DWARF and debug-location evidence**
  - Depends on: T06.
  - Owns: `src/metadata/dwarf/`, `src/metadata/debug/`, DWARF regression tests.
  - Work: Reuse `debug-info.ts`, `dwarf*.ts`, and applicable `decompiler-debug.ts` behavior without browser coupling. Import supported signatures/types, line/source mappings, scoped variable locations, and inline-scope evidence from local authorized debug inputs. Validate image/debug identity; keep display names separate from structural contracts and unsupported encodings explicit.
  - Acceptance: Existing applicable debug regressions retain supported signatures, scoped storage names, and source mappings. Conflicting/mismatched debug files do not silently alter semantics. Missing debug information leaves native analysis usable. No symbol-server access occurs automatically. Contributes A04/A06.

- [ ] **T19 — Integrate symbol names, runtime metadata, and library contracts**
  - Depends on: T06, T07, T10, T11.
  - Owns: `src/metadata/symbols/`, `src/metadata/runtime/`, `src/metadata/library-contracts/`, `src/metadata/codeview/`.
  - Work: Preserve original names and add supported demangling/display names; migrate applicable Mach-O runtime metadata and library prototype evidence. Expose PE CodeView/PDB identity references without claiming unimplemented PDB type recovery. Provide structured, ABI-specific library contracts with provenance; distinguish imported callable entries from pointer-storage slots and display declarations.
  - Acceptance: Native names remain addressable after demangling/renaming. Supported runtime metadata improves navigation without implying full Swift/Objective-C/C++ reconstruction. Pointer imports and names alone do not create function signatures; conflicting contracts are retained as conflicts. Contributes A01/A03/A06.

- [ ] **T20 — Implement recovered types and constraint/evidence handling**
  - Depends on: T17, T18, T19.
  - Owns: `src/analysis/types/`, type-recovery behavior tests.
  - Work: Port type recovery onto typed IR and combine memory access shapes, ABI rules, debug types, library contracts, and explicit annotations. Represent pointers, arrays, structures/fields, signatures, and scalar/vector types within supported semantics. Separate machine widths from reconstructed source types, and track why each constraint exists.
  - Acceptance: Structure/field and signature recovery improves fixture decompilation while respecting offsets, widths, aliases, and both data layouts. Conflicting evidence is surfaced, user assertions remain labeled, and names or isolated casts cannot establish object sizes/types without evidence. Contributes A06/A08.

- [ ] **T21 — Implement emitter-neutral control-flow structuring**
  - Depends on: T16.
  - Owns: `src/presentation/`, structured-control-flow tests.
  - Work: Port CFG simplification/structuring into a presentation model for sequences, conditionals, loops, switches where established, calls, returns, and explicit labeled transfers. Preserve irreducible flow, exceptional/unknown boundaries, stable statement identity, and semantic source mappings. The model must contain no C syntax strings.
  - Acceptance: Structured output represents the same paths and side effects as the input CFG on reducible and irreducible fixtures. Unknown edges and unsupported semantics remain visible; inability to form a loop/if does not trigger invented control flow. Contributes A06/A07.

- [ ] **T22 — Implement C-like pseudocode emission and instruction mappings**
  - Depends on: T20, T21.
  - Owns: `src/emitters/c/`, emitter interface implementation and behavioral mapping tests.
  - Work: Port useful emission/presentation/runtime-helper behavior into the first emitter. Handle precedence, declarations, signedness/widths, identifiers, structures/signatures, labels, and helper explanations. Emit text plus statement/span-to-IR/instruction mappings and explicit reconstruction/coverage diagnostics. Formatting must not perform semantic analysis.
  - Acceptance: Both target corpora yield readable C-like output with correct expression grouping and observable semantics. Mappings still identify original instructions after simplification; names are escaped without losing original identities. Outputs do not claim to be original or necessarily recompilable C. Tests assert semantics/mappings, not incidental wording. Contributes A07.

- [ ] **T23 — Implement transactional annotation edits and revision semantics**
  - Depends on: T05, T20.
  - Owns: `src/project/annotations/`, revision/conflict/invalidation contract tests.
  - Work: Implement atomic name, note, type/structure, and signature edits using stable IDs and `expected_revision`. Store author/origin, evidence references, and assertion status; support retraction/removal without deleting immutable binary facts. Produce conservative dependency invalidation signals and preserve edit history.
  - Acceptance: A successful batch advances revision once; a stale or invalid batch makes no partial edits. Names/types/notes and provenance survive reopen. Retraction removes the assertion from subsequent analysis rather than leaving stale inferred facts, and function-ID changes do not silently reattach notes to unrelated entities. Contributes A08.

### Worker execution, service, and MCP integration

- [ ] **T24 — Implement bounded project workers and job lifecycle**
  - Depends on: T05, T06, T07.
  - Owns: `src/workers/`, worker lifecycle/resource behavior tests.
  - Work: Run real project import/load/store work in persistent bounded child processes. Implement typed coarse-grained IPC, project write ownership, job IDs/states, progress, cancellation, queue limits, deadlines, and crash recovery. Keep synchronous SQLite and CPU work off the MCP event loop; avoid serializing whole IR graphs per instruction/request.
  - Acceptance: Actual Mach-O/PE imports execute through workers and survive close/resume. Cancellation, queued-work limits, forced worker failure, and interrupted writes produce explicit states without corrupting the project. Completed/cancelled races have deterministic outcomes, and the host remains responsive. Contributes A08/A10.

- [ ] **T25 — Integrate the complete decompilation pipeline and revision-aware cache**
  - Depends on: T15, T22, T23, T24.
  - Owns: `src/service/analysis/`, `src/project/cache/`, pipeline integration cases.
  - Work: Connect loaders, discovery, architecture lifters, ABI/metadata evidence, shared passes, presentation, and emission into real per-function analysis jobs. Implement completeness reporting and caches keyed by input identity, versions, features/ABI, analysis policy, revisions, and emitter options. Publish results atomically and prevent old-revision jobs from becoming current after edits.
  - Acceptance: The service decompiles real functions for both targets without using an external decompiler. Repeated requests use valid cached results; annotation edits/retractions and option/version changes invalidate them. Cancellation/crashes never publish partial artifacts as complete. ARM64 behavior no longer relies on a legacy C-string pipeline or sibling runtime import. Contributes A04–A08.

- [ ] **T26 — Implement bounded project inspection and navigation services**
  - Depends on: T15, T18, T19, T24.
  - Owns: `src/service/queries/`, query/result and artifact-access behavior tests.
  - Work: Implement project open/close, binary-info views, symbol/string/function searches, function metadata/disassembly/CFG views, references, and bounded byte/typed reads. Add deterministic ordering, server-side filtering, revision-bound cursors, and project-scoped artifact retrieval. Reuse loader address translation and indexes; do not introduce a second program model.
  - Acceptance: A direct client navigates from import/string to referencing function and reads correct headers, disassembly, CFG, and bytes on both targets. Pagination covers results without duplication/omission at a fixed revision and rejects stale cursors. Unmapped/zero-filled data, incomplete indexes, and truncation are explicit. Contributes A01/A03/A08.

- [ ] **T27 — Expose the complete local MCP tool surface**
  - Depends on: T23, T25, T26.
  - Owns: `src/mcp/`, compiled server entry point, deterministic stdio smoke client.
  - Work: Use the official TypeScript SDK to publish every tool named in PLAN.md with validated input/output schemas and structured results. Connect real project/query/analysis/annotation operations, job status/cancel, progress where supported, and bounded artifact/resource reads. Add an actual launch command; reserve stdout for protocol traffic and send diagnostics to stderr.
  - Acceptance: Launch the compiled server and discover/call its tools through a real MCP client. For each target, open → inspect/search → follow references → decompile → annotate → reanalyze → close/resume succeeds with correct revisions/evidence. Long jobs can be inspected/cancelled without depending on optional client extensions. No mock backend, generic shell, or arbitrary SQL tool is exposed. Contributes A09.

### Integration, containment, and delivery

- [ ] **T28 — Verify input containment and enforce resource/error boundaries**
  - Depends on: T27.
  - Owns: containment integration cases and documented limits; coordinate fixes in owning modules rather than duplicating validation.
  - Work: Exercise authorized-root checks, canonical/symlink paths, project/artifact isolation, parser arithmetic/count limits, work/IR/output budgets, cancellation, crashes, and transactional recovery through the real service. Check that strings/symbols/notes remain data and that no target execution, dynamic target-library load, remote fetch, or arbitrary file access is reachable. Document actual worker/OS restrictions without overstating sandbox guarantees.
  - Acceptance: Hostile/malformed fixtures and denied paths produce bounded, typed errors; unrelated project artifacts remain inaccessible. Worker termination cannot corrupt saved analysis, flood stdout, or leave requests hanging indefinitely. Existing legitimate binaries still complete their workflows. Contributes A10.

- [ ] **T29 — Run cross-target and cross-host release acceptance**
  - Depends on: T28.
  - Owns: end-to-end acceptance suite, host verification configuration, release evidence.
  - Work: Execute PLAN.md A01–A11 with real fixtures and the compiled MCP server on macOS arm64 and Windows x86-64. Each host analyzes both target formats without running the target. Include stripped/symbol-bearing cases, persistence, annotation-driven reanalysis, unsupported semantics, malformed files, source mappings, cancellation, and decoder/ABI semantic regressions. Integrate outstanding migration fixes and remove obsolete migration scaffolding.
  - Acceptance: Record actual commands/scenarios and outcomes for the complete matrix; unavailable host execution is an explicit blocker, not an inferred pass. All required behavior works without `../disass_arm`, private inputs, undeclared developer tools, or a public decompiler. Contributes A01–A11.

- [ ] **T30 — Measure end-to-end performance and resource bounds**
  - Depends on: T29.
  - Owns: benchmark workloads/harness and performance evidence; coordinate implementation fixes with owning modules.
  - Work: Measure cold import/indexing, per-function decode/lift/analysis/emission, cached queries, IPC/serialization, and peak memory for representative small/large binaries on recorded hosts. Check bounded concurrency and WASM lifecycle under sustained use. Optimize only measured bottlenecks, preserving semantic regression results; document practical limits and regression methodology.
  - Acceptance: Reproducible reports distinguish stages, cold/warm behavior, binary sizes, runtime/hardware, and memory. Work/output limits are exercised, sustained jobs do not accumulate unbounded resources, and any claimed improvement has before/after evidence. Do not claim a Rust-vs-JS speed ratio without a comparable implementation. Contributes A12.

- [ ] **T31 — Package and document the first local release**
  - Depends on: T29, T30.
  - Owns: distribution scripts/metadata, user/developer documentation, license/provenance notices, final backlog/plan status updates.
  - Work: Produce the compiled installable application and document local MCP launch/configuration, project lifecycle, tool schemas, annotation/evidence rules, limits, supported semantic families, and troubleshooting. Include decoder revisions/licenses, a64js generated-data provenance review, fixture redistribution notices, update procedures, and benchmark/host verification evidence. Do not bundle separately licensed Arm reference downloads.
  - Acceptance: Install from the produced artifact in a clean environment on both hosts and complete a real MCP investigation without source-tree/sibling dependencies. All A01–A12 have recorded evidence; documentation distinguishes shipped behavior from future work. No obsolete aliases, duplicate legacy pipeline, or migration-only scaffold remains.

### Later extensions — not first-release blockers

- [ ] **F01 — Add a Python-like pseudocode emitter**
  - Depends on: T31.
  - Owns: `src/emitters/python-like/`, emitter selection/capability integration and semantic mapping cases.
  - Work: Define a readable Python-like pseudocode dialect over the existing presentation model. Make finite-width arithmetic, loads/stores, labels/unstructured flow, and unknown effects explicit; do not imply ordinary Python runtime semantics. Add emitter selection and versioned cache identity without changing the semantic pipeline.
  - Acceptance: The same analyzed functions render in both styles with equivalent effects and source mappings. No decoder/lifter/type-recovery fork is introduced, and the output is clearly labeled pseudocode rather than recovered or directly executable Python.

- [ ] **F02 — Add authenticated MCP Streamable HTTP transport**
  - Depends on: T31.
  - Owns: HTTP transport, authorization integration, remote deployment documentation and security scenarios.
  - Work: Reuse the same service/tools with authentication, project authorization, origin/DNS-rebinding protection, conservative binding defaults, bounded uploads/import access if offered, and request/work quotas. Define remote artifact and job access under the same identity. Keep transport lifecycle separate from persisted project identity.
  - Acceptance: An authorized client completes the existing workflow remotely; unauthenticated/cross-project access, malicious origins, and resource abuse are rejected. Local stdio behavior remains intact, and no custom public socket protocol is required.

- [ ] **F03 — Extend to another explicit format/ISA/ABI target**
  - Depends on: T31.
  - Gate: Select the next target combination and representative semantic corpus before assigning implementation; no target is assumed by this task.
  - Owns: The selected loader/decoder/lifter/ABI additions and their conformance/acceptance corpus.
  - Work: Add only the components required by the selected combination, reusing existing semantic analysis, persistence, tools, and emitters. Publish exact capabilities and unsupported cases. If replacing a decoder, implement its architecture adapter and adjudicate semantic conformance rather than assuming a drop-in swap.
  - Acceptance: The complete investigation workflow works for the selected target with evidence-backed semantics, and existing targets remain correct. Public tools require no architecture-specific command fork.

## Doing

No implementation tasks are currently assigned.

## Done

No implementation tasks have been completed.

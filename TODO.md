# Decompiler output-quality roadmap

## Goal and rules

Reach Ghidra-quality output on the supported target matrix, then outperform it on measured correctness, readability, coverage, and investigation workflows. These are implementation goals, not current capabilities or a promise to beat Ghidra on every binary.

- Correctness before prettiness; useful coverage before latency claims.
- Source semantics and independently inspected instructions are the oracle. Ghidra is a comparator, not ground truth: the comparison also found omitted arguments and awkward FP return types in its output.
- Keep one shared reconstruction pipeline for C-like and Python-like output. Fix IR, analysis, source projection, and structured rendering; do not repair generated text with regexes or add fixture-name special cases.
- Preserve fixed-width arithmetic, signedness, memory/call ordering, aliasing, and explicit unknowns. Never make unsupported code look supported by dropping effects or warnings.
- Reuse existing ABI, type/evidence, annotation, graph, and cache contracts. File paths below identify investigation/implementation surfaces, not proven root causes.

## Observed baseline

The local comparison used identical symbol-bearing Mach-O ARM64 binaries, without supplied source/types or adjacent debug files: the native corpus and Homebrew SQLite 3.54.0. The matching SQLite source archive was hash-checked against Homebrew's recipe. This is not yet a cross-architecture ranking.

| Default-budget result                    | Open Decomp | Ghidra MCP |
| ---------------------------------------- | ----------: | ---------: |
| Corpus functions returning text          |       15/16 |      16/16 |
| Selected SQLite functions returning text |        2/10 |      10/10 |

Returning text is not a correctness result. Raised Open Decomp budgets recovered the missing outputs, but exposed semantic defects and retained partial results.

Retained evidence: `/tmp/open-decomp-ghidra-compare.sfUkLc/` (`comparison.json`, `quality-review.json`, both tools' raw results, emitted `.c` files, source/disassembly references, and reproduction settings). This temporary location is not durable regression storage. The Ghidra comparator was 12.1.4 through xjoker/ghidra-mcp commit `73ea1c8eaa4bb364f7338f8180e623583bb1d340`.

## P0 — Stop emitting incorrect source-level behavior

These block a quality-parity claim. Diagnose and fix each at its owning layer before simplifying its output.

### Control flow, exits, and phi transfers

- [x] Minimize and fix the raised-budget `sqlite3_strnicmp` failure: the mismatch calculation is emitted after an unconditional `return 0`, although the underlying semantic state is `complete`. Trace the reachable native CFG through SSA, structured regions, reconstruction, and rendering to find the first incorrect transition.
  - Acceptance: mismatching non-NULL inputs reach the character-difference result; equal prefixes and exhausted counts return zero; NULL ordering, empty strings, negative counts, first-byte mismatches, and mismatches after several iterations match the source oracle.
- [x] Validate structured branch/loop exits, return placement, and edge-specific parallel copies. Preserve loop-carried values, short-circuit behavior, multiple exits, and cyclic phi transfers. Use explicit labels/gotos when needed to preserve a graph; do not force an attractive but incorrect structured shape.
  - Acceptance: every reachable source CFG edge/effect has an equivalent representation; no reachable computation is stranded after a terminating statement; no path uses an undefined synthesized local.

Surfaces: `src/analysis/cfg/`, `src/analysis/ssa/`, `src/presentation/`, `src/reconstruction/`, `src/emitters/renderer.ts`; behavioral cases in `test/presentation/`, `test/reconstruction/`, and emitter control tests.

### Incoming arguments are not local stack storage

- [x] Fix `fixture_stack_args`: recover all ten inputs and the weighted sum. The current output declares eight inputs and reads the other two from an uninitialized local `stack_frame`.
- [ ] Separate callee-entry incoming stack slots, outgoing call arguments, saved registers, private locals, and escaped/aliased storage throughout source projection. Model SP adjustments and frame-pointer aliases without reclassifying incoming bytes as freshly allocated local memory.
  - Acceptance: the ten-argument example returns 385 for arguments 1 through 10; high-bit/overflow cases retain 64-bit behavior. Cover framed/frameless functions, alignment, mixed register/stack arguments, Windows shadow space, SysV return-address offsets/red-zone rules, and Darwin stack varargs.
  - Unknown incoming slots must remain explicit inputs/unknown incoming storage, never silently become uninitialized private locals. Promote actual locals only with definite initialization and valid alias/escape evidence.

Surfaces: `src/analysis/stack/`, `src/analysis/calls/`, `src/abi/`, `src/reconstruction/source-planner.ts`, `src/reconstruction/source-stack.ts`.

### FP/vector inputs, results, and computations

- [x] Fix `fixture_float`: recover two floating inputs and the result of `a * 1.5 + b * 0.5`. Do not project an unrelated integer argument as the return value. Track FP/SIMD register banks and scalar lane widths independently of integer-register inference.
- [ ] Fix variadic FP reconstruction and preserve vector lane operations through source projection. Cover the Darwin stack-based double sum, count-zero path, scalar/vector returns, mixed integer/FP calls, and vector stores.
  - Acceptance: finite supported-environment cases match the independent oracle; FP arithmetic remains live all the way to its actual result or memory effect. A scalar double return must not become a whole SIMD-register aggregate.
  - Keep FPCR/MXCSR, exceptional-value, rounding, underflow, and trap limitations honest. Retain the supported expression under explicit assumptions; do not erase it or claim unsupported environments are modeled.

Surfaces: `src/lifters/arm64/`, `src/lifters/x86_64/`, `src/abi/`, `src/reconstruction/source-planner.ts`, `src/reconstruction/source-model.ts`, and FP/vector expression rendering.

### Publication invariants and regression evidence

- [ ] Reject or explicitly mark reconstruction failures when internal reachability, def-use, incoming-storage, or result-projection invariants fail. Preserve diagnostic evidence instead of publishing plausible incorrect code without qualification.
  - Acceptance: the current `sqlite3_strnicmp` and incoming-stack defects cannot pass the relevant invariant checks unnoticed. Keep bounded-operation completion distinct from semantic coverage and from any future validation status; `complete` is not an equivalence proof.
- [ ] Turn the observed failures into source-backed, end-to-end regression cases before changing the affected passes. Check both output dialects from the same reconstructed representation.
  - Compare observable return values, memory writes, call arguments/order, and branch outcomes using an independent source oracle and a reconstruction evaluator or supported executable-output subset. IR-only checks cannot establish that rendering preserved behavior.
  - Execute only trusted source-built fixtures in an isolated developer harness, never arbitrary analyzed inputs or production targets. Exclude undefined source inputs and state the supported FP environment.
  - Use semantic assertions, not snapshots of Ghidra wording, temporary counts, or formatting. A helper identity or self-comparison is not an independent oracle.

## P1 — Reach useful Ghidra parity on the measured workload

### Call interfaces and interprocedural inference

- [ ] Recover the second input and actual passed argument in `fixture_indirect`, then reconstruct callback parameters/results without substituting `unknown_arguments()` when the dataflow establishes them.
- [ ] Improve bounded native-callee summaries and caller/callee constraint propagation, including recursion, tail calls, preserved arguments, result widths, and mixed register/stack locations. Keep direct calls out of intraprocedural traversal and use an explicit bounded dependency worklist for interprocedural analysis.
- [ ] Recover the concrete interfaces around `sqlite3_changes64`, `sqlite3_total_changes64`, `sqlite3_errcode`, `sqlite3_limit`, and `sqlite3_complete`: safety checks, logging, mutex callbacks, and full-width `sqlite3_incomplete` results.
  - Acceptance: no observed argument is dropped; a narrow call result does not create invented unknown upper bits when the actual return contract establishes the full value. Preserve `fixture_direct`, where Open Decomp currently passes the argument that Ghidra omits.
  - Infer only what evidence supports. An unknown count is not zero arguments; a known prefix is not a complete variadic argument list; unresolved callback targets still retain conservative effects.

Surfaces: `src/analysis/calls/`, `src/analysis/types/`, `src/service/analysis/calls.ts`, `src/service/analysis/source-facts.ts`, `src/reconstruction/source-planner.ts`, and existing library contracts.

### Types, memory, and symbolic data

- [ ] Carry pointer, scalar, signedness, result-width, and field/array evidence into source expressions rather than defaulting useful inputs/results to `uint64_t`. Keep machine bit width separate from inferred source type.
- [ ] Improve cross-function memory-shape constraints into compatible partial structures, array/stride accesses, and function-pointer fields. Preserve conflicting layouts and unknown sizes; an observed access extent is not proof of an entire object layout.
- [x] Fix symbolic/literal recovery for `fixture_string`, then globals, string tables, constant pools, and switch tables. Render `char *` and the exact fixture string instead of only `0x100000ad0` when the bytes and address establish it.
  - Acceptance: exact bounds, terminators, encodings, relocations, interior pointers, and mutable-versus-immutable data are respected. Do not reproduce Ghidra's SQLite lookup-table presentation as out-of-bounds indexing into the unrelated `"expand 32-byte k"` literal.

Surfaces: `src/analysis/types/`, `src/analysis/references/`, `src/analysis/strings/`, `src/service/analysis/source-facts.ts`, and shared reconstruction/expression rendering.

### Expressions, local variables, and idiomatic control flow

- [x] Collapse register-cell extract/concat chains and redundant casts into source-width values. Recover `3 * b`, zero-extended addition, masked shifts, and pointer indexing without exposing high/low halves unnecessarily.
- [ ] Simplify copies, dead pure temporaries, equivalent phi values, conditions, induction variables, and loop bounds. Inline only when scope, evaluation order, and expression size remain safe; do not duplicate effectful operations or expand shared expression DAGs exponentially.
- [ ] Introduce semantic local names from proven roles and stable evidence, with deterministic neutral names otherwise. Prefer `count`, pointer/element roles, and established field names over registers; never invent the program author's intent.
  - Acceptance: the arithmetic, sum-loop, width, stack-argument, and indirect-call examples communicate their algorithms without machine-state plumbing. Preserve modulo arithmetic, signed comparisons, division/shift edge behavior, evaluation order, aliases, and volatile/atomic semantics.
  - Syntax-check the declared executable subset with its real helper definitions; check identifiers, scopes, parentheses, and declarations for all output. Do not claim all pseudocode is compilable C/Python.

Surfaces: `src/reconstruction/expressions.ts`, `src/reconstruction/source-expressions.ts`, `src/reconstruction/source-stack.ts`, `src/presentation/`, and `src/emitters/`.

### Useful output without maximum-budget workarounds

- [x] Diagnose why small selected SQLite bodies exhaust default instruction budgets. Separate image discovery, function ownership/ranges, selected-function graph work, and bounded callee-summary work. Measure the actual visited instructions/edges before deciding the repair; do not assume a single cause or just raise every limit.
- [ ] Make selected-function work proportional to its body and required dependencies. Reuse immutable per-image indexes and summaries; do not reconstruct or serialize unrelated image-wide analysis for every request.
- [x] Add evidence-backed support for the observed ARM64 memory barrier in `sqlite3_initialize`, preserving ordering rather than treating it as a no-op. Improve tail-call source presentation without hiding unknown targets/conventions.
- [ ] Make the ordinary small-page MCP navigation and cached-result paths usable on SQLite. Diagnose the wrapper-limit census failure and large-image cache latency; keep explicit delivery bounds and page/artifact semantics intact.
  - Acceptance: all originally selected corpus and SQLite functions return useful results through normal CLI/API/MCP defaults without supplied prototypes. Metadata-only gaps are distinguishable from missing instructions/graphs or unresolved semantics. Any remaining partial result names the actual limitation rather than implying full recovery.

Surfaces: `src/analysis/discovery/`, `src/service/queries/graphs.ts`, `src/service/analysis/`, `src/project/store/`, `src/project/cache/`, and ISA lifters.

## P2 — Demonstrate parity beyond our own fixtures

- [x] Preserve a reproducible comparison harness and reviewed input manifest using the existing `scripts/bench/` and performance-evidence conventions. Retain hashes, compiler flags, source/license provenance, selected function addresses, tool versions, budgets, raw responses, semantic states, and matched output artifacts outside temporary-only storage.
- [ ] Run a broader source-known corpus across the currently supported Mach-O ARM64, PE x86-64, and ELF x86-64 targets; symbol-bearing and stripped variants; multiple optimization levels and independently built compiler variants. Include loops with multiple exits, switches/jump tables, pointer aliasing, aggregates, callbacks, variadic/mixed FP calls, and real library workloads.
- [ ] Include held-out programs/functions not used to tune reconstruction. Evaluate both decompilers with equal source/debug/type access and document unsupported target/configuration cells instead of quietly dropping them.
- [ ] Publish separate correctness, usable-coverage, readability, and performance results. Use source-derived behavioral cases plus blind paired readability review with a fixed rubric: algorithm comprehension, types/interfaces, control flow, unresolved semantics, and irrelevant machine-state clutter. Text size is a diagnostic, not a quality score.
- [ ] Normalize performance methodology: the same MCP client path, equal requested work/coverage, matched output options, serialized measured runs, fresh-project versus resumed/cache distinction, and distributions over repeated runs. Separate import, analysis, first decompile, cached response, transport, and memory costs.
  - Compare against a persistent/reused Ghidra decompiler interface as well as the selected real MCP bridge. Beating avoidable bridge process-start overhead is not an engine-speed advantage. Faster failures or incomplete indexes are not useful speedups.

**Parity gate:** all P0 regressions pass through the actual public paths; the measured workload has no known dropped branch/result/argument or invented local input; declared supported corpus cases pass independent behavioral checks; held-out readability/usable coverage is at least comparable to the pinned Ghidra configuration without trading away correctness. State the evaluated scope, not a universal victory.

## P3 — Build defensible advantages over Ghidra

Start these after the correctness/parity work they depend on. Existing evidence and annotation infrastructure should be extended, not duplicated.

- [ ] **Explainable, trustworthy output:** expose why a parameter, type, field, string, call target, and high-level rewrite was inferred. Preserve exact instruction/source spans through simplification; show conflicts and assumptions beside the affected construct. Keep raw machine semantics accessible without forcing them into every pseudocode line.
  - Success: an investigator can verify or challenge a specific inference from the emitted code without manually rediscovering its instruction provenance.
- [ ] **Localized uncertainty:** render the understood body normally and isolate unresolved arguments, instructions, or effects in the smallest sound region. Consolidate repeated FP-environment assumptions into explicit function-level requirements while preserving affected control/effect dependencies.
  - Success: users can distinguish established computation, assumption-dependent computation, and unresolved behavior; shorter output does not hide uncertainty or weaken semantics.
- [ ] **Translation validation for risky rewrites:** add bounded bit-vector/control-flow checks where useful, starting with arithmetic normalization, phi elimination, stack promotion, and exit restructuring. Use independent counterexamples to reject unsound transformations; solver timeout/unknown remains unverified, not proven.
  - Success: validation catches plausible source-changing rewrites that the source corpus alone misses. Do not claim whole-program equivalence from a checked local rewrite.
- [ ] **Stronger interprocedural recovery:** use bounded context-sensitive summaries to improve callbacks, aggregate returns, shared object layouts, and API interfaces while preserving alias/conflict evidence. Make evidence additions and corrected annotations incrementally refine dependent output.
  - Success: recover real call arguments and layouts that Ghidra misses, without promoting guesses into source facts or analyzing unrelated callees without a bound.
- [ ] **Better modern optimized-code coverage:** rank unsupported instruction/compiler patterns by occurrence in the reviewed corpus, then implement their semantics, ABI effects, reconstruction, and source-backed cases together. Expand atomics, SIMD/vector code, optimized switch/loop idioms, and language runtimes based on measured demand.
  - Later C++ virtual dispatch/RTTI/exceptions, Objective-C, and Swift work must have separate supported-subset gates and metadata/ABI evidence; symbol demangling alone is not source-language recovery.
- [ ] **Incremental interactive analysis:** invalidate only proven affected dependencies after annotations/summary changes, keep repeated requests independent of unrelated image size, and expose explicit progress/cancellation and bounded useful results. Preserve target/revision/component/budget cache identity; never reuse stale output to appear fast.
  - Success: improve correctness-equivalent latency and memory distributions on both small and real large inputs, not only cached fixture microbenchmarks.
- [ ] **Agent-friendly investigation:** build compact, structured output for signatures, call arguments, fields, assumptions, unresolved constructs, and instruction-backed references on the existing MCP/artifact contracts. Make user/LLM annotations reviewable, retractable hypotheses rather than invisible rewrites of established facts.
  - Success: blind source-answering tasks require less manual repair and fewer irrelevant bytes than the Ghidra workflow while preserving correct answers and visible uncertainty.

**Beyond-Ghidra gate:** demonstrate reproducible wins on held-out workloads in the claimed dimensions, with no known correctness regression and no reduced useful coverage. Report tradeoffs and counterexamples. Do not replace the baseline with only favorable functions or claim general superiority from one architecture, one compiler, or one bridge.

## Definition of done for each implementation item

- Reduce an observed defect to a deterministic behavioral case or define the feature's consumer-visible acceptance criterion before implementation.
- Fix the owning shared layer; exercise both dialects and affected CLI/API/MCP paths without duplicating the algorithm or preserving obsolete alternate implementations.
- Run the changed scenario end to end and observe its output; use targeted semantic regressions for boundaries/effects, not text snapshots or mock forwarding checks.
- Preserve source mappings and provenance. Update cache component versions when semantics/output identity changes, with invalidation following existing contracts.
- Update relevant architecture/API/performance documentation only with exercised evidence. Record unsupported cases, actual budgets, and limitations alongside successful results.

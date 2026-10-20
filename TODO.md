# Readability roadmap: close the gap with Ghidra

## Goal and rules

Make source-view output read as well as Ghidra's on unseen code without giving up correctness or explicit uncertainty. These are planned items, not current capabilities.

- Correctness before readability. Every rewrite keeps fixed-width arithmetic, signedness, memory/call ordering, aliasing and explicit unknowns. A prettier wrong program is a regression.
- Fix the owning shared layer (IR, analysis, reconstruction, structuring); never repair emitted text with regexes or special-case fixtures or functions. Both dialects consume the same result.
- Reuse the existing local validator (`src/reconstruction/local-validation.ts`), evidence/provenance and cache-version contracts. Bump component versions when output identity changes.
- Tune only on the development loop (`scripts/bench/quality-dev-loop.py`) and our own fixtures. Claims come from a sealed held-out set (see Measurement).

## Baseline (2026-10-19, see docs/PERFORMANCE.md)

On the second held-out suite (8 unseen functions, 24 cells), blind preference was Open Decomp 44, Ghidra 138, tie 10. Ghidra was preferred on every dimension except unresolved semantics; angr was also preferred (84 vs 153). Reviewer reasons: goto labels; integer addresses with casts instead of pointers; frame and unknown-register plumbing; extra temporaries; helper-macro preambles and helper calls (bit-insert, divide-trap, 128-bit). On Ghidra's 16 LLM questions, Open Decomp needs ~2.2× Ghidra's tokens per correct answer. Most of the extra comes from open `...` arities, `entry_sp` frame memory and residual casts.

Root causes found in the code, in the order we plan to address them:

| #   | Gap                                                         | Current mechanism                                                                                                                                                                                                                                              | Ghidra's approach                                                  |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| R1  | Frame slots stay `*(T *)(entry_sp - N)`                     | Stack promotion is all-or-nothing per frame: one escaped frame address sets `saveEscaped` and skips every slot (`src/reconstruction/source-stack.ts`, `saveEscaped` and the promotion loops)                                                                   | Per-variable stack recovery                                        |
| R2  | goto labels, cross-loop jumps                               | Cyclic SCCs become loops, unique-entry successors become sequence/if/switch, everything else stays a labeled transfer; bounded repair passes keep a change only if gotos drop (`src/presentation/index.ts`, `src/emitters/source-control.ts` `transferAction`) | Iterative region collapse over the whole graph with goto selection |
| R3  | Extra temporaries, sub-register recombination, helper calls | `simplifySSA` fixpoint with a small rewrite set (`src/analysis/values/index.ts`) plus ~50 named source-view rewrites, each gated by a BDD validator allowance (`src/reconstruction/source-expressions.ts`)                                                     | Large rule pool applied to a fixpoint                              |
| R4  | Integer addresses with casts, `type_N *` names              | IR values are bit-vectors (`src/ir/model.ts`); pointer needs positive local evidence; any conflict drops the source type (`src/reconstruction/source-types.ts`)                                                                                                | Image-wide type propagation during up-front analysis               |
| R5  | Open `...` arities, unknown call interfaces                 | Only proven interfaces close; anything else stays explicit (docs/CORE.md, open-arity section)                                                                                                                                                                  | Guesses prototypes from parameter ID                               |

## R1: Per-slot stack promotion

- [ ] Replace the frame-wide `saveEscaped` gate with per-slot escape analysis. A slot is promotable when no escaped address can alias its byte range (derive the range from the escaped pointer's base offset and the observed access extents; unknown extent aliases the whole frame above the base). Keep escaped slots as explicit frame memory; promote the rest.
- [ ] Recover each promoted slot's width/type from its accesses and merge split parts (`wide_slot_parts`) per slot, not per frame.
- [ ] Classify O0 spill/reload pairs of incoming arguments as the argument itself when no intervening write or escape exists.
  - Acceptance: on the dev loop and fixtures, O0 cells no longer show `entry_sp - N` for slots whose address never escapes. A slot whose address reaches a call, a store or an unknown effect stays explicit. Executable-subset cases still pass, and the validator rejects nothing new.

## R2: Region-collapse structuring

- [ ] Replace the SCC/unique-entry structurer with an iterative collapse over the whole CFG: sequence, if-then, if-then-else, short-circuit `&&`/`||`, while/do-while/infinite loops with break/continue, and switch. When no rule applies, pick the goto edge that unblocks the most collapses (not the first unmatched edge), then continue.
- [ ] Recover loop forms from the collapsed regions: `for` from induction variable plus bound plus step when the update is the last statement on the back edge; `do-while` versus `while` from the test position.
- [ ] Keep irreducible graphs correct with explicit labels. Delete the repair passes the new structurer makes redundant (tail duplication, forced tail copies, `do{}while(0)` wraps, `loop_exit_layout`) instead of stacking them on top.
  - Acceptance: fewer gotos per function on the dev loop than the current structurer; zero gotos on reducible CFGs without multi-level exits; every reachable edge/effect still represented (existing control-flow invariants); both dialects render the same structure.

## R3: Expression rule pool

- [ ] Introduce a single rule pool over SSA values, applied to a fixpoint with a work bound: constant/identity folding, extension/truncation fusion, sub-register extract/insert recombination into source-width values, shift/mask idioms, comparison/flag canonicalization, strength reduction (multiply/divide by constant, magic-number division to `/` and `%`), and 128-bit multiply-high to `(uint128_t)a * b >> 64`. Move existing scattered `presentation(...)` rewrites into it where they are value rewrites.
- [ ] Replace helper calls with plain C where the exact semantics hold under the stated assumptions: bit-field insert/extract to mask-and-shift, division with a proven nonzero divisor to `/`. Keep the helper only when a trap or edge case is actually reachable.
- [ ] Copy propagation and temporary elimination at source level: inline single-use pure values when evaluation order and expression size allow it; merge equivalent phi values into one variable.
- [ ] Measure the BDD validator allowance on the dev loop. Raise efficiency (memoize per value, validate rule classes once) rather than silently skipping validation when the allowance runs out.
  - Acceptance: the dev loop shows fewer temporaries and no helper preambles for supported idioms. Every rule carries its own bit-precise validation or proof, with counterexample tests at width/sign boundaries.

## R4: Pointer and type inference

- [ ] Propagate pointer-ness through the image: a value is a pointer when it is dereferenced, passed where a known prototype expects a pointer, returned from an allocator, compared with a pointer, or derived by add/sub from a pointer. Run this on the callee-summary and image-type paths (`src/service/analysis/image-types.ts`), not only per function.
- [ ] Resolve conflicts by evidence weight instead of dropping the type: when one candidate has dereference evidence and the other only an integer use, keep the pointer type and leave a visible cast at the integer use.
- [ ] Name recovered structures from their strongest evidence: prototype parameter type, allocator size plus use site, or the field-access pattern shared across functions. Fall back to `type_N` only without any of these.
- [ ] Render pointer arithmetic as indexing or field access when stride and base are established.
  - Acceptance: on the dev loop, integer-typed locals that are dereferenced become pointers. Struct field access replaces `*(T *)(p + off)` where a layout is recovered. No source type contradicts library prototypes or debug data.

## R5: Inference mode (opt-in guessing)

Guessing may be used only behind an explicit option (`inference: "proven" | "likely"`; CLI `--inference likely`; MCP/API option). It stays off by default until it meets the precision gate, and either way it can always be turned off. Guessed constructs carry a visible marker in both dialects and an inference record in provenance, so they are never mistaken for proven facts.

- [x] Build a precision harness first. Score each heuristic against source-derived ground truth (arity, parameter types, result type, pointer-ness) on our fixtures, the dev loop and SQLite/brotli source. Report precision and coverage per heuristic.
- [x] Caller-consensus arity closure (the design in docs/CORE.md) in likely mode: use the discovered call sites even when the callee is exported or discovery is partial, and close `...` to the arity every caller agrees on.
- [x] Callee arity from the callee's own body: registers read before write that are not callee-saved and not forwarded unchanged into an indirect call.
- [ ] Likely pointer and result types from use patterns that R4 rejects as unproven (e.g. a single integer use against several dereferences).
- [x] Gate: a heuristic ships in likely mode only at ≥95% precision on the harness. Likely mode becomes the default only if, on the sealed held-out set and the LLM task benchmark, it improves readability and tokens per correct answer without increasing the confident-wrong-answer rate.
  - Acceptance: `proven` mode output is unchanged by this work; the harness reports precision per heuristic; markers and provenance identify every guessed construct.
  - Status: implemented by `scripts/bench/likely-precision.ts` (harness), `src/service/analysis/likely-arity.ts` (`caller_consensus`, `callee_reads` gate), `likely_closure` in `observeParameters`; results in docs/PERFORMANCE.md (both heuristics pass on small samples; consensus coverage on SQLite is zero because its hubs have more than 32 callers or disagreeing prefixes). Open: the likely pointer/result type bullet (needs R4); "Likely mode becomes the default" stays unmet (needs the sealed set and the LLM benchmark, not run); indirect-call (callback) arities have no heuristic; "gate" checkbox covers the precision gate only.

## Measurement

- Development: `scripts/bench/quality-dev-loop.py` (not held out) after each item.
- The second held-out suite is no longer fully blind (`h2_level` was read during triage). Build a new sealed third set before the first R-item lands, following the sealing rule in docs/PERFORMANCE.md, and keep it unread until a measurement round.
- Gate for the roadmap: on the sealed set, blind preference is at least even with Ghidra and the executable-correctness subset does not regress. Report counterexamples and losses next to wins.
- LLM task benchmark (`scripts/bench/llm-tasks/`): track tokens per correct answer against Ghidra and the wrong-answer rate, in both inference modes.

## Definition of done for each item

- Define the consumer-visible acceptance criterion or reduce the observed defect to a deterministic behavioral case before implementing.
- Fix the owning shared layer and exercise both dialects through CLI/API/MCP. Delete obsolete passes the change supersedes.
- Run the changed scenario end to end and observe the output. Use semantic regressions for boundaries and effects, not text snapshots.
- Preserve source mappings and provenance; bump cache component versions when output identity changes.
- Update docs (CORE.md, PERFORMANCE.md) only with exercised evidence, including unsupported cases and losses.

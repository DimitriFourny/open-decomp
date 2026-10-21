# Readability roadmap 2: close the remaining gap with Ghidra

## Goal and rules

Make source-view output as short and as structured as Ghidra's on the same functions without giving up correctness or explicit uncertainty. These are planned items, not current capabilities. The previous roadmap (R1–R5) has landed; its text, per-item evidence and rejected variants are at `git show 7301f55:TODO.md`.

- Correctness before readability. Every rewrite keeps fixed-width arithmetic, signedness, memory/call ordering, aliasing and explicit unknowns. A shorter wrong program is a regression.
- Copy Ghidra's exact transforms, not its guesses. Its stack alias boundary (`varmap.cc:754-757`), parameter fill-in (`fspec.cc:1100-1140`), return-value detection (`coreaction.cc:1991-2037`), constants-as-pointers (`coreaction.cc:1093-1176`) and "most specific type wins" lattice (`type.cc:229-235`) are heuristics: they belong in `inference: "likely"` behind the R5 precision gate, or nowhere.
- Fix the owning shared layer (SSA, reconstruction, structuring, renderer); never repair emitted text with regexes or special-case fixtures or functions. Both dialects consume the same result.
- Reuse the local validator (`src/reconstruction/local-validation.ts`), evidence/provenance and cache-version contracts. Bump component versions when output identity changes.
- Never raise budgets. brotli `main` and SQLite `whereLoopAddBtreeIndex` finish only ~0.4M / ~0.3M work under the 10M limit; an item that adds work pays for it in the same change.
- Tune on the structure sample and the development loop; claims come from a new sealed suite (see Measurement).

Ghidra citations are relative to `../ghidra/Ghidra/Features/Decompiler/src/decompile/cpp/`.

## Baseline (2026-10-20)

Same 214 functions of the structure sample (`scripts/bench/structure-gotos.py`: brotli 1.2.0 CLI, SQLite 3.54.0 `btree`/`vdbemem`/`exprcode` name filters, Mach-O and ELF fixture libraries). Open Decomp at `c07c94f` (`open-decomp export`, C source view, `proven`, default budget); Ghidra 12.1.4 headless, default decompiler options after auto-analysis. Counts are regex matches on printed text, not a readability verdict. Raw outputs of both tools, the Ghidra script, the function lists and the per-construct classification are in `.local/ghidra-gap-2026-10-20/` (local, gitignored).

| metric                                            |          Open Decomp | Ghidra |
| ------------------------------------------------- | -------------------: | -----: |
| `goto`                                            |                  372 |    405 |
| functions with a `goto`                           |                   31 |     48 |
| `do { } while (0)`                                |                   95 |      0 |
| `break`                                           |                  284 |     23 |
| `while (true)`                                    |                   47 |      8 |
| `continue` / exit-flag variables                  |              12 / 12 |  0 / 0 |
| `for`                                             |                    3 |     12 |
| `else if`                                         |                    0 |     37 |
| conditions holding a statement (`(x = f(), ...)`) |                    0 |     33 |
| non-blank lines                                   |               16,614 | 11,377 |
| bytes                                             |               749 KB | 380 KB |
| local declarations                                |                2,463 |  1,163 |
| lines with `entry_sp`                             | 1,370 (38 functions) |      0 |
| call lines ending in `, ...)`                     |                  774 |      0 |
| 64-bit values reassembled from two 32-bit cells   |     11 (6 functions) |      0 |

The SQLite source of the 114 SQLite functions has 51 gotos (we print 215, Ghidra 288; inlining inflates both). The goto count is not the gap. The gap is the goto substitutes (breakable blocks, `while (true)` with breaks, exit flags), the missing C idioms (`else if`, comma conditions, `for`, un-rotated loops) and everything printed around the statements:

| share of our 749 KB                                          |      |
| ------------------------------------------------------------ | ---: |
| statements and control flow (about Ghidra's whole output)    | 53 % |
| per-function `typedef` / `struct` / `extern` preamble        | 18 % |
| lines using `entry_sp` (frame kept as raw memory)            | 11 % |
| local declarations                                           | 10 % |
| comments                                                     |  6 % |
| `unknown_*` / `requirement_predicate` / `physical_*` helpers |  2 % |

Each of our 180 jump constructs (108 `goto`, 43 `do { } while (0)`, 29 `while (true)`) in 40 functions was classified against Ghidra's output and the disassembly (`goto-classify-{small,large}.md`):

| cause                                                                        | constructs | item   |
| ---------------------------------------------------------------------------- | ---------: | ------ |
| Ghidra prints a goto at the same place                                       |         85 | —      |
| a test plus one statement joins `&&` / `\|\|` as a comma condition           |         26 | G2     |
| two tests of the same value merged (incl. loop un-rotation)                  |         16 | G3     |
| loop exit choice (`while (true)` where Ghidra prints `do { } while (c)`)     |         16 | G4     |
| phi copies in arms keep them apart                                           |         14 | G1     |
| other: goto edge choice, label placement, if/else printed as breakable block |         23 | G4, G6 |
| return-block duplication, jump threading                                     |          0 | —      |

Our small return-tail copies already beat Ghidra's (on the 34 smaller functions Ghidra prints 73 gotos, we print 41, mostly because of them); keep them.

**Order.** M1 → G6 (drop breakable blocks first, so later items are measured against the honest baseline) → G5 → G1 → G2 → G3 → G4 → rest of G6. G2 needs G1's variable partition to know which edge copies print. G7, G8 and G9 do not touch control flow and can run in parallel worktrees.

## M1: Ghidra lane in the structure sample

- [x] Check in the headless script (`.local/ghidra-gap-2026-10-20/ghidra-scripts/DecompileList.java`) as `scripts/bench/ghidra-decompile-list.java` and add a `ghidra` subcommand to `structure-gotos.py` that runs `analyzeHeadless` (`GHIDRA_INSTALL_DIR`, `JAVA_HOME`) on the sample binaries with the same function lists (matched by symbol name: Ghidra rebases the ELF image) into the same per-function layout. Ghidra only loads the binaries; nothing is executed.
- [x] Extend `metrics` with every counter of the baseline tables: jump statements (`goto` + `break` + `continue` + exit flags + run-once blocks), `while (true)`, `for`, `else if`, comma conditions, non-blank lines, bytes by part (preamble, `entry_sp` lines, local declarations, comments, uncertainty helpers, other), call lines with `, ...)`, cell reassemblies. Print a paired Open Decomp / Ghidra table and per-function deltas.
  - Evidence (2026-10-21): `ghidra` smoke on 3 ELF, 3 brotli and 2 + 2 SQLite functions gave the 2026-10-20 outputs (headers aside); `metrics` on the saved outputs reproduces the goto, break, continue, exit-flag, `while (true)`, `for` and cell-reassembly rows exactly and the line, byte, declaration and open-call rows when file totals are recounted; `else if` 36 vs 37, Ghidra declarations 1,237 vs 1,163 and comma conditions 120 vs 33 differ by counter definition (docs/PERFORMANCE.md, "Readability roadmap 2 baseline").
  - Acceptance: reproduces the baseline tables from `.local/ghidra-gap-2026-10-20/`; recorded in docs/PERFORMANCE.md as this roadmap's baseline.

## G1: Merge phi copies into variables before structuring

Edge copies print inside arms and keep equal arms apart (14 classified constructs). `whereLoopAddBtree` prints six arms `address_32 = (uint8_t*)address_22; goto label_169;` where Ghidra prints one 8-term condition; local declarations are 2,463 vs 1,163. Today `phi_copy_coalescing` runs in the renderer after structuring and unions a pair only when storage type, presented type and name agree (docs/internals/reconstruction.md, variable recovery).

Ghidra forces every MULTIEQUAL's inputs and output into one variable (`mergeMarker`, `merge.cc:889-901`), inserts a COPY only where two live ranges overlap (`trimOpInput` at the end of the predecessor, `merge.cc:692-711`), hides copies inside one variable (`markInternalCopies`, `merge.cc:1444-1469`), then merges non-interfering same-type values (`mergeAdjacent`, `merge.cc:983-1013`; `mergeByDatatype`, `merge.cc:359-400`).

- [x] One variable partition over SSA values (block parameters, edge arguments, definitions) computed from SSA live-range interference before structuring: a block parameter and its incoming arguments share a variable unless they interfere; an interfering pair keeps one explicit copy on that edge. Members may differ in storage width or presented type: the variable takes one presented type and a differing member prints one exact conversion at its definition, not a copy. Formals stay representatives; names are chosen per variable and are never a merge condition.
  - Evidence (2026-10-21): `partitionVariables` (`src/emitters/source-control.ts`), record `variable_partition`; computed before source control planning (the region structurer itself still runs before reconstruction, see G2). Tests: interfering pair keeps one edge copy, integer member of a `uint32_t *` formal's variable converts once at its definition (executed, both dialects), native emitted C for swaps / pointer walk / early exit.
- [x] Merge non-interfering same-type values (in-place updates `x = x + 1`, register reuse) in the same partition and delete the renderer coalescing it supersedes (`phi_copy_coalescing`, `copy_coalescing`).
  - Evidence (2026-10-21): in-place pairs and same-type values one register holds at block boundaries join in the same partition; `coalescePhiCopies` / `coalesceValues` and both records deleted.
- [x] Structuring and source planning read "this edge prints k copies" from the partition (today `copies(transfer)` in `planLayout` is only known after coalescing).
  - Evidence (2026-10-21): `edgeCopies` (partition-owned) feeds `planLayout`, `foldSwitchGuards`, flag, loop-form and shared-arm planning and printing; a `for` whose init copy merged prints `for (; c; step)`.
  - Proof: interference is exact SSA liveness; merging non-interfering values changes names only. The control validators re-derive every edge's copies.
  - Acceptance: the six `whereLoopAddBtree` arms print no copy; sample local declarations and plain `x = y;` copies fall; no new validator rejection; both dialects.
  - Result (2026-10-21, 25-function subset): the six arms print `goto` only; C declarations 429 -> 342, plain copies 120 -> 61 (Python-like 435 -> 347, 104 -> 43); gotos and loop forms unchanged; `whereLoopAddBtree` validation records identical in status (no rejection); counted work brotli `main` 8.01M -> 7.97M, `whereLoopAddBtreeIndex` 9.64M -> 9.56M (docs/CORE.md).

## G2: Structure with block contents; comma conditions

The structurer runs before reconstruction and ignores block contents (docs/internals/structuring-emission.md, design decisions). The renderer merges `if (a) if (b)` into `a && b` only when nothing prints between the two tests (`renderer.ts:5461`). A test separated from the previous one by a single call therefore costs a goto or a breakable block: 26 classified constructs (`sqlite3BtreeTripAllCursors`: 3 gotos, Ghidra 1 with `(uVar2 = _saveCursorPosition(pbVar3), (int)uVar2 != 0)`).

Ghidra structures inside its data-flow loop and again after merging (`coreaction.cc:6021`, `6100`). A block may join a condition when it prints at most its branch plus one statement (`BlockBasic::isComplex`, `block.cc:2417-2472`; `ruleBlockOr`, `blockaction.cc:1321-1371`), and that operand prints comma-separated (`printc.cc:2979-3017`).

- [ ] Content facts per block: printed statements, labels/notes and edge copies (G1), computed from reconstruction and source inlining. First map every read of the region tree under `src/reconstruction` (ownership walk `index.ts:83`, FP guard rewrite `source-fp.ts:235`, loop roles `source-names.ts:367`, `validate.ts`, `local-control-validation.ts`) and make the facts independent of the first region tree.
- [ ] Structure again with those facts (Ghidra's post-merge pass), or move structuring after reconstruction if the map shows no real dependency [inference: the move is the cleaner design]. Decide by measured work; the result must fit the work-limit margins (see rules). Dropping `planBreakableBlocks` (G6) frees its search allowance.
- [ ] Short-circuit operand rule: an operand block that prints exactly one statement before its test joins `&&` / `||`. C prints `(x = f(), x != 0)`, or `(x = f()) != 0` when the test reads `x` once directly; Python-like prints `(x := f()) != 0`. Eligible first: an assignment whose value the test reads (both dialects can print it). Measure how many of the 26 constructs that leaves before extending to other single statements.
  - Proof: the comma operator is a sequence point; the statement runs exactly when the test runs, in the same order. Nothing is hoisted. The control validator checks the chain like any merged condition.
  - Acceptance: `sqlite3BtreeTripAllCursors` prints at most one goto; the sample's jump statements fall by about the measured comma-condition share; comma/walrus conditions appear in both dialects.

## G3: Merge duplicated tests; un-rotate loops

Compilers copy one test into several predecessors and we print a goto per copy: 16 classified constructs, 11 in `allocateBtreePage` (`cbz`/`cbnz x21` at 0x100066780, 0x1000669ec, 0x100066afc; `cbnz x26` at 0x100066cb0, 0x100066d38). A rotated loop prints as `if (p != 0) { do { … } while (p != 0); }` (`sqlite3BtreeTripAllCursors`; Ghidra: `for (pbVar3 = …; pbVar3 != 0; pbVar3 = *(byte **)(pbVar3 + 0x28))`), so the sample has 3 `for` loops against 12. SSA threading bypasses only empty blocks whose branch is constant or tests the same SSA value (`src/analysis/values/index.ts:627-652`).

Ghidra's `ConditionalJoin` (`blockaction.cc:1920-2115`, match `2073-2099`) and `ActionNodeJoin` (`2335-2373`) replace two CBRANCH blocks with the same exits and functionally equal conditions by one joined block whose differing operands become MULTIEQUALs (`nodeJoinCreateBlock`, `funcdata_block.cc:798-834`); `BlockWhileDo::finalTransform` then builds `for` loops (`block.cc:3284-3366`, `3477-3546`).

- [ ] SSA CFG rewrite in simplification: two branch blocks with the same two targets (same or complemented polarity) whose condition cones are equal up to leaves that differ per block become a new join block with one parameter per differing leaf and one branch; both blocks jump to it and the target edge arguments are carried per predecessor. The joined cone must be pure (no load, call or unknown effect); the provenance of both terminators joins.
- [ ] Rotated loops: the guard `if (c)` and the bottom test `c` over the loop-carried value join into one header test, so `planLoopForms` prints `while (c)` or `for (init; c; step)`.
  - Proof: structural equality of the two condition cones modulo the parameterized leaves; local validation checks that the joined test equals each original test on its incoming edge.
  - Acceptance: `sqlite3BtreeTripAllCursors` prints one loop test; `allocateBtreePage` loses the 7 gotos the classification attributes directly to duplicated tests; sample `for` and tested loops rise.

## G4: Choose loop exits like Ghidra

Bottom-tested loops become `while (true)` with breaks, and the code after the loop is absorbed into the body: 47 `while (true)` vs 8, 284 `break` vs 23, 16 classified constructs. `ParseInt`: Ghidra prints `do { … } while (uVar2 != 5);` followed by the post-loop test; we print `while (true)` with `continue`, three `break`s and a goto. Our follow key ranks fewest other non-tail exits first, then a header exit, then a latch exit (`src/presentation/index.ts:480-490`).

Ghidra's `LoopBody::findExit` takes exit candidates from the tails first, then the head, then middle nodes (`blockaction.cc:182-239`); `orderTails` puts the exiting tail first (`245-263`); body extension never adds the exit block (`150-176`).

- [ ] Rank a latch (bottom-test) exit first when the loop has one repeat edge, then the header exit, then the current key. Compare body extension with Ghidra's `extend` and stop absorbing code that runs only after the loop has finished.
- [ ] The 6 classified edge-choice cases in large functions: Ghidra labels a side exit (error or return path) so the enclosing if/else still collapses; we keep it as a `break` and pay a goto where the arms merge. Also the outer `while (true)` in `sqlite3BtreeIndexMoveto` (line 241 in the baseline) whose only back edge is `goto label_103`.
  - Acceptance: `ParseInt` prints a do-while with the post-loop code after it; sample `while (true)` and `break` counts fall; every per-function goto increase is listed in docs/PERFORMANCE.md with its cause (totals hid `whereLoopAddBtree` 14 → 26 in the forward-label round).

## G5: `else if`

The renderer never prints `else if` (0 in the sample, Ghidra 37); 39 `} else { if (…) … }` sites have an else body that is exactly one if statement. Ghidra prints an else block that is itself an if with a pending brace, giving `else if` (`printc.cc:3036-3041`, `3071-3078`).

- [ ] In the renderer's if printing (`renderer.ts`, around `5380-5490`): when an else arm prints exactly one `if` (no statement, definition, label, note or edge copy before or after it), print `} else if (…) {` (Python-like `elif`) at the outer depth. Mappings keep their spans.
  - Acceptance: sample `else if` at least 39; the layout, validators and every other printed token unchanged; both dialects.

## G6: Drop `do { } while (0)`; fix emitter repair artifacts

Decision (2026-10-20): breakable blocks were a cheap goto reduction. Reviewers cited them (`h3_pack`, docs/PERFORMANCE.md, third suite round 1), Ghidra never prints them, and they are dropped. Removing them raised gotos 200 → 333 on `structure/6` (docs/PERFORMANCE.md, structuring sample); G1–G4 are measured against the baseline without them.

- [x] Delete `planBreakableBlocks` (`src/emitters/source-control.ts:1484`), its renderer call and `breakable_block` presentation record (`renderer.ts:6578-6588`), the `once` loop mark (`src/presentation/model.ts:119-123`) and its handling in the renderer (`renderer.ts:4589`, `7206`) and the validators (`src/reconstruction/validate.ts:261`, `311`, `387`; `src/reconstruction/local-control-validation.ts:29-34`, `73`, `144`), the Python-like run-once `while True: … break` form, their tests and docs (docs/internals/structuring-emission.md, docs/CORE.md). Bump the version. Land first and record the new sample baseline with M1.
  - Done (emitters 69): `planBreakableBlocks`, the `breakable_block` rule, the `once` loop mark and the run-once printing in both dialects are gone; their edges print as `goto` to forward labels. Checked on 6 functions (C / Python-like exports, `/tmp` before-after): `do { } while (0)` 2/2/2/8/6/5 → 0 and no run-once `while True:` in `CloseFiles`, `sqlite3BtreeSetPageSize`, `sqlite3VdbeMemGrow`, `btreeBeginTrans`, `sqlite3BtreeOpen`, `sqlite3ExprCodeIN`; gotos 2→5, 1→4, 3→6, 32→52, 31→46, 5→14 respectively (full-sample baseline recorded by the coordinator).
- [ ] `if (loop_exit_0) { break; } break;` in `allocateBtreePage`: `planLoopExits` emits a flag test followed by an unconditional transfer to the same place. Emit neither the test nor the flag when both outcomes leave the same way.
- [ ] Exit flags that are set on every path reaching their test (`whereLoopAddBtree` `loop_exit_*`): introduce a flag only when some path reaches the re-test with it clear; otherwise print the transfer directly. Baseline: 12 flags in 6 functions; Ghidra prints a goto for a multi-level exit. After G1–G4, measure flags against plain gotos the same way as breakable blocks.
  - Acceptance: no `do { } while (0)` or run-once `while True:` in either dialect; both artifacts gone from their functions; validators re-derive every edge.

## G7: Shrink what surrounds the code

47 % of our bytes are outside statements and control flow, and Ghidra prints none of it. On the LLM task benchmark we pay about 2.2× Ghidra's tokens per correct answer.

- [ ] Per-function preamble (18 % of bytes): every function prints its `typedef` / `struct` bodies and `extern` lines. Print struct bodies once per image (`export` already writes `types.h`; MCP has the `types` view) and reference them by name; print an `extern` only when it carries a declared or library prototype, not an inferred `(T*, ...)` that repeats the call site.
  - Acceptance: preamble bytes per function fall; the LLM task benchmark (`scripts/bench/llm-tasks/`) gains no wrong or unknown answer.
- [ ] Escaped frame memory (11 % of bytes, 1,370 `entry_sp` lines in 38 functions). Ghidra puts constant-offset stack slots in SSA and names them (`local_28`, `&local_28`) under an alias-boundary guess (`varmap.cc:708-799`). Exact alternative without promotion: print the frame region kept as memory as one local frame object, a struct whose members sit at their frame offsets (one member per consistent (offset, width) access set, byte arrays for overlapping or dynamically indexed parts, padding between), and spell accesses `frame.local_ec`, `&frame.local_ec`, `(uint8_t *)&frame + i`. Memory semantics, ordering and aliasing are unchanged: nothing is forwarded. Owner: stack plan (`src/reconstruction/source-stack.ts`) and renderer.
  - Acceptance: no `entry_sp` in functions whose frame accesses are all at known offsets; the 52 third-suite interface mismatches caused by an extra `entry_sp` input disappear if no access needs `entry_sp` once the frame object exists [check].
- [ ] Open arity at call sites (774 call lines end in `, ...)`, 375 such externs): the source view prints `...` at every open call (`renderer.ts:1677-1681`). Print only the proven arguments at the call and state the open arity once in the callee's declaration. Proven mode stays proven: no argument is added to or dropped from the IR, and `likely` closures still print `likely_arity(...)`.
  - Acceptance: the checked view is unchanged; LLM benchmark questions about arguments keep their answers.

## G8: Recombine split register cells

A 64-bit value assembled per arm from two 32-bit cells prints as `value6 | ((uint64_t)value7 << 32)`. `sqlite3BtreeCommitPhaseTwo` builds the `getPageNormal` / `getPageMMap` function pointers this way (low cells `0x60ce8` / `0x60ae0`, high cell `1`, i.e. `0x100060ce8`); Ghidra prints `pcVar4 = _getPageNormal`. Baseline: 11 reassemblies in 6 functions. Ghidra's varnodes are whole registers, so this cannot arise there.

- [ ] Cell recombination (source view, docs/internals/reconstruction.md, step 6) also merges a phi group whose cells are constants (or recombinable values) on every incoming edge into one whole-width parameter with one constant per edge; pointer and global naming then applies to each constant.
  - Acceptance: `sqlite3BtreeCommitPhaseTwo` prints both symbols; the sample reassembly count falls; local validation proves each recombined constant.

## G9: Coverage

We print no text where Ghidra does. Third suite: stripped ELF 0 of 32 functions for us, 17 of 32 for Ghidra (stripped PE: neither harness produced text). Dev loop: all 88 failures are the stripped ELF/PE cells (`No function matches the selector` at `-O0`, `Function search is incomplete; uniqueness or absence cannot be established` at `-O2`). One unsupported instruction turns a function into whole-state `unknown_effect` plumbing: `sqlite3VdbeMemNumerify` prints 146 lines around `FCVTZS_64D_float2int`, Ghidra 37. The x86-64 lifter also ends the block there (ARM64 continues).

- [ ] Stripped ELF/PE discovery and selection: resumable whole-image discovery so a selector can resolve a function, or prove its absence, on stripped images.
- [ ] The x86-64 lifter continues past an unsupported instruction, like ARM64.
- [ ] Lift the encodings seen: ARM64 `FCVTZS_64D_float2int`, `UCVTF_D64_float2fix`, `DUP_asimdins_DR_r`, `CMEQ_asimdsame_only`, `AND_asimdsame_only` (structure sample); x86-64 `bts`, `punpcklbw` (third suite). Each gets semantic tests against the trusted evaluator.
  - Acceptance: stripped ELF/PE dev-loop and third-suite cells return text; the listed encodings leave no `__unknown_effect` in their functions.

## Measurement

- After each item: `structure-gotos.py` with the Ghidra lane (M1) and `scripts/bench/quality-dev-loop.py`; record paired totals and per-function regressions.
- After G1–G4: re-run the per-construct classification on the same 40 functions (protocol and categories in `.local/ghidra-gap-2026-10-20/goto-classify-*.md`).
- The structure sample, the dev loop and the third suite are all seen. Claims need a new sealed suite built and measured under the sealing rule in docs/PERFORMANCE.md.
- [ ] Gate: on the new sealed suite, blind preference is at least even with Ghidra on control flow, machine-state clutter and algorithm comprehension (the dimensions where Ghidra led in round 1); the executable-correctness subset does not regress; the LLM task benchmark's tokens per correct answer fall with no new wrong answer. Report counterexamples and losses next to wins.

## Definition of done for each item

- Define the consumer-visible acceptance criterion or reduce the observed defect to a deterministic behavioral case before implementing.
- Fix the owning shared layer and exercise both dialects through CLI/API/MCP. Delete obsolete passes the change supersedes.
- Run the changed scenario end to end and observe the output. Use semantic regressions for boundaries and effects, not text snapshots.
- Preserve source mappings and provenance; bump cache component versions when output identity changes.
- Update docs (CORE.md, PERFORMANCE.md, docs/internals) only with exercised evidence, including unsupported cases and losses.

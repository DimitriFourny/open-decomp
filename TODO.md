# Roadmap 3: remove machine-state artifacts (`physical_return`, `entry_sp`, `indirect_exit`)

## Goal and rules

odbench (docs/PERFORMANCE.md "odbench: the benchmark") shows that Haiku prefers Open Decomp's listings to Ghidra's overall (full tier 0.659), but that an LLM understands Ghidra's slightly better (comprehension −0.15). The losses concentrate in functions that print three machine-level artifacts. This roadmap removes them at their root. Readability roadmap 2 (G1–G9) is done; its text is at `git show f61e1a1:TODO.md`.

Each item below is sized for one agent. The root causes were found by reading the code and confirmed with checked views, instrumented copies of `dist/` and prototype hacks outside the repository (2026-10-21). The prototypes measured the effect but wrote no validation records, so each item still has to be implemented properly. Line references are at `f61e1a1`.

- **Correctness first.** Every rewrite keeps fixed-width arithmetic, signedness, memory and call ordering, aliasing and explicit unknowns. A shorter wrong program is a regression.
- **Proven vs likely.** The default `proven` mode prints only what is proven or rests on an ABI premise recorded with `validation.requireAbi(...)`, like G7's `frame_object` or the existing `exit_scratch` / `incidental_result` rules. Heuristics go behind `inference: "likely"` and its precision gate (`src/reconstruction/source-likely.ts`, `scripts/bench/likely-precision.ts`).
- **Fix the owning shared layer.** That is the lifter, discovery, SSA, native summaries, reconstruction or the renderer. Never patch emitted text with regexes, and never special-case functions or fixtures. Both dialects consume the same result.
- **Validator records.** Every new presentation rule writes a `validation.presentation(...)` record (`src/reconstruction/local-validation.ts`). The checked view (`--view checked`) stays byte-identical unless the item says otherwise.
- **Never raise budgets.** brotli `main` and SQLite `whereLoopAddBtreeIndex` run close to the 10M work limit. An item that adds work pays for it in the same change, and the cost is measured with M1.
- **Version bumps happen at merge time.** Take the next free number on `main`; do not pre-assign. Components:
  - `discovery`, `stack-calls`, `reconstruction` and `pipeline` in `src/service/analysis/versions.ts:62`;
  - `C_EMITTER_VERSION` in `src/emitters/c/index.ts:5` and `PYTHON_LIKE_EMITTER_VERSION` in `src/emitters/python-like/index.ts:5`;
  - `NATIVE_SUMMARY_FORMAT` in `src/service/analysis/native-summaries.ts:17`.

## Baseline (odbench full tier, head `0eaab0f` = `f61e1a1` for `src/`, 231 functions with text)

| artifact in the C source view                             | functions | occurrences | readability vs Ghidra on them | comprehension OD / Ghidra | tokens × Ghidra |
| --------------------------------------------------------- | --------: | ----------- | ----------------------------: | ------------------------: | --------------: |
| `physical_return(explicit_values(…), physical_inputs(…))` |        18 | 34 calls    |                         0.167 |               2.44 / 2.50 |            2.22 |
| `entry_sp` formal and `*(T *)(entry_sp ± k)`              |        13 | 163 lines   |                         0.462 |               2.00 / 1.46 |            2.14 |
| `indirect_exit(target, reason, physical_inputs())`        |         6 | 6           |                         0.417 |               1.67 / 3.17 |            0.48 |
| none of these (nor `__unknown_effect`)                    |       192 | —           |                         0.733 |               2.64 / 2.80 |            1.31 |

Report: `.odbench/reports/2026-10-21-173924-od-head-full/report.md` (local). Section 7 lists the grader's wrong claims about these functions. Typical examples are "returns via `physical_return`", "updates a caller-supplied frame region at `entry_sp`" and "the function is a stub that exits to an indirect branch".

| class                                                            | functions                                                               | items  |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- | ------ |
| return join split into register cells                            | `matrix_switch` ELF/PE `-O2`                                            | R1     |
| self-recursive call counted as result demand                     | `btreeOverwriteContent`, `fts3EvalAllocateReaders`, `fts3EvalNextRow`   | R2     |
| context-specialized callee summary switches result register      | `matrix_variadic_call` `-O2` (ELF, PE, both stripped)                   | R3     |
| `-O0` callee summary misses a slot-typed double                  | `matrix_variadic_call` `-O0` (ELF, PE, Mach-O)                          | R4     |
| vector copy/zero-fill temporary taken for an FP result           | `vdbePmaReaderClear`, `matrix_aggregate` ×4 (sret)                      | R5     |
| integer-built double in an FP register                           | `sqlite3Fp10Convert2`                                                   | R6     |
| incoming stack arguments not bound as formals                    | `createFunctionApi` (AAPCS64 args 9–11)                                 | S1     |
| frame object switched off while any entry-SP address is live     | multiplier: 104 of the 163 lines                                        | S2     |
| reloaded stack addresses printed as constants (undeclared names) | the SysV and PE variadics                                               | S3     |
| written by-value aggregate in the incoming area                  | `matrix_aggregate` ×3 (SysV MEMORY class)                               | S4, S5 |
| callee-side variadic areas                                       | `matrix_variadic` Win64 ×3 and Darwin ×3 (S6); SysV ×3 (S7)             | S6, S7 |
| jump table proved on a stale chain                               | `selectInnerLoop` (+ `jsonTranslateTextToBlob`, `sqlite3_str_vappendf`) | J1     |
| table base or index fact set before a merge or call              | `jsonTranslateTextToBlob` (+ 5 more SQLite tables)                      | J2     |
| tail-jumped callee absorbed into its caller (stripped)           | `matrix_switch` stripped llvm-clang23 ELF/PE                            | J3     |
| indirect tail call through a register                            | `sqlite3_result_pointer`, `pcache1Shrink` (about 282 `br` in SQLite)    | J4     |

## Lanes and order

The work splits into four lanes. Lanes are independent; inside a lane, follow the arrows. Items in different lanes that touch the same file are named, so that the second to merge rebases.

- **Lane J (discovery):** J1 → J2, J1 → J3.
- **Lane T (tails):** J4. It extracts the frame-save helper in `src/reconstruction/source-stack.ts`, so land it before S2 or rebase S2 onto it.
- **Lane R (results):**
  - R1, R2 and R5 → R6 are in reconstruction and analysis (`source-planner.ts`, `result-demands.ts`/`source-facts.ts`, `source-results.ts`).
  - R3 → R4 are in native summaries. Land them one after the other.
- **Lane S (stack):**
  - S1 → (S2, S3) → S4;
  - S2 → S6 → S7;
  - S5, S8 and S9 are optional.
  - All of them are in `source-stack.ts`, `source-planner.ts` and the renderer. Land them one after the other.
- **M1** is a prerequisite for every item's work check. It is small; do it first.

## M1: Counted work per function in odbench

Every item has to show that brotli `main` and SQLite `whereLoopAddBtreeIndex` (and every corpus function) still finish within the 10M work limit, and what it costs. Today nothing reports work consumed: `decompile --json` shows only the budget, and earlier rounds used throwaway instrumentation. The counter is `consumed` in `createOperationContext` (`src/core/operation.ts:64-140`, `remainingWork()`).

- [x] Expose the work an operation consumed in the decompile result. Use a field that does not take part in cache identity or output fingerprints, for example operation metadata next to `budget`.
  - Have the odbench OD lane record it per function (`FunctionResult.work`, `scripts/bench/odbench/od-worker.ts`, `lane-od.ts`).
  - Have `report.ts` print, in section 8, per-function work, the largest functions, and the functions above 80% of the limit.
  - Acceptance: `bun run bench run od --label m1 --tier full` records `work` for every function. brotli `main` and `whereLoopAddBtreeIndex` appear in section 8 with their counts. Outputs are byte-identical to `od-head`.
  - Done: `data.work` on `function_decompile` results (per delivery; a cache `hit` reports the cost of serving the stored result), `FunctionResult.work` per function, report section 8. Full-tier lane `od-rm3-m1`: all 231 texts byte-identical to `od-head`; brotli `main` 9,223,523 and `whereLoopAddBtreeIndex` 9,429,670 of 10,000,000 (the latter is not a corpus function; measured with a fresh cache via the CLI).

## R: `physical_return`

The renderer prints `physical_return` at `src/emitters/renderer.ts:8130-8199` whenever the return projection is `physical`, or `outputs` remain after `exit_scratch`. Every cause is upstream of that point, so no item changes the renderer. With all six prototypes on, the lane went from 34 to 0 calls. In the full tier, only the 18 functions and two more SQLite functions changed, both toward their source types.

### R1: Rebind narrow join exits at the function's integer result width

- [x] **Problem.** In `matrix_switch` (ELF `-O2` `0x401aa0`, PE `-O2` `0x140001040`), `default: return a` and `case 9: return a == b ? 42 : 99` share one `ret`. Case 9 writes `eax`, which zero-extends, so rax is two SSA cells. OD prints `return physical_return(explicit_values((uint64_t)result), physical_inputs("x86_64:rax:32:32", value0));`. Ghidra prints `return param_2;`.
  - **Root cause:** `source-planner.ts:1115-1127` sets `wide` only when a high cell has a defining expression. A phi has none (`source-cells.ts:111-117`). The join exit therefore binds the 32-bit low cell. Harmonization (`:1227-1252`) then zero-extends it to the function width and keeps the high cell as an overlay. G8 recombination (`source-cells.ts:144-201`) does not fire, because an exit snapshot is not a joint read.
  - **Change:** in harmonization, for an exit narrower than the function width W, check whether its uncertain outputs cover exactly bits [narrow, W) of the integer return root. If they do, bind the whole location at W (`concat` of the cells) and drop those outputs. Otherwise keep `zero_extend`. `recombineSourceCells` then merges the phi web and records `register_cell_recombination`.
  - **Soundness:** bit-exact, because concat(cells) is the register value, and needs no ABI premise. Do not widen exits one by one: a prototype that followed phi sources made `btreeOverwriteContent` 64-bit. Decide W from all exits first, then rebind.
  - **Tests:** an IR fixture for SysV and AAPCS64 (`test/reconstruction/source-results.test.ts` or `source-loop-cells.test.ts`). Nine arms return 64-bit values; one arm joins the default through a 32-bit write plus a 64-bit cmov. Execute the emitted C and Python against an oracle with `a = 0x123456789abcdef0`. Assert:
    - no `physical_return`;
    - a recombination record;
    - an unchanged checked view;
    - a negative case where every exit is narrow keeps the narrow type.
  - **Acceptance:** both `matrix_switch` texts end `case 9: arg1 = arg1 == arg2 ? 42 : 99; break; } return arg1;`. No other full-tier text changes.
  - Evidence (2026-10-22): `source-planner.ts` harmonization rebinds (source view only, record `exit_result_width`) an exit narrower than the all-exit width W whose remaining return-root overlays tile exactly [narrow, W); G8 then records `register_cell_recombination`. OD lane `od-rm3-r1` vs `od-head`: only the two `matrix_switch` texts differ, both ending `case 9: arg1 = arg1 == arg2 ? 42 : 99; break; } return arg1;` (physical_return 1 → 0 each; texts with it 18 → 16); their checked views are byte-identical. Tests: `source-loop-cells.test.ts` SysV + AAPCS64 switch join executed in C and Python with `a = 0x123456789abcdef0`, all-narrow negative keeps `uint32_t`. reconstruction/64.

### R2: Forwarded result demand from a self-recursive call is not demand

- [x] **Problem.** `btreeOverwriteContent` (`static int`) prints 6 × `physical_return(explicit_values((uint32_t)comparison), physical_inputs("arm64:x0:32:32", value2))`. `fts3EvalAllocateReaders` and `fts3EvalNextRow` (both `static void`) print the same overlay. All three are self-recursive.
  - **Root cause:** `src/analysis/calls/result-demands.ts:94-105` pushes every changed exit cell of the primary result root as a full-width demand on the call that defines it. A callee's high half that only flows to this function's own exit therefore demands `x0[0:64]`. `source-facts.ts:2021-2036` folds dependencies of the function's own unit into `function_return_demands`, so the self-call demands the function's own result. That blocks `exit_scratch` (`reconstruction/index.ts:556-559, 686-689`) and `incidental_result` (`source-results.ts:695-698, 781-791`).
  - **Change:**
    - Tag demand roots from the return-exit snapshot as _forwarded_. Every other root is _semantic_: loads, stores, call arguments, branches, switch, indirect targets, explicit return values. A value reached from both is semantic.
    - `NativeDependency` (`native-prepare.ts:83-86, 141`) keeps `return_demand` and gains `return_demand_semantic`.
    - In the `source-facts.ts` aggregation, a dependency from the function's own unit contributes only its semantic demand.
  - **Soundness:** the self-demand is circular. Under the existing `exit_scratch` / `incidental_result` premise ("callers read only the established return storage" / "read no result"), the self-call is one of those callers. No new rule is applied; the existing ones fire with their existing records.
  - **Tests:**
    - `test/analysis/calls/result-demands.test.ts`: forwarded vs semantic tagging.
    - A recursive AAPCS64 fixture with exits `mov w0,#0`, the self-call result and a library `int` call. Without external demand it prints a 32-bit result with an `exit_scratch` record. With `function_return_demands: [x0 64]` from an external caller the overlay stays.
    - A void-like recursive fixture becomes `void`.
    - Execute the low 32 bits against an oracle.
  - **Acceptance:**
    - `btreeOverwriteContent` prints `uint32_t btreeOverwriteContent(` with plain `return 0;` / `return (uint32_t)comparison;`.
    - `fts3EvalNextRow` prints `void`.
    - `fts3EvalAllocateReaders` has no `physical_return`. Its leftover `uint32_t` result is a known residual: a stored constant 7 left in `w0` looks deliberate.
    - Expected side changes, both toward the source: `fts3EvalTestExpr` → `uint32_t`, `fts5ParseSetColset` → `void`. Nothing else changes.
  - **Not in this item:** using forwarded demand for non-self callers only when the caller's own exit is semantically demanded. It changes many callee summaries; measure it as a separate item if wanted.
  - Evidence (2026-10-22): `CallResultDemands` tags return-exit-snapshot roots forwarded (semantic closure first); `NativeDependency.return_demand_semantic`; the selected function's own unit contributes only semantic demand to `function_return_demands`; `NATIVE_SUMMARY_FORMAT` 2. OD lane `od-rm3-r2` vs main texts: exactly the five listed texts differ (`physical_return` 6→0, 1→0, 6→0). A self-call whose result is returned whole (no 32-bit use joined with an `int` result) still takes the call site's full-width observed result; see `test/reconstruction/recursive-result-source.c` for the shapes that are covered.

### R3: A context-specialized callee summary keeps the callee's result root

- [x] **Problem.** `matrix_variadic_call` `-O2` (ELF `0x401d60`, PE `0x140001260`, stripped ELF `sub@0x401d50` and PE `sub@0x140001250`) is two tail calls to the variadic `matrix_variadic` (returns `double`). OD prints a `void` function whose two exits return different registers through `physical_return`, under the header `/* ABI scratch at return, not results: … */`.
  - Evidence (2026-10-22): `generic_result` on the context unit = `nativeReturnInterface(baseline, …, untypedFloatWrites)` (no seeding; a literal-zero FP exit counts as a write of the root another exit types), applied by `inheritGenericResult` (`native-transfer.ts`) in `observeNativeUnit` for the summary and `source_interface`; context units are not persisted, so `NATIVE_SUMMARY_FORMAT` stays; `stack-calls/11`. OD lane full tier: exactly the four texts changed (`double …`, `return matrix_variadic(0);` / `return matrix_variadic(2…);`, no "ABI scratch", 0 `physical_return`); `fts3UpdateMethod`, `analyzeDatabase` byte-identical; coverage unchanged. Tests: assembled SysV callee (`native-interface.test.ts`), caller executed as `double` with a stub callee in both dialects (`native-context.test.ts`).
  - **Root cause:**
    - `native-context-prepare.ts:28-67` specializes the callee to the call's constants. For `matrix_variadic(0)` only the `xorpd %xmm0,%xmm0; ret` exit survives.
    - A literal zero has no IEEE type, so `native-transfer.ts:428-453` skips xmm0 (`if (floating && !type) continue;`) and claims `rax[0:64]`, which the `va_list` setup writes.
    - The other call site still projects xmm0, so the two exits disagree.
    - The context-free result is already computed (`native-context-prepare.ts:39-49`) but used only for entry registers.
  - **Change:**
    - Store the generic result on the context unit.
    - In `observeNativeUnit` (`source-facts.ts:1383-1509`), use the generic `returns`/`return_types`/`written_result` only when both results are non-empty and their root sets differ, for `observed` and for `source_interface`.
    - Keep context widths on the same root, and never add a result to an empty context.
    - Persist the field if prepared units are serialized (`native-summaries.ts`).
  - **Soundness:** the specialized exits are a subset of the callee's exits, so the generic per-exit proofs hold on each of them. Only the storage classification is inherited; values stay context-precise.
  - **Tests:** `test/service/analysis/native-context.test.ts` / `native-interface.test.ts`.
    - A SysV callee with `count == 0 → xorpd xmm0` and a loop exit that `addsd`s into xmm0: the generic and the `count = 0` summaries both give xmm0 f64.
    - A caller with call sites for count 0 and 2 becomes a `double` function; execute it with a stub callee.
    - Negative: empty generic and empty context stay empty.
  - **Acceptance:**
    - The four functions print `double …` with `return matrix_variadic(0);` / `return matrix_variadic(2…);` and no "ABI scratch" comment.
    - `fts3UpdateMethod` and `analyzeDatabase` stay byte-identical. A broader override, applied whenever the results differed, changed them and was rejected.
    - Nothing else changes.
  - **Separate problem:** the ELF `-O2` text still drops the double parameters `a`, `b`. They pass through to the variadic callee, so this is open arity; see S8.

### R4: The native return interface types `-O0` slot reloads like the source planner

- [ ] **Problem.** `matrix_variadic_call` `-O0` (ELF `0x401ec0`, PE `0x140001410`, Mach-O `0x1000007a4`) prints `physical_return` with `unknown_value(…, "call clobbers zmm0_low64")`. The callee `matrix_variadic` is `double` in its own source view, but its summary says `rax`/`x0`.
  - **Root cause:**
    - `nativeReturnInterface` (`native-transfer.ts:242-250, 428-453`) types registers only from expressions and contracts.
    - At `-O0` the result is a reload of a frame slot (`movsd -0x28(%rbp),%xmm0` / `ldr d0,[sp,#8]`), so the FP root is skipped.
    - The source planner types the same reload (`source-results.ts:178-253`: `slotStores`, `reloaded`, `slotType`). Two implementations of "which register is the result" disagree.
  - **Change:** move the slot-typing helper into a shared module and use it in `nativeReturnInterface` at the `floating && !type` branch. The type applies when every exit cell is a load from an exact private slot whose direct stores are all one of: FP of the same width, literals, or typed reloads. The existing typed-result precedence (`:488-497`) then replaces the integer root. The output of `source-results.ts` must stay byte-identical.
  - **Tests:** `native-interface.test.ts`, O0-style callees:
    - SysV (slot stored with an `fadd` result and a literal 0.0, xmm0 reloads it, eax a loop counter) → xmm0 f64;
    - AAPCS64 (`ldr d0` from an sp slot, x0 not written) → v0 f64;
    - Negative: an integer store into the slot keeps today's behavior;
    - A caller fixture executes `double r = callee(...); return r;` through a frame slot.
  - **Acceptance:**
    - The three functions print `double matrix_variadic_call(uint32_t arg0, double arg1, double arg2)` with `return result;` / `return frame.local_30;`.
    - No `unknown_value(… "call clobbers zmm0_low64")`.
    - The PE signature must stay `(uint32_t, double, double)`. A forced-summary prototype showed an extra `uint64_t` rdx formal; if it appears, report it to S8 instead of patching it.
    - Nothing else changes.
  - **Depends on:** R3 (same files; land them one after the other).

### R5: A vector copy or fill temporary in the FP register is not a result

- [x] **Problem:**
  - `vdbePmaReaderClear` (`static void`, ends with `memset` of the reader) prints `physical_return(… "arm64:x0:0:64", address_4, "arm64:v0:0:64", 0, …)`. Here x0 is a leftover `vdbeIncrFree` result and v0 is the `movi v0.2d,#0` used by `stp q0,q0`.
  - `matrix_aggregate` (ELF/PE `-O2`, both stripped) returns its struct through the hidden pointer. OD prints `rax` = the sret pointer echo plus the `zmm0` halves of a 16-byte `movups` copy. Ghidra prints `long *matrix_aggregate(...)` with `return param_2;`.
  - **Root cause:**
    - `selectSourcePrimaryResult` (`source-results.ts:748-778`) returns `explicit` when the untyped FP register is written after the integer register on every exit.
    - `observedElsewhere` (`:409-458`) deliberately ignores stores, so the copy datum looks like a result.
    - In the zero-fill case, constant folding breaks value identity. The link survives in instruction provenance: the `movi` id is shared by the exit cells and by every store datum.
  - **Change:**
    - Build two sets: SSA values that are, through transport, the datum of a ≥128-bit store; and the instruction ids in those data's provenance.
    - The FP carrier is incidental when every exit leaf is one of: such a datum, a constant sharing such an instruction, or an unprojected or non-final call output.
    - Then skip the `explicit` return and treat the FP state as `undefined` for the `incidental_result` gate.
    - The integer register then decides. For the aggregate, rax equals entry rdi (Win64: rcx), which is an exact pointer result. Otherwise `incidental_result` gives `void`.
  - **Soundness:** this is the `incidental_result` family: a presentation record plus the `abi_conformance` premise that callers read no FP result. The ≥128-bit restriction keeps scalar FP results that are also stored explicit.
  - **Risk to measure:** an untyped vector-returning function that also stores the same vector. No corpus function has one.
  - **Tests:** `source-results.test.ts`, executed against a memory oracle:
    - AAPCS64 zero-fill → `void`;
    - SysV sret echo with a 128-bit copy → `return p`;
    - Win64 variant;
    - Negatives: a 64-bit untyped d0 that is stored and returned stays explicit; a vector-typed carrier stays unchanged;
    - The checked view is unchanged.
  - **Acceptance:**
    - `vdbePmaReaderClear` prints `void` with no `physical_return`.
    - The four `matrix_aggregate` texts print `<T>* …(<T>* address, …)` ending `return address;`.
    - Nothing else changes. The by-value struct parameter is S4's job.
  - Evidence (2026-10-22): `selectSourcePrimaryResult` gains the named predicate `incidentalFloatingCarrier()` (checked before the untyped-FP `explicit` rule; records `incidental_result` + `abi_conformance` "callers read no floating-point result register"). Constants link to a stored datum only through the defining instruction of a _constant_ datum. OD lane `od-rm3-r5` vs `od-rm3-s1` (main): exactly the five acceptance texts differ (`vdbePmaReaderClear` → `void`, 4 × `matrix_aggregate` → `…_arg0_…* …(…* address, …)` / `return address;`; physical_return 1 → 0 each; texts with it 18 → 11 with R1); their checked views are byte-identical. Tests: `source-results.test.ts` AAPCS64 zero-fill (provenance-linked cells), SysV/Win64 128-bit copy executed in C and Python; 64-bit stored scalar stays explicit, vector-typed carrier stays the vector result. reconstruction/66.

### R6: An integer-built double in the FP register is a `double` result

- [x] **Problem.** `sqlite3Fp10Convert2` (`static double`) builds the double's bits in integer registers (`fmov d0, x8`; `movi v0.2d,#0` on early exits). There is no IEEE evidence, so OD prints `void` and 3 × `physical_return(… "arm64:v0:0:64", …)`.
  - **Done (R6, proven):** `untypedScalarFloating()` in `selectSourcePrimaryResult`; full-tier OD lane changes only `sqlite3Fp10Convert2` (`double sqlite3Fp10Convert2(…)`, 3 → 0 `physical_return`); precision: fires on 0 of 250 sampled SQLite and 16 brotli functions, and on 2 of the 6 remaining SQLite functions declared `double` (`sqlite3Fp10Convert2`, `vdbeSorterGetReal`), 0 false positives.
  - **Change:** in the branch that would return `explicit` (after R5's incidental check), choose `float` when all of the following hold:
    1. On every exit, the FP cell walks to leaves that are not call outputs, loads, observed elsewhere or vector data; literals are neutral.
    2. On every exit with a non-literal leaf, the upper FP cells are literal 0, i.e. a scalar `fmov`/`movq` write.
    3. The non-literal exits agree on width: 64 gives `double`, 32 gives `float`.
    4. At least one exit has a non-literal leaf.

    Record `primary_result` with the reason "…written before an untyped scalar FP value consumed only by exits on every exit path", plus an `abi_conformance` requirement: "a scalar FP-bank result is IEEE; callers read no integer result". This mirrors the accepted rule that scalar FP-bank formals are IEEE (docs/CORE.md).

  - **Mode decision:** proven if the precision check is clean, otherwise `likely`. Check that no full-tier function whose source returns a non-FP type gains `double`/`float`, and run the same comparison over the SQLite/brotli samples of `likely-precision`. Any false positive moves the rule behind `inference: "likely"` and `LIKELY_GATE`.
  - **Tests:**
    - An AAPCS64 fixture with `movi #0` and `fmov d0, x8` exits → `double`. Executed results are bit-exact for NaN payloads, −0.0 and infinities.
    - Negatives: the value is also stored or passed to a call; all exits are literals; the upper lane is non-zero; x0 is demanded.
    - A 32-bit `fmov s0, w8` variant → `float`.
  - **Acceptance:** `sqlite3Fp10Convert2` prints `double sqlite3Fp10Convert2(…)` with no `physical_return`; nothing else changes in the full tier.
  - **Depends on:** R5.

## S: `entry_sp`

163 lines in 13 functions. Each fix is a proven-mode rewrite under an ABI premise recorded like G7's `frame_object`. None needs `likely`.

A prototype of S1–S3 (unsound, measurement only) gave these results:

- `createFunctionApi`: 18 → 0 lines;
- SysV `matrix_variadic` `-O2`: 31 → 2 lines;
- SysV `matrix_variadic` `-O0`: 38 → 2 lines.

### S1: Incoming scalar stack arguments become formals by per-slot reach

- [x] **Problem.** `createFunctionApi` has 11 source parameters; on AAPCS64, arguments 9–11 are on the caller's stack. OD reads `*(uint64_t *)((uintptr_t)entry_sp + 0/8/16)`. Ghidra prints `param_9..param_11`.
  - **Done (S1):** `incomingFloor` in `expose()`, per-slot binding with `incoming_formal` / `incoming_arguments_private`; full-tier OD lane changes only `createFunctionApi` (18 → 0 `entry_sp`, `…, arg8, arg9, opaque_1* arg10`, negative slots as `frame.*`), checked views of the 13 `entry_sp` functions byte-identical; float/narrower slots not added (no corpus need).
  - **Root cause:** `src/reconstruction/source-stack.ts:1394-1433` binds incoming loads to formals (via `incomingStack`, `source-planner.ts:1356-1377`) only when all of these hold:
    - `!escaped`. But any unresolved call sets it (`:609-614`), and every callee summary here was cut by budget.
    - No store through a non-stack pointer anywhere in the function (`:1409`).
    - The per-load stack snapshot flags `aliased`/`escaped` are clear (`:1418-1419`).

    These whole-function gates fail. The live entry SP then also disables the frame object (S2), so the 14 negative slots print as `entry_sp − k`.

  - **Change** (source view only):
    - `expose()` (`:501-515`) also records `incomingFloor`: the lowest floor of exposures with a base ≥ 0. Mixed-sign values and indexed or dynamic accesses with a base ≥ 0 count too.
    - Bind an exact, nonvolatile, loads-only, non-overlapping incoming group when `!reachAll`, `group.end <= incomingFloor` (or there is no floor), and the facts are complete.
    - Drop the `escaped`, unknown-store and snapshot-flag gates in the source view; keep them in the checked view.
    - Optionally also accept float/double and narrower integers where `abi.classifyCall` places such a scalar. Reuse the IEEE retyping in `source-signature.ts:120-156`.
  - **Soundness:** callees, caller-supplied, global, loaded and returned pointers cannot designate this activation's incoming argument storage. Only addresses derived from it can, and the floor excludes those. Record:
    - `requireAbi('incoming_arguments_private', …)`;
    - `presentation('incoming_formal', 'stack:<key>', …)`.
  - **Tests** (`test/reconstruction/incoming-stack.test.ts`, IR builder, AAPCS64 and SysV):
    - 9 (AAPCS64) or 7 (SysV) used parameters, an open call before the incoming loads and a store through argument 1. Assert no `entry_sp`, the formal count, and `execute()` equal to the oracle for 0, 2^64−1 and 2^63. The event trace shows the store and the call but no incoming loads.
    - Negative: the incoming address is passed to the call, so the slot is not bound and a call oracle writing through it is observed.
  - **Acceptance:**
    - `createFunctionApi` has 0 `entry_sp` and 11 formals (`…, arg8, arg9, <ptr> arg10`); its negative slots print as `frame.*` members.
    - No other text gains `entry_sp`.
    - The checked view is byte-identical.

### S2: The frame object coexists with live entry-SP addresses ≥ 0

- [ ] **Problem.** `frame()` (`source-stack.ts:1720-1731, 1775-1783`) returns the entry-SP form for the _whole_ frame whenever any address at or above the entry SP is live. The `frame_object` validation record is then `verified` but unused. This accounts for 104 of the 163 lines (createFunctionApi, SysV variadics).
  - **Change:**
    - Extend the object variant of `SourceStackStorage` (`source-model.ts:226-234`) with `entry: Value | null`.
    - When the frame object is verified and the entry SP is live, lay out the object from accesses with `end <= 0` (minus the return address) and taken negative addresses.
    - Renderer (`printed` `:1650-1679`, `frameStorage` `:3992-4032`): offsets ≥ 0 keep `entry_sp + k`; negative offsets go through `frame.*`.
    - `validate.ts:83-103` accepts retained accesses ≥ 0 only when `storage.entry` is set.
    - Never emit an object with no members and no taken address; the prototype printed `struct { } frame;` for Darwin.
    - Update `inference.ts:498-501` and `source-names.ts:958`.
  - **Soundness:** G7's existing premise (`requireAbi('frame_object', …)`, `:1802-1807`). Frame addresses stay inside the frame object, which never reaches incoming bytes. Nothing is forwarded.
  - **Tests** (`test/reconstruction/frame-object.test.ts`), per ABI:
    - an escaped negative slot;
    - an indexed negative base;
    - entry SP+8 (AAPCS64: +0) stored into a negative slot and dereferenced later.

    Negative offsets print as `frame.*`, and `entry_sp` appears only in ≥ 0 expressions. `execute()` gives the same values and the same event order as the checked view. Add a case with no negative accesses: no frame object.

  - **Acceptance:**
    - The SysV `matrix_variadic` texts (`-O0` `0x401d10`, `-O2` `0x401bd0`, stripped `sub@0x401bd0`) print every negative access as `frame.*`, with ≤ 4 `entry_sp` lines each.
    - No `struct { } frame;` anywhere.
    - The checked view is unchanged.
  - **Depends on:** S1. Rebase onto J4 if J4 has landed: both touch `source-stack.ts`.

### S3: Stack addresses read back from memory print through their load

- [ ] **Problem.** In the SysV and PE variadic texts, values are assigned to undeclared names (`value4 = …`, `address_5 = …`, `address_2 = address;`); the graders flagged these. Also, `entry_sp + 8` appears where the binary _reloads_ `va.overflow_arg_area`.
  - **Root cause:**
    - The stack plan seeds its address map from every value with a stack fact, including load results (`source-stack.ts:133-137`).
    - The renderer prints such values as address constants (`renderer.ts:1650-1653`) and skips their declarations (`:8933`).
    - But a retained load still prints as `name = …` (`:4610-4617`).
  - **Change:**
    - Split the analysis address map from the presentation map in `planSourceStack`'s result. The analysis map keeps taint, escape and floors; the presentation map feeds `source.stack_addresses` and liveness (`reconstruction/index.ts:863, 942, 1219`).
    - A retained load whose result is at offset ≥ 0 prints through its declared variable.
    - A retained load at a negative offset is either hidden with `presentation('frame_reload_spelled_as_address', …)` or declared.
    - General invariant: `assignmentText` never assigns to a name the declaration pass skipped.
  - **Soundness:** a spelling choice between two expressions proven equal.
  - **Tests:** an IR builder case stores SP+8 into a frame slot, reloads it and dereferences it in a loop. Assert:
    - every assignment target is declared (`new Parser(text).symbols` from `test/emitters/c/support.ts`);
    - no `entry_sp + 8` inside the loop;
    - `execute()` is equal.

    Repeat with a negative frame address.

  - **Acceptance:** no assignment to an undeclared name in the 13 functions. With S2, the SysV `-O2` texts lose `entry_sp + 8` in their loop pre-headers.
  - **Depends on:** S1 (land after it; pairs with S2).

### S4: An incoming by-value aggregate becomes a struct formal

- [ ] **Problem.** `matrix_aggregate(aggregate input, u64 delta, double scale)` passes a 24-byte struct, which is SysV MEMORY class: it sits at entry SP+8..+32 and is modified in place. OD prints `*(uint64_t *)(entry_sp + 8) = …` (ELF `-O0` `0x401c40`, `-O2` `0x401b30`, stripped `sub@0x401b30`). Ghidra prints `in_stack_*` locals.
  - **Root cause:**
    - Formal binding accepts only loads of pointer-width integers without overlaps (`source-stack.ts:1404-1407`, `source-planner.ts:1360`).
    - Slot promotion and the frame object are negative-only (`source-stack.ts:956-957`; `frameLayout` `:73, 79`).
    - `validate.ts:83-96` rejects any retained non-negative access.
  - **Change:**
    - When retained accesses lie in the incoming area (`incoming_candidate`, plus the Win64 `shadow_space`), S1 did not bind them, and no exposure has a base ≥ 0, lay them out with `frameLayout` generalized by origin and direction. Members sit at their entry offsets.
    - Create one source-only formal `stack_args` of struct type, appended last in `finalize` and recorded in `formal_stack_offsets`.
    - Spelling: `stack_args.arg_8`, `&stack_args.arg_8`, `*(uint64_t *)&stack_args.arg_10`, with a preamble struct. Python-like: `stack_args: struct{…}`.
    - `reconstruction/index.ts:1102` must not drop the signature for it.
  - **Soundness:** nothing is forwarded. Record:
    - `requireAbi('incoming_object', …)`: the sret pointer, globals, loaded pointers and unknown stores never designate the incoming area;
    - `presentation('incoming_object', …)`.
  - **Tests:** a SysV IR fixture with sret in `rdi`, `rsi`, `xmm0`, an add/increment/multiply at +8/+16/+24, and a 16-byte plus an 8-byte copy to `[rdi]`. `execute()` reproduces `{total+delta, count+1, weight*scale}` byte-exactly for wrapping `total`, `count = 0xffffffff` and NaN/−0.0 `weight`. Add an O0-style `lea`-based variant and a negative variant where the address escapes.
  - **Acceptance:** the three texts have 0 `entry_sp` and one `struct stack_args_… stack_args` formal. The checked view is unchanged.
  - **Depends on:** S2. The interpreter in `test/emitters/c/support.ts` needs by-value struct formals.

### S5 (optional): `frameLayout` keeps scalar members under spanning accesses

- [ ] A wide access that exactly covers whole narrower clusters plus padding merges them into a byte array today (`uint8_t local_d8[8]`, `arg_10[8]`). Keep the narrower members and spell the wide access as a cast at the first member (`source-stack.ts:35-112`).
  - Acceptance: the SysV `-O2` `matrix_variadic` and the `matrix_aggregate` texts get `uint32_t` members. `frame-object.test.ts` layout expectations are updated.
  - Depends on: S4.

### S6: Darwin and Win64 variadic functions print `...` and `va_start`

- [ ] **Problem.**
  - Win64 `matrix_variadic` (`-O0` `0x140001320`, `-O2` `0x140001170`, stripped `sub@0x140001160`) spills `rdx`/`r8`/`r9` into the home area (`*(uint64_t *)(entry_sp + 16) = arg1; …`) and walks it from +16. Its signature shows the spilled registers as formals.
  - Darwin (`-O0` `0x1000006b4`, `-O2` `0x1000004c4`, stripped `sub@0x1000004c4`) prints `double* entry_sp` as a formal and walks it.
  - **Root cause:**
    - `source-variadic.ts` handles only the caller side.
    - Nothing recognizes the callee's `va_start` code.
    - The planner makes every argument register a formal (`source-planner.ts:684-710`) and refuses declared variadic signatures (`:839`).
    - The Win64 home area is classified `shadow_space` (`src/analysis/stack/index.ts:86-101`).
  - **Change:**
    - **Detection.** Let `a` be the lowest exposed incoming offset (S1's floor): Darwin 0 (or the end of the named stack formals), Win64 `8 + 8n` with 1 ≤ n ≤ 4. A value based at `a` must be dereferenced at non-constant offsets or escape, and no known-offset incoming access may lie below `a` except bound named formals. Win64 additionally needs, for each i in [n, 4), exactly one unconditional entry-region store of the entry value of the i-th integer argument register to home slot `8 + 8i`, before any other access to that area or any call, with no other use of those registers.
    - **Rewrite:**
      - the named formals only, followed by `...`;
      - a source-only `va` value replacing the entry-SP base (`(uintptr_t)va + k`);
      - the Win64 home stores hidden;
      - a `va_list va; va_start(va, <last named>);` prologue (Python-like: `va = va_start(arg0)`);
      - `va_list` is `char *` on both ABIs.
  - **Soundness:** exact by the ABI definition of `va_start`. Record `requireAbi('variadic_convention', …)` and `presentation('va_start', …)`. If the base is only read at constant offsets, the function is not variadic: use S4 instead.
  - **Tests:**
    - `fixtures/bin/macho-arm64-symbols` `fixture_variadic` (2 `entry_sp` lines today): assert `...`, no `entry_sp`, and `execute()` equal to the C oracle for counts 0..9 with doubles placed at entry SP.
    - A Win64 IR fixture: the home stores are hidden and `execute()` returns the sum over registers and stack slots.
    - Negative: a missing home store or a direct use of `rdx` means no rewrite.
    - Add `va_list`/`va_start` to the test interpreter.
  - **Acceptance:** the six texts have 0 `entry_sp` and signatures `(uint32_t arg0, ...)` / `(uint32_t count, ...)`; the PE `arg1..arg3` formals are gone.
  - **Depends on:** S1, S2.

### S7: SysV variadic functions print `...` and `va_start`

- [ ] **Problem.** SysV `matrix_variadic` (`-O0` `0x401d10`, `-O2` `0x401bd0`, stripped `sub@0x401bd0`) prints 15 formals: `arg1..arg5`, `double arg6` and 7 × `uint128_t` (the register save area spills). It also prints `al` as `unknown_value("bits8_t", "non-argument entry register")` and the `va_list` initialization through `entry_sp`. Ghidra prints `double matrix_variadic(uint param_1)`.
  - **Change:** match the exact footprint; if anything differs, do not rewrite.
    - **Register save area** at frame offset R, 16-aligned. For i in [g, 6), one u64 store of the entry GPR i at R+8i (unconditional). For j in [f, 8), one 128-bit store of the entry xmm_j at R+48+16j, all inside one region guarded by `al != 0`.
    - **`va_list`** at frame offset v: `gp_offset = 8g`, `fp_offset = 48+16f` (two u32 stores or one u64), `overflow_arg_area` = entry SP + 8 + s, `reg_save_area` = R.
    - Every footprint store happens on every path before any other access to these areas, any call or any escape. The saved registers and `al` have no other use.
  - **Rewrite:**
    - the named formals followed by `...`;
    - the footprint stores hidden and the empty guard dropped (check that structuring removes an `if` with an empty arm and a pure condition);
    - `va_start(va, <last named>)` at the last footprint store;
    - `va` as a `va_list` frame member, with fields spelled `va[0].gp_offset` / `fp_offset` / `overflow_arg_area` / `reg_save_area`;
    - reloads of the overflow pointer print through S3.
  - **Soundness:** SysV `va_start` lowering _is_ these stores. The `al` guard only matters if a caller violates the ABI. Record `requireAbi('variadic_convention', …)` and `presentation('va_start', …)` listing the absorbed stores.
  - **Tests:** `fixtures/bin/elf-x86_64-symbols` `fixture_variadic` (24 `entry_sp` lines today):
    - assert one named formal, `...`, and no `uint128_t` formals or `unknown_value("bits8_t"…)`;
    - `execute()` against the oracle for counts 0..12, which forces the overflow path;
    - Negatives: a missing xmm store, an extra use of `rsi`, a call between footprint stores. Each gives no rewrite and output identical to today's.
  - **Acceptance:** the three texts have 0 `entry_sp` and the signature `(uint32_t arg0, ...)`.
  - **Not done here:** `va_arg` recognition; Ghidra does not do it either.
  - **Depends on:** S2, S3, S6 (shared `...`/`va` plumbing).

### S8 (optional): Callers see a callee's variadic interface

- [ ] Publish the S6/S7 footprint as a `NativeInterface` field: `variadic: {named_integer, named_vector, named_stack_bytes}` (`src/service/analysis/source-facts.ts:541-616`, native summaries). Bump `stack-calls` and `NATIVE_SUMMARY_FORMAT`.
  - Effect: call sites print the variadic arguments (`matrix_variadic(2, a, b)`), and `matrix_variadic_call` `-O2` keeps its double parameters `a`, `b`, which R3 does not restore.
  - Depends on: S6, S7, R3.

### S9 (optional): Declared signatures with stack, variadic or hidden-result parameters

- [ ] `source-planner.ts:835-840` refuses variadic and `hidden_result` declarations, and `bind` refuses stack locations (`:142`). With S1, S4, S6 and S7, a declared stack parameter can bind to an incoming formal or object member, and a declared `...` can drive S6/S7. No corpus function needs it. Without it, a DWARF signature with stack parameters re-creates `entry_sp`, and `reconstruction/index.ts:1102` drops the signature.

## J: `indirect_exit`

The relative x86 jump-table shape (`lea; movslq; add; jmp *reg`) and the compressed ARM64 shape (`adr; ldr[bh]; add …, lsl #2; br`) are already proved; `sqlite3GetToken` prints a `switch`. CONTINUE.md's "relative jump table unproven" is wrong. Every failure comes from where the proof chain starts, or from which functions discovery knows, not from the table encoding.

A whole-image instrumented run on sqlite3-arm64 found 21 tables proved and 291 distinct unresolved `br`: 9 compressed tables and about 282 indirect tail calls.

### J1: Re-prove jump tables on settled chains

- [x] **Problem.** `selectInnerLoop` (`0x1000bc1e4`) prints `if (value7 <= 12) return indirect_exit(0x1000bc594 + ((uint64_t)data_100132d3e[value7] << 2), …)`. Its graph holds 253 of the function's 639 instructions, so the case bodies are lost. Ghidra prints the `switch`.
  - **Done (J1):** `selectInnerLoop` proves the table at branch `0x1000bc590` (13 targets, guard exact), holds 639 instructions and prints `void selectInnerLoop(…)` with a `switch (value7)` (case 1 shares the out-of-range exit) and no `indirect_exit`; SQLite image-wide proved tables 21 → 22 (none lost); the full-tier OD lane changes only that text.
  - **Root cause:**
    - `proveJumpTable` (`src/analysis/discovery/jump-tables.ts:205-702`) runs once, when the branch is first decoded, on the predecessor map decoded so far (`discovery/index.ts:542-566`).
    - Per-graph validation (`:788-883`) only re-checks the recorded chain. When a chain member later gains predecessors, the table is rejected for good (`:877-880`).
    - A fresh proof on the final chain succeeds: 13 targets, table `0x100132d3e`.
  - **Change:**
    - After every `drain()`, including the drains the sweep triggers, re-prove in VA order every unconditional indirect branch whose chain context changed: a member gained a predecessor or became a seed, or the root gained instructions. Replace or drop the table entry, enqueue new targets, and drain until stable.
    - In per-graph validation, when the recorded chain fails, re-prove with the graph's predecessors and `is_entry`. Accept the result only if the chain is single-entry, every target is inside the function, and the targets are a subset of the current ones. The subset rule keeps validation removal-only, so it terminates.
  - **Tests:** `test/analysis/jump-tables.test.ts`, synthetic ARM64. Entry `b L1`; at `L1`: `sub w8,w0,#1; cmp w8,#2; b.hi out; adr; ldrb; add …, lsl #2; br`, with one case branching back to `L1`. The table resolves (3 targets, guard exact) and the case bodies are members. Negative: with the guard before `L1`, the table stays unresolved and the graph `partial`.
  - **Acceptance:**
    - `selectInnerLoop` has the table at `0x1000bc590` (13 targets), prints a `switch`, has no `indirect_exit`, and holds ≥ 600 instructions.
    - SQLite: proved tables go from 21 to ≥ 22, and none is lost.
    - Matrix and brotli texts are byte-identical except where a table newly resolves.
    - Fix CONTINUE.md's note and `docs/internals/discovery.md` (proofs are re-run on the final predecessors).

### J2: Register facts at the chain start

- [ ] **Problem.** In `jsonTranslateTextToBlob` (`0x10008b404`), the table base `x24` is set before the parser loop and survives `bl` calls (callee-saved). The straight-line prover sees it as an opaque symbol. The same holds for `sqlite3ExprCodeTarget`, `sqlite3ExprDataType`, `strftimeFunc`, `re_sql_func` (whose case blocks become 14 spurious functions) and `sqlite3_str_vappendf`. `sqlite3Fts5ExprNew` needs a "known zero-extended" fact for an index guarded on `w8` and loaded through `x8`.
  - **Change:**
    - Add an optional `entry_state` to the proof input, mapping a register to a constant or to "zero-extended from k bits". `read()` (`jump-tables.ts:233-242`) seeds roots from it.
    - When the straight-line proof fails, compute facts only for the roots it needs: a forward must-dataflow over the root's decoded members, including proved-table edges.
      - Lattice: ⊥ / const / zext k / ⊤.
      - Transfer: reuse the prover's exact evaluators, factored into a stepper. A 32-bit write gives `zext 32`.
      - Kills: x86 from the exact `payload.registers`. ARM64 from any register operand plus writeback, with an explicit kill-all list (PAC/AUT hints, SVC, anything without a payload). Calls kill every register not in the new `DiscoveryInput.preserved_registers`, filled from the image's `AbiProfile.preserved` (`service/queries/graphs.ts:104-112`, `prepare.ts:77-83, 214-222`). Without that input, calls kill everything (today's behavior).
    - Re-derive the facts on the final graph, and keep the table only if the targets are the same or a subset.
    - Record the defining instruction and every crossed call in the table's evidence (rule text names the ABI); optionally add `entry_facts` to `ResolvedJumpTable` (`core/contracts.ts:100`).
  - **Soundness:** call preservation is the ABI contract SSA already applies in proven mode (docs/internals/ssa-values.md). The facts hold on every decoded path, including the table's own edges.
  - **Tests:**
    - (a) a base in a callee-saved register, set before a loop that contains a `bl`, resolves with `preserved_registers`;
    - (b) the base redefined on one back edge does not resolve;
    - (c) (a) without `preserved_registers` does not resolve;
    - (d) a `w`-guarded index loaded via `x` resolves when its only definition is a 32-bit write, but not after a 64-bit `ldr`;
    - (e) the x86 `lea r14,[rip+T]` hoisted variant resolves;
    - (f) `paciasp` or `svc` in the loop kills the facts.
  - **Acceptance:**
    - `jsonTranslateTextToBlob` resolves (table `0x100132882`, 59 entries), prints a `switch` on the byte, and holds ≥ 800 instructions.
    - SQLite: the six tables above resolve (≥ 28 proved), and `re_sql_func`'s case blocks are no longer functions.
    - Only `yy_reduce` (348 entries > `MAX_JUMP_TABLE_ENTRIES = 256`) stays unresolved; see Decisions.
  - **Depends on:** J1. The two share one `discovery` bump if they land together.

### J3: Candidate functions at tail-jump targets

- [ ] **Problem.** In the stripped llvm-clang23 `-O2` cells, `matrix_switch` (ELF `0x401aa0`, PE `0x140001040`) is reached only by the entry point's tail `jmp` with the index fixed at 2.
  - Discovery absorbs it into the entry function: there is no symbol, no `.eh_frame`, and a leaf has no `.pdata`.
  - In the entry function the index is a constant, so the table does not prove, and the sweep turns the 10 case blocks into candidate functions.
  - `decompile --address va:0x401aa0` returns the _entry_ function, which is why OD prints `void fn_function() { return indirect_exit(0x401ada, …); }`.
  - The symbol-bearing cells have identical bytes and print a `switch`.
  - **Change:** after the seeded drain and before the sweep (`discovery/index.ts:736-741`), and in image-wide or continuation mode only, seed a `candidate` function at the target T of an unconditional direct jump J in root R when all of these hold:
    1. T is not a seed or an object address.
    2. T lies before R's entry, or at or after the next seed above it.
    3. The SP at J equals R's entry SP, by an SP-delta must-dataflow (new `stack-delta.ts`, x86 and ARM64).
    4. Every decoded edge into T is such a jump.

    Evidence: `derive('unconditional jump at entry stack depth to code outside the root body', …)`. Then J1 proves T's table, and R's jump becomes a direct `tail_call`.

  - **Soundness:** a function boundary is a presentation choice; the `tail_call` edge models the transfer exactly. This reverses the documented non-goal "no promotion of branch targets to seeds", so update `docs/internals/discovery.md` with these guards.
  - **Tests** (`test/analysis/discovery.test.ts`, synthetic):
    - (a) `mov edi,2; jmp T` with T before the entry → T becomes a candidate with a complete graph, and the entry has a `tail_call`;
    - (b) a backward jump inside the root's own range → no seed;
    - (c) `push rbp; jmp T` → no seed;
    - (d) T also reached by a `jcc` → no seed and no conflict;
    - (e) ARM64 `ldp x29,x30,[sp],#16; b T` → seed.
  - **Acceptance:**
    - In both stripped cells, `functions` lists `0x401aa0` / `0x140001040` and none of the case-block addresses.
    - `decompile` at those addresses prints `(uint32_t, uint64_t, uint64_t)` and a 10-case `switch` plus default, like the symbol-bearing cells.
    - The entry functions print a direct tail call.
    - Mach-O and all symbol-bearing cells are unchanged.
  - **Depends on:** J1.

### J4: Indirect tail calls in the source view

- [x] **Problem.** Done (J4): `sqlite3_result_pointer` prints `return ((… (*)(uint64_t, ...))arg3)(arg1);` and `pcache1Shrink` `((void (*)(uint64_t, ...))data_100168d80)(value0); return;` (frame-save route, `indirect_tail_call` abi_conformance), 0 `indirect_exit` in both; checked views and every other full-tier text unchanged; `test/reconstruction/indirect-tails.test.ts` executes both dialects with a stub target.
  - `sqlite3_result_pointer` (`0x100042080`, the inlined `invokeValueDestructor`) prints `return indirect_exit(arg3, "Indirect branch target is unresolved", …)` for `br x3` after a full epilogue. Ghidra prints `(*UNRECOVERED_JUMPTABLE)(param_2); return;`.
  - `pcache1Shrink` (`0x1000ecae0`) does the same with `br x1`, where `x1` is loaded from the global `xMutexLeave` slot `data_100168d80`.
  - About 282 of SQLite's unresolved `br` instructions are such tail calls, including frameless leaves like `memtraceRoundup`.
  - **Root cause:**
    - Neither lifter marks an indirect branch as a tail call (`arm64/index.ts:286-293`, `x86_64/index.ts:316-320`).
    - `tails` are built only for direct targets with a callee summary (`source-planner.ts:616-653`).
  - **Change** (reconstruction and renderer, source view only; the checked view keeps `indirect_exit`):
    - New `src/reconstruction/source-tails.ts` `classifyIndirectTails`. A candidate is an `indirect` exit without a table where the exit stack snapshot has SP = entry SP (`analysis/stack/index.ts:891-893`).
    - Exclude targets whose expression cone (≤ 128 nodes, loads are leaves) contains a constant in an executable range. These are switch-like and keep `indirect_exit`.
    - Return-location proof:
      - ARM64: `x30` at the exit is either the entry `x30`, or a reload of a slot that qualifies as a frame save with this exit included. For that, extract the frame-save qualification at `source-stack.ts:1004-1222` into a helper that takes an explicit exit list, and use it from both places.
      - x86-64: no store overlaps [entry SP, entry SP+8), the frame does not escape, and there is no unknown-address store.
    - The frame-save route records the existing `abi_conformance` requirement.
    - Accepted exits get `presentation('indirect_tail_call', …)` and a `TailProjection` with `target: null` plus the target value (`source-model.ts`).
    - Arguments: bind the ABI argument-register prefix from `block.register_exit`, as for indirect calls, with the list open. The producer of the indirect-call prefix was not located; start from `src/service/analysis/source-facts.ts`.
    - `planSourceStack` treats these exits like tail calls.
    - Renderer (`renderer.ts:8268-8310`): use the indirect-call `functionPointer` spelling (`:4385-4396, 4509-4535`). Print `call; return;` when the function's return projection is void, otherwise `return call`.
  - **Soundness:** with SP = entry SP and the return location proved to hold the entry return address, the branch is observationally a call of the target by our caller. The interface stays open and the target's effects unknown.
  - **Tests:** IR-built like `test/reconstruction/frame-saves.test.ts`, executed with a stub target:
    - (a) an ARM64 frame + call + restore + `br x3` becomes a value-target tail that forwards the result and passes x0;
    - (b) x30 overwritten → no tail;
    - (c) SP not restored → no tail;
    - (d) target = `adr` + table entry → no tail;
    - (e) a frame address passed to the inner call → no tail;
    - (f) x86 `add rsp,8; jmp rax` → tail, and a store to [entry SP] → no tail;
    - (g) checked view unchanged.
  - **Acceptance:**
    - `sqlite3_result_pointer` prints `((void (*)(uint64_t, ...))arg3)(arg1); return;` (or the `return` form) with no `indirect_exit`.
    - `pcache1Shrink` prints a function-pointer tail call through `data_100168d80` and records `abi_conformance`.
    - Both checked views are unchanged.
    - `selectInnerLoop` / `jsonTranslateTextToBlob` before J1/J2 keep `indirect_exit` (SP ≠ entry SP, code-address cone).
  - **Independent** of J1–J3. Rebase with S2: both touch `source-stack.ts`.

## Expected end state (prototype-backed where noted)

| artifact          | full tier now           | after the items                                                                                                                                                                                    |
| ----------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `physical_return` | 34 calls, 18 functions  | 0. Prototype of R1–R6: only the 18 targets plus `fts3EvalTestExpr` and `fts5ParseSetColset` changed, both toward their source types. `fts3EvalAllocateReaders` keeps a spurious `uint32_t` result. |
| `entry_sp`        | 163 lines, 13 functions | 0 expected. Prototype of S1–S3: `createFunctionApi` 18 → 0, SysV variadic 38/31 → 2. S4, S6 and S7 not prototyped.                                                                                 |
| `indirect_exit`   | 6 functions             | 0 expected in the corpus. Probes: tables proved for J1/J2; J3 seed by analysis; J4 not prototyped. Image-wide, `yy_reduce` remains.                                                                |

## Decisions recorded with this roadmap

- **R6 (untyped scalar FP result):** proven mode only if the precision check is clean, otherwise `likely`. The item decides from its own measurement.
- **J3:** reversing discovery's "no promotion of branch targets to seeds" is accepted with the four guards above. A boundary is presentation; the transfer stays exact.
- **Not in scope:**
  - `yy_reduce`'s 348-entry table. It needs `MAX_JUMP_TABLE_ENTRIES` above 256 (`discovery/index.ts:29`, mirrored in target recovery). That is a structural cap, not the work budget; raise it only by an explicit decision.
  - Hiding outgoing-argument stores to budget-cut callees (`createFunctionApi`'s `frame.local_88/80/90`). This needs closed callee interfaces or `likely` arity.
  - `va_arg` recognition.
  - The `__unknown_effect` functions (unlifted encodings such as `INS_asimdins_IR_r` and `USHL_asimdsame_only`), a G9-style follow-up.

## Measurement

Every item is measured with odbench on the full tier, from a worktree with a built `dist/`:

```sh
bun run build
/Users/df0/Documents/projects/od-wt/heavy.sh bun run bench run od --label <item> --repo <worktree> --tier full
bun run bench all --label <item> --base od-head --tier full        # judged against Ghidra and against head
grep -c 'physical_return\|entry_sp\|indirect_exit' .odbench/lanes/od-<item>/texts/<acceptance file>.c
```

Report per item:

- the artifact count before and after for the acceptance functions;
- the set of texts that differ from `od-head` (it must equal the expected set);
- readability against head and against Ghidra on the changed functions;
- comprehension and its paired delta;
- the work of brotli `main`, `whereLoopAddBtreeIndex` and the changed functions (M1).

A per-item judge run on the full tier costs on the order of $0.10–0.50 (only changed texts are judged).

The corpus is a development set. Claims of generalisation need a new sealed suite (docs/PERFORMANCE.md "sealing rule").

## Definition of done for each item

- The listed acceptance functions change as stated, every other full-tier text stays byte-identical (or each other change is explained and goes toward the source), and the checked view is unchanged unless the item says otherwise.
- Semantic tests in the named files: behavior through the IR builder and `execute()` of emitted C and Python against oracles, not text snapshots. Run `bun run typecheck`, `bun run test:unit` and `bun run test:integration`.
- Validation records and ABI requirements as named; component versions bumped at merge time.
- Docs updated with exercised evidence only: docs/CORE.md (result rules, stack presentation, helper vocabulary), the relevant docs/internals pages, and a docs/PERFORMANCE.md entry with the odbench numbers. Tick the box here with a one-line evidence note.

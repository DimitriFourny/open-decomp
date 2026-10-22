# Roadmap 4: beat Ghidra on odbench quality and decompile speed

## Goal and rules

The odbench full tier after roadmap 3 (`.odbench/reports/2026-10-22-145217-od-rm3-final-full/report.md`, lane `od-rm3-final` = `main` `f919627`) puts Open Decomp ahead of Ghidra 12.1.4 on readability (0.726) and QA answers (78% vs 67%). It is behind on functions with text, comprehension coverage, wrong claims and the readability noise dimension (0.383): these are the goals of this roadmap. Decompile speed has its own target (D8). Token counts are not a goal (D9): the items that reduce tokens stay for their readability and noise value, and no item trades correctness or information for tokens. Roadmap 3 is done; its text is at `git show 11135ed:TODO.md`. The former continuation notes (roadmap 3 leftovers; reliability, ObjC and hygiene backlog) are at `git show 11135ed:CONTINUE.md`.

Each item is sized for one agent. The causes come from an investigation on 2026-10-22 in ten slices: result types, callee summaries, call sites, floating point, frames and saves, preamble, expressions, control flow, coverage and speed. Each slice read the code and checked its findings with `--json` and `--view checked` outputs, instrumented throwaway copies, and prototypes run on the corpus. Prototype numbers are labelled _measured_; text-based estimates are labelled _[estimate]_. No prototype wrote tests or validation records, so every item still has to be implemented properly. Line references are at `11135ed` (= `f919627` + docs).

- **Correctness first.** Every rewrite keeps fixed-width arithmetic, signedness, memory and call ordering, aliasing and explicit unknowns. A shorter wrong program is a regression.
- **Proven vs likely.** odbench measures the default `proven` mode. A rule that can only be `likely` (behind `inference: "likely"` and `LIKELY_GATE`, `src/reconstruction/source-likely.ts`, `scripts/bench/likely-precision.ts`) does not move the benchmark. A proven rule either needs no premise, or rests on an ABI or language premise recorded with `validation.requireAbi(...)`. Only the premises listed under "Decisions" may be added.
- **Fix the owning shared layer**: lifter, discovery, SSA, native summaries, reconstruction or renderer. Never patch emitted text with regexes. Never special-case functions or fixtures. Both dialects consume the same result.
- **Validator records.** Every new presentation rule writes a `validation.presentation(...)` record (`src/reconstruction/local-validation.ts`). The checked view (`--view checked`) stays byte-identical unless the item says otherwise (only A1 and F2 change it).
- **Never raise budgets.** The request work limit stays 10M. An item may reallocate the request's own work between stages (C3). Work spent outside the request's accounting counts as raising, except the open-time job of T8, which is not a request and runs under its own reported budget (Decision D4). Near-limit functions: `sqlite3Fts3Incrmerge` 9.87M, `isDate` 9.79M, brotli `main` 9.24M. An item that adds work there pays for it in the same change.
- **Work counts are noisy until T2 lands.** Two runs of one build differ in about 21 SQLite functions, by up to a few hundred units each. Until T2 lands, treat |Δ| ≤ 300 per function as noise.
- **Version bumps happen at merge time.** Take the next free number on `main`; do not pre-assign. Components:
  - `discovery`, `stack-calls`, `reconstruction` and `pipeline` in `src/service/analysis/versions.ts`;
  - `C_EMITTER_VERSION` (`src/emitters/c/index.ts`) and `PYTHON_LIKE_EMITTER_VERSION` (`src/emitters/python-like/index.ts`);
  - `NATIVE_SUMMARY_FORMAT` (`src/service/analysis/native-summaries.ts`).

## Baseline: od-rm3-final vs Ghidra, full tier (231 paired functions)

| row                                                  | OD                                                          | Ghidra                                                    | status                            | moved by                    |
| ---------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------- | --------------------------------- | --------------------------- |
| functions with text (of 237)                         | 232 (4 work limit, 1 invariant failure)                     | 237                                                       | behind                            | C1–C4                       |
| lexical tokens vs Ghidra (geomean)                   | 1.337 (sum 202,541 vs 129,170)                              | 1                                                         | not a goal (D9)                   | P1, P2, E1–E6, A1–A3, C2, K |
| Claude tokens vs Ghidra (geomean)                    | 1.477                                                       | 1                                                         | not a goal (D9)                   | the above, P3, P4, F3       |
| readability overall                                  | 0.726 (136 / 62 / 33)                                       | —                                                         | ahead                             | all                         |
| readability noise dimension                          | 0.383                                                       | —                                                         | behind                            | P, F, A, E, C2, K, V        |
| readability control_flow                             | 0.570                                                       | —                                                         | barely                            | L1–L4, E                    |
| comprehension coverage (0–4)                         | 2.665 (SQLite 2.50, brotli 2.67, matrix 2.83)               | 2.723 (2.73, 3.07, 2.67)                                  | behind                            | V1–V3, K, F, E2, E3         |
| wrong claims per function                            | 2.67 (SQLite 3.07, brotli 3.13)                             | 2.26 (2.28, 1.87)                                         | behind                            | V1–V3, K, F, E2, E3         |
| QA correct                                           | 78%                                                         | 67%                                                       | ahead                             | —                           |
| QA Claude tokens per correct answer                  | 4,785                                                       | 3,528                                                     | not a goal (D9)                   | token items, C2, K2–K4      |
| decompile time after open vs Ghidra's whole run (D8) | SQLite 121.4 s, brotli 7.7 s, matrix 0.7–1.9 s; total 140 s | SQLite 38.7 s, brotli 3.9 s, matrix 3.5–7.3 s; total 87 s | behind (SQLite 3.1×, brotli 2.0×) | M2, T1–T9, C4               |

### Where the gap comes from

**1. Return types (largest wrong-claim class in SQLite).** Counted from the lane texts against the source declarations:

| source declaration | OD prints `void` | OD prints a value | OD prints `unknown_result` | Ghidra                 |
| ------------------ | ---------------: | ----------------: | -------------------------: | ---------------------- |
| `void` (42)        |               17 |                13 |                         12 | 40 `void`              |
| a value (189)      |                8 |               180 |                          1 | 172 of 186 (14 `void`) |

The grader counts every "returns X" on a void function as wrong. 4 of the 8 value→void cases are correctness bugs: callers in the image read the result (V1).

**2. Wrong claims by kind.** All 1,203 listed wrong claims (OD 644, Ghidra 559) were classified (`judge_batch`):

| kind                                                                                                                | OD per fn | Ghidra per fn | OD − Ghidra | SQLite OD / Ghidra |
| ------------------------------------------------------------------------------------------------------------------- | --------: | ------------: | ----------: | -----------------: |
| control flow                                                                                                        |      0.51 |          0.42 |       +0.09 |            60 / 51 |
| return value                                                                                                        |      0.30 |          0.22 |       +0.08 |        **42 / 12** |
| calls (arguments, formats, function pointers)                                                                       |      0.28 |          0.21 |       +0.07 |            34 / 23 |
| decompiler artifact read as behavior (`fp_mul(64, …)` read as a call, `unknown_value`, frame slots, raw `va` walks) |      0.19 |          0.13 |       +0.06 |             11 / 6 |
| inlined or delegated code                                                                                           |      0.38 |          0.34 |       +0.03 |            65 / 50 |
| constants and fields                                                                                                |      0.28 |          0.24 |       +0.03 |            55 / 50 |
| arithmetic and data flow (packed `value0/value1` pairs, conversion chains)                                          |      0.19 |          0.16 |       +0.03 |            12 / 14 |
| parameters                                                                                                          |      0.09 |          0.15 |       −0.06 |              8 / 5 |
| grader concedes the claim is correct                                                                                |      0.53 |          0.50 |       +0.03 |                  — |

**3. Tokens.** The preamble (everything before the signature) costs 28.5k lexical tokens over 232 texts:

- inlined data tables 15.6k (six 256-byte maps such as `sqlite3UpperToLower` and `sqlite3CtypeMap` are 87% of that, repeated in 38 functions);
- struct bodies 7.2k (482 of 1,382 members are `pad_0x…`);
- typedefs 2.1k;
- externs 2.0k;
- includes, defines and helpers 1.5k.

Without any preamble the geomean would be 1.147; statements alone are 1.145 against Ghidra's statements. Comments are 33.5 KB (Ghidra 1.3 KB): open-arity lists 14.2 KB, `/* partial */` struct notes 6.0 KB, the FP-environment note 4.6 KB and table notes 3.1 KB. The `/* C-like */` banner is stripped before odbench counts tokens. Statement-level costs:

- `(uintptr_t)` 1,876;
- 202 derived-pointer temporaries;
- `frame.` prefixes 2,292 (4.6k tokens);
- 64-bit cell reassembly in 259 expressions;
- 67.7 KB of `boundary("unknown_read_write", {…60 registers…})` lines in brotli `main`, `isDate` and `sqlite3Fts3Incrmerge` (C2);
- `isDate` alone is 18,789 tokens vs Ghidra's 6,521 (A1, F1, E3).

**4. Noise.** OD loses the noise dimension in 118 of 232 functions. Keywords in the judge's reasons there: struct 95, cast 60, artifact 43, goto 35, frame 30, comment 24, value temporaries 24, pad 24, typedef 23, `unknown_value`/`fp_*` helpers about 20.

**5. Control flow.** Loop discovery matches Ghidra: the per-function loop count is identical in 217 of 232 functions. Loop form does not:

|                    |                       `while (true)` | do-while | `while (c)` | `for` |
| ------------------ | -----------------------------------: | -------: | ----------: | ----: |
| OD (437 loops)     |                                  217 |      170 |          32 |    18 |
| Ghidra (409 loops) | 66 (43 of them `do {} while (true)`) |      259 |          42 |    42 |

There are three causes: a loop header that prints a statement, bottom tests whose loop-carried copies are live on exit, and exit choice (L1–L4).

**6. Coverage.** Four functions exceed 10M work: `sqlite3_str_vappendf`, `sqlite3Select`, `sqlite3Pragma` and `sqlite3WhereCodeOneLoopStart`. The work is in the selected body: SSA 2.5–3.6M, types 1.8–2.6M, render. Callee summaries are ≤ 17% of it. `sqlite3CodeRowTrigger` fails a reconstruction invariant. A failure returns no text at all.

**7. Decompile time.** SQLite takes 123.3 s: 1.8 s to open plus 121.4 s for 114 decompiles (the lane started at load average 7, so these times are inflated). In a profile of the worker:

- callee-unit preparation 32.5%, mostly 681 _repeat_ preparations of units the cache refuses to keep;
- GC 13.4%;
- dependency-ledger fingerprinting 7.6%;
- the per-request cache layer 12.4% (about 158 ms per request);
- the requested function's own pipeline 14.7%.

The 4 work-limit failures cost 20.6 s and produce no text.

**Ruled out by measurement:**

- _More callee-summary budget._ At 10× work, 0 of the 25 void-source mismatches print `void`. 19 texts change, with mixed results. 40 texts gain only the FP note.
- _An image-wide summary pass to change texts._ Estimated at about 290M work, roughly 100 s single-threaded on SQLite, and fuller summaries do not fix the artifacts (above). T8 runs an open-time preparation pass for speed only; texts and request work stay unchanged.
- _Library prototypes as escaped-object extents._ A C pointer parameter does not bound accesses: `pipe(int[2])` is declared `int *`.
- _A Ghidra-style void heuristic._ It can only be `likely`, and Ghidra pays for it with 14 value→void errors.

## Lanes and order

The lanes are independent. Inside a lane, follow the arrows. Items in different lanes that touch the same file are listed below; the second to merge rebases onto the first.

- **M1** (odbench signature rows and diagnostics) and **M2** (speed rows) come first. They are small, and every item uses their rows.
- **Lane C (coverage):** C1; C2 → C3; C4 (C3's reserve is calibrated after C4a/b/d).
- **Lane V (return types):** V1 → V2 → V3.
- **Lane K (call sites):** K1 → K2 → K7; K3, K4, K5 and K6 are independent.
- **Lane F (floating point):** F1 → F4 → F5; F1 → F2; F3 is independent.
- **Lane A (ARM64 lifting and frames):** C1 → A1 → A2; A3 is independent. A1 must keep FPCR out of its clobber set, because F1's `isDate` gain depends on it.
- **Lane E (expressions):** E1 → E2 (judge them together); E1 → E6; E3, E4 and E5 are independent.
- **Lane P (preamble):** P1; P2 → P3; P4.
- **Lane L (loops):** L1 → L3; L1 → L2; L4 last (highest risk).
- **Lane T (time):** T1; T2 → T3 → T6 → T8 → T9; T4 → T5; T7. T8 and T9 need M2 for their acceptance rows.

Files that several items touch:

| file                                      | items                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/emitters/renderer.ts`                | P1 (tables `:3866-3956`), P2/P3 (`structureBodies` `:3369-3435`, header comments `:9295-9326`), F1 (`printedCopies` `:5884`), F3 (`:8823-8843`), K6 (`functionPointer` `:4690-4727`, tail args `:8425`, `:8519`), E1 (`memberAccess` `:3146`, `sourceStorage` `:4280`, `:1844-1855`), E4 (`chooseLocalTypes` `:7453`), L1–L4 (loop printing, `restateTest` `:8031-8186`), C2 (`commaValue` `:6624`), C3 (`renderSource` `:9484-9519`), A3 (frame printing `:9136-9177`), V2 (`unknown_result` `:9001-9005`) |
| `src/service/analysis/source-facts.ts`    | V1/V2 (`:2050-2072`), K4 (`sourceAddresses` `:663-902`), T1 (`:1817-1837`), T2/T3 (`:1096-1300`), T4/T5 (`:1869-1881`), C3 (`:1611`), C4a                                                                                                                                                                                                                                                                                                                                                                   |
| `src/reconstruction/source-planner.ts`    | V1 (`:1557-1573`), V2 (`:706-715`, `:1120-1151`, `:1206-1220`), K3 (`:544-636`), K2 (`:386-390`, `:566-573`)                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/reconstruction/source-results.ts`    | V2, V3 (`:484-489`, `:556-567`, `:926-936`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/service/analysis/native-worklist.ts` | T4, T5, V3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/reconstruction/source-variadic.ts`   | K1, K2, K7                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/reconstruction/source-stack.ts`      | A1 (`:1098-1101`), A3 (`frame()` `:2423-2531`, `frameLayout` `:66-316`)                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/reconstruction/source-fp.ts`         | F1, F4, F5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/lifters/arm64/*`                     | A1, A2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/emitters/source-control.ts`          | L1–L4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `src/emitters/source-inlining.ts`         | E1, E6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/reconstruction/index.ts`             | C1 (`:1022-1031`), K2 (`:286-302`), V2 (`:707-790`)                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## M1: Signature and diagnostic rows in odbench

- [x] **Problem.** The largest excess wrong-claim class (return types) does not appear in the report. Comprehension is one sample per function, so its noise is about ±0.1. The OD lane does not record diagnostics, so this investigation needed throwaway census scripts for cut callees, partial reasons, unsupported encodings and open arity.
  - **Change** (`scripts/bench/odbench/`):
    - `od-worker.ts`/`lane-od.ts`: record per function the diagnostics (code plus first sentence, deduplicated) in `lane.json`. This is not part of text identity.
    - New `signature.ts` with a tolerant C definition reader for the three lane styles: OD (preamble, one-line signatures), Ghidra (signature line, then `{`) and source (macros such as `SQLITE_API`, multi-line parameters, `KEEP`). The report gains a "signature vs source" table per lane:
      - return kind (void / value / `unknown_result`) against the source declaration;
      - parameter count equal / fewer / more.
    - Report section 5: per-lane counts of `unknown_result`, `unknown_value(`, `__unknown_effect(`, `boundary(`, `requirement_predicate(`, function-pointer casts containing `...`, and functions with a `frame` struct. Add a separate counter for conditions holding an embedded assignment (`(x = e) op k`). OD prints 46 of these that `comma_conditions` (`metrics.ts:253-277`) does not count. Leave the existing counter unchanged.
  - **Tests:** odbench unit tests in `test/bench/` with one signature per lane style, including multi-line parameters, function-pointer parameters and K&R-free macros. The diagnostics must round-trip through `lane.json`.
  - **Acceptance:**
    - `bun run bench report --lanes od-rm3-final,source --tier full` re-renders from the caches, with no model call.
    - It shows OD void-source 17/13/12 (void/value/unknown) and value-source 8/180/1 (±1 for parser differences, explained).
    - Texts and judgments are unchanged.
  - **Done (evidence).** `bench report --lanes od-rm3-final,source --tier full` re-renders from the caches with no model call: void-source 17/13/12, value-source 9/180/1 (the prototype's 8 omitted the stripped `sub@0x10000041c` `KEEP aggregate` function, which the reader matches by taking the text's last definition; 232 paired, not 231), Ghidra 40/2/0 and 14/176/0. Embedded-assignment conditions count 41 in OD (casts before the group and arithmetic operators after it included; the prototype's 46 was not reproduced by any variant tried: the only `if`/`while` lines with an assignment group that this counter skips are 6 comma conditions, which stay in `comma_conditions`), 17 in the source, 0 in Ghidra. `bench run od --label rm4-m1`: 232 texts byte-identical to `od-rm3-final`, state/reason/sha unchanged, 237 functions with `diagnostics` (202 with at least one).

## M2: Speed rows that match the D8 target

- [x] **Problem.** The scorecard's cold time adds opening and decompiling, but the target (D8) compares the decompile time after open with Ghidra's whole run (import, analysis and decompiles), and asks for quick first decompiles. The report has neither row, no worker memory figure and no parallel OD lane: the lane header always records `jobs: 1` (`scripts/bench/odbench/lane-od.ts:257`).
  - **Change** (`scripts/bench/odbench/`):
    - `od-worker.ts`/`lane-od.ts`: record per binary `open_ms` (`openBinary`, including the T8 job once it exists, with the job's own time as `open_job_ms`), `first10_ms` (wall time from open to the 10th corpus function's result, in corpus order), the existing `decompile_ms_total`, and the peak RSS of every process.
    - `--jobs N`: decompile one binary's functions with N request workers over one opened project (needs T9; until T9 lands it accepts only 1). The lane header records N.
    - `report.ts`, scorecard and section 8: per binary and in total, OD decompile time after open against Ghidra's `cold_ms`, the ratio and the D8 threshold (1.25×); `first10_ms` against 5 s on SQLite; open time and peak RSS as reported values. Keep the existing cold-time row.
  - **Tests:** odbench unit tests in `test/bench/`: the ratio and threshold rows from a synthetic lane, and `--jobs 1` lanes re-render unchanged.
  - **Acceptance:** `bench report` on the existing lanes shows SQLite 121.4 s vs 38.7 s (3.13×) and the total 140 s vs 87 s (1.61×) without a model call; a new `od` run records `first10_ms` and peak RSS.
  - **Done:** `bench report --lanes od-rm3-final,source --tier full` (from caches) shows SQLite 121.4 s vs 38.7 s (3.13×) and total 140.0 s vs 86.7 s (1.62×; 1.61× is the rounded 140/87); an `od` run (`od-rm4-m2`, loaded host) records `first10_ms`, `open_ms` and per-process peak RSS with texts byte-identical to `od-rm3-final`; `test/bench/odbench-speed.test.ts`.

## C: Coverage and failures

### C1: No edge copy into a proven stack-address phi

- [x] **Problem.** `sqlite3CodeRowTrigger` (`0x1000d41a8`) fails in both views with "Reconstruction invariant failed: a parallel edge copy has an invalid destination or width". `isDate` hits the same failure once A1 lands. **Done:** `sqlite3CodeRowTrigger` now has text in both views (310 source lines, 5.85M work in lane `od-rm4-c1`); lane diff vs `od-rm3-final` is that one new text, every other text byte-identical (reconstruction 78 → 79).
  - **Root cause:**
    - `planSourceStack` proves that a loop phi is one frame address on every edge (`source-stack.ts:659-667`); here x28 carries `x29 − 0xb0`.
    - `reconstructView` therefore marks every `sourceStack.addresses` id inline (`src/reconstruction/index.ts:1043`).
    - The edge-copy filter (`:1022-1031`) drops only `forcedInline` destinations, so the copies into the inline phi stay.
    - `validate.ts:178-184` then rejects them.
  - **Change:** in that filter, also drop copies whose destination is in `sourceStack.addresses`. Add a comment: a proven stack-address parameter prints as its frame address, and every incoming value has the same offset.
  - **Soundness:** proven, with no new rule. The phi is exactly entry SP + offset on every path.
  - **Tests:** `test/reconstruction/frame-object.test.ts` or `source-stack-promotion.test.ts`, IR builder:
    - a loop carrying `fp − 0xb0` in a callee-saved register, re-materialized on one edge as a different SSA value, with loads and stores through it;
    - `execute()` emitted C and Python-like against an oracle;
    - assert that no invalid-destination error is raised.
  - **Acceptance:**
    - `sqlite3CodeRowTrigger` gets text in both views (measured: 310 lines, 5.42M work).
    - Every function that renders today is byte-identical in both views. Today a live inline stack-address destination always threw, so no existing render reaches the new branch.

### C2: Exhausted validation never degrades the text

- [x] **Problem:** _(Done: lane `od-rm4-c2` at 10M: brotli `main` 55,953 → 46,419 B, `isDate` 112,543 → 81,332 B, `Incrmerge` 80,331 → 56,081 B, `boundary(` 9/27/23 → 0; every other text byte-identical to `od-rm3-final`; checked view identical; `sqlite3Select` at 40M renders in one attempt per metadata mode, then stops at the evidence catalog bound (C3).)_
  - 59 `boundary("unknown_read_write", {"arm64:x0:0:64", … 60 registers})` statements (67.7 KB) in brotli `main` (9), `isDate` (27) and `sqlite3Fts3Incrmerge` (23);
  - up to 5 full render attempts (5.3M work on `sqlite3Select` at 40M);
  - a latent "A comma statement printed a line" failure behind `sqlite3Select`/`sqlite3Pragma`.
  - **Root cause:**
    - When `ValidationAllowance` runs out (`local-validation.ts:56`), every phi-copy check in the renderer (`renderer.ts:5391-5439`) pushes its own "allowance exhausted" record (`local-validation.ts:537-590`): `Incrmerge` 137, `isDate` 130, brotli `main` 147. These fill the 256-record bound (`:647`).
    - After that, `presentation()` refuses every rewrite (`:595-625`):
      - a refused `call_effects` prints the call's clobber contract as a separate statement (`renderer.ts:4520-4532`);
      - held calls then miss their readers and throw `CallInliningRetry` (`:4681`, `:8752`), and `renderSource` rebuilds up to 5 times (`:9487-9511`).
    - `commaValue` (`:6624`) accepts a call as a comma operand without checking that `call_effects` will be admitted, so the refused call prints a line inside the test, which then throws (`:6694-6698`).
  - **Change:**
    - (a) `LocalValidationSession.check`: once the allowance is exhausted, fold `parallel-copy` checks into one terminal limitation record per emission. The record reads "N later phi-copy emissions not validated; local validation allowance exhausted". Reuse the slot logic of `skipExhaustedBitvector` (`:520-535`).
    - (b) `commaValue` admits a call as a comma operand only after `localValidation.presentation('call_effects', …)` admits it, with the same scope and contract, recorded at planning time.
  - **Soundness:** no proof is weakened. The unvalidated copies stay unvalidated and are summarized in one record.
  - **Tests:**
    - `test/reconstruction/local-validation.test.ts`: exhaustion yields one aggregated record, and later presentations are still admitted.
    - A renderer test in which a refused `call_effects` call is never used as a comma operand. `execute()` both dialects.
  - **Acceptance** (prototype, measured at 10M):

    | function      | bytes before → after | `boundary(` before → after |
    | ------------- | -------------------: | -------------------------: |
    | brotli `main` |      55,951 → 46,417 |                      9 → 0 |
    | `isDate`      |     112,804 → 81,593 |                     27 → 0 |
    | `Incrmerge`   |      80,331 → 56,081 |                     23 → 0 |

    `sqlite3Select` renders in one attempt at 40M. All other texts are byte-identical. The checked view is byte-identical (measured on `Incrmerge`: 171,818 bytes both ways).

  - **Expected effect:** lexical tokens about −5k outside `isDate` [estimate]; noise in three large functions; QA tokens (brotli `main` carries 3 QA questions).

### C3: Always produce text within the unchanged 10M

- [ ] **Problem.** Four functions fail with no text. Optional stages (callee summaries, image types, pointer evidence, goto search, provenance metadata) are sized as fractions of what remains, not against what the mandatory tail needs. Two output bounds turn finished text into a failure:
  - the evidence catalog of 10,000 ids (`catalog.ts:36-62, 95-101`, `src/core/tools.ts:538`);
  - a cache-catalog type with more than 1,000 `evidence_ids` (`src/project/cache/index.ts:92`).
  - **Change:**
    1. _Tail reserve._
       - At the start of source evidence (`source-facts.ts:1611`) and image types (`image-types.ts:990-994`), compute `T = c × IR nodes`. Calibration: the reconstruct + render + validate tail costs 232–250 work per node on `sqlite3Select`/`sqlite3Pragma`. Use a generous `c`.
       - Set pool = min(current share, max(0, remaining − T) × share).
       - Functions whose current share already leaves ≥ T keep identical budgets. When remaining ≤ T, the optional stage is skipped with its existing explicit reason.
    2. _Text-first render._
       - After `reconstruct()` (`renderer.ts:9484`), when remaining work is below `k_full × units + k_text × units`, run `attempt('omitted')` directly. Rendering with `metadata: 'omitted'` produces byte-identical text and saves 1.4–1.8M on large functions (measured).
       - The goto search runs only from a sub-allowance that leaves the text render's reserve.
       - Record the omission with reason `budget` (`withMetadataOmissions`, `src/project/cache/limits.ts:15-43`; `src/core/emission-limits.ts`).
    3. _Evidence overflow is a metadata omission._ When evidence exceeds a bound, publish the text with the result `evidence` table shed and `evidence_ids` truncated. Add a coverage entry ("N proof references omitted; the pseudocode text is complete"). Do not throw.
  - **Soundness:**
    - Nothing about the program is weakened.
    - An omitted render has byte-identical text (measured on brotli `main`, `isDate`, `Incrmerge`, `sqlite3CodeRowTrigger`).
    - Skipped stages keep their explicit reasons, and the state stays `partial`.
    - Every decision is a function of the request's own counters, so determinism under budgets holds.
  - **Tests:**
    - `test/service/selected-work.test.ts`: a body whose tail reserve exceeds the remaining work still returns text, and the skipped stage is named.
    - `test/emitters/metadata-limits.test.ts`: a budget-chosen omitted render has identical text and reason `budget`.
    - `test/service/evidence-work.test.ts`: more than 10,000 evidence ids publish text with an omission.
  - **Acceptance:**
    - `sqlite3WhereCodeOneLoopStart` gets text at 10M. Measured with C2 + C4a + text-only render: rendering finished at 8.14M, and only the evidence bound then failed.
    - `sqlite3_str_vappendf` gets text [estimate: render starts at 7.61M and needs about 1.5M].
    - Every other text is byte-identical unless its pool falls below T (list those).
    - The checked view is unchanged.
  - **Depends on:** C2. Calibrate after C4.

### C4: Remove superlinear and repeated work on large bodies

- [x] **Problem.** The mandatory floor exceeds 10M for `sqlite3Select` (≈11.65M) and `sqlite3Pragma` (≈14.0M), measured with summaries off at a 40M measurement budget. Optional stages also blow up with body size. _Done (C4): (a), (b), (d) as specified; (c) reuses the value analysis after fixpoint-keeping rounds, re-solves only the blocks reachable from comparison/rule/threading/join changes, skips rounds that only removed unreachable blocks, and skips the copy pass (2,031 lane `simplifySSA` calls identical to the full rounds; simplify 1.75M → 1.33M on `sqlite3Select`, 2.32M → 1.60M on `sqlite3Pragma` at 40M); rewrite and trivial-parameter elimination still read the whole graph. Lane: 8 texts change through budget-dependent optional stages; work −5.5%; `sqlite3Select`/`sqlite3Pragma` still exceed 10M._
  - **Change** (byte-identical by construction):
    - (a) `nativeArgumentValues` (`src/service/analysis/native-arguments.ts:29-39, 85-97`) scans the whole IR per call. Build one per-IR index (assignments, stores, call register inputs by call id, terminator exit bindings, concat by operand tuple) once per caller loop in `nativeShapeTransfers` (`source-facts.ts:1305-1328`) and `functionTypeObjects` (`image-types.ts:317-342`), and pass it in.
      - Measured: −0.56M on `Incrmerge`, −0.72M on `isDate`, up to −9M on `sqlite3Pragma` at 40M.
      - `isDate`'s text changes only because the freed work lets the budget-dependent image-type merge finish. Report it.
    - (b) `rank` (`src/presentation/index.ts:1107-1123`): return before the edge scan when `selection < 0` (about −0.2M on `sqlite3Pragma`).
    - (c) `simplifySSA` (`src/analysis/values/index.ts:383-407`): after round 1, run `propagate`/`rewrite`/`propagateCopies`/`eliminateTrivialParameters` only over the cones the previous round changed, reaching the same fixpoint. Rounds 2..7 cost 1.2–1.8M on `sqlite3Select`/`sqlite3Pragma`.
    - (d) Memoize `restructure` in `AttemptPlans`, keyed by the evaluated structuring conditions. `WhereCode` and `sqlite3Select` each ran 4 identical restructures.
    - (e) Not in this item (would weaken checking): running `assertValidIR` only after the final simplify (0.6–0.95M per big request).
  - **Soundness:** pure refactors, with no rule changes and no new records.
  - **Tests:**
    - `test/analysis/values/values.test.ts`: incremental and full simplify reach the same SSA on builder IR with chained constants and phi rewrites (`execute()` oracles).
    - `test/presentation/structuring.test.ts`: the layout is identical with and without the early exit.
    - The existing source-facts argument tests pass.
  - **Acceptance:**
    - Corpus texts are byte-identical, except where freed work changes budget-dependent optional results (each such text is listed).
    - With C3, `sqlite3Select` and `sqlite3Pragma` get text at 10M [estimate: the gaps are 1.7M and 4.0M; (c) was not prototyped].
  - **Expected effect:** functions with text up to 237 (with C1, C3); decompile time on large functions.

## V: Return types

### V1: Caller result-use evidence (correctness)

- [x] **Problem.** Four value-returning functions print `void` although callers in the image read the result: _(done: source-built fixture `test/service/analysis/caller-result-use.test.ts` (a `static noinline` void-like `post_call` kept non-void by its reading caller, `post_ignored`/`bump` stay `void`); OD lane `od-rm4-v1b` prints integer results for the five functions plus `sqlite3PagerSavepoint` (source `int`), no other text changes, checked view identical; about +340k work on the 38 SQLite functions where the scan runs, near-limit functions unchanged)_
  - `sqlite3GetToken` (17 of 18 BL sites read w0/x0; OD's own `getConstraintToken` text reads it);
  - `getConstraintToken` (11/11);
  - `sqlite3BtreeOpen` (5/5);
  - `sessionRetryConstraints` (2/2).

  `rtreeInsertCell` (5/5 sites read) prints `unknown_result`.
  - **Root cause:**
    - `incidental_result` assumes that callers read no result and never checks. Its record says "no caller was scanned" (`source-planner.ts:1206-1220`).
    - `function_return_demands` holds demand only from units the request happened to prepare (`source-facts.ts:2050-2072`, "do not turn a presentation request into an incoming-caller scan").
    - The reference index is effectively empty at decompile time: `completeDiscovery` takes 49.7 s on SQLite and stays partial.
  - **Change:**
    1. New `src/analysis/calls/caller-sites.ts`: a per-image direct call-site index, built once and cached like `nativeCallIndex`.
       - ARM64: a linear 4-byte sweep of executable sections for BL/B to a function entry, each site mapped to its containing function (no function → `unknown`).
       - x86-64: the discovered reference index only.
    2. Classify the result registers (x0/w0 and the FP carrier) after each site as `semantic`, `forwarded` (only to the caller's own return exit or tail), `dead` or `unknown`:
       - use a caller unit already prepared in the request (`observeCallResultDemands(...).semantic`) when one exists;
       - otherwise lift a bounded window from the return address: ≤ 64 instructions, following direct and conditional branches, stopping at a write of the root, a read, `ret`, a tail branch, an indirect branch or a call.
    3. Add every `semantic` site's width to `function_return_demands` (`source-facts.ts:2050-2072`). Stop at the first semantic site; cap at 32 sites, smallest callers first.
    4. `source-planner.ts:1561-1573`: when caller demand names the integer root and a tail's callee has no result types, type the tail result at the demanded width instead of `returnType = null`. Record `presentation('tail_result_width', …)` naming the demanding sites.
  - **Soundness:** positive evidence only, with no new premise. Any subset of sites is valid. It removes a premise-based rewrite or binds a register that callers provably read. The reconstruction already honours demand (`test/reconstruction/source-results.test.ts:431`).
  - **Tests:**
    - `test/analysis/calls/caller-sites.test.ts`: sweep and window classifier on synthetic code: read, write-before-read, ret-forward, tail, jump table → `unknown`.
    - A source-built fixture `test/service/analysis/caller-result-use-source.c` with `caller-result-use.test.ts`, following `test/service/likely-inference.test.ts`. A static `int f()` whose result a caller reads prints an integer result; a static void function stays `void`. Compile with `CLANG -O1 -g0`; never execute the analyzed binary.
    - `source-results.test.ts`: a tail plus demand gives a typed result, executed in both dialects.
  - **Acceptance:**
    - The 5 functions above get integer results.
    - None of the 42 void-source texts change.
    - The checked view is byte-identical.
    - M1 value-source row 8/180/1 → 4/185/0 [estimate from the call-site scan].
  - **Cost:** one sweep per image (about 300k words on SQLite), plus ≤ 32 windows of ≤ 64 instructions, run only where `incidental_result` would fire or a tail result is unresolved. Charged to the request; abstain when exhausted.

### V2: Closed-world caller consensus makes a function `void`

- [ ] **Problem.** 19 void-source functions print a value or `unknown_result`. The body alone cannot tell `f(); }` from `return f();`. Mechanisms:
  - a tail call into an in-image callee whose interface never carries `returns_void`: `codeOffset`, `sqlite3DropTrigger`, `pcache1RemoveFromHash`, `sqlite3RowidConstraint`, `analyzeDatabase`, …;
  - a final call establishing the result: `verifyDbFile` (`sqlite3_log`), `fts5StructureWrite` (`sqlite3_free`, which OD prints as `void` on its own), `sqlite3AddDefaultValue`, …;
  - a kept stored value: `fts3EvalAllocateReaders`.
  - **Root cause:**
    - `returns_void` comes only from library and ObjC contracts (`native-library-tails.ts:140`, `objc-messages.ts:432`). A tail gets `result_void` only from it (`source-planner.ts:710-715`), and the renderer prints `unknown_result` for any other non-void tail (`renderer.ts:8971-8983`, `:9001-9005`).
    - `selectSourcePrimaryResult` refuses `incidental_result` whenever a tail exists (`source-results.ts:926-936`).
    - A final call counts as establishing the result (`:484-489`, `:556-560`). Its projection exists only because the caller's own exit snapshot forwarded demand (`native-transfer.ts:489-504`).
  - **What must be proven for function F** (no supplied signature, no indirect result):
    - (a) F is not exported (export trie, dynamic symbols, PE exports);
    - (b) no relocation, rebase, bind or chained fixup targets F's entry (`LoadedImage.relocations`), and no code materializes it (ARM64 ADR, ADRP+ADD/LDR; x86 RIP-relative LEA/MOV);
    - (c) the site set is complete: on ARM64 the V1 sweep; on x86 only with a `complete` reference index; every site lies in a known function;
    - (d) after every BL site, x0 and the FP carrier have no semantic demand:
      - a `forwarded` site requires its caller to satisfy (a)–(d) recursively, depth ≤ 6, with SCC members assumed coinductively (`fts3EvalAllocateReaders` needs this);
      - a B (tail) site requires the tail caller to satisfy (a)–(d);
      - any `unknown` site → abstain;
      - more than 64 sites, or 128 in a recursion → abstain.
  - **Change:**
    - `source-facts.ts` publishes `function_result_use: { consensus: 'ignored', sites }`.
    - The caller of `selectSourcePrimaryResult` in `source-planner.ts:1120-1151` returns `kind: 'none', void_like: 'caller_consensus'`.
    - Every tail gets `result_void` (`:706-715`), and the tail exclusion (`source-results.ts:926-936`) does not apply to this rule.
    - The `exit_scratch` handling (`reconstruction/index.ts:707-790`) moves x0 out of line, as for `incidental_result`.
    - Record `presentation('caller_consensus', …, sites)` and `requireAbi('caller_consensus', …)` (Decision D1).
    - Document the rule in docs/CORE.md next to `incidental_result`, and in docs/internals/calls-abi.md §3.
  - **Soundness:** proven under the recorded closed-world premise (D1). Within the program, F's result is unobservable. This is stronger evidence than today's `incidental_result`, which scans nothing.
  - **Tests:** `caller-result-use-source.c` cases, each executed against oracle stubs through the IR-builder path (`source-results.test.ts` with `function_result_use` supplied):
    - `static void g()` ending in `return h();` with an int `h` and every caller discarding the result → `void`;
    - the same with its address stored in a table → unchanged;
    - an exported variant → unchanged;
    - a recursive variant;
    - an int function one caller reads → stays a value.
  - **Acceptance:**
    - 13 functions print `void` with `return;` and `f(...);`: `verifyDbFile`, `pcache1RemoveFromHash`, `vdbeSorterExtendFile`, `sqlite3AddDefaultValue`, `sqlite3CreateForeignKey`, `parserDoubleLinkSelect`, `sqlite3DropTrigger`, `generateSortTail`, `sqlite3RowidConstraint`, `analyzeDatabase`, `fts3EvalAllocateReaders`, `fts5StructureWrite`, brotli `PrintFileProcessingProgress`.
    - Up to 4 more when windows resolve: `pagerUnlockAndRollback`, `sqlite3FreeIndex`, `sqlite3SelectPrep`, `codeOffset`.
    - `sqlite3WhereExplainBloomFilter` (source `int`; both callers discard the result; Ghidra also prints `void`) becomes `void`. This is exact relative to the program; report it.
    - The 17 voids that are right today are unchanged. The checked view is byte-identical.
    - M1 void-source row 17/13/12 → 30–34 / 3–4 / 5–8.
  - **Expected effect:** about 24 return-related wrong claims on these functions (upper bound): wrong claims −0.05 to −0.10 per function. Fewer tokens (`result =`, `call_result =`, `return x;`).
  - **Depends on:** V1 (index and window classifier).

### V3: Void-like tails and final calls through callee summaries

- [ ] **Problem.** Exported or address-taken functions that tail-call or final-call a callee OD itself prints `void` still print `unknown_result` or a value: `sqlite3session_delete`, `cume_distValueFunc`, `jsonAppendRaw`. Callers also print `call_result = sqlite3_free(…)`, although `sqlite3_free` prints `void`.
  - **Root cause:** a callee's void-likeness exists only in its own reconstruction, never in its native summary.
  - **Change:**
    - `native-transfer.ts`: add `result_incidental?: true` to `NativeInterface`/`InferredCallee`. Compute it on complete callee units by evaluating the `incidentalInteger` classes over native SSA with _semantic_ caller demand only: forwarded demand from the requesting caller is circular, as for self-calls (`source-facts.ts:2052-2054`). Recurse through the callee's tails; SCCs are coinductive.
    - Tails into such callees get `result_void`.
    - `source-results.ts:926-936` allows incidental classification when every tail is `result_void`.
    - `:558-560` does not count a final call into a `result_incidental` callee as establishing the result.
    - Bump `NATIVE_SUMMARY_FORMAT`.
  - **Soundness:** the same `incidental_result` premise, applied transitively. Extend the record's scope to list the callee ids. No new premise.
  - **Tests:**
    - `source-results.test.ts`: a tail into a void-like callee gives `void`; a tail into a value callee is unchanged. Executed in both dialects.
    - `test/service/analysis/native-summary.test.ts`: the flag is set for a void-like callee and not set for `return f()` with a value `f`.
  - **Acceptance:**
    - `cume_distValueFunc` and `jsonAppendRaw` print `void`, and `sqlite3session_delete` too if `sqlite3_free`'s summary is complete.
    - Overlaps V2 on 4–6 functions.
    - Checked view byte-identical.
    - Final void-source row about 35–37 of 42 [estimate].
  - **Depends on:** V2. Shares `native-transfer.ts`/`native-worklist.ts` with T4/T5.

## K: Call sites

### K1: Darwin variadic stack arguments across tail calls and joined slots

- [ ] **Problem.** 35 Darwin variadic sites with a literal format, plus at least 8 with a variable format, print their anonymous arguments as frame stores: `frame.local_70 = (uintptr_t)address_3; sqlite3ErrorMsg(address, "no such trigger: %S");`. Those slots keep 17 frame structs alive. The callee's S8 footprint is present even when the CLI says "cut by budget", so budget is not the blocker (measured at 4× and 10×).
  - **Root cause** (instrumented `planVariadicStackArguments`, `src/reconstruction/source-variadic.ts:30-293`):
    - (R1a) every indirect tail exit counts as a boundary that reads the slot (`:175-181`, `:253-262`), although at a tail call SP is back at the entry SP;
    - (R1c) a slot written on several branches has no single owner (`:220-237`);
    - (R1b) any escaped frame address aborts the function (K7);
    - (R1d) a later ambiguous callee may read the slot. This one is correct and conservative.
  - **Change:**
    1. In the other-boundary check, skip a boundary whose snapshot SP is an exact stack offset ≥ `start + owner.size`.
    2. Resolve a slot whose byte facts merge at the call block's entry with `sourceStackArgumentParts` (`source-stack-arguments.ts:35-53`), as `bindStack` does. The argument becomes the shared block-parameter value, and every per-edge store is `consumed`. Each store still meets the existing per-store conditions.
  - **Soundness:** no new premise. Part 1 follows from the recorded `darwin_variadic_stack_arguments` premise: a tail call's SP is the caller's entry SP, and the callee's arguments lie at or above it. Part 2 reuses the existing join proof. The `variadic_stack_arguments` records stay.
  - **Tests:** `test/reconstruction/variadic-source.test.ts`, IR builder:
    - (a) a call, then an epilogue and a tail branch: the argument binds and `execute()` matches the oracle;
    - (b) a slot written on two branches: the argument is the phi, both stores are consumed, and both paths match;
    - (c) negative: a later ambiguous same-frame callee still blocks.
  - **Acceptance:**
    - Part 1 measured: `sqlite3DropTrigger` prints `sqlite3ErrorMsg(address, "no such trigger: %S", address_3);` and loses its frame struct. `sqlite3RowidConstraint` prints `sqlite3MPrintf(address_2, "%s.%s", …)` without a frame. `parserDoubleLinkSelect` loses its frame. `sqlite3CreateForeignKey` binds 2/2 sites.
    - Part 2: `verifyDbFile` (needs K7 as well), `selectInnerLoop`, `generateSortTail`.
    - Every other text is byte-identical. Checked view unchanged.

### K2: Consume outgoing stores that a bound stack argument already shows

- [ ] **Problem.** 33 stores in 10 functions (17 in brotli `main`) print the value and pass it again as the call's argument: `frame.local_2b0 = …; fprintf(stream_3, "corrupt input [%s]\n", …same…)`, `frame.local_88 = arg9; … sqlite3CreateFunc(…, arg8, arg9, …)`.
  - **Root cause:** only `planVariadicStackArguments` consumes stores (`reconstruction/index.ts:286-302`). Format-rule closures (`bindStack`, `source-planner.ts:566-573`) and callee stack parameters (`:386-390`) bind the value but leave the store.
  - **Change:**
    - Factor the slot-eligibility checks out of `planVariadicStackArguments` into one helper.
    - For every call whose projection bound a stack location through `bindStack`, mark the owning stores consumed under the same conditions: one exact store per slot (or a K1 join), unread, invisible at other boundaries, not hidden, private or a save.
    - Record `presentation('stack_argument_store', …)`.
  - **Soundness:** the value already appears as the argument. Under the premise the binding already records, the store's only observer is that call.
  - **Tests:**
    - `variadic-source.test.ts`: Darwin `printf("%d %d", a, b)` with a closed format; the stores are gone and `execute()` matches.
    - `test/reconstruction/stack-storage.test.ts`: a 9-argument call's stack-parameter store is consumed.
    - Negative: a slot re-read after the call keeps its store.
  - **Acceptance:**
    - The 33 lines disappear, in brotli `main`, `sqlite3Fts3Incrmerge`, `createFunctionApi`, `fts5FlushSecureDelete`, `sqlite3_rtree_query_callback`, `rename*Func`, `PrintFileProcessingProgress`, `sqlite3BtreeOpen` and ELF `-O0` `matrix_variadic`.
    - Frame members that held only those slots disappear.
    - Checked view unchanged.
  - **Expected effect:** tokens −1.5k to −2k [estimate]; QA tokens (brotli `main`).
  - **Depends on:** K1 (same files).

### K3: Print the fixed prefix of an established variadic library contract

- [x] **Problem.** brotli `PrintBytes` and brotli `main` (5 sites) print `fprintf(...)` with no arguments at all, plus dead `__stderrp;` statements. Ghidra prints `_fprintf(pFVar2,pcVar3)`. These cause 3 wrong claims ("fprintf arguments are elided").
  - **Root cause:**
    - A contract is rendered only when `layout.state === 'complete'` and the argument count equals the declared count (`source-planner.ts:544-557`).
    - The fallback needs an `InferredCallee`, but `observePreparedCallInterfaces` skips calls with an established contract (`src/analysis/calls/observed.ts:55-59`).
    - The format rule rightly refuses to close here: the candidate formats `"%d B"` and `"%0.3f KiB"` need different types (`src/service/analysis/source-variadic.ts:364-379`).
  - **Change:**
    - In `source-planner.ts`, after the complete-contract branch (`:553-636`): when `declaration.variadic` and no rule signature closed the call, bind each fixed parameter through `bind(...)` at the contract's register locations, and bind the declared result.
    - Project the call as `inferred` with `argument_list_complete: false`, so the header states open arity.
    - Record `presentation('library_fixed_prefix', …)`.
  - **Soundness:** the contract is established and non-conflicting, and the fixed locations are exactly the ABI classification. The anonymous tail stays open.
  - **Tests:**
    - `test/service/analysis/source-variadic.test.ts`: `"%d B"` vs `"%0.3f KiB"` gives no closing signature.
    - `variadic-source.test.ts` (or a new `library-variadic-prefix.test.ts`): a phi of two `FILE*` loads and two literal formats feeding `fprintf` prints `fprintf(stream, format)`. `execute()` with a stub `fprintf` matches on both paths.
  - **Acceptance:**
    - `PrintBytes` prints `stream = __stderrp; … fprintf(stream, format)` with no dead `__stderrp;` statements (measured).
    - The 4 brotli `main` sites change the same way.
    - Everything else byte-identical. Checked view unchanged.
  - **Done (K3):** `PrintBytes` prints `fprintf(stream, format)` with no dead `__stderrp;`; brotli `main` loses 15 dead `__stderrp;` statements and its 4 open sites print `fprintf(stream, format, ...)` / the literal format. Only those 2 lane texts change, checked view identical. The declared result stays unbound (binding it turned void `PrintBytes` into `uint64_t` with an `unknown_value` return). brotli `main` work 9.238M → 9.266M.

### K4: String literals from tail-exit arguments and partly constant phis

- [ ] **Problem.** 78 addresses of `__cstring` strings print as hex (71 non-empty) in 16 functions: brotli `main` 27, `isDate` 23, `codeOffset` `0x100153ba2` where Ghidra prints `"OFFSET"`. Ghidra spells 65 of the 71 as literals.
  - **Root cause:** a literal needs a `SourceAddress.string` fact, and only addresses in the candidate set of `sourceAddresses` (`source-facts.ts:663-902`) get one.
    - (a) Tail-exit register constants are never candidates. Only calls are (`:834-876`).
    - (b) The 32-bit-cell concat/phi rule drops every constant when any edge is non-constant (`:772-811`, `:789-790`).
  - **Change:**
    - (a) Tile the constant cells of each `indirect`-terminator block's exit `register_states` into whole pointer-width constants, as for call `register_candidates`.
    - (b) Run `constantCandidates` (`src/service/analysis/source-variadic.ts:108-212`: bounded at ≤ 8 values, through phis, selects and pure ops) on each pointer-width concat or phi, and on each tail-exit and call argument. Add every member as a candidate.
    - A candidate only _allows_ a fact. `recoverDataAddress` still requires immutable, terminated, section-bounded bytes, and every printed literal keeps its `string_literal` record.
  - **Soundness:** proven. A constant on an edge is that value on that path.
  - **Tests:**
    - `test/emitters/c/source-literals.test.ts`: a tail call with a literal argument prints the literal, and a phi of {literal, loaded value} prints the literal on the constant edge.
    - `test/analysis/strings.test.ts`: per-edge constants are candidates.
  - **Acceptance:**
    - Measured on 10 functions: 70 → 41 hex addresses (`isDate` 23→0, `fts5UnicodeCreate` 3→0, `codeOffset` prints `"OFFSET"`, `parserDoubleLinkSelect` 1→0).
    - With `constantCandidates`, also `sqlite3_result_error_code` and brotli `main` [estimate].
    - Checked view: report any added `data_address(...)` wrappers.
  - **Expected effect:** comprehension and QA in `isDate`, brotli `main`, `codeOffset`, `sqlite3_result_error_code`.

### K5: Writable import slots are program storage; interior addresses are named after their symbol

- [ ] **Problem:**
  - **Soundness bug.** Three calls through SQLite's writable `aSyscall[i].pCurrent` print as calls to `fstat`, `stat` and `fcntl` (`verifyDbFile`: `value0 = (uintptr_t)fstat; ((uint64_t (*)(…))value0)(…)`; `unixSync`). SQLite's `unixSetSystemCall` rewrites those slots.
  - **Naming.** 212 `data_1001…` names are interior addresses of named Mach-O symbols: `_sqlite3Config` 156, `_sqlite3BuiltinFunctions` 22, `_pcache1_g` 22, … They include the 49 mutex-method calls the grader misread in 4 claims ("invokes a cleanup trigger through data_100168d70").
  - **Root cause:**
    - `recoverImportBindings` (`src/analysis/strings/source-data.ts:511-592`) marks every bound slot as an import binding, without a section or segment check. `planGlobals` (`src/emitters/source-globals.ts:147-177`) then folds the load under the premise "only the dynamic linker writes a binding slot" (`source-model.ts:148-151`).
    - Mach-O nlist symbols have no size (`src/loaders/macho/metadata.ts:69`), so `buildSymbolIndex` gives them the unit range `[a, a+1)` (`source-data.ts:173-178`), and interior addresses fall back to `data_<hex>` (`source-globals.ts:113-116`).
  - **Change:**
    - (a) Keep a slot as an import binding only when only the loader writes it: Mach-O `S_NON_LAZY_SYMBOL_POINTERS`/`__got`/`__auth_got` or a read-only-after-fixup segment (`__DATA_CONST`, `SG_READ_ONLY`), ELF `PT_GNU_RELRO`, the PE IAT. A bind in writable program data stays plain storage; its load prints as a load, with an optional `/* initially fstat */` declaration comment.
    - (b) Name a data address with no covering symbol relative to the nearest preceding object symbol in the same section, when no other symbol or data record starts in between: `sqlite3Config_0x80` with `/* sqlite3Config+0x80 */`. The extent stays unknown. Record `presentation('symbol_relative_name', …)`.
  - **Soundness:** (a) removes an unsound fold; the checked view already prints the load. (b) is exact address arithmetic and claims no extent or type.
  - **Tests:**
    - `test/analysis/import-bindings.test.ts`: a bind inside `__DATA,__data` is not an import slot; a `__got` bind is.
    - `test/emitters/c/source-globals.test.ts`: an interior address of a size-less symbol is named after it.
    - An executed C oracle in which the slot is rewritten at run time.
  - **Acceptance:**
    - `verifyDbFile` and `unixSync` load the `aSyscall` slot and call through it.
    - 20 functions rename `data_1001…` to `sqlite3Config_0x…`, `pcache1_g_0x…` and so on.
    - The brotli `__stderrp` texts are byte-identical.
    - Declare the checked view's `data_address("…")` name changes.

### K6: Call spelling: no `...` in open-arity casts; tail arguments printed like ordinary arguments

- [x] **Done** (measured on the full OD lane `od-rm4-k6` vs `od-main-afb7691`: 51 texts changed, `, ...` casts 77 → 0, `(uintptr_t)` in `return f(` tail lines 46 → 0 in 21 functions, 30 `open arity` header lines gained `indirect call at 0x<VA>`, nothing else, states and work unchanged, checked view byte-identical; emitters 87). **Problem:**
  - 77 function-pointer casts spell open arity as `(T (*)(A, B, ...))`, which in C declares a variadic prototype. This caused 4 wrong claims (`matrix_callback` ×2, `sub@0x100000450`, `sub@0x1400010f0`).
  - 46 `(uintptr_t)` casts on tail-call arguments in 21 functions: `return sqlite3SrcListDelete((uintptr_t)address_2, (uintptr_t)address_1)`, where `address_1` is a declared pointer.
  - **Root cause:**
    - `functionPointer` (`renderer.ts:4690-4727`, `:4709-4710`) appends `...` for open arity, where direct calls state open arity in the header note (`:4574-4582`).
    - Tail arguments print through `valueLiteral`/`value` (`:8425-8428`, `:8519-8522`) instead of `sourceCall`'s per-argument routine (`:4441-4454`).
  - **Change:**
    - Keep `...` only for a declared variadic signature. Add an open indirect call to the header's open-arity note (for example `indirect call at 0x…`).
    - Extract the per-argument routine and use it for tail arguments.
    - Update the `function_pointer_call` record texts (`:4570`, `:8420`).
  - **Soundness:** presentation only. The printed arguments fill exactly the cast's named positions, so the executed C passes the same registers.
  - **Tests:**
    - `test/emitters/c/function-pointer-calls.test.ts` (new): an open indirect call prints without `...` plus a header note, and `execute()` matches the oracle callback.
    - `test/reconstruction/indirect-tails.test.ts`: no `(uintptr_t)` on a declared pointer local.
  - **Acceptance:** the 77 casts lose `, ...`, and the 46 tail arguments lose `(uintptr_t)`. Nothing else changes.

### K7: Escaped frame addresses bound the variadic aliasing floor

- [ ] **Problem.** One escaped frame address anywhere (`fstat(fd, &buf)`) disables variadic binding for the whole function: `source-variadic.ts:70-97` aborts on any stored or register-held stack address (10 of 19 affected functions).
  - **Change:**
    - Do not abort on an exact `stack`/`stack_fragment` escape. Record the lowest escaped offset as `escapeFloor`, and admit only slots with `start + size ≤ escapeFloor`.
    - Keep aborting on `dynamic_stack` and on missing snapshots.
    - Record `requireAbi('escaped_frame_floor', …)`: a frame address handed to a callee or stored designates bytes at or above itself.
  - **Soundness:** proven under the new `escaped_frame_floor` premise (D5, accepted). `frame_object` does not cover it.
  - **Tests:** `variadic-source.test.ts`: a callee receiving `&local` above the slot binds; one receiving an address at or below it does not.
  - **Acceptance** (measured):
    - `fts3DestroyMethod` prints all 11 `fts3DbExec` arguments and loses 11 frame members (this removes the grader's "%s that no argument supplies" claim).
    - `unixSync` prints its `sqlite3_log` arguments.
  - **Depends on:** K1.

## F: Floating point

### F1: FP-environment epoch webs: coinductive acceptance and mark-based unobserved epochs

- [x] **Problem.** In functions with a call inside a loop, every FPCR guard, failure effect, `unknown_exit("Unsupported FPCR environment")` and `fp_*` helper stays printed. `rtreeInsertCell` has 19 `requirement_predicate` guards and 3 `unknown_value("uint32_t", "call clobbers fpcr")` (lexical tokens 6,360 vs Ghidra's 3,144). Undeclared `value0 = unknown_value("bits32_t", "FPCR environment");` assignments in `sqlite3_result_double` and `cume_distValueFunc` do not compile. _Done (`wt/rm4-f1`): lane `od-rm4-f1` differs from `od-main-56a18f1` in exactly the three acceptance texts (`rtreeInsertCell` 6,336 → 5,311 lexical tokens with 0 guards/exits/placeholders/`fp_*`, 6,360 → 5,335 against `od-rm3-final`; `sqlite3_result_double` 123 → 114, `cume_distValueFunc` 182 → 173); checked view byte-identical on those three and three unchanged FP-note functions; states unchanged; `rtreeInsertCell` work 7,045,301 → 7,022,449._
  - **Root cause:**
    - `sourceFpPresentation` returns `unchanged` unless every guard's epoch is assumed. `assumedEpoch` is inductive and rejects cycles (`src/reconstruction/source-fp.ts:146-160`, `:149`), and a loop with a call makes the FPCR loop phi depend on itself.
    - `unobserved` (`:209-238`) is a reference count that never releases a cycle, and it marks only call outputs (`:234`).
    - `renderer.ts:5884-5894` prints copies into a phi whose class is hidden.
  - **Change:**
    1. Replace `assumedEpoch` with a greatest fixpoint over the bitcast/phi transport web: a member is accepted iff every non-member parent is an entry or call-clobber epoch and every member parent is accepted. Charge `context.checkpoint` per edge.
    2. Replace the reference count with a mark pass: values reachable from any use other than an omitted guard condition are observed, and the rest of the released web is unobserved, including phi destinations and entry bindings.
    3. `printedCopies` skips copies whose destination is unobserved.
  - **Soundness:** proven, with no new premise. A phi or bitcast only transports its inputs' values. Records:
    - `fp_environment_guard` gains the accepted transport ids;
    - a new `fp_unobserved_epoch` lists the hidden copies and definitions.
    - Checked view byte-identical (verified on `rtreeInsertCell`).
  - **Tests:** `test/emitters/c/source-fp.test.ts`, both ABIs and both dialects:
    - IR-builder loops with a call in the body and guards before and after it, executed against `execute()`. No `requirement_predicate`, `unknown_value` or undeclared identifier; compile with clang as `source-fp-native.test.ts:195` does.
    - Negatives: an explicit FPCR write inside the loop, or a web with one non-epoch input, keeps the guards.
    - An entry/call phi consumed only by a guard prints nothing.
  - **Acceptance** (measured):
    - `rtreeInsertCell` loses all guards, FPCR effects and exits, placeholders and `fp_*` helpers (6,360 → 5,335 tokens).
    - `sqlite3_result_double` (123 → 114) and `cume_distValueFunc` (182 → 173) lose the dangling assignments.
    - The other 52 FP-note texts are byte-identical.
    - After A1, `isDate` loses all 27 guards and 8 placeholders (simulated: 18,789 → 15,338 tokens).

### F2: ABI premise: calls preserve the FP control state, except known environment writers

- [ ] **Problem.**
  - Darwin arm64 clobbers FPCR at every call (`src/abi/darwin-arm64/index.ts:310-337`), which creates an epoch per call, phi webs and placeholders. `"arm64:fpcr:0:32"` appears in 64 printed boundary lists.
  - SysV and Win64 already preserve the MXCSR control bits (`sysv-amd64/index.ts:293-302`, `windows-x64/index.ts:64-73`), but they make no exception for `fesetround`/`_controlfp`. A call to one of them is ignored on every target.
  - **Change:**
    1. Darwin: remove FPCR from `CLOBBERS.registers`.
    2. Add an ABI-profile field `environment_writer_clobbers` (FPCR, or MXCSR[6:16]). Apply it where the call target becomes known, before SSA cell construction (import-stub resolution / `src/analysis/calls/index.ts`), to:
       - fenv.h writers: `fesetround`, `fesetenv`, `feupdateenv`, `feholdexcept`, `fesetexceptflag`, `feenableexcept`, `fedisableexcept`;
       - MSVC: `_controlfp`, `_control87`, `_controlfp_s`, `__control87_2`, `_set_controlfp`, `_fpreset`;
       - BSD: `fpsetround`, `fpsetmask`;
       - local callees whose summary shows exit FPCR ≠ entry FPCR.
    3. Record `requireAbi('fp_environment_preserved', [call ids], …)` for unknown, indirect and non-writer targets.
    4. Source FP treats writer-call epochs as not assumed, so their guards stay.
  - **Soundness:**
    - AAPCS64 §6.1.2: the FPCR control fields change only through specific support functions.
    - SysV psABI: the MXCSR control bits are callee-saved.
    - Microsoft x64: MXCSR[6:15] is nonvolatile.
    - The rule tightens soundness for fenv writers on x86.
    - **The checked view changes** (intended; D2): FPCR call-clobber values disappear.
  - **Tests:**
    - The ABI profile tests: clobber sets.
    - `source-fp.test.ts`: a `fesetround` import call between two FP operations keeps the guard after it (both dialects, all three ABIs); an ordinary import preserves the epoch.
  - **Acceptance:**
    - Source texts identical to F1 + F4 for `rtreeInsertCell`, `sqlite3_result_double` and `cume_distValueFunc` (measured).
    - Boundary lists lose `arm64:fpcr`.
    - Review and declare the checked-view diff.
  - **Cost:** +2.2% work on `rtreeInsertCell`, +5.7k on `isDate`. Pay it back in the same change; `isDate` is at 9.79M.
  - **Depends on:** F1.

### F3: The source view drops the FP-environment note; the premise is recorded

- [ ] **Problem.** 55 functions print `/* assumes nearest-even rounding and masked FP traps (requirement_…) */` (4,730 comment bytes). 12 of them have no FP operation at all, only a callee that requires it (`sqlite3_finalize`, `fts3DestroyMethod`, …). The note causes 3–4 wrong claims ("source has no such comment") and appears in 14 noise reasons. The FP requirement propagates through callee summaries (`source-requirements.ts:338-340`, `source-facts.ts:623-628, 1437-1441`), so fuller summaries spread the note further: +40 texts at 10× budget.
  - **Change** (`renderer.ts:8823-8843`, source view):
    - Print no note. Record `validation.requireAbi('fp_default_environment', [function id], …)` whenever an `fp_environment` requirement exists.
    - Map omitted-guard provenance (`mapSites`, `:8797-8811`) to the signature span.
    - `emission.requirements` is unchanged; the checked view keeps its `/* Requirement … */` line.
    - Update docs/CORE.md (`:367-368`, `:1223-1225`).
  - **Soundness:** a language premise of the same class as `frame_object`. C11 7.6.1p2: code compiled with `FENV_ACCESS` off (the default) that runs under non-default modes has undefined behaviour, so emitted C without `#pragma STDC FENV_ACCESS ON` already presumes the default modes.
  - **Tests:** `source-fp.test.ts`, `source-fp-native.test.ts`, Python-like:
    - no note in the text;
    - `local_validation` contains the record;
    - `requirements` lists every site;
    - mappings point into the signature;
    - checked view byte-identical.
  - **Acceptance:** the 55 texts lose exactly the trailing signature comment. No other change.
  - **Expected effect:** Claude tokens geomean about −0.03 [estimate]; wrong claims −3 to −4; noise on about 13 functions. Lexical tokens are unchanged.

### F4: Native FP where NaN-freedom is provable; value-preserving conversion spelling

- [x] **Problem:** _Done (`wt/rm4-f4`): lane `od-rm4-f4` differs from `od-main-91c0552` in exactly the 13 acceptance texts (plus C1's new `sqlite3CodeRowTrigger`): `PrintBytes` 168 → 145 lexical tokens (`(double)arg0 * 9.313225746154785e-10`), `PrintFileProcessingProgress` `(double)(value2 - value1) / 1000000.0`, 9 `matrix_mixed` cells `(double)arg0 / (double)arg1`, `cume_distValueFunc`/`rtreeInsertCell` lose every `cast_signed_to_float` (`fp_div` by a variable stays); checked view byte-identical; records `fp_nan_free` (subjects + operand bounds) and extended `fp_native_operations`._
  - `fp_mul(64, cast_unsigned_to_float("ieee64_t", "bits64_t", arg0), 9.3e-10)` in brotli `PrintBytes` (×3);
  - `fp_div(…cast_unsigned_to_float…, 1000000.0)` in `PrintFileProcessingProgress`;
  - `cast_signed_to_float` in `cume_distValueFunc` and `rtreeInsertCell`;
  - `(double)(int32_t)arg0 / (double)(int64_t)arg1` in 9 `matrix_mixed` cells, with about 9 wrong claims "converted through int64_t".

  The grader reads `fp_mul(64, …)` as a call with a constant 64.
  - **Root cause:**
    - The payload gate (`source-fp.ts:297-365`, `:404-408`) treats every value that reaches a call argument, a store or an integer consumer as NaN-payload sensitive, including int→float conversions and finite arithmetic, which cannot produce a NaN.
    - `expressions.ts:938-943` always casts the operand to the IR conversion's source width and signedness.
  - **Change:**
    - (a) Int→float conversions are NaN-free candidates whatever their sensitivity.
    - (b) A bounded, memoized magnitude pass over FP values:
      - literals give `|c|`;
      - W-bit conversions give `2^(W-1)` / `2^W`;
      - add/sub/mul, and division by a finite nonzero literal, combine the operand bounds with a rounding margin;
      - a phi gives the max; cycles are unbounded.

      An operation whose operands are bounded below the format maximum and that has no invalid case is NaN-free.

    - (c) Print `(double)narrow` when the IR operand is `zero_extend` of an unsigned narrower value (signed or unsigned conversion) or `sign_extend` of a signed narrower one. Decide from the IR expression, not from the printed C type.
    - Records: `fp_nan_free` (subjects and bounds); extend `fp_native_operations` for (c).
  - **Soundness:** an 8–64-bit integer converts to a finite IEEE value. Finite add/sub/mul round to a finite value or ±inf, never NaN, so the IR's canonical-NaN rule is never exercised. A conversion depends only on the mathematical integer.
  - **Tests:** `test/emitters/c/source-fp-native.test.ts`:
    - u64→f64 times a literal, stored to memory: `execute()` and clang, both dialects;
    - negatives: an argument-valued operand stays `fp_mul`, division by a variable stays `fp_div`, and a bound overflow stays a helper;
    - zero-extended u16/u32 values ≥ 2^31 and ≥ 2^15.
  - **Acceptance** (measured):
    - `PrintBytes` prints `(double)arg0 * 9.313225746154785e-10` (168 → 145 tokens).
    - `PrintFileProcessingProgress` prints `(double)(value2 - value1) / 1000000.0`.
    - The 9 `matrix_mixed` cells print `(double)arg0 / (double)arg1`.
    - All else identical; checked view unchanged.
  - **Depends on:** F1 (same file).

### F5: NaN payloads are unobserved

- [ ] After F1 and F4, 11 helpers remain:
  - 9× `fp_mul` in the `matrix_aggregate` cells, stored to caller memory (source `input.weight *= scale`);
  - one `fp_add` (ELF `-O0` `matrix_variadic`);
  - one `fp_div` (`cume_distValueFunc`).

  They cause about 8 wrong claims ("fp_mul call / constant 64") and "fp_mul helper" noise on 5 cells. Removing them needs the existing `fp_native_operations` premise ("source floating results are consumed as values, not inspected for arithmetic NaN payloads") extended to stores and call arguments. IEEE 754 leaves payload propagation as a "should", and C Annex F does not specify payloads. The IR's canonical NaN (`src/ir/semantics.ts:14-15`) is itself not hardware-exact (ARM FPCR.DN=0, x86 `0xfff8…`).
  - **Change:** `source-fp.ts:321, 331` stop marking stores and call arguments as payload-sensitive under `requireAbi('fp_nan_payload_unobserved', …)` (D6, accepted). Extend the `fp_native_operations` record text.
  - **Tests:** `test/emitters/c/source-fp-native.test.ts`: a possibly-NaN product stored to caller memory and one passed to a call print as operators. Oracles compare NaN results modulo payload and every other result bit-exact, in both dialects.
  - **Acceptance** (measured): all 11 become operators; the `matrix_aggregate` cells print `address->field_0x10_f = arg2 * value0` (or the member's name). Checked view unchanged.
  - **Depends on:** F1, F4.

## A: ARM64 lifting and frames

### A1: Unlifted SIMD&FP data-processing encodings get a bounded effect

- [ ] **Problem.** `isDate`, `unicodeNext` and `sqlite3VdbeDisplayComment` print their callee-saved saves as stores (`frame.local_a0 = unknown_value("bits64_t", "non-argument entry register");`, 46 lines). They also lose every FP presentation and frame promotion. They are the three costliest SIMD users in the corpus: `isDate` is 18,789 tokens vs Ghidra's 6,521.
  - **Root cause:**
    - The unlifted encodings `FMADD_D_floatdp3`, `FCVTZS_asisdmisc_R`, `FCCMP_D_floatccmp`, `INS_asimdins_*`, `USHL_asimdsame_only`, `XTN_asimdmisc_N` and `UZP1_asimdperm_only` fall back to `unknownClobbers` (`src/lifters/arm64/semantics.ts:58-76`, `index.ts:339-347`). That clobber set covers x0–x30, **SP**, v0–v31, **FPCR** and all memory.
    - `source-stack.ts:1098-1101` treats any `unknown_effect` as a frame escape, so the save elision never runs: there is no `frame_save` record in these functions.
    - `source-fp.ts:121-127` aborts FP presentation on an FPCR output.
  - **Change:**
    1. Lifter catch path: derive the bound from the decoded encoding class, never from assembly text. When an `_`-separated segment of `payload.canonical_encoding` starts with `asimd`, `asisd`, `float` or `crypto` (but not `asisdls`, the SIMD loads and stores) and the instruction falls through, emit `block.unknown(reason, …)` with:
       - registers: V0–V31, plus GP `Rd` for to-general forms (`*_float2int`, `UMOV_*`, `SMOV_*`) when Rd ≠ 31;
       - flags: NZCV and FPSR;
       - memory: `none`;
       - no SP and no FPCR.

       The diagnostic and coverage reason stay unchanged.

    2. `source-stack.ts:1098`: an `unknown_effect` with `clobbers.memory === 'none'` exposes nothing.
  - **Soundness:** an ISA fact. The A64 "Data Processing – Scalar Floating-Point and Advanced SIMD" group never accesses memory or names SP (register 31 is ZR). It writes only Vd, GP Rd in the to-general forms, NZCV (FCMP/FCCMP) and FPSR, and it reads FPCR without writing it. No presentation record is needed. **The checked view changes** for these three functions (intended; D2; `isDate` checked 273,167 → 238,427 bytes).
  - **Tests:**
    - `test/lifters/arm64/simd-move.test.ts`: an unsupported SIMD encoding keeps SP, x19–x28 and memory.
    - IR builder: a store before and a load after a `memory: 'none'` effect gives the stored value.
    - `test/reconstruction/frame-saves.test.ts`: a save is elided across a memory-free unknown effect; an `unknown_read_write` effect still exposes the frame.
    - Emitted C/Python against oracles.
  - **Acceptance** (measured):
    - `sqlite3VdbeDisplayComment` 2,296 → 1,618 tokens, with no save lines and no `unknown_value`.
    - `isDate` 18,789 → 10,934 tokens (gotos 96 → 56, `requirement_predicate` 27 → 0, `fp_*` 9 → 0).
    - All other texts byte-identical.
  - **Depends on:** C1, without which `isDate` fails with the edge-copy invariant. F1 for the remaining FP guards.

### A2: Lift A64 single-lane SIMD loads and stores (`ST1`/`LD1`, `asisdlso`/`asisdlsop`)

- [ ] **Problem.** After A1, `unicodeNext` keeps its 14 save lines and an exposed frame, because `ST1_asisdlsop_S1_i1s` (`st1 {v.s}[i], [xn], #4`) is a real store that A1 must not bound.
  - **Change:** in `ArmSemantics.execute()`, lift the single-lane forms from the structured operands, never from operand text:
    - the memory operand gives base, writeback (`post`/`none`), `access_bits` and register offset;
    - the vector operand gives the lane;
    - ST1 stores `extract(V[t], lane*esize, esize)` little-endian; LD1 inserts into V[t];
    - post-index writeback adds `access_bits/8` or Xm, and SP may be the base.

    Multi-register forms (`asisdlse`/`asisdlsep`) stay unlifted.

  - **Soundness:** exact ISA semantics.
  - **Tests:** `test/lifters/arm64/semantics.test.ts`: ST1/LD1 lane with immediate and register post-index, an SP base and every element size, `execute()` against byte oracles.
  - **Acceptance:** `unicodeNext` prints no `non-argument entry register` and no `__unknown_effect`, and has `frame_save` records (about −400 to −500 tokens [estimate]). Its checked view changes (intended). Other texts byte-identical.
  - **Depends on:** A1.

### A3: Escaped slots bounded by a frame save print as independent locals

- [x] **Problem.** 67 texts declare a `_Alignas(16) struct { … } frame;`. That costs 3,420 declaration tokens, 155 pads and 2,292 `frame.` prefixes, and the judges cite the frame in 30 noise losses. Small functions that pass one local's address to a callee print a padded object: `getConstraintToken` prints `struct { uint8_t pad_40[12]; uint32_t local_34; uint8_t pad_30[48]; } frame;` for `&frame.local_34`. _Done (`wt/rm4-a3`, lane `od-rm4-a3` vs `od-main-56a18f1`): frame structs 66 → 59 (the 7 acceptance functions print none), `fts3DestroyMethod`/`unixSync` print `uint32_t local_24;` outside it, 42 more structs lose (26) or shrink (16) their tail pad, 50 texts changed, no state change; checked view identical on the acceptance set._
  - **Root cause:** `frame()`/`frameLayout` (`source-stack.ts:2423-2531`, `:66-316`) treat the whole escaped region up to the entry SP as one object. The existing `frame_save` premise (`:1579`) says that a frame address handed to a callee designates its own object and never a save slot, so an escaped object below a save slot ends at that slot. `frame()` does not use this.
  - **Change** (source view, `!reachAll`, entry SP not live):
    1. Each escaped or indexed base at or above `reachFloor` defines a region running to the lowest proven save slot above it (`saveBytes`), or to the entry SP. Overlapping regions merge.
    2. A region that is exactly one `frameLayout` member, with no other access, taken address or indexed base inside it except at its start, becomes `FrameMember.independent` (`source-model.ts:298-312`).
    3. The renderer (`:9136-9177`) declares it on its own (`uint32_t local_34;`), prints `&local_34`, and omits the struct when no non-independent member is left.
    4. When every byte from the lowest save slot to the entry SP is a hidden save byte, end the object at that save slot. This drops the trailing pad.
    5. Records: `presentation('escaped_slot_object', …)` and `presentation('frame_object_save_area', …)`, with `requireAbi('frame_object_base')` and `requireAbi('frame_save')` on their subjects.
  - **Soundness:** proven under existing premises (`frame_object_base`, `frame_save`). Objects are contiguous. Memory operations are unchanged, so the checked view is untouched.
  - **Tests:** `test/reconstruction/frame-object.test.ts`:
    - an escaped slot directly below the save area is an independent local;
    - negatives: a gap byte, two members in the region, an interior or indexed address, a live entry SP;
    - a callee oracle writes through the pointer, and the result equals the IR interpretation.

    `frame-saves.test.ts`: the trimmed object never covers a byte that is not hidden.

  - **Acceptance:**
    - `getConstraintToken`, `sqlite3Fp10Convert2`, `sqlite3session_delete`, `stat4ValueFromExpr`, `fts5CreateTokenizer`, `filterHash` and `jsonAfterEditSizeAdjust` print no frame struct.
    - `fts3DestroyMethod` and `unixSync` print `local_24` outside it.
    - About 30 more frame structs lose their tail pad.
    - Checked view byte-identical.
  - **Expected effect:** about −0.4k tokens [estimate]; noise in 9 small functions, 8 of which lost the noise dimension. After K1/K2 and closed callee arities, 22 more functions lose the struct entirely: in 22 functions an open-arity call's possible argument area is the only reason the struct exists.

## E: Expressions

### E1: Rematerialize constant-offset derived pointers; print byte-pointer sums without `uintptr_t`

- [x] **Problem.** The texts contain 202 temporaries of the form `x = (T*)((uintptr_t)b ± k)` and 436 dereferences `*(T *)((uintptr_t)x + k)`. Example: `sqlite3_collation_needed16` prints `address_1 = (uint8_t*)((uintptr_t)address + 0x190); *(uint64_t *)address_1 = 0; *(uint64_t *)((uintptr_t)address_1 + 8) = arg2;` (an ARM64 `stp` with a computed base). Ghidra prints `*(undefined8 *)(param_1 + 400)`. _Done (E1): OD lane vs `od-main-afb7691`: 58 texts changed, 57 shorter (−3.1k regex-lexer tokens); `sqlite3_collation_needed16` prints `address->field_0x190 = 0; address->field_0x198 = arg2;`, `sqlite3PagerSavepoint` `address_10->field_0x1e0 = 0;` (−437), `vdbePmaReaderClear` `+ 64`; states unchanged, checked view unchanged; brotli `main` needs C2 first (shared 256-record bound)._
  - **Root cause:**
    - The renderer repeats `x ± k` only inside one reader statement (`src/emitters/source-inlining.ts:585-616`, gate at `:616`).
    - `memberAccess` builds fields only through inline bases (`renderer.ts:3146`).
    - Derived pointers are `void *`/`uint8_t*` (`pointers.ts:409-412`, `renderer.ts:2833-2847`).
    - C-like code always round-trips byte pointers through `uintptr_t` (`renderer.ts:1844-1855`, `:4280`), contrary to the `byteAddress` doc (`:2833-2835`).
  - **Change:**
    - (a) In `planSourceInlining`, a pointer-width `leaf ± const` whose every use is a load/store address (directly, or through other such candidates), with at most 8 uses, becomes a repeated site anchored at its first use. The leaf is a printed, non-inline, non-stack variable. Record `address_rematerialization` next to `repeated_operation`.
    - (b) The raw-address printer reassociates constant chains `(b + k1) + k2 → b + (k1+k2)`.
    - (c) In C-like `sourceStorage` and pointer assignments, a byte-pointer base prints `*(T *)(p + k)` and `q = p + k`. Record `byte_pointer_sum`.
  - **Soundness:** presentation only. The rematerialized expression is modular arithmetic on an immutable SSA value. `VariableLiveness.leaves` already counts each occurrence as a read at its reader. (c) rests on the premise that `typed_index` subscripts already accept.
  - **Tests:**
    - `test/emitters/c/source-inlining.test.ts`: `p + 0x190` stored at +0 and +8 in two statements, then the base reassigned. Assert no temporary, field spelling, and `execute()` equal for aliasing and fault memories.
    - `source-structs.test.ts`: the member prints through the base.
    - `source-typed-index.test.ts`: byte-pointer sums.
    - Python-like execution.
  - **Acceptance:**
    - (a) measured: −2,543 tokens, geomean 1.337 → 1.323, 38 functions changed, none worse, all states and work unchanged.
    - `sqlite3_collation_needed16` prints `address->field_0x190 = 0; address->field_0x198 = arg2;`.
    - `sqlite3PagerSavepoint` prints `A->field_0x1e0 = 0;` (−439 tokens).
    - `vdbePmaReaderClear` prints `+ 64`, not `+ 48 + 16`.
    - (c) about −0.6k more [estimate].
    - Checked view unchanged.

### E2: A formal is a scalar-element pointer only when its accesses are array-shaped

- [x] **Problem.** _Done (E2): OD lane `od-rm4-e2` vs `od-main-bf6f43f`: 28 texts changed (+639 regex-lexer tokens: typedef/struct lines); `stmtClose` prints `address->field_0x10`, `InitDecoder` `address->field_0x148`, `PrintFileProcessingProgress` fields; real arrays unchanged; 8 members print `*p->field_0xN`._ Struct pointers print as `uint64_t*` with constant subscripts: `stmtClose(uint64_t* address) … address[2]`, brotli `InitDecoder` `address[41]`, `PrintFileProcessingProgress` `address[59]`. This causes 6 wrong claims in 4 functions ("takes a uint64_t array pointer"). 20 formals use only non-zero constant subscripts.
  - **Root cause:** `formal_pointer` (`src/reconstruction/source-signature.ts:744-783`) checks only element width and kind. `scalarArray`'s contiguity gate (`src/emitters/source-structs.ts:132-182`) is not applied to formals.
  - **Change:**
    - Record per-root constant displacements (`:617-626`). Grant `formal_pointer` only when the formal is indexed or stepped, or its constant offsets are contiguous from 0. Otherwise keep the analysis structure (or a byte pointer).
    - Print declared scalar-pointer members as `*p->field_0x48` instead of `(uint64_t)*(uint64_t *)(uintptr_t)p->field_0x48`.
  - **Soundness:** spelling only. Extend the record text with "array-shaped lineage".
  - **Tests:** `test/emitters/c/formals.test.ts`:
    - +0x10 only → not `uint64_t*`;
    - +0, +8, +16 → `uint64_t*`;
    - indexed by `i*8` → `uint64_t*`;
    - `execute()` equality.
  - **Acceptance:** `stmtClose` prints `address->field_0x10` (measured); `InitDecoder` `address->field_0x148`; real arrays (`matrix_*` loops, `crc32_z`, `adler32_z`) are unchanged.
  - **Expected effect:** +499 tokens in 24 functions (measured: typedef and struct lines). This is less after P2. Judge E1 and E2 together.
  - **Depends on:** E1.

### E3: Recombine 64-bit cells from call outputs, range-folded groups and narrowed halves

- [x] **Problem.** 259 reassemblies `x | ((uint64_t)y << 32)` and 56 split pairs in 17 functions: `isDate` alone has 166 lines (`value16 | ((uint64_t)value17 << 32)` for one pointer). `matrix_multi_exit` ELF/PE `-O2` returns `value0 | ((uint64_t)value1 << 32)`, which the grader read as a "packed low/high pair" (6 wrong claims). The source returns `sum ^ i`. **Done:** (1) and (2) landed (range-folded groups beside a wider value; `outputs` edges giving a call or unknown effect one whole output per root). (3) was dropped: it never fired in the reconstruction/emitter suites or in sampled corpus functions. (4) was not done. In lane `od-rm4-e3`, `<< 32` reassemblies went from 260 to 75 and `>> 32` split lines from 68 to 18 against `od-main-91c0552`. `isDate` went from 173 to 10, with no pointer among the 10: 7 are entry-register saves and 3 are `v0` doubles, which are item (4). `matrix_multi_exit` ELF/PE `-O2` prints one `uint64_t` accumulator. `call clobbers` placeholders went from 13 to 12. The checked view is byte-identical (reconstruction 82, emitters 90).
  - **Root cause** (instrumented `recombineSourceCells`, `src/reconstruction/source-cells.ts`):
    - (1) a range-folded group accepts only constant edges (`:216`, `:319`): `multi_exit`'s high sum cell is folded inside the loop;
    - (2) the per-cell register outputs of one call or unknown effect never form a joint source (`:222-303`, reasons compared per cell `:243-256`): 58 + 52 + 76 `isDate` rejections;
    - (3) a narrowed 32-bit low half is not recognized as a slice of the whole (`:71-72`);
    - (4) vector groups require identical partitions across blocks.
  - **Change:**
    - (1) A folded group accepts `value`, `zero_extend` and `group` edges when every folded cell's constant equals the edge slice (re-checked with `validation.check('bitvector', …)` or citing the range proof).
    - (2) A new edge source kind `outputs` for one instruction's write of one root: the whole result value when the projection binds it, otherwise one whole `call clobbers <root>` unknown. One reason per root, also in boundary printing.
    - (3) A BDD-checked normalization: `trunc_n(a op b)` equals `trunc_n(W)` for add, sub, mul, and, or, xor and shl when `W = ext(a) op ext(b)` exists.
    - (4) Optional: coarser vector partitions.
    - Each change keeps and extends `register_cell_recombination`.
  - **Soundness:** (1) the existing interval proof; (2) structural; (3) a bit-vector identity.
  - **Tests:** `source-cells.test.ts`, `source-loop-cells.test.ts` and `sqlite-cell-constants.test.ts` (the constant `0x100132f08` as one literal):
    - a loop sum with a range-folded high cell;
    - a phi fed by a call's x0 cells;
    - a phi fed by a call's clobbered v0 cells;
    - executed in both dialects, including `multi_exit`'s overflow path.
  - **Acceptance:** `matrix_multi_exit` ELF/PE `-O2` prints one 64-bit accumulator; `isDate` has no `<< 32` reassembly of a pointer. Checked view byte-identical.
  - **Expected effect:** about −2.8k tokens [estimate]; 6 wrong claims.
  - **Cost:** watch `isDate`'s work (9.79M).

### E4: Choose signed or narrow local types by conversion cost

- [ ] **Problem.** Locals are declared `uint32_t` 736 times and `int32_t` 8 times. The texts hold 397 signed tests such as `(int32_t)x >= 1`, 236 chains such as `(uint64_t)(int32_t)x`, and 80 `(uint32_t)valueN ==` on 64-bit locals that are only read low. Judges read `count` as unsigned or cite "machine-level sign-extension arithmetic".
  - **Root cause:** signed and narrow spellings exist only for formals (`signedConsumer`, `formal_low_slice`, `source-signature.ts:715-725, 829-888`). A local declared signed converts back at each use (`renderer.ts:1841-1842`).
  - **Change:**
    - A planner next to `planLocalTypes` (`src/emitters/source-local-types.ts`) for integer partitions of 8, 16 and 32 bits, plus 64 → low slice.
    - Count the conversions each spelling prints:
      - cheap when signed: signed compare, sign extension, `ashr`, `sdiv`/`srem`;
      - need `(uintN_t)` to stay UB-free when signed: `add`/`sub`/`mul`/`shl`;
      - cheap when unsigned: unsigned compare, zero extension, `lshr`, `udiv`.

      Choose `intN_t` when strictly cheaper. Declare a 64-bit local whose uses are all low-slice reads narrow.

    - Hook into `chooseLocalTypes` (`renderer.ts:7453`) with record `local_integer_spelling`.
  - **Soundness:** presentation only. Every use still prints its exact conversion, and signed arithmetic is never left unconverted.
  - **Tests:** `test/emitters/c/source-local-types.test.ts` and `source-width.test.ts`:
    - a loop counter with a signed `i < n` and `i + 1`, executed across the INT_MAX wrap;
    - a 64-bit call-result local read only as `(uint32_t)`.
  - **Acceptance:**
    - `sqlite3DropTrigger` prints `int32_t count; … if (count >= 1)`.
    - `btreeOverwriteContent` has no `(int32_t)value0 <= arg3`.
    - No text where conversions increase. Checked view unchanged.
  - **Expected effect:** −0.75k to −1.2k tokens in about 55 functions [estimate].

### E5: Fold the bitfield-move aliases (SXTB/SXTH/SXTW, SBFIZ/UBFIZ, SBFX)

- [x] **Problem.** 25 sign-fill selects such as `((x >> 0x1f) & 1 ? 0xffffffffffffffff : 0) & 0xffffffff00000000) | (x & 0xffffffff)` and 5 rotate-as-shift idioms in 15 functions, each 15–35 tokens. Judges cite `btreeOverwriteContent`, `openStatTable` and `fts3MatchinfoLcsCb`. _Done (`wt/rm4-e5`): fields of 8/16/32 bits starting at bit 0 fold (SXTB/SXTH/SXTW, SBFIZ, UBFIZ); SBFX/UBFX and odd widths keep their lowering (the division and signed-shift recognizers read them, and odd widths print as xor/subtract pairs). Lane `od-rm4-e5` vs `od-main-afb7691`: 61 sign-fill selects and 7 rotate idioms fold in 28 functions (30 texts change, all of them by these folds; 14 selects and 10 rotates remain in other shapes); `btreeOverwriteContent` prints `(uint64_t)count` (`count` is an `int32_t` formal) and `size = (uint64_t)(int32_t)size`; `fts3MatchinfoLcsCb` prints `*(uint64_t *)((uintptr_t)arg2 + ((uint64_t)arg1 << 5))` with `int32_t arg1`; checked view byte-identical; reconstruction 80, fingerprints unchanged._
  - **Root cause:** the generic SBFM/UBFM lowering (`src/lifters/arm64/semantics.ts:332-353`). `foldShiftIdiom` (`src/reconstruction/source-shifts.ts:121-171`) folds only masks equal to the whole non-wrapped part.
  - **Change:** in `foldShiftIdiom` or a sibling rule in `EXPRESSION_RULES` (`source-rules.ts:632-652`), with masks equal to the field exactly:
    - (i) `(select(bit_s(x), ~0, 0) & ~mask(s+1)) | (x & mask(s+1))` → `sign_extend(trunc_{s+1}(x))`;
    - (ii) `ror(x, w-k) & (mask(n) << k)` with k+n ≤ w → `zero_extend(trunc_n(x)) << k`;
    - (iii) the combination of both.

    Extend the `shift_idiom` record.

  - **Soundness:** bit-exact identities, proof class `own` with boundary tests (or BDD).
  - **Tests:** `test/reconstruction/source-shifts.test.ts`: lifted SXTW, `SBFIZ #5, #32`, UBFIZ and SXTB, executed for inputs with bit 31 set.
  - **Acceptance:** `btreeOverwriteContent` prints `(uint64_t)(int32_t)count`; `fts3MatchinfoLcsCb` prints `arg2 + ((uint64_t)(int32_t)arg1 << 5)`. Nothing changes outside the 15 functions.

### E6: Move proven non-faulting reloads across loads

- [ ] **Problem.** `-O0` `matrix_alias` (Mach-O, ELF, PE) prints `value0 = *address; *address_1 = *address_1 ^ value0; value1 = *address; return value1 + *address_1;`. Both judges call these "redundant temporaries". There are about 12 such sites in the corpus.
  - **Root cause:** `source-inlining.ts:449-468` refuses to move a load across any intervening independent load (the fault-order premise, `:90-101`), even when the moved load's exact address was just accessed.
  - **Change:**
    - A load whose exact address range was accessed on every path from a dominating access, with no call, unknown effect or volatile access in between, may move across non-volatile loads (never across stores or calls).
    - Record `nonfaulting_load_order` and `requireAbi('nonfaulting_reload', …)` (D7, accepted).
  - **Tests:** `source-inlining.test.ts`: aliasing memories (a == b), and a fault memory where the first access faults.
  - **Acceptance:** `matrix_alias` `-O0` prints `*address = *address + arg2; *address_1 = *address_1 ^ *address; return *address + *address_1;`.
  - **Depends on:** E1 (same file).

## P: Preamble and comments

### P1: Table contents policy and extent soundness

- [x] **Problem.** Inlined tables cost 15.6k lexical tokens, 7.6% of OD's total. 87% of that is six 256-byte maps repeated across 38 functions, which no judge asked for and which no QA answer uses: the four table-backed QA questions are 0/3 for OD today. One declaration is wrong: `unicodeNext` prints `static const uint8_t sqlite3Utf8Trans1[3979]` (source: 64 entries), followed by 192 bytes of neighbouring opcode-name strings.
  - **Root cause:**
    - `TABLE_FULL_BYTES = 512n` and `TABLE_PREFIX_BYTES = 256` (`renderer.ts:209-210`).
    - `tableContents` (`:3866-3956`) takes `span_bound` (the distance to the next symbol, "a bound, not a size", `source-model.ts:139-142`) as the extent (`:3887-3890`).
    - `maximum()` (`src/emitters/source-tables.ts:42-63`) cannot bound `x − c`.
  - **Change:**
    1. A symbol size (`byte_length`) stays an extent. `span_bound` only caps the accessed range:
       - `total = reach` when `reach ≤ span_bound/size`;
       - otherwise the extent is not established and the table prints as `name[] = {` + first row + `/* ... further elements not shown */`.

       The note keeps `VA 0x…, read-only; N elements` and drops the basis words.

    2. Print a table in full only up to `TABLE_FULL_BYTES = 64`. Otherwise print one 16-byte row plus `/* ... N more */`, with the declared `[N]` when the extent is established; `TABLE_PREFIX_BYTES = 16`. Lower `TABLE_BYTES_READ` (`source-facts.ts:655`) to 64. Python-like follows through the `memory_view` form.
    3. Optional: `maximum()` learns that `x − c` with `x ≤ m` (a u8 load or a dominating `x ≥ c`) is `≤ m − c`. With it, `Utf8Trans1` becomes `[64]` and prints in full.
    4. Record `presentation('table_extent', …)`: an extent is claimed only from a symbol size or a bounded access range.
  - **Soundness:** the bytes shown are exact. The printed length is a symbol size or a proven access range, never a neighbour distance. The test interpreter never reads printed contents (`test/emitters/c/support.ts:357, 478-488`).
  - **Tests:** `test/emitters/c/data-symbols.test.ts` (update "large tables show a bounded prefix"):
    - `span_bound` with an unbounded reach prints `[]` and 16 elements, in both dialects;
    - a bounded reach prints its reach;
    - the 64 B boundary (u8, u32, u64);
    - `execute()` against `tableFixture` with masked and unmasked indices.
  - **Acceptance:**
    - Exactly the 38 table functions change.
    - `aHardLimit` (60 B), `aType` (64 B), `statemap` and `aAscii` change only in the note.
    - No `[3979]`.
    - Checked view identical on all 232.
  - **Expected effect** (measured on the stored texts): lexical sum 205,686 → 192,009; geomean 1.337 → 1.272; Claude geomean about 1.42 [estimate]; QA tokens on `sqlite3_incomplete`, `sqlite3_stricmp`, `sqlite3_strnicmp` and `renameColumnFunc`.
  - **Evidence (rm4-p1):** OD lane `od-rm4-p1` vs `od-rm3-final`: exactly the 38 texts that print a table changed (all other 194 byte-identical, no state/work change beyond noise), no `[3979]`; lexical sum 205,686 → 192,106 (1,087,232 → 1,052,948 bytes); checked view byte-identical on 6 changed functions. `maximum()` stayed as it was; `reachOf` (source-tables.ts) adds the guarded `x - c` and constant `x >> c` rules (so `Utf8Trans1` is `[64]` in full and `aAscii` `[4]`). Deviation: `statemap` (index is a loop-carried state with no provable range) and the tables whose index range is not provable (`UpperToLower`, `aEntry`, `CtypeMap`) now print `name[]` with the first row; the old `[10]`/`[274]` were neighbour distances (source: `statemap[8]`).

### P2: Struct bodies without pad members in the inline text

- [ ] **Problem.** Struct bodies cost 7,200 tokens, and 482 of their 1,382 members (35%) are `uint8_t pad_0xOFF[N];`. Every real member name already carries its offset (`field_0x14`). Judges cite pads in 28 reasons.
  - **Root cause:** `structureBodies` (`renderer.ts:3369-3435`) emits a pad for every gap (`:3407`, `:3418`), because the same lines feed `emission.structures`/`types.h` (`:9350-9355`).
  - **Change:**
    - `structureBodies(compact)`: for `options.structures === 'inline'`, omit pads (`struct X { uint32_t field_0x4; opaque_1* field_0x28; };`). For `external` (export/`types.h`, `src/cli/export.ts:468-478`), keep today's text.
    - Keep `__attribute__((packed))` iff the exact layout is packed.
    - Record `presentation('compact_struct_members', …)` with the omitted gaps.
    - `test/emitters/c/support.ts` `structBody` reads offsets from `field_0x<hex>` names when no pad precedes them (and keeps the pad path for external text).
  - **Soundness:** presentation. The emitter never claimed complete layouts (`image-types.ts:42`).
  - **Tests:** `test/emitters/c/source-structs.test.ts` (inline vs external; pads in `emission.structures`); one test per dialect for `address->field_0x14` with a gap before it, with equal `execute()` results.
  - **Acceptance:** the 99 functions with bodies change. Everything else, including `types.h`, `emission.structures` and the checked view, is byte-identical.
  - **Expected effect:** −2,892 lexical tokens, geomean −0.024 (measured on texts).

### P3: Header comment diet

- [ ] **Problem.** OD prints 33.5 KB of comments against Ghidra's 1.3 KB, and the Claude tokenizer counts them.
  - **Change** (one emitter change each):
    1. Drop the bare `/* partial */` before struct bodies (183 lines; `renderer.ts:3424-3431`). Keep `/* conflicts with X, Y */`, and drop the `partial; N fns;` prefix.
    2. Table notes drop the basis words (with P1).
    3. Shorten `open arity (calls show proven args only): …` to `open arity (proven args only): …`. The callee list stays: it is the roadmap 2 G7 replacement for inline `, ...`. The interpreter regex `test/emitters/c/support.ts:349` accepts any parenthetical.
    4. Drop `/* import from libSystem.B.dylib */`; keep `/* used as a value; prototype unknown */`.
    5. The FP note is F3's job.

    Update docs/CORE.md (`:66`, `:1173`).

  - **Tests:** update `source-structs.test.ts:379, 487` and `source-c-support.test.ts:352`. The Python-like `# open arity (…)` wording follows C.
  - **Acceptance:** only comment bytes change (about −14.5 KB); lexical metrics byte-identical; checked view identical.
  - **Expected effect:** Claude geomean about −0.015 [estimate].
  - **Depends on:** P2 (same function).

### P4: Struct class names without another function's name

- [x] **Problem.** 250 of 418 struct names are `<fn>_arg<N>_<hash>` (`sqlite3VdbeAddOp3_arg0_e84e`, `setSectorSize_arg0_f48_f0_2620`), 1,190 occurrences and 34.5 KB. 141 of them name a function other than the one printed, which the judge called "misleading sqlite3DbFree_arg1 type name".
  - **Root cause:** `src/analysis/types/image-types.ts:395-452` names a class after its first anchor.
  - **Change:**
    - Function texts print `struct_<6hex>` (already used for 146 classes; `source-structs.ts:241`).
    - `ImageTypeClass.name` keeps the anchor for metadata, and `types`/`types.h` print it as a comment (`/* first seen: setSectorSize arg0 */`).
    - Both dialects change.
  - **Tests:** `test/analysis/types/image-types.test.ts`, `test/emitters/c/source-structs.test.ts`, `test/reconstruction/image-types-source.test.ts`, the docs/CORE.md image-type section.
  - **Acceptance:** only struct names change; lexical tokens unchanged.
  - **Expected effect:** Claude tokens −9.3k, geomean about −0.035 [estimate].
  - **Done (`wt/rm4-p4`):** OD lane: 97 of 237 texts change, every one only by struct identifiers (identical after renaming; lexical token counts unchanged); `<fn>_arg<N>_` struct names 219 (1,109 occurrences) → 0, and `_ret`/`_obj`/`_local`/`_alloc` names → `struct_<hex>` too (368 names before and after); checked view unchanged on the 4 sampled functions; versions types/16, reconstruction/79, emitters 85.

## L: Loops

### L1: A loop header's one statement prints inside the test

- [x] **Problem.** A loop header that prints any statement cannot become `while (c)`. 13 measured loops print `while (true) { x = e; if (!c) break; … }` where Ghidra prints a tested loop. Examples: the `sqlite3ParseUri` scan; the `sqlite3BtreeOpen` pointer chase. _Done (`wt/rm4-l1`): lane `od-rm4-l1` vs `od-rm3-final`: `while (true)` 217 → 203, tested loops 220 → 234, `break;` 379 → 360, `for` 18 → 19, gotos 759 unchanged; 14 loops in 10 texts print their header statement inside the test (`openDatabase` becomes a `for`), and 2 more texts (`fts3EvalNextRow`, `sqlite3Fts3Incrmerge`) only print chained negations as `x == 0`; every other text byte-identical; checked view identical; `loop_comma_condition`._
  - **Root cause:** `planLoopForms` accepts a chain stage only when `facts.silent(first)` (`src/emitters/source-control.ts:1436`), and a head test only when `facts.silent(head)` (`:1455`). The comma-operand machinery already exists for later short-circuit operands (`commaOperand` `renderer.ts:6574-6586`, `operandTerm` `:6685-6719`, carriers `:7686-7706`), and `commaOperands` is computed for every block.
  - **Change:**
    - `LoopFacts` gains `comma(block)` (a non-silent header whose `commaOperands` entry is one statement) and `carrier(block)`.
    - `choose` accepts them for the first chain stage and the single head test, and tries the do-while bottom test first when the header is comma-only. Without that order, `matrix_multi_exit` regressed.
    - The renderer records `loopCommaTests`, `region()` skips the statement, and the header text comes from `operandTerm`. Factor `ifHead`'s mapping loop (`:6951-6966`) into `mapHeaded`.
    - `acceptFor`/`acceptStatementFor` count the comma statement's operands as test reads (`:5550`, `:5590`).
    - Print chained negations with `NEGATED_PREDICATE` (`:6023-6027`).
    - Record `loop_comma_condition`.
  - **Soundness:** pure restructuring. The statement still runs once per header entry, immediately before the test, and the comma operator is a sequence point. Python-like uses only the direct walrus form.
  - **Tests:** `test/emitters/c/source-control.test.ts`, executed for n = 0, 1, 3 in C and Python-like:
    - a pointer chase;
    - a two-stage scan;
    - a carrier;
    - a loop with both a header test and a valid bottom test, which must stay do-while.
  - **Acceptance** (measured):
    - `while (true)` 217 → 203, tested loops 220 → 234, `break` 340 → 321, `for` 18 → 19; gotos unchanged; tokens −122.
    - 10 texts change (`openDatabase` becomes a `for`); 103 other loop texts are byte-identical.

### L2: Restate do-while tests over the copy source and loop-invariant bounds

- [ ] **Problem.** 16 do-while candidates fail because `rebase` fails (`source-control.ts:1533`):
  - `(uint32_t)value45 + 16 == 0x15b0` after `value45 = value45 + 16` (`adler32_z` `-O2` ×4 cells);
  - `(uint64_t)arg2 - 1 == index` after `index = 1 + index` (`matrix_callback` `-O2` ×4).
  - **Root cause:** `restateTest` (`renderer.ts:8031-8186`) requires a constant bound (`:8056-8059`) and a non-inline leaf (`:8074-8080`).
  - **Change:**
    - (1) A test on the repeat copy's source value (through bitcast, truncate or zero-extend) becomes the same predicate over the destination.
    - (2) For eq/ne against a bound B not written in the loop, `x == B` after `x ← x + c` becomes `x == B + c` (mod 2^w), folding `B + c` when `B = y − c`.
    - Both are re-proved by `validateBitvectorCandidate` (`:8155-8169`) and recorded as `loop_test_restatement`. Ordered compares stay excluded.
  - **Tests:** `source-control.test.ts`, next to the existing restatement test (about `:191`), executed.
  - **Acceptance:** `adler32_z` `-O2` (ELF, Mach-O, PE) and `matrix_callback` `-O2` print `do {…} while (…)`; −8 to −12 `while (true)` [estimate].
  - **Depends on:** L1.

### L3: `for` loops over `-O0` promoted stack-slot induction variables

- [ ] **Problem.** 8 `-O0` loops (`matrix_callback` ×3, `matrix_multi_exit` ×3, `matrix_variadic` PE/Mach-O) print `index = 0; while (index < n) { …; index = index + 1; }`. Ghidra prints `for`, and the judge cites "ghidra has a clean for-loop".
  - **Root cause:** the step and init are `store`s to a promoted private local. `trailingStatement` accepts only `assign`/`load` (`renderer.ts:5644`), and `acceptStatementFor` identifies the variable by `step.result` (`:5587`).
  - **Change:** accept a trailing store into a promoted, non-escaped, non-punned local when:
    - the test reads a load of it;
    - there is no other store to it in the loop;
    - the init is the entry block's trailing store.

    Escaped frame members stay excluded. Extend the `for_loop` record.

  - **Tests:** `source-control.test.ts`: an `-O0`-style IR executed for n = 0, 1, 3; negative: a second store in the loop.
  - **Acceptance:** those 8 texts print `for (index = 0; index < argN; index = index + 1)`. Nothing else changes.
  - **Depends on:** L1 (`acceptStatementFor`).

### L4: Rotate loop-carried copies so bottom tests become do-while

- [ ] **Problem.** 34 loops are do-while candidates rejected only because the repeat copies are live on exit (`source-control.ts:1529`). 29 loops end with "test, then pure var-to-var copies": `sqlite3BtreeOpen`, `pcache1RemoveFromHash`, `renameColumnFunc` ×4, `renameTableFunc` ×3, … Ghidra prints all of them as do-while, with the copy at the loop top.
  - **Root cause:** the header phi `x = φ(x0, y)` is resolved by a copy `x = y` on the repeat edge, after the test (`partitionVariables` `source-control.ts:448-461`, `edgeCopies` `:676-703`).
  - **Change:**
    - Only for loops whose bottom test is the sole repeat edge and whose only blocker is live-on-exit copies of a loop-defined `y`:
      - partition the header phi as a pseudo-value that coalesces with `y` (they do not interfere);
      - emit a header-start copy `x = p`, which makes the repeat edge copy-free.
    - Record `loop_copy_rotation`. The parallel-copy validator accepts the header-start copy, either as a synthetic assign or as a rule that equal copies of all incoming edges may print once at block start.
  - **Soundness:** copy placement in SSA, with no premise. Checked view unchanged.
  - **Tests:** `source-control.test.ts`, executed:
    - a list walk whose last node is used after the loop;
    - a countdown whose pre-decrement value is used after;
    - negative: `y` live into the header from outside.
  - **Acceptance:** the list walks in `sqlite3BtreeOpen`, `pcache1RemoveFromHash`, `renameColumnFunc` and `renameTableFunc` print do-while; about −30 `while (true)` and −30 `break` [estimate]. Only entry-copy names change elsewhere in those functions.
  - **Cost:** partition changes can rename variables, so restrict the rotation to candidates. Charge it like the optional partition work (≤ 1/8 of the remaining work).
  - **Depends on:** L1, L2.

## T: Time and summary bookkeeping

### T1: Incremental hash of the dependency ledger

- [x] **Problem.** `fingerprint(readset)` (`source-facts.ts:1817-1837`, inside the dependency loop at `:1786`) rebuilds and hashes the whole append-only ledger (about 10.9k reads) for every context-specialized dependency: 11.0 s of profile plus GC. _Done (`wt/rm4-t1`): all 237 lane texts and states identical to `od-rm3-final`; SQLite `decompile_ms_total` back-to-back at similar load: base 139.3 / 125.6 s → 117.2 / 106.9 s._
  - **Change:**
    - `src/core/identity.ts`: an append-only canonical hasher that produces exactly `fingerprint({version: 1, complete: true, reads})` for a growing array, with `canonicalIdentity` per element (no second format).
    - `src/project/cache/dependencies.ts`: `AnalysisDependencyCollector.readsetFingerprint(readset)` absorbs only new reads. `finish()` snapshots are prefixes (`:410-415`). Fall back to the full hash for foreign readsets.
  - **Soundness:** speed only. The evidence text and every id derived from it are byte-identical (prototype: 30 live calls compared, 0 mismatches).
  - **Tests:** dependency tests: the incremental fingerprint equals `fingerprint(readset)` for ledgers grown in steps, after `replay`/`replayTrace`, for the empty ledger and for a foreign readset.
  - **Acceptance:** all odbench texts, states and evidence byte-identical; work within noise.
  - **Expected effect:** SQLite decompiles 123.6 → 107.3 s (measured).

### T2: Charge-exact reuse and an explicit `limited` flag

- [x] **Problem.** Charged work depends on history: _(done: `PreparedNativeUnit.limited` set at every preparation limit and when the variadic footprint is cut; footprint limits no longer allowance-derived; context evidence scope content-derived instead of the random project ID (the real cause of run-to-run work noise); reused record index records its build's reads. Two full odbench runs of one build give identical per-function work; 45 functions' work and 1 text (`matrix_checksum` PE O0: open-arity note for a limited `adler32_z`) changed vs `od-main-afb7691`.)_
  - `_sqlite3Initialize` charges 275,857 at its first preparation and 278,384 in 46 later ones;
  - `_sqlite3_config` charges 333,203, 294,349 or 246,292 depending on the load;
  - about 21 SQLite functions differ in work between two runs of one build.

  This contradicts docs/internals/project-cache.md §5. It also blocks T3 and T6, and makes the benchmark's work column unstable.
  - **Root cause:** not found yet. One candidate: the silent `nativeVariadicFootprint` catch (`native-prepare.ts:434-445`) swallows a resource limit without a reason. The unit then still counts as `reusablePreparation`, which would also be a soundness hole.
  - **Change:**
    - First find the cause, with an instrumented copy that logs fn, work, kind and allowance per unit load.
    - Add `limited: boolean` to `PreparedNativeUnit` (set at `native-prepare.ts:306, 400, 426` and in the variadic catch). The retention predicates use it instead of free-text reasons.
    - Fix whatever makes the charge allowance-dependent, or record the correct `entry.allowance`.
  - **Tests:** a history-independence test: prepare one unit through `nativeUnitLoader` under allowances A < B < C in every order, and assert the same unit, charged work and reads. Add a regression test for `limited`.
  - **Acceptance:** two full odbench runs of one build give identical work counts. Any text change (a previously mis-cached unit) is listed.

### T3: Retain prepared units whose reasons do not depend on the budget

- [ ] **Problem.** Units whose only reason is "unresolved control flow" are never kept (any indirect call in the body sets it), so hub callees are prepared again in every request: `sqlite3Initialize` 30–46 times, `sqlite3Malloc` 30, `sqlite3_free` 50, `sqlite3Realloc` 13, … In total 580 repeat preparations.
  - **Root cause:** `reusablePreparation` (`source-facts.ts:1125-1126`) requires `!unit.reasons.length`, and so does the persisted schema (`native-summaries.ts:88`). The documented contract (`:1101-1110`) needs only "hit no limit".
  - **Change:**
    - Split the predicate:
      - retention (in-process and persisted): `!budget_truncated && !limited && analysis complete`;
      - the request-local `admit` (`:1675-1681`, `:1770`): keeps the old predicate, so evidence citation stays byte-identical.
    - Allow non-budget reasons in the persisted rows and bump `NATIVE_SUMMARY_FORMAT`.
    - Document the rule in docs/internals/project-cache.md §4.
  - **Tests:**
    - `test/service/analysis/native-summary-persistence.test.ts`: a unit with an unresolved indirect call is persisted and served with unchanged output and equal work.
    - `test/service/analysis/request-determinism.test.ts`: cold vs warm order gives identical texts and work.
    - The store schema test.
  - **Acceptance:** texts byte-identical (prototype: 0 of 129 changed); work identical after T2.
  - **Expected effect:** SQLite −6 to −7 s on top of T1 (measured).
  - **Depends on:** T2.

### T4: Do not load effects-only native dependencies

- [ ] **Problem.** About 26% of callee-load work on SQLite (34.7M of 134.8M) goes to deferred loads that no unobserved entry argument reaches. They change 1 of 114 texts, and they still make 22 requests `partial(budget)`.
  - **Root cause:** `native-worklist.ts:211-212, 366-373, 482-489` schedules every dependency of every loaded unit, and `:724-765` propagates the reasons of all of them.
  - **Change:**
    - Classify each dependency edge of a loaded unit:
      - _argument-reaching_ (existing);
      - _result-forwarding_: the call's result reaches a return exit or tail (`demand_index`/`nativeReturnInterface`);
      - _shape-transferring_: a `nativeShapeTransfers` candidate;
      - _effects-only_: everything else.
    - Schedule only the first three. An effects-only callee stays `unresolved()` for that call and contributes no reason.
    - The selected function's own direct dependencies stay demanded.
    - Update docs/internals/calls-abi.md §4.
  - **Soundness:** an unloaded callee's interface is `unresolved()`, which the caller already treats conservatively. Callee effects are never summarized.
  - **Tests:**
    - `test/service/analysis/native-worklist.test.ts`: on a synthetic graph, an effects-only callee is not loaded, while result and shape callees are.
    - `native-summary.test.ts` with `native-summary-source.c`: a helper that logs after computing its result keeps its closed arity and result type (execute against the oracle).
    - `request-determinism.test.ts`.
  - **Acceptance:**
    - SQLite and brotli texts byte-identical. `createFunctionApi` must keep `uint8_t* address_1` through the shape edge.
    - `partial(budget)` drops by up to 22.
  - **Expected effect** (measured, upper bound with all deferred loads skipped): SQLite work −9.3%, time −7%.

### T5: Budget labels name the fact that is actually missing

- [ ] **Problem.** 60 SQLite functions are `partial(budget)` with the caveat "callee summaries cut by budget: …". At 10× budget, 53 are still labelled. The real blocker is usually an unresolved indirect call (`sqlite3Realloc` → `xRealloc`) or nothing the text uses.
  - **Change:**
    - Propagate reasons per fact: arity along argument-reaching edges, result along result-forwarding edges, shapes along shape edges (T4's classification).
    - `source-facts.ts:1869-1881` emits `callee_partial` with the fact kind and splits budget from non-budget leaves. `resource_limit` only when a budget leaf blocks a fact the call site lacks.
    - `src/core/diagnostic-summary.ts:61-97` prints for example "open arity: sqlite3VdbeAddOp3 (unresolved indirect call in sqlite3Realloc)".
  - **Soundness:** diagnostics only.
  - **Tests:** `native-worklist.test.ts` (per-fact propagation); `test/core/diagnostic-summary.test.ts`.
  - **Acceptance:** texts and checked view byte-identical; budget-labelled states 62 → about 38–40 [estimate].
  - **Depends on:** T4.

### T6: Memoize the allowance-independent prefix of unit preparation

- [ ] **Problem.** 75 repeat preparations of units that hit a limit, 67 of them `_sqlite3_str_vappendf` (reached by about 60% of SQLite requests through `sqlite3_log`/`sqlite3MPrintf`). Each redoes graph + lift + SSA, which is 446 of 790 ms when the types/stack stage hits the limit.
  - **Change:**
    - Split `prepareNativeUnit` (`native-prepare.ts`) after SSA into `prepareNativePrefix` (graph, lift, `boundIR`, entry prefix, SSA construct + simplify + verify) and the allowance-dependent rest.
    - `nativeUnitLoader` keeps prefix entries in the same LRU. A hit replays exactly the recorded charges and reads (the `fits`/`traceCharges`/`replayTrace` discipline, `source-facts.ts:1231-1267`) and requires the SSA limit to be ≥ the recorded SSA work. If SSA itself hit its limit, reuse only graph + lift.
  - **Soundness:** a completed SSA preparation within limit L returns the same IR for every L' ≥ its work (`ssa/budget.ts:23-33`; the same argument the unit cache relies on).
  - **Tests:** through `nativeUnitLoader`, a prefix hit and the cold path give equal IR, charged work and reads, under allowances above and below the recorded SSA work, in both limit modes.
  - **Acceptance:** texts, states and work byte-identical.
  - **Expected effect:** SQLite −9 to −13 s [estimate].
  - **Depends on:** T2, T3.

### T7: Constant-factor bundle

- [ ] **Change** (all four are output-neutral):
  1. `verifyIR` identity checks: precompiled `^entity_[0-9a-f]{64}$` / `^evidence_[0-9a-f]{64}$` tests instead of zod `safeParse` per id (`src/ir/verify.ts:228, 253, 254, 582`). Measured −1.6 s.
  2. `analysis/stack/index.ts` `combine`/`join`/`union` (`:135-170`): fast paths for equal, empty and single lists, and a merge of two sorted unique lists. 5.7 s self in the profile.
  3. Do not re-validate and re-encode the result just built in the same process (`validateComputation`, `src/project/cache/index.ts:150`, 5.1 s; `delivery`): parse once, as the result-hit path does.
  4. Take `native_summaries` persistence and the per-request artifact `fsync` / `synchronous=FULL` commit (`publishArtifact`, store `:1325`, about 8 s) off the request's critical path. Summaries already never fail a request. Agree the flush points with docs/internals/project-cache.md ("durable before acknowledged" covers job state).
  - **Tests:**
    - an equivalence test of the fast predicates against the zod schemas over generated ids;
    - the existing validation, stack and store tests;
    - a crash-after-acknowledge test for the deferred flush.
  - **Acceptance:** byte-identical texts and artifacts (ids and timestamps aside); validators are as strict as before.
  - **Expected effect:** −8 to −12 s on SQLite [estimate; only part 1 measured].

### T8: Prepare and persist native units at open

- [ ] **Problem.** Native-unit preparation is 32.5% of the decompile CPU on SQLite. Even with T3 and T6, every process prepares its 499 distinct units on first use, inside requests (about 16 s). Units above size 8,192 are not persisted, because encoding them costs more than preparing them (docs/PERFORMANCE.md "Persistent analysis cache"). Parallel workers (T9, `export --jobs`) therefore cannot share them.
  - **Change:**
    1. A unit payload format whose encode plus decode is cheaper than preparation at every size (measure decode time against preparation time on SQLite's units). Remove the 8,192 persist bound once that holds.
    2. An image job at open, after import and indexing, in the CLI, API, MCP and the odbench lane. It prepares the generic native unit of every function in the index, callees first, in parallel worker processes, each under the largest allowance a request load can receive (`native-worklist.ts:270-306`). Retention follows T3; a limited unit keeps only T6's prefix. Results go into the project's persisted unit store.
    3. The job has its own work budget, is reported as open time (M2 `open_job_ms`), can be cancelled, and never fails the open. Context-specialized units stay per request.
    4. Requests read the store through the existing `nativeUnitLoader` reuse path: exact charge replay, and reuse only when the replayed charge fits the request's allowance.
  - **Soundness:** a retained unit is a pure function of the image revision, component identities and the function. Reuse replays its exact charge (T2), so texts and per-request work are identical whether the job ran, ran partly or did not run.
  - **Tests:**
    - `test/service/analysis/request-determinism.test.ts`: decompiling with and without the open job gives identical texts and work.
    - Persistence round trip of a large unit.
    - A cancelled open job leaves a usable project.
  - **Acceptance:**
    - odbench full tier: every text and per-function work identical to the lane before T8.
    - SQLite decompile time after open drops by about 15–25 s [estimate].
    - Open time and peak RSS are reported (SQLite: about 290M work, about 15–25 s on 8 workers [estimate]).
  - **Depends on:** T2, T3, T6, M2.

### T9: Parallel request workers that share the unit store

- [ ] **Problem.** Batches decompile one function at a time: the odbench lane, MCP batches. `export --jobs N` runs N workers on clonefile copies with no shared artifacts or units, rebuilding them per worker at about 1.2 GB RSS each. A project allows one running job (docs/internals/project-cache.md "Concurrency ceilings").
  - **Change:**
    - A request pool of N workers over one opened project. The T8 unit store and the image indexes are shared read-only. Results are published through the owning process, which stays the single writer.
    - The odbench lane `--jobs N` (default chosen from the M2 measurement, for example min(4, cores/2)) and `export --jobs` use this pool instead of clonefile copies.
    - Document the per-worker memory budget.
  - **Soundness:** requests are independent, because a request's work and output never depend on process history (T2). Publication order does not change artifacts.
  - **Tests:** texts and work identical for 1 and 4 workers; `export` with `--jobs 1` and `--jobs 4` writes byte-identical files.
  - **Acceptance:**
    - odbench full tier: texts and per-function work identical for `--jobs 1` and `--jobs 4`.
    - Decompile time after open ≤ 1.25× Ghidra's whole run on every binary and in total: SQLite ≤ 48 s, brotli ≤ 4.9 s.
    - The first 10 SQLite functions after open finish within 5 s.
    - Peak RSS reported.
  - **Depends on:** T8, M2.

## Expected end state

Projections combine measured prototypes with the estimates above. Overlaps (for example `isDate` in A1, F1, E3 and C2) are counted once.

| row                                        | now                       | after this roadmap                                                                               | Ghidra             | flips                   |
| ------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------ | ------------------ | ----------------------- |
| functions with text                        | 232                       | 235 (C1 measured, C3 WhereCode measured), 237 with C4 [estimate]                                 | 237                | yes, if C4 lands        |
| lexical tokens (geomean)                   | 1.337                     | ≈ 1.20 (P1 1.272 and P1+P2 1.249 measured on texts; E1 −0.014 measured)                          | 1                  | not a goal (D9)         |
| Claude tokens (geomean)                    | 1.477                     | ≈ 1.28–1.30 [estimate]                                                                           | 1                  | not a goal (D9)         |
| readability noise dimension                | 0.383                     | up (artifacts, pads, typedef noise, FP helpers and saves removed) [not projected]                | —                  | expected                |
| comprehension coverage                     | −0.057 vs Ghidra          | ≥ 0 [estimate]                                                                                   | —                  | expected                |
| wrong claims per function                  | 2.67                      | ≈ 2.22–2.32 (upper-bound sum over items, F5 included: about 78 claims) [estimate]                | 2.26               | close                   |
| return types (M1)                          | void 17/42, value 180/189 | void 35–37/42, value 184–185/189 [estimate]                                                      | 40, 172/186        | void close, value ahead |
| QA tokens per correct answer               | 4,785                     | ≈ 3,800–4,000 [estimate; brotli `main` is half of OD's QA tokens]                                | 3,528              | not a goal (D9)         |
| decompile after open vs Ghidra's whole run | SQLite 3.1×, total 1.6×   | one worker: T1–T7 ≈ 75–85 s, with T8 ≈ 60–70 s; T9 with 4 workers ≈ 15–25 s on SQLite [estimate] | 1 (target ≤ 1.25×) | expected with T9        |
| `partial(budget)` states                   | 62                        | ≈ 38                                                                                             | —                  | —                       |

## Decisions

### Taken (confirmed 2026-10-22)

- **D1, closed-world `caller_consensus` premise (V2).** "No code outside the image transfers control to F (not exported, address never materialized, every direct branch to F enumerated), and callers read results only in the ABI result registers." It is stronger evidence than the existing `incidental_result` premise, which scans no caller. It is recorded with `requireAbi`, and x0 keeps its exact exit value in exit metadata and in the checked view.
- **D2, intentional checked-view changes for A1 and F2.** A1 makes the IR effect of unlifted SIMD&FP instructions exact per ISA. F2 aligns Darwin with the SysV/Win64 modelling of FP control state and fixes fenv writers on every target. Each item declares and reviews its checked diff.
- **D3, presentation policy.** P1 prints tables in full up to 64 B, otherwise one 16-byte row. P2 omits pads only inline. P4 prints class names as `struct_<hash>` in function texts. The anchored names and full layouts stay in `types`/`export`.
- **D4, budget accounting.** C3 reallocates the request's own 10M (tail reserve, text-first render), which is not raising the budget. A per-unit allowance outside the request counts as raising and is not allowed. The open-time job of T8 is not a request: it runs under its own budget, its cost is reported as open time, and a request that reuses one of its units replays the unit's exact charge, so request work does not depend on whether the job ran.
- **D5, `escaped_frame_floor` premise (K7).** "A frame address handed to a callee or stored designates bytes at or above itself." C guarantees this only when the escaped address is an object base, which OD does not prove; the premise is recorded with `requireAbi` on every binding that uses it.
- **D6, `fp_nan_payload_unobserved` premise (F5).** `fp_native_operations` extends to stores and call arguments: NaN payloads are unspecified (IEEE 754 "should", C Annex F), and the IR's canonical NaN is not hardware-exact either.
- **D7, `nonfaulting_reload` premise (E6).** A successful access to [a, a+w) implies that a later read of it does not fault, absent an intervening call, unknown effect or volatile access.
- **D8, speed target.** Opening a binary may take longer than Ghidra's import and analysis; open time is reported but not targeted. After open, the decompile time of a binary's corpus functions must stay within 1.25× of Ghidra's whole run on the same binary (import, analysis and decompiles; `cold_ms` in the Ghidra lane), per binary and in total. On SQLite that means ≤ 48 s for the 114 functions, and the first 10 functions within 5 s. The open-time job and batch decompiles may use several cores (T8, T9); a single request stays single-threaded and deterministic.
- **D9, token rows are not a goal.** Lexical tokens, Claude tokens and QA tokens per correct answer are reported but not targeted. Items that reduce tokens are kept for their readability, noise and comprehension value; a change is never accepted for its token saving alone if it removes information a reader uses.

## Not in scope

- **More callee-summary budget, or an image-wide summary pass to change texts.** Measured: neither fixes the text artifacts (see "Ruled out by measurement"). T8's open-time pass is for speed only and leaves texts and request work unchanged.
- **A Ghidra-style void heuristic, or "each escaped base is its own object".** These can only be `likely`, so they do not move odbench.
- **Library prototypes as escaped-object extents.** `int *` does not bound accesses, and `struct stat` is opaque in the catalog. **Callee-summary extent facts** (to split the 20 multi-member escaped regions, 133 members) need a new summary fact, and most receivers are SQLite internals that are budget-cut or callback-forwarded.
- **Lifting FMADD/FMSUB, scalar FCVTZS and FCCMP as IR operations.** A1 with F1 already unblocks `isDate`.
- **Multi-statement comma loop headers.** Ghidra refuses them too.
- **Exit and follow choice for multi-exit loops (127 loops), and sinking identical edge copies into joins.** OD prints 376 gotos right after an assignment vs Ghidra's 225. Both need a goto cost model. They are the next control-flow candidates once L1–L4 are measured.
- **Dropping `(uint32_t)call_result` casts (225 sites).** Re-measure after V1–V3: the width comes from forwarded result demand.
- **Folding single-use `call_result_N`.** Memory effects sit between the call and the use in 25 of 25 sampled cases.
- **`yy_reduce`'s 348-entry table, and `va_arg` recognition.** Carried over from roadmap 3.
- **Struct-by-value returns for the AAPCS64 x8 indirect result** (Darwin `matrix_aggregate`). The current form is exact and matches Ghidra.

## Measurement

Every item is measured with odbench on the full tier, from a worktree with a built `dist/`:

```sh
bun run build
/Users/df0/Documents/projects/od-wt/heavy.sh bun run bench run od --label <item> --repo <worktree> --tier full
bun run bench all --label <item> --base od-rm3-final --tier full     # judged against Ghidra and against the base
bun run bench report --lanes od-<item>,od-rm3-final,source --tier full
```

Report per item:

- the acceptance texts, before and after;
- the set of texts that differ from the base (it must equal the expected set);
- the M1 rows;
- readability against the base and against Ghidra on the changed functions;
- comprehension and wrong claims on the changed functions;
- the work of brotli `main`, `isDate`, `sqlite3Fts3Incrmerge` and the changed functions.

Only changed texts are judged, which costs about $0.10–0.50 per item. Speed items (T, C4) also report the M2 rows from a run started on an idle host (load average below half the cores; the lane warns otherwise), with `--repeat 2`.

The roadmap result is measured once, after the last merge. It uses `--comprehension-samples 3` for the OD and Ghidra lanes, because single-sample comprehension has a CI of about ±0.1, and `--repeat 2` to check determinism and the work column (after T2). The corpus is a development set; claims of generalisation need a new sealed suite (docs/PERFORMANCE.md "sealing rule").

## Definition of done for each item

- The listed acceptance functions change as stated. Every other full-tier text stays byte-identical, or each other change is listed and goes toward the source. The checked view is unchanged unless the item says otherwise.
- Semantic tests in the named files: behavior through the IR builder and `execute()` of emitted C and Python against oracles, not text snapshots. Run `bun run typecheck`, `bun run test:unit` and `bun run test:integration`.
- Validation records and ABI requirements as named. Component versions are bumped at merge time.
- Docs are updated with exercised evidence only: docs/CORE.md (rules, premises, helper vocabulary), the relevant docs/internals pages, and a docs/PERFORMANCE.md entry with the odbench numbers. Tick the box here with a one-line evidence note.

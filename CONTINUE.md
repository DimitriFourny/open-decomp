# Continuation: post-TODO review and next fixes

Repository: `/Users/df0/Documents/projects/open_decomp` (TypeScript/Bun native decompiler, macOS ARM64 host). Only trusted source-built oracle programs may execute; never execute analyzed inputs. Never raise budgets, reduce selected workloads, drop effects/arguments/results, invent type facts, suppress validation, or special-case fixtures to pass a gate.

## Status (2026-10-19, main `c8dceed` + docs)

Primary consumer is now an LLM reversing an app; the headline metric is **LLM task success per token** (`scripts/bench/llm-tasks/`, results in `docs/PERFORMANCE.md`): on 42 frozen source-derived questions (SQLite 3.54.0 exe + brotli 1.2.0), Haiku answered 41/42 (`mcp-default`) and 42/42 (`export-file`), versus 35/42 before the constant-data/diet slices and 27/42 from raw disassembly; on Ghidra's 16 questions 16/16 vs Ghidra 13/16, at ~2.2× Ghidra's tokens per correct answer.

Landed this round (each a merged `wt/*` branch): text-first MCP `function_decompile` (tools/list 350 KB → 34 KB; `_CheckAlias` 211 KB → 2 KB), short handles, compact caveat header; metadata limits never discard pseudocode; selected-mode proof closure fix; 6.9k generated library prototypes + typed imported data (`bun run prototypes`); named GOT/IAT/bind globals and import stubs; string/char literals by evidence; names from prototype parameters/result roles; Darwin variadic stack arguments; SCC-ordered callee summaries; void-result inference; callee-saved save/restore elision; image-scoped struct identity, array-of-struct access, `types` command/view; `open-decomp export` (per-function files + index/strings/imports/exports/`types.h`); cross-request callee reuse (~1.6× one-process p50); ObjC metadata, `-[C sel]` names, message syntax, ivar-named `self`; typed locals and cast minimization; `...` for open arity; noreturn import calls end flow; constant tables/folded read-only loads/function-name constants; `field_0x…` members.

TODO.md P3.6/P3.7 stay open: P3.7's "fewer irrelevant bytes than Ghidra" is still false on Ghidra's 16 questions (6,983 vs 2,518 est. tokens); P3.6 unchanged.

## Raw evidence (local, not versioned; ignored in .gitignore)

`investigation-evidence-2026-10-17/` (runs 1–10, run10 private scoring), `incremental-*-2026-10-17/`, `quality-rounds/round6-2026-10-18/` and `quality-heldout-inputs-2026-10-17/` (all under `.local/`; the former prospective and perf-final roots outside the repo were removed). The "held-out" lane is now a frozen _published_ suite (source and JSON hash indexes are tracked; gold/results archives are external); a fresh held-out claim needs a new sealed set outside the repo.

The 15 formerly tracked benchmark archives live in the canonical, gitignored store `${OPEN_DECOMP_EVIDENCE_DIR:-.local/evidence}/<original repo-relative path>`; back it up yourself. `node --import tsx scripts/bench/fetch-evidence.ts` populates the store from another copy: exactly one of `--from DIR` or `--url-base URL` is required (`--only NAME` selects one archive). `scripts/bench/evidence-assets.json` pins sizes/SHA256; no public mirror is configured. Provision the baseline before `bun run check` so the SQLite interfaces integration test runs rather than explicitly skipping. See `docs/PERFORMANCE.md`.

## Next (prioritized)

1. **Token cost vs Ghidra.** Per-correct tokens are ~2.2× Ghidra's on its 16 questions. Largest remaining sources: `...` open arity where callee summaries stay open (SQLite `sqlite3_free`/`sqlite3Malloc` pass untouched x1..x7 into config function pointers; caller-consensus closure is designed but not built — see docs/CORE.md), `entry_sp` frame memory for escaped locals, residual casts on integer-typed pointer locals, goto-heavy structuring in a few functions (`ParseInt`).
2. **Analysis scope.** Resumable per-root whole-image discovery as a background job so real images stop being permanently `partial`; persist callee summaries on disk (CLI cold path still pays ~0.6–0.8 s fixed cost per process); x86-64 lifter continues past unsupported instructions like ARM64.
3. **ObjC gaps.** `[super …]` methods lose the typed header (stack-built `objc_super`), `-init…` ivar writes through the `[super init]` result, `NSLog` format rule.
4. **Reliability/safety.** stdio pending-ID leak on cancellation; per-job cooperative cancellation; poisoned cache rows recompute; trust check before resuming a foreign project directory; HTTP global rate limit only after authentication; escape C1 controls in emitted strings.
5. **Benchmark.** More answerers (a stronger model, repeated runs for variance), more binaries (an ObjC app, a stripped binary, x86-64), and a real tokenizer.
6. **Hygiene.** `format:check` + real ESLint rules in `check`; commit the comparison `contract.json` instead of `/tmp` defaults; fix docs drift (store schema 5, SSA snapshot cost, DMB modelled).

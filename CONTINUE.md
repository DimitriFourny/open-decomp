# Continuation: finish TODO.md

## User contract
The user asked the coordinator to assign implementation to `sol-worker` subagents, parallelize independent slices, tick TODO.md only when acceptance is met, and commit after each finished task until all tasks are done. Their latest request was to commit the current checkpoint and provide a continuation prompt. This checkpoint is NOT completion of the seven remaining tasks.

Repository: `/Users/df0/Documents/projects/open_decomp`; TypeScript/Bun native decompiler, macOS ARM64. Only trusted source-built oracle programs may execute; never execute analyzed inputs. Never raise budgets, reduce the selected workload, drop effects/arguments/results, invent type facts, suppress validation, or make fixture-name/hash special cases to pass a gate. LSP was checked: no configured servers.

## Status
TODO.md remains **26/33 checked**. Seven open:
1. P1.3 selected SQLite interfaces (blocked by default work; preserve direct sqlite3_incomplete full regression).
2. P1.11 proportional selected-function work (active).
3. P1.13 SQLite MCP navigation/cache paths.
4. P2.4 separate correctness/coverage/readability/performance report.
5. P2.5 normalized repeated performance methodology.
6. P3.6 correctness-equivalent incremental latency AND memory distributions.
7. P3.7 blind investigation tasks with less repair AND fewer irrelevant bytes.

Last completed task commit before this checkpoint: `c54d22c` P3.4 context-sensitive recovery. Earlier milestones: `7443ee1` P3.1, `665bf5d` P3.2, `7864dae` P3.5, `05e4580` P3.3. Some P3.6/P3.7 correctness prerequisites are intentionally already committed; their empirical gates remain open. Do not tick based on implementation alone.

## Checkpoint scope
All active workers were explicitly frozen. Maintained code/test/bench changes are committed together at the user's request, not as a false task-completion commit. Multi-GB raw evidence directories remain untracked ON DISK (not deleted): `incremental-controlled-functional-2026-10-17/` (~1.6GB), `incremental-controlled-functional-fine-2026-10-17/` (~17MB), `incremental-evidence{,-final,-verified}-2026-10-17/` (~360MB each), `investigation-evidence-2026-10-17/` (~186MB). Do not blindly git-add these or pycache. Historical evidence identities must never be relabeled.

Current identity was explicitly bumped and runtime-smoked: pipeline/10, ssa/4, stack-calls/6, reconstruction/23, C emitter23, Python emitter23. Types6/values-effects3 unchanged. Older actual proofs pipeline9/emitter22 remain historical, not proof of the new identity.

## P1.11 budget work — next immediate priority
Owner in prior session: GraphBudget (sol-worker integration), with NativeBudgetSlice and ReconstructBudgetSlice. They are frozen; new sessions should assign fresh workers with this contract, not assume process-local agents survive.

Implemented coherent optimizations:
- immutable per-image selected-root traversal/index/cache; direct calls excluded from intraprocedural ownership; no mutation of historical function ranges;
- sparse value propagation, SSA root-cell indexing and canonical binding layouts; only private frozen descriptor facts reused, mutable external descriptors remain fully validated;
- exact stack COW/dirty propagation, escape/barrier map proofs invalidated on mutation; bounded iterative CFG reverse-postorder fixed-array priority worklist replacing FIFO; all lattice/contribution/snapshot logic and final output order preserved;
- native structural indexes reused per exact SSA/ABI, changing callee contracts and query demand reevaluated; separate baseline/specialized contexts;
- demand-indexed call preparation; static structure shared, per-call whole-carrier/witness semantics fresh;
- persistent source normalization dependency worklist with new-expression discovery and late alias invalidation;
- conservative normalization-only demand closure (newest slice): includes parameters/entry storage; ALL loads+addresses/results, stores+addresses/values, register read/write values; original and projected call args/results/input/output/indirect target; unknown-effect raw registers; branch/switch/control; original+projected returns; every raw unresolved physical exit/tail channel; recursively ALL phi sources and expression operands. Missing/new consumer or control kind falls back to full normalization. Original IR/expression map/catalog/provenance/requirements are retained. No effect/fact pruning.
- Renderer reference grouping/metadata accounting fusion, original-subject inference joins, source-data memo, supplied-name-root traversal, publication validation fused into existing complete subject loop.

Most important safe source SSA policy: `observable_register_masks` plus helper `src/analysis/ssa/observable-masks.ts`. Default public SSA is FULL unchanged. Every actual read/write ROOT remains FULL unconditionally. Only clobber-only roots may track the union of classifier-derived argument/result/HFA/hidden/sret/implicit locations and ALL ABI-preserved slices. ARM v8-v15 preserved low64 remain tracked; caller-saved high64 may be omitted ONLY absent any actual read/write or ABI capability; later upper read OR write restores the entire root including earlier clobbers. Full CallClobbers/effects/provenance remain, and verifier checks remain unchanged (already intersect tracked layout). Disjoint bit masks retain exact runs. No ABI-name switches or authored prototype claims.

Measured history (deterministic charged work, NOT timing): baseline1,409,476 -> native/normalizer1,364,399 -> root policy+stack1,103,063 -> exact masks **1,033,184**, 43 roots/57 cells, native261300 (artifact1167). This last census is BEFORE final RPO and final normalization-demand closure. Their combined total was unmeasured when the user requested freeze. Do not discount work or lower native pool fractions. Root snapshot memo and TOP-saturation shortcuts were NOT implemented; snapshot memo explicitly held.

Known actual default failure: fresh public fixture_check after exact masks FAILED `resource_limit`, work limit1,000,000 consumed1,000,015, NO text/artifact (artifact1170; selected-work script exit0 is NOT success). Do not rerun simply to confirm. RPO/demand changes since then justify a new actual run after coherent readiness:
```
node --import tsx scripts/bench/selected-work.ts --mode public --contract /tmp/open-decomp-ghidra-compare.sfUkLc/contract.json --binary corpus-arm64 --function fixture_check
```
Inspect actual `function_decompile.result.state/error/data`, not process exit. A counts-only census is diagnosis, not default-budget success. Need also fresh direct sqlite3_incomplete after actual fix, then ALL originally selected52 normal API emissions and ordinary CLI/MCP defaults, both dialects/no supplied prototypes. Only then P1.3/P1.11/P1.13 can close, separately tick/docs/commit.

Verification before checkpoint: post-mask77 focused checks passed in two suites (49+28); overlapping later RPO36 passed, do NOT add overlapping counts as113. Covers all3 ABI inventories, exact masks/preserved halves/later upper use, SSA/bindings/IR provenance and malformed descriptors, stack COW/late/backedge/overlap/barriers, actual emitted C/Python widths/induction, native context/FP contract withdrawal/private-vs-external stores/demand returns, actual public selected-body isolation. RPO regression all40 late-predecessor source IDs and memory value42 preserved under bounded work; low-budget facts/snapshots clear. Final checkpoint verification is recorded by the final chat/commit.

A typecheck exposed two consumer fixes, applied: release-acceptance.ts now narrows disassembly.detail==='full' before bytes; native-interface ABI clone retains bound classifyCall (prototype method cannot be object-spread).

## P1.3 and P1.13
SQLite fixture/source tests: `test/reconstruction/sqlite-interfaces-source.c`, `.test.ts`:63 trusted native oracle rows; named wrappers+logging/mutex callbacks+fixture_direct+direct299-instruction sqlite3_incomplete. KEEP the full direct 64-result/parenthesis default-budget regression, no skips/narrowing/work raises. After budget fix run:
```
node --import tsx --test test/analysis/calls/observed.test.ts test/analysis/calls/argument-preparation.test.ts test/analysis/calls/upper-result.test.ts test/reconstruction/sqlite-interfaces.test.ts
```
NavigationCache implementation:29 focused tests passed; SQLite3389 unique functions, requested1000 pages autolimited125 under2MiB; immutable metadata LRU4/64MiB with full SHA checking/history/tamper guards. Acceptance still requires all52 default useful public paths. No task tick yet.

## P3.7 investigation — explicit failed gate, approved next design
Correctness APIs exist: explicit immutable artifact/current scope, filtered paged original inferences/requirements and reviewable original subject metadata; function_decompile delivery auto/artifact distinct from semantic partial state; factored JSON schemas; exact producer-recorded declaration_span (UTF16) excluded from body quotes; disassembly detail compact/full defaultfull, original architecture decoder formatting, bounded gaps/statuses and cache accounting. Actual SDK357 checks, ARM+PE-x86 native consumer80 checks, and all5 trusted-source oracle cases passed at recorded pipeline9/emitter22. Native proof establishes SDIV64 despite reconstructed IR128, direct/callback forwarding and post-call addition. Do not call helper names proof of semantics.

Frozen five questions/source/gold/binary retained across all runs; they are development-feedback cases, NOT heldout anymore. Runs1..9/raw failures retained. Run9 two NEW independent Sol reviewers R5/R6 were given ONLY:
`investigation-evidence-2026-10-17/paired-run9/review/{INSTRUCTIONS.md,packet-A.json,packet-B.json}`.
All10 answers and5 paired preferences each correct on audited supported fact/uncertainty atoms. Their original JSONPath selectors were invalid: originals retained; syntax-only RFC6901 disjoint corrections preserved ALL non-path content and scalar-leaf relevance intent, independently verified. Corrected invalid0/overlap0. Reviews/scorers/gold/correction audits retained in paired-run9/private.
- R5 irrelevant A564/B326; repairs A3/B5; preferences A2/B2/tie1.
- R6 irrelevant A175/B120; repairs A3/B5; preferences A1/B2/tie2.
- Packet A5445B/B14089B; fullwire A47822/B500213.
**Gate FAIL**: fewer irrelevant bytes but MORE manual reconstruction; larger wire. No tick or superiority claim. B native-only requires reconstructing algorithm/result expressions and signed128IR-vs64native reconciliation. Unknown arity/bounds/effects must remain.

APPROVED NEXT design (NOT IMPLEMENTED): same ALL5 frozen questions/binary/gold, source+native workflow: include_quotes:true AND kinds includes source; add PAGED investigation kind `helper` (14th kind; migrate caps/filters/contracts/docs/callers), original artifact helper index+name+explanation REUSING existing emission.helpers element validators. These are renderer pseudocode semantic contracts, not original source/executable definitions. All actual used helpers, no favorable fixture filtering; normal pagination/bounds/cancellation; full artifact unchanged; no unpaged duplicated descriptions. Quote exact producer spans, exclude only exact declaration interval. Keep native and all uncertainties. Existing helper menu may remain discovery, not duplicated bodies. No helper-kind mutations had begun at freeze. `scripts/bench/investigation.py` has only UNRUN run10 prep: +source kind/include_quotes true/RFC6901 disjoint instruction clarification. No run10 occurred. Prepare/verify actual public SDK+source consumers, then freeze and use TWO NEW blank Sol reviewers (not R1..R6), same rubric, preserve all outcomes, disclose development feedback/style unblinding.

Useful prior-session local artifacts (may be host-scoped; durable raw dirs/code are authoritative): `local://p37-native-follow-on-handoff.json`, `local://p37-investigation-docs-addition.md`, `local://selected-work-implementation.md`, `local://reconstruct-budget-evidence.json`, `local://native-budget-evidence.json`. DO NOT apply old graph staging patches to combined WT: stale pre-mask/pre-compact partial ownership snapshots. Current combined code is authoritative.

## P3.6 incremental implementation vs empirical acceptance
Correctness prerequisites committed c54: complete positive/negative dependency ledger, candidate bound8, storeSchema5/analysis_reuse, exact global cache identity preserved; a validated historical computation publishes NEW artifact/catalog at NEW revision, original proofs/history immutable; no ledger => conservative miss; native readsets replay and annotation/declaration absence included.36 leaf requests/12 zero-lift reuses and14 safety groups passed. No consistent normalized latency+memory win claimed.

Controlled scripts committed: `scripts/bench/incremental-controlled{,-worker}.ts`, `.py`, `incremental-output-oracles.ts`, `incremental-equivalence.ts`. Protocol in prior local artifact incremental-controlled-protocol.md. Four frozen functions (max/loop/threadsafe/strnicmp),5/5/1/30 source cases, ASCII lookup table256 independently validated. Benchmark-only control clones exact closed project snapshots and ONLY offline deletes exact B analysis_reuse row in control, logs all changes. No production force-compute flag. Same warmups, balanced role order, six paired repetitions intended; separate matched reopen clones; no forced GC/sleeps/padding.
Actual functional cohort `incremental-controlled-functional-2026-10-17/experiment.json` passed8 first/reopen pairs/205 independent observations: full control1lift/reuse0; new revision3/4 artifacts; identities, catalogs, claims/statuses/edges, complete ledgers, histories, output equivalence. Only declared proof-ID/original-proof-revision alpha comparison (raw proofs retained), not Nav strict same-revision observer control. Functional proof only at recorded pipeline9/22, not normalized performance. Finer sampler cohort failed worker preack while source files changed, retained; requested2ms achieved median14.178ms actual, NEVER call it500Hz. Final endpoint paired6 primary for short requests, peaks unavailable=>null not0, log actual cadence.
All further actual cohorts are HOLD until final coherent build and explicit parent release; normalized measurement additionally needs exclusive serialized slot.

## P2 comparative and performance work
Historical baseline immutable pipeline6/rec9/C10. Broader24inputs/288pairs: OD186texts48complete138partial vs Ghidra190. Heldout24inputs/120pairs: OD80texts42complete38partial40missing vs Ghidra70/50missing. Gold184casesx4builds=736 gold-only pass. Exact unchanged-output executable subset OD4/120cells156/156cases116unverified; Ghidra36cells1346/1346cases84unverified; invalid driver attempts retained. Historical two Sol all60-pair readability reviews preferred Ghidra in all120 preferences; no parity claim. Pending evaluation scripts and five archived raw/gold/invalid-driver/packets/readability evidence files in scripts/bench are checkpointed. Text size is not quality.

Prospective plan `scripts/bench/quality-prospective-plan.json`: after FINAL coherent build/tests, rerun all24broader x12functions x2tools=576 toolcells plus all24heldout x5 x2=240; same original binaries/addresses/flags/pinned MCP/equal access/normal budgets; keep every failure/partial. No prospective runs yet. Prior local contract quality-prospective-run-contract.md. Original broader root `.local/performance/quality-matrix-reviewed`; output `/Users/df0/Documents/open-decomp-quality-prospective-2026-10-17/{broader,heldout}`. Fresh all available matched-pair packets, TWO NEW blank Sol reviewers, hash/schema/quote check before unsealing; no source/detail feedback to reconstruction tuners.

Normalized prepared scripts: quality-persistent.py, quality-persistent-ghidra.py, quality-persistent-observer.mjs, quality-persistent-hooks.json, quality_persistent_snapshots.py. Four lanes: OD unobserved/observed, pinned existing bridge, persistent native Ghidra DecompInterface. Same MCP client, serialized balanced3 repsx10, fresh/import/resume/cached distinction, separate ping, RSS process tree/cadence. OD observer controls use byte-identical closed postimport/project snapshots preserving IDs/revisions/context/artifacts; strict full source/coverage/cache identities/inferences/requirements/local-validation equivalence.23 observer modules pinned/failclosed; regenerate pins ONLY after final compiled build. No measured normalized runs started. NavigationCache, IncrementalAnalysis, ComparisonHarness all explicitly HOLD.

## Immediate resume sequence
1. Read TODO.md and this checkpoint; confirm current files, don't reapply stale patches. Initialize task tracker with all seven items; assign fresh sol-worker slices based on contracts above. Respect raw evidence and historical pins.
2. Obtain final demand-closure proof/census if preserved; run combined deterministic count and fresh ordinary fixture_check/sqlite3_incomplete AFTER real code changes. Fix remaining owning-layer work, not budgets/checks/coverage.
3. Prove all52 public defaults + SQLite63 source oracle, actual CLI/API/MCP, then separately tick/docs/commit P1.3/P1.11/P1.13 when earned.
4. Implement approved paged helper/source computation investigation workflow; actual SDK/native+source oracle; frozen new blank two-reviewer cohort, strict correctness/uncertainty/relevance/repair. Keep gate unchecked if failed.
5. Final typecheck/build/full tests/format check and actual CLI/API/MCP smoke. Only then release serialized normalized performance + controlled incremental six pairs + prospective all-cell comparisons. Do not run unrelated loads during measurements.
6. Publish separate results with counterexamples and actual scope, tick and commit each completed task. No claim of general superiority or parity from a favorable subset. Do not stop at a phase boundary while actionable work remains.

## Final checkpoint verification
After freezing all workers, `bun run typecheck` passed. The final focused run passed **45/45 tests**, including new normalization-demand/effect/physical-return retention, late-definition/shared-storage normalization, original-subject preservation, exact ABI masks, stack RPO/COW/backedges, native changing contracts, investigation contracts, independent local validation, and actual emitted C/Python width/induction behavior. No final full suite, formatter, all52 workload, normalized performance, run10 investigation review, or prospective matrix was claimed. The ordinary default failures described above remain historical ground truth; the final RPO+demand combination still needs its own actual default run.

## Late frozen investigation evidence handoff
After the checkpoint, AgentInvestigation packaged the retained runs1–9, SDK/native data, original/corrected reviews, strict scores, audits, source/gold, and ownership snapshots at `.local/p37-investigation-evidence-2026-10-17-run9-final.tar.gz`. Worker-reported SHA256: `b6801ad0fd1cf90e4f7a4dfed1c67f61e8458889fdac969ba5d0765db32255b2` (not independently rehashed by the coordinator). Additional detailed continuation is `investigation-evidence-2026-10-17/handoff/CONTINUATION.md`. These are local evidence files, not newly exercised verification. Worker reconfirmed: helper-kind implementation never began, kinds remain13, only unrun benchmark source/quotation prep exists, run10 remains HOLD.

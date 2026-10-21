# Performance and resource evidence

Roots recorded under `~/Documents/` before round 6 no longer exist; archived evidence is in `.local/evidence/` per `scripts/bench/evidence-assets.json`. Historical sections below keep their recorded paths.

## Evidence archive setup

The 15 retained `.tar.gz` bundles are external assets, not git content. `scripts/bench/evidence-assets.json` pins every original repo-relative path, byte size and SHA256. The canonical store is `$OPEN_DECOMP_EVIDENCE_DIR`, or `<repo>/.local/evidence` when unset, preserving those paths; `.local/` is gitignored, so back the store up yourself. `fetch-evidence.ts` populates it from another copy of the archives; exactly one of `--from DIR` or `--url-base URL` is required. No public download location is currently configured.

```sh
# Populate the store from another copy of the archives (e.g. your own backup), preserving repo-relative paths:
node --import tsx scripts/bench/fetch-evidence.ts --from "$EVIDENCE_BACKUP"
# Fetch one bundle by basename (the original repo-relative path also works):
node --import tsx scripts/bench/fetch-evidence.ts --from "$EVIDENCE_BACKUP" --only baseline-2026-10-17.tar.gz
# If a mirror is published, it must preserve the manifest's repo-relative paths:
node --import tsx scripts/bench/fetch-evidence.ts --url-base "$EVIDENCE_URL_BASE"
```

Fetch verifies size/SHA256 before publishing each asset; existing store files are checked too. TypeScript `evidencePath()` and Python `evidence_path()` resolve the same manifest and verify each asset once per process. Missing archives report the fetch command; corruption is an error, not a test skip. The SQLite interfaces integration test explicitly skips only when required host tools or its baseline archive are absent; provision the baseline to exercise it.

Below, `$EVIDENCE` means `${OPEN_DECOMP_EVIDENCE_DIR:-.local/evidence}` when running from the repository root. Archive basenames in historical JSON remain provenance identifiers; their bytes now live beneath this store, while JSON hash/member records remain tracked.

## Status and method

These historical macOS measurements were captured after Node 24.22.0 strict checking, **695/695 tests**, compilation and **24 compiled MCP release scenarios**. They are a recorded baseline, not measurements of later revisions. **macOS arm64 / Node 24.22.0 is the verified execution host.** Linux/WSL using Linux Node is intended but has no host performance/qualification claim. Native Windows execution is outside the product requirement. Windows PE x64 is a statically analyzed target in the macOS measurements, not the measurement host.

Host: Darwin 27.0.0, arm64, Mac18,5, Apple M6, 12 logical CPUs, 16 GiB RAM; Node v24.22.0, V8 13.6.233.17-node.57. A one-vCPU QEMU Windows verification guest was running concurrently. This was not a dedicated idle benchmark host.

The compiled harnesses use the actual `QueryService`, production handler, persistent SQLite project workers, a64js and iced-x86 adapters. No analyzed input is launched by the harness. They report JSON Lines, input hashes, options, budgets, component versions, states, diagnostics and process-scoped memory. A zero harness exit means requested scenarios were recorded and assertions passed; it does **not** mean every large image was fully analyzed.

- **Cold import** means a fresh project/worker, not cold filesystem caches. Input hashing already reads the file.
- Pipeline tables are one observed run per profile. Cache figures are medians of three identical requests after computation, with the same published artifact identity verified.
- Stage boundaries come from trusted runtime hooks and existing progress callbacks. Compound stages include the work named in the row; handler total overlaps its constituent stages. Host latency also includes owner startup, reply construction, validation, scheduling and transport. Do not infer exact IPC cost by subtraction.
- Sustained measurements use 100 batches. Median averages the two middle samples for even counts; p95 is nearest-rank. Explicit parent GC is outside elapsed work; children use natural GC.
- `rss` and heap/external/ArrayBuffer values are boundary samples. Only supported `process.resourceUsage().maxRSS` is a process-lifetime high-water. Categories overlap and must not be summed; separate process maxima are not simultaneous process-tree peak memory. Missing telemetry is not zero.

## Reproduction

Use Node 24.22.0 as the runtime and Bun 1.4.3 for the pinned `bun.lock` dependencies from a source checkout. These current reproduction commands do not recast the historical measurements below as Bun-era runs:

```sh
bun install --frozen-lockfile
bun run check
node --import tsx scripts/bench/fetch-inputs.ts
node dist/scripts/bench/pipeline.js --fixtures fixtures/bin --large-macho .local/benchmark-inputs/sqlite-3.54.0/macos-arm64/sqlite3 --large-pe .local/benchmark-inputs/sqlite-3.54.0/windows-x64/sqlite3.exe --large-instructions 50000
node --expose-gc dist/scripts/bench/resources.js --fixtures fixtures/bin --iterations 100
node dist/scripts/release-acceptance.js
```

The input helper downloads only the reviewed, fixed SQLite archives in `scripts/bench/inputs.json`, checks archive size/SHA3/SHA256 before extraction and binary size/SHA256/ISA afterward, and never executes them. Both cached validation and a fresh download/extraction were exercised on macOS. It requires `unzip` on macOS or inbox `tar.exe` on Windows; the Windows preparation branch is not yet exercised. These downloads are benchmark setup, not a remote-fetch feature in the analysis service. SQLite's [release](https://sqlite.org/releaselog/3_54_0.html), [downloads](https://sqlite.org/download.html) and [public-domain statement](https://sqlite.org/copyright.html) are upstream references; this is not independent clearance of every linked runtime component. Inputs are not bundled with the application.

Omit `--large-instructions 50000` to attempt the raised profile's one-million-instruction traversal. That can reach a real block limit rather than finish. `--iterations`, `--cache-iterations` and `--functions` control repetitions and bounded selection; the harness validates their finite ranges. Capture stdout as JSONL and keep stderr diagnostics separately.

| Budget       |   Default | Raised bounded profile | Raised full attempt |
| ------------ | --------: | ---------------------: | ------------------: |
| Instructions |    10,000 |                 50,000 |           1,000,000 |
| Blocks       |    10,000 |                100,000 |             100,000 |
| IR nodes     |   100,000 |             10,000,000 |          10,000,000 |
| Work units   | 1,000,000 |            100,000,000 |         100,000,000 |
| Deadline, ms |    30,000 |                300,000 |             300,000 |
| Output bytes | 1,048,576 |              1,048,576 |           1,048,576 |

The smaller instruction limit does not relax work/block limits or claim whole-image coverage. Published partial function ranges cannot later be extended silently by raising a decompilation request's budget. Incomplete graphs fail without publishing an analysis artifact.

## Inputs

| Input                                |       Bytes | SHA256                                                             |
| ------------------------------------ | ----------: | ------------------------------------------------------------------ |
| Checked-in Mach-O ARM64 executable   |      52,368 | `82680f1eaabe35cd05149ae943022b4abd51eea715cc642d861de404c86c9adf` |
| Checked-in PE x86-64 DLL             |      13,312 | `ce6d13815457147570cd3975b1b2d8a2e9872b03a603bc0b7b32dc3f62ffecf3` |
| SQLite 3.54.0 macOS ARM64            |   2,069,752 | `8b694b0185a1d1130ccaeefa4e9969566788fb8460d478d21caee384327a9409` |
| SQLite 3.54.0 Windows x64            |   4,295,168 | `1d4dbbc37396c5de744e1a732540b8bc83cd89888f47e86365b726e5a813c5e7` |
| Node 24.22.0 macOS ARM64 limit probe | 122,503,472 | `b468fb9c67427c9d3aec07ee1105e63020923a631a9a2a00beb71a7ba3768bfd` |
| Node 24.22.0 Windows x64 limit probe |  93,882,184 | `ba93f9a70bd86fce3ebbb39ec758501458453467aa92a34a0a3602d1e3fc2b9c` |

Fixture manifest SHA256: `4cc7d85521038930efd31d44bb0cb3b1b6de1ce698b5fbb587375bafe4cc22d8`. The macOS Node probe reads the trusted host runtime's on-disk binary; it does not establish support for arbitrary Node applications or launch a separate analyzed program.

## Import and indexing

Run `4564be42-e5a7-485a-85d9-3af4c9d4fb9e`, after native code/data ownership and normalized-storage fixes. Times are milliseconds.

| Input / profile                | Host import | Read/hash/load/snapshot | Index preparation | Publication/acknowledgement | Observed result                                  |
| ------------------------------ | ----------: | ----------------------: | ----------------: | --------------------------: | ------------------------------------------------ |
| Small Mach-O / default         |      250.22 |                   10.56 |             15.28 |                       21.69 | Complete                                         |
| Small PE / default             |      252.13 |                    7.12 |             28.44 |                       18.04 | Complete                                         |
| SQLite Mach-O / default        |    1,626.12 |                   41.36 |            288.72 |                      864.68 | Partial indexes published                        |
| SQLite Mach-O / raised bounded |    3,206.89 |                   32.11 |            882.70 |                    1,875.17 | Partial indexes published                        |
| SQLite PE / default            |      495.02 |                   62.69 |                 — |                           — | Work limit; no ready image metadata              |
| SQLite PE / raised bounded     |    4,491.32 |                   60.41 |          1,099.71 |                    2,354.20 | Native metadata complete; function index partial |

A complete `project_open` result describes its requested image operation, not complete discovery or semantic recovery of every function. Inspect each index state and layer-specific coverage. Failed import preparation leaves the immutable byte snapshot and inspectable failed job, not a falsely ready image; the harness checks this after reopening.

Selection uses the real entry point plus bounded public `functions_find` queries, including `analysis: "complete"`, then favors complete discovered graphs of substantive size. It is not an exhaustive ranking. The Mach-O header symbol remains visible as native metadata but no longer becomes a function merely because its mapping executes.

## Per-function pipeline and caches

The selected examples are small arithmetic functions at Mach-O `0x100000574` / PE `0x180001030`, a real SQLite ARM64 body at `0x10000d9ac` under the default profile, and a real SQLite x86-64 body at `0x14000e180` under the raised bounded profile. The first three emitted results are complete; the SQLite x86-64 result is explicitly partial / `unsupported_subset`. Complete discovery is not complete instruction/ABI/type semantics.

| Stage, ms                                            | Small ARM64 | Small x86-64 | SQLite ARM64 | SQLite x86-64 |
| ---------------------------------------------------- | ----------: | -----------: | -----------: | ------------: |
| Scope/cache lookup                                   |        0.19 |         0.14 |         0.19 |          0.19 |
| Decode/CFG                                           |        0.80 |         0.60 |       125.93 |        632.36 |
| Lift/IR validation                                   |        0.39 |         0.63 |         1.92 |          1.31 |
| SSA/shared simplification/validation                 |        0.43 |         0.66 |         1.43 |          4.20 |
| Metadata/call preparation                            |        1.65 |         1.16 |        83.04 |        256.04 |
| Types/catalog/annotations                            |        4.46 |         2.24 |       116.62 |        383.24 |
| Structure/presentation setup                         |        0.04 |         0.03 |         0.77 |          0.55 |
| Emit/postprocess/cache publication/result validation |       16.12 |        13.59 |       245.79 |        780.55 |
| Handler total, overlapping above                     |       24.08 |        19.05 |       575.70 |      2,058.45 |
| Host uncached request                                |       27.46 |        21.16 |       579.23 |      2,065.94 |
| Host cached request, median of three                 |        9.47 |         7.90 |       239.75 |        774.03 |

The last emission-stage row is deliberately broad: it is not a measurement of text rendering alone. Large-input graph reconstruction still traverses the published image scope, and metadata/catalog/artifact processing remains substantial. The results do not justify switching languages or claiming a Rust-versus-JavaScript ratio.

Both small inputs computed three functions and served nine cache hits each. SQLite ARM64 computed two selected real bodies and served six cache hits in each profile; its true entry was instruction-truncated and correctly rejected. SQLite PE computed three selected bodies and served nine cache hits in the raised profile, retaining partial semantic coverage. These are selected-function results, not whole-program decompilation.

The largest individual worker lifetime RSS reported in this pipeline run was **1,649,098,752 bytes**; parent lifetime RSS was **150,175,744 bytes**. A small input file does not imply a small analysis heap. These are separate lifetime maxima, not a combined concurrent peak or a hard RAM ceiling.

## Sustained decoding, workers and serialization

Run `1e23af03-5632-43d3-abe9-7f90b7825134`: 100 batches per ISA, 32 real decode/format requests per batch, no failures.

| Adapter  | Requests | Decoded instructions, with repetition | Median batch, ms | p95 batch, ms |
| -------- | -------: | ------------------------------------: | ---------------: | ------------: |
| a64js    |    3,200 |                             1,126,400 |            34.85 |         40.56 |
| iced-x86 |    3,200 |                             2,588,800 |            85.19 |         86.43 |

These workloads differ in instruction counts and content; the table is not a decoder-versus-decoder speed comparison.

| Parent retained heap, bytes | First post-GC | Last post-GC | Last 25 minimum | Last 25 maximum | External minimum | External maximum |
| --------------------------- | ------------: | -----------: | --------------: | --------------: | ---------------: | ---------------: |
| ARM64 workload              |    43,692,424 |   43,993,672 |      43,961,056 |      44,060,224 |        4,103,692 |        4,103,692 |
| x86-64 workload             |    44,946,016 |   44,848,896 |      44,827,256 |      44,881,104 |        5,414,412 |        5,416,460 |

Inputs and active adapters intentionally remain reachable during these samples. Retention stayed within the reported late-run ranges; this finite run is not proof of asymptotic leak freedom, and retained WASM/native allocator capacity is not by itself a leak.

The real pool owned two workers and rejected a third with `resource_limit`. Concurrent imports produced a running-notification peak of two, not a claim about simultaneous CPU execution. With queue capacity one, each three-request burst admitted two and rejected one. All admitted jobs completed. Sustained decompilation produced two computations and 198 cache hits, followed by actual close/reopen and disposal checks. Work, output and frame limits were exercised without successful artifact publication on the rejected paths. The resource harness removed its temporary projects.

| Real `binary_info` round trip | Samples | Payload bytes | Median, ms | p95, ms |
| ----------------------------- | ------: | ------------: | ---------: | ------: |
| ARM64 project                 |     100 |         1,706 |      0.969 |   1.235 |
| x86-64 project                |     100 |         2,124 |      0.968 |   1.205 |

Round trips include durable admission, SQLite/query work, validation, framing, scheduling and child telemetry. Separate serialization micro-measurements below use actual function-result payloads, 100 batches of 64 repetitions; values are median batch time divided by 64, in microseconds per operation. They exclude transport and schema validation and must not be subtracted from the round trips to claim exact IPC cost.

| Function-result payload | UTF-8 bytes | JSON stringify, µs | JSON parse, µs | Frame encode, µs | Frame decode, µs |
| ----------------------- | ----------: | -----------------: | -------------: | ---------------: | ---------------: |
| ARM64                   |      48,768 |              27.21 |          43.87 |            33.65 |            46.51 |
| x86-64                  |      79,263 |              42.04 |          66.55 |            52.47 |            70.22 |

The resource-run parent lifetime RSS was **351,272,960 bytes**, with final post-GC heap **46,540,344 bytes**. Largest individual child lifetime RSS was **301,400,064 bytes**. Child heap endpoints use natural GC and include imports, JIT, caches and durable job bookkeeping; boot-to-last differences are not isolated leak sizes.

## Limits found on larger inputs

These additional normalized-storage probes preceded the final Mach-O 1.0.3 ownership correction; they are retained observations, not same-revision speed comparisons. Full SQLite attempt run: `e037b515-bce4-4772-a926-975990be9a31`. Bounded Node attempt run: `004e8e8d-0f4a-424e-8170-fee323a38c7f`.

| Input / profile              | Host import, ms | Explicit limiting result                                      |
| ---------------------------- | --------------: | ------------------------------------------------------------- |
| SQLite ARM64 / raised full   |        2,919.54 | Blocks: 100,001 against 100,000                               |
| SQLite x86-64 / raised full  |        5,410.48 | Blocks: 100,005 against 100,000                               |
| Node ARM64 / default         |          247.75 | Native symbol count exceeds 100,000                           |
| Node ARM64 / raised bounded  |          248.47 | Same native symbol cap                                        |
| Node x86-64 / default        |          416.86 | Work: 1,000,001 against 1,000,000                             |
| Node x86-64 / raised bounded |        6,461.89 | Loaded-image metadata exceeds 64 MiB aggregate encoded budget |

No function success is claimed for the rejected Node imports. Raising a traversal budget is not a way around native parser/storage limits.

## Corrections driven by observations

- Real Node/SQLite PE unwind records exposed two compatibility errors: mapped non-code handler references were treated as malformed code, and reserved `UWOP_SET_FPREG` OpInfo bits were rejected. LLVM inspection and the native unwind contract supported the corrections; defined operands, frame requirements, ordering and record bounds remain checked.
- Repeated native-hint preparation and linear boundary scans exhausted work budgets. Per-image checked data indexes, indexed discovery ranges/seed lookups and one-instruction discovery requests removed that amplification without raising public traversal caps. Earlier SQLite ARM64 inspection reached 407,586 instructions and a genuine aggregate block cap; unique completed membership showed no duplicate-graph explanation for that limit.
- SQLite PE reached publication but failed because all metadata was one encoded record. Schema 4 stores bounded ordered facts atomically, retaining the 16 MiB individual-record cap and adding explicit 64 MiB aggregate / one-million-fact limits. Reopen, historical snapshots, malformed stored facts, rejected writes and migration rollback are exercised. These encoded-data limits are not RAM or total SQLite-file limits.
- A first apparent large ARM64 success was actually a header symbol interpreted as code. It is excluded from accepted function evidence. Native header ownership and section-membership rules now prevent that false seed; the benchmark uses existing public analysis-status filters to select genuine complete discovered bodies while retaining the true entry as an honest failure/success sample.
- Direct `sqlite3_incomplete` (299 instructions) failed default work at 1,000,001 because every candidate data address rescanned all image symbols, hints and relocations (~290k counted work). Data-address recovery now reuses a per-symbol-snapshot interval index and per-image hint/relocation pages, bounded by the 4,096-byte string window; 113,390 sampled SQLite/corpus addresses matched the previous recovery exactly. The source range fixpoint replays a block whose inherited constraints and read facts are unchanged instead of re-evaluating it, a successfully verified immutable IR object is not re-verified by later consumers, and identical local-validation outcomes are published once. Counted work (raised diagnose profile) fell from 2,743,242 to 2,375,403 for `sqlite3_incomplete`; at the default 1,000,000 work limit a fresh process now finishes it at 977,416.

Different failure points, coverage and selected functions make those earlier runs unsuitable for a numeric speedup claim. Performance changes must preserve semantics and provenance, not merely reduce elapsed time by skipping unsupported or unvisited code.

## Regression procedure and retained evidence

For a comparison, keep runtime/hardware, input hashes, budgets, selected function IDs/addresses, coverage states, instrumentation and GC policy identical. Use an otherwise idle host, multiple fresh-process iterations and the sustained workload; compare per-stage distributions and late-run retention, not one favorable sample. Investigate changed work/coverage or missing telemetry before interpreting timing. No exact millisecond CI threshold or language speed ratio is established here.

Raw JSONL is retained locally under `.local/performance/`, not shipped as application runtime data. Hashes identify these captured observations; another run naturally has different IDs/timings/hashes.

| Local evidence file                         | SHA256                                                             |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `macos-sqlite-bounded-50000-owned.jsonl`    | `50335b81928576f282ec77ddd2d3755eec5128332a6026d42c6caa95cc6cf1ff` |
| `macos-resources-100-owned.jsonl`           | `038f555aaa9b7734a5c68e0feb4209c44ab06748ddf71acbb735dd6f74f61348` |
| `macos-sqlite-full-normalized.jsonl`        | `56f8b894d665f0975761c1f1b0cbd2b0ccaeee7c8513dccd696abba0b737e3b3` |
| `macos-node-bounded-50000-normalized.jsonl` | `44ec106500c099a4d8de0d8551e37b54c9dafc6194589e82ef8c0373b269e81c` |
| `macos-release-current.jsonl`               | `2c9dd46c2cbaf56dcececb4e0dff2eb75dfcc9cea78df6504915f1397d2620d0` |

Windows source acceptance, representative performance, and clean installed-artifact verification remain separately recorded gates. QEMU TCG results, when available, will be labeled emulated-host observations rather than native Windows throughput or an SLA.

## Selected SQLite budget diagnosis (2026-10-17)

This count-only diagnosis used SQLite 3.54.0 Mach-O ARM64, SHA256 `4e01e37ea6fc2cfb008521558f999ac06cdbb4504e3eeb422c1a84b5ead57e56`. Production traversal and budgets were unchanged. Durable evidence: `scripts/bench/selected-work-baseline.json`; runnable instrumentation: `scripts/bench/selected-work.ts` and `selected-work-hooks.ts`. Concurrent host activity excludes performance conclusions.

| Image discovery profile                                 | Decoded instructions | Successor-edge visits | Ownership queue visits | Functions | CFG blocks |
| ------------------------------------------------------- | -------------------: | --------------------: | ---------------------: | --------: | ---------: |
| Ordinary 10,000-instruction ceiling                     |               10,000 |                10,190 |                 13,499 |     3,389 |      4,181 |
| Completed seeded traversal, raised observation ceilings |              287,720 |               317,051 |                319,301 |     3,521 |     79,496 |

Both profiles recorded zero shared/overlapping instruction ownership records. The ten originally selected bodies total only 251 instructions after traversal finishes. Ordinary import retained just three instructions for most selected wrappers and six for each string-comparison loop. The unchanged public QueryService/worker path returned text for two selected SQLite functions; the other eight failed in decode/discovery before lifting or callee summaries.

Separate causes:

- Import spreads its instruction ceiling across unrelated image roots and persists the resulting partial observed ranges.
- Each selected graph request repeats whole-image discovery. Neither measured result fits the 1,024-unit graph cache: 17,657 units at the ordinary ceiling; 367,216 after traversal finishes.
- Native summaries repeat that global work. `sqlite3_complete` performs two entire-image traversals for only 306 body-plus-callee instructions. `changes64`, `total_changes64`, `errcode` and `limit` each perform three traversals for their body and two required native targets.
- Raising a later query does not repair historically truncated discovery ranges, although it still pays for whole-image traversal. Finishing seeded discovery remains distinct from semantic coverage.

Recorded reproduction commands. The committed `scripts/bench/selected-contract.json` (the default `--contract`) selects the reviewed binaries and functions; `--inputs` (or `$OPEN_DECOMP_BENCH_INPUTS`) names a directory holding `corpus-arm64` and `sqlite3-arm64`, for example `inputs/` extracted from `$EVIDENCE/scripts/bench/quality-evidence/baseline-2026-10-17.tar.gz` (`--binary` defaults to `sqlite3-arm64`; the ten-function selection belongs to it):

```sh
node --import tsx scripts/bench/fetch-evidence.ts --from "$EVIDENCE_BACKUP" --only baseline-2026-10-17.tar.gz
mkdir -p .local/performance/selected-inputs
tar -xzf "${OPEN_DECOMP_EVIDENCE_DIR:-.local/evidence}/scripts/bench/quality-evidence/baseline-2026-10-17.tar.gz" -C .local/performance/selected-inputs inputs
INPUTS="$PWD/.local/performance/selected-inputs/inputs"
node --import tsx scripts/bench/selected-work.ts --mode public --inputs "$INPUTS"
node --import tsx scripts/bench/selected-work.ts --mode diagnose --inputs "$INPUTS"
node --import tsx scripts/bench/selected-work.ts --mode diagnose --inputs "$INPUTS" --import-instructions 1000000 --instructions 1000000
```

`public` uses ordinary defaults in a fresh isolated project. `diagnose` raises only non-instruction observation ceilings to 100,000 blocks, 10,000,000 IR nodes, 100,000,000 work and 300,000 ms; these are measurement settings, not a proposed repair. No analyzed input executes. The retained count record is historical evidence of the pre-repair implementation, not a promise that later instrumentation produces identical counts.

## Public-surface census (2026-10-17)

`scripts/bench/public-surface-census.ts` drives every contract function through the real MCP stdio server (spawned from source, server and tool defaults, default 100-item pages, cursors followed) and the ordinary `functions`/`decompile` CLI commands, both dialects, without supplied prototypes or raised limits:

```sh
node --import tsx scripts/bench/public-surface-census.ts --out "$CENSUS_OUT" --inputs "$INPUTS" [--contract PATH] [--binary corpus-arm64] [--function NAME] [--surface mcp|cli|both]
```

Per call it records tool, state, reason, delivery, cache, diagnostic codes/messages, coverage, wire bytes and wall time (diagnostic only) to `calls.jsonl`, and writes `summary.json`/`summary.md`. MCP covers import job, `functions_find`/`symbols_find`/`strings_find`/`binary_info` page sweeps, selected-function lookup, `function_get`/`xrefs_get`, first and cached `function_decompile` (artifact chunks read through the published `resource_link`/`next_uri` when delivery is artifact), the default queued job path, and a real server restart that must hit the persisted cache. Each result is classified from its actual fields: `failed`, `resource_limit` (reason `budget`, `details.kind=limit`, or a coverage reason naming a sub-budget), `missing_instructions` (decode coverage), `missing_graph` (lift/analysis coverage for unresolved control flow), `unresolved_semantics` (reason `unsupported_subset`, reconstruction coverage, source-interface diagnostics), `metadata_gap` (reason `incomplete_index`, image-wide discovery diagnostics) and `delivery_limit` (reason `output_limit`; the semantic class comes from the published artifact body). Mach-O C symbols carry a leading underscore: the CLI is first tried with the unprefixed contract name and then with the actual symbol; failure of the former is recorded as an anomaly.

Finding fixed: `functions_find`/`symbols_find` resolved annotation-assigned display names with one SQLite round trip per image function on every page, so a 10-item page of the 3,389-function SQLite image cost about 82 ms (about 35 ms after batching name lookup into one bounded annotation query per 1,000 functions). The default-page sweep of SQLite fell from 3.4 s to 1.9 s and the 339-page `limit: 10` sweep from 27 s to 12.7 s. Remaining per-page cost is decoding the image function records; paging semantics, cursors and delivery bounds are unchanged.

Result at commit `31364d7` (pipeline/11, ssa/5, reconstruction/25, emitters 24, navigation/2): all 26 contract functions × 2 dialects × {MCP, CLI} = 104 cells returned text under defaults with zero anomalies, including first, cached, restarted-server and queued-job paths. 44 cells (11 functions) are `complete`; every `partial` names its limitation (unresolved semantics, native-dependency work sub-budget, partial image index or output-limit artifact delivery). Unprefixed C names resolve on both binaries through the authoritative Mach-O symbol table. Wall times in the census are diagnostic only; normalized performance belongs to the P2.5 methodology.

Budget repair outcome (count-only diagnose, same contract): `fixture_check` 1,022,657 → 609,327 work after minimal dominance-based SSA (block parameters 4,617 → 347), single verification per IR, indexed data-address lookup and compact emission writing; `sqlite3_incomplete` fresh-process default run 1,000,001 (failed) → 977,416 before compaction. The remaining default-budget headroom of the largest SQLite request is dominated by native-dependency preparation (capped at half the remaining budget) and output-proportional rendering.

## Reviewed paired-decompiler harness

`scripts/bench/quality.py` retains the original 16 native-corpus and ten SQLite 3.54.0 Mach-O ARM64 selections. `quality-inputs.json` pins hashes, selected addresses, compiler/source/license provenance, tool versions, budgets, semantic states and matched raw-response/output artifacts. Source and independently inspected instructions remain the oracle; Ghidra is a comparator, not truth.

The durable baseline archive `$EVIDENCE/scripts/bench/quality-evidence/baseline-2026-10-17.tar.gz` contains 968 individually hashed files: reviewed binaries, fixture source/license/build records, matching SQLite source, Homebrew recipe/receipt/SBOM, disassembly/manual findings, original raw responses and matched C. It excludes dependency checkouts, virtualenvs, installed tools and project databases. Archive SHA256: `9716b960dcbc94b02a49552ef195d9b2b51d54ef08bf1347a7dd1009f5cd0269`. Preparation was exercised independently and validated all 968 files:

```sh
node --import tsx scripts/bench/fetch-evidence.ts --from "$EVIDENCE_BACKUP" --only baseline-2026-10-17.tar.gz
python3 scripts/bench/quality.py prepare --destination .local/performance/quality-reviewed
```

Use Python 3.12+, a built production CLI, Ghidra 12.1.4 with a working host-native decompiler, and the separately provisioned `xjoker/ghidra-mcp` bridge pinned to `73ea1c8eaa4bb364f7338f8180e623583bb1d340` (`uv sync --locked --python 3.13`). `quality-ghidra.py` bootstraps that unchanged upstream runtime on Python's main thread with headless AWT settings; target operations still use MCP. The baseline manifest records dependency/build hashes. The Homebrew bottle's fully expanded compiler invocation and precise clang version are unavailable; retained recipe flags are not a byte-reproducible source-build claim.

```sh
python3 scripts/bench/quality.py run \
  --inputs .local/performance/quality-reviewed \
  --output "$HOME/open-decomp-stage/smoke" \
  --ghidra-bridge .local/quality-bridge \
  --ghidra "$GHIDRA_HOME" \
  --java-home "$JAVA_HOME" \
  --input corpus-arm64 --function fixture_arithmetic --function fixture_direct \
  --cold-runs 1 --warm-runs 1
```

Outputs must use a new durable directory outside `/tmp`. The exercised Ghidra stack rejects dot-prefixed project paths, and the Ghidra-recording commands (`quality.py run`, `quality-matrix.py run`, `quality-heldout.py run`, `quality-context.py`, `quality-persistent.py`, `investigation.py`) enforce this on the resolved `--output`, so they cannot write beneath `.local/`. Record such runs into a non-hidden staging directory such as `$HOME/open-decomp-stage/<name>`, then `mv "$HOME/open-decomp-stage/<name>" .local/quality-rounds/<round>/<name>` and `rmdir "$HOME/open-decomp-stage"` once it is empty; every other step (input builds, angr, oracle, evaluation, packets, reviews) writes directly under `.local/quality-rounds/<round>/`. Omitting selection/repetition flags records all 26 functions, three fresh projects per input/tool and ten repeated calls per function. `--profile default` and `--profile raised` remain separate populations. Requests are serialized under `.local/performance/quality.measurement.lock`; coordinate host use before making performance claims.

Both tools use the same Python stdlib newline-JSON-RPC client, identical binary/symbol/address access and no injected source/types/annotations. The harness records raw requests/responses, schemas, tool/component identities, first/repeated samples, cache and semantic states, emitted artifacts and hashes. Large analysis artifacts are read across bounded resource pages and size/SHA256 checked. No analyzed binary executes. Client latency includes transport and raw logging; the selected bridge still creates a new `DecompInterface` per call, so these records are not persistent-interface engine-speed evidence.

The exercised two-function smoke exited zero with eight matched C outputs, successful closes and both servers exiting zero. Arithmetic was complete, computed then cached; direct-call output remained explicitly partial, and its 630,962-byte artifact was retrieved across two pages. This smoke used the existing compiled application, not concurrent reconstruction changes, and supports harness functionality only. Durable smoke archive SHA256: `06e31569fd853ae44104c6d616d2ee263807f9dd406c7f7cbf2240bf3ce90587`; exact invocation and 80 member hashes are in `quality-evidence/smoke-2026-10-17.json`. Full-matrix, held-out, semantic/readability and normalized performance results remain separate gates.

## Broader source-known paired matrix

`quality-matrix-build.py` builds 24 inputs: Mach-O ARM64, PE x86-64 and ELF x86-64; independently built Apple clang 21.0.0 and Homebrew LLVM clang 23.1.3; `-O0`/`-O2`; symbol-bearing/truly stripped. These compilers share Clang lineage. The twelve selected functions cover multi-exit loops, real switch jump tables, aliases, aggregates, callbacks, variadic/mixed FP and an unchanged zlib 1.3.1 Adler-32/CRC-32 checksum workload—not full compression-library coverage. Exact flags, source/licenses, tools, disassembly and addresses are retained. All builds succeeded; stripping removed selected static names while preserving paired text-section hashes.

Reviewed inputs: `$EVIDENCE/scripts/bench/quality-matrix-inputs.tar.gz`, SHA256 `96863c3783347be3fe75279401c3f4bd9808d29e9f16daed845f4cc96fe5e250`, with 118 member hashes in `quality-matrix-inputs.json`. The unmodified zlib archive is `$EVIDENCE/scripts/bench/quality-matrix-zlib-1.3.1.tar.gz`, SHA256 `9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23`; upstream notices are retained.

```sh
node --import tsx scripts/bench/fetch-evidence.ts --from "$EVIDENCE_BACKUP" --only quality-matrix-inputs.tar.gz
python3 scripts/bench/quality-matrix.py prepare --destination .local/performance/quality-matrix-reviewed
python3 scripts/bench/quality-matrix.py run \
  --inputs .local/performance/quality-matrix-reviewed \
  --output "$HOME/open-decomp-stage/matrix-results" \
  --entry dist/src/cli/entry.js \
  --bridge .local/quality-bridge \
  --ghidra "$GHIDRA_HOME" \
  --java-home "$JAVA_HOME"
```

Both tools receive identical binary bytes and compiler-grounded selected addresses, with no source, sidecars, types, prototypes, names or annotations injected. The same raw MCP client records every cell, including missing entries, failures, partial semantics and truncation; containing functions are not substituted for exact entries. No analyzed matrix target executes.

The full default recording completed 24 input cells, 48 input/tool cells and 288 matched function pairs. All closes succeeded and servers exited zero. The complete compiled tree remained unchanged across the run: index SHA256 `db33db3bb8593018c7fb01ad60cee9e0393fc0a3ee635ae0dfd23ef3eb46b33c`. This checkpoint emitted `reconstructed-c-10`, pipeline/6 and reconstruction/9; later changes are outside its evaluated scope.

**Text-return observations only—not correctness or usable-semantic-coverage scores:**

| Target, 96 function cells/tool | Open Decomp text | OD complete / partial | OD missing entry / work failure | Ghidra MCP text | Ghidra missing-function failure |
| ------------------------------ | ---------------: | --------------------: | ------------------------------: | --------------: | ------------------------------: |
| Mach-O ARM64                   |               92 |               32 / 60 |                           0 / 4 |              96 |                               0 |
| PE x86-64                      |               48 |               16 / 32 |                          46 / 2 |              20 |                              76 |
| ELF x86-64                     |               46 |                0 / 46 |                          46 / 4 |              74 |                              22 |
| Total                          |              186 |              48 / 138 |                         92 / 10 |             190 |                              98 |

All ten Open Decomp request errors were `adler32_z` work limits. Exact-address discovery gaps and all Ghidra selected-address-not-in-function errors remain present; these describe the pinned import/discovery/bridge configuration, not universal engine coverage. The harness verified 116 full Open Decomp artifacts by size/SHA256; no Ghidra text was truncated and no reconstruction-invariant rejection was reported. Ghidra semantic coverage is unavailable through the bridge.

Durable raw results: `$EVIDENCE/scripts/bench/quality-matrix-results-2026-10-17.tar.gz`, SHA256 `701d79f537170bf715dfde4dd13b088f8c1ada44b5dcd8fa83a7bd518b14dec2`; the tracked sibling JSON indexes 3,248 retained members, the invocation and evaluated checkpoint. Numbered requests/responses, live schemas, emitted C, complete artifacts and matched results are retained; project databases and duplicate streams are omitted. This completes broader recording, not the parity gate. Behavioral correctness, held-out review and normalized performance remain separate; concurrent source-only smokes exclude performance conclusions.

## Frozen published-suite equal-access evaluation (formerly "held-out")

The held-out source and five-function selection were frozen before inspecting decompiler output in `scripts/bench/quality-heldout-selection.json`: source SHA256 `4daef9d0963bfcc5dd5d4440bb8dbfaaa7ded76ab8350b86bb0c4413ee34753b`. No suite source or output was supplied to reconstruction workers during that run, and no production pass was tuned against it. The source, gold, results and review packets are now tracked in this repository, so the suite is a **frozen published suite**, not a held-out set: results on it after any future tuning must not be described as held-out. A new held-out set must live outside the repository, with only its hashes committed.

All 24 source-built cells succeeded: three supported targets × independently built Apple clang21/LLVM clang23 × O0/O2 × symbol-bearing/stripped. Selected symbols were removed from stripped variants; paired text-section hashes matched. Both tools received identical binaries and compiler-derived selected addresses, without source/debug sidecars, prototypes or annotations. No analyzed image executed.

The recording exited zero: 48 tool/input cells, 120 matched function pairs, 240 function/tool cells; every project close and server exit succeeded. All 6,222 compiled `dist/` files remained unchanged at index digest `db33db3bb8593018c7fb01ad60cee9e0393fc0a3ee635ae0dfd23ef3eb46b33c`, the broader-matrix checkpoint. Later source/build changes are outside this evaluation.

| Target / selected cells per tool | Open Decomp text | OD complete / partial | OD undiscovered | Ghidra MCP text | Ghidra missing-function failures |
| -------------------------------- | ---------------: | --------------------: | --------------: | --------------: | -------------------------------: |
| Mach-O ARM64 / 40                |               40 |               28 / 12 |               0 |              40 |                                0 |
| PE x86-64 / 40                   |               20 |                14 / 6 |              20 |               0 |                               40 |
| ELF x86-64 / 40                  |               20 |                0 / 20 |              20 |              30 |                               10 |
| Total / 120                      |               80 |               42 / 38 |              40 |              70 |                               50 |

These are text-availability observations, not correctness, usable-coverage or readability scores. Ghidra exposes no semantic-coverage state through this bridge. Its failures identify selected addresses outside discovered functions in this pinned import/discovery/MCP configuration, not universal engine limitations. Every missing/unsupported cell remains recorded; no budget retry or performance claim is made.

```sh
python3 scripts/bench/quality-heldout.py build \
  --output .local/quality-rounds/heldout-new-inputs
python3 scripts/bench/quality-heldout.py run \
  --inputs .local/quality-rounds/heldout-new-inputs \
  --output "$HOME/open-decomp-stage/heldout-new-results" \
  --entry dist/src/cli/entry.js \
  --bridge .local/quality-bridge \
  --ghidra "$GHIDRA_HOME" \
  --java-home "$JAVA_HOME"
```

Use the pinned bridge setup and a new durable output directory (stage Ghidra-recording runs outside `.local/` and move them under `.local/quality-rounds/` as described above); the shared measurement lock rejects overlapping harness runs. Commands, tool identities, raw requests/responses, full artifacts, source text and failures are retained in the external store (fetch using the command above); JSON indexes remain under `scripts/bench/`:

- `$EVIDENCE/scripts/bench/quality-heldout-inputs-2026-10-17.tar.gz`: 119,901 bytes; SHA256 `e6acbf080ee0b6203e99aa2ecec2aea4d475fa635fc7666737fcdb41ecf4d362`.
- `$EVIDENCE/scripts/bench/quality-heldout-results-2026-10-17.tar.gz`: 45,648,755 bytes; SHA256 `5f1f3f063a3298b89b1ce6b5e97280119d8f8dd2693aca6ca8cf52d79cbe5872`.
- `quality-heldout-results-2026-10-17.json`: scope, checkpoint, invocation, observations and member hashes.

Intermediate objects, project databases and duplicate streams are omitted; complete run objects remain in `comparison.json`. The uncompressed inputs are extracted from the inputs archive into `.local/quality-heldout-inputs-2026-10-17/`; the uncompressed results originals were removed with the earlier `~/Documents/open-decomp-*` roots. Independent source gold, actual executable-output subset checks and blind readability reviews are separate lanes. This recording does not establish the parity gate.

## Prospective rerun of all frozen cells (2026-10-17, commit `901602b`)

Executed `scripts/bench/quality-prospective-plan.json` phases 1–5 unchanged (all nine harness/oracle hashes matched; both input archives byte-identical to their roots). All 6,381 compiled `dist/` files kept aggregate digest `dd0ea2635b5fea63933ec3d58da52e4efbdd6a7b60b9cc6769014fa89dfc2e4d` at every snapshot. Output root: `~/Documents/open-decomp-quality-prospective-2026-10-17/` (`records/summary.json`). The held-out lane is a **frozen published suite**: its source, gold and historical results are tracked in this repository, so it no longer supports a fresh held-out claim.

| Lane                                                            | Open Decomp now                                                                                  | Open Decomp historical | Ghidra now           | Ghidra historical   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------- | -------------------- | ------------------- |
| Broader availability (576 tool-cells, 288 pairs)                | 194 texts: 44 complete / 150 partial; 2 work-limit errors (`adler32_z`, PE O0)                   | 186: 48 / 138          | 190 texts            | 190                 |
| Frozen published-suite availability (240 tool-cells, 120 pairs) | 80 texts: 36 complete / 44 partial; 40 undiscovered                                              | 80: 42 / 38; 40        | 70 texts, 50 missing | 70 / 50             |
| Source gold (4 builds × 184 cases)                              | 736/736 (oracle self-check, not engine correctness)                                              | 736/736                | —                    | —                   |
| Exact unchanged-output executable subset (120 cells)            | **0 cells** (no text 40, does not compile 42, interface arity differs 34, machine-entry input 4) | 4 cells, 156/156       | 36 cells, 1346/1346  | 36 cells, 1346/1346 |
| Blind LLM readability (2 new reviewers, all 60 available pairs) | preferred in 0/120                                                                               | 0/120                  | preferred in 120/120 | 120/120             |

Mean blind ratings (0–4, 120 ratings per tool): algorithm comprehension 2.62 vs 3.78; control flow 1.79 vs 3.28; irrelevant machine-state clutter 0.63 vs 3.18; style 1.24 vs 2.72; types/interfaces 1.29 vs 2.73; unresolved semantics 2.54 vs 3.73 (Open Decomp vs Ghidra). The executable-subset regression is a presentation regression: the four previously plain-C cells now use renderer helpers (`field_view`, `stack_slot`, unaligned aliases) or recovered `type_N` names that the exact-text policy correctly refuses to repair. This run establishes neither the parity gate nor a performance result.

## Agent investigation blind task, run10 (2026-10-17, commit `901602b`)

Same five frozen questions, binary, gold and rubric as runs 1–9; workflow adds paged `source` quotations and the 14th investigation kind `helper`. SDK oracle 665/665, native SDK oracle 80/80 (ARM64 + PE x86-64) and the trusted source/instruction oracle passed. Two new blank reviewers (R7, R8) saw only the frozen bundle `investigation-evidence-2026-10-17/paired-run10/review/` (local evidence, not versioned). A = comparator, B = Open Decomp.

| Reviewer                                                         | Irrelevant bytes A / B | Relevant A / B | Manual-repair cases A / B | Preferences A / B / tie |
| ---------------------------------------------------------------- | ---------------------: | -------------: | ------------------------: | ----------------------: |
| run9 R5                                                          |              564 / 326 |   2257 / 10037 |                     3 / 5 |               2 / 2 / 1 |
| run9 R6                                                          |              175 / 120 |   2782 / 11259 |                     3 / 5 |               1 / 2 / 2 |
| run10 R7                                                         |             508 / 2826 |   2665 / 27247 |                     3 / 0 |               0 / 3 / 2 |
| run10 R8 (repair field normalized from prose; original retained) |             419 / 2784 |   2754 / 27775 |                     4 / 2 |               0 / 4 / 1 |

All 12 fact atoms and 9/10 uncertainty atoms present on every side (the tenth qualified everywhere, as in run9); no unsupported claims. **Gate FAIL**: B now needs less manual repair for both reviewers, but carries more irrelevant bytes (both reviewers marked the `stack_slot`/`unaligned_uint64_t` helper contracts, call-clobber placeholder locals and native prologue/epilogue in the caller/callback cases). Packets A 5,445 / B 33,500 bytes; full wire A 47,822 / B 510,506 bytes.

## Source view, frozen published suite rerun (2026-10-18, commit `16205c4`)

Same frozen published suite and harness as the 2026-10-17 prospective rerun; Open Decomp output is now the default proof-carrying `source` view (`--view checked` keeps the explicit machine form). `dist/` aggregate `a9d8af0f…` (6,399 files) unchanged before/after; gold hash `427f9357…` reproduced (736/736). Root: `~/Documents/open-decomp-quality-round2-2026-10-18/`. Two new blank reviewers, all 60 available pairs.

| Lane                     | 2026-10-17 (explicit view)         | 2026-10-18 (source view)                        | Ghidra              |
| ------------------------ | ---------------------------------- | ----------------------------------------------- | ------------------- |
| Availability (120 cells) | 80 texts, 36 complete / 44 partial | 80 texts, 36 / 44                               | 70 texts            |
| Exact executable subset  | 0 cells                            | 4 cells, 156/156 cases (arity mismatch 34 → 30) | 36 cells, 1346/1346 |
| Blind preference (120)   | Ghidra 120                         | Ghidra 116, tie 4                               | —                   |

Mean ratings Open Decomp vs Ghidra (0–4): algorithm comprehension 2.67 vs 3.78; control flow 2.00 vs 3.43; clutter 0.57 vs 2.82; style 1.22 vs 2.65; types/interfaces 1.44 vs 2.52; unresolved semantics 2.50 vs 3.43. Clutter evidence quoted by reviewers is now dominated by unpromoted O0 frame slots (`*(uint32_t *)(entry_sp - 56) = …`), `boundary("unknown_read_write", …)` markers, sub-register byte/word recombination (`value8 | ((uint32_t)(uint24_t)(value8 >> 8) << 8)`), x86-64 frame saves, and physical-return overlays in functions without an established primary result.

## Source view round 3, frozen published suite rerun (2026-10-18, commit `2e97d92`)

Same suite, harness and method; root `~/Documents/open-decomp-quality-round3-2026-10-18/`; `dist/` aggregate `fc4f422b…` (6,402 files) unchanged before/after; gold `427f9357…` reproduced (736/736). Two new blank reviewers, all 60 available pairs.

| Lane                     | Round 2 (`16205c4`) | Round 3 (`2e97d92`)                                                         | Ghidra              |
| ------------------------ | ------------------- | --------------------------------------------------------------------------- | ------------------- |
| Availability (120 cells) | 80 texts, 36 / 44   | 80 texts, 36 / 44                                                           | 70 texts            |
| Exact executable subset  | 4 cells, 156/156    | **26 cells, 978/978** (no text 40, no compile 44, arity 6, machine-entry 4) | 36 cells, 1346/1346 |
| Blind preference (120)   | Ghidra 116, tie 4   | Ghidra 116, Open Decomp 4 (all ELF x86-64 O2)                               | —                   |

Mean ratings Open Decomp vs Ghidra (0–4): algorithm comprehension 2.92 vs 3.77; control flow 2.16 vs 3.42; clutter **1.54** vs 2.98 (round 2: 0.57); style 1.78 vs 2.70; types/interfaces 1.89 vs 2.70; unresolved semantics 2.90 vs 3.50. Remaining low-score evidence: cross-loop `goto` labels, synthetic `type_N*` pointer types, `entry_sp` formals with residual frame slots, x86 `rdx`/MXCSR guard overlays and remaining `physical_return` tuples where no primary result is established.

## Source view round 4, frozen published suite rerun (2026-10-18, commit `9f4fe66`)

Same suite, inputs and gold (`427f9357…`, 736/736); all 70 Ghidra texts byte-identical to round 3; root `~/Documents/open-decomp-quality-round4-2026-10-18/` (`records/` holds commands, exit codes and comparisons). Evaluator fix (commit `1007153`): round-4 C begins with `static inline` helpers, and `quality-heldout-evaluate.py` used to bind the first definition. It now binds the target name (including the Mach-O `_name` form), else the unique non-`static` definition, else the first definition. Replaying round-3 inputs gave identical results (`records/neutrality-round3-replay.json`). As-is numbers are in `records/asis-first-definition-binding/`: 0 cells, 10 counterexamples, all caused by the binding. The 2026-10-17 prospective plan keeps its historical evaluator pin.

**Comparability caveat:** both reviewers are Claude models (A opus-worker, B sonnet-worker); rounds 2–3 used GPT reviewers. Reviewer B read only the first ~130 lines plus tail sections of the longest vectorized outputs.

| Lane                    | Round 3 (`2e97d92`)       | Round 4 (`9f4fe66`)                                                           | Ghidra              |
| ----------------------- | ------------------------- | ----------------------------------------------------------------------------- | ------------------- |
| Exact executable subset | 26 cells, 978/978         | **46 cells, 1706/1706** (no text 40, no compile 24, arity 6, machine-entry 4) | 36 cells, 1346/1346 |
| Blind preference (120)  | Ghidra 116, Open Decomp 4 | Ghidra 110, Open Decomp 10 (all `heldout_saturate` O2, Mach-O ARM64 + ELF)    | —                   |

Mean ratings Open Decomp vs Ghidra (0–4), round 3 in parentheses:

| Dimension            | Open Decomp     | Ghidra |
| -------------------- | --------------- | ------ |
| Algorithm            | 2.73 (2.92)     | 3.75   |
| Control flow         | **2.65** (2.16) | 3.27   |
| Clutter              | 1.35 (1.54)     | 3.00   |
| Style                | 1.77 (1.78)     | 2.81   |
| Types/interfaces     | 1.78 (1.89)     | 3.00   |
| Unresolved semantics | 3.07 (2.90)     | 3.86   |

Low-score evidence still remaining:

- unused `static inline` helper preludes;
- `uint64_t`-typed formals;
- loop indices split into `lo | hi << 32` halves;
- flag reconstruction (`fp_unordered`, `~(…) & 1`);
- `bit_pattern("ieee64_t", …)` for FP zero.

On x86-64 `heldout_weighted`, the source view projects `rax` (`uint32_t` loop index) as the result and labels `zmm0` as scratch. The `double` result and its multiply–accumulate chain then disappear from the readable text; they stay in exit metadata.

## angr as a third frozen-suite tool (2026-10-18)

**Tool.** angr **10.0.4.post1** (PyPI, latest stable on 2026-10-18) on CPython 3.13.16, macOS arm64, in the gitignored venv `.local/angr-venv/`. `scripts/bench/angr-requirements.txt` pins it and every dependency (`archinfo`/`cle`/`pyvex` 10.0.4, `capstone` 5.0.9, `pypcode` 4.0.1, `z3-solver` 5.1.0.0, …). The PyPI wheel set ships no unicorn library. angr logs that unicorn support is disabled; the lane never needs it.

**Method.** `scripts/bench/angr-decompile.py run` records every built cell of the frozen suite. Each selected function is decompiled in a fresh worker process with `PYTHONHASHSEED=0`, so no knowledge-base state carries over between functions. The worker runs:

1. `angr.Project(input, auto_load_libs=False)`;
2. `CFGFast(normalize=True)` (the normalization the Decompiler requires; every other argument is the angr default);
3. a lookup of the function whose entry is exactly the selected address;
4. `Decompiler(function, cfg=cfg.model)` with the default preset and default options. `comparison.json` → `tool_identity` records all option defaults (`structurer_cls` SAILR, `llm_refine` false, …).

angr's own default fallback is kept: after a decompiler error it retries once with its `basic` preset. Decompiler errors are recorded; the smoke run had none.

**Fairness.** angr gets the same binaries as the other two lanes, hash-checked against the build manifest. It is addressed like the Ghidra and Open Decomp lanes: every cell, symbol-bearing or stripped, uses the compiler-derived VA from `build-manifest.json` (`llvm-nm` on the unstripped link). In symbol-bearing cells angr's function name comes from the symbol table. angr gets no names, prototypes, types, debug data, source or tuning. The script never creates a SimulationManager and never executes or emulates the analyzed binary. CFGFast's default indirect-jump resolution does its own static block-level analysis. Every non-text result stays an unavailable cell (`function_not_discovered`, `no_text`, `tool_error`, `tool_timeout`, `build_failed`). Nothing is retried selectively. Wall times include a fresh process, load and CFGFast for each function, so they are not a performance comparison.

**Harness integration.** All changes are generic over tool names:

- `quality-heldout-evaluate.py run` accepts repeated `--results` and an optional `--tools`. Every tool goes through the same header, name binding, PE plain-`long` rule, unverified reasons, oracle and worker. The PE rule now rejects only bare `long` (32-bit under Windows LLP64, 64-bit on the host); `long long` is 64-bit on both and is no longer matched. This applies to every tool.
- `quality-heldout-packets.py` takes `--extra-results <dir>` and `--tools A B` (default `open-decomp ghidra`). With extra results, the sealed map also records their `comparison.json` hashes.
- `quality-heldout-review-results.py` takes `--tools A B`, which must equal the sealed pair. It adds `tools`, `preference_counts` (zero-filled) and `dimension_means` to `readability.json`.
- `quality-heldout-instructions.py` renders the round-4 reviewer instructions for any packet directory. Its output for round 4 is byte-identical to `review-instructions/reviewer-instructions.md`.

No angr types header was added. angr's scalar types are standard C, and `uint128_t` is already defined. A diagnostic recompile of all 38 failing angr texts with the real `__m128i`/`__m128d`/`__m128` vector typedefs compiled none of them: the failures are helper calls (VEX `arm64g_calculate_condition`, `CONCAT`, `__CFADD__`, `__ROL__`, `__double_as_longlong`, `_mm_*` intrinsics), undeclared variables, and pointer/integer mismatches. The policy repairs none of these.

**Neutrality on round 4** (`/tmp/od-angr-smoke/records/neutrality-round4.json`):

- **Evaluator** (both the generic change and the narrowed PE rule). Rerunning on round-4 `heldout/` gives the same summary (Open Decomp 46 passed / 74 unverified; Ghidra 36 / 84) and the same records apart from `library_sha256`. All 140 driver sources, all 140 `compile.json` files (after substituting the output root) and all worker logs are byte-identical; only `evaluator_sha256` and the non-reproducible dylib UUIDs differ. No round-4 Open Decomp or Ghidra PE text contains `long long`. The three-tool run gives the same Open Decomp/Ghidra records.
- **Packets.** With the sealed round-4 seed, 184 of 185 files are byte-identical, including `mapping.json`. `packet-manifest.json` differs only in its absolute directory fields.
- **Readability.** Re-aggregating the round-4 submissions reproduces `readability.json` byte for byte once the three added fields are removed.

**Smoke run.** All 120 cells, `/tmp/od-angr-smoke/`, round-4 Open Decomp/Ghidra texts. Two angr recordings produced identical text hashes.

| Lane (120 function cells)         | angr 10.0.4.post1                                                                                                               | Ghidra 12.1.4 (round 4)   | Open Decomp (round 4)                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------------------------------- |
| Text availability (Mach-O/PE/ELF) | **120** (40/40/40)                                                                                                              | 70 (40/0/30)              | 80 (40/20/20)                           |
| Exact executable subset           | **42 cells, 1542/1542** (Mach-O 14, ELF 14, PE 14)                                                                              | 36 cells, 1346/1346       | 46 cells, 1706/1706                     |
| Other angr outcomes               | 16 counterexamples (`heldout_roll`, 4/36 each), 4 execution timeouts (ELF O2 `heldout_runs`), 38 no compile, 20 PE plain-`long` | 34 no compile, 50 no text | 24 no compile, 40 no text, 10 interface |

The 16 `heldout_roll` counterexamples load `uint8_t` bytes as signed `char` and sign-extend them (for example, the all-`0xff` case). The 4 timeouts are emitted inner loops with no counter increment. Before the PE rule was narrowed to bare `long`, angr scored 36 cells, 1322/1322, with 32 PE plain-`long` rejections. Twelve of those 32 PE texts contained only `long long`: six now pass, four are `heldout_roll` counterexamples, and two use SSE intrinsics and do not compile.

Round-5 commands, with `R=<new round root under .local/quality-rounds/>` and `IN=.local/quality-heldout-inputs-2026-10-17`. The Ghidra-recording `quality-heldout.py run` cannot write beneath `.local/`: use `--output "$HOME/open-decomp-stage/heldout"`, then `mv` it to `"$R/heldout"` and `rmdir "$HOME/open-decomp-stage"` (see the staging procedure above):

```sh
python3 scripts/bench/quality-heldout-oracle.py --output "$R/gold"
python3 scripts/bench/quality-heldout.py run --inputs "$IN" --output "$R/heldout" --entry dist/src/cli/entry.js \
  --bridge "$BRIDGE" --ghidra "$GHIDRA_HOME" --java-home "$JAVA_HOME"
.local/angr-venv/bin/python scripts/bench/angr-decompile.py run --inputs "$IN" --output "$R/angr"
python3 scripts/bench/quality-heldout-evaluate.py run --results "$R/heldout" --results "$R/angr" --output "$R/correctness"
python3 scripts/bench/quality-heldout-packets.py --results "$R/heldout" --oracle "$R/gold" --output "$R/review"
python3 scripts/bench/quality-heldout-packets.py --results "$R/heldout" --extra-results "$R/angr" \
  --tools open-decomp angr --oracle "$R/gold" --output "$R/review-angr"
python3 scripts/bench/quality-heldout-instructions.py --packets "$R/review" --submissions "$R/submissions" \
  --output "$R/review-instructions/reviewer-instructions.md"
python3 scripts/bench/quality-heldout-instructions.py --packets "$R/review-angr" --submissions "$R/submissions-angr" \
  --output "$R/review-instructions-angr/reviewer-instructions.md"
# after both blind submissions per set exist:
python3 scripts/bench/quality-heldout-review-results.py --packets "$R/review" \
  --review-a "$R/submissions/review-A.json" --review-b "$R/submissions/review-B.json" --output "$R/readability"
python3 scripts/bench/quality-heldout-review-results.py --packets "$R/review-angr" --tools open-decomp angr \
  --review-a "$R/submissions-angr/review-A.json" --review-b "$R/submissions-angr/review-B.json" --output "$R/readability-angr"
```

Both packet sets show the same Open Decomp texts. Reviewers who have seen one set can recognize Open Decomp's style in the other, so each set should get its own fresh reviewers.

## Source view round 5, three-tool frozen-suite rerun (2026-10-18, commit `61aa5e9`)

Same suite, inputs and gold (`427f9357…`, 736/736). Root: `~/Documents/open-decomp-quality-round5-2026-10-18/`, with `records/` holding commands, exit codes, the `dist/` digest `604c4849…` (unchanged before/after) and the round-4 comparison. All 70 Ghidra texts and all 120 angr texts are byte-identical to round 4 and the angr smoke run. Every one of the 80 Open Decomp texts changed.

There are two blind packet sets, each reviewed by two fresh reviewers (A opus-worker, B sonnet-worker; nobody reviewed both sets):

- Open Decomp vs Ghidra: 60 pairs, unchanged procedure.
- Open Decomp vs angr: 80 pairs.

Reviewer B in both sets scored byte-identical repeated packets once and reused the scores; reviewer A read every packet.

| Lane                    | Open Decomp                                  | Ghidra                   | angr                                                                              |
| ----------------------- | -------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| Texts (120 cells)       | 80                                           | 70                       | 120                                                                               |
| Exact executable subset | 46 cells, 1706/1706 (unchanged from round 4) | 36 cells, 1346/1346      | 42 cells, 1542/1542 (16 counterexamples, 4 timeouts, 38 no compile, 20 PE `long`) |
| Blind preference vs OD  | —                                            | Ghidra 80, OD 29, tie 11 | angr 52, OD 72, tie 36                                                            |

Round 4's preference was Ghidra 110, OD 10.

Mean ratings (0–4):

| Dimension            | OD (Ghidra set) | Ghidra | OD round 4 | Ghidra round 4 | OD (angr set) | angr |
| -------------------- | --------------- | ------ | ---------- | -------------- | ------------- | ---- |
| Algorithm            | 2.89            | 3.45   | 2.73       | 3.75           | 3.34          | 3.12 |
| Control flow         | 2.82            | 3.26   | 2.65       | 3.27           | 3.12          | 2.77 |
| Clutter              | 1.98            | 2.95   | 1.35       | 3.00           | 2.12          | 2.38 |
| Style                | 2.08            | 2.72   | 1.77       | 2.81           | 2.39          | 2.40 |
| Types/interfaces     | **2.75**        | 2.32   | 1.78       | 3.00           | 2.66          | 2.73 |
| Unresolved semantics | 3.25            | 3.70   | 3.07       | 3.86           | 3.38          | 2.85 |

Ghidra's identical texts moved by up to 0.68 between rounds (types 3.00 → 2.32). Within-set gaps are therefore the meaningful comparison; absolute means across rounds are not.

Against Ghidra, OD now wins `heldout_runs` (19 of 24) and `heldout_saturate` (10 of 24, plus 10 ties). It loses `heldout_merge`, `heldout_roll` and `heldout_weighted` 24/24.

The x86-64 `heldout_weighted` source view now returns `double` with the multiply–accumulate chain visible. Residual text in that output:

- `uint64_t*` formals with `__od_bitcast_f64_u64` loads;
- `bit_pattern("ieee64_t", …)` zeros;
- one mixed `fp_add`;
- `(value1 | ((uint64_t)0 << 32))`;
- byte-offset `8 + (uintptr_t)arg1 + i * 8` accesses.

## Source view round 6, three-tool frozen-suite rerun (2026-10-18, commit `e1c8830`)

Root: `.local/quality-rounds/round6-2026-10-18/`. The earlier `~/Documents/open-decomp-*` roots were removed when artifacts moved to `.local/`; the run reconstructed what it needed (`records/round5-baseline-reconstruction.json`):

- **Inputs:** extracted from the hash-verified `.local/evidence/` archive.
- **Round-5 OD and Ghidra baseline:** rebuilt from commit `61aa5e9`. The rebuilt texts match the round-5 reviewers' recorded hashes.
- **Round-5 angr baseline:** `/tmp/od-angr-smoke`.
- **Unchanged tools:** Ghidra 70/70 and angr 120/120 texts are byte-identical to round 5.
- **Gold:** `427f9357…`, 736/736.

Four fresh reviewers took part (opus-worker A and sonnet-worker B per set). This round's instructions asked them to read every packet. They still reused scores for byte-identical repeated texts after confirming the match.

| Lane                    | Open Decomp                                          | Ghidra                   | angr                   |
| ----------------------- | ---------------------------------------------------- | ------------------------ | ---------------------- |
| Exact executable subset | **50 cells, 1850/1850** (round 5: 46; no compile 20) | 36 cells, 1346/1346      | 42 cells, 1542/1542    |
| Blind preference vs OD  | —                                                    | Ghidra 66, OD 36, tie 18 | angr 62, OD 82, tie 16 |

Round 5's preferences were Ghidra 80, OD 29, tie 11, and angr 52, OD 72, tie 36. The four newly passing cells are Mach-O ARM64 O2 `heldout_weighted`; no OD cell regressed.

| Dimension            | OD   | Ghidra | Gap r5 → r6   | OD (angr set) | angr |
| -------------------- | ---- | ------ | ------------- | ------------- | ---- |
| Algorithm            | 3.29 | 3.60   | 0.56 → 0.31   | 3.26          | 3.05 |
| Control flow         | 2.98 | 3.42   | 0.44 → 0.44   | 3.08          | 2.69 |
| Clutter              | 2.32 | 2.97   | 0.97 → 0.65   | 2.16          | 2.50 |
| Style                | 2.50 | 2.83   | 0.63 → 0.33   | 2.35          | 2.38 |
| Types/interfaces     | 3.12 | 2.47   | −0.43 → −0.65 | 2.73          | 2.42 |
| Unresolved semantics | 3.49 | 3.79   | 0.45 → 0.30   | 3.42          | 2.99 |

Results by function against Ghidra:

| Function   | OD wins | Ghidra wins | Ties |
| ---------- | ------: | ----------: | ---: |
| `runs`     |      16 |           4 |    4 |
| `saturate` |      16 |           8 |    0 |
| `merge`    |       4 |          16 |    4 |
| `roll`     |       0 |          16 |    8 |
| `weighted` |       0 |          22 |    2 |

The x86-64 `heldout_weighted` text is now a plain typed loop over `double*` with literals and `arg0[i + 1]`. What remains:

- `while (true) … break` instead of a `do`/`while`;
- NaN-exact `!(0.0 >= x)` instead of `0.0 < x`;
- one `fp_eq` helper;
- missing `const` on read-only FP pointers;
- generic `valueN` names.

## Source view round 7, three-tool frozen-suite rerun (2026-10-18, commit `21f4089`)

Root: `.local/quality-rounds/round7-2026-10-18/`. Same inputs, gold (`427f9357…`, 736/736) and harness hashes as round 6. The OD+Ghidra recording was staged in `~/open-decomp-stage/` and moved in. Ghidra 70/70 and angr 120/120 texts are byte-identical to round 6; 76 of 80 Open Decomp texts changed.

The changes in this round:

- frame-private locals promoted across more calls (`call_return_address`, `wide_slot_parts`, `fp_guard_frame`; flags are not argument storage);
- `do`/`while` and exit-copy loop forms (`loop_exit_copies`, `loop_test_restatement`);
- `shift_idiom` (masked rotates and sign-fill to plain shifts);
- `single_use_call_inlining`;
- FP copy propagation through identity bitcasts;
- `const` formals across open-arity calls;
- loop-role names.

On the 4-cell development matrix, the C outputs changed as follows:

| Matrix metric (C)               | Before | After |
| ------------------------------- | -----: | ----: |
| `while (true)` loops            |     54 |    33 |
| `bv_ror`/`bv_rol` uses          |     46 |     0 |
| outputs with raw `entry_sp - …` |     21 |    13 |
| `valueN` declarations           |    380 |   228 |
| files with `call_result`        |     74 |     6 |

| Lane                    | Open Decomp                                          | Ghidra                   | angr                   |
| ----------------------- | ---------------------------------------------------- | ------------------------ | ---------------------- |
| Exact executable subset | **54 cells, 1994/1994** (round 6: 50; no regression) | 36 cells, 1346/1346      | 42 cells, 1542/1542    |
| Blind preference vs OD  | —                                                    | Ghidra 57, OD 46, tie 17 | angr 45, OD 83, tie 32 |

Round 6 had Ghidra 66, OD 36, tie 18, and angr 62, OD 82, tie 16. The four newly passing cells are Mach-O ARM64 O0 `heldout_weighted`, which round 6 rejected for recovering four inputs.

Reviewers disagreed on 28 of 60 Ghidra-set pairs and 29 of 80 angr-set pairs.

| Dimension            | OD   | Ghidra | Gap r6 → r7   | OD (angr set) | angr |
| -------------------- | ---- | ------ | ------------- | ------------- | ---- |
| Algorithm            | 3.12 | 3.45   | 0.31 → 0.33   | 3.11          | 2.92 |
| Control flow         | 2.87 | 3.17   | 0.44 → 0.30   | 3.01          | 2.58 |
| Clutter              | 2.01 | 2.73   | 0.65 → 0.72   | 2.01          | 2.14 |
| Style                | 2.14 | 2.38   | 0.33 → 0.24   | 2.29          | 2.11 |
| Types/interfaces     | 3.02 | 1.97   | −0.65 → −1.05 | 2.81          | 2.51 |
| Unresolved semantics | 3.22 | 3.61   | 0.30 → 0.39   | 3.35          | 2.96 |

Results by function against Ghidra (round 6 in parentheses):

| Function   | OD wins | Ghidra wins |  Ties |
| ---------- | ------: | ----------: | ----: |
| `runs`     | 16 (16) |       2 (4) | 6 (4) |
| `saturate` | 15 (16) |       9 (8) | 0 (0) |
| `roll`     |  10 (0) |     12 (16) | 2 (8) |
| `weighted` |   5 (0) |     14 (22) | 5 (2) |
| `merge`    |   0 (4) |     20 (16) | 4 (4) |

One reviewer flagged a conditionally incremented change counter named `index` in O0 `saturate`. An audit of the 12-cell development matrix against source then found 294 wrong role names in the round-7 output, 278 of them `accumulator`. Commit `f690362` fixes this: a role prints only when it holds on every iteration and for every coalesced member, and copies and unrolled intermediates stay neutral. The same audit then finds 0 wrong names. The round-7 numbers above were measured before this fix.

Round 8 audited every parameter printed with a role name on the same 12 cells (C view, 280 decompiled functions): 62 `address` (pointer formals), 6 `callback` and 2 `count` (a `u32 count` formal), all correct against the source, 0 `index`/`remaining`/`limit`/`accumulator`. The audit found the hole that remained, reproduced on constructed IR: a parameter that is itself the loop variable (the loop begins at function entry) printed as `index` for any up-step and as `count` for any unit countdown, whatever the loop tested. A parameter now takes a loop role only as a unit countdown ending at zero (`count`), a loop bound is `count` only for a unit step from 0 that stops strictly below it (else `limit`), the initial-value exception of a coalesced variable never covers a parameter, and a parameter used as a bit position in `1 << n` is not a `shift_count`. Matrix output is byte-identical; a wider sample (148 sqlite3 and corpus functions) found one wrong name, `sqlite3_config`'s opcode printed as `shift_count`, now neutral.

## Development comparison loop

`scripts/bench/quality-dev-loop.py` compares the Open Decomp source view with the archived Ghidra 12.1.4 texts on the 24-cell, 12-function broader matrix (`.local/performance/quality-matrix-reviewed/`, up to 288 pairs) so a change can be measured in minutes instead of once per frozen-suite round. **This matrix is a development set, not held-out:** its source (`source/`, zlib 1.3.1 plus `quality-matrix-corpus.c`) is known and it has been inspected while tuning. Use it to steer work; claim nothing from it as independent evidence. The frozen suite above remains the reporting benchmark. No analyzed binary is executed.

```sh
# 1. Ghidra texts from the archived recording (hash-checks the archive and all 24 binaries; refuses on mismatch; no Ghidra re-run)
python3 scripts/bench/quality-dev-loop.py ghidra --output .local/quality-dev/ghidra
# 2. Open Decomp texts, C source view, default budget; any checkout's dist works (baseline: git archive HEAD | tar -x -C /tmp/snap, link node_modules, bun run build)
python3 scripts/bench/quality-dev-loop.py run --entry dist/src/cli/entry.js --label r8 [--jobs 4]
# 3. Blind packets: same --seed gives the same pairs across labels, stratified by function x O0/O2
python3 scripts/bench/quality-dev-loop.py packets --label r8 --sample 60 --seed 8 --output .local/quality-dev/review-r8
mv .local/quality-dev/review-r8/private .local/quality-dev/sealed-review-r8 && chmod 700 .local/quality-dev/sealed-review-r8
# 4. After the reviewers write submissions (schema in review-r8/instructions.md):
python3 scripts/bench/quality-dev-loop.py aggregate --packets .local/quality-dev/review-r8 \
  --mapping .local/quality-dev/sealed-review-r8 --review submissions/review-A.json [--review submissions/review-B.json]
# Cheap per-change check, no reviewers: static text counts side by side (only pairs with text in every run)
python3 scripts/bench/quality-dev-loop.py metrics --label base --label r9 [--json]
```

`run` writes `.local/quality-dev/runs/<label>/<cell>/<function>.c` and `summary.json` (status `complete`/`partial`/`failed`, exit code, seconds, failure diagnostics); each cell uses one throwaway cache under `/tmp`, deleted afterwards. `packets` reuses the frozen six-dimension 0–4 rubric and instruction wording, writes `case-NNN/{X.c,Y.c,question.json}` with a seeded random X/Y assignment, and keeps the mapping in `private/` for sealing; add `--require-label OTHER` to restrict a round to pairs that also have text in an earlier run. `aggregate` decodes preferences and dimension means per tool, function, O0/O2, target and symbol state into `aggregate.json` and `aggregate.md`.

`metrics` counts defect classes from the readability roadmap in each run's texts: `goto`, labels, `entry_sp` frame references, open `...` arities, casts to scalar/pointer types, helper preamble lines (`#define`/`static inline`), helper calls (`__od_*`, `bv_*`, `insert_bits`), `type_N` names and local declarations, plus lines and bytes/4 as an estimated token count, grouped by all/O0/O2/target. The counts are regex-based and only show whether a change moved a defect class; they are not a readability verdict.

## Source view round 8 (2026-10-19, commits `50c361b`, `41b9dee`)

Round 8 changes:

- jump-table `switch` recovery (`discovery/2`, `targets/2`, `structure/3`, lifters arm64 1.0.6 / x86 4);
- FP frame slots, FP-bank formals, and slot-chain FP results;
- `short_circuit_flag`;
- `copy_coalescing` and `local_load_reuse` (related values only);
- `incidental_result` and `indirect_result`;
- `scalar_array_pointee`;
- inline rotates and `loop_exit_merge`;
- x86 MXCSR guard parity in parameter discovery;
- parameter role checks;
- native bounded shifts, `strength_reduced_multiply`, and brace-less cases.

Measurement roots: `.local/quality-rounds/round8-2026-10-19/` and `.local/quality-heldout2/round8-2026-10-19/` (both at `50c361b`). The measurement runner was a sonnet-worker. Reviewers were A opus-worker and B sonnet-worker, fresh per packet set.

| Suite (reviewed pairs)          | Open Decomp vs Ghidra                           | Open Decomp vs angr                | Exact subset, OD / Ghidra / angr            |
| ------------------------------- | ----------------------------------------------- | ---------------------------------- | ------------------------------------------- |
| Frozen published suite (60/80)  | OD 92, Ghidra 27, tie 1                         | OD 107, angr 32, tie 21            | 54 / 36 / 42 cells (unchanged from round 7) |
| Second held-out suite (96/128)  | OD 44, Ghidra 138, tie 10                       | OD 84, angr 153, tie 13, neither 6 | 84 / 86 / 80 cells; OD 6 counterexamples    |
| Development loop (60, 1 review) | OD 25, Ghidra 23, tie 12 (round 7: 18 / 38 / 4) | —                                  | —                                           |

**The frozen-suite win does not generalise.** Rounds 4–8 used reviewer comments on the five frozen functions to choose work. On eight unseen functions, Ghidra and even angr are preferred over Open Decomp on every dimension except unresolved semantics. The frozen suite now measures fit to those functions, not decompiler quality. Claims must come from the second held-out suite, or from a newer sealed set.

Category-level reasons in the second-suite reviews were:

- helper-macro preambles and helper calls (bit-insert, divide-trap, 128-bit);
- goto labels;
- integer addresses with casts instead of pointers;
- extra temporaries;
- frame and unknown-register plumbing;
- one wrong `shift_count` name.

**Correctness:** Open Decomp's source view was wrong for `h2_level` in six x86-64 cells. FP argument registers were declared as integers, an O0 FP result was returned through the integer register, and Win64 stack doubles were typed as integers. Round 7 had the same defect. Commit `41b9dee` fixes it (all 24 cells pass 58/58 in a re-evaluation). That triage read `h2_level`'s source and outputs, so `h2_level` is no longer blind for correctness. The other seven functions were not read.

## Readability roadmap round (2026-10-20, dev loop, not held out)

Scope: readability roadmap items R1–R5 (archived: `git show 7301f55:TODO.md`; per-slot stack promotion, region-collapse structuring, expression rule pool, pointer and type inference, opt-in `likely` inference). **Everything below is development-set evidence.** The 24-cell matrix and the structure sample were inspected while tuning, no reviewer preference or Ghidra/angr comparison was collected this round, and the sealed third suite (see "Third held-out suite (sealed)") had not been measured when this round was written (it was measured afterwards: "Third held-out suite: round 1"). The static counts are regex-based (see "Development comparison loop") and show whether a defect class moved, not whether text became more readable. The LLM task benchmark was not re-run for this round (see round 1 of the third suite).

Builds: `base-de95fa4` (main before the round) and `int-112527d` (integrate, equal to main: R1–R5 rounds, including the R2 forward-label round, `structure/6`). Both are `quality-dev-loop.py run` outputs in default `proven` mode, C source view, default budget, 288 (cell, function) pairs. Table: `python3 scripts/bench/quality-dev-loop.py metrics --label base-de95fa4 --label int-112527d` (only pairs with text in both).

| metric (200 texts: 100 O0 + 100 O2) | all before | all after | O0 before |  O0 after | O2 before |  O2 after |
| ----------------------------------- | ---------: | --------: | --------: | --------: | --------: | --------: |
| est. tokens (bytes / 4)             |     78,527 |    69,776 |    39,811 |    35,437 |    38,716 |    34,339 |
| lines                               |      8,605 |     8,295 |     4,148 |     3,868 |     4,457 |     4,427 |
| casts to scalar/pointer types       |      3,077 |     1,901 |     1,746 |     1,318 |     1,331 |       583 |
| helper preamble lines               |        104 |        34 |        64 |        14 |        40 |        20 |
| helper calls                        |        144 |        30 |       112 |        14 |        32 |        16 |
| `entry_sp` frame references         |        617 |       329 |       468 |       208 |       149 |       121 |
| local declarations                  |      1,357 |     1,323 |       592 |       550 |       765 |       773 |
| open `...` arities                  |        132 |       132 |        68 |        68 |        64 |        64 |
| `goto` / labels / `type_N` names    |  0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |

Reading it, including what did not move:

- Tokens −11.1 % (O0 −11.0 %, O2 −11.3 %), casts −38 % (O2 −56 %), helper preamble lines −67 % and helper calls −79 % (O0 112 → 14), `entry_sp` −47 % (O0 468 → 208, O2 149 → 121). Per-item steps (R1 `entry_sp` 617 → 329 and casts 3,077 → 2,757; R3 helpers 48 → 34 / 46 → 30 on its own baseline; R4 casts) are in the R1/R3/R4 notes of `git show 7301f55:TODO.md`.
- Open arities are unchanged (132) in the default mode (no `proven` rule closed an additional one). `--inference likely` closes 12 of them (132 → 120) in this set; see "Likely-inference precision", which also records that its markers and legend cost more tokens than they remove here (78,527 → 78,579).
- Local declarations fell only 2.5 % (1,357 → 1,323) and rose in O2 (765 → 773) and PE (307 → 323). Dev-loop `goto` is 0 before and after (no printed goto on this set), so this set cannot show the structuring work; the sample below does.
- The R2 forward-label round (`int-717fa5d` → `r2c-65fa781` labels) added lines on this set, 8,227 → 8,299, and est. tokens 69,703 → 69,733 with no goto anywhere; the cause was not investigated.
- Remaining `entry_sp` is escaped objects below optimized frames' scalars (SQLite `renameColumnFunc`, brotli `main`: R1 gained nothing there, no fact bounds an escaped object's extent), O0 possible open-call argument storage never read back, incoming/aggregate stack bytes and the SysV `va_list` save area (R1 in `git show 7301f55:TODO.md`).
- Run status is identical in both builds: 54 complete, 146 partial, 88 failed. All 88 are the eight stripped ELF/PE cells (11 functions each): the O0 cells fail with `No function matches the selector` and the O2 cells with `Function search is incomplete; uniqueness or absence cannot be established` (exit 2, no text). These selector/discovery failures predate the round and are unchanged; the dev loop never measures stripped ELF/PE output.

Structuring sample (`scripts/bench/structure-gotos.py`, `open-decomp export` c-like source view; brotli 1.2.0 CLI, SQLite 3.54.0 `btree`/`vdbemem`/`exprcode` name filters, Mach-O and ELF fixture libraries; 214 functions printed by every build compared here, 213 for the `structure/4` build, whose `sqlite3ExprCodeTarget` output is not source text; analyzed binaries are never executed). Counts are printed text, never a readability verdict.

| build                                       | printed gotos | backward gotos | `for` loops | loops with a test |
| ------------------------------------------- | ------------: | -------------: | ----------: | ----------------: |
| pre-R2 (SCC / unique-entry structurer)      |           214 |              0 |           3 |                41 |
| `structure/4` (first region-collapse round) | 189 (213 fns) |              — |           0 |      49 (213 fns) |
| `structure/5` (`717fa5d`)                   |           193 |             54 |           3 |                52 |
| `structure/6` (`112527d`, forward labels)   |           200 |              2 |           3 |                52 |

Gotos on the 213 functions every build prints: pre-R2 196, `structure/4` 189, `structure/5` 178 (`structure/6` was only measured against `structure/5` on 214). The `for` loops disappeared at `structure/4` (a body ending in an omitted FP-guard block, and a branch sequencing its exit path after itself, hid the bottom test) and returned at `structure/5`.

Losses. The total did drop against pre-R2 (214 → 200) but not per function, and `structure/6` is 7 above `structure/5` in total (193 → 200) because forward-only labels trade backward jumps for more labels:

- Against pre-R2, `structure/5` printed more gotos in `sqlite3BtreeInsert` (7 → 16), `ParseBase64` (2 → 5), `sqlite3BtreeTripAllCursors` (1 → 3), `sqlite3BtreeOpen` (31 → 32), `sqlite3ExprCodeExprList` (5 → 6), `sqlite3ExprCodeGeneratedColumn` (0 → 1) and `sqlite3VdbeMemStringify` (2 → 3); it printed fewer in `allocateBtreePage` (34 → 18), `btreeBeginTrans` (41 → 36), `CloseFiles` (3 → 0), `sqlite3ExprCodeTarget` (18 → 15) and others (pre-R2 and `structure/5` outputs re-counted with `structure-gotos.py metrics`).
- `structure/6` against `structure/5`: `whereLoopAddBtree` 14 → 26, `allocateBtreePage` 18 → 24 and `CloseFiles` 0 → 2 got worse; `btreeBeginTrans` 36 → 32, `sqlite3BtreeInsert` 16 → 14, `sqlite3ExprCodeTarget` 15 → 13 and `ParseBase64` 5 → 3 got better. Both remaining backward gotos jump to a loop header from inside an irreducible or nested loop. Complete per-function lists and the rejected variants are in R2 of `git show 7301f55:TODO.md` and in docs/CORE.md.
- The source-view repairs still earn their keep: on `structure/6`, removing breakable blocks (`do { } while (0)`) would raise gotos 200 → 333 and removing return-tail copies 200 → 362; forced goto-path tail copies changed nothing (200 → 200) and were deleted.
- What remains (`structure/5` sample, 178 gotos): 156 acyclic within one loop scope (mostly SQLite's own `goto` error paths and joins entered from arms of different branches), 21 loop exits to a non-follow target, 1 multi-level continue, 1 entry into a loop at its header. A fourth round (`wt/r2d`, reaching-condition guarded regions) reduced the `structure/6` total only 200 → 195 at a large model and validator cost and is unmerged; see R2 in `git show 7301f55:TODO.md`. The follow-up roadmap (TODO.md) is based on a paired Ghidra 12.1.4 run on this sample instead: Ghidra prints more gotos (405 vs 372) but no breakable blocks, far fewer `break`/`while (true)`, and `else if`, comma conditions and `for` loops we lack.
- Property tests cover 300 random reducible programs without labels and 300 random acyclic graphs with every labeled transfer forward (`test/presentation/structuring.test.ts`); they are not a measure of readability.

Related per-item evidence recorded elsewhere in this document: likely-mode precision and the R5 type heuristics ("Likely-inference precision", including the dev-loop `r5-likely-c` comparison and byte-identical `proven` output), cache and latency work ("Persistent analysis cache" and "Per-function latency and cross-request callee reuse"), and the LLM task protocol ("LLM task success per token").

## Readability roadmap 2 baseline: Ghidra lane in the structure sample (2026-10-21, roadmap item M1)

The structure sample (`scripts/bench/structure-gotos.py`) now has a Ghidra lane and a paired metrics table. `ghidra` runs `analyzeHeadless` (Ghidra 12.1.4, default decompiler options after auto-analysis) on the sample binaries and decompiles the functions listed in an Open Decomp export's `index.tsv` (or `SAMPLE.list` files) by symbol name, because Ghidra rebases the ELF image; the SQLite filters share one analysis. Ghidra only loads the binaries; nothing is executed. The Java script is `scripts/bench/ghidra-decompile-list.java` (the class `DecompileList` is copied under that name into a temporary script path at run time). Both lanes write `OUT/LABEL/SAMPLE/functions/NAME@ADDR.c`; `metrics --label NAME=DIR` reads any existing directory, also the flat layout `DIR/SAMPLE/*.c`.

```sh
# Open Decomp lane (as before), then the Ghidra lane on the same functions
python3 scripts/bench/structure-gotos.py run --entry dist/src/cli/entry.js --label head
GHIDRA_INSTALL_DIR=/path/to/ghidra_12.1.4_PUBLIC JAVA_HOME=/path/to/jdk \
  python3 scripts/bench/structure-gotos.py ghidra --label ghidra --from head
python3 scripts/bench/structure-gotos.py metrics --label head --ghidra ghidra
# the 2026-10-20 baseline outputs (local, gitignored): flag NAME=DIR takes existing directories
python3 scripts/bench/structure-gotos.py metrics \
  --label od=.local/ghidra-gap-2026-10-20/open-decomp --ghidra ghidra=.local/ghidra-gap-2026-10-20/ghidra
```

Smoke of the lane itself (not the 214-function run): 3 ELF fixture functions, 3 brotli functions and 2 + 2 SQLite functions (`allocateBtreePage`, `btreeBeginTrans`, `sqlite3VdbeMemCast`, `sqlite3VdbeMemClearAndResize`; 57 s including the SQLite auto-analysis) were decompiled with `--limit`; the ELF and brotli files are byte-identical to the 2026-10-20 raw outputs apart from the timing in the header comment.

Baseline of readability roadmap 2: Open Decomp at `c07c94f` (`open-decomp export`, C source view, `proven`, default budget) against Ghidra 12.1.4, the 2026-10-20 raw outputs. Open Decomp prints 214 functions, Ghidra 213 (it was not asked for `sqlite3ExprCodeTarget`, whose Open Decomp output is not source text), so each counter is shown over the 213 functions both print and, for Open Decomp, over all 214. The last column is the TODO.md baseline.

| counter                                                      | Open Decomp, 213 |    Ghidra, 213 | Open Decomp, 214 | TODO.md baseline (Open Decomp / Ghidra) |
| ------------------------------------------------------------ | ---------------: | -------------: | ---------------: | --------------------------------------- |
| `goto`                                                       |              372 |            405 |              385 | 372 / 405                               |
| functions with a `goto`                                      |               31 |             48 |               32 | 31 / 48                                 |
| `do { } while (0)`                                           |               95 |              0 |              100 | 95 / 0                                  |
| `break`                                                      |              284 |             23 |              298 | 284 / 23                                |
| `continue`                                                   |               12 |              0 |               12 | 12 / 0                                  |
| exit-flag variables (`loop_exit_N`)                          |               12 |              0 |               12 | 12 / 0                                  |
| jump statements (goto + break + continue + flags + run-once) |              775 |            428 |              807 | (sum of the rows above)                 |
| `while (true)`                                               |               47 |              8 |               48 | 47 / 8                                  |
| `for`                                                        |                3 |             12 |                3 | 3 / 12                                  |
| loops with a test (`while (c)`, `do { } while (c)`, `for`)   |               56 |             89 |               56 | —                                       |
| `else if`                                                    |                0 |             36 |                0 | 0 / 37                                  |
| comma conditions (comma operator in an `if` / `while` test)  |                0 |            120 |                0 | 0 / 33                                  |
| non-blank lines without comment lines                        |           16,546 |         11,316 |           17,146 | 16,614 / 11,377                         |
| bytes                                                        |          745,628 |        377,473 |          769,028 | 749 KB / 380 KB                         |
| bytes: preamble (before the signature)                       |   151,560 (20 %) |              0 |   154,324 (20 %) | 18 %                                    |
| bytes: `entry_sp` lines                                      |    86,202 (12 %) |              0 |    90,792 (12 %) | 11 %                                    |
| bytes: local declarations                                    |     56,602 (8 %) |   21,288 (6 %) |     58,749 (8 %) | 10 %                                    |
| bytes: comments                                              |     37,903 (5 %) |   24,603 (7 %) |     38,230 (5 %) | 6 %                                     |
| bytes: `unknown_*` / `requirement_predicate` / `physical_*`  |     14,487 (2 %) |              0 |     14,775 (2 %) | 2 %                                     |
| bytes: statements and control flow (other)                   |   398,874 (53 %) | 331,582 (88 %) |   412,158 (54 %) | 53 %                                    |
| local declarations                                           |            2,456 |          1,237 |            2,557 | 2,463 / 1,163                           |
| lines with `entry_sp`                                        |            1,309 |              0 |            1,370 | 1,370 (38 functions) / 0                |
| functions with `entry_sp`                                    |               37 |              0 |               38 | 38 / 0                                  |
| body lines containing `, ...)` (open calls)                  |              725 |              0 |              769 | 774 / 0                                 |
| 64-bit values rebuilt from two 32-bit cells                  |               11 |              0 |               11 | 11 / 0                                  |
| functions with such a reassembly                             |                6 |              0 |                6 | 6 / 0                                   |

The jump, loop and cell counters reproduce the TODO.md table exactly. The deviations are from how the first baseline script counted, not from the outputs:

- **Duplicate functions and function sets.** `sqlite3VdbeMemFromBtree` and `sqlite3VdbeMemFromBtreeZeroOffset` match both the `btree` and the `vdbemem` filter, so the export directories hold 216 files for 214 functions. `metrics` counts each function once (keyed by sample and name). The baseline script counted the files: the goto and loop counters are unaffected (the two functions print no goto), but the other totals are file totals. Recounted per file, the same outputs give 2,463 declarations, 16,618 lines and 749,773 bytes over the 215 files without `sqlite3ExprCodeTarget`, and 774 open-call lines and 1,370 `entry_sp` lines over all 216 files. `lines with entry_sp` and `functions with entry_sp` in the 214 column are deduplicated and equal the baseline.
- **Lines.** "Non-blank lines" here excludes comment lines (comments are one of the byte parts); that gives 16,546 deduplicated and 16,618 per file, against 16,614 in the baseline. Ghidra: 11,316 against 11,377, a 0.5 % difference whose exact rule is not recoverable.
- **Ghidra `else if` 36 against 37, local declarations 1,237 against 1,163, comma conditions 120 against 33.** The first baseline script is not retained. Comma conditions now count every `if` / `while` test holding a comma operator (a `(` group not opened by a call whose top level has a `,`), e.g. `(uVar2 = _saveCursorPosition(pbVar3), (int)uVar2 != 0)`; 48 of the 120 have an operand assigning a call result. Declarations count every `type name;` / `type name [n];` line after the function's opening brace (12 are arrays).
- **Byte parts.** A line goes to the first matching part in this order: comment line, preamble (before the signature: `#define`, `typedef`, `struct`, `extern` lines), `entry_sp`, uncertainty helpers, local declaration, other. The baseline shares were 18 / 11 / 10 / 6 / 2 / 53 %; this table gives 20 / 12 / 8 / 5 / 2 / 54 % on the same 214 functions, a definitional difference (for example every pre-signature line counts as preamble here).

Per-function deltas, Open Decomp minus Ghidra over the 213 common functions: jump statements +347 (larger in 37 functions, equal in 159, smaller in 17), lines +5,230, bytes +368,155. The largest jump-statement excesses: `brotli/main` 211 vs 115, `whereLoopAddBtreeIndex` 104 vs 42, `btreeBeginTrans` 71 vs 37, `whereLoopAddBtree` 55 vs 24, `sqlite3BtreeOpen` 60 vs 33, `sqlite3BtreeInsert` 34 vs 13, `allocateBtreePage` 39 vs 20. Functions where Ghidra prints more: `exprCodeInlineFunction` 0 vs 5, `btreeComputeFreeSpace` 0 vs 4, `sqlite3VdbeMemZeroTerminateIfAble` and `sqlite3VdbeMemSetText` 0 vs 3. G6 (dropping breakable blocks) is measured against these figures; the coordinator's benchmark reruns `run`, `ghidra` and `metrics` on the whole sample.

## Readability roadmap 2, G4 loop exits (2026-10-21, not held out)

`structure/7`, emitters 72. Subset of the structure sample: 28 functions (every baseline function with a `while (true)`, plus `sqlite3BtreeTripAllCursors`, `sqlite3ExprCodeIN`), fresh `decompile` per function, C source view, before = `63647e7`; `structure-gotos.py metrics` paired with the 2026-10-20 Ghidra lane on the 27 functions both print:

| metric            | before |  G4 | Ghidra |
| ----------------- | -----: | --: | -----: |
| `goto`            |    506 | 486 |    341 |
| `break`           |     73 |  69 |     20 |
| `continue`        |     13 |   8 |      0 |
| jump statements   |    594 | 565 |    361 |
| `while (true)`    |     47 |  43 |      8 |
| loops with a test |     27 |  31 |     61 |

- Per-function gotos: no increase in any of the 28 functions; `main` 188 → 177, `sqlite3BtreeIndexMoveto` 12 → 8, `whereLoopAddBtreeIndex` 70 → 68, `allocateBtreePage`, `sqlite3BtreeOpen`, `sqlite3BtreeTableMoveto` −1 each. Function states (partial reasons) are identical before and after in both dialects.
- `ParseInt` prints Ghidra's form: `do { … } while (index != 5);` followed by the post-loop test (before: `while (true)` with `continue`, three `break`s and a goto). `sqlite3BtreeIndexMoveto`: the outer loop whose only back edge was `goto label_104` is `do { … } while (value41 == address->field_0x55);`; the comparator choice keeps Ghidra's `if (…) { … } else { label_94: … }` (5 → 3 gotos, the three side exits).
- Rejected: ranking a single latch exit first, then the header exit, before the old key (Ghidra's order) raised gotos 506 → 534 on the subset (`whereLoopAddBtree` +7, `allocateBtreePage` +5, `sqlite3ExprCodeIN` +4, `sqlite3VdbeMemSetStr` +3): it absorbs post-loop code into the body when the latch exit is a small tail, and makes a follow that other exits also reach. The kept key counts those as labeled exits first and uses the bottom test only among equal costs.
- Not reached: the classified edge-select cases in `whereLoopAddBtree` (rows 78, 80, 93) still print their gotos (35 → 35); `sqlite3VdbeMemTranslate` keeps `while (true)` where the latch exit carries an exit copy (G1).
- Work (fresh `decompile`, 10k resolution, not the export numbers above): `whereLoopAddBtreeIndex` 9.65M → 9.65M, brotli `main` 8.01M → 8.05M.

## Readability roadmap 2, G7 frame object (2026-10-21, not held out)

Escaped frame memory prints as one local frame object instead of `entry_sp` arithmetic (TODO.md G7, second item; `reconstruction/62`, emitters 69). Fresh `decompile --no-analysis-cache`, C source view, default budget, base `18575c1` vs the change; counted work read from the operation context (temporary instrumentation, not committed).

- **Structure sample, the 38 functions that printed `entry_sp` in the baseline plus SQLite `renameColumnFunc`:** lines with `entry_sp` 1,470 → 26 (C); 37 of 39 functions print none (Python-like matched C function by function in the run before the last change, which only removed ELF `fixture_check`'s 51 lines). What remains is ELF `fixture_variadic` (24) and Mach-O `fixture_variadic` (2): both read their callers' variadic argument area at or above the entry SP, which is not frame memory. Over the 39 functions (run before that last change), non-blank lines 12,014 → 12,547 (+4.4 %: the struct declaration, one line per member and padding run) and bytes 514,112 → 511,140 (−0.6 %). Overlapping access sets (a wide zeroing store read back in halves) print as byte arrays with cast dereferences (`*(uint32_t *)&frame.local_250[4]`), as long as the `entry_sp` form; scalar members print `frame.local_270`, escaped addresses `&frame.local_210`.
- **Work (exact counts):** brotli `main` 9,606,593 → 9,527,542; SQLite `whereLoopAddBtreeIndex` 9,718,487 → 9,720,610 (+2,123; margin 279k). The member layout is computed once in the stack plan; member types read only each member's own accesses; the frame-access validation shares the existing statement scan.
- **Interfaces:** the six third-suite functions with the `entry_sp` interface mismatches (`h3_label`, `h3_rescale`, `h3_dispatch`, `h3_pack`, `h3_unescape`, `h3_pairsum`; symbol-bearing binaries of all 12 cells, seen suite) print `entry_sp` in 8 of 72 decompilations instead of 46 (lines 612 → 61). The remaining 8 are PE `h3_pairsum` (Win64 stack arguments 5 and 6 at `entry_sp + 40/48`) and PE `h3_unescape` (`entry_sp + 40`, a Win64 stack argument), both incoming arguments. Not re-scored with the third-suite evaluator.
- Semantic regressions (`test/reconstruction/frame-object.test.ts`): layout boundaries (exact set → scalar, overlap / interior address / indexed base → byte array, gap → padding, stack-aligned start for arm64 and x86 entry SPs) and an escaped, indexed, overlapping frame executed in both dialects on three ABIs, with the indexed store aliasing each member in turn.

## Readability roadmap 2, G7: preamble and open arity (2026-10-21, not held out)

TODO.md G7, first and third items. Same build before (`7301f55`+`18575c1`, emitters 68) and after (emitters 69); brotli 1.2.0 CLI and SQLite 3.54.0 sample binaries; `open-decomp export` (C source view, `proven`) for 14 functions: brotli `main`, `NextFile`, `OpenFiles`, `CloseFiles`, `PrintFileProcessingProgress`, `ParseBase64`, `CheckAlias`, `FileSize`; SQLite `sqlite3BtreeTripAllCursors`, `allocateBtreePage`, `exprCodeTargetAndOr`, `sqlite3VdbeMemNumerify`, `whereLoopAddBtree`, `whereLoopAddBtreeIndex`. Preamble = the lines between the header comment and the signature (includes, typedefs, struct bodies, externs, comments):

| function                                |   preamble before → after |      file bytes before → after |
| --------------------------------------- | ------------------------: | -----------------------------: |
| `main`                                  |             2,706 → 1,772 |                58,351 → 57,237 |
| `NextFile`                              |                 963 → 362 |                  4,683 → 4,082 |
| `OpenFiles`                             |                 658 → 370 |                  2,357 → 2,069 |
| `CloseFiles`                            |                 793 → 505 |                  4,284 → 3,996 |
| `PrintFileProcessingProgress`           |                 446 → 293 |                  1,732 → 1,569 |
| `ParseBase64`, `CheckAlias`, `FileSize` |  unchanged (37, 141, 178) |                      unchanged |
| `sqlite3BtreeTripAllCursors`            |                 993 → 210 |                  2,646 → 1,833 |
| `exprCodeTargetAndOr`                   |               1,975 → 193 |                  5,004 → 3,152 |
| `sqlite3VdbeMemNumerify`                |                  80 → 120 |                  8,851 → 8,416 |
| `allocateBtreePage`                     |                 113 → 219 |                22,620 → 20,211 |
| `whereLoopAddBtree`                     |                 141 → 407 |                30,698 → 26,536 |
| `whereLoopAddBtreeIndex`                |                 202 → 678 |                76,797 → 71,170 |
| **sum**                                 | **9,426 → 5,485 (−42 %)** | **222,116 → 204,364 (−8.0 %)** |

The four functions whose preamble grows had no declaration for their open callees (call-site interfaces that disagree were never declared) and printed `, ...)` at every call; the comment line now names them once and the file shrinks 4.9–13.6 %. Whole 70-function exports (64 brotli functions plus the six SQLite ones): preamble 16,129 → 10,977 bytes (−32 %), function files 252,030 → 233,057 bytes (−7.5 %), `types.h` 3,961 → 21,729 bytes (the structure declarations moved there): the structure bytes are relocated, not removed (net −0.5 %); what falls is what an LLM reads per function.

- **Open arity.** Call lines ending `, ...)` (excluding casts and prototypes) in the source-view texts of the 10 `decompile` functions, both dialects: 176 → 0. The checked view is byte-identical on all 20 texts (10 functions × 2 dialects). 36 `f(...)` calls keep the marker (no argument proven, or a library prototype with no proven argument such as `fprintf(...)`). Python-like grows 0.5 % (96,881 → 97,380 bytes over the 10 functions): it has no extern lines to drop, so the comment line is pure addition there; C-like shrinks 1.9 % (111,593 → 109,479).
- **Externs.** Only callees with an established prototype (library, debug, recovered source signature) are declared. The inferred `(T*, ...)` and closed `/* inferred */` externs repeated their call sites and are gone (about 20 KB of the 773 KB structure-sample output, 2.6 %).
- **Struct bodies.** The merged `types` pass is not a superset of what functions name: the SQLite `btree` export's `types.h` is 442 bytes and declares one structure while its 78 functions print 230 distinct ones (brotli's agrees with its functions). So `export` is the only surface that elides bodies: it asks for `options.structures: "external"`, the emission returns the `typedef`s and bodies in `emission.structures`, and `types.h` gets them after the merged types (one definition per name, other member sets in `#if 0` blocks with their functions, so the header stays valid C). `decompile` and MCP `function_decompile` keep them inline, since no complete image artifact accompanies a single function. Most names occur in one function (230 names, 259 bodies in the `btree` sample), so the bodies move to `types.h` rather than disappear.
- **Not measured here:** the LLM task benchmark (`scripts/bench/llm-tasks/`): `export-file` answers about member layout now need `types.h`, MCP and CLI text differs only in the open-arity spelling. The coordinator must check for new wrong/unknown answers.

## Readability roadmap 2, G2: structure with block contents, comma conditions (2026-10-21, not held out)

`structure/8`, emitters 76, against main `cd7be17` (`structure/7`, emitters 75). Subset: the 26 functions holding the 26 classified comma-condition constructs (`.local/ghidra-gap-2026-10-20/goto-classify-*.md`), fresh `decompile` per function (default budget), metrics by `structure-gotos.py metrics` paired with the Ghidra lane.

| 26 functions, C-like source view |   main |     G2 | Ghidra |
| -------------------------------- | -----: | -----: | -----: |
| `goto`                           |    209 |    182 |    175 |
| `break` / `continue`             | 25 / 3 | 26 / 3 |  9 / 0 |
| jump statements                  |    237 |    211 |    184 |
| comma conditions (regex)         |      0 |      4 |     56 |
| `else if`                        |      3 |      5 |      7 |

- Python-like: jump statements 254 → 232; 25 lines with a walrus condition (`(x := f()) != 0`), none before.
- No function prints more jump statements. Largest drops: `whereLoopAddBtree` 42 → 32 (joined exits: chains of `if (…) goto L;` print as one `||` test), `btreeBeginTrans` 52 → 49, `sqlite3BtreeTripAllCursors` 3 → 1 goto (acceptance: at most one), `sqlite3BtreeSetPageSize`, `sqlite3ExprCodeGeneratedColumn`, `sqlite3VdbeMemGrow` 2 fewer each, `sqlite3BtreeRollback` 3 → 2 (`if (value0 == 0 || (uint32_t)(arg1 = saveCursorsOnList(value0, 0, 0)) == 0) goto L;`, Ghidra's form).
- Share: the drop (26 jumps, 11 %) is about the comma-condition share of the classified constructs (26 of 180, 14 %). Not reached: void-call operands `(f(x), test)` (`sqlite3BtreeClose` #39, `sqlite3ExprCodeExprList` #83; C-only, Python-like cannot print them), operands whose call is inlined into the test, loop-condition comma tests (`sqlite3BtreeTableMoveto` #3), `sqlite3BtreeSavepoint` #19.
- Work (counted, `measure-main-work.sh` copy with the binary as argument): brotli `main` 8.90M → 9.20M, SQLite `whereLoopAddBtreeIndex` 9.00M → 9.40M (limit 10M, margins 0.80M / 0.60M). The second structuring costs 1.04M / 0.38M; the provisional first structuring (no goto search) saves 0.75M / 0.35M, but `recoverSourceEvidence` gives optional callee summaries half of the work remaining at that point (`source-facts.ts`), which takes back about 0.3M of the saving on `whereLoopAddBtreeIndex`. Both functions complete with the same diagnostics as main.
- Not measured here: the whole structure sample and the dev loop (coordinator).

## Normalized four-lane performance (2026-10-17, commit `901602b`)

Exclusive serialized slot (`.local/performance/quality.measurement.lock`), `dist/` aggregate `dd0ea263…` unchanged before/after, Node **v26.11.1** (not the historical 24.22.0 host), Ghidra 12.1.4, bridge `73ea1c8e…`. Protocol `scripts/bench/quality-persistent.py` unchanged: same MCP client for all four lanes (Open Decomp unobserved/observed, pinned Ghidra MCP bridge, persistent Ghidra `DecompInterface`), 11 equal requests in 156/156 matched cells, 3 fresh runs, 10 warm, 30 pings, balanced order. 1,716/1,716 observer/control pairs and 6/6 import controls equivalent. Raw evidence: `~/Documents/open-decomp-perf-2026-10-17-final/p25-normalized/comparison.json`.

| Input  | Lane              | Import (ms) | Up-front analysis (ms) |         First decompile, fresh (ms, median) |                    Repeated decompile (ms, median) | Peak RSS fresh (MiB) |
| ------ | ----------------- | ----------: | ---------------------: | ------------------------------------------: | -------------------------------------------------: | -------------------: |
| corpus | Open Decomp       |         279 |                   lazy |  18.6 complete (n=27) / 26.9 partial (n=21) |             4.3 complete / 7.9 partial (cache hit) |                  724 |
| corpus | Ghidra bridge     |         905 |                    500 |                                       233.5 |                                            231–232 |                  543 |
| corpus | Ghidra persistent |         811 |                    488 |                                         2.2 |                                                1.9 |                  547 |
| SQLite | Open Decomp       |       2,134 |                   lazy | 154.8 complete (n=6) / 207.9 partial (n=24) | 15.5–16.0 complete / 33.8–38.7 partial (cache hit) |                  648 |
| SQLite | Ghidra bridge     |       1,349 |                 30,321 |                                       230.5 |                                        230.2–230.7 |                2,870 |
| SQLite | Ghidra persistent |       1,238 |                 33,572 |                                         3.5 |                                            2.9–3.6 |                2,646 |

Delivered coverage was **not** equal: Open Decomp returned `complete` output for 11/26 functions; both Ghidra lanes returned text for 26/26 (no semantic state exposed). Against the persistent Ghidra interface Open Decomp is slower on first and cached decompiles on both inputs; its lead over the bridge is the bridge's per-call interface start (~230 ms), and avoiding Ghidra's 30–34 s up-front SQLite analysis reflects lazy per-function analysis, not engine speed. Transport is isolated only as MCP ping overhead (0.1–0.6 ms). Open Decomp cached SQLite hits spend ~8.8 ms of 12.6 ms in `validate_computation`.

## Controlled incremental reuse (2026-10-17, commit `901602b`)

`scripts/bench/incremental-controlled.py`, four frozen functions × first/reopen × 6 balanced pairs = 48 pairs, no failures; every output passed its source oracle; 48/48 pairs semantically equivalent (declared proof-ID/revision renaming only); control lifted once, reuse zero times. Raw evidence: `~/Documents/open-decomp-perf-2026-10-17-final/p36-incremental-controlled/experiment.json`.

| Case              | Control first (ms) | Reuse first (ms) | Reuse faster | Endpoint RSS Δ reuse−control (MiB, pairs lower) |
| ----------------- | -----------------: | ---------------: | -----------: | ----------------------------------------------: |
| fixture maximum   |               22.3 |             16.2 |          6/6 |                                      +9.8 (2/6) |
| fixture sum-loop  |               27.6 |             17.4 |          6/6 |                                     −13.8 (6/6) |
| SQLite threadsafe |               54.7 |             31.8 |          6/6 |                                      +0.8 (3/6) |
| SQLite strnicmp   |               94.6 |             52.6 |          6/6 |                                     −16.0 (4/6) |

Latency improves in 48/48 pairs (reuse/control median 0.54–0.72 across cells, reopen similar). Memory does **not** consistently improve (counterexamples above; sum-loop reopen heap +8.8 MiB; the 2 ms requested sampler achieved a 12.39 ms median interval, so most short fixture peaks are null, not 0). Cached SQLite leaf hits (~15.5 ms) remain slower than fixture hits (~4.3 ms), so repeated requests still depend on image size.

## Measured optimized conversion coverage

`scripts/bench/quality-matrix-rank.py` verifies the retained broader comparison output hashes and counts emitted unsupported-instruction sites across every reviewed input cell. These are static occurrences, not dynamic frequency or independent-program counts. Discovery, budget, unresolved-interface/control and FP-environment gaps remain separate in `quality-matrix-rank-2026-10-17.json`; they were not relabeled as ISA demand.

| Ranked encoding family         | Historical unsupported sites | Unsupported sites after focused replay | Whole-function results             |
| ------------------------------ | ---------------------------: | -------------------------------------: | ---------------------------------- |
| Legacy SSE `Cvtsi2sd_xmm_rm32` |                            8 |                                      0 | All partial: FP environment/status |
| ARM64 `UCVTF_asisdmisc_R`      |                            4 |                                      0 | All partial: FP environment/status |

The rank motivated legacy SSE signed 32/64-bit register/memory-to-FP32/FP64 and ARM signed/unsigned scalar-SIMD same-width 32/64-bit conversion support. Upper lanes, flags, load faults, environmental guards and unknown status effects retain their architectural contracts. This focused replay is not a new whole-matrix result or an equivalence claim.

The trusted `quality-matrix-conversions.ts` smoke passed 13 native source inputs, 104 x86 machine cases, 52 ARM machine cases and 234 independently interpreted public C/Python outcomes across 18 emissions. It covers exact rounding ties, signed/unsigned boundaries, 64-to-32 double-rounding witnesses, lane/flag preservation and memory/environment failures. The independent BigInt-to-IEEE oracle rounds the exact remainder directly to destination precision; it does not reuse production evaluation or an intermediate JavaScript float. Only newly supplied trusted source wrappers execute; analyzed matrix/x86 images do not. A fresh coordinator run after requirement integration reproduced these observations, and 36 focused lifter/source tests passed.

Reproduction: `node --import tsx scripts/bench/quality-matrix-conversions.ts <new-output-directory>`. Retained source, reports and archive are `scripts/bench/quality-matrix-conversions*`; `quality-matrix-conversion-replay.ts` records the historical-site replay. VEX/EVEX conversion, packed ARM conversion, FP16/fixed-point variants and exceptional FP environments remain unsupported. No general SIMD, atomics, language-runtime, parity or superiority claim follows.

## Bounded native contexts: source-backed paired evidence

The development-corpus comparison retained all 12 `context_*` functions on the same 17,432-byte Mach-O ARM64 image, SHA256 `42b42f7f43425706d5382aa8d624699bd6ff40d21a359e3a97e71dad292fbf03`. Actual MCP workflows produced 12 C plus 12 Python product outputs and 12 C outputs from pinned Ghidra 12.1.4 / unchanged bridge `73ea1c8eaa4bb364f7338f8180e623583bb1d340`. All selected addresses, closes and server exits matched the declared workload; neither tool received source/debug/types/annotations. Fourteen corresponding product texts matched the separately evaluated 84-outcome source oracle byte-for-byte.

At `BL 0x100000468`, the trusted source and instructions require forwarding incoming X0 into `context_words`; `ADD 0x10000046c` consumes X0 and X1 results. Product output preserves that actual argument and both 64-bit channels. The retained Ghidra caller declares no inputs and calls `context_words()` without the source-required argument, despite its own callee response having an input. Several callback/recursive/alias/conflict wrapper responses also omit source-required returns as `void`, while product output retains them. These are scoped findings in the recorded default workflow, not a claim that another query or corrected prototype cannot recover them.

Counterevidence is retained: Ghidra already shows mode constants, shared pointers, callbacks and the same partial field offsets/overlap in its caller/callee responses, often more readably. Those layouts are not exclusively discovered here. The initial product comparison also exposed a genuine standalone `context_words` defect: it dropped the XOR/X1 word and reported complete. Original responses remain unchanged. The generic repair now preserves the known secondary storage as an uncertain physical overlay and reports partial, with an original-RET requirement; it does not guess the authored aggregate. Caller-constrained two-word results remain explicit. A supplementary 24-outcome FP/raw-storage oracle checks bank/slice preservation, not comparative FP superiority.

The focused consumers additionally exercised four hypothesis/assertion/retraction context scopes and complete 256-selector native-cache replay, including absent-subject invalidation and real ledgerless re-lifting. Only separately compiled trusted oracle code executes; analyzed images never execute. The recording used historical pipeline8/reconstruction21/emitter21 labels. The later pipeline9/stack5/types6/reconstruction22 identity and final compiled evaluation are distinct; no normalized timing, held-out, general parity or superiority claim follows.

Retained before-fix archive: `$EVIDENCE/scripts/bench/quality-context-prefx-2026-10-17.tar.gz`, SHA256 `ee8355e8971621648ae8a6b12d418bcf2e401270a2c35b22ec7e892eac8dcde7`. After-fix archive: `$EVIDENCE/scripts/bench/quality-context-afterfix-2026-10-17.tar.gz`, SHA256 `2e6cd9f4430748eb5913bac09433810b988e226a8cfded48db4171c9b695bcec`. Both digests were independently checked by the coordinator. The tracked sibling JSON files retain all findings, commands, source checkpoints, proof/text bindings and member hashes. Replay uses `scripts/bench/quality-context.py` and the exact archived analyzed image, never an independently rebuilt replacement or the trusted-oracle executable.

## Second held-out suite (sealed)

The frozen published suite is public and has been inspected, so it can no longer test generalisation. A second suite of eight fresh plain-C11 functions covers a struct-field update loop, a switch-based tokenizer state machine, delimiter scanning with early returns, a bounded binary search, a clipped floating-point mean with a conditional, bit manipulation without builtins, a libc `strlen`/`memcpy` caller with a computed size, and nested loops over a 2-D array. The names are `h2_step`, `h2_count`, `h2_locate`, `h2_probe`, `h2_level`, `h2_mask`, `h2_emit` and `h2_survey`. Nothing about their behaviour is tracked.

**Sealing rule.** Development workers MUST NOT read anything under `.local/quality-heldout2/` (`source/`, `inputs/`, `gold/`, later outputs), and MUST NOT run Open Decomp, Ghidra or angr on its inputs outside a measurement round. Do not paste its source, vectors or decompiler output into prompts, tests, fixtures or commit messages. A breach marks the suite contaminated and retires it; do not rename or reselect functions to recover. The `.local/` tree is gitignored: back it up yourself, because the suite cannot be rebuilt if `source/` is lost. Any restored copy must match the pins below.

**What is tracked.** Only `scripts/bench/quality-heldout2-selection.json` (function names, positional signatures, one generic review question, the 24 cell ids, source/model hashes and compiler/linker/SDK pins), the scripts, and this section. The C source (`heldout2-corpus.c`) and the Python reference models, valid-input contract, vector generator and ctypes bindings (`heldout2-models.py`) live in `.local/quality-heldout2/source/` (mode 700) and are bound by hash.

| Pin                                                                                            | SHA256                                                             |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Private C source                                                                               | `7b1bef655d1b91d4d488d397da15e554f405a9b10e2b72c8c9ded2fbb616857c` |
| Private oracle models                                                                          | `addd9c804a0b910fe1c9161fac2aa1570fcaf1ba7674ebe5e2ff4a4e41be4005` |
| `quality-heldout2-selection.json`                                                              | `26ca36302e24218874378884ae07b4ce155182d8e753837d77dc22850189c3bb` |
| Gold vectors `gold/source-oracle-cases.json` (472: 46/64/62/63/58/60/60/59 in the order above) | `06b26e0db44ababe802043b8fde3d0453272ead129732fa9d9dc0b03743636a7` |
| 24 input images (sorted `<cell id> <sha256>` lines, one hash)                                  | `b34644743b102ba7ec95f42400f9e742897454825b72472a10ec6da605dda436` |

The toolchain pins are those of the frozen suite: Apple clang 21.0.0 (`/usr/bin/clang`), Homebrew LLVM clang 23.1.3, LLD 23.1.3, `llvm-nm`/`objcopy`/`readobj`/`objdump`, and the CommandLineTools SDK. `build` refuses to run if any hash or the SDK path differs. `oracle-results.json` embeds dylib hashes that are not reproducible, so only the case hash is pinned. The gold passed 472/472 under Apple clang 21 and LLVM clang 23 at `-O0` and `-O2`, and under an Apple clang 21 `-O1 -fsanitize=undefined -fsanitize-trap=undefined` build, so none of the vectors reaches undefined behaviour in the source.

**Build.** The 24 cells are the frozen matrix: Mach-O arm64, ELF x86-64 and PE x86-64; Apple clang 21 and LLVM clang 23; `-O0`/`-O2`; symbol-bearing and `llvm-objcopy`/`strip`-stripped. All 24 built, with identical text hashes between each symbol-bearing/stripped pair. Mach-O links `-lSystem`. The freestanding ELF and PE images link a second object from the same source (`-DH2_STUBS_ONLY`, `-O0`) that defines `memcpy` and `strlen` as ordinary callees; the analyzed function still calls them in every cell. No source or sidecar is copied next to the inputs.

**Measurement procedure** (mirrors round 7; `R` is a new round root, `IN` the sealed inputs, and the usual `GHIDRA_HOME`, `JAVA_HOME` and `BRIDGE` variables are as in the staging procedure above). Run `bun run build` first. The Ghidra-recording step cannot write beneath `.local/`: record into `$HOME/open-decomp-stage/` and `mv` it into place.

```sh
R=.local/quality-rounds/heldout2-<date>; IN=.local/quality-heldout2/inputs; mkdir -p "$R"
python3 scripts/bench/quality-heldout2-oracle.py --output "$R/gold"   # must report cases_sha256 06b26e0d… and 472/472 on all five runs
python3 scripts/bench/quality-heldout2.py run --inputs "$IN" --output "$HOME/open-decomp-stage/heldout2" \
  --entry dist/src/cli/entry.js --bridge "$BRIDGE" --ghidra "$GHIDRA_HOME" --java-home "$JAVA_HOME"
mv "$HOME/open-decomp-stage/heldout2" "$R/heldout2" && rmdir "$HOME/open-decomp-stage"
.local/angr-venv/bin/python scripts/bench/quality-heldout2-angr.py run --inputs "$IN" --output "$R/angr"
python3 scripts/bench/quality-heldout2-evaluate.py run --results "$R/heldout2" --results "$R/angr" --output "$R/correctness"
python3 scripts/bench/quality-heldout2-packets.py --results "$R/heldout2" --oracle "$R/gold" --output "$R/review"
python3 scripts/bench/quality-heldout2-packets.py --results "$R/heldout2" --extra-results "$R/angr" \
  --tools open-decomp angr --oracle "$R/gold" --output "$R/review-angr"
python3 scripts/bench/quality-heldout-instructions.py --packets "$R/review" --submissions "$R/submissions" \
  --output "$R/review-instructions/reviewer-instructions.md"
python3 scripts/bench/quality-heldout-instructions.py --packets "$R/review-angr" --submissions "$R/submissions-angr" \
  --output "$R/review-instructions-angr/reviewer-instructions.md"
# after both blind submissions per set exist (give reviewers only "$R/review/reviewer" or "$R/review-angr/reviewer"):
python3 scripts/bench/quality-heldout-review-results.py --packets "$R/review" \
  --review-a "$R/submissions/review-A.json" --review-b "$R/submissions/review-B.json" --output "$R/readability"
python3 scripts/bench/quality-heldout-review-results.py --packets "$R/review-angr" --tools open-decomp angr \
  --review-a "$R/submissions-angr/review-A.json" --review-b "$R/submissions-angr/review-B.json" --output "$R/readability-angr"
```

A complete recording has 48 OD/Ghidra tool cells and 192 matched function pairs (24 cells × 8); angr has 24 cells and 192 pairs. Rebuild the inputs only from the pinned source: `python3 scripts/bench/quality-heldout2.py build --output <new dir>` must reproduce the aggregate image hash above.

The new wrappers reuse the frozen harness unchanged. `quality-heldout2-evaluate.py`, `quality-heldout2-packets.py` and `quality-heldout2-angr.py` load the frozen script text through `quality_heldout_wrap.py`, apply a few counted substitutions (selection file, oracle file, completeness count) and fail loudly if a substitution no longer applies. `quality-heldout-instructions.py` and `quality-heldout-review-results.py` read only the packet tree and are used as is. The evaluator differs from the frozen policy in one respect: its header also includes `<string.h>`, so the real libc prototypes for `h2_emit`'s callee are declared for every tool. The oracle script in `scripts/bench/quality-heldout2-oracle.py` loads the hash-pinned private models, so the evaluator's per-function executable checks and the packets' sealed oracle copy use the same 472 vectors.

Results from this suite stay separate from the frozen-suite rounds. Report them with the same availability, exact-executable-subset and blind-readability lanes, and do not tune any pass against the outputs, the questions or the source. After a measurement round the suite has been seen: record who saw what, and treat the next round as a new suite.

## Third held-out suite (sealed)

The second suite is no longer fully blind (`h2_level` was read during triage), so the readability roadmap R1–R5 (`git show 7301f55:TODO.md`) is measured on a third suite of eight fresh plain-C11 functions, written before any decompiler output for them existed and never analyzed. The names are `h3_pairsum`, `h3_unescape`, `h3_rescale`, `h3_walk`, `h3_pack`, `h3_clock`, `h3_label` and `h3_dispatch`. They were chosen to differ in shape from the second suite and from the development-loop matrix: a nested pair search with sentinel skipping, `continue`, `break` and a `goto` exit; an escape-sequence decoder with a state entered from two places; a frame mixing address-taken locals (out-parameters of a helper callee, a local scratch buffer) with non-escaping signed 64-bit arithmetic; a linked-list walk that writes to nodes and can cycle; an array-of-structs fold with bitfield-style packing into a 64-bit result; 64-bit division/modulo by constants (signed and unsigned) with packing and an out array; a `strchr`/`strlen`/`memcpy`/`memset` caller; and indirect calls through a table of handlers. Nothing about their behaviour is tracked.

**Sealing rule.** Identical to the second suite, with `.local/quality-heldout3/` in place of `.local/quality-heldout2/`: development workers MUST NOT read anything under it (`source/`, `inputs/`, `gold/`, later outputs), MUST NOT run Open Decomp, Ghidra or angr on its inputs outside a measurement round, and MUST NOT paste its source, vectors or decompiler output into prompts, tests, fixtures or commit messages. A breach marks the suite contaminated and retires it; do not rename or reselect functions to recover. **The suite cannot be rebuilt if `source/` is lost**: the C source and models exist only in the gitignored `.local/quality-heldout3/source/` (mode 700), so back it up yourself; any restored copy must match the pins below.

**What is tracked.** Only `scripts/bench/quality-heldout3-selection.json` (function names, positional signatures, one generic review question, the 24 cell ids, source/model hashes, the aggregate image hash and its rule, compiler/linker/SDK pins), `scripts/bench/quality-heldout3*.py`, the shared `quality_heldout_wrap.py` and this section. The C source (`heldout3-corpus.c`) and the Python reference models, valid-input contract, vector generator and ctypes bindings (`heldout3-models.py`) are private and bound by hash. Struct and function-pointer parameters are typed `void *`/`const void *` in the positional signatures so the evaluator's adapters compile without private declarations.

| Pin                                                                                                       | SHA256                                                             |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Private C source                                                                                          | `b243dfffb1e8d6eb7713aafc205c35920ce0b204b868aa761c06aa6a209d4e86` |
| Private oracle models                                                                                     | `f2f5e2606a1e9b5401750892c062009c4afe6ed0b745a6ed6cfbcca234022160` |
| `quality-heldout3-selection.json`                                                                         | `26cea1d3ef306d796bd94da4702324557c2c26c9dd9c4c716fcfdbaf28aa453c` |
| Gold vectors `gold/source-oracle-cases.json` (510: 63/76/63/62/57/64/62/63 in the order above)            | `1729011868fda274284c4e22c5778130cf6e16486351e6771caf5430add2ec0d` |
| 24 input images (SHA256 of the sorted `<cell id> <image sha256>\n` lines; also `inputs_aggregate_sha256`) | `0733a31eeae609036f9303ce35386eb921c91972515139c204ea7d21346b20e1` |

The toolchain pins are those of the second suite (Apple clang 21.0.0 `/usr/bin/clang`, Homebrew LLVM clang 23.1.3, LLD 23.1.3, `llvm-nm`/`objcopy`/`readobj`/`objdump`, the CommandLineTools SDK). `build` refuses to run if any source, model or tool hash or the SDK path differs, and fails if the built images do not hash to the pinned aggregate. The gold passed 510/510 under Apple clang 21 and LLVM clang 23 at `-O0` and `-O2` and under an Apple clang 21 `-O1 -fsanitize=undefined -fsanitize-trap=undefined` build, so no vector reaches undefined behaviour in the source. Checks made while authoring: each of 17 single-line mutations of the C source (comparison, mask, constant and ordering changes) was caught by at least one vector on a scratch copy; the trusted source function texts, compiled through the evaluator's positional adapters and `<string.h>` header, passed all 510 vectors (this exercises the contracts only, never an analyzed image). The suite author ran no Open Decomp, Ghidra or angr analysis on the inputs.

**Build.** The 24 cells are the frozen matrix (Mach-O arm64, ELF x86-64, PE x86-64; Apple clang 21 and LLVM clang 23; `-O0`/`-O2`; symbol-bearing and stripped). All 24 built with identical text hashes between each symbol-bearing/stripped pair, and a rebuild into a different directory reproduced the aggregate hash. Mach-O links `-lSystem`; the freestanding ELF and PE images link a second object from the same source (`-DH3_STUBS_ONLY`, `-O0`) that defines `strchr`, `strlen`, `memcpy` and `memset` as ordinary callees. Every image also contains a non-selected helper function (`h3_bounds`, called by `h3_rescale`) and the analysis-root `h3_entry`. Two of the 24 images are byte-identical (the stripped `-O0` ELF images of both compilers), so those two cells analyze the same bytes; count them as two cells but do not read them as independent evidence. No source or sidecar is copied next to the inputs.

**Measurement procedure.** Same as the second suite with `heldout3` in place of `heldout2` in every script name, `.local/quality-heldout3/inputs` as `IN` and a new round root (`R=.local/quality-rounds/heldout3-<date>`). The oracle step must report `cases_sha256` `1729011868fda274284c4e22c5778130cf6e16486351e6771caf5430add2ec0d` and 510/510 on all five runs; a complete recording has 48 OD/Ghidra tool cells and 192 matched function pairs, and angr 24 cells and 192 pairs. The wrappers load the second suite's scripts through `quality_heldout_wrap.py` with counted substitutions and fail loudly if a substitution no longer applies; `quality-heldout-instructions.py` and `quality-heldout-review-results.py` are used as is. Rebuild the inputs only from the pinned source: `python3 scripts/bench/quality-heldout3.py build --output <new dir>` prints `aggregate_image_sha256` and fails unless it equals the value above. Expected limitation: a tool that emits the handler-table callback parameter with a type the exact-output compile cannot accept is reported `unverified`, not passing.

Results from this suite stay separate from earlier rounds and are reported with the same availability, exact-executable-subset and blind-readability lanes. Do not tune any pass against the outputs, the questions or the source. After a measurement round the suite has been seen: record who saw what, and treat the next round as a new suite. Measured once, 2026-10-20 (next section); the suite is now seen.

## Third held-out suite: round 1 (2026-10-20)

First and only measurement of the sealed third suite, `proven` inference (default), C source view, default budget. Build: `dist/` of `dda46a2` (main after the R1–R5 roadmap round); commit `3ba2255` followed it and changed only `scripts/bench/quality-matrix.py`. Round root `.local/quality-rounds/heldout3-2026-10-20/` (gold, `heldout3` = Open Decomp + Ghidra recording, `angr`, `correctness`, `review*`, `submissions*`, `readability*`, `records/` with commands and logs). Tooling: Ghidra 12.1.4, bridge `xjoker/ghidra-mcp` `73ea1c8e…` re-provisioned at `$HOME/open-decomp-bridge/ghidra-mcp` (`uv sync --locked --python 3.13`, clean tracked tree), Homebrew OpenJDK 27, angr venv `.local/angr-venv`. The oracle step reproduced `cases_sha256` `1729011868fda274284c4e22c5778130cf6e16486351e6771caf5430add2ec0d` and 510/510 on all five runs.

**Harness fix (`3ba2255`).** The first Open Decomp recording classified all 192 cells `tool_error`: MCP `function_decompile` is text-first (no `structuredContent`) and the recorder reads the full envelope. `quality-matrix.py` now passes `detail:"full"`; on three dev-matrix functions the full envelope's emission text is the exact tail of the text-first response. The failed recording is kept as `discarded-run1-od-tool_error` and is not used. No product change.

**Availability (192 function cells per tool).**

| Tool        | Text returned | Not delivered                                                                                                    |
| ----------- | ------------: | ---------------------------------------------------------------------------------------------------------------- |
| Open Decomp |           126 | 64 `function_not_discovered` (every stripped PE and ELF cell), 2 `tool_error` (see open defects)                 |
| Ghidra      |           113 | 79 `tool_error`: all 64 PE cells and 15 ELF cells ("address not contained in function"; same pattern as round 8) |
| angr        |           192 | 0                                                                                                                |

Open Decomp states on the 126 texts: 52 complete, 74 partial. Reviewable pairs (both sides have text): 94 for Open Decomp vs Ghidra, 126 for Open Decomp vs angr. The other pairs are unscored.

**Exact-executable subset** (finite vectors, 510 per function, compiled from the exact emitted C; no analyzed binary executed; `correctness/correctness.json`):

| Tool        | Cells passing all vectors | Counterexample | Unverified |
| ----------- | ------------------------: | -------------: | ---------: |
| Open Decomp |                        54 |              4 |        134 |
| Ghidra      |                        44 |              0 |        148 |
| angr        |                        46 |             12 |        134 |

Open Decomp passes by function: `h3_walk` 16, `h3_pack` 12, `h3_pairsum` 12, `h3_clock` 8, `h3_unescape` 6, `h3_dispatch`, `h3_label` and `h3_rescale` 0. Ghidra: `h3_pairsum` 14, `h3_pack` 14, `h3_unescape` 8, `h3_clock` 4, `h3_label` 4, others 0. angr: `h3_walk` 24, `h3_pairsum` 12, `h3_clock` 6, `h3_unescape` 4. Unverified reasons, Open Decomp: no emitted text 66, recovered interface with a different input count than the source (5 vs 4: 42, 5 vs 6: 4, 4 vs 3: 4, 6 vs 5: 2), exact C outside the executable subset 12, machine-entry state input 4. Ghidra: no text 79, outside the subset 69. angr: outside the subset 70, plain-`long` data model on PE 48, unsupported pointer-to-pointer parameter declarations (at least 10 cells). The four-cell comparison is not a ranking: a pass count depends on how many cells compile at all.

**Open defects found (not fixed in the measured build; the suite is not tuned against). Root causes and fixes (commit `2949cf4`, emitters 68) were found afterwards on the now-seen suite and reduced to independent source-built regressions (`test/reconstruction/emitted-c-source.test.ts`):**

- **`h3_clock`, Mach-O arm64 `-O2`:** Open Decomp's emitted C is wrong: 4 of 64 vectors pass in each of the four cells (Apple clang 21 and LLVM clang 23, symbol-bearing and stripped). angr is also wrong on `h3_clock` in 8 cells (0/64 at `-O0`, 10/64 at `-O2`) and on `h3_pack` in 4 Mach-O `-O2` cells (54/57). Ghidra has no counterexample.
  _Root cause (C printer, not reconstruction):_ the source printer typed a hexadecimal literal in [2^63, 2^64) as the IR width of its context instead of C's `unsigned long long`. In the 128-bit product of a multiply-high (`umulh` by the magic `0xc22e450672894ab7` of `/ 86400`, kept raw because a `bfxil` also reads it) the literal therefore looked 128-bit, so the `(uint128_t)` cast of the other operand was dropped and `(value0 * 0xc22e450672894ab7) >> 64` multiplied in 64 bits and shifted by the full width. The IR and the checked view were right. Not a roadmap regression: `de95fa4` printed the same line and also failed the four ELF and PE `-O2` cells (4/64); at `dda46a2` those had their multiply-high folded into a division. Local validation could not reject it because there was no rewrite to validate: validation proves IR and presentation rewrites, while the C type of a printed operand belongs to the printer, whose only check is the printer oracle (`test/emitters/source-simplify-oracle.test.ts`), which generated no interior wider than 64 bits. No validator shortcut was involved. _Fix:_ a literal below 2^64 is 64-bit in every context; the oracle now also runs 700 trees with 128-bit interiors and constants at or above 2^63 (it fails on the old printer with a shift-sanitizer error). Re-recording the four Mach-O `-O2` cells with the round's evaluator: `h3_clock` 64/64 in all four, every other function's text unchanged.
- **`h3_unescape`, Mach-O arm64 LLVM clang 23 `-O2`** (symbol-bearing and stripped): `function_decompile` fails with `invalid_input: "A duplicated transfer has inconsistent rendered actions"` (a reconstruction invariant rejection; no text). The same function decompiles in the Apple clang 21 cells.
  _Root cause:_ source-view return-tail copies (`planLayout`) copy a jump chain onto a labeled edge; inside the copy each jump falls into the copy of its target, and copies share the original transfer objects, for which the renderer prints one action. The region-collapse structurer (R2 merge `1a59bef`, first failing merge; `678b212` before it decompiles) placed one block of such a chain inside the loop, where its own transfer to the loop follow prints as `break`, so the same transfer was both `break` and fallthrough. _Fix:_ after copying, every transfer whose occurrences print differently refuses the labeled edges whose copies hold it (they keep their goto), repeated until all agree. Both cells now return text (outside the executable subset, as in the Apple clang 21 cells, because of an unsupported `DUP` vector instruction).
- **Interface mismatches:** 52 Open Decomp cells are unverified because the number of recovered inputs differs from the source's positional signature (not a type judgement; an extra input or a missing one both count).
  _Triage:_ no regression. Re-recording all 16 text-bearing cells with `de95fa4` and with the fix gives the same interface outcome for every (cell, function). In all 52 the difference is an explicit `entry_sp` input (the evaluator rejects any `entry_` input): 32 escaped frame objects (`h3_label`'s local buffer passed to `memcpy`, 16; `h3_rescale`'s `&lo`/`&hi` passed to `h3_bounds`, 16), frame slots kept as memory across `h3_dispatch`'s indirect handler call (8 `-O0`, 2 ELF `-O2`), callee-saved register saves kept as frame stores because the function ends in an unsupported-instruction exit (`h3_pack` ELF/PE `-O2`, `bts`, 4; `h3_unescape` ELF `-O2`, `punpcklbw`, 2), and Win64 stack arguments 5 and 6 of `h3_pairsum` read at `entry_sp + 40/48` instead of becoming formals (PE, 4). All are conservative and correct; none is fixed here.
- **No recovered algorithm in some cells:** reviewers in both sets noted `h3_pack` at ELF `-O2` where the text is mostly `unknown_value`/`unknown_exit` markers and only a zero check can be explained (the x86-64 lifter does not support `bts`; not fixed).
- **Work-limit failures (LLM task re-run and the structure sample, not this suite):** brotli 1.2.0 CLI `main` and SQLite `whereLoopAddBtreeIndex` failed with `resource_limit: Operation work limit exceeded` (10,000,001 of 10,000,000) in the current build; at `c8dceed` they finished (8,146,458 and 7,566,953 counted work in a fresh `decompile`, default budget).
  _Root cause (bisected over first-parent merges, fresh cache, default budget):_ both first fail at the R4 merge `ceb53bf`. For `main`, R3temps (`3c30ecb`) made call-inlining retries targeted: each held call that does not reach its reader renders again, and every render re-ran the whole reconstruction (about 780k work each in the final build) and its validation; `main` renders four times (9,856,246 at `3c30ecb`, still under the limit), R4 then pushed it over, and the R2 region-collapse structurer (`1a59bef`, `717fa5d`: about +1.4M, mostly repeated `tailBlock` scans and edge-selection simulations) added more (14,148,415 needed with the limit raised). For `whereLoopAddBtreeIndex`, R4's pointer evidence made the inference provenance unions about four times larger (inference collection 1.03M to 4.27M work with the limit raised): every mapping's proof list was rescanned per inference and per half of every split type cohort, and oversized unions were materialized before being rejected.
  _Fix (no limit raised, texts unchanged):_ `renderSource` reconstructs once; each attempt renders from that reconstruction with its own fork of the local-validation session, and validation runs on the first attempt only. The structurer memoizes `tailBlock` (the CFG is immutable during structuring). Inference reference unions share one encoding per distinct reference set, summarize each mapping list once, and check union sizes before materializing. Counted work (fresh `decompile`, default budget): `main` 9,604,277 (exit 2, partial, as at `c8dceed`), `whereLoopAddBtreeIndex` 9,718,104; with the limit raised, 14,148,415 to 10,920,991 and 24,114,515 to 22,747,871 (the native-interface refinement share scales with the remaining work, so raised-limit numbers are larger). Both texts and normalized JSON (ids aside) are identical to `112527d` with the limit raised. Structure sample: 2 `resource_limit` failures before, 0 after. Regression: `test/reconstruction/emitted-c-source.test.ts` (a retried render executed against its source), session-fork and union unit tests. Margins remain small (about 0.3-0.4M); the remaining per-attempt constructor work (inlining plan, liveness, coalescing) depends on the rejected calls and still repeats per retry.
  _G9 regression and fix (`wt/g9lift`, no limit raised):_ lifting ARM64 DUP/CMEQ/AND/FCVTZS/UCVTF removed a whole-state unknown-effect barrier in `main`, so more code is analyzed: 9.60M to 11.18M counted work (failed). Paid back without dropping analysis: a mapping's evidence is the union of immutable evidence lists passed by identity, unioned and interned once per distinct list sequence (and inference records cite member proof lists by identity); reference unions keep their size and occupied word range, so `size()` is one step and `finish()` scans the range when that is cheaper than sorting; a multi-subject inference member merges each subject's memoized link summary; constant-to-source-address lookups use an index built in the existing address loop; render attempts share the attempt-independent source-name, character and indexed-data plans; and an attempt's mappings are published only once its body can no longer be retried (a retried attempt's metadata was discarded anyway). `main` 9,450,510 (text, partial (budget), 1,482 lines), `whereLoopAddBtreeIndex` 9,718,487 to 9,046,078. Earlier-stage savings are not taken: below about 5M used before image-type merging, that optional pass gets a sub-budget (`remaining - max(remaining/4, used)`) and, for `main`, spends all of it and stops (a chunked copy-on-write stack state cut `recoverStack` by 1.1M but only moved that work into merging, and changed other functions' text by enabling more merging).
- **Nondeterministic structure names across runs (`open-decomp export`):** SQLite 3.54.0 `btreeBeginTrans` printed `struct_a70993` when exported with `--name btreeBeginTrans --jobs 2` but `struct_d9a38b` with `--jobs 1` or inside the `--name btree` export (also `--no-analysis-cache`, also the same function requested twice in one session: first request vs later ones); `sqlite3ExprCodeTarget` was reported with the same symptom (not reproduced on its own before the fix).
  _Root cause:_ the names themselves are content-derived (a digest of the observed layout, or of the merged layout for a bounded image type), and the merge input was ordered canonically. What differed was the layout: native callee loading stops loading new bodies once half of the work left after the selected body is spent (`native dependency load work reserve`), so which callees are loaded, and with them the merged image-type layout of `sqlite3PagerSharedLock`'s first argument, depends on that work figure. Image-scoped indexes built once per process (native call index, symbol and data-hint indexes, Objective-C index, discovery index, the materialized function/symbol/import/export/reference arrays) charged their linear build cost to the request that happened to build them (and nothing to the rest), and the selected-local graph cache charged its reuse by size instead of by the work its reconstruction charged. The first request in a process therefore had up to 45,467 (SQLite) less work than every later one: results depended on request order and on how a parallel export dealt functions to workers.
  _Fix (versions: `pipeline/26`):_ each such build records its measured cost (`buildOnce`) and every operation that uses the structure, the building one included, pays exactly that recorded cost once on its root context (`useBuilt`; still bounded by the shared work limit, never raised), and a graph cache hit charges exactly the work its construction charged, so a request's charged work, and every budget-dependent decision, is independent of what the process served before (prepared callee units already obeyed this). After it, `--name btreeBeginTrans` (`--jobs 1` and `2`) and `--name btree` (`--jobs 1` and `3`) give identical files for the same functions, and `--name sqlite3ExprCodeTarget` (`--jobs 1` and `2`) matches the same function in `--name exprcode`; a warm project cache reproduces the cold text. A fresh-process request is charged exactly what it was before, so no limit margin moves: brotli `main` and SQLite `whereLoopAddBtreeIndex` still finish at 9,606,593 and 9,718,487 of 10,000,000 work. `test/service/analysis/request-determinism.test.ts` compiles a small call tree and asserts that a cold request, a repeated request and a request after another function are identical over a sweep of work budgets (it fails before the fix at 88,000 and 100,000 work). Remaining, by design: output may differ between different budgets (a different request) and, only if a wall-clock deadline expires, between runs (the 30 s default deadline is never reached by the samples above).

**Blind readability (LLM reviewers, not a human study).** Both reviewers were Claude Haiku, fresh agents chunked 16 cases per agent, the same instructions per reviewer id (A and B), reading only `review/reviewer` or `review-angr/reviewer` (no tool names; X/Y assignment varies). Reviewer instructions: `.local/quality-rounds/heldout3-2026-10-20/review-instructions{,-angr}/reviewer-instructions.md`. The aggregator validated all submissions (94 and 126 cases each, ids matching). Counts below are reviewer ratings (two per pair).

| Pair set (reviewed pairs)         | Overall preference (2 ratings per pair) | Reviewer split  | Per reviewer (A / B)                                   |
| --------------------------------- | --------------------------------------- | --------------- | ------------------------------------------------------ |
| Open Decomp vs Ghidra (94 of 192) | OD 108, Ghidra 78, tie 2                | 11 of 94 pairs  | A: OD 57, Ghidra 36, tie 1; B: OD 51, Ghidra 42, tie 1 |
| Open Decomp vs angr (126 of 192)  | OD 135, angr 111, tie 6                 | 11 of 126 pairs | A: OD 68, angr 57, tie 1; B: OD 67, angr 54, tie 5     |

Round 8, second suite, for comparison (different functions and reviewers, so a trend and not a delta): OD 44 / Ghidra 138 / tie 10 and OD 84 / angr 153 / tie 13 / neither 6.

Dimension means (0–4, higher is more readable; round 8 second suite in brackets):

| Dimension                        | OD vs Ghidra: OD | Ghidra | OD vs angr: OD | angr |
| -------------------------------- | ---------------: | -----: | -------------: | ---: |
| algorithm comprehension          |      2.49 [2.81] |   2.64 |           2.66 | 2.59 |
| control flow                     |      2.90 [2.75] |   3.10 |           2.94 | 2.87 |
| irrelevant machine-state clutter |      2.16 [1.95] |   2.26 |           2.17 | 2.13 |
| style                            |      2.18 [2.01] |   1.99 |           2.25 | 2.24 |
| types and interfaces             |      2.28 [2.30] |   1.89 |           2.22 | 2.20 |
| unresolved semantics             |      2.20 [3.04] |   2.19 |           2.32 | 2.06 |

Open Decomp is ahead of Ghidra on style and types/interfaces and behind on algorithm comprehension, control flow and clutter (means differ by 0.1–0.2 on three of six, so those are small). Its unresolved-semantics mean fell from 3.04 on the second suite to 2.20 (Ghidra: 3.36 there, 2.19 here); this set was not matched to that one.

Where Open Decomp wins and loses (reviewer ratings, OD vs Ghidra / OD vs angr):

| Slice                     | OD vs Ghidra (OD / Ghidra / tie) | OD vs angr (OD / angr / tie) |
| ------------------------- | -------------------------------- | ---------------------------- |
| `h3_pairsum`              | 24 / 0 / 0                       | 25 / 7 / 0                   |
| `h3_walk`                 | 24 / 0 / 0                       | 20 / 8 / 4                   |
| `h3_clock`                | 23 / 0 / 1                       | 18 / 14 / 0                  |
| `h3_unescape`             | 15 / 5 / 0                       | 24 / 2 / 2                   |
| `h3_pack`                 | 10 / 14 / 0                      | 8 / 24 / 0                   |
| `h3_dispatch`             | 8 / 16 / 0                       | 15 / 17 / 0                  |
| `h3_label`                | 3 / 20 / 1                       | 16 / 16 / 0                  |
| `h3_rescale`              | 1 / 23 / 0                       | 9 / 23 / 0                   |
| Mach-O `-O2`              | 43 / 17 / 0                      | 56 / 3 / 1                   |
| Mach-O `-O0`              | 30 / 34 / 0                      | 29 / 34 / 1                  |
| ELF (`-O0` / `-O2`)       | 19 / 13 / 0 and 16 / 14 / 2      | 8 / 22 / 2 and 23 / 9 / 0    |
| PE (`-O0` / `-O2`)        | no pairs (Ghidra has no PE text) | 2 / 28 / 2 and 17 / 15 / 0   |
| symbol-bearing / stripped | 70 / 54 / 2 and 38 / 24 / 0      | 90 / 95 / 5 and 45 / 16 / 1  |

The losses are concentrated in three kinds of function and in `-O0`. Recurring reviewer reasons for preferring the other tool:

- `entry_sp` stack-slot reads and offsets as variables (`h3_label`, `h3_dispatch`, `h3_rescale`);
- a 128-bit macro helper header and sign-extension masks around a 64-bit rescale (`h3_rescale`);
- a variadic cast on an indirect handler call and an undeclared inferred helper prototype (`h3_dispatch`, `h3_rescale`);
- a `do { … break; } while (0)` construct standing in for `continue` and a mask routed through a stack buffer (`h3_pack` at `-O0`);
- unknown-value/unknown-exit markers instead of a computation (`h3_pack` ELF/PE `-O2`);
- `valueN` temporaries.

Reasons reviewers gave for preferring Open Decomp: explicit byte offsets on a record pointer where the other tool steps an `int*` (`h3_walk`, `h3_pack`), named locals and return codes with fewer gotos and no goto web (`h3_unescape`, `h3_label`), typed table/byte parameters with the same control flow (`h3_dispatch`), scalar expressions where the other tool uses vector views and helper calls (`h3_clock` at `-O0`), and named typed temporaries instead of signed-modulo constants.

**Blinding is weak.** Reviewers flagged possible style unblinding in 188 of 188 (Ghidra set) and 247 of 252 (angr set) ratings; the engines' output styles are recognisable (`entry_sp` slots, `FUN_`/`param_` names, macro helpers). Preferences may partly reflect style bias. Both reviewers share a model lineage, so their agreement is weaker evidence than two different reviewers; reviewer confidence averaged 0.66 (Ghidra set) and 0.69 (angr set). Cells share one source function, so 94/126 pairs are not independent programs. Missing pairs (98 and 66) get no score, so a tool that decompiles less is not penalised by the readability lane.

**LLM task benchmark (`scripts/bench/llm-tasks/`, 42 questions, configs `mcp-default` and `export-file`, answerers Claude Haiku agents, 14 questions per agent, single run per set).** Packets `.local/llm-tasks/r20-{proven,likely}` built from checkout `3ba2255` (dist of `dda46a2`) with the binaries copied to `.local/llm-tasks/inputs/` (the MCP root check rejects the Homebrew symlink path); `likely` packets were built through a throwaway `HOME` whose `settings.json` sets `decompile.inference` to `likely`. Answers `.local/llm-tasks/answers-{proven,likely}`, scores `<packets>/score/score.{json,md}`. Only the `likely` packets contain `likely_arity(`/`likely_type(` markers (3 of 42 files per config; none in `proven`). Previous run (2026-10-19, `c8dceed`) in the same table:

| Run and config                  | Correct / unknown / wrong | Material tokens | Tokens / correct |
| ------------------------------- | ------------------------: | --------------: | ---------------: |
| run 2 `mcp-default` (`c8dceed`) |                41 / 0 / 1 |         ~103.9k |            2,534 |
| run 2 `export-file`             |                42 / 0 / 0 |         ~104.9k |            2,497 |
| round 1 `proven` `mcp-default`  |                39 / 3 / 0 |          57,628 |            1,478 |
| round 1 `proven` `export-file`  |                41 / 1 / 0 |         100,909 |            2,461 |
| round 1 `likely` `mcp-default`  |                39 / 3 / 0 |          57,711 |            1,480 |
| round 1 `likely` `export-file`  |                40 / 1 / 1 |         100,989 |            2,525 |

On Ghidra's 16 questions (its archived output, 2,518 tokens, 13 correct, 194 tokens/correct; the 2,518 reproduces from the archived files):

| Config (round 1)        | Correct | Material tokens | Tokens / correct | Round 2 (previous run) |
| ----------------------- | ------: | --------------: | ---------------: | ---------------------: |
| `mcp-default`, `proven` |   16/16 |           6,895 |              431 |         16, 6,983, 436 |
| `export-file`, `proven` |   16/16 |           7,323 |              458 |         16, 7,407, 463 |
| `mcp-default`, `likely` |   16/16 |           6,931 |              433 |                      — |
| `export-file`, `likely` |   16/16 |           7,359 |              460 |                      — |
| Ghidra (archived)       |   13/16 |           2,518 |              194 |         13, 2,518, 194 |

Ghidra is still about 2.2× cheaper per correct answer on its 16 questions; Open Decomp answers all 16.

What the totals hide. The all-question token totals dropped by about 45% for `mcp-default`, but not for the reason the table suggests: brotli `main` now fails in the current build with `resource_limit: Operation work limit exceeded` (consumed 10,000,001 of 10,000,000 work). The `mcp-default` packet for the three `bro-main-*` questions is the 234-byte failure envelope (previously a 66 KB partial output), so all three are `unknown` (not wrong); `export-file` delivers the function's disassembly (51 KB) and answers two of the three from it (`bro-main-quality` unknown). The previous run answered `bro-main-lgwin` wrongly in `mcp-default` from the 62 KB body. So per-correct tokens improved because a large function stopped decompiling, not because the others shrank: on the 16 Ghidra questions the totals changed by about 1% (6,983 → 6,895 and 7,407 → 7,323). This is an open defect: brotli `main` (inlined option parser) is now `failed` at the default work budget.

`likely` mode did not help: `mcp-default` is identical (39/3/0, 1,480 vs 1,478 tokens/correct), and `export-file` lost one answer and gained one confident wrong answer, `bro-filesize-failure` (`0xffffffffffffffff` where the gold is `-1`; the scorer compares the number, the value is the same 64-bit pattern, but it is scored wrong): 40/1/1, 2,525 vs 2,461 tokens/correct. Single runs with Haiku answerers; one-question differences are within noise. The held-out readability round ran in `proven` mode only, so no held-out readability evidence exists for `likely`.

**Who saw what (the suite is now seen; the next measurement needs a new suite).** Development workers did not read it before this round. In this round: the measurement agent (`Heldout3Round`) ran the oracle and all tools, read the correctness records and per-function pass counts, the blind reviewers' rationales and aggregated results, and the reviewer packets' structure; it did not read the private C source or models. The coordinator (`Main`) saw the aggregated results. Reviewers (Haiku, per-reviewer-id chunks) saw only the reviewer packet trees (X/Y decompiler text, question, rubric) and no source, gold or mapping. The private mappings were sealed under `sealed/` until both submissions existed, then restored for aggregation. The decompiler output texts for all 24 cells are now in `.local/quality-rounds/heldout3-2026-10-20/` and have been seen by reviewers; do not use this suite for tuning, and do not paste its source, vectors or output into tracked files.

## Per-function latency and cross-request callee reuse (2026-10-19)

Host shared with other agents (load average 5–12, noted per run); serial runs, Node 26.11, SQLite 3.54.0 Mach-O ARM64 dylib (`libsqlite3.3.54.0.dylib`) 79-function sample, fresh imported project per configuration. "Main" is `fee03a5`; outputs of every run below are byte-identical between main and this change (CLI cold, CLI warm, one-process session, `export` directories).

| Seconds per function (79)                                          | Main p50 / p90 / max | After p50 / p90 / max |      Load |
| ------------------------------------------------------------------ | -------------------: | --------------------: | --------: |
| CLI, cold project (one process per function, incl. ~0.4 s startup) |   2.00 / 2.60 / 5.01 |    1.60 / 2.01 / 4.50 | 7.5 → 6.0 |
| CLI, warm (artifact hits)                                          |   0.76 / 0.91 / 1.36 |    0.78 / 0.86 / 1.30 | 5.2 → 5.3 |
| One process (`openBinary` session), cold project                   |   1.08 / 1.67 / 4.53 |    0.67 / 1.06 / 3.65 | 5.2 → 5.3 |

`export --jobs 1`: SQLite `--name json` (91 functions) 111.5 s → 68.7 s (max worker RSS 1.23 → 1.25 GB); brotli (64 functions) 8.38/8.16/7.37 s → 5.30/5.29/6.02 s.

Where time went (CPU profiles of the sample, `--cpu-prof` on CLI and worker): before, the worker spent ~32 % in preparing native callee units (`prepareNativeUnit`: lift, SSA, verification, types, calls, annotation queries), ~2.7 s of a 7 s `_sqlite3ExprCodeTemp` in replaying cumulative dependency readsets (one SQLite annotation query per replayed read), ~10 % in sub-budget `checkpoint` chains (each wrapper charged its parent twice, so cost doubled per nesting level), and per process ~0.2 s module loading, ~0.2 s loading/validating image metadata and ~0.2–0.3 s decoding native record indexes.

Changes (none alters output): readset replay skips reads the collector already holds (charging the same work); store statements are prepared once per connection; annotation reads short-circuit on revisions without annotations; stored records decode to plain properties; the deadline clock is sampled every 32 charges (expiry latched); sub-budget wrappers charge their parent once; canonical identities are built in one string and hashed one-shot; address/range encoding skips nested codec parses. Prepared callee units are now reused by every later request in the same worker at the same image revision and component/native-type identity, not keyed by budget or root (`source-facts.ts`): only limit-free preparations are kept, a hit requires an allowance of at least min(original, 4·W + 3) and the same capacity, and replays the exact work W and the traced dependency reads in order, so results and later budgets equal a fresh preparation (`native-unit-reuse.test.ts`, readset oracle). Limits: the CLI starts a process per call, so its cold path cannot reuse units (no on-disk persistence of prepared units); the per-image unit cache is capped at 2^18 size units (~256 MiB); `_renameColumnFunc` already differs between a one-process session and a fresh CLI process on main (pre-existing process-history dependence, unchanged here).

## LLM task success per token (`scripts/bench/llm-tasks/`)

The readability review compares how pseudocode looks to a human. The primary consumer is an LLM reversing an application, so this harness measures what that consumer needs: **the fraction of source-derived questions answered correctly from the delivered material, and the tokens that material cost.** Results of two runs are below; a third run (2026-10-20, both inference modes) is in "Third held-out suite: round 1".

**Question set (`questions.json`, frozen 2026-10-19 before any decompiler output was built).** 42 questions: 26 over SQLite 3.54.0 (`sqlite3-arm64`, the binary the archived Ghidra run analysed, SHA-256 `4e01e37e…7e56`; 14 functions, including the 10 Ghidra-archived ones and `btreeLeaveAll`, `sqlite3_result_pointer` (carries the inlined `sqlite3VdbeMemSetPointer`), `renameColumnFunc`, `sqlite3_incomplete`) and 16 over the brotli 1.2.0 CLI (Homebrew, `9a3bf101…23c7`; `ParseInt`, `CheckAlias`, `OpenFiles`, `FileSize`, `WriteOutput`, `NextFile`, `main` with the inlined option parser). Kinds: return value, constant/limit, struct field offset, error message text, file mode/flags, call order, loop bound/stride, branch condition, callee. Each record has the function and address, question text, answer format, gold answer, a machine scoring rule (`numeric`, `exact`, `set` (optionally ordered), `regex`, `rubric` of required facts), and a source span with an anchor line. Gold comes from `sqlite3.c` (SHA-256 `2da161e3…3243`) and `brotli.c` at tag v1.2.0 (`cb6c8ca6…cd0c`), using the build configuration the binary itself embeds (SQLite's compile-option string table: `MAX_VARIABLE_NUMBER=250000`, `THREADSAFE=1`, `ENABLE_API_ARMOR`, …) and struct offsets from `offsetof()` over the verbatim source; every offset/constant was also checked against `llvm-objdump` output. `node --import tsx scripts/bench/llm-tasks/run.ts verify --sources DIR` re-checks every source span and anchor text. Gold never comes from decompiler output. `questions.json` is hashed into each packet manifest and `score` refuses a different file. Limitations: the set is small and was authored by one author; scoring rules are intentionally lenient regexes for short phrases (see the rule definitions); `disclosure` in the file records what the author had seen.

**Configurations.** Each question is delivered as exactly the material an LLM would see, per tool configuration: `mcp-default` (`function_decompile`, default arguments, through the real MCP stdio server of the given checkout; all text blocks as delivered), `export-file` (`open-decomp export --name FN` function file plus its `index.tsv` header and row), `ghidra` (archived headless Ghidra 12.1.4 output, SQLite's 10 archived functions only) and `disasm` (`function_get` compact disassembly, all pages: the no-decompiler baseline). Byte counts are UTF-8 bytes of the material only (prompt excluded; the prompt is identical across configs). Tokens are estimated as `ceil(bytes / 3.6)`; no tokenizer is available offline, so treat token figures as a monotone proxy, not billing.

**Protocol.** The prompt tells the answerer to use only the material, to answer `unknown` when it cannot be determined, and to give a short answer. Collect answers outside the harness (subagents reading `packets/<config>/<id>.md`, writing `DIR/<config>/<id>.json` as `{"answer": "..."}`) or let `score --answer-cmd CMD` run `CMD` per packet (prompt on stdin, answer on stdout). Answers must be gathered without access to the source, gold or other configs' packets. Scoring: `unknown` is an abstention; any other non-matching answer is a confident wrong answer, reported separately because it is worse. Reported per config: accuracy, unknown rate, wrong rate, missing, total material tokens and tokens per correct answer (total material tokens of the config's questions / correct answers), on the config's own questions and on the common subset every config has a packet for (use the common subset to compare Ghidra). Per-question table and the list of wrong answers go in `score.md`; `score.json` has the same data.

```
node --import tsx scripts/bench/llm-tasks/run.ts fetch-sources --sources SRC   # brotli.c; sqlite3.c from the pinned amalgamation
node --import tsx scripts/bench/llm-tasks/run.ts build --repo CHECKOUT --out OUT \
  --binary sqlite3-arm64=PATH --binary brotli=PATH --ghidra DIR --sources SRC       # CHECKOUT needs a built dist/
node --import tsx scripts/bench/llm-tasks/run.ts score --packets OUT --answers ANSWERS_DIR
```

**Variant.** `--variant sqlite3-dylib` runs the same SQLite questions over `libsqlite3.3.54.0.dylib` (SHA-256 `cbd373e6…0205`, same function bodies, addresses in `questions.json` `variants`); there is no archived Ghidra output for it, so Ghidra comparisons use the executable.

**Dry run (packet sizes only, no answers; checkout `6e45fa01`, 42 questions, material bytes of the 21 distinct functions repeated per question).** Per config over all 42 questions on the executable: `mcp-default` 418,317 B (median 2,823, max 66,093; ~116.2 k est. tokens), `export-file` 379,149 B (median 2,147, max 65,375; ~105.3 k), `disasm` 546,271 B (median 2,622, max 105,307; ~151.7 k), `ghidra` 9,041 B over its 16 questions (median 607, max 892; ~2.5 k). On those same 16 questions: `mcp-default` 39,060 B, `export-file` 27,007 B, `disasm` 31,892 B, `ghidra` 9,041 B. Open Decomp states: 4 complete, 38 partial (no failures) for both MCP and export. The large packets are `main` (brotli, inlined option parser, 66 KB), `renameColumnFunc` and `sqlite3_incomplete`; the Ghidra archive covers only small functions, so size ratios from the common subset do not generalise to large functions. Accuracy is not measured yet.

`build` writes `OUT/packets/<config>/<id>.md` and `OUT/manifest.json` (checkout git HEAD and dirty flag, dist build time, node/bun/clang versions, binary and question-file hashes, function addresses, per-packet material bytes/tokens/SHA-256, tool state and call provenance). Use a fresh `OUT` per build. Run it as one heavy process; the SQLite import dominates.

**Results (2026-10-19, answerer Claude Haiku 5.5 via blind subagents: one fresh agent per config per run, reading only its config's packets; single run each, so per-question noise is real).** Run 1 is checkout `20676c6` (after the MCP text-first, prototypes, globals, literals, naming, call-interface, image-type, printer and ObjC slices); run 2 is `c8dceed` (adds the compact header/caveats, demand-first callee loading with noreturn import calls, and constant-data rendering: function names for code addresses, folded read-only loads, constant table contents, `field_0x…` member names). Ghidra and disasm packets are identical across runs.

| config (all questions) | run 1 correct / unknown / wrong | run 2 correct / unknown / wrong | run 2 tokens / correct |
| ---------------------- | ------------------------------: | ------------------------------: | ---------------------: |
| `mcp-default` (42)     |                      35 / 7 / 0 |                      41 / 0 / 1 |                  2,534 |
| `export-file` (42)     |                      35 / 5 / 2 |                      42 / 0 / 0 |                  2,497 |
| `disasm` (42)          |                      27 / 9 / 6 |                     27 / 11 / 4 |                  5,621 |

| Ghidra's 16 questions | run 1 correct | run 2 correct | run 2 material tokens | tokens / correct |
| --------------------- | ------------: | ------------: | --------------------: | ---------------: |
| `mcp-default`         |            13 |            16 |                 6,983 |              436 |
| `export-file`         |            13 |            16 |                 7,407 |              463 |
| `ghidra`              |            13 |            13 |                 2,518 |              194 |
| `disasm`              |            10 |            11 |                 8,866 |              806 |

The three questions every tool missed in run 1 (`sq-stricmp-case`, `sq-strnicmp-diff`, `sq-limit-hard-varnum`) need constant table contents (`sqlite3UpperToLower`, `aHardLimit`); run 2 prints those tables and answers all three. Other run-1 misses fixed by run 2: a destructor passed as a raw code address (now its function name), keyword strings reached through `base + offset` (now literals), a default quality loaded from read-only data (now folded), and a member named `f_36` read as decimal (now `field_0x36`). The single run-2 wrong answer is `bro-main-lgwin` in `mcp-default` (minimum window bits not identified in `main`'s 62 KB body; `export-file` answered it). Ghidra remains about 2.2× cheaper per correct answer on its 16 questions: its packets are short because its output omits what Open Decomp keeps explicit (call arguments such as `sqlite3_log`'s format arguments, open-arity markers, struct layouts), and it misses the three table questions.

## Persistent analysis cache: result-hit path and callee summaries (2026-10-20)

Host shared with other agents (load average 1.5–3), Node 26.11, ARM64 macOS, Homebrew brotli 1.2.0 CLI (64 functions) and SQLite 3.54.0 `libsqlite3.3.54.0.dylib`. Built CLI (`node dist/src/cli/entry.js`), serial runs, a fresh APFS-cloned project per trial, median of 5–15 runs; "Main" is `9f6ddf2` built in a separate worktree. Every output below was byte-identical across modes: `decompile --json` (pseudocode, state, diagnostics, evidence; same project ID via a copied import) for cold, second process with persisted summaries, in-process warm, result hit and `--no-analysis-cache` on brotli (`_CheckAlias`, `_ParseInt`, `_FileSize`, `_OpenFiles`, `_main`) and SQLite (`_sqlite3_changes64`, `_sqlite3_total_changes64`, `_sqlite3_errcode`); `export` directories of all 64 brotli functions were `diff -r` identical between Main, cold, `--no-analysis-cache` and a second export that reused only persisted summaries (results deleted).

| Wall time, ms (median)                                                                                      |  Main |  After |
| ----------------------------------------------------------------------------------------------------------- | ----: | -----: |
| (a) `_ParseInt` in a new process, after an earlier process ran `_CheckAlias` (shares one 2.6 M-work callee) | 1,029 |  1,023 |
| (a) same function, no earlier process                                                                       | 1,019 |  1,017 |
| (b) repeated identical `decompile` `_CheckAlias` (result hit, CLI)                                          |   424 |    400 |
| (b) repeated `decompile` `_main` (7.7 MB result delivered by artifact)                                      |   960 |    838 |
| (c) `export` all 64 brotli functions, `--jobs 1`, cold                                                      | 6,953 |  6,812 |
| (c) second `export` of the same project (all hits)                                                          | 3,506 |  2,885 |
| (c) `export` after an earlier `export --name _Brotli` process                                               | 6,903 |  6,828 |
| `--no-analysis-cache` `export` (no in-process unit reuse either)                                            |     — | 10,410 |

In-process result hit (one `openBinary` session, `_CheckAlias`, worker CPU per request): 32.7 ms → 21.7 ms for the first hit of a payload (payload parsed once, `validateComputation` no longer re-parses result/catalog/readset, the artifact is not looked up twice, one wrapper parse instead of ~6 full-result zod passes across `validateComputation`, `delivery`, handler, runtime and host) → 10.3 ms for later hits of the same payload (parsed payload memoized by the verified artifact hash). A CLI process spends ~400 ms outside this (startup, worker spawn, project and image-metadata load), so the CLI gain is the 12–120 ms above.

Sidecar growth (brotli, `du -sk`): import 6.7 MB; after `_CheckAlias` +4.4 MB (Main +4.4 MB; persisted summaries add ~12 KB because only small units are stored); after a full export 103 MB (Main 101 MB), of which `native_summaries` is 14 rows / ~3.7 MB when the size bound below is lifted. The cap is 64 MiB per project.

**What this does not deliver.** The expensive units are not worth persisting with the current encoding. A unit of prepared size ~32 k (1,633 instructions; 29.9 MB of JSON, 2.4 MB compressed) costs ~330 ms to encode and ~260 ms to load against ~450 ms to prepare; with it persisted, (a) fell 1,029 → 881 ms but every cold run rose to ~1,340 ms (+30 %) and cold `export` 6.9 → 7.9 s, so units of prepared size above 8,192 are not persisted (a loss on the first run costs more than a later reuse returns). Hash-consing equal sub-objects would shrink the JSON only 30 → 25 MB (measured), so a faster payload format, not a smaller graph, is what would change this. Below that bound, units write and load in a few ms (SQLite: 17 units, 1.7 MB compressed, reuse ≈ 0.15 s of a 2.0 s run). Callee summaries cut by a budget limit (`sqlite3_log`: 0.8 s of every SQLite `sqlite3_*` decompilation) are limit-dependent and, under the reuse contract, never cacheable. Reuse across a revision change is not offered: prepared evidence embeds the revision.

## Likely-inference precision (`scripts/bench/likely-precision.ts`, 2026-10-20)

`options.inference: "likely"` (roadmap R5, `git show 7301f55:TODO.md`) closes open `...` argument lists with two heuristics (docs/CORE.md, inference mode). Each firing heuristic records a `guess` inference; the harness decompiles functions in `likely` mode, joins every guess with source-derived ground truth and scores it. Ground truth is never read from the analyzed binary: the same sources are compiled with the host clang (`-O1 -g -gdwarf-5`, so called externals get declarations too) and `dwarfdump --debug-info` is parsed into per-function parameter counts, kinds/widths, result and variadic/by-value-aggregate flags (`complex`, not scored). A guess is correct when the printed argument count equals the declared parameter count of the callee; closing a variadic callee is always wrong; callees without source truth are unscored. Precision is reported per site and per distinct callee (a callee is correct only if every guess about it is), and the gate (`LIKELY_GATE` in `src/service/analysis/likely-arity.ts`) needs both at >=95% on at least 20 scored sites, pooled over targets. Coverage is guessed sites over open direct call sites whose callee has a scorable source arity. The truth already carries parameter kinds and widths and the result type, so pointer/result-type heuristics (the R4-dependent roadmap bullet, not implemented) add a scorer without changing the report.

Targets (all on Apple Silicon unless noted): `matrix` (dev-loop matrix, 12 symbol-bearing cells, 12 functions each; `scripts/bench/quality-matrix-corpus.c`), `fixtures` (Mach-O `macho-arm64-symbols` and `libcorpus-arm64-symbols.dylib`, `fixtures/source/{corpus,check}.c`), `sqlite` (the LLM-task `sqlite3-arm64` executable, SHA-256 `4e01e37e...7e56`, against the pinned 3.54.0 amalgamation `2da161e3...7243`; its compile options differ from the Homebrew build, so only names present in both are scored), `brotli` (Homebrew 1.2.0 CLI against the pinned v1.2.0 `tools/brotli.c`, with libbrotli entry points as imports). Callers are sampled deterministically by name hash (SQLite 250 of the defined functions, 237 decompiled; the others hit budgets or were unsupported). Run `final1` (`.local/r5-likely/runs/final1`, build of this branch):

| target / binary                                                              | functions decompiled | call records |     open direct sites with scorable arity |                    guesses | `callee_reads`                               | `caller_consensus`                             |
| ---------------------------------------------------------------------------- | -------------------: | -----------: | ----------------------------------------: | -------------------------: | -------------------------------------------- | ---------------------------------------------- |
| matrix (12 cells; the 4 ELF cells guess, the 4 Mach-O and 4 PE cells do not) |              12 each |            6 |                            1 per ELF cell | 1 per ELF cell (`crc32_z`) | 0                                            | 1/1 per ELF cell                               |
| fixtures (both)                                                              |              16 each |           28 | 1 (`fixture_stack_args`, stack arguments) |                          0 | 0                                            | 0                                              |
| sqlite                                                                       |                  237 |        1,342 |                                       889 |                         76 | 76/76 sites, 43/43 callees                   | 0 (hubs exceed 32 callers or callers disagree) |
| brotli                                                                       |                   16 |          212 |                                        43 |                         21 | 0                                            | 21/21 sites, 9/9 callees                       |
| pooled                                                                       |                      |              |                                           |                            | **76/76 sites (100%), 43/43 callees (100%)** | **25/25 sites (100%), 11/11 callees (100%)**   |

Both heuristics pass the gate on this evidence and `LIKELY_GATE` enables both. Limits that matter when reading it: the samples are small (a zero-error 43-callee sample is only consistent with a true precision of about 92% or better at 95% confidence; 11 callees with about 74%), `caller_consensus` was only exercised on brotli (libbrotli imports) and one matrix callee (`crc32_z`), coverage is low (SQLite: 76 of 889 open sites, the rest stay `...`; the largest remaining open callee is `sqlite3VdbeAddOp3` with 163 sites, not investigated), every guess was an exact count (no over/under/variadic errors), and a re-run on other code can move any number. The gate is therefore a measured observation, not a proof; `proven` stays the default.

Dev loop (`quality-dev-loop.py run --inference likely`, `--jobs 2`, label `r5-likely-c` against `base-de95fa4`): `open_arity` 132 -> 120 and est. tokens 78,527 -> 78,579 (the marker legend and wrappers cost more than the removed `...` in this small set); all other metrics unchanged. Only `adler32_z` and `crc32_z` (zlib entry points called from `matrix_checksum`) close, both correctly (3 parameters). The remaining dev-loop `...` are a truly variadic callee (`matrix_variadic`, correctly left open: its callee body escapes `va_list`, and Darwin variadic calls write stack arguments) and indirect callback calls, which no implemented heuristic covers. In default (`proven`) mode every dev-loop text is byte-identical to `base-de95fa4` (`diff -r` over all 200 texts, label `r5-proven-b`).

### Likely pointer and result types (roadmap R5, harness extended 2026-10-20)

The harness now also scores `parameter_type` and `result_type` guesses: a guessed pointer is right when the DWARF-declared formal (or result) is a pointer. Formals are compared by position only when the printed formals (the escaped-frame stack base excluded) and the declared formals agree in number and none is a float; other functions are unscored. Coverage of a type heuristic is its correct guesses over the declared pointer formals (results) that proven analysis leaves integer. A new target `brotli-lib` builds the pinned brotli 1.2.0 library sources (tag archive SHA-256 `816c96e8…dfec`) with the host clang for arm64 macOS at `-O0` and `-O2` without debug info and takes truth from a separate `-O1 -g` compile. Run `2026-10-20`, label `r5b-final`, all targets, default samples (matrix 12 cells x 12 functions, fixtures 2 x 16, SQLite 250, brotli CLI 16, libbrotli 150 per level; SQLite and the libraries are sampled by name hash, so these are samples).

Population (declared pointers that proven analysis prints as pointers / leaves integer): SQLite formals 309 / 62, results 3 / 21; libbrotli-O2 formals 162 / 51, results 1 / 8; libbrotli-O0 formals 43 / 222 (O0 spills formals into unpromoted frame slots, so uses stay invisible until R1), results 1 / 11; brotli CLI formals 13 / 3.

| heuristic (guess)                                                                                                      | scored guesses (pooled) |                   precision | coverage | gate                             |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------: | --------------------------: | -------: | -------------------------------- |
| `carried_word_formal` (formal only carried on, never computed with, and null-tested or in the first argument register) |                      25 |        100% (25/25 formals) |     6.8% | passes, enabled                  |
| `indirect_call_target` (formal reaches an indirect call/tail target)                                                   |                       8 |                        100% |     2.2% | fails `MIN_SITES` (20), disabled |
| `opaque_word_formal` (carried only, any position)                                                                      |                      85 | 70.6% sites / 68.8% formals |    16.3% | fails, disabled                  |
| `caller_argument_pointer` (every discovered caller passes a proven address)                                            |                       0 |                         n/a |       0% | fails, disabled                  |
| `caller_result_pointer` (every discovered caller treats the result as an address)                                      |                       0 |                         n/a |       0% | fails, disabled                  |

What the numbers say, including losses. `opaque_word_formal` is wrong exactly where the word is an integer: 18 of its 44 SQLite guesses are 32/8-bit `int`s or 64-bit `sqlite3_int64`/`size_t` that the function only passes on, and 5 of 23 in libbrotli-O2 are `size_t`. The caller heuristics never fired on the sampled functions: discovery is partial (SQLite: most functions have no discovered caller; e.g. `lockTable`, `sqlite3DbStrNDup`, `sqlite3ColumnType` have none), and a caller that passes its own formal unchanged is not "prepared", which the vote handles but cannot invent evidence. They fire in a small fixture (`test/service/likely-types-source.c`, `tag` and `fetch`, two agreeing callers each) and stay disabled. `carried_word_formal` passes on a small sample (25 guesses; a zero-error sample of 25 is only consistent with a true precision of about 89% or better at 95% confidence) and its coverage is 6.8% of the open pointer formals; SQLite alone has 10 of its guesses, all correct. Result types: 21 of 24 SQLite pointer results and 8 of 9 libbrotli-O2 results remain integer; no result heuristic reached any measurable site.

Pooled `caller_consensus` (arity, existing heuristic) now measures 44 scored sites at 86.4% (sites) / 77.8% (callees) on this larger corpus (libbrotli-O2: 25/31 sites, six `under` errors where a callee does not read a trailing declared formal), below the 95% gate; its `LIKELY_GATE` entry (set earlier on 4 scored sites) is now `false`: guesses are still recorded with `applied: false`, but `...` stays open. `callee_reads` is unaffected (78/78 on SQLite).

Dev loop (`quality-dev-loop.py`, `--jobs 2`): proven mode text of all 288 (cell, function) outputs is byte-identical (SHA-256 per file) between the integrate build (`0c0d794`) and this build.

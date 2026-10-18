# Performance and resource evidence

## Evidence archive setup

The 15 retained `.tar.gz` bundles are external assets, not git content. `scripts/bench/evidence-assets.json` pins every original repo-relative path, byte size and SHA256. The durable local copy is `~/Documents/open-decomp-evidence-archives/`, preserving those paths. The working store is `$OPEN_DECOMP_EVIDENCE_DIR`, or `<repo>/.local/evidence` when unset. No public download location is currently configured.

```sh
node --import tsx scripts/bench/fetch-evidence.ts
# Equivalent explicit source:
node --import tsx scripts/bench/fetch-evidence.ts --from "$HOME/Documents/open-decomp-evidence-archives"
# Fetch one bundle by basename (the original repo-relative path also works):
node --import tsx scripts/bench/fetch-evidence.ts --only baseline-2026-10-17.tar.gz
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
node --import tsx scripts/bench/fetch-evidence.ts --only baseline-2026-10-17.tar.gz
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
node --import tsx scripts/bench/fetch-evidence.ts --only baseline-2026-10-17.tar.gz
python3 scripts/bench/quality.py prepare --destination .local/performance/quality-reviewed
```

Use Python 3.12+, a built production CLI, Ghidra 12.1.4 with a working host-native decompiler, and the separately provisioned `xjoker/ghidra-mcp` bridge pinned to `73ea1c8eaa4bb364f7338f8180e623583bb1d340` (`uv sync --locked --python 3.13`). `quality-ghidra.py` bootstraps that unchanged upstream runtime on Python's main thread with headless AWT settings; target operations still use MCP. The baseline manifest records dependency/build hashes. The Homebrew bottle's fully expanded compiler invocation and precise clang version are unavailable; retained recipe flags are not a byte-reproducible source-build claim.

```sh
python3 scripts/bench/quality.py run \
  --inputs .local/performance/quality-reviewed \
  --output "$HOME/Documents/open-decomp-quality/smoke" \
  --ghidra-bridge "$HOME/Documents/open-decomp-quality-bridge" \
  --ghidra "$GHIDRA_HOME" \
  --java-home "$JAVA_HOME" \
  --input corpus-arm64 --function fixture_arithmetic --function fixture_direct \
  --cold-runs 1 --warm-runs 1
```

Outputs must use a new durable non-hidden directory outside `/tmp`: the exercised Ghidra stack rejects dot-prefixed project paths. Omitting selection/repetition flags records all 26 functions, three fresh projects per input/tool and ten repeated calls per function. `--profile default` and `--profile raised` remain separate populations. Requests are serialized under `.local/performance/quality.measurement.lock`; coordinate host use before making performance claims.

Both tools use the same Python stdlib newline-JSON-RPC client, identical binary/symbol/address access and no injected source/types/annotations. The harness records raw requests/responses, schemas, tool/component identities, first/repeated samples, cache and semantic states, emitted artifacts and hashes. Large analysis artifacts are read across bounded resource pages and size/SHA256 checked. No analyzed binary executes. Client latency includes transport and raw logging; the selected bridge still creates a new `DecompInterface` per call, so these records are not persistent-interface engine-speed evidence.

The exercised two-function smoke exited zero with eight matched C outputs, successful closes and both servers exiting zero. Arithmetic was complete, computed then cached; direct-call output remained explicitly partial, and its 630,962-byte artifact was retrieved across two pages. This smoke used the existing compiled application, not concurrent reconstruction changes, and supports harness functionality only. Durable smoke archive SHA256: `06e31569fd853ae44104c6d616d2ee263807f9dd406c7f7cbf2240bf3ce90587`; exact invocation and 80 member hashes are in `quality-evidence/smoke-2026-10-17.json`. Full-matrix, held-out, semantic/readability and normalized performance results remain separate gates.

## Broader source-known paired matrix

`quality-matrix-build.py` builds 24 inputs: Mach-O ARM64, PE x86-64 and ELF x86-64; independently built Apple clang 21.0.0 and Homebrew LLVM clang 23.1.3; `-O0`/`-O2`; symbol-bearing/truly stripped. These compilers share Clang lineage. The twelve selected functions cover multi-exit loops, real switch jump tables, aliases, aggregates, callbacks, variadic/mixed FP and an unchanged zlib 1.3.1 Adler-32/CRC-32 checksum workload—not full compression-library coverage. Exact flags, source/licenses, tools, disassembly and addresses are retained. All builds succeeded; stripping removed selected static names while preserving paired text-section hashes.

Reviewed inputs: `$EVIDENCE/scripts/bench/quality-matrix-inputs.tar.gz`, SHA256 `96863c3783347be3fe75279401c3f4bd9808d29e9f16daed845f4cc96fe5e250`, with 118 member hashes in `quality-matrix-inputs.json`. The unmodified zlib archive is `$EVIDENCE/scripts/bench/quality-matrix-zlib-1.3.1.tar.gz`, SHA256 `9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23`; upstream notices are retained.

```sh
node --import tsx scripts/bench/fetch-evidence.ts --only quality-matrix-inputs.tar.gz
python3 scripts/bench/quality-matrix.py prepare --destination .local/performance/quality-matrix-reviewed
python3 scripts/bench/quality-matrix.py run \
  --inputs .local/performance/quality-matrix-reviewed \
  --output "$HOME/Documents/open-decomp-quality-matrix-results" \
  --entry dist/src/cli/entry.js \
  --bridge "$HOME/Documents/open-decomp-quality-bridge" \
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
  --output "$HOME/Documents/open-decomp-heldout-new-inputs"
python3 scripts/bench/quality-heldout.py run \
  --inputs "$HOME/Documents/open-decomp-heldout-new-inputs" \
  --output "$HOME/Documents/open-decomp-heldout-new-results" \
  --entry dist/src/cli/entry.js \
  --bridge "$HOME/Documents/open-decomp-quality-bridge" \
  --ghidra "$GHIDRA_HOME" \
  --java-home "$JAVA_HOME"
```

Use the pinned bridge setup and a new durable output directory outside the system temporary directory; the shared measurement lock rejects overlapping harness runs. Commands, tool identities, raw requests/responses, full artifacts, source text and failures are retained in the external store (fetch using the command above); JSON indexes remain under `scripts/bench/`:

- `$EVIDENCE/scripts/bench/quality-heldout-inputs-2026-10-17.tar.gz`: 119,901 bytes; SHA256 `e6acbf080ee0b6203e99aa2ecec2aea4d475fa635fc7666737fcdb41ecf4d362`.
- `$EVIDENCE/scripts/bench/quality-heldout-results-2026-10-17.tar.gz`: 45,648,755 bytes; SHA256 `5f1f3f063a3298b89b1ce6b5e97280119d8f8dd2693aca6ca8cf52d79cbe5872`.
- `quality-heldout-results-2026-10-17.json`: scope, checkpoint, invocation, observations and member hashes.

Intermediate objects, project databases and duplicate streams are omitted; complete run objects remain in `comparison.json`. Uncompressed originals are in `~/Documents/open-decomp-quality-heldout-{inputs,results}-2026-10-17/`. Independent source gold, actual executable-output subset checks and blind readability reviews are separate lanes. This recording does not establish the parity gate.

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

Latency improves in 48/48 pairs (reuse/control median 0.54–0.72 across cells, reopen similar). Memory does **not** consistently improve (counterexamples above; sum-loop reopen heap +8.8 MiB; the 2 ms requested sampler achieved a 12.39 ms median interval, so most short fixture peaks are null, not 0). Cached SQLite leaf hits (~15.5 ms) remain slower than fixture hits (~4.3 ms), so repeated requests still depend on image size. P3.6 therefore stays open.

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

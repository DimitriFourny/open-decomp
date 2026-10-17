# Performance and resource evidence

## Status and method

These historical macOS measurements were captured after Node 24.22.0 strict checking, **695/695 tests**, compilation and **24 compiled MCP release scenarios**. Later F01/F02/F03 macOS correctness/installed evidence is recorded in [release verification](RELEASE-VERIFICATION.md); it does not recast these older measurements as a rerun of later bytes. **macOS arm64 / Node 24.22.0 is the verified execution host.** Linux/WSL using Linux Node is intended but has no host performance/qualification claim. Native Windows execution is outside the product requirement; Windows VM measurements are not a release gate and no further native benchmark run is required. Windows PE x64 is a statically analyzed target in the macOS measurements, not the measurement host.

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

| Budget | Default | Raised bounded profile | Raised full attempt |
| --- | ---: | ---: | ---: |
| Instructions | 10,000 | 50,000 | 1,000,000 |
| Blocks | 10,000 | 100,000 | 100,000 |
| IR nodes | 100,000 | 10,000,000 | 10,000,000 |
| Work units | 1,000,000 | 100,000,000 | 100,000,000 |
| Deadline, ms | 30,000 | 300,000 | 300,000 |
| Output bytes | 1,048,576 | 1,048,576 | 1,048,576 |

The smaller instruction limit does not relax work/block limits or claim whole-image coverage. Published partial function ranges cannot later be extended silently by raising a decompilation request's budget. Incomplete graphs fail without publishing an analysis artifact.

## Inputs

| Input | Bytes | SHA256 |
| --- | ---: | --- |
| Checked-in Mach-O ARM64 executable | 52,368 | `82680f1eaabe35cd05149ae943022b4abd51eea715cc642d861de404c86c9adf` |
| Checked-in PE x86-64 DLL | 13,312 | `ce6d13815457147570cd3975b1b2d8a2e9872b03a603bc0b7b32dc3f62ffecf3` |
| SQLite 3.54.0 macOS ARM64 | 2,069,752 | `8b694b0185a1d1130ccaeefa4e9969566788fb8460d478d21caee384327a9409` |
| SQLite 3.54.0 Windows x64 | 4,295,168 | `1d4dbbc37396c5de744e1a732540b8bc83cd89888f47e86365b726e5a813c5e7` |
| Node 24.22.0 macOS ARM64 limit probe | 122,503,472 | `b468fb9c67427c9d3aec07ee1105e63020923a631a9a2a00beb71a7ba3768bfd` |
| Node 24.22.0 Windows x64 limit probe | 93,882,184 | `ba93f9a70bd86fce3ebbb39ec758501458453467aa92a34a0a3602d1e3fc2b9c` |

Fixture manifest SHA256: `4cc7d85521038930efd31d44bb0cb3b1b6de1ce698b5fbb587375bafe4cc22d8`. The macOS Node probe reads the trusted host runtime's on-disk binary; it does not establish support for arbitrary Node applications or launch a separate analyzed program.

## Import and indexing

Run `4564be42-e5a7-485a-85d9-3af4c9d4fb9e`, after native code/data ownership and normalized-storage fixes. Times are milliseconds.

| Input / profile | Host import | Read/hash/load/snapshot | Index preparation | Publication/acknowledgement | Observed result |
| --- | ---: | ---: | ---: | ---: | --- |
| Small Mach-O / default | 250.22 | 10.56 | 15.28 | 21.69 | Complete |
| Small PE / default | 252.13 | 7.12 | 28.44 | 18.04 | Complete |
| SQLite Mach-O / default | 1,626.12 | 41.36 | 288.72 | 864.68 | Partial indexes published |
| SQLite Mach-O / raised bounded | 3,206.89 | 32.11 | 882.70 | 1,875.17 | Partial indexes published |
| SQLite PE / default | 495.02 | 62.69 | — | — | Work limit; no ready image metadata |
| SQLite PE / raised bounded | 4,491.32 | 60.41 | 1,099.71 | 2,354.20 | Native metadata complete; function index partial |

A complete `project_open` result describes its requested image operation, not complete discovery or semantic recovery of every function. Inspect each index state and layer-specific coverage. Failed import preparation leaves the immutable byte snapshot and inspectable failed job, not a falsely ready image; the harness checks this after reopening.

Selection uses the real entry point plus bounded public `functions_find` queries, including `analysis: "complete"`, then favors complete discovered graphs of substantive size. It is not an exhaustive ranking. The Mach-O header symbol remains visible as native metadata but no longer becomes a function merely because its mapping executes.

## Per-function pipeline and caches

The selected examples are small arithmetic functions at Mach-O `0x100000574` / PE `0x180001030`, a real SQLite ARM64 body at `0x10000d9ac` under the default profile, and a real SQLite x86-64 body at `0x14000e180` under the raised bounded profile. The first three emitted results are complete; the SQLite x86-64 result is explicitly partial / `unsupported_subset`. Complete discovery is not complete instruction/ABI/type semantics.

| Stage, ms | Small ARM64 | Small x86-64 | SQLite ARM64 | SQLite x86-64 |
| --- | ---: | ---: | ---: | ---: |
| Scope/cache lookup | 0.19 | 0.14 | 0.19 | 0.19 |
| Decode/CFG | 0.80 | 0.60 | 125.93 | 632.36 |
| Lift/IR validation | 0.39 | 0.63 | 1.92 | 1.31 |
| SSA/shared simplification/validation | 0.43 | 0.66 | 1.43 | 4.20 |
| Metadata/call preparation | 1.65 | 1.16 | 83.04 | 256.04 |
| Types/catalog/annotations | 4.46 | 2.24 | 116.62 | 383.24 |
| Structure/presentation setup | 0.04 | 0.03 | 0.77 | 0.55 |
| Emit/postprocess/cache publication/result validation | 16.12 | 13.59 | 245.79 | 780.55 |
| Handler total, overlapping above | 24.08 | 19.05 | 575.70 | 2,058.45 |
| Host uncached request | 27.46 | 21.16 | 579.23 | 2,065.94 |
| Host cached request, median of three | 9.47 | 7.90 | 239.75 | 774.03 |

The last emission-stage row is deliberately broad: it is not a measurement of text rendering alone. Large-input graph reconstruction still traverses the published image scope, and metadata/catalog/artifact processing remains substantial. The results do not justify switching languages or claiming a Rust-versus-JavaScript ratio.

Both small inputs computed three functions and served nine cache hits each. SQLite ARM64 computed two selected real bodies and served six cache hits in each profile; its true entry was instruction-truncated and correctly rejected. SQLite PE computed three selected bodies and served nine cache hits in the raised profile, retaining partial semantic coverage. These are selected-function results, not whole-program decompilation.

The largest individual worker lifetime RSS reported in this pipeline run was **1,649,098,752 bytes**; parent lifetime RSS was **150,175,744 bytes**. A small input file does not imply a small analysis heap. These are separate lifetime maxima, not a combined concurrent peak or a hard RAM ceiling.

## Sustained decoding, workers and serialization

Run `1e23af03-5632-43d3-abe9-7f90b7825134`: 100 batches per ISA, 32 real decode/format requests per batch, no failures.

| Adapter | Requests | Decoded instructions, with repetition | Median batch, ms | p95 batch, ms |
| --- | ---: | ---: | ---: | ---: |
| a64js | 3,200 | 1,126,400 | 34.85 | 40.56 |
| iced-x86 | 3,200 | 2,588,800 | 85.19 | 86.43 |

These workloads differ in instruction counts and content; the table is not a decoder-versus-decoder speed comparison.

| Parent retained heap, bytes | First post-GC | Last post-GC | Last 25 minimum | Last 25 maximum | External minimum | External maximum |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ARM64 workload | 43,692,424 | 43,993,672 | 43,961,056 | 44,060,224 | 4,103,692 | 4,103,692 |
| x86-64 workload | 44,946,016 | 44,848,896 | 44,827,256 | 44,881,104 | 5,414,412 | 5,416,460 |

Inputs and active adapters intentionally remain reachable during these samples. Retention stayed within the reported late-run ranges; this finite run is not proof of asymptotic leak freedom, and retained WASM/native allocator capacity is not by itself a leak.

The real pool owned two workers and rejected a third with `resource_limit`. Concurrent imports produced a running-notification peak of two, not a claim about simultaneous CPU execution. With queue capacity one, each three-request burst admitted two and rejected one. All admitted jobs completed. Sustained decompilation produced two computations and 198 cache hits, followed by actual close/reopen and disposal checks. Work, output and frame limits were exercised without successful artifact publication on the rejected paths. The resource harness removed its temporary projects.

| Real `binary_info` round trip | Samples | Payload bytes | Median, ms | p95, ms |
| --- | ---: | ---: | ---: | ---: |
| ARM64 project | 100 | 1,706 | 0.969 | 1.235 |
| x86-64 project | 100 | 2,124 | 0.968 | 1.205 |

Round trips include durable admission, SQLite/query work, validation, framing, scheduling and child telemetry. Separate serialization micro-measurements below use actual function-result payloads, 100 batches of 64 repetitions; values are median batch time divided by 64, in microseconds per operation. They exclude transport and schema validation and must not be subtracted from the round trips to claim exact IPC cost.

| Function-result payload | UTF-8 bytes | JSON stringify, µs | JSON parse, µs | Frame encode, µs | Frame decode, µs |
| --- | ---: | ---: | ---: | ---: | ---: |
| ARM64 | 48,768 | 27.21 | 43.87 | 33.65 | 46.51 |
| x86-64 | 79,263 | 42.04 | 66.55 | 52.47 | 70.22 |

The resource-run parent lifetime RSS was **351,272,960 bytes**, with final post-GC heap **46,540,344 bytes**. Largest individual child lifetime RSS was **301,400,064 bytes**. Child heap endpoints use natural GC and include imports, JIT, caches and durable job bookkeeping; boot-to-last differences are not isolated leak sizes.

## Limits found on larger inputs

These additional normalized-storage probes preceded the final Mach-O 1.0.3 ownership correction; they are retained observations, not same-revision speed comparisons. Full SQLite attempt run: `e037b515-bce4-4772-a926-975990be9a31`. Bounded Node attempt run: `004e8e8d-0f4a-424e-8170-fee323a38c7f`.

| Input / profile | Host import, ms | Explicit limiting result |
| --- | ---: | --- |
| SQLite ARM64 / raised full | 2,919.54 | Blocks: 100,001 against 100,000 |
| SQLite x86-64 / raised full | 5,410.48 | Blocks: 100,005 against 100,000 |
| Node ARM64 / default | 247.75 | Native symbol count exceeds 100,000 |
| Node ARM64 / raised bounded | 248.47 | Same native symbol cap |
| Node x86-64 / default | 416.86 | Work: 1,000,001 against 1,000,000 |
| Node x86-64 / raised bounded | 6,461.89 | Loaded-image metadata exceeds 64 MiB aggregate encoded budget |

No function success is claimed for the rejected Node imports. Raising a traversal budget is not a way around native parser/storage limits.

## Corrections driven by observations

- Real Node/SQLite PE unwind records exposed two compatibility errors: mapped non-code handler references were treated as malformed code, and reserved `UWOP_SET_FPREG` OpInfo bits were rejected. LLVM inspection and the native unwind contract supported the corrections; defined operands, frame requirements, ordering and record bounds remain checked.
- Repeated native-hint preparation and linear boundary scans exhausted work budgets. Per-image checked data indexes, indexed discovery ranges/seed lookups and one-instruction discovery requests removed that amplification without raising public traversal caps. Earlier SQLite ARM64 inspection reached 407,586 instructions and a genuine aggregate block cap; unique completed membership showed no duplicate-graph explanation for that limit.
- SQLite PE reached publication but failed because all metadata was one encoded record. Schema 4 stores bounded ordered facts atomically, retaining the 16 MiB individual-record cap and adding explicit 64 MiB aggregate / one-million-fact limits. Reopen, historical snapshots, malformed stored facts, rejected writes and migration rollback are exercised. These encoded-data limits are not RAM or total SQLite-file limits.
- A first apparent large ARM64 success was actually a header symbol interpreted as code. It is excluded from accepted function evidence. Native header ownership and section-membership rules now prevent that false seed; the benchmark uses existing public analysis-status filters to select genuine complete discovered bodies while retaining the true entry as an honest failure/success sample.

Different failure points, coverage and selected functions make those earlier runs unsuitable for a numeric speedup claim. Performance changes must preserve semantics and provenance, not merely reduce elapsed time by skipping unsupported or unvisited code.

## Regression procedure and retained evidence

For a comparison, keep runtime/hardware, input hashes, budgets, selected function IDs/addresses, coverage states, instrumentation and GC policy identical. Use an otherwise idle host, multiple fresh-process iterations and the sustained workload; compare per-stage distributions and late-run retention, not one favorable sample. Investigate changed work/coverage or missing telemetry before interpreting timing. No exact millisecond CI threshold or language speed ratio is established here.

Raw JSONL is retained locally under `.local/performance/`, not shipped as application runtime data. Hashes identify these captured observations; another run naturally has different IDs/timings/hashes.

| Local evidence file | SHA256 |
| --- | --- |
| `macos-sqlite-bounded-50000-owned.jsonl` | `50335b81928576f282ec77ddd2d3755eec5128332a6026d42c6caa95cc6cf1ff` |
| `macos-resources-100-owned.jsonl` | `038f555aaa9b7734a5c68e0feb4209c44ab06748ddf71acbb735dd6f74f61348` |
| `macos-sqlite-full-normalized.jsonl` | `56f8b894d665f0975761c1f1b0cbd2b0ccaeee7c8513dccd696abba0b737e3b3` |
| `macos-node-bounded-50000-normalized.jsonl` | `44ec106500c099a4d8de0d8551e37b54c9dafc6194589e82ef8c0373b269e81c` |
| `macos-release-current.jsonl` | `2c9dd46c2cbaf56dcececb4e0dff2eb75dfcc9cea78df6504915f1397d2620d0` |

Windows source acceptance, representative performance, and clean installed-artifact verification remain separately recorded gates. QEMU TCG results, when available, will be labeled emulated-host observations rather than native Windows throughput or an SLA.

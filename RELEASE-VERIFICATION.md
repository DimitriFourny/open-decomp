# Local release verification

## Current status

The current F01/F02/F03 macOS development checkout passed strict typechecking, **852/852 tests** (six suites, zero skipped), compilation and actual compiled stdio acceptance for all **eight maintained fixtures and both dialects** under **Node 24.22.0**. Compiled HTTP/HTTPS additionally investigated all four ELF executable/shared symbol-bearing/stripped variants with both dialects, annotations, hash-paged artifacts, cache and full server restart. The corrected bounded-body implementation passed the retained eight-process overflow stress. A fresh immutable extension candidate from source **`0d3e40bd8e67d6d0afa02edbd5973d1239ff6b7a`** subsequently passed clean empty-cache offline installed acceptance on macOS, as recorded below. Frozen v0.1 archive results do not qualify these bytes. **The verified execution host and current first-local-release acceptance scope are macOS arm64 / Node 24.22.0.** Linux/WSL is intended but not host-qualified; native Windows execution is outside product scope, not a release blocker.

### Execution hosts versus analysis targets

| Role | Scope and evidence |
| --- | --- |
| Verified execution host | macOS arm64, Node 24.22.0: strict regression, compiled workflows, resources and exact-archive offline installed evidence below |
| Intended, unverified execution hosts | Linux, including WSL using **Linux Node and Linux filesystem/process APIs**; no host pass is inferred from ELF support or cross-compilation |
| Native Windows / `win32` Node | Outside the product requirement; historical failures and focused lifecycle observations retained below, not full native support |
| Analysis targets | Windows PE x64, macOS Mach-O ARM64, Linux ELF/System V x64, within documented subsets; statically analyzed without target execution |

Windows users are expected to run the tool under WSL rather than native Windows Node. No Windows/Linux VM, SSH setup, native install or native performance qualification is required for the current macOS release scope. No new Linux/WSL qualification project is being introduced. This is an explicit user scope correction, not a retroactive native-Windows pass or an erasure of earlier failures. Further native-host work was stopped by scope; its recorded outcomes remain historical.

macOS host: Darwin 27.0.0, arm64, Mac18,5, Apple M6, 12 logical CPUs, 16 GiB RAM. The current 852-test regression reported **91,318.200375 ms** and passed strict typecheck and build. The historical F01/F02 730-test regression reported 70,385.691125 ms; the earlier frozen 695-test run reported 71,099.741291 ms. These are verification durations, not performance SLAs.

The historical Windows environment was Windows 10 Enterprise LTSC 19044 x86-64, QEMU TCG, one virtual CPU and 4 GiB RAM. Earlier isolated runs used no guest network, shared host filesystem, credentials or target execution. An older frozen commit, `f059a4403a0d800bff071a51c5dfa9dc3793ed57`, passed 589 tests; that does **not** cover the current candidate. Native-Windows observations concern different OS APIs from WSL/Linux Node and establish neither full native support nor Linux/WSL qualification.

Frozen Windows candidate `c9ffe777e32a7bb8bb9afa5eedbc0008b35ca347` passed compilation, 21 x86 decoder cases and actual compiled decoding of both target formats, but its source workflow and lifecycle/bounded-worker cases failed. Oversized-ID handling **passed**, correcting the earlier screenshot interpretation. The run was stopped without a final test-run footer; its retained log and intervention history are below. A later **focused extracted-artifact** probe of frozen `7fe5f80` also failed: initialization took **2,929.086 ms**, import **14,752.847 ms**, then the stalled-output process did not exit before the **120-second watchdog**. No full suite was restarted.

PE target support and native-Windows execution are distinct. macOS cross-compiles PE fixtures and statically analyzes PE, Mach-O and ELF without a VM or executing target binaries. Native Windows host qualification is no longer a product/release requirement. Its observed I/O failures remain real evidence, not merely emulation slowness, and the later focused current-artifact lifecycle pass remains limited to that scenario. Neither result is a Windows throughput claim or a Linux/WSL host pass.

## F03 and bounded-body integration evidence

Source readiness was coordinated with the Windows stdio producer before the combined phase. A first integration run passed strict checking and 851/852 tests but exposed a second aggregate-`complete` assumption in artifact-only delivery; build correctly did not run. The changed official-SDK source workflow then passed its focused check. The final `npm run check` passed strict checking, **852/852**, six suites, no skip/cancel, and compilation. Retained logs:

| Evidence | Bytes | SHA256 |
| --- | ---: | --- |
| `.local/f03-integration-check.log` (retained failure) | 84,714 | `b85c6519ca5342bb5b7f488cf0394d1a794e4312ab00f5196af0a3f2aa30f259` |
| `.local/f03-workflow-focused.log` (1/1) | 261 | `84b1e4cea1419d59fdd197642e17ec4ba7879cfd9cfcc04e877412d884fe567f` |
| `.local/f03-integration-final-check.log` | 83,640 | `a92261dfdfbc3ffd5ca6314ae3e11383aa2a6b5334944e80453e50e9f76b07b0` |
| `.local/f03-compiled-release.jsonl` | 11,000 | `53de86a0f8ce2ad57b1a279b0dd9269568b4abc13de8edd3c678d14e6a532e7a` |
| `.local/extension-verification/f03-macos-http-https.jsonl` | 21,275 | `05de9822b43e0e07e67bb67813d5e198e58ff30005c5f0eadf856d63d256d099` |

The exact runtime executable was `/Users/df0/.npm/_npx/fee7060b69ab3f2d/node_modules/node/bin/node` (24.22.0). With its directory prepended to PATH, the commands were `npm run check`, `node --import tsx --test --test-name-pattern 'official SDK source-entry workflows' test/mcp/stdio.test.ts`, and `node dist/scripts/release-acceptance.js`. The compiled release driver produced **28 passed scenario records plus the completion record**: eight full investigations (Mach-O two, PE DLL two, ELF four), native variants, eleven rejected images, both original architectures' budget failures and unsupported-effect immutable resumes. It never executed targets.

Actual ELF coverage, first observed in coordinator artifact656 and again through compiled HTTP/HTTPS, is decode **4/4 complete**, lift **4/4 complete**, ABI **1/1 complete**, analysis **partial** because ELF DWARF is unavailable, and reconstruction **22/22 units** with explicit source uncertainty. Aggregate `partial` is truthful, including for symbol-bearing images. The workflow now requires unique complete machine-layer coverage with all units/no reasons, all reconstruction units, all-instruction emission mappings and closed evidence links. Artifact-only delivery must preserve the restored result's state/coverage and full emission; diagnostic wording is not pinned and gaps are not suppressed.

The actual HTTP/HTTPS CLI smoke used `dist/src/mcp/http/entry.js`, ordinary default workers, official SDK clients and existing compiled `callMcpTool`/`readAnalysis`/manifest helpers. Each of the four ELF fixtures on each transport emitted both dialects to different hash-verified artifacts, denied cross-principal project/artifact access, applied an asserted rename at revision **2→3**, recomputed both dialects, stopped/restarted the entire server process, and recovered both annotation and exact cached artifact identities. All baseline C/Python-like artifacts were respectively **93,375/93,654 bytes**, each **23 pages** at a requested 4,093-byte page size; text was **12,505/12,540 UTF-8 bytes**. Handles/digests and per-layer coverage are retained in the ten JSONL records. HTTPS ran with `NODE_EXTRA_CA_CERTS="$PWD/test/mcp/http-test-cert.pem"`; certificate verification was never disabled. The temporary investigation script was removed after retaining evidence.

### HTTP oversized-body error race

The previous compiled server pre-rejected oversized `Content-Length` while request bytes remained in flight. The retained eight-process labeled stress failed **5/8** with `ECONNRESET` at `oversized-body`; baseline `.local/extension-verification/http-boundary-before.json`, SHA256 `1f0963ac38402cf17a5a448d48345df662077a5be83bf0da3e19e1415c601fcd`. The correction uses the existing bounded reader/body deadline instead of early length rejection. It does not raise the **2,097,152-byte** acceptance/storage bound or drain an unbounded input.

After the successful build, eight concurrent `node .local/http-boundary-probe.mjs` processes each received **413** for **2,097,153 input bytes**, completed all labeled rejection stages and then received **200** for the healthy request: **8/8 passed, zero resets**. Full labeled stdout/stderr is retained in `.local/extension-verification/http-boundary-after.json`, **27,342 bytes**, SHA256 `06ddbf59e0531cf9bce7da1ae380707e97923a91dcc75f04831ef455abbf6278`. Separate compiled HTTP and HTTPS byte-accounting records observed **23-byte** 413 bodies, SHA256 `2d70a47133fe156cdbc4fac58837c81381e6c9078f34d17f9a9e6ce00c0306c4`. The temporary probe was removed only after retaining output. This is bounded-error delivery evidence, not a throughput or hard-RSS guarantee.

The reviewed source milestone and fresh candidate packaging/macOS installed prerequisites are satisfied by the immutable pair below. A fresh artifact containing the corrected execution-host documentation still needs its own exact-archive macOS installed acceptance. Native Windows compiled/installed/performance qualification is outside current release scope, not a pending prerequisite. Linux/WSL remains intended and unverified.

## Immutable F03 candidate and subsequent macOS installed qualification

After Main committed source **`0d3e40bd8e67d6d0afa02edbd5973d1239ff6b7a`**, the existing release driver packaged a fresh, previously absent output directory. No source changes or full regression reruns occurred during this phase. The driver performed its normal clean compilation and bundled all eight resolved production packages into **7,180 inventory files**, using Node **24.22.0** and npm **11.20.0** on macOS arm64.

Both immutable files are under `/Users/df0/Documents/projects/open_decomp/.local/release/local-0.1.0-elf-0d3e40b/`:

| File | Bytes | SHA256 |
| --- | ---: | --- |
| `open-decomp-0.1.0.tgz` | 7,508,205 | `ab61b6939c0b901d40ba4aac1a7a0339c8d6e4f47dfe9606801134a6d90ce341` |
| `open-decomp-0.1.0.tgz.release.json` | 983,773 | `b0057274787c659217ec39f2df575ce83471c5b7f590968d03211e88a59e6154` |

With the verified Node directory prepended to PATH, both commands exited **0**:

```sh
npm run pack:release -- --out .local/release/local-0.1.0-elf-0d3e40b
npm run verify:installed -- \
  --artifact /Users/df0/Documents/projects/open_decomp/.local/release/local-0.1.0-elf-0d3e40b/open-decomp-0.1.0.tgz \
  --fixtures fixtures/bin
```

The verifier validated this exact archive against its sibling manifest, copied both fixture manifests and all **27** indexed binary/malformed inputs to an external temporary root, installed with an initially empty npm cache using **offline / ignore-scripts / omit-dev**, checked the recorded inventory, and ran the installed public import, actual Mach-O/PE/ELF decoding with both ISA decoders, and four demangling cases exercising all three WASM engines. The real installed server/workers then passed **28 maintained scenario records plus release completion**: all eight full investigations with both dialects, native variants, typed rejected images, budget failures and unsupported-effect immutable resumes. The complete installed log contains **40 JSON records**, including final installed-acceptance completion. No target execution, source-runtime fallback, compiler dependency or network fetch was used by installed runtime verification.

Retained package log `.local/release/f03-0d3e40b-package.log`: **1,136 bytes**, SHA256 `6c3704d51d6f0f0d1a311ae21fc1d48337af343a508817f5beb6dccaf3bbed4d`. Installed evidence `.local/release/f03-0d3e40b-macos-installed.jsonl`: **19,346 bytes**, SHA256 `9a19217ca68a23592ab616c4d64fca5aafe6e81ad7387df47cd389a990f8d4d0`. Handoff `.local/release/f03-0d3e40b-handoff.json`: **14,262 bytes**, SHA256 `b3100bd746e9f4059e3671b0725dcbc0748ba39ebaf0f529db031b3541a2070a`; it records the full source identity, exact commands, artifact identities, current compiled harness/helper hashes, both manifest hashes and all 27 fixture identities.

**Snapshot boundary:** documentation inside this archive was captured at source milestone `0d3e40b`, before this installed run. Its then-pending packaging/installation statements are build-time history, not a contradiction or evidence of later verification. This section is a subsequent qualification record outside the sealed archive. Neither archive nor manifest was rewritten, and no repack was performed merely to include the archive's own hash.

This is an immutable **candidate**, not an implicit publication or a claim that every execution environment is qualified. Before the scope correction, WindowsNativeOps received this pair and the four-helper compiled harness/two-manifest/27-input staging contract. Historical native results below are retained; further Windows host/installed/performance work is no longer required. The pair remains unchanged while accurate scope documentation is prepared for a separately identified artifact.


## Historical F01/F02 macOS development evidence

The combined current worktree passed strict typecheck, all 730 tests and build before actual compiled CLI workflows. Independent read-only semantic/security reviewers found no evidence-backed defects within their scopes; that review does not expand the measured runtime scope.

The initial integration typecheck caught the old SDK three-argument call signature, which was corrected. An earlier 728/730 run exposed two HTTP harness mistakes: native Node `fetch` replaced the intended hostile Host header (confirmed with a real echo server), and closing a just-connected idle TCP peer could produce `ECONNRESET` (the partial-body peer separately returned 408). The Host probe now uses native `http.request`; the idle-close assertion permits only the expected reset. Focused 2/2 and the complete 730/730 run passed after these corrections. No production semantic/security failure was suppressed.

The compiled investigations used normal packaged-layout `dist` entry points, default real workers, official SDK clients and no target execution. For **each of stdio, HTTP and HTTPS**, the client:

- Imported symbol-bearing Mach-O ARM64 and stripped PE x64, and located a real arithmetic function.
- Emitted C-like and Python-like to distinct artifacts, compared mapped instruction sets, paged and hash-checked complete artifact bytes, and observed Python-like cache reuse.
- Applied an annotation at revision **2→3**, recomputed, and closed the project.
- Restarted the **entire server process**, reopened the same durable project/revision, and recovered the Python-like cache artifact.

HTTP/HTTPS additionally rejected missing credentials (**401**), hostile Origin (**403**) and cross-principal project/artifact access. Native TLS CLI execution used explicitly public test-only certificate material with an explicitly trusted CA via `NODE_EXTRA_CA_CERTS`; certificate verification was **never disabled**. Configuration raised request rates for artifact paging; this was an investigation/restart check, not a throughput benchmark.

Retained evidence: **14 JSONL records** in `.local/extension-verification/macos-stdio-http-https.jsonl`, SHA256 **`52462b1b29e8318f45e43f9afb0f776668b7170719f15746b65cea32ffaadab6`**. This qualifies the exercised macOS development behavior only, not a new installed artifact or Windows/release completion. [REMOTE.md](REMOTE.md) gives the private bearer/principal, native TLS and service-dispatch ownership boundaries.

## Reproducing the source-build acceptance

From the repository root, with lockfile dependencies installed:

```sh
npm exec --yes --package=node@24.22.0 -- npm run check
npm exec --yes --package=node@24.22.0 -- node dist/scripts/release-acceptance.js
```

With the verified Node executable already on PATH, the equivalent commands are `npm run check` and `node dist/scripts/release-acceptance.js`. The maintained harness accepts `--server-entry PATH --fixtures PATH`; fixtures is the `bin` directory alongside `manifest.json`, `elf-manifest.json` and `malformed`. It checks input hashes, launches the real official-SDK stdio client/server, emits JSON Lines evidence, and exits nonzero on an assertion or protocol failure. The client and corpus are developer acceptance assets, not installed runtime dependencies.

The earlier frozen first-local-release compiled macOS run passed 24 scenario records followed by `release-scenarios-complete` (separate from the F01/F02 workflows above):

- Four complete investigations: symbol-bearing and stripped Mach-O ARM64 executables and PE x86-64 DLLs. These inspect headers/bytes, follow strings/references/functions, read CFG/disassembly, decompile and page hash-verified artifacts, apply typed annotations, reject stale revisions, reanalyze, restart the **MCP server process**, verify active annotations and cache/artifact identity, retract edits, and resume persisted projects.
- Universal Mach-O explicit ARM64 selection and container-relative bytes; both PE executable variants' named imports, IAT references and file/VA/RVA/zero-fill reads; both Mach-O dylib variants' exports.
- Eleven malformed/unsupported container imports with exact typed failures, no published image/artifacts and inspectable revision-zero projects after reopening.
- Both architectures' instruction, IR-node and work limits, each attempted twice: durable failed jobs, no analysis publication, unchanged revisions, followed by ordinary computation and cache reuse.
- Recognized but unsupported ARM64 `dmb ish` and x86 `fld1` mutations: partial lifting, unavailable-semantics diagnostics and exact original-byte provenance. Replacing only the temporary input file after closing does not alter the project-owned image or cached artifact on resume.

The workflow records whether cancellation wins or the operation already finishes. Deterministic blocked-owner component cases—not a race-sensitive workflow outcome—establish cancellation-before-publication behavior. No acceptance scenario executes an analyzed target or imports a target-selected library/module.

## Criteria and evidence boundaries

| Criterion | Maintained evidence exercised by the regression/compiled runs | Boundary |
| --- | --- | --- |
| A01 loading | `test/loaders/{macho,pe,elf}/loader.test.ts`; compiled native variants and all four ELF workflows | Selected-slice completeness is distinct from unsupported other slices; ELF has explicit section-table/static-runtime limits. |
| A02 decoding | `test/decoders/{arm64,x86_64}/`; compiled disassembly | Decoder recognition is not semantic lifting support. |
| A03 navigation | `test/analysis/{discovery,references,targets}.test.ts`; `test/service/queries.test.ts`; compiled string/IAT/reference walks | Unresolved indirect edges remain explicit. |
| A04 ARM migration | `test/lifters/arm64/`, `test/abi/darwin-arm64/`; current typed-IR/source oracles | No exhaustive private legacy-suite equivalence claim; historical C output is not an oracle. |
| A05 x86 semantics | `test/lifters/x86_64/`, `test/abi/{windows-x64,sysv-amd64}/`; real compiler evidence | Documented scalar/common SIMD and ABI subset, not the whole ISA or x87/AVX reconstruction. |
| A06 shared analysis | `test/analysis/{ssa,values,effects,stack,calls,types}/`; `test/presentation/` | Widths, faults, aliasing, calls and provenance are checked on the regression corpus, not proved for every program. |
| A07 emission | `test/emitters/c/`, `test/mcp/http.test.ts`; frozen C-like artifact mappings and current compiled two-emitter workflows | C-like and Python-like machine-state pseudocode, not recovered source or a guarantee of executable C/Python. F01 evidence does not change frozen artifact contents. |
| A08 durability | `test/project/annotations/`; `test/service/analysis/pipeline.test.ts`; process-restart investigation | Lost mutation acknowledgements must be inspected, never automatically replayed. |
| A09 interface | `scripts/mcp-workflow.ts`, `scripts/release-acceptance.ts`; compiled stdio/HTTP/HTTPS workflows | Current macOS compiled and exact-archive installed workflows passed. Linux/WSL is intended but unverified; native Windows execution is out of scope. |
| A10 containment | `test/service/parser-containment.test.ts`, `test/workers/`, `test/mcp/{stdio,http}.test.ts`; compiled rejection/budget cases | Worker boundaries are fault containment, not an OS security sandbox; private HTTP authentication is not OAuth/SSO. |
| A11 delivery | Pinned build/toolchain, bundled candidate and empty-cache offline installed execution | Current exact-archive macOS closure/workflow passed; each new archive needs its own evidence. Native Windows install is not required. Notices preserve unresolved public-redistribution/source-provenance boundaries. |
| A12 resources | `PERFORMANCE.md`, real SQLite pipelines, sustained decoder/worker/IPC workloads | Recorded macOS measurements and actual cap failures; no Windows/Linux/WSL throughput claim or native-Windows measurement gate. |

## Migration cleanup and observed correction

The active sibling-API collector and its redundant generated-C files were removed. `fixtures/baseline/arm64.json` remains frozen historical evidence; current fixture generation, independent inspection, source oracles and SQLite schema migrations remain maintained. Fixture recipe hashes and historical instructions were updated. No sibling checkout is required by the current tests, compiled server or release harness.

The added universal-image scenario initially returned `partial/incomplete_index` solely because the **nonselected** Intel slice was unsupported. Mach-O loader 1.0.2 now forms selected-slice capabilities before adding container diagnostics. The ARM64 import/index is complete, the unsupported Intel slice and warning remain visible, and genuine selected metadata loss still yields partial indexes. The compiled scenario and a persistent-service regression both pass after the correction.

Large-input validation then exposed two additional correctness problems. Schema 4 now stores bounded ordered image facts instead of forcing all native metadata into one 16 MiB record; historical migration, replacement, corruption and rollback cases pass. Mach-O loader 1.0.3 preserves explicit header/load-command data ownership and requires section membership for function-symbol classification. The previous apparent SQLite ARM success at `__mh_execute_header` is excluded from useful-function evidence; actual complete discovered code bodies now decompile. PE SQLite also imports and emits selected code under a bounded partial-index profile. The full 24-scenario compiled suite passed again after both corrections.


## Frozen v0.1 private artifact and installed macOS acceptance

Before F01/F02 extension work, the maintained drivers ran after the then-complete regression check:

```sh
npm run pack:release -- --out .local/release/local-0.1.0-macos
npm run verify:installed -- --artifact /absolute/repo/.local/release/local-0.1.0-macos/open-decomp-0.1.0.tgz --fixtures fixtures/bin
```

The produced artifact is **7,432,793 bytes**, contains **7,143 inventory files**, and bundles all eight resolved production packages, including the transitive WASI shim. Node **24.22.0** and npm **11.20.0** were used. Archive SHA256: `10016938c5eb38c979b2b77f8914e6a7bdd28e4aad4de07f6793b3e07364c871`. Its sibling `.release.json` SHA256 is `aad4a8cb33ea59851dd7843beb6acd30f4e7ebc5861810f15908dd9e9c9fea97`; the manifest records npm integrity, lockfile SHA256 and inventory. It does not claim a clean Git build.

The verifier copied the archive and hash-checked fixture inputs into an external temporary root, installed offline with an initially empty npm cache and scripts/dev dependencies disabled, and verified every recorded installed file. The separate installed process successfully imported the public package, decoded real ARM64/x86-64 functions and exercised Itanium, Microsoft and Swift WASM demanglers. The installed server and workers then passed all 24 maintained MCP scenarios using only installed runtime files and copied inputs. The source checkout supplied the developer client/harness, not runtime fallback modules; inherited loader/module configuration was removed.

This corrects the observed preflight failure where `--help` worked but public import could not resolve installed `dist/vendor/a64js/src/decode.js`. The artifact now includes that compiled closure without a duplicate root vendor runtime. Temporary successful-install environments are removed by the verifier.

Retained JSONL evidence: `.local/release/macos-installed-acceptance.jsonl`, 35 records, SHA256 `df1c668ec3a3bc2fe75110637a6afc7986d43f432766708569ce6e4f437f3d28`. All 23 retained license/provenance assets match their inventory hashes and sizes; 21 local-package copies additionally match the installed source bytes exactly. That audit is `.local/release/license-assets.json`, SHA256 `4bf52ad789a91e50c5044988491356a99a56248eb38b24b4c7e32f00e830325a`. Neither successful installation nor matching notices resolves the public Arm generated-data review or establishes the unknown Swift WASM source revision.

This archive contains build-time documentation snapshots predating its installed run. These results identify these exact bytes; rebuilding after code or documentation changes produces a new artifact requiring its own recorded verification. Windows installation has not yet passed.

## Historical native Windows stdout diagnosis and focused observations

The frozen guest's test-owner inspector showed its remaining CLI child with `stdout.readableFlowing: false`, **71,002 bytes** read, an unfinished **585-byte** stdin stream, and a live project worker. Attaching to the blocked CLI failed while attaching to its test owner succeeded. This matches Node's documented [synchronous Windows standard-output pipe writes](https://nodejs.org/api/process.html#a-note-on-process-io): blocking inside the write prevents the same event loop from firing the 30-second deadline.

At guest time `2026-10-16T08:54:53.939Z`, diagnostic intervention resumed that child's output and ended its input through the owner inspector. The debugger was then detached. The existing frozen check advanced into its remaining cases; it was **not rerun**, and its earlier lifecycle failures remain failures. After two 90-minute observers had expired and the recovering run continued, the coordinator stopped only the verified `npm run check` command tree (root PID 4684); the runner reported exit 1. All **64,123 captured log bytes** were exported over the private UART to `.local/windows/evidence/c9ffe77-foundation.log`, SHA256 `3466c55a77e1a50c878b33154eeafe2e6fdb4995eb58e496583b7de609a7be99`. No final test-run summary was produced. The raw log confirms oversized-ID handling passed, correcting the earlier console interpretation, but records source workflow, EOF/backpressure/stalled-output and additional bounded-worker failures. Retained screenshots include `test-owner-pipes.png`, `frozen-pipe-released.png`, `post-intervention-log.png` and `stopped-failed-check.png` under `.local/windows/evidence/`. Subsequent focused diagnostic observations are below; no further native Windows qualification is required by the corrected scope.

`src/mcp/cli.ts` now uses asynchronous file-descriptor writes on Windows, handles partial writes, and makes the SDK await the actual write callback even for small frames. POSIX retains its readiness-driven stream writer: applying descriptor writes indiscriminately reproduced an actual `EAGAIN`/connection-close failure during SDK tool discovery on macOS. Native POSIX stream handling corrected it. The lifecycle regression also reaps the child before deleting its potentially Windows-locked project directory.

After correction, macOS strict typechecking, **695/695 tests** and compilation passed. A separate actual compiled-client probe paused a real imported project's output, observed exit **1** after **30,013.236292 ms**, then reopened that same project at revision **2**, closed it and observed normal EOF exit. This is exercised macOS behavior, **not a Windows pass**. It did not resolve native Windows host behavior; later native observations remain separately scoped below.

The corrected source was frozen at Git commit `7fe5f80ee68eb61389e982d90aeeec4d32a12263` before extension work. Its separately built archive, `.local/release/local-0.1.0-stdio-fix/open-decomp-0.1.0.tgz`, is **7,435,800 bytes** with **7,143 inventory files**, SHA256 `30f8f2631eac3821ab902e708242436139ebfd0d1eaf87fc229a2f90699c1a51`. Empty-cache offline installed acceptance passed again on macOS: public import, both decoders, all three WASM demanglers and all 24 MCP scenarios. The 35 retained records are `.local/release/macos-installed-stdio-fix-acceptance.jsonl`, SHA256 `c9f1c6af13fa0bfd5f0987ff023dbce5612350d2a8be896f6153b1c692c7b29e`. This identifies those frozen bytes only, not the current extensions.

The targeted Windows **extracted-artifact** probe of that exact archive initialized in **2,929.086 ms** and imported in **14,752.847 ms**, but its stalled-output case never exited before the **120-second watchdog**. Guest `fixed-stdio-probe.log` SHA256: `756d35430d4e36a04a187c817712e9c187e79341265ff5ac66a2090f329b02f2`. This remains a failed focused host check, not an npm-installed Windows acceptance pass. No full core suite was restarted. The historical failure is preserved, but native Windows qualification is outside the corrected product requirement rather than a current release blocker.

Current Windows source additionally tracks outstanding raw stdout writes. Healthy EOF allows the existing output promise/write callback to settle within the original 30-second deadline before destroying output; drained connections use normal exit. Only an abandoned Windows fd1 write still pending after transport/SDK shutdown and **all** owned workers finish cleanup uses self-termination with exit 1, avoiding Node's blocked libuv-threadpool exit join. POSIX readiness/EAGAIN handling remains unchanged. Native diagnostic `.local/windows/evidence/stdio-diagnostic-1.log` (**21,638 bytes**, SHA256 `a2a960b795814368aa4612453e9ce920579e8ed411df85e5e5f81f3b3d9a46e4`) proves worker/SDK cleanup returned and process-exit was reached before the original 120-second hang. The first isolated correction exited the stalled peer but incorrectly returned 1 on healthy EOF; its failure is retained in `stdio-candidate-1.log` (**36,775 bytes**, SHA256 `69686e391e22cf325c52713406ece1cc47814da106aac224b11f6aec8add2326`). The corrected isolated native diagnostic passed as detailed below; that does not establish current artifact/release/installed acceptance.

### Isolated native candidate2 diagnostic — passed, frozen-overlay scope only

WindowsNativeOps ran a fresh writable clone at `C:\verification\candidate-2-7fe5f80`, extracted from frozen source `7fe5f80ee68eb61389e982d90aeeec4d32a12263` archive SHA256 `30f8f2631eac3821ab902e708242436139ebfd0d1eaf87fc229a2f90699c1a51`, then applied the hash-bound diagnostic CLI overlay. The owned launcher `D:\run-stdio-candidate-2.ps1` refused an existing evidence root, checked archive/overlay/probe identities, and invoked `C:\verification\node-v24.22.0-win-x64\node.exe D:\stdio-stall-probe.mjs` from the cloned package. This was an isolated **frozen-overlay diagnostic**, not execution of the current `0d3e40b` artifact or a full Windows acceptance run.

The unchanged **120,000 ms** watchdog probe passed on actual Windows x64/Node 24.22.0. The abandoned-output peer exited **1** after **30,444.539 ms**; its owned workers finished at child-relative **44,092.386 ms**, before pending-write termination at **44,093.415 ms**. The same durable project reopened at revision **2**. For the healthy peer, EOF raced the final **1,431-byte** response's callback: settle began at **10,878.020 ms**, the callback succeeded at **10,879.258 ms**, then pending-write became false at **10,879.881 ms** before output destruction. All owned workers closed at **10,884.176 ms**, followed by normal exit **0** at **10,884.683 ms**. The probe observed EOF-peer exit at total **60,848.928 ms** and finished cleanup at **60,874.736 ms**, without watchdog firing. This directly exercises both the abandoned-write termination and healthy-callback-drain distinction.

Raw `.local/windows/evidence/stdio-candidate-2.log`: **30,697 bytes**, SHA256 `655f87eb8a96118fb4bc2dafbb8d6507fe8799ef3f959a4c550e652ac142bdd3`. Input identity record `.local/windows/evidence/native-candidate-2-inputs.json`: **1,557 bytes**, SHA256 `69dd1ec290fe93a664f90fbdd1d56b5d2ddb4bc4209478e60c7a6dc441ae7926`. The record binds overlay SHA256 `1fc26d0eea42f3623815fe25c6ad59fe13c8738188459738b3e49eac6e6b0953`, unchanged probe SHA256 `7aac0b1fe8ded12f0c6a2d709b552c960f796e172e52b841189f649527efe851`, launcher and media. Native UART command capture reported process exit **0**; one observer lacked only its trailing END marker, not the process/result evidence. No guest command was rerun to manufacture that marker.

This isolated diagnostic does not qualify F01/F02/F03 as a full native-Windows application or erase either earlier failure. Further native-Windows compiled/installed/resource qualification is outside current release scope, not a required follow-up; intended Linux/WSL host execution remains unverified.

### Current sealed artifact native lifecycle — passed, focused scope only

WindowsNativeOps subsequently ran the **unaltered current artifact**, not the diagnostic overlay: source `0d3e40bd8e67d6d0afa02edbd5973d1239ff6b7a`, archive SHA256 `ab61b6939c0b901d40ba4aac1a7a0339c8d6e4f47dfe9606801134a6d90ce341`, extracted package `C:\verification\current-0d3e40b\package`. The hash-bound `run-current-native.ps1` launcher checked current runtime `dist\src\mcp\cli.js` SHA256 `aa716b844c2b3ee4c1995338a21e7bd564bb1610da891eeb6fa8be99fcc2ed15` and unchanged probe SHA256 `7aac0b1fe8ded12f0c6a2d709b552c960f796e172e52b841189f649527efe851`, then invoked the probe with guest Node **24.22.0** from that extracted package. The **120,000 ms** watchdog was unchanged.

The focused native run passed with guest command **exit 0**: the stalled peer exited **1 after 30,423.255 ms**, the same durable project resumed at **revision 2**, and the healthy peer closed normally with **EOF exit 0** observed at total **61,519.688 ms**. Probe cleanup completed at **61,547.767 ms**, without watchdog firing. The raw log retains the expected 30-second stall diagnostic and **71,158 received bytes** before the abandoned output was reaped.

Evidence `.local/windows/evidence/current-native-0d3e40b.log`: **1,456 bytes**, SHA256 `fc18c2dc26e093f98df32e2f9e9613c4fcc2eadf1b3fabdf72df371f657370b9`. Input/staging identities are in `.local/windows/evidence/current-0d3e40b-inputs.json` (at this native result, SHA256 `25a65230469a14eb7fe80a39281478de0fdf964171c3a0cde776feeba4351a36`); they bind the sealed pair, current runtime, developer harness, both fixture manifests, 27 inputs, native launcher and execution media. This is current-byte Windows lifecycle evidence, **not** a frozen-overlay result, but it is still **extracted-artifact focused acceptance**, not clean installed acceptance or the full compiled eight-fixture/two-dialect suite. Those broader native checks were not completed and are no longer product/release requirements. No native-Windows, Linux or WSL host qualification is inferred.



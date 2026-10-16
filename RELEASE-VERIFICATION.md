# Local release verification

## Current status

The current F01/F02 macOS development checkout passed strict typechecking, **730/730 tests** (six suites, zero skipped), compilation and actual compiled **stdio, HTTP and HTTPS** investigation/restart workflows under **Node 24.22.0**. These exercise both C-like and Python-like emitters over the shared semantic pipeline. **No new extension npm artifact has yet been built/installed.** Frozen v0.1 archives separately passed 24 compiled release scenarios and empty-cache offline installed acceptance on macOS; those archive results do not qualify extensions or later bytes. Windows-host lifecycle acceptance remains blocked, with T29/T30/T31 still incomplete. This is not a declaration that A01–A12 are complete.

macOS host: Darwin 27.0.0, arm64, Mac18,5, Apple M6, 12 logical CPUs, 16 GiB RAM. The current 730-test regression reported **70,385.691125 ms**; strict typecheck, tests and build took **87.90 s** in total (coordinator raw record `artifact://584`). The earlier frozen 695-test run reported 71,099.741291 ms after the stdio correction below. These are verification durations, not performance SLAs.

The recorded Windows environment is Windows 10 Enterprise LTSC 19044 x86-64, QEMU TCG, one virtual CPU and 4 GiB RAM. The earlier isolated runs used no guest network, shared host filesystem, credentials or target execution. An older frozen commit, `f059a4403a0d800bff071a51c5dfa9dc3793ed57`, passed 589 tests; that does **not** cover the current candidate. POSIX-signal cases are intentionally inapplicable on Windows; EOF, backpressure, worker shutdown and persistence remain required host behavior.

Frozen Windows candidate `c9ffe777e32a7bb8bb9afa5eedbc0008b35ca347` passed compilation, 21 x86 decoder cases and actual compiled decoding of both target formats, but its source workflow and lifecycle/bounded-worker cases failed. Oversized-ID handling **passed**, correcting the earlier screenshot interpretation. The run was stopped without a final test-run footer; its retained log and intervention history are below. A later **focused extracted-artifact** probe of frozen `7fe5f80` also failed: initialization took **2,929.086 ms**, import **14,752.847 ms**, then the stalled-output process did not exit before the **120-second watchdog**. No full suite was restarted.

PE target support and Windows-host qualification are distinct. macOS can cross-compile PE fixtures and analyze them statically without a Windows VM. Windows remains a required application host: use focused compiled A01–A11 acceptance and required decoder/ABI smoke for process/pipe/filesystem/installer behavior, with A12 measurements tracked separately, rather than repeating the full architecture-independent TSX core suite. QEMU is sufficient for focused host checks; this is a real I/O failure, not merely emulation slowness, and TCG observations are not native throughput claims. Neither Windows-host support nor any A01–A12 criterion is removed.

## F01/F02 macOS development evidence

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

With the verified Node executable already on PATH, the equivalent commands are `npm run check` and `node dist/scripts/release-acceptance.js`. The maintained harness accepts `--server-entry PATH --fixtures PATH`; fixtures is the `bin` directory alongside its `manifest.json` and `malformed` directory. It checks input hashes, launches the real official-SDK stdio client/server, emits JSON Lines evidence, and exits nonzero on an assertion or protocol failure. The client and corpus are developer acceptance assets, not an installed application's runtime dependencies.

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
| A01 loading | `test/loaders/{macho,pe}/loader.test.ts`; compiled native variants | Selected-slice completeness is distinct from unsupported other slices. |
| A02 decoding | `test/decoders/{arm64,x86_64}/`; compiled disassembly | Decoder recognition is not semantic lifting support. |
| A03 navigation | `test/analysis/{discovery,references,targets}.test.ts`; `test/service/queries.test.ts`; compiled string/IAT/reference walks | Unresolved indirect edges remain explicit. |
| A04 ARM migration | `test/lifters/arm64/`, `test/abi/darwin-arm64/`; current typed-IR/source oracles | No exhaustive private legacy-suite equivalence claim; historical C output is not an oracle. |
| A05 x86 semantics | `test/lifters/x86_64/`, `test/abi/windows-x64/`; real compiler evidence | Documented scalar/common SIMD subset, not the whole ISA. |
| A06 shared analysis | `test/analysis/{ssa,values,effects,stack,calls,types}/`; `test/presentation/` | Widths, faults, aliasing, calls and provenance are checked on the regression corpus, not proved for every program. |
| A07 emission | `test/emitters/c/`, `test/mcp/http.test.ts`; frozen C-like artifact mappings and current compiled two-emitter workflows | C-like and Python-like machine-state pseudocode, not recovered source or a guarantee of executable C/Python. F01 evidence does not change frozen artifact contents. |
| A08 durability | `test/project/annotations/`; `test/service/analysis/pipeline.test.ts`; process-restart investigation | Lost mutation acknowledgements must be inspected, never automatically replayed. |
| A09 interface | `scripts/mcp-workflow.ts`, `scripts/release-acceptance.ts`; current compiled stdio/HTTP/HTTPS workflows | Frozen compiled/installed macOS stdio passed; current extensions have compiled macOS evidence but no newly installed artifact. Windows remains a distinct gate. |
| A10 containment | `test/service/parser-containment.test.ts`, `test/workers/`, `test/mcp/{stdio,http}.test.ts`; compiled rejection/budget cases | Worker boundaries are fault containment, not an OS security sandbox; private HTTP authentication is not OAuth/SSO. |
| A11 delivery | Pinned build/toolchain, frozen bundled artifacts and empty-cache offline installed execution | Frozen macOS closure/workflow passed; no extension artifact installed. Windows installed acceptance remains T31. Notices preserve unresolved public-redistribution/source-provenance boundaries. |
| A12 resources | `PERFORMANCE.md`, real SQLite pipelines, sustained decoder/worker/IPC workloads | macOS measurements and actual cap failures recorded; Windows measurements remain T30. |

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

## Windows stdout diagnosis and pending host correction

The frozen guest's test-owner inspector showed its remaining CLI child with `stdout.readableFlowing: false`, **71,002 bytes** read, an unfinished **585-byte** stdin stream, and a live project worker. Attaching to the blocked CLI failed while attaching to its test owner succeeded. This matches Node's documented [synchronous Windows standard-output pipe writes](https://nodejs.org/api/process.html#a-note-on-process-io): blocking inside the write prevents the same event loop from firing the 30-second deadline.

At guest time `2026-10-16T08:54:53.939Z`, diagnostic intervention resumed that child's output and ended its input through the owner inspector. The debugger was then detached. The existing frozen check advanced into its remaining cases; it was **not rerun**, and its earlier lifecycle failures remain failures. After two 90-minute observers had expired and the recovering run continued, the coordinator stopped only the verified `npm run check` command tree (root PID 4684); the runner reported exit 1. All **64,123 captured log bytes** were exported over the private UART to `.local/windows/evidence/c9ffe77-foundation.log`, SHA256 `3466c55a77e1a50c878b33154eeafe2e6fdb4995eb58e496583b7de609a7be99`. No final test-run summary was produced. The raw log confirms oversized-ID handling passed, correcting the earlier console interpretation, but records source workflow, EOF/backpressure/stalled-output and additional bounded-worker failures. Retained screenshots include `test-owner-pipes.png`, `frozen-pipe-released.png`, `post-intervention-log.png` and `stopped-failed-check.png` under `.local/windows/evidence/`. Further Windows qualification starts with the focused compiled deadlock/reopen/EOF reproducer, not another unattended full run.

`src/mcp/cli.ts` now uses asynchronous file-descriptor writes on Windows, handles partial writes, and makes the SDK await the actual write callback even for small frames. POSIX retains its readiness-driven stream writer: applying descriptor writes indiscriminately reproduced an actual `EAGAIN`/connection-close failure during SDK tool discovery on macOS. Native POSIX stream handling corrected it. The lifecycle regression also reaps the child before deleting its potentially Windows-locked project directory.

After correction, macOS strict typechecking, **695/695 tests** and compilation passed. A separate actual compiled-client probe paused a real imported project's output, observed exit **1** after **30,013.236292 ms**, then reopened that same project at revision **2**, closed it and observed normal EOF exit. This is exercised macOS behavior, **not a Windows pass**. The Windows branch and remaining guest failures still require their own host verification.

The corrected source was frozen at Git commit `7fe5f80ee68eb61389e982d90aeeec4d32a12263` before extension work. Its separately built archive, `.local/release/local-0.1.0-stdio-fix/open-decomp-0.1.0.tgz`, is **7,435,800 bytes** with **7,143 inventory files**, SHA256 `30f8f2631eac3821ab902e708242436139ebfd0d1eaf87fc229a2f90699c1a51`. Empty-cache offline installed acceptance passed again on macOS: public import, both decoders, all three WASM demanglers and all 24 MCP scenarios. The 35 retained records are `.local/release/macos-installed-stdio-fix-acceptance.jsonl`, SHA256 `c9f1c6af13fa0bfd5f0987ff023dbce5612350d2a8be896f6153b1c692c7b29e`. This identifies those frozen bytes only, not the current extensions.

The targeted Windows **extracted-artifact** probe of that exact archive initialized in **2,929.086 ms** and imported in **14,752.847 ms**, but its stalled-output case never exited before the **120-second watchdog**. Guest `fixed-stdio-probe.log` SHA256: `756d35430d4e36a04a187c817712e9c187e79341265ff5ac66a2090f329b02f2`. This is a failed focused host check, not an npm-installed Windows acceptance pass. No full core suite was restarted. Diagnostic-only follow-through is not a product fix or acceptance result; T29/T30/T31 remain in progress/blocked.

# Local release verification

## Current status

The current macOS implementation passes strict typechecking, **695/695 tests**, compilation and all **24 compiled release scenarios** under **Node 24.22.0**. The private artifact also passes an empty-cache, offline installation and the complete maintained MCP investigation suite on macOS. The frozen Windows run exposed CLI lifecycle failures; T29 remains in progress. Windows performance and clean-artifact acceptance remain separate release gates. This is not a declaration that A01–A12 are complete.

macOS host: Darwin 27.0.0, arm64, Mac18,5, Apple M6, 12 logical CPUs, 16 GiB RAM. The latest full regression run reported 66,989.748208 ms; this is verification duration, not a performance SLA.

Windows environment: isolated Windows 10 Enterprise LTSC 19044 x86-64, QEMU TCG, one virtual CPU, 4 GiB RAM. No guest network, shared host filesystem, credentials or target execution. An older frozen commit, `f059a4403a0d800bff071a51c5dfa9dc3793ed57`, passed 589 tests; that result does **not** cover the current candidate. Windows POSIX-signal cases are intentionally inapplicable; EOF, backpressure, worker shutdown and persistence still require execution.

Frozen Windows candidate `c9ffe777e32a7bb8bb9afa5eedbc0008b35ca347` passed compilation, 21 x86 decoder cases and actual compiled decoding of both target formats. The first host observer reached its 90-minute deadline without a terminal result; a second observer follows the same run, not a rerun. Subsequent guest-console inspection observed failed EOF, backpressure, stalled-output and oversized-ID lifecycle cases, with the test process still owning a CLI and project-worker pair. This is a real acceptance failure under investigation, not merely an observer expiry or an inferred pass. Retained guest screenshots are under `.local/windows/evidence/runner-{diagnostic,process-tree}.png`. Later macOS fixes are not covered by this older Windows snapshot.

## Reproducing the source-build acceptance

From the repository root, with lockfile dependencies installed:

```sh
npm exec --yes --package=node@24.22.0 -- npm run check
npm exec --yes --package=node@24.22.0 -- node dist/scripts/release-acceptance.js
```

With the verified Node executable already on PATH, the equivalent commands are `npm run check` and `node dist/scripts/release-acceptance.js`. The maintained harness accepts `--server-entry PATH --fixtures PATH`; fixtures is the `bin` directory alongside its `manifest.json` and `malformed` directory. It checks input hashes, launches the real official-SDK stdio client/server, emits JSON Lines evidence, and exits nonzero on an assertion or protocol failure. The client and corpus are developer acceptance assets, not an installed application's runtime dependencies.

The compiled macOS run passed 24 scenario records followed by `release-scenarios-complete`:

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
| A07 emission | `test/emitters/c/`; compiled artifact mappings | C-like machine-state pseudocode; not recovered or necessarily recompilable C. |
| A08 durability | `test/project/annotations/`; `test/service/analysis/pipeline.test.ts`; process-restart investigation | Lost mutation acknowledgements must be inspected, never automatically replayed. |
| A09 interface | `scripts/mcp-workflow.ts`, `scripts/release-acceptance.ts` | Compiled and clean installed macOS execution passed; current Windows execution remains a distinct gate. |
| A10 containment | `test/service/parser-containment.test.ts`, `test/workers/`, `test/mcp/stdio.test.ts`; compiled rejection/budget cases | Worker boundaries are fault containment, not an OS security sandbox. |
| A11 delivery | Pinned build/toolchain, bundled artifact and empty-cache offline installed execution | macOS closure and full installed workflow passed; Windows installed acceptance remains T31. Notices preserve unresolved public-redistribution/source-provenance boundaries. |
| A12 resources | `PERFORMANCE.md`, real SQLite pipelines, sustained decoder/worker/IPC workloads | macOS measurements and actual cap failures recorded; Windows measurements remain T30. |

## Migration cleanup and observed correction

The active sibling-API collector and its redundant generated-C files were removed. `fixtures/baseline/arm64.json` remains frozen historical evidence; current fixture generation, independent inspection, source oracles and SQLite schema migrations remain maintained. Fixture recipe hashes and historical instructions were updated. No sibling checkout is required by the current tests, compiled server or release harness.

The added universal-image scenario initially returned `partial/incomplete_index` solely because the **nonselected** Intel slice was unsupported. Mach-O loader 1.0.2 now forms selected-slice capabilities before adding container diagnostics. The ARM64 import/index is complete, the unsupported Intel slice and warning remain visible, and genuine selected metadata loss still yields partial indexes. The compiled scenario and a persistent-service regression both pass after the correction.

Large-input validation then exposed two additional correctness problems. Schema 4 now stores bounded ordered image facts instead of forcing all native metadata into one 16 MiB record; historical migration, replacement, corruption and rollback cases pass. Mach-O loader 1.0.3 preserves explicit header/load-command data ownership and requires section membership for function-symbol classification. The previous apparent SQLite ARM success at `__mh_execute_header` is excluded from useful-function evidence; actual complete discovered code bodies now decompile. PE SQLite also imports and emits selected code under a bounded partial-index profile. The full 24-scenario compiled suite passed again after both corrections.


## Private artifact and installed macOS acceptance

The maintained drivers ran after the complete regression check:

```sh
npm run pack:release -- --out .local/release/local-0.1.0-macos
npm run verify:installed -- --artifact /absolute/repo/.local/release/local-0.1.0-macos/open-decomp-0.1.0.tgz --fixtures fixtures/bin
```

The produced artifact is **7,432,793 bytes**, contains **7,143 inventory files**, and bundles all eight resolved production packages, including the transitive WASI shim. Node **24.22.0** and npm **11.20.0** were used. Archive SHA256: `10016938c5eb38c979b2b77f8914e6a7bdd28e4aad4de07f6793b3e07364c871`. Its sibling `.release.json` SHA256 is `aad4a8cb33ea59851dd7843beb6acd30f4e7ebc5861810f15908dd9e9c9fea97`; the manifest records npm integrity, lockfile SHA256 and inventory. It does not claim a clean Git build.

The verifier copied the archive and hash-checked fixture inputs into an external temporary root, installed offline with an initially empty npm cache and scripts/dev dependencies disabled, and verified every recorded installed file. The separate installed process successfully imported the public package, decoded real ARM64/x86-64 functions and exercised Itanium, Microsoft and Swift WASM demanglers. The installed server and workers then passed all 24 maintained MCP scenarios using only installed runtime files and copied inputs. The source checkout supplied the developer client/harness, not runtime fallback modules; inherited loader/module configuration was removed.

This corrects the observed preflight failure where `--help` worked but public import could not resolve installed `dist/vendor/a64js/src/decode.js`. The artifact now includes that compiled closure without a duplicate root vendor runtime. Temporary successful-install environments are removed by the verifier.

Retained JSONL evidence: `.local/release/macos-installed-acceptance.jsonl`, 35 records, SHA256 `df1c668ec3a3bc2fe75110637a6afc7986d43f432766708569ce6e4f437f3d28`. All 23 retained license/provenance assets match their inventory hashes and sizes; 21 local-package copies additionally match the installed source bytes exactly. That audit is `.local/release/license-assets.json`, SHA256 `4bf52ad789a91e50c5044988491356a99a56248eb38b24b4c7e32f00e830325a`. Neither successful installation nor matching notices resolves the public Arm generated-data review or establishes the unknown Swift WASM source revision.

This archive contains build-time documentation snapshots predating its installed run. These results identify these exact bytes; rebuilding after code or documentation changes produces a new artifact requiring its own recorded verification. Windows installation has not yet passed.

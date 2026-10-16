# Local release verification

## Current status

T29's macOS candidate passes strict typechecking, **669/669 tests**, compilation and the compiled release scenarios under **Node 24.22.0**. The current Windows snapshot has not yet completed verification; T29 remains in progress. T30 performance measurements and T31 clean-artifact installation/licensing documentation remain separate release gates. This is not a declaration that A01–A12 are complete.

macOS host: Darwin 27.0.0, arm64, Mac18,5, Apple M6, 12 logical CPUs, 16 GiB RAM. The full regression run reported 66,380.975292 ms; this is verification duration, not a performance SLA.

Windows environment: isolated Windows 10 Enterprise LTSC 19044 x86-64, QEMU TCG, one virtual CPU, 4 GiB RAM. No guest network, shared host filesystem, credentials or target execution. An older frozen commit, `f059a4403a0d800bff071a51c5dfa9dc3793ed57`, passed 589 tests; that result does **not** cover the current candidate. Windows POSIX-signal cases are intentionally inapplicable; EOF, backpressure, worker shutdown and persistence still require execution.

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
| A09 interface | `scripts/mcp-workflow.ts`, `scripts/release-acceptance.ts` | Compiled macOS execution passed; current Windows and clean installed-artifact evidence are distinct gates. |
| A10 containment | `test/service/parser-containment.test.ts`, `test/workers/`, `test/mcp/stdio.test.ts`; compiled rejection/budget cases | Worker boundaries are fault containment, not an OS security sandbox. |
| A11 delivery | Pinned build/toolchain and source-build execution | Clean package closure, notices and both-host installed acceptance belong to T31; not yet complete. |
| A12 resources | Work/output limits already exercised | Representative performance and sustained-use reports belong to T30; not yet complete. |

## Migration cleanup and observed correction

The active sibling-API collector and its redundant generated-C files were removed. `fixtures/baseline/arm64.json` remains frozen historical evidence; current fixture generation, independent inspection, source oracles and SQLite schema migrations remain maintained. Fixture recipe hashes and historical instructions were updated. No sibling checkout is required by the current tests, compiled server or release harness.

The added universal-image scenario initially returned `partial/incomplete_index` solely because the **nonselected** Intel slice was unsupported. Mach-O loader 1.0.2 now forms selected-slice capabilities before adding container diagnostics. The ARM64 import/index is complete, the unsupported Intel slice and warning remain visible, and genuine selected metadata loss still yields partial indexes. The compiled scenario and a persistent-service regression both pass after the correction.

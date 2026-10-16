# Redistributable native corpus (T02)

This is a trusted, first-party C corpus for **offline static analysis**. Inputs in `bin/` are actual Apple Clang/Apple ld and Clang/LLD output, not hand-built headers described as compiler output. `malformed/` contains explicitly identified mutations/extractions of that output. All authored source, recipes, tests and compiled corpus inputs are under [LICENSE](LICENSE). No private input, downloaded Arm reference material, Windows SDK, CRT object, compiler binary, system library, or sibling source file is bundled.

## Index and stable expectations

`manifest.json` is the machine-readable index. It records source/recipe SHA-256, complete compiler/linker/inspection commands, tool versions (and hashes where a version flag is unavailable), image hashes, independent LLVM report hashes, entry addresses, mappings, symbols, imports/exports, slice identities, raw function ranges, and every malformed mutation with expected disposition. Addresses are unslid hexadecimal VAs, not host addresses. PE RVAs and slice file offsets must not be substituted for VAs.

| Input under `bin/` | Target/type | Entry VA | Useful symbol expectation |
| --- | --- | --- | --- |
| `macho-arm64-symbols` | Darwin ARM64 executable | `0x100000a8c` (`_main`) | `_fixture_arithmetic` at `0x100000574`, file offset 1396, 20 bytes; imports `_puts` |
| `macho-arm64-stripped` | Same, executable symbols removed | `0x100000a8c` | `_fixture_arithmetic` absent from nlist; code and entry retained |
| `libcorpus-arm64-symbols.dylib` | Darwin ARM64 dylib | None | Exports `_fixture_arithmetic` at `0x43c` |
| `libcorpus-arm64-stripped.dylib` | Dylib, debug/local symbols stripped | None | Dynamic exports intentionally retained |
| `macho-universal` | Real lipo x86-64 + ARM64 executable | Selected ARM64 entry as above | ARM64 slice at file offset 32768, size 52368, byte-identical to thin symbol-bearing input |
| `pe-x86_64-symbols.exe` | Windows x86-64 PE32+ executable | `0x140001000` (`fixture_entry`, RVA `0x1000`) | Image base `0x140000000`; imports `KERNEL32.dll!ExitProcess` and `corpus-symbols.dll!fixture_check` |
| `pe-x86_64-stripped.exe` | Same, debug sections stripped | `0x140001000` | Imports unchanged |
| `corpus-symbols.dll` | Windows x86-64 PE32+ DLL | None (`/noentry`) | Exports `fixture_arithmetic` at `0x180001030`, file offset 1072; image base `0x180000000` |
| `corpus-stripped.dll` | DLL, debug sections stripped | None | Export names intentionally retained |

The DLL is not an empty shell: it contains all semantic functions, exported data, a real relocatable function-pointer initializer, a zero-filled global, Windows unwind metadata, and the complete source self-check. The EXE invokes its imported self-check and passes the result to `ExitProcess`, with no CRT dependency. Both EXEs deliberately import the same DLL name; the trusted execution driver isolates the stripped pair and renames its checked-in DLL copy to that import name.

`loader-expectations.json` records additional independently established data-symbol addresses, the Mach-O zero-fill section, PE raw-versus-virtual boundaries, relocation kind, string bytes and universal translations. In particular, Mach-O `__DATA,__common` is zero-fill even though the containing segment includes file padding. PE `.data` has raw size 512 and virtual size 532; its 20-byte tail is virtual zero-fill. The LLD `/debug:dwarf` image has a debug directory entry labeled CodeView with `PDBSignature=0`, not a valid RSDS/PDB identity; retain this distinction rather than inventing a PDB.

`metadata/*.txt` is captured LLVM 23.1.3 header/section/symbol/export/import/relocation/unwind/debug evidence; `*.disassembly.txt` is independent instruction evidence. These are inspectable text, not assembly parsed by our decompiler. The fixture-only `scripts/fixtures/inspect.ts` populates index facts and is **not** the production loader or its hostile-input policy.

### ELF / System V AMD64 corpus

The independent `elf-manifest.json` indexes LLVM cross-compiled Linux x86-64 inputs without rewriting the historical Mach-O/PE manifest or its pinned recipes. Generate it with the commands below before running ELF tests or the full investigation workflows. Generated artifacts are compiler outputs, not synthesized headers; generation never executes them.

| Output under `bin/` | Format/type | Native interface |
| --- | --- | --- |
| `elf-x86_64-symbols` / `elf-x86_64-stripped` | ELF64 ET_EXEC, linked base `0x400000` | Explicit analysis entry `fixture_entry`; dynamic corpus exports and `fixture_external` import |
| `libcorpus-elf-x86_64-symbols.so` / `libcorpus-elf-x86_64-stripped.so` | ELF64 ET_DYN | All existing `fixture_*` scalar/control/stack/memory/call/FP/vector functions and data; `fixture_external` import |
| `libfixture-native.so` | ELF64 ET_DYN, self-authored dependency | Exports `fixture_external(value) = value ^ 0x1234` |

Both main images record `DT_NEEDED libfixture-native.so`; that does not by itself attribute an individual undefined symbol to a library. Their stripped variants remove static/debug tables while retaining the dynamic interfaces. `fixture_entry` is intentionally **not** runnable Linux process startup: no CRT, syscalls, exit routine, kernel behavior or dynamic-linker execution is claimed. Shared-library internal corpus calls bind locally (`-Bsymbolic`) so source-call oracles have stable linked targets; the external native import remains dynamic.

`code/elf-x86_64/fixture_*.bin` is separate from PE `code/x86_64/`. ELF function extents come from `STT_FUNC` values and sizes, not next-symbol guesses or parsed assembly. `metadata/` holds independent LLVM header/section/program-header/symbol/dynamic/relocation reports and raw-byte disassembly. The ELF manifest pins sources, recipes, tools/versions/hashes, commands, image bytes, reports and ranges. Its workflow addresses are linked VAs derived from those compiler symbols, not hardcoded offsets or runtime ASLR guesses.

`test/fixtures/elf-manifest.test.ts` checks provenance, real executable/shared stripping, native interfaces, zero-fill and exact code ranges. `elf-semantics.test.ts` decodes and lifts the compiler bytes through the normal ELF/x86/SysV pipeline, evaluates the existing independent `expected.json` cases (including FP/vector, stack and physical-state call oracles), and checks observable results/memory rather than instruction counts or emitted spelling. This is test-owned IR evaluation, **not execution of the target binary**. MCP full investigations cover executable/shared symbols/stripped variants, explicit format/ABI and native-header checks, annotations/retraction, both emitters, restarted and reopened caches, and standard tools only. Installed acceptance copies and hash-checks both manifests' inputs outside the source checkout.

The dedicated `test/abi/sysv-amd64/fixtures/abi.c` corpus independently covers INTEGER/SSE banks, rollback on exhaustion of either bank, ninth-SSE/seventh-INTEGER stack arguments, INTEGER/SSE/mixed/reversed aggregate returns, hidden large-result buffers, red-zone-compatible negative accesses versus explicit larger frames, variadic AL, and 80-bit `long double` with sixteen-byte object stride. The compiler-evidence test feeds raw ELF bytes to the decoder; formatted LLVM text is never decoder input. Pointer/storage evidence does not claim x87 reconstruction.

ELF support requires ELF64LE EM_X86_64 ET_EXEC/ET_DYN, OSABI 0/3, bounded valid program/section tables and unique PT_LOAD mappings. Sectionless images, extended counts/indexes, ELF DWARF, PLT callable-entry recovery and runtime dependency/relocation/ASLR/IFUNC-result guessing are outside this subset. Native symbol-bearing inputs therefore still have unavailable debug types/signatures: aggregate analysis/reconstruction may truthfully be partial even when decode/lift/ABI are complete and every reconstruction unit/instruction mapping is emitted. SysV variadic declarations establish only a fixed prefix, not complete actual arguments; AL is an upper bound on vector-register use, not proof of arity.

Current macOS proof passed strict checking, 852 tests and build, compiled stdio investigations for all eight fixtures/both dialects, real compiled HTTP/HTTPS investigations for all four ELF variants, and exact-archive offline installed acceptance. Exact evidence is in [RELEASE-VERIFICATION.md](../RELEASE-VERIFICATION.md). This is static analysis on the verified macOS execution host, not Linux/Windows target execution. Intended Linux/WSL host use remains unverified; Windows users are expected to use WSL/Linux Node, not native `win32` Node. Native Windows host qualification is outside current release scope; no VM or target execution is required to cross-compile/analyze the corpus.

Generate only these SDK/CRT-free ELF inputs from the repository root with LLVM Clang/lld and repository Node/tsx dependencies:

```sh
LLVM_BIN=/opt/homebrew/opt/llvm/bin \
  node --import tsx scripts/fixtures/generate-elf.ts
LLVM_BIN=/opt/homebrew/opt/llvm/bin \
  node --import tsx test/abi/sysv-amd64/fixtures/generate.ts
```

`ELF_CC` and `LD_LLD` optionally override the compiler/linker; `LLVM_BIN` selects `clang`, `ld.lld`, `llvm-readobj`, `llvm-objdump`, and `llvm-objcopy`. No Linux SDK/headers/libraries, network, host Linux installation or target execution is required. Both generators use explicit target/entry/soname, disabled build IDs, stable source mappings and temporary-object cleanup. Byte identity is promised only for recorded artifacts/toolchains, not across LLVM versions. The first command writes the five images above, `fixtures/elf-manifest.json`, `fixtures/code/elf-x86_64/*.bin`, and corresponding `fixtures/metadata/<image>.txt` / `<image>.disassembly.txt`. The second writes `test/abi/sysv-amd64/fixtures/{abi.so,abi.disassembly.txt,abi.metadata.txt,evidence.json}`. Neither generator is part of builds or normal tests.

After intentional generation, the coordinator runs focused provenance, semantic and ABI evidence checks:

```sh
node --import tsx --test test/fixtures/elf-*.test.ts test/abi/sysv-amd64/compiler-evidence.test.ts
```

Compiled acceptance remains `node dist/scripts/release-acceptance.js`; it now investigates each supported format/ABI rather than treating all x86-64 inputs as PE. No ELF native-execution mode was added to `execute-trusted.ts`.


### Loader-independent function inputs

`code/arm64/fixture_*.bin` and `code/x86_64/fixture_*.bin` contain 16 compiler function ranges per architecture. `manifest.codeRanges` binds each raw file to its parent image, source symbol, VA, file offset, byte length and hash. They can be consumed immediately by decoder/lifter tests with no image loader or sibling checkout. Symbol-to-next-symbol extents can contain compiler alignment padding, especially x86 NOP/INT3 bytes; these bytes are not proof of reachable instructions. Use CFG reachability, do not call recognition counts whole-function semantic conformance.

## Source semantics and isolated oracle

* `source/corpus.c` / `corpus.h`: wrapping integer arithmetic, signed comparison/division, loops, volatile stack storage, aliased load/add/store, direct/indirect calls, 32-to-64-bit extension and masked variable shifts, ten integer arguments, binary64 arithmetic, 128-bit four-lane float/integer vectors, promoted floating varargs, and a referenced string.
* `source/check.c`: all 24 deterministic cases, with stable failure IDs 1–14 and exit 0 on success. The Mach-O executable additionally prints exactly `open-decomp trusted fixture v1\n`. Finite FP test values are exact; contraction is disabled. No signed C division by zero or `INT_MIN/-1` is claimed defined.
* `expected.json`: explicit arguments, results and memory-after expectations, independent of pseudocode wording.
* `inventory.json`: exact compiler-corpus signatures, semantic families, observed instruction families, historical API boundaries and corpus exclusions. It does **not** describe total product coverage: targeted tests separately cover ADC/SBB, partial-register writes, logical authentication boundaries, TLS, ordinal/delay imports, forwarded exports and Objective-C/Swift metadata. Advanced-vector and runtime limitations remain explicit.
* `test/fixtures/oracle.ts`: isolated source-level BigInt width/wrapping and IEEE-number/`Math.fround` reference semantics. It never executes a user image or imports the service. Current typed-IR evaluator suites compare these vectors and memory/call/branch effects rather than generated source spelling.

The trusted native harness establishes compiler-output behavior on compatible hosts; the mathematical oracle is an additional check, not a claim that a source evaluator decodes machine code. No tests or application modules load the sibling implementation. All normal fixture tests use checked-in bytes/results and require no network, private binaries, cross-compiler or target execution.

## Existing ARM64 API baseline

`baseline/arm64.json` is frozen historical evidence from direct calls to the reference **`decompile(bytes, options)` API**, not executions of its test suite or a current regression oracle. It retains image/reference/a64js hashes, input words/addresses, captured code, CFGs, mappings, diagnostics, source/API/rendered signatures and real process results. The migration-only collector and redundant C-file copies have been retired; historical command paths in the JSON describe that past run, not runnable current instructions. The reference implementation is neither vendored nor required.

Existing behavior coverage was inspected in `../disass_arm/test/decompiler-core/`: API byte/record validation and sparse CFGs; integer/flag widths; native arithmetic/loops/memory; stack aliases/escapes; typed and unknown calls; Darwin variadic conventions; pointer authentication; native presentation/type-recovery and structured CFG tests. The new corpus carries forward the applicable scalar/stack/call/memory families and adds real FP/vector compiler cases. It does not report those old tests as run or automatically import every old regression/private fixture.

Observed collection on macOS ARM64, Node **26.11.1** (collection host, not the project's Node 24 acceptance claim):

* All three Mach-O executable variants exited 0 with the expected stdout and empty stderr.
* Both dylibs were explicitly loaded by the trusted C `source/library-runner.c`, called through `int fixture_check(void)`, and exited 0. This driver is developer-only, never service functionality.
* Contracted arithmetic, signed max, loop, stack, memory, direct calls, division and width/shift functions have all instructions supported and no error diagnostics. Compiling their reconstructed C with Apple Clang `-std=c11 -O1 -fsanitize=undefined` succeeded; both the scalar/memory harness and corrected direct-call harness exited 0. The captured compile has one unsuppressed precedence-style warning in `fixture_width`; no UBSan stderr occurred in these runs.
* **EntryStatePrototypeBoundary:** source/API signature `uint32_t fixture_direct(uint32_t)` becomes a six-parameter rendered C prototype: source arg, `initial_sp`, `initial_x19`, `initial_x20`, `initial_x29`, `initial_x30`. The API explicitly warns about these requirements. The recorded direct-call harness supplies an aligned 128-byte backing array, a pointer to its midpoint as `initial_sp`, and all four initial register values. Calling the reconstruction as if it had the one-argument source ABI is invalid; an initial such harness was discarded and is **not** miscompilation/regression evidence. Preserve this source/API/output-signature distinction during migration.
* Raw indirect calls have explicit unresolved-contract errors despite 8/8 recognized/supported instructions. No signature is inferred from a callback name.
* Scalar FP: 1/6 supported; floating vector: 1/6; integer vector: 1/7; floating variadic: 11/14. Reachable unsupported semantics produce errors. The old public API rejects `double` signature types and ten-parameter signatures. Ten-argument raw instruction support (17/17) does not establish ABI support. The integrated `fixture_check` is also incomplete because of these families.
* PE execution was **not run** during collection: no Windows x86-64 host, Wine executable, or configured SSH host was available. The later isolated Windows verification runs the analysis application, not these target programs; it does not retroactively establish native PE execution. PE generation and independent static metadata collection did complete.

These observations are historical migration input, not the current support inventory. Current lifter, ABI, shared-analysis and emitter regressions exercise scalar/stack/call/memory and implemented FP/vector behavior against source-level semantic oracles, preserving explicit unsupported boundaries. Neither old instruction counts nor captured C text prove unexecuted families.

## Commands

Run all commands from the repository root. Fixture rebuilds are deliberately separate from `npm run build`.

### Offline fixture maintenance validation

```sh
npm run typecheck
node --import tsx --test test/fixtures/*.test.ts
```

These check hashes/manifest structure, independently pinned fields/bytes, exact universal slicing, stripping behavior, exports/imports and zero-fill, every malformed mutation, raw code/source binding, and the independent semantic vectors. They do not compile or execute fixtures. Captured API diagnostics and entry-state results are historical migration evidence, not passing tests of the new implementation. Run `npm run check` for the current lifter, ABI, analysis, emitter and service regressions; run `node dist/scripts/release-acceptance.js` for the compiled MCP scenarios.

### Trusted native behavior, no compiler or sibling required

On macOS ARM64 or Windows x86-64:

```sh
node --import tsx scripts/fixtures/execute-trusted.ts
```

Only the checked-in hash-matching corpus is accepted. macOS runs the three executable variants. Windows runs both executable/DLL pairs in an isolated temporary directory, including the stripped DLL under its required import name. On other hosts the driver fails explicitly; static tests remain usable. Coordinator verification on Node 24.22.0/macOS arm64 executed this driver: all three executable variants exited 0 with the exact expected output. Windows execution remains unverified.

For direct dylib checks on macOS with Command Line Tools (uses only a trusted driver):

```sh
clang -std=c11 -O1 fixtures/source/library-runner.c -o /tmp/open-decomp-library-runner
/tmp/open-decomp-library-runner "$PWD/fixtures/bin/libcorpus-arm64-symbols.dylib"
/tmp/open-decomp-library-runner "$PWD/fixtures/bin/libcorpus-arm64-stripped.dylib"
```

### Rebuild compiler inputs

Prerequisites for the full recipe: macOS, Apple Command Line Tools/SDK with ARM64 and x86-64 support, Apple Clang 21.0.0 (`clang-2100.3.34.2`), Apple ld 27037.1, Apple `strip`/`lipo`, LLVM/LLD 23.1.3 (`llvm-dlltool`, `llvm-objcopy`, `llvm-readobj`, `llvm-objdump`, `lld-link`), and the repository Node/tsx dependencies. No Windows SDK or CRT is needed. These were installed locally; no public tool download was necessary.

```sh
CC=/usr/bin/clang LLVM_BIN=/opt/homebrew/opt/llvm/bin LLD_LINK=lld-link \
  node --import tsx scripts/fixtures/generate.ts
```

Defaults are the recorded local tool locations; the three environment variables override them. The exact source paths and flags are in `manifest.commands`: C11, `-O1 -g`, no auto-vectorization, no FP contraction, no stack protector or builtin library substitution; explicit `arm64-apple-macos13.0`, `x86_64-apple-macos13.0` and `x86_64-pc-windows-msvc`; PE timestamp 0, explicit bases, no default libraries, DLL no-entry and EXE explicit entry. LLVM tools independently inspect every result. The recipe removes its temporary object/import-library directory on success.

Hashes pin the **checked-in** artifacts. SDK/tool/debug metadata/UUID changes may alter rebuilt bytes; do not promise cross-toolchain byte identity. After an intentional rebuild, inspect independent reports, review address/byte expectations in tests and `loader-expectations.json`, and run the current semantic suites. The historical ARM64 baseline remains bound to its recorded old image and is not regenerated. Do not derive expected semantic results from the decompiler under test.

## Malformed inputs

There are 13 explicit boundary cases: empty input; truncated Mach-O/PE headers; overrun/zero Mach-O load-command size; unsupported Mach CPU; fat slice outside the container; PE header/raw-section/import-directory overruns; unsupported PE machine; a real ARM64 function with a trailing incomplete word; and a real x86 direct CALL truncated to three of its five bytes. Each resolves to its parent bytes and exact mutation in the manifest. Fixture tests validate those mutations; current loader/decoder and actual-child containment suites enforce their reject/unsupported/incomplete distinctions without target execution.

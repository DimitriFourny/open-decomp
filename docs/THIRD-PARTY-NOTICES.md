# Third-party notices and provenance

The Open Decomp application and its first-party documentation are licensed under [MIT](../LICENSE). This notice records the separate copyright, license and provenance obligations for bundled dependencies; the application license does not relicense them or independently clear rights in third-party generated data. Archive-specific identities below refer to the locally packaged `open-decomp` 0.1.0 distribution.

Full dependency notices are retained verbatim under [licenses/](../licenses/), with UTF-8 byte sizes, SHA256 hashes and original paths in [licenses/inventory.json](../licenses/inventory.json). The upstream Swift text is identified separately by retrieval URL/date. Hashes identify those retained texts, not a legal opinion. Runtime dependency packages also retain their shipped notices in the bundled `node_modules`. Do not replace actual governing texts with the summary labels below or with npm metadata alone.

## Runtime dependency inventory

Exact package versions are pinned by the source `bun.lock`. Archive SHA256/SHA512 integrity, the `bun.lock` digest, Node/Bun tool versions, original source package metadata and archive inventory are bound by the produced archive's sibling schema-version-2 `<archive>.release.json` manifest. Its `bun_pack` inventory records file paths, sizes, modes, SHA256 hashes and bundled package names. An installed run is a separate verification event; documentation bundled inside that archive is only its build-time snapshot. Historical npm-built release manifests remain evidence for their original sealed archives.

| Component                         | Version / revision                         | Applicable notices retained here                                                                                                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a64js transformed decoder runtime | `aa0e547ca5313779c87e1e52d75687b12e985615` | [MIT code license](../vendor/a64js/LICENSE), [snapshot provenance](../vendor/a64js/README.md), [source/output hashes](../vendor/a64js/snapshot.json); generated-data review below.                                                                                                                          |
| `iced-x86`                        | 1.21.0                                     | [MIT](../licenses/iced-x86/LICENSE.txt), copyright 2018–present iced project and contributors. Official Node/WASM decoder; no native addon.                                                                                                                                                                 |
| `@modelcontextprotocol/core`      | 2.3.1                                      | [Full licensing-transition notice and license](../licenses/@modelcontextprotocol/core/LICENSE); see below.                                                                                                                                                                                                  |
| `@modelcontextprotocol/server`    | 2.3.1                                      | [Full licensing-transition notice and license](../licenses/@modelcontextprotocol/server/LICENSE); see below.                                                                                                                                                                                                |
| `zod`                             | 4.6.7                                      | [MIT](../licenses/zod/LICENSE).                                                                                                                                                                                                                                                                             |
| `gecko-profiler-demangle`         | 0.4.0                                      | [MIT](../licenses/gecko-profiler-demangle/LICENSE-MIT) OR [Apache-2.0](../licenses/gecko-profiler-demangle/LICENSE-APACHE); both exact texts retained. Used for local Itanium C++ demangling.                                                                                                               |
| `llvm-msvc-demangle`              | 0.2.0                                      | [MIT wrapper](../licenses/llvm-msvc-demangle/LICENSE), [LLVM/runtime notices](../licenses/llvm-msvc-demangle/THIRD_PARTY_NOTICES.md) and full texts below. Used for Microsoft C++ demangling.                                                                                                               |
| `swift-demangle-wasm`             | 1.0.2                                      | [MIT wrapper](../licenses/swift-demangle-wasm/LICENSE), copyright 2025 Yuta Saito; [exact package NOTICE](../licenses/swift-demangle-wasm/NOTICE), [actual upstream Swift license and Runtime Library Exception](../licenses/swift-demangle-wasm/Swift-LICENSE.txt). See discrepancy/source boundary below. |
| `@bjorn3/browser_wasi_shim`       | 0.4.2                                      | [MIT](../licenses/@bjorn3/browser_wasi_shim/LICENSE-MIT) OR [Apache-2.0](../licenses/@bjorn3/browser_wasi_shim/LICENSE-APACHE); transitive Swift WASI runtime.                                                                                                                                              |

Node 24.22.0, Bun 1.4.3 for package management, Node's SQLite implementation, operating-system libraries and the user's MCP host are separate prerequisites, not bundled application runtimes. Bun does not replace Node as the application/test runtime. The source-only acceptance client `@modelcontextprotocol/client` 2.3.1 and build/test dependencies are not shipped production dependencies; their own installed/source notices still apply when using the development checkout. Do not infer their inclusion in the application archive.

## MCP SDK licensing transition

The pinned SDK LICENSE files begin with a transition notice, which is preserved in full for **both shipped SDK packages**. They are not simply MIT licensed:

- All new code and specification contributions are Apache-2.0.
- Contributions whose authors consented to relicensing are Apache-2.0.
- Unconsented legacy contributions originally licensed MIT **remain MIT**; the notice conveys no rights beyond the applicable original license.
- Non-specification documentation contributions are [CC-BY-4.0](../licenses/CC-BY-4.0.txt); the full Creative Commons legal text is retained in addition to the SDK's transition notice.

The complete package texts, including the transition wording and Apache license, are in the linked files above. A manifest's simplified SPDX label does not supersede this transition. SDK project reference: <https://github.com/modelcontextprotocol/typescript-sdk>.

## a64js code and Arm generated-data provenance

The imported source is [DimitriFourny/a64js](https://github.com/DimitriFourny/a64js) at commit `aa0e547ca5313779c87e1e52d75687b12e985615`, from a tracked-clean checkout at import. Its code license is MIT, copyright 2026 a64js contributors; the retained license SHA256 recorded in the snapshot is `b18b6f1511d85fb279dfd0bbe45441bd80b531fbcce58498de166b27345d999a`.

This is a **transformed runtime snapshot**, not an unchanged source copy. TypeScript 5.9.3 erased types targeting ES2023/ESNext with `verbatimModuleSyntax: true`; an AST transformation changed static import/export `.ts` specifiers to `.js`. The transitive closure from `src/decode.ts` and `src/format.ts` contains 1,918 reachable runtime modules, including generated encoding tables. `snapshot.json` records original TypeScript and emitted JavaScript SHA256 values plus retained declaration hashes. No decode logic/generated instructions were hand-patched; first-party adapter completion is separate. The distribution uses `dist/vendor/a64js`; root `vendor/a64js` holds the provenance/license files, not a required sibling runtime checkout.

Upstream describes the committed tables as generated from Arm's **2025-12 A-profile A64 XML** release. The identified reference archive URL is:

<https://developer.arm.com/-/cdn-downloads/permalink/Exploration-Tools-A64-ISA/ISA_A64/ISA_A64_xml_A_profile-2025-12.tar.gz>

This URL is provenance, **not an installer download instruction**. The recorded review could identify the archive but could not obtain its governing license: developer.arm.com download fetches returned HTTP 403 and an archive-member license read returned 404. An unrelated Arm Performance Libraries EULA is not evidence for these ISA XML terms. Prior use of the archive by another project is not redistribution permission either.

The MIT notice covers a64js project code; it does **not** relicense separately distributed Arm reference material or settle the rights in derived generated data. **Public redistribution review of the generated tables and applicable Arm terms remains unresolved.** Private/local artifact preparation does not constitute public legal clearance. Preserve this boundary on updates and obtain the actual governing terms before making any public-distribution claim.

No raw Arm XML/HTML, reference archive, PDF/diff PDF, downloaded reference corpus or reference generator is included in the selected artifact. Do not add those separately licensed downloads to the distribution. Keep the exact revision and source/output hashes when updating; changing the Arm release is an explicit provenance/legal review, not an incidental rebuild.

## Microsoft demangler: LLVM and linked runtimes

The wrapper/build scripts are MIT licensed. Its WASM and generated AST declarations/schema contain LLVM code/information under **Apache-2.0 WITH LLVM-exception**, not the wrapper's MIT license alone. The retained [upstream.json](../licenses/llvm-msvc-demangle/upstream.json) identifies LLVM `llvmorg-23.1.3`, commit `0d261d1ca552c95a8f007e061c787ac7132fbcbc`, Emscripten 4.0.23 and emsdk commit `c0bb220cb6e6f4e0fabb6f6db9efd53390ef5e56`, with upstream file hashes.

Retain the package's complete [THIRD_PARTY_NOTICES.md](../licenses/llvm-msvc-demangle/THIRD_PARTY_NOTICES.md), including its resource-guard/arena/output-buffer/AST-adapter modification description, and all accompanying full texts:

- [LLVM.txt](../licenses/llvm-msvc-demangle/licenses/LLVM.txt)
- [emscripten-LICENSE.txt](../licenses/llvm-msvc-demangle/licenses/emscripten-LICENSE.txt) and [emscripten-AUTHORS.txt](../licenses/llvm-msvc-demangle/licenses/emscripten-AUTHORS.txt): MIT/University of Illinois/NCSA terms and authors.
- [libcxx.txt](../licenses/llvm-msvc-demangle/licenses/libcxx.txt), [libcxxabi.txt](../licenses/llvm-msvc-demangle/licenses/libcxxabi.txt), [libunwind.txt](../licenses/llvm-msvc-demangle/licenses/libunwind.txt) and [compiler-rt.txt](../licenses/llvm-msvc-demangle/licenses/compiler-rt.txt): LLVM runtime licenses/exceptions and retained notices.
- [musl.txt](../licenses/llvm-msvc-demangle/licenses/musl.txt): musl and included contributor notices.

These are exact copies from the installed pinned package, not newly selected license variants or shortened boilerplate.

## Swift: preserve the NOTICE, use the actual governing text

The wrapper's [MIT license](../licenses/swift-demangle-wasm/LICENSE) and [package NOTICE](../licenses/swift-demangle-wasm/NOTICE) are retained without alteration. That NOTICE describes the underlying Swift demangler as “Apache License 2.0 with LLVM Exception” and points to <https://www.swift.org/LICENSE.txt>.

The actual linked Swift license retrieved on **2026-10-16** is Apache License 2.0 followed by **“Runtime Library Exception to the Apache 2.0 License”**, not an LLVM-exception heading. The full actual text is retained in [Swift-LICENSE.txt](../licenses/swift-demangle-wasm/Swift-LICENSE.txt), SHA256 `2794ef94e7dc677a97ee7d02de93d21ec8cc14dddc8b2166c8607608ef43b78d`. The exception concerns portions embedded in binary products through compilation; do not replace the text with the wrapper NOTICE's label or treat this summary as a new exception/grant.

The underlying project is [swiftlang/swift](https://github.com/swiftlang/swift); the wrapper repository is [kateinoigakukun/swift-demangle.wasm](https://github.com/kateinoigakukun/swift-demangle.wasm). **The exact Swift source commit used to build the published 1.0.2 WASM has not been established.** A current license fetch does not establish that build revision. What is pinned is the published wrapper version, lockfile tarball integrity and installed WASM bytes, not an invented Swift commit:

```text
swift-demangle-wasm@1.0.2 npm integrity:
sha512-GM0+lb7jgGejx0K1GbTvzbN6aOrgrBum4Kq5iYEoXtRI/i6MHVLbo6Ru91StNcYhrTgGDtznBZ6oe/js4Kjr5A==
```

The exact lockfile integrity value, including punctuation, is authoritative; see the artifact's lockfile digest and retained build evidence. Source-revision uncertainty is an explicit provenance limitation, not a claim of public redistribution clearance.

### Observed installed-package WASM identities

These SHA256 values were read from the pinned dependency assets during notice preparation. They identify payloads, not a claim that an installed application/host test passed or that a WASM source revision is known.

| Package asset                                     | SHA256                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `gecko-profiler-demangle/index_bg.wasm`           | `9b98fbf2aaeb718905b3ff1a7f66de96c3ad261f47487c60d9735772923a1a2a` |
| `llvm-msvc-demangle/dist/llvm-msvc-demangle.wasm` | `ecf93c031232ab9737965f3b157c2d83696e0c4752f7044ee5cc1b50c8c1dfec` |
| `swift-demangle-wasm/dist/swift-demangle.wasm`    | `fa6a1978ec5b3d30eb0a458f8d9625668213ec5889145baf9ae4c0deaa651790` |

Demangling is bounded local display decoration. Neither a demangled name nor the presence of a WASM payload establishes ABI signatures, type layouts or instruction-semantic support.

## Fixture licensing and excluded inputs

[fixtures/LICENSE](../fixtures/LICENSE) retains the MIT notice for original fixture source, build/test recipes, fixture data and compiled corpus binaries under `fixtures/`, `test/metadata/fixtures/`, `test/abi/windows-x64/fixtures/`, `test/abi/sysv-amd64/fixtures/`, and the corresponding `scripts/fixtures/` and `test/fixtures/` files. The application-wide MIT grant is in the root [LICENSE](../LICENSE); the fixture-specific notice remains intact. Preserve the applicable copyright and full permission/warranty text when redistributing the corpus.

[FIXTURES.md](FIXTURES.md), the source checkout's `fixtures/manifest.json` and the Windows ABI fixture's `evidence.json` bind original source, recipes, compiler/linker versions, output hashes and independent inspection. Those corpus inputs are acceptance assets supplied explicitly to developer drivers, not installed runtime dependencies; the selected application artifact includes their documentation/license, not the fixture binaries. Compiler-output validation/native trusted-fixture execution and analysis-host acceptance are different evidence events.

Compiler/linker tools, system SDKs/libraries, sibling source checkouts, private inputs, external benchmark binaries, local VM disks/media and raw Arm downloads are not redistributed in this artifact. The fixture license grants no rights in them. Benchmark download references and upstream statements in [PERFORMANCE.md](PERFORMANCE.md) are provenance for separate developer setup, not independent clearance of every linked runtime component or permission to bundle those inputs.

## Maintaining these notices

On dependency/decoder updates, review the actual installed package files, preserve complete copyright/license/NOTICE/runtime authorship texts, update exact versions, package/WASM identities and `licenses/inventory.json`, and retain source/transformation provenance. Review changing SDK transition terms and unresolved Arm/Swift source questions explicitly. Have the release owner verify the final package inventory and offline installed behavior on each required host. The application's MIT grant does not change those third-party terms.

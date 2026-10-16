# Third-party notices

The wrapper and build scripts are MIT licensed. The WebAssembly binary and generated
AST declarations/schema contain code or information from the LLVM Project, under
Apache-2.0 WITH LLVM-exception. See `licenses/LLVM.txt` and `upstream.json` for the
exact source revision, files and SHA-256 hashes.

The build adds resource guards to the Microsoft demangler and arena, bounds
intermediate output buffers, and makes their cleanup exception-safe. These adaptations
are generated in `.build/`; the checksummed upstream sources remain unchanged.
The AST export is a new adapter. `MicrosoftDemangleNodes.cpp` supplies the upstream
AST; `ItaniumDemangle.cpp` supplies shared OutputBuffer virtual methods. Unused
demangler entry points are removed by link-time optimization.

The binary is compiled by pinned Emscripten and links its runtime/system libraries.
Redistribute the accompanying notices:

- `licenses/emscripten-LICENSE.txt` and `licenses/emscripten-AUTHORS.txt`:
  Emscripten MIT/University of Illinois/NCSA terms and authors.
- `licenses/libcxx.txt`, `licenses/libcxxabi.txt`, `licenses/libunwind.txt`,
  `licenses/compiler-rt.txt`: LLVM runtime licenses and exceptions.
- `licenses/musl.txt`: musl and included contributors' notices.

All license files are copied from the exact pinned LLVM/Emscripten sources during
the build and checked for inclusion in the final tarball. Keep these notices when
redistributing the generated runtime or WASM asset.

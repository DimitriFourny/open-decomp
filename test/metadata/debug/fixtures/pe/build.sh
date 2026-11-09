#!/bin/sh
# Rebuilds the PE/PDB fixtures from shapes.c with the Zig 0.17.1 toolchain: its bundled clang
# and LLD, `zig clang` and `zig lld-link` (`pip install ziglang==0.17.1` or the release
# tarball; `zig` on PATH). Freestanding: no CRT, no import libraries; unwind tables as every
# x64 image has them. /Brepro derives the PDB GUID from the output; the compilation
# directory, source prefix, PDB source path and /pdbaltpath keep the build machine's paths
# out of the image and the PDB, and -gno-codeview-command-line leaves out the compiler
# command line. Run from this directory. Byte identity is promised only for the recorded
# toolchain.
set -eu
CFLAGS="-target x86_64-windows-msvc -gcodeview -gno-codeview-command-line -funwind-tables
  -fno-stack-protector -fno-sanitize=all -fno-builtin -ffreestanding
  -fdebug-compilation-dir=C:\\open_decomp -fdebug-prefix-map=$PWD=C:\\open_decomp"
build() {
  # shellcheck disable=SC2086
  zig clang $CFLAGS $2 -c shapes.c -o shapes-$1.obj
  zig lld-link /nologo /nodefaultlib /entry:shapes_main /subsystem:console /debug /Brepro \
    /pdbsourcepath:C:\\open_decomp /pdb:shapes-$1.pdb /pdbaltpath:shapes-$1.pdb \
    /out:shapes-$1.exe shapes-$1.obj
  rm shapes-$1.obj
}
build O0 -O0                              # stack-pointer frames, as MSVC builds them
build O0-fp "-O0 -fno-omit-frame-pointer" # RBP frames set by UWOP_SET_FPREG
build O2 -O2                              # register and ranged locations, inlining
sha256sum shapes.c shapes-O0.exe shapes-O0.pdb shapes-O0-fp.exe shapes-O0-fp.pdb \
  shapes-O2.exe shapes-O2.pdb

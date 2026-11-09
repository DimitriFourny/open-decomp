#!/bin/sh
# Rebuilds the library-type fixtures (static compiler/linker fixtures; never executed).
#   libcalls-stripped: Debian gcc 14.2.0 on x86_64-linux-gnu (glibc 2.41), lazy-binding PLT,
#                      stripped: library calls reach their imports only through PLT stubs.
#   wincalls.exe:      zig 0.17.1 (`pip download ziglang`), mingw-w64 x86_64-windows-gnu,
#                      stripped; the functions are named by their exports only.
set -eu
cd "$(dirname "$0")"
gcc -O1 -fno-inline -o libcalls-stripped libcalls.c
strip libcalls-stripped
zig cc -target x86_64-windows-gnu -O1 -fno-inline -s -o wincalls.exe wincalls.c \
  -lws2_32 -ladvapi32 -luser32
rm -f wincalls.lib wincalls.pdb
sha256sum libcalls.c libcalls-stripped wincalls.c wincalls.exe

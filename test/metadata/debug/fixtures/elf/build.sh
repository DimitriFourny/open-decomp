#!/bin/sh
# Rebuilds the ELF debug-info fixtures from shapes.c (GCC 14.2 / GNU ld 2.44 on Debian x86-64).
# Run from this directory. Byte identity is promised only for the recorded toolchain.
set -eu
CC="${CC:-gcc}"
MAP="-fdebug-prefix-map=$PWD=/open_decomp"
$CC $MAP -g -O0 -o shapes-g shapes.c
$CC $MAP -g -gdwarf-4 -O0 -o shapes-dwarf4 shapes.c
$CC $MAP -g -O2 -o shapes-O2 shapes.c
$CC $MAP -g -gz=zlib -O0 -o shapes-gz shapes.c
# A stripped image and its separate debug file, matched by GNU build ID.
cp shapes-g shapes-stripped
objcopy --only-keep-debug shapes-stripped shapes.debug
strip --strip-debug --strip-unneeded shapes-stripped
objcopy --add-gnu-debuglink=shapes.debug shapes-stripped
# No build ID: matched by the .gnu_debuglink CRC-32 of the whole debug file.
$CC $MAP -g -O0 -Wl,--build-id=none -o shapes-nobuildid shapes.c
objcopy --only-keep-debug shapes-nobuildid shapes-nobuildid.debug
strip --strip-debug --strip-unneeded shapes-nobuildid
objcopy --add-gnu-debuglink=shapes-nobuildid.debug shapes-nobuildid
sha256sum shapes.c shapes-g shapes-dwarf4 shapes-O2 shapes-gz shapes-stripped shapes.debug \
  shapes-nobuildid shapes-nobuildid.debug

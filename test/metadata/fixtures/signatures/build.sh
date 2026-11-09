#!/bin/sh
# Library signature fixtures (provenance.json): a static library of two objects and a program
# linked with it, with and without symbols. Run from this directory.
set -eu
T=$(mktemp -d)
gcc -O2 -fno-asynchronous-unwind-tables -c sigfix1.c -o "$T/sigfix1.o"
gcc -O2 -fno-asynchronous-unwind-tables -c sigfix2.c -o "$T/sigfix2.o"
rm -f libsigfix.a
(cd "$T" && ar rcD libsigfix.a sigfix1.o sigfix2.o)
cp "$T/libsigfix.a" libsigfix.a
gcc -O2 -o sigfix-symbols sigfix-main.c libsigfix.a
strip -o sigfix-stripped sigfix-symbols
rm -r "$T"
sha256sum sigfix1.c sigfix2.c sigfix-main.c libsigfix.a sigfix-symbols sigfix-stripped

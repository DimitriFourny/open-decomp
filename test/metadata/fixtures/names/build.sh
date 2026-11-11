#!/bin/sh
# Callee alias name fixture (provenance.json): a freestanding program whose C++ function
# `scale(int, int)` is exported (`-rdynamic`), so a call to it resolves to the function
# and to its mangled export. Run from this directory.
set -eu
g++ -O1 -fno-asynchronous-unwind-tables -fcf-protection=none -nostdlib -rdynamic \
  -Wl,-e,entry -Wl,--build-id=none -o alias-exported alias.cpp
sha256sum alias.cpp alias-exported

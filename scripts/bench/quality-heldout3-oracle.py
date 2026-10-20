#!/usr/bin/env python3
"""quality-heldout2-oracle.py bound to the third sealed held-out suite.

Same generic harness (fresh dylibs from the private source at Apple clang 21 and LLVM clang 23
`-O0`/`-O2` plus a trap-mode UBSan build); the selection and the hash-pinned private models come
from quality-heldout3-selection.json. Also exposes cases/reference/native for
quality-heldout3-evaluate.py.
"""
import sys

sys.dont_write_bytecode = True
import quality_heldout_wrap as wrap

namespace = wrap.load('quality-heldout2-oracle.py', __file__, [
    ('Source-built native oracle for the second sealed held-out suite', 'Source-built native oracle for the third sealed held-out suite', 1),
    ("'quality-heldout2-selection.json'", "'quality-heldout3-selection.json'", 1),
    ("'heldout2_models'", "'heldout3_models'", 1),
])
cases, reference, native, main = (namespace[name] for name in ('cases', 'reference', 'native', 'main'))

if __name__ == '__main__':
    sys.exit(main())

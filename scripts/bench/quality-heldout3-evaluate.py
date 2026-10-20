#!/usr/bin/env python3
"""quality-heldout-evaluate.py bound to the third sealed held-out suite.

Same policy as quality-heldout2-evaluate.py (frozen header/name-binding/PE-long/worker policy plus
`#include <string.h>` so the real libc prototypes for the suite's strchr/strlen/memcpy/memset callees
are declared for every tool alike), with the selection, oracle and positional contracts taken from
quality-heldout3-*.
"""
import sys

sys.dont_write_bytecode = True
import quality_heldout_wrap as wrap

namespace = wrap.load('quality-heldout-evaluate.py', __file__, [
    ("'quality-heldout-selection.json'", "'quality-heldout3-selection.json'", 1),
    ("'quality-heldout-oracle.py'", "'quality-heldout3-oracle.py'", 2),
    ('#include <stdbool.h>\n', '#include <stdbool.h>\n#include <string.h>\n', 1),
])
namespace['CONTRACTS'] = wrap.contracts('heldout3')

if __name__ == '__main__':
    sys.exit(namespace['main']())

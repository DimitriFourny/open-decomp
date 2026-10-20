#!/usr/bin/env python3
"""quality-heldout-evaluate.py bound to the second sealed held-out suite.

Same header/name-binding/PE-long/worker policy as the frozen evaluator, with the
selection, oracle and positional contracts taken from quality-heldout2-*. The only
header difference is `#include <string.h>` so the real libc prototypes for the
suite's memcpy/strlen callee are declared for every tool alike.
"""
import sys

sys.dont_write_bytecode = True
import quality_heldout_wrap as wrap

namespace = wrap.load('quality-heldout-evaluate.py', __file__, [
    ("'quality-heldout-selection.json'", "'quality-heldout2-selection.json'", 1),
    ("'quality-heldout-oracle.py'", "'quality-heldout2-oracle.py'", 2),
    ('#include <stdbool.h>\n', '#include <stdbool.h>\n#include <string.h>\n', 1),
])
namespace['CONTRACTS'] = wrap.contracts('heldout2')

if __name__ == '__main__':
    sys.exit(namespace['main']())

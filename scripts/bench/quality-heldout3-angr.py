#!/usr/bin/env python3
"""angr-decompile.py bound to the third sealed held-out suite.

Run with the angr venv: `.local/angr-venv/bin/python scripts/bench/quality-heldout3-angr.py run
--inputs <inputs> --output <dir>`. Identical per-function fresh-worker procedure; the selection comes
from quality-heldout3-selection.json and the completeness check scales with the selected function count.
"""
import sys

sys.dont_write_bytecode = True
import quality_heldout_wrap as wrap

namespace = wrap.load('angr-decompile.py', __file__, [
    ("'quality-heldout-selection.json'", "'quality-heldout3-selection.json'", 1),
    ("len(result['runs']) == 24 and len(result['matched']) == 120",
     "len(result['runs']) == 24 and len(result['matched']) == 24 * len(frozen['selected_functions'])", 1),
])

if __name__ == '__main__':
    sys.exit(namespace['main']())

#!/usr/bin/env python3
"""quality-heldout2.py bound to the third sealed held-out suite.

Same 24-cell build and the same Open Decomp/Ghidra recording procedure (`build`, `run`); the
selection, private source directory, object name, libc-stub define and entry symbol come from
quality-heldout3-selection.json and `.local/quality-heldout3/source/`. `run` records decompilers
and must only be used at a measurement round.
"""
import sys

sys.dont_write_bytecode = True
import quality_heldout_wrap as wrap

namespace = wrap.load('quality-heldout2.py', __file__, [
    ('Build and record the second sealed held-out suite', 'Build and record the third sealed held-out suite', 1),
    ('quality-heldout2-selection.json', 'quality-heldout3-selection.json', 2),
    ('.local/quality-heldout2/source/', '.local/quality-heldout3/source/', 1),
    ("'heldout2.o'", "'heldout3.o'", 1),
    ('-DH2_STUBS_ONLY', '-DH3_STUBS_ONLY', 1),
    ('h2_entry', 'h3_entry', 3),
    ('Second sealed held-out equal-access recording', 'Third sealed held-out equal-access recording', 1),
    ("    quality.require([cell['id'] for cell in plan['cells']] == frozen['cells'], 'Built cells differ from the selection cell list')\n",
     "    quality.require([cell['id'] for cell in plan['cells']] == frozen['cells'], 'Built cells differ from the selection cell list')\n"
     "    lines = ''.join(f\"{cell['id']} {cell['input']['sha256']}\\n\" for cell in sorted(plan['cells'], key=lambda cell: cell['id']))\n"
     "    aggregate = __import__('hashlib').sha256(lines.encode()).hexdigest()\n"
     "    print(json.dumps({'aggregate_image_sha256': aggregate}), flush=True)\n"
     "    quality.require(aggregate == frozen['inputs_aggregate_sha256'], 'Built images differ from the pinned aggregate image hash')\n", 1),
])

if __name__ == '__main__':
    sys.exit(namespace['main']())

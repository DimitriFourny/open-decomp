#!/usr/bin/env python3
"""quality-heldout-packets.py bound to the third sealed held-out suite.

Identical seeded X/Y packet and sealed-map procedure; only the selection (review
questions, source SHA256) comes from quality-heldout3-selection.json.
"""
import sys

sys.dont_write_bytecode = True
import quality_heldout_wrap as wrap

namespace = wrap.load('quality-heldout-packets.py', __file__, [
    ("'quality-heldout-selection.json'", "'quality-heldout3-selection.json'", 2),
])

if __name__ == '__main__':
    sys.exit(namespace['main']())

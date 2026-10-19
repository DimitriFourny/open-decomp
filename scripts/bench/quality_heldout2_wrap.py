"""Run a frozen-suite script unchanged except for explicit, counted text substitutions.

The frozen evaluator/packet/angr scripts hardcode the frozen selection, oracle and
cell counts and must not be edited (pinned hashes). The second-suite wrappers load
the frozen file's text, apply the substitutions listed in each wrapper, fail loudly
if any substitution does not apply exactly the stated number of times, and execute
the result. Later fixes to the frozen scripts therefore flow into this suite, and
any change that breaks a substitution is detected instead of silently ignored.
"""
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
import quality

HERE = Path(__file__).resolve().parent
SELECTION = HERE / 'quality-heldout2-selection.json'


def contracts():
    """Evaluator CONTRACTS (return type, positional source parameter types) from the selection."""
    selected = json.loads(SELECTION.read_text())['selected_functions']
    return {item['name']: (item['signature']['return'], list(item['signature']['params'])) for item in selected}


def load(frozen, wrapper, replacements):
    """Compile `frozen` (file name in scripts/bench) with `replacements` [(old, new, count)]; return its namespace.

    `__file__` is the wrapper so scripts that re-invoke themselves as subprocess workers re-enter the wrapper.
    """
    text = (HERE / frozen).read_text()
    for old, new, count in replacements:
        found = text.count(old)
        quality.require(found == count, f'{frozen}: expected {count} occurrence(s) of {old!r}, found {found}; frozen script changed')
        text = text.replace(old, new)
    namespace = {'__name__': 'quality_heldout2_wrapped', '__file__': str(Path(wrapper).resolve())}
    exec(compile(text, str(HERE / frozen), 'exec'), namespace)
    return namespace

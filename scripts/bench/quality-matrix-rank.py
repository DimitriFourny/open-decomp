#!/usr/bin/env python3
"""Rank retained broader reviewed matrix gaps, without running any input binary.

Counts are function-cell occurrences and emitted opaque-effect occurrences, not
unique input programs. Symbol-bearing/stripped and compiler repetitions remain
in the denominator. Missing discovery and resource failures are separate lanes.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import re


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rank(path):
    data = json.loads(path.read_text())
    runs = [run for run in data['runs'] if run['tool'] == 'open-decomp']
    expected = {cell['id'] for cell in data['build_manifest']['cells']}
    if len(runs) != len(expected) or {run['cell'] for run in runs} != expected:
        raise ValueError('Every recorded broader matrix input cell is required exactly once')
    states, operations, semantic = Counter(), Counter(), Counter()
    noninstruction = defaultdict(set)
    other_effect_occurrences = Counter()
    families = defaultdict(lambda: {'cells': set(), 'occurrences': 0, 'examples': []})
    outputs = []
    for run in sorted(runs, key=lambda item: item['cell']):
        planned = next(cell for cell in data['build_manifest']['cells'] if cell['id'] == run['cell'])
        if (len(run['functions']) != len(planned['functions']) or
                {row['name'] for row in run['functions']} != {row['name'] for row in planned['functions']}):
            raise ValueError('Selected function denominator changed: ' + run['cell'])
        for row in run['functions']:
            key = (run['cell'], row['name'])
            states[row['status']] += 1
            operations[row.get('operation_reason') or 'none_reported'] += 1
            semantic[row.get('semantic_state') or 'not_reported'] += 1
            if row['status'] != 'text_returned':
                noninstruction[row['status']].add(key)
            if ((row.get('raw_result') or {}).get('error') or {}).get('code') == 'resource_limit':
                noninstruction['resource_failure'].add(key)
            for diagnostic in row.get('diagnostics') or []:
                if diagnostic['code'] == 'resource_limit':
                    noninstruction['resource_diagnostic'].add(key)
            for coverage in row.get('coverage') or []:
                for reason in coverage.get('reasons', []):
                    if reason == 'unresolved control flow' or 'control boundary remains unresolved' in reason:
                        noninstruction['unresolved_control'].add(key)
                    if 'source call interface is unresolved' in reason or 'established source contract' in reason:
                        noninstruction['unresolved_source_call'].add(key)
                    if 'Source metadata or type recovery is incomplete' in reason:
                        noninstruction['source_metadata_or_types'].add(key)
            output = row.get('output')
            if output is None:
                continue
            source = path.parent / output['path']
            if digest(source) != output['sha256'] or source.stat().st_size != output['bytes']:
                raise ValueError('Retained output identity mismatch: ' + str(source))
            outputs.append({'path': output['path'], 'sha256': output['sha256']})
            for match in re.finditer(r'opaque_effect\("((?:[^"\\]|\\.)*)"', source.read_text()):
                reason = json.loads('"' + match[1] + '"')
                if reason.startswith('Instruction family ') or reason.startswith('Unsupported ARM64 encoding '):
                    entry = families[reason]
                    entry['cells'].add(key)
                    entry['occurrences'] += 1
                    entry['examples'].append({'cell': key[0], 'function': key[1], 'output': output['path']})
                else:
                    noninstruction['environment_or_other_opaque_effect: ' + reason].add(key)
                    other_effect_occurrences[reason] += 1
    ranking = []
    for reason, entry in families.items():
        ranking.append({'reason': reason, 'function_cells': len(entry['cells']),
                        'emitted_instruction_occurrences': entry['occurrences'], 'occurrences': entry['examples']})
    ranking.sort(key=lambda item: (-item['emitted_instruction_occurrences'], item['reason']))
    return {'schema': 1, 'scope': 'All retained broader reviewed open-decomp matrix cells; not held-out or behavioral equivalence evidence',
            'comparison_sha256': digest(path), 'input_cells': len(runs),
            'selected_function_cells': sum(states.values()), 'result_states': dict(sorted(states.items())),
            'operation_reasons': dict(sorted(operations.items())), 'semantic_states': dict(sorted(semantic.items())),
            'instruction_ranking': ranking,
            'separate_noninstruction_gaps': {name: {'function_cells': len(keys),
                'cells': [{'cell': cell, 'function': function} for cell, function in sorted(keys)]}
                for name, keys in sorted(noninstruction.items())},
            'separate_opaque_effect_occurrences': dict(sorted(other_effect_occurrences.items())),
            'retained_outputs': outputs,
            'limitations': ['Instruction occurrence count is emitted opaque-effect sites, not dynamic frequency.',
                'Undiscovered, failed, and unvisited instructions cannot be inferred from absent output.',
                'Overlapping noninstruction categories are not summed into a semantic failure count.',
                'No target execution, performance comparison, parity, superiority, or modern-language claim.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('comparison', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = rank(args.comparison.resolve())
    text = json.dumps(result, indent=2, sort_keys=True) + '\n'
    if args.output:
        args.output.write_text(text)
    else:
        print(text, end='')


if __name__ == '__main__':
    main()

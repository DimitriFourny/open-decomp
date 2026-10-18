#!/usr/bin/env python3
"""Create complete seeded X/Y readability packets and a separately sealed map.

The reviewer directory contains no source oracle, tool mapping or random seed.
All available pairs are included; missing cells remain in a separate availability
register and receive no invented readability scores. No reviews are fabricated.
"""
import argparse
import hashlib
import json
from pathlib import Path
import random
import secrets
import shutil
import sys

sys.dont_write_bytecode = True
import quality

HERE = Path(__file__).resolve().parent
RUBRIC = {
 'style': ['Presentation prevents a reliable reading', 'Severe layout/name/expression impediments',
           'Readable in parts with substantial impediments', 'Clear with minor presentation impediments', 'Consistently clear and navigable'],
 'algorithm_comprehension': ['Cannot determine transformation', 'Only isolated operations understandable',
           'Main transformation partly understandable', 'Main transformation and purpose understandable with minor uncertainty', 'Transformation and boundary behavior readily explainable'],
 'types_interfaces': ['Interface/types actively misleading or unusable', 'Major widths/pointers/inputs/results unclear',
           'Mixed useful types and substantial unresolved interface', 'Mostly clear widths/pointers/parameters/results', 'Clear evidence-supported interface without machine-bank clutter'],
 'control_flow': ['Paths/exits cannot be followed', 'Severe loop/branch/exit confusion', 'Main paths understandable but significant friction',
           'Loops/conditions/exits mostly clear', 'All visible paths and stop conditions readily followable'],
 'unresolved_semantics': ['Unsupported behavior is hidden or apparently invented', 'Unknowns obscure most meaningful behavior',
           'Unknowns identifiable but substantially entangled', 'Limitations localized and mostly understandable', 'Known behavior and explicit limitations cleanly distinguished'],
 'irrelevant_machine_state_clutter': ['Machine plumbing overwhelms transformation', 'Extensive irrelevant state/temporaries/helpers',
           'Substantial clutter but transformation recoverable', 'Only limited irrelevant plumbing', 'No material irrelevant machine-state clutter'],
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--results', type=Path, required=True)
    parser.add_argument('--extra-results', type=Path, action='append', default=[],
                        help='Additional tool recording (e.g. angr-decompile.py output) matched by cell/function')
    parser.add_argument('--tools', nargs=2, default=['open-decomp', 'ghidra'], metavar=('TOOL', 'TOOL'),
                        help='The blinded pair (default: open-decomp ghidra)')
    parser.add_argument('--oracle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    quality.require(args.tools[0] != args.tools[1], 'A packet pair needs two distinct tools')
    result = json.loads((args.results / 'comparison.json').read_text())
    frozen = json.loads((HERE / 'quality-heldout-selection.json').read_text())
    quality.require(result['build_manifest']['selection']['source']['sha256'] == frozen['source']['sha256'], 'Only frozen held-out suite authorized')
    roots = {run['tool']: args.results for run in result['runs']}
    pairs = list(result['matched'])
    for root in args.extra_results:
        extra = json.loads((root / 'comparison.json').read_text())
        quality.require(extra['build_manifest'] == result['build_manifest'], 'Extra recording used different inputs')
        tools = {run['tool'] for run in extra['runs']}
        quality.require(not tools & set(roots), 'Each tool must come from exactly one recording')
        roots.update(dict.fromkeys(tools, root))
        rows = {(row['cell'], row['name']): row for row in extra['matched']}
        quality.require(len(rows) == len(pairs) and set(rows) == {(row['cell'], row['name']) for row in pairs}, 'Extra recording cells differ')
        pairs = [{**pair, **{tool: rows[(pair['cell'], pair['name'])][tool] for tool in tools}} for pair in pairs]
    quality.require(set(args.tools) <= set(roots), 'Requested tool has no recording')
    args.output.mkdir(parents=True, exist_ok=False)
    reviewer, private = args.output / 'reviewer', args.output / 'private'
    reviewer.mkdir()
    private.mkdir(mode=0o700)
    seed = secrets.token_hex(32)
    rng = random.Random(int(seed, 16))
    rng.shuffle(pairs)
    mapping, availability = [], []
    questions = {row['name']: row['review_question'] for row in frozen['selected_functions']}
    for index, pair in enumerate(pairs):
        identifier = f'case-{index + 1:03}'
        order = list(args.tools)
        rng.shuffle(order)
        labels = dict(zip(('X', 'Y'), order))
        secret = {'case': identifier, 'cell': pair['cell'], 'function': pair['name'], 'mapping': labels,
                  'original': {label: pair[tool] for label, tool in labels.items()}}
        mapping.append(secret)
        present = all(pair[tool]['status'] == 'text_returned' for tool in order)
        public = {'case': identifier, 'paired_text_available': present,
                  'availability': {label: 'text' if pair[tool]['status'] == 'text_returned' else 'no_text'
                                   for label, tool in labels.items()}}
        availability.append(public)
        if not present:
            continue
        directory = reviewer / identifier
        directory.mkdir()
        outputs = {}
        for label, tool in labels.items():
            source = roots[tool] / pair[tool]['output']['path']
            quality.require(quality.digest(source) == pair[tool]['output']['sha256'], 'Recorded output changed')
            shutil.copyfile(source, directory / (label + '.c'))
            outputs[label] = {'path': label + '.c', 'sha256': quality.digest(source),
                              'bytes_diagnostic_only': source.stat().st_size}
        quality.save(directory / 'question.json', {'case': identifier, 'question': questions[pair['name']],
                     'outputs': outputs, 'instructions': 'Explain each output independently, then score each fixed dimension 0..4 with line/quote evidence. Do not score correctness from appearance; no source answer or tool label is supplied.'})
    seal = {'seed': seed, 'selection_sha256': quality.digest(HERE / 'quality-heldout-selection.json'),
            'comparison_sha256': quality.digest(args.results / 'comparison.json'), 'cases': mapping,
            'policy': 'Do not disclose this mapping/seed or source gold to reviewers until all reviews are submitted and hashed.'}
    if args.extra_results:
        seal['extra_comparison_sha256s'] = {str(root): quality.digest(root / 'comparison.json') for root in args.extra_results}
    quality.save(private / 'mapping.json', seal)
    shutil.copyfile(args.oracle / 'source-oracle-cases.json', private / 'source-oracle-cases.json')
    quality.save(reviewer / 'rubric.json', {'dimensions_0_through_4': RUBRIC,
        'rules': ['Readability only; source/native gold and actual executable-output correctness are scored separately.',
                  'No output or unsupported cell is not an automatic readability zero; it belongs to availability.',
                  'Text bytes are diagnostic only, not a score or preference formula.',
                  'Tool labels/seed/source gold are hidden; output style may still enable inference, so blinding is imperfect.',
                  'Do not edit outputs. Supply per-side task answers, each score with quote/line evidence, X/Y/tie/neither preference, confidence, and possible style-based unblinding.',
                  'Record reviewer identity/method. LLM review, if later used, must be labeled and is not an independent human study.']})
    quality.save(reviewer / 'availability.json', availability)
    quality.save(args.output / 'packet-manifest.json', {'schema': 1, 'total_function_pairs': len(pairs),
        'paired_review_packets': sum(row['paired_text_available'] for row in availability),
        'missing_pair_cells': sum(not row['paired_text_available'] for row in availability),
        'mapping_commitment_sha256': quality.digest(private / 'mapping.json'),
        'oracle_commitment_sha256': quality.digest(private / 'source-oracle-cases.json'),
        'rubric_sha256': quality.digest(reviewer / 'rubric.json'),
        'reviewer_directory': str(reviewer), 'private_directory': str(private),
        'reviews_submitted': 0, 'readability_result': 'not_yet_reviewed',
        'policy': 'Give reviewers only reviewer/. Keep private/ sealed until submissions are complete. Every available pair is included under a seeded shuffle; no favorable-pair selection.'})
    print(json.dumps({'total_pairs': len(pairs), 'packets': sum(row['paired_text_available'] for row in availability),
                      'missing_pairs': sum(not row['paired_text_available'] for row in availability), 'reviews_submitted': 0}))
    return 0


if __name__ == '__main__':
    sys.exit(main())

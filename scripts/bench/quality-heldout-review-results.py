#!/usr/bin/env python3
"""Validate both complete blind submissions before reading the sealed X/Y map."""
import argparse
from collections import Counter
import json
from pathlib import Path
import statistics
import sys

sys.dont_write_bytecode = True
import quality


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--packets', type=Path, required=True)
    parser.add_argument('--review-a', type=Path, required=True)
    parser.add_argument('--review-b', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    meta = json.loads((args.packets / 'packet-manifest.json').read_text())
    available = json.loads((args.packets / 'reviewer/availability.json').read_text())
    expected = {row['case'] for row in available if row['paired_text_available']}
    rubric = json.loads((args.packets / 'reviewer/rubric.json').read_text())
    dimensions = set(rubric['dimensions_0_through_4'])
    reviews, receipts = [], []
    for identifier, path in [('A', args.review_a), ('B', args.review_b)]:
        review = json.loads(path.read_text())
        quality.require(review['reviewer_id'] == identifier, 'Wrong reviewer identity')
        quality.require(review['method'] == 'blinded_llm_readability_not_human_study', 'Wrong methodology label')
        quality.require(len(review['cases']) == len(expected), 'Incomplete/extra review cases')
        quality.require({row['case'] for row in review['cases']} == expected, 'Missing or duplicate case identifiers')
        for row in review['cases']:
            quality.require(row['preference'] in ('X', 'Y', 'tie', 'neither'), 'Invalid preference')
            quality.require(isinstance(row['confidence'], (float, int)) and 0 <= row['confidence'] <= 1, 'Invalid confidence')
            for side in ('X', 'Y'):
                quality.require(bool(row[side]['answer']), 'Missing independent question answer')
                scores = row[side]['scores']
                quality.require(set(scores) == dimensions, 'Wrong rubric dimensions')
                for score in scores.values():
                    quality.require(type(score['score']) is int and 0 <= score['score'] <= 4, 'Invalid score')
                    quality.require(bool(score['evidence']) and bool(score['rationale']), 'Missing score evidence/rationale')
        receipts.append({'reviewer_id': identifier, 'path': str(path), 'sha256': quality.digest(path)})
        reviews.append(review)
    quality.require(receipts[0]['sha256'] != receipts[1]['sha256'], 'Submissions must be independently retained')
    # Neither mapping nor source gold is read before BOTH submissions validate.
    mapping_path = args.packets / 'private/mapping.json'
    quality.require(quality.digest(mapping_path) == meta['mapping_commitment_sha256'], 'Sealed mapping changed')
    mapping = json.loads(mapping_path.read_text())
    by_case = {row['case']: row for row in mapping['cases']}
    aggregate, per_reviewer = [], []
    pooled = {tool: {dimension: [] for dimension in dimensions} for tool in ('open-decomp', 'ghidra')}
    preferences = Counter()
    decoded = []
    for review in reviews:
        scores = {tool: {dimension: [] for dimension in dimensions} for tool in pooled}
        choices = Counter()
        for row in review['cases']:
            labels = by_case[row['case']]['mapping']
            for side in ('X', 'Y'):
                for dimension in dimensions:
                    value = row[side]['scores'][dimension]['score']
                    scores[labels[side]][dimension].append(value)
                    pooled[labels[side]][dimension].append(value)
            preference = labels[row['preference']] if row['preference'] in labels else row['preference']
            choices[preference] += 1
            preferences[preference] += 1
            decoded.append({'reviewer_id': review['reviewer_id'], 'case': row['case'],
                            'cell': by_case[row['case']]['cell'], 'function': by_case[row['case']]['function'],
                            'mapping': labels, 'decoded_preference': preference, 'review': row})
        per_reviewer.append({'reviewer_id': review['reviewer_id'], 'preferences': dict(choices),
            'dimensions': {tool: {dimension: {'mean': statistics.mean(values), 'median': statistics.median(values),
                           'counts_0_to_4': [values.count(score) for score in range(5)]}
                           for dimension, values in items.items()} for tool, items in scores.items()}})
    for tool, items in pooled.items():
        for dimension, values in sorted(items.items()):
            aggregate.append({'tool': tool, 'dimension': dimension, 'ratings': len(values),
                              'mean': statistics.mean(values), 'median': statistics.median(values),
                              'counts_0_to_4': [values.count(score) for score in range(5)]})
    first, second = ({row['case']: row for row in review['cases']} for review in reviews)
    disagreements = []
    for case in sorted(expected):
        gaps = {side: {dimension: abs(first[case][side]['scores'][dimension]['score'] - second[case][side]['scores'][dimension]['score'])
                      for dimension in dimensions} for side in ('X', 'Y')}
        disagreements.append({'case': case, 'preference_disagrees': first[case]['preference'] != second[case]['preference'],
                              'absolute_score_differences': gaps})
    report = {'schema': 1, 'method': 'Two independently submitted blinded LLM reviews; NOT a human study',
              'submissions_before_unsealing': receipts, 'mapping_commitment_sha256': meta['mapping_commitment_sha256'],
              'mapping_read_only_after_both_validated': True, 'paired_cases': len(expected),
              'missing_pairs_retained': meta['missing_pair_cells'], 'preferences': dict(preferences),
              'dimension_ratings': aggregate, 'per_reviewer': per_reviewer, 'disagreements': disagreements,
              'decoded_reviews': decoded,
              'limitations': ['Only readability/task comprehension; not behavioral correctness or usable-coverage proof.',
                             'Repeated target/compiler/optimization/symbol variants are correlated; not 60 independent programs.',
                             'LLM reviewer bias and shared model lineage; no human or population-level generalization.',
                             'Engine style can imperfectly unblind X/Y; reviewers disclose suspected style inference.',
                             'No text-length score, no performance ranking, no universal parity claim.']}
    args.output.mkdir(parents=True, exist_ok=False)
    quality.save(args.output / 'readability.json', report)
    print(json.dumps({'paired_cases': len(expected), 'preferences': dict(preferences),
                      'preference_disagreements': sum(row['preference_disagrees'] for row in disagreements)}))
    return 0


if __name__ == '__main__':
    sys.exit(main())

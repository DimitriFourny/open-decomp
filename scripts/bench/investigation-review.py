#!/usr/bin/env python3
"""Audit frozen blind reviews: strict RFC6901 value-span byte attribution.

No engine facts, source, packets or answers are modified. Unmarked bytes are
UNCLASSIFIED, never automatically irrelevant. Cross-label overlap is separate.
Gold atom classifications are an explicit, separately retained source audit,
not an invented numeric/LLM score or a third blind answer.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re


def spans_for(raw):
    text = raw.decode('utf-8')
    decoder = json.JSONDecoder()
    byte_offsets = [0]
    for character in text:
        byte_offsets.append(byte_offsets[-1] + len(character.encode('utf-8')))
    spans = {}

    def whitespace(position):
        while position < len(text) and text[position] in ' \t\r\n':
            position += 1
        return position

    def value(position, path):
        position = whitespace(position)
        start = position
        if text[position] == '{':
            position = whitespace(position + 1)
            if text[position] != '}':
                while True:
                    key, position = decoder.raw_decode(text, position)
                    if not isinstance(key, str):
                        raise ValueError('Non-string object key')
                    position = whitespace(position)
                    if text[position] != ':':
                        raise ValueError('Missing object colon')
                    position = whitespace(value(position + 1, path + (key,)))
                    if text[position] == '}':
                        break
                    if text[position] != ',':
                        raise ValueError('Missing object separator')
                    position = whitespace(position + 1)
            position += 1
        elif text[position] == '[':
            position = whitespace(position + 1)
            ordinal = 0
            if text[position] != ']':
                while True:
                    position = whitespace(value(position, path + (str(ordinal),)))
                    ordinal += 1
                    if text[position] == ']':
                        break
                    if text[position] != ',':
                        raise ValueError('Missing array separator')
                    position = whitespace(position + 1)
            position += 1
        else:
            _, position = decoder.raw_decode(text, position)
        spans[path] = (byte_offsets[start], byte_offsets[position])
        return position

    end = whitespace(value(0, ()))
    if end != len(text):
        raise ValueError('Unexpected trailing packet bytes')
    return json.loads(text), spans


def pointer_tokens(pointer):
    if not isinstance(pointer, str) or (pointer and not pointer.startswith('/')):
        raise ValueError('Not an absolute JSON pointer')
    if pointer == '':
        return ()
    result = []
    for token in pointer[1:].split('/'):
        if re.search(r'~(?![01])', token):
            raise ValueError('Invalid RFC6901 escape')
        result.append(token.replace('~1', '/').replace('~0', '~'))
    return tuple(result)


def merge(intervals):
    merged = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def length(intervals):
    return sum(end - start for start, end in intervals)


def intersection(left, right):
    result, first, second = [], 0, 0
    while first < len(left) and second < len(right):
        start = max(left[first][0], right[second][0])
        end = min(left[first][1], right[second][1])
        if start < end:
            result.append((start, end))
        if left[first][1] < right[second][1]:
            first += 1
        else:
            second += 1
    return result


def classify(case, index, packet_spans):
    allowed = ('cases', str(index), 'material')
    material = packet_spans[allowed]
    selections, invalid, redundant = {}, [], []
    for label, field in [('relevant', 'relevant_material_paths'), ('irrelevant', 'irrelevant_material_paths')]:
        paths, intervals = [], []
        for pointer in case[field]:
            try:
                tokens = pointer_tokens(pointer)
                if tokens[:3] != allowed:
                    raise ValueError('Pointer escapes its declared case material')
                if tokens not in packet_spans:
                    raise ValueError('Pointer does not resolve in the actual frozen packet')
                span = packet_spans[tokens]
                if any(start <= span[0] and end >= span[1] for start, end in intervals):
                    redundant.append({'label': label, 'path': pointer})
                intervals.append(span)
                paths.append({'path': pointer, 'byte_interval': span})
            except (ValueError, KeyError) as error:
                invalid.append({'label': label, 'path': pointer, 'error': str(error)})
        selections[label] = {'paths': paths, 'intervals': merge(intervals)}
    relevant = selections['relevant']['intervals']
    irrelevant = selections['irrelevant']['intervals']
    overlap = intersection(relevant, irrelevant)
    overlap_bytes = length(overlap)
    union_bytes = length(merge(relevant + irrelevant))
    counts = {'material_bytes': material[1] - material[0],
              'relevant_bytes': length(relevant) - overlap_bytes,
              'irrelevant_bytes': length(irrelevant) - overlap_bytes,
              'overlap_bytes': overlap_bytes,
              'unclassified_material_bytes': material[1] - material[0] - union_bytes}
    assert counts['material_bytes'] == sum(counts[key] for key in (
        'relevant_bytes', 'irrelevant_bytes', 'overlap_bytes', 'unclassified_material_bytes'))
    return {**counts, 'resolved_paths': selections, 'invalid_paths': invalid,
            'redundant_paths': redundant, 'cross_label_overlap_intervals': overlap,
            'manual_repair_needed': case['manual_repair_needed']}


def main(args):
    root = args.root
    gold = json.loads((root / 'private/gold/answers.json').read_text())
    atoms = {case['function']: case for case in gold['answers']}
    audit = json.loads(args.gold_audit.read_text())
    results = {'method': 'Raw frozen UTF-8 JSON value-subtree spans. A marked parent includes child keys/separators; a marked child excludes its own parent key/colon/comma. Surrounding framing, question text and all unmarked material remain unclassified. Same-label overlap is unioned once; cross-label overlap is reported separately and excluded from both labels. Invalid paths contribute zero classified bytes.',
               'gold_method': audit['method'], 'reviewers': {}}
    for review_path in args.review:
        raw_review = review_path.read_bytes()
        review = json.loads(raw_review)
        reviewer = review['reviewer']
        sides = {}
        for side, cases in review['sides'].items():
            packet_path = root / 'review' / f'packet-{side}.json'
            raw_packet = packet_path.read_bytes()
            packet, spans = spans_for(raw_packet)
            by_name = {case['function']: index for index, case in enumerate(packet['cases'])}
            if len(cases) != len(atoms) or {case['function'] for case in cases} != set(atoms):
                raise ValueError('Every frozen function must have exactly one review row')
            measured = []
            for case in cases:
                name = case['function']
                source_audit = audit['reviewers'][reviewer][side][name]
                if len(source_audit['facts']) != len(atoms[name]['facts']) or len(source_audit['uncertainty']) != len(atoms[name]['uncertainty']):
                    raise ValueError('Gold audit must classify every original frozen atom')
                measured.append({'function': name, **classify(case, by_name[name], spans), 'gold_audit': source_audit})
            totals = {key: sum(case[key] for case in measured) for key in ('material_bytes', 'relevant_bytes', 'irrelevant_bytes', 'overlap_bytes', 'unclassified_material_bytes')}
            sides[side] = {'packet_sha256': hashlib.sha256(raw_packet).hexdigest(), 'packet_bytes': len(raw_packet),
                'totals': totals, 'unclassified_packet_bytes': len(raw_packet) - totals['relevant_bytes'] - totals['irrelevant_bytes'] - totals['overlap_bytes'],
                'manual_repair_cases': sum(case['manual_repair_needed'] for case in measured),
                'invalid_path_count': sum(len(case['invalid_paths']) for case in measured), 'cases': measured}
        pairwise = []
        for name in atoms:
            left = next(case for case in sides['A']['cases'] if case['function'] == name)
            right = next(case for case in sides['B']['cases'] if case['function'] == name)
            pairwise.append({'function': name,
                'B_minus_A_irrelevant_bytes': right['irrelevant_bytes'] - left['irrelevant_bytes'],
                'B_irrelevant_bytes_fewer': right['irrelevant_bytes'] < left['irrelevant_bytes'],
                'A_manual_repair': left['manual_repair_needed'], 'B_manual_repair': right['manual_repair_needed'],
                'any_invalid_or_overlap': bool(left['invalid_paths'] or right['invalid_paths'] or left['overlap_bytes'] or right['overlap_bytes'])})
        preferences = {label: sum(row['preferred_side_or_tie'] == label for row in review['paired']) for label in ('A', 'B', 'tie')}
        results['reviewers'][reviewer] = {'raw_review_sha256': hashlib.sha256(raw_review).hexdigest(),
            'sides': sides, 'pairwise': pairwise, 'reported_preferences': preferences}
    args.output.write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps({reviewer: {'sides': {side: {'totals': data['totals'], 'manual_repair_cases': data['manual_repair_cases'], 'invalid_path_count': data['invalid_path_count']} for side, data in result['sides'].items()}, 'pairwise': result['pairwise'], 'reported_preferences': result['reported_preferences']} for reviewer, result in results['reviewers'].items()}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--review', type=Path, action='append', required=True)
    parser.add_argument('--gold-audit', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    main(parser.parse_args())

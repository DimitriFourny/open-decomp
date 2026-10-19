#!/usr/bin/env python3
"""Fast local development comparison loop: Open Decomp source view vs archived Ghidra.

Uses the broader reviewed development matrix (24 cells x 12 selected functions).
This matrix is a DEVELOPMENT set: its source is known and it has been inspected
while tuning, so results are not held-out evidence and must not be reported as such.
Analyzed binaries are never executed; everything is static decompilation.

  ghidra     extract the archived Ghidra 12.1.4 texts (after verifying input hashes)
  run        decompile the same (cell, function) set with one Open Decomp build
  packets    seeded, stratified blind X/Y review packets (same seed -> same pairs)
  aggregate  decode reviewer JSON with the sealed mapping into per-tool/function/O-level tables
"""
import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import sys
import tarfile
import tempfile
import time

sys.dont_write_bytecode = True
import quality

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
LOCAL = REPO / '.local'
DEFAULT_MATRIX = LOCAL / 'performance/quality-matrix-reviewed'
DEFAULT_ARCHIVE = LOCAL / 'evidence/scripts/bench/quality-matrix-results-2026-10-17.tar.gz'
DEFAULT_GHIDRA = LOCAL / 'quality-dev/ghidra'
DEFAULT_RUNS = LOCAL / 'quality-dev/runs'
TOOLS = ('open-decomp', 'ghidra')
TEXT_STATUSES = ('complete', 'partial')

# One neutral task question per function; no names, no tool hints.
QUESTIONS = {
    'matrix_multi_exit': 'Describe the loop, each of its exit conditions and what is returned on each exit.',
    'matrix_switch': 'Describe the multi-way selection: how inputs map to results and what the default/out-of-range path does.',
    'matrix_alias': 'Describe the memory reads and writes, their order, and what the result depends on if the pointers overlap.',
    'matrix_aggregate': 'Describe the by-value aggregate input (its integer and floating-point members) and the aggregate result.',
    'matrix_callback': 'Describe the loop that calls an indirect callback, what is passed to it and when the loop exits early.',
    'matrix_variadic': 'Describe how the variable argument list is consumed (including the zero-count case) and what is returned.',
    'matrix_mixed': 'Describe the integer and floating-point parameters and how the floating-point result is formed.',
    'matrix_variadic_call': 'Describe the calls made, including the variadic call sites, and the argument types passed.',
    'matrix_checksum': 'Describe which checksum routines are called, with what arguments, and how their results are returned.',
    'adler32_z': 'Describe the checksum computed, its initial state, the block processing and the modular reductions.',
    'crc32_z': 'Describe the CRC computation: initial/final value handling, table use and the per-byte or word-wise processing.',
    'crc32_combine': 'Describe how two CRCs and a length are combined, including the arithmetic and loop structure.',
}


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def load_manifest(matrix):
    path = matrix / 'build-manifest.json'
    manifest = json.loads(path.read_text())
    quality.require(len(manifest['cells']) == 24, 'The development matrix must have 24 cells')
    quality.require(all(cell['status'] == 'built' for cell in manifest['cells']), 'Unbuilt matrix cell')
    return manifest, path


def cell_binary(matrix, manifest, cell):
    return matrix / Path(cell['input']['path']).relative_to(manifest['root'])


def cell_info(manifest):
    return {cell['id']: {key: cell[key] for key in ('target', 'compiler', 'optimization', 'symbols')}
            for cell in manifest['cells']}


# --------------------------------------------------------------------------- ghidra

def command_ghidra(args):
    matrix, archive, output = args.matrix.resolve(), args.archive.resolve(), args.output.resolve()
    manifest, manifest_path = load_manifest(matrix)
    quality.require(not output.exists() or not any(output.iterdir()), f'{output} is not empty; choose a new output')
    results = json.loads((HERE / 'quality-matrix-results-2026-10-17.json').read_text())
    baseline = results['baseline']
    archive_sha = quality.digest(archive)
    quality.require(archive_sha == baseline['sha256'], 'Archive hash differs from quality-matrix-results-2026-10-17.json')
    wanted, comparison = {}, None
    with tarfile.open(archive) as bundle:
        for member in bundle:
            if not member.isfile():
                continue
            if member.name == 'comparison.json':
                comparison = bundle.extractfile(member).read()
            elif '/ghidra/' in member.name and member.name.endswith('.c'):
                wanted[member.name] = bundle.extractfile(member).read()
    quality.require(comparison is not None, 'Archive lacks comparison.json')
    recorded = {entry['path']: entry for entry in baseline['files']}
    quality.require(sha256_bytes(comparison) == recorded['comparison.json']['sha256'], 'comparison.json hash mismatch')
    data = json.loads(comparison)
    # Archived inputs must be exactly the current matrix binaries.
    quality.require(data['build_manifest_sha256'] == quality.digest(manifest_path), 'build-manifest.json differs from archived run')
    runs = {(run['cell'], run['tool']): run for run in data['runs']}
    checked = 0
    for cell in manifest['cells']:
        binary = cell_binary(matrix, manifest, cell)
        current = quality.digest(binary)
        for tool in TOOLS:
            run = runs[(cell['id'], tool)]
            quality.require(run['input']['sha256'] == current == cell['input']['sha256'],
                            f'Input hash mismatch for {cell["id"]} ({tool}): refusing')
            checked += 1
    inputs = json.loads((HERE / 'quality-matrix-inputs.json').read_text())
    output.mkdir(parents=True, exist_ok=True)
    cells = cell_info(manifest)
    index, counts = {'cells': {}}, Counter()
    for cell in manifest['cells']:
        run = runs[(cell['id'], 'ghidra')]
        planned = {function['name']: function for function in cell['functions']}
        quality.require({row['name'] for row in run['functions']} == set(planned), 'Function set differs: ' + cell['id'])
        entry = {**cells[cell['id']], 'input_sha256': cell['input']['sha256'], 'functions': {}}
        for row in run['functions']:
            item = {'address': row['address'], 'category': planned[row['name']]['category'], 'status': row['status']}
            if row['status'] == 'text_returned':
                text = wanted.get(f'{cell["id"]}/ghidra/{row["name"]}.c')
                quality.require(text is not None, f'Archive lacks recorded Ghidra text for {cell["id"]}/{row["name"]}')
                quality.require(sha256_bytes(text) == row['output']['sha256'], 'Archived text differs from recorded hash')
                target = output / cell['id'] / f'{row["name"]}.c'
                target.parent.mkdir(exist_ok=True)
                target.write_bytes(text)
                item.update({'path': f'{cell["id"]}/{row["name"]}.c', 'bytes': len(text), 'sha256': sha256_bytes(text)})
            counts[item['status']] += 1
            entry['functions'][row['name']] = item
        index['cells'][cell['id']] = entry
    index.update({'schema': 1, 'tool': 'ghidra', 'source_archive': str(archive), 'source_archive_sha256': archive_sha,
                  'comparison_sha256': recorded['comparison.json']['sha256'],
                  'build_manifest_sha256': data['build_manifest_sha256'], 'matrix': str(matrix),
                  'bridge_commit': data['bridge_commit'], 'ghidra_properties_sha256': data['ghidra_properties_sha256'],
                  'ghidra_version': '12.1.4', 'inputs_verified': checked,
                  'statuses': dict(counts), 'texts': counts['text_returned'],
                  'note': 'Archived recording of Ghidra 12.1.4 through the pinned bridge; not re-run. Functions without a text have no entry file.'})
    quality.save(output / 'index.json', index)
    print(json.dumps({'ghidra_texts': counts['text_returned'], 'statuses': dict(counts),
                      'inputs_verified': checked, 'output': str(output)}))
    return 0


# --------------------------------------------------------------------------- run

NOISE = ('project_open:', 'binary_info:', 'functions_find:', 'function_decompile:', 'Created project:', 'Reusing project:')


def decompile(command, binary, address, cache, timeout):
    started = time.monotonic()
    try:
        done = subprocess.run([*command, 'decompile', str(binary), '--address', f'va:{address}', '--view', 'source',
                               '--cache', str(cache)], capture_output=True, text=True, timeout=timeout,
                              env={**os.environ, 'NO_COLOR': '1'})
        code, text, stderr = done.returncode, done.stdout, done.stderr
    except subprocess.TimeoutExpired as error:
        code, text, stderr = None, '', f'timeout after {timeout}s'
        if error.stderr:
            stderr = (error.stderr if isinstance(error.stderr, str) else error.stderr.decode()) + '\n' + stderr
    lines = [line for line in stderr.splitlines() if line.strip() and not line.startswith(NOISE)]
    return code, text, lines, round(time.monotonic() - started, 3)


def run_cell(command, matrix, manifest, cell, output, timeout):
    binary = cell_binary(matrix, manifest, cell)
    cache = Path(tempfile.mkdtemp(prefix='od-devloop-cache-', dir='/tmp'))
    rows = {}
    try:
        for function in cell['functions']:
            code, text, lines, elapsed = decompile(command, binary, function['address'], cache, timeout)
            row = {'address': function['address'], 'exit_code': code, 'seconds': elapsed}
            if code in (0, 2) and text.strip():
                row['status'] = 'complete' if code == 0 else 'partial'
                target = output / cell['id'] / f'{function["name"]}.c'
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text)
                row.update({'path': f'{cell["id"]}/{function["name"]}.c', 'bytes': len(text.encode()),
                            'sha256': sha256_bytes(text.encode())})
                if code == 2:
                    row['diagnostics'] = lines[-6:]
            else:
                row['status'] = 'no_text' if code in (0, 2) else 'failed'
                row['diagnostics'] = lines[-6:] or ['(no stderr)']
            rows[function['name']] = row
    finally:
        shutil.rmtree(cache, ignore_errors=True)
    return cell['id'], rows


def command_run(args):
    entry, matrix = args.entry.resolve(), args.matrix.resolve()
    quality.require(entry.is_file(), f'No such entry: {entry}')
    output = args.runs.resolve() / args.label
    quality.require(not output.exists(), f'{output} exists; choose a new label')
    manifest, _ = load_manifest(matrix)
    command = [args.node, *(['--import', 'tsx'] if entry.suffix == '.ts' else []), str(entry)]
    output.mkdir(parents=True)
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = [pool.submit(run_cell, command, matrix, manifest, cell, output, args.timeout) for cell in manifest['cells']]
        results = dict(future.result() for future in futures)
    cells = cell_info(manifest)
    counts, failures = Counter(), []
    for cell_id, rows in sorted(results.items()):
        for name, row in rows.items():
            counts[row['status']] += 1
            if row['status'] in ('failed', 'no_text'):
                failures.append({'cell': cell_id, 'function': name, 'status': row['status'], 'exit_code': row['exit_code'],
                                 'diagnostics': row['diagnostics']})
    summary = {'schema': 1, 'tool': 'open-decomp', 'label': args.label, 'entry': str(entry),
               'entry_sha256': quality.digest(entry), 'view': 'source', 'budget': 'default',
               'address_space': 'va', 'wall_seconds': round(time.monotonic() - started, 1), 'jobs': args.jobs,
               'texts': counts['complete'] + counts['partial'], 'statuses': dict(counts), 'failures': failures,
               'cells': {cell_id: {**cells[cell_id], 'functions': rows} for cell_id, rows in sorted(results.items())}}
    quality.save(output / 'summary.json', summary)
    print(json.dumps({'label': args.label, 'texts': summary['texts'], 'statuses': dict(counts),
                      'failures': len(failures), 'wall_seconds': summary['wall_seconds'], 'output': str(output)}))
    for item in failures:
        print(f'FAIL {item["cell"]}/{item["function"]} exit={item["exit_code"]}: {(item["diagnostics"] or [""])[-1][:160]}')
    return 0


# --------------------------------------------------------------------------- packets

def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def key(seed, *parts):
    return hashlib.sha256('|'.join([str(seed), *parts]).encode()).hexdigest()


def render_instructions(reviewer, submissions, cases):
    template = load_module('quality_heldout_instructions', 'quality-heldout-instructions.py').TEMPLATE.template
    # Frozen wording; only the missing-pair register (absent here, every pair is complete) is dropped.
    drops = [' Missing pairs remain separately recorded in availability.json and receive no invented readability scores.',
             'Missing-cell register: `$reviewer/availability.json`\n\n']
    for phrase in drops:
        quality.require(phrase in template, 'Frozen instruction template changed; update quality-dev-loop.py')
        template = template.replace(phrase, '')
    from string import Template
    text = Template(template).substitute(count=len(cases), reviewer=reviewer, submissions=submissions)
    return text + ''.join(f'- `{reviewer}/{case}/question.json`\n' for case in cases)


def command_packets(args):
    ghidra_root, run_root = args.ghidra.resolve(), args.runs.resolve()
    index = json.loads((ghidra_root / 'index.json').read_text())
    summary = json.loads((run_root / args.label / 'summary.json').read_text())
    quality.require(set(summary['cells']) == set(index['cells']), 'Run and Ghidra cell sets differ')
    require_labels = {}
    for label in args.require_label:
        require_labels[label] = json.loads((run_root / label / 'summary.json').read_text())
    pool = defaultdict(list)
    for cell_id, cell in sorted(index['cells'].items()):
        for name, ghidra in sorted(cell['functions'].items()):
            row = summary['cells'][cell_id]['functions'][name]
            if 'path' not in ghidra or row['status'] not in TEXT_STATUSES:
                continue
            if any(other['cells'][cell_id]['functions'][name]['status'] not in TEXT_STATUSES for other in require_labels.values()):
                continue
            pool[(name, cell['optimization'])].append((cell_id, name))
    eligible = sum(map(len, pool.values()))
    strata = sorted(pool, key=lambda stratum: key(args.seed, 'stratum', *stratum))
    for stratum in strata:
        pool[stratum].sort(key=lambda pair: key(args.seed, 'pair', *pair))
    chosen = []
    for depth in range(max(map(len, pool.values()), default=0)):
        for stratum in strata:
            if len(chosen) < args.sample and depth < len(pool[stratum]):
                chosen.append(pool[stratum][depth])
    quality.require(len(chosen) == args.sample, f'Only {len(chosen)} eligible pairs for --sample {args.sample}')
    chosen.sort(key=lambda pair: key(args.seed, 'case', *pair))
    output = args.output.resolve()
    quality.require(not output.exists(), f'{output} exists; choose a new packet directory')
    output.mkdir(parents=True)
    private = output / 'private'
    private.mkdir(mode=0o700)
    rubric = load_module('quality_heldout_packets', 'quality-heldout-packets.py').RUBRIC
    cases = []
    for number, (cell_id, name) in enumerate(chosen, 1):
        identifier = f'case-{number:03}'
        order = list(TOOLS) if int(key(args.seed, 'side', cell_id, name), 16) & 1 else list(reversed(TOOLS))
        labels = dict(zip(('X', 'Y'), order))
        sources = {'open-decomp': run_root / args.label / summary['cells'][cell_id]['functions'][name]['path'],
                   'ghidra': ghidra_root / index['cells'][cell_id]['functions'][name]['path']}
        expected = {'open-decomp': summary['cells'][cell_id]['functions'][name]['sha256'],
                    'ghidra': index['cells'][cell_id]['functions'][name]['sha256']}
        directory = output / identifier
        directory.mkdir()
        files = {}
        for label, tool in labels.items():
            quality.require(quality.digest(sources[tool]) == expected[tool], f'Recorded {tool} output changed: {sources[tool]}')
            shutil.copyfile(sources[tool], directory / f'{label}.c')
            files[label] = {'path': f'{label}.c', 'sha256': expected[tool]}
        quality.save(directory / 'question.json', {
            'case': identifier, 'question': QUESTIONS[name], 'outputs': files,
            'instructions': 'Explain each output independently, then score each fixed dimension 0..4 with line/quote evidence. '
                            'Do not score correctness from appearance; no source answer or tool label is supplied.'})
        info = index['cells'][cell_id]
        cases.append({'case': identifier, 'cell': cell_id, 'function': name, 'optimization': info['optimization'],
                      'target': info['target'], 'compiler': info['compiler'], 'symbols': info['symbols'],
                      'mapping': labels, 'sha256': {label: expected[tool] for label, tool in labels.items()}})
    quality.save(output / 'rubric.json', {'dimensions_0_through_4': rubric, 'rules': [
        'Readability only; source/native gold and actual executable-output correctness are scored separately.',
        'Text bytes are diagnostic only, not a score or preference formula.',
        'Tool labels/seed/source gold are hidden; output style may still enable inference, so blinding is imperfect.',
        'Do not edit outputs. Supply per-side task answers, each score with quote/line evidence, X/Y/tie/neither preference, '
        'confidence, and possible style-based unblinding.',
        'LLM review is labeled as such and is not an independent human study.']})
    submissions = args.submissions.resolve() if args.submissions else output.parent / f'{output.name}-submissions'
    instructions = output / 'instructions.md'
    instructions.write_text(render_instructions(output, submissions, [row['case'] for row in cases]))
    mapping = {'schema': 1, 'label': args.label, 'seed': args.seed, 'sample': args.sample, 'tools': list(TOOLS),
               'eligible_pairs': eligible, 'strata': len(strata), 'require_labels': args.require_label,
               'ghidra_index_sha256': quality.digest(ghidra_root / 'index.json'),
               'run_summary_sha256': quality.digest(run_root / args.label / 'summary.json'),
               'cases': cases, 'policy': 'Do not disclose this mapping to reviewers until all reviews are submitted.'}
    quality.save(private / 'mapping.json', mapping)
    quality.save(output / 'commitment.json', {'mapping_sha256': quality.digest(private / 'mapping.json'),
                                              'rubric_sha256': quality.digest(output / 'rubric.json'),
                                              'instructions_sha256': quality.digest(instructions)})
    spread = Counter(row['optimization'] for row in cases), Counter(row['function'] for row in cases)
    print(json.dumps({'packets': str(output), 'instructions': str(instructions), 'cases': len(cases),
                      'eligible_pairs': eligible, 'by_optimization': dict(spread[0]), 'by_function': dict(spread[1]),
                      'private': str(private), 'submissions_dir': str(submissions),
                      'seal': f'mv {private} {output.parent}/sealed-{output.name} && chmod 700 {output.parent}/sealed-{output.name}'}))
    return 0


# --------------------------------------------------------------------------- aggregate

def load_review(path, expected, dimensions):
    review = json.loads(path.read_text())
    quality.require(isinstance(review.get('reviewer_id'), str), f'{path}: reviewer_id missing')
    cases = {row['case']: row for row in review['cases']}
    quality.require(len(cases) == len(review['cases']) and set(cases) == expected, f'{path}: case set differs from packets')
    for row in cases.values():
        quality.require(row['preference'] in ('X', 'Y', 'tie', 'neither'), f'{path}: invalid preference')
        for side in ('X', 'Y'):
            scores = row[side]['scores']
            quality.require(set(scores) == dimensions, f'{path}: wrong rubric dimensions')
            for score in scores.values():
                quality.require(type(score['score']) is int and 0 <= score['score'] <= 4, f'{path}: invalid score')
    return review['reviewer_id'], cases


def mean(values):
    return round(statistics.mean(values), 3) if values else None


def group_stats(rows):
    """rows: decoded per-review-per-case dicts."""
    votes = Counter(row['preference'] for row in rows)
    overall = {tool: mean([row['overall'][tool] for row in rows]) for tool in TOOLS}
    delta = None if None in overall.values() else round(overall['open-decomp'] - overall['ghidra'], 3)
    return {'ratings': len(rows), 'preferences': {choice: votes[choice] for choice in (*TOOLS, 'tie', 'neither')},
            'overall_mean': overall, 'overall_delta_open_decomp_minus_ghidra': delta}


def command_aggregate(args):
    packets, sealed = args.packets.resolve(), args.mapping.resolve()
    mapping_path = sealed / 'mapping.json'
    commitment = json.loads((packets / 'commitment.json').read_text())
    quality.require(quality.digest(mapping_path) == commitment['mapping_sha256'], 'Sealed mapping differs from packet commitment')
    mapping = json.loads(mapping_path.read_text())
    cases = {row['case']: row for row in mapping['cases']}
    dimensions = set(json.loads((packets / 'rubric.json').read_text())['dimensions_0_through_4'])
    for identifier, row in cases.items():
        for label in ('X', 'Y'):
            quality.require(quality.digest(packets / identifier / f'{label}.c') == row['sha256'][label], f'{identifier}/{label}.c changed since sealing')
    reviews = [load_review(path, set(cases), dimensions) for path in args.review]
    quality.require(len({reviewer for reviewer, _ in reviews}) == len(reviews), 'Reviewer ids must differ')
    decoded, dimension_scores = [], {tool: defaultdict(list) for tool in TOOLS}
    for reviewer, rows in reviews:
        for identifier, review in sorted(rows.items()):
            case = cases[identifier]
            labels = case['mapping']
            scores = {tool: {dim: review[side]['scores'][dim]['score'] for dim in dimensions} for side, tool in labels.items()}
            for tool in TOOLS:
                for dim, value in scores[tool].items():
                    dimension_scores[tool][dim].append(value)
            decoded.append({'reviewer': reviewer, 'case': identifier, 'cell': case['cell'], 'function': case['function'],
                            'optimization': case['optimization'], 'target': case['target'], 'symbols': case['symbols'],
                            'preference': labels.get(review['preference'], review['preference']),
                            'overall': {tool: statistics.mean(scores[tool].values()) for tool in TOOLS}, 'scores': scores})
    report = {'schema': 1, 'label': mapping['label'], 'seed': mapping['seed'], 'cases': len(cases),
              'reviewers': [reviewer for reviewer, _ in reviews], 'ratings': len(decoded),
              'scope': 'Development matrix (source known, not held-out); LLM review, not a human study.',
              'overall': group_stats(decoded),
              'dimension_means': {tool: {dim: mean(values) for dim, values in sorted(items.items())}
                                  for tool, items in dimension_scores.items()}}
    for field in ('function', 'optimization', 'target', 'symbols'):
        groups = defaultdict(list)
        for row in decoded:
            groups[row[field]].append(row)
        report['by_' + field] = {name: group_stats(rows) for name, rows in sorted(groups.items())}
    report['per_reviewer'] = {reviewer: group_stats([row for row in decoded if row['reviewer'] == reviewer])
                              for reviewer, _ in reviews}
    report['decoded'] = decoded
    output = args.output.resolve() if args.output else packets.parent / f'aggregate-{packets.name}'
    quality.require(not output.exists(), f'{output} exists; choose a new output')
    output.mkdir(parents=True)
    quality.save(output / 'aggregate.json', report)
    (output / 'aggregate.md').write_text(render_markdown(report))
    print((output / 'aggregate.md').read_text())
    print(json.dumps({'output': str(output)}))
    return 0


def row_line(name, stats):
    prefs, overall = stats['preferences'], stats['overall_mean']
    delta = stats['overall_delta_open_decomp_minus_ghidra']
    return (f'| {name} | {stats["ratings"]} | {prefs["open-decomp"]} | {prefs["ghidra"]} | {prefs["tie"] + prefs["neither"]} '
            f'| {overall["open-decomp"]:.2f} | {overall["ghidra"]:.2f} | {delta:+.2f} |')


def render_markdown(report):
    head = ['| group | ratings | OD pref | Ghidra pref | tie/neither | OD mean | Ghidra mean | OD-Ghidra |',
            '|---|---:|---:|---:|---:|---:|---:|---:|']
    lines = [f'# Development comparison: {report["label"]}', '',
             f'{report["cases"]} cases x {len(report["reviewers"])} review(s) ({", ".join(report["reviewers"])}). '
             'Means are the average of the six 0-4 dimensions. Development set, not held-out; LLM review.', '',
             *head, row_line('**all**', report['overall'])]
    for field in ('optimization', 'function', 'target', 'symbols'):
        lines += ['', f'## By {field}', '', *head, *[row_line(name, stats) for name, stats in report['by_' + field].items()]]
    lines += ['', '## Dimension means', '', '| dimension | OD | Ghidra |', '|---|---:|---:|']
    for dim in sorted(report['dimension_means']['open-decomp']):
        lines.append(f'| {dim} | {report["dimension_means"]["open-decomp"][dim]:.2f} | {report["dimension_means"]["ghidra"][dim]:.2f} |')
    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest='command', required=True)
    ghidra = commands.add_parser('ghidra', help='Extract archived Ghidra texts after verifying input hashes')
    ghidra.add_argument('--output', type=Path, default=DEFAULT_GHIDRA)
    ghidra.add_argument('--matrix', type=Path, default=DEFAULT_MATRIX)
    ghidra.add_argument('--archive', type=Path, default=DEFAULT_ARCHIVE)
    run = commands.add_parser('run', help='Decompile every (cell, function) with one Open Decomp build')
    run.add_argument('--entry', type=Path, required=True, help='dist/src/cli/entry.js (or entry.ts) of any checkout/snapshot')
    run.add_argument('--label', required=True)
    run.add_argument('--matrix', type=Path, default=DEFAULT_MATRIX)
    run.add_argument('--runs', type=Path, default=DEFAULT_RUNS)
    run.add_argument('--jobs', type=int, default=4, help='Cells decompiled in parallel (functions of a cell are serial)')
    run.add_argument('--timeout', type=int, default=300, help='Seconds per function')
    run.add_argument('--node', default='node')
    packets = commands.add_parser('packets', help='Seeded stratified blind X/Y packets')
    packets.add_argument('--label', required=True)
    packets.add_argument('--sample', type=int, required=True)
    packets.add_argument('--seed', type=int, required=True)
    packets.add_argument('--output', type=Path, required=True)
    packets.add_argument('--ghidra', type=Path, default=DEFAULT_GHIDRA)
    packets.add_argument('--runs', type=Path, default=DEFAULT_RUNS)
    packets.add_argument('--submissions', type=Path, help='Where reviewers write review-*.json (default: <output>-submissions)')
    packets.add_argument('--require-label', action='append', default=[], metavar='LABEL',
                         help='Only pairs that also have Open Decomp text in this other run (repeatable); keeps rounds comparable')
    aggregate = commands.add_parser('aggregate', help='Decode reviews with the sealed mapping')
    aggregate.add_argument('--packets', type=Path, required=True)
    aggregate.add_argument('--mapping', type=Path, required=True, help='Sealed directory holding mapping.json (the moved private/)')
    aggregate.add_argument('--review', type=Path, action='append', required=True)
    aggregate.add_argument('--output', type=Path, help='Default: <packets parent>/aggregate-<packets name>')
    args = parser.parse_args()
    return {'ghidra': command_ghidra, 'run': command_run, 'packets': command_packets, 'aggregate': command_aggregate}[args.command](args)


if __name__ == '__main__':
    sys.exit(main())

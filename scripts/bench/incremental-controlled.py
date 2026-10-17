#!/usr/bin/env python3
"""Declared cache-index counterfactual, separate from the frozen four-lane comparison.

Use --plan-only --source-functional to prepare/validate trusted public oracle inputs
without analysis. Actual normalized recording REQUIRES Main's final build/exclusive
host release (--build-ready); no waiting, lock stealing, forced GC or target execution.
"""
import argparse
import asyncio
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import sqlite3
import subprocess
import sys
import time
from types import SimpleNamespace

sys.dont_write_bytecode = True
import quality
from quality_persistent_snapshots import clone_snapshot, closed_project_facts, freeze_closed_project, project_manifest

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
loader = importlib.util.spec_from_file_location('quality_persistent_recording', HERE / 'quality-persistent.py')
recording = importlib.util.module_from_spec(loader)
loader.loader.exec_module(recording)
MemorySampler = recording.MemorySampler
EXPECTED_CASES = ['maximum', 'sum-loop', 'threadsafe', 'strnicmp']


def executable_inputs(args):
    """Pin only this experiment and actual production/oracle dependencies, never heldout inputs."""
    paths = {Path(__file__), HERE / 'quality.py', HERE / 'quality-persistent.py',
             HERE / 'quality_persistent_snapshots.py', REPO / 'package.json', REPO / 'bun.lock'}
    prefix = REPO if args.source_functional else REPO / 'dist'
    extension = '.ts' if args.source_functional else '.js'
    for name in ('incremental-controlled', 'incremental-controlled-worker',
                 'incremental-output-oracles', 'incremental-equivalence'):
        paths.add(prefix / 'scripts/bench' / (name + extension))
    for name in ('test/metadata/fixture', 'test/emitters/c/support',
                 'test/emitters/c/strnicmp-fixture', 'test/lifters/arm64/support'):
        paths.add(prefix / (name + extension))
    for root in (prefix / 'src', prefix / 'vendor'):
        quality.require(root.is_dir(), f'Final executable dependency root is missing: {root}')
        paths.update(path for path in root.rglob('*') if path.is_file() and
                     path.suffix in ('.ts', '.js', '.json', '.wasm'))
    quality.require(all(path.is_file() for path in paths), 'A pinned compiled/source oracle dependency is missing')
    return [{'path': str(path.relative_to(REPO)), 'bytes': path.stat().st_size,
             'sha256': quality.digest(path)} for path in sorted(paths)]


def exact_auxiliary_facts(directory):
    """Jobs and full metadata supplement the shared semantic-fact helper."""
    connection = sqlite3.connect((Path(directory) / 'project.sqlite').as_uri() + '?mode=ro', uri=True, timeout=0)
    try:
        metadata = connection.execute('SELECT singleton,project_id,revision FROM metadata ORDER BY singleton').fetchall()
        jobs = [(identity, hashlib.sha256(payload).hexdigest()) for identity, payload in
                connection.execute('SELECT id,payload FROM jobs ORDER BY id')]
        return {'metadata': metadata, 'jobs': jobs}
    finally:
        connection.close()


def without_reuse_facts(facts):
    return {**facts, 'tables': {name: value for name, value in facts['tables'].items() if name != 'analysis_reuse'},
            'facts_sha256': None}


def disable_exact_b_candidates(directory, spec, destination):
    """Only closed owned clones; semantic rows/artifact files are never mutated."""
    directory = Path(directory).resolve()
    quality.require(directory.is_relative_to(destination.parent.resolve()), 'Cache control must remain in its owned trial')
    before = closed_project_facts(directory)
    auxiliary = exact_auxiliary_facts(directory)
    files_before = project_manifest(directory)
    sql = 'DELETE FROM analysis_reuse WHERE scope=?'
    scope = spec['candidate_scope']
    connection = sqlite3.connect(directory / 'project.sqlite', timeout=0, isolation_level=None)
    try:
        connection.execute('PRAGMA foreign_keys=ON')
        connection.execute('BEGIN IMMEDIATE')
        rows = connection.execute(
            'SELECT scope,revision,artifact_id FROM analysis_reuse WHERE scope=? ORDER BY revision,artifact_id', (scope,)).fetchall()
        quality.require(bool(rows), 'Counterfactual must remove actual B candidates, not a guessed/nonexistent cache key')
        quality.require(spec['baseline_artifact_id'] in {row[2] for row in rows}, 'Exact baseline B publication must be among removed candidates')
        deleted = connection.execute(sql, (scope,)).rowcount
        remaining = connection.execute('SELECT COUNT(*) FROM analysis_reuse WHERE scope=?', (scope,)).fetchone()[0]
        quality.require(deleted == len(rows) and remaining == 0, 'Exact-B cache-index treatment was not complete')
        connection.execute('COMMIT')
    except BaseException:
        if connection.in_transaction:
            connection.execute('ROLLBACK')
        raise
    finally:
        connection.close()
    after = closed_project_facts(directory)
    quality.require(without_reuse_facts(before) == without_reuse_facts(after),
                    'Counterfactual changed a semantic/image/artifact/identity/schema fact')
    quality.require(exact_auxiliary_facts(directory) == auxiliary, 'Counterfactual changed job history or project metadata')
    files_after = project_manifest(directory)
    immutable = lambda files: [row for row in files if row['path'].startswith(('images/', 'artifacts/'))]
    quality.require(immutable(files_before) == immutable(files_after), 'Counterfactual changed an imported image or published artifact byte')
    result = {'kind': 'declared benchmark-only cache-index unavailability counterfactual',
              'normal_user_command': False, 'production_bypass': False, 'project': str(directory),
              'sql': sql, 'parameters': [scope], 'rows_before': rows, 'deleted_rows': deleted,
              'remaining_exact_scope_rows': remaining, 'before': before, 'after': after,
              'metadata_and_jobs_unchanged': True, 'immutable_file_hashes_unchanged': True}
    quality.save(destination, result)
    return result


async def invoke(args, mode, output, additional=(), sampled=False):
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    entry = REPO / ('scripts/bench/incremental-controlled.ts' if args.source_functional else 'dist/scripts/bench/incremental-controlled.js')
    command = [args.node, *(['--import', 'tsx'] if args.source_functional else []), str(entry),
               '--mode', mode, '--output', str(output), '--experiment', str(args.output),
               '--sqlite', str(args.sqlite), *map(str, additional)]
    process = await asyncio.create_subprocess_exec(*command, cwd=REPO,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    sampler = MemorySampler(SimpleNamespace(process=process), args.memory_interval) if sampled else None
    sampler_task = asyncio.create_task(sampler.run()) if sampler else None
    stderr_task = asyncio.create_task(process.stderr.read())
    events, stdout = [], []
    started = time.monotonic_ns()
    try:
        while True:
            line = await process.stdout.readline()
            if not line:
                break
            stdout.append(line)
            try:
                event = json.loads(line)
            except Exception:
                continue
            events.append({**event, 'received_monotonic_ns': time.monotonic_ns()})
            if sampler and event.get('kind') == 'window':
                sampler.phase = event['phase'] if event['state'] == 'begin' else 'post-request-verification'
        status = await process.wait()
    finally:
        if sampler:
            sampler.stopped = True
            await sampler_task
    stderr = await stderr_task
    output.mkdir(parents=True, exist_ok=True)
    (output / 'driver.stdout.jsonl').write_bytes(b''.join(stdout))
    (output / 'driver.stderr.txt').write_bytes(stderr)
    timestamps = [sample['monotonic_ns'] for sample in sampler.samples] if sampler else []
    evidence = {'command': command, 'pid': process.pid, 'status': status,
                'started_monotonic_ns': started, 'ended_monotonic_ns': time.monotonic_ns(),
                'events': events, 'measurement_class': 'shared-host source functional' if args.source_functional else 'exclusive compiled observed counterfactual',
                'memory_samples': sampler.samples if sampler else [],
                'memory_summary': sampler.summary() if sampler else None,
                'requested_sampler_sleep_seconds': args.memory_interval if sampler else None,
                'actual_ps_result_intervals_seconds': recording.distribution([
                    (right - left) / 1e9 for left, right in zip(timestamps, timestamps[1:])]),
                'requested_sleep_is_not_actual_sampling_cadence': True}
    quality.save(output / 'invocation.json', evidence)
    quality.require(status == 0, f'{mode} failed; retain {output}/driver.stderr.txt and every selected case')
    return evidence


def bind_worker_evidence(directory, invocation):
    directory = Path(directory)
    run = json.loads((directory / 'run.json').read_text())
    worker = [json.loads(line) for line in (directory / 'worker.jsonl').read_text().splitlines() if line.strip()]
    selected = [row for row in worker if row.get('kind') == 'operation' and
                row.get('operation') == 'function_decompile' and row.get('function_id') == run['function_id']]
    quality.require(len(selected) == 1, 'Exactly one actual selected-body operation must correspond to the measured window')
    operation = selected[0]
    quality.require(operation['lifts'] == 0 if run['role'] == 'reuse' else operation['lifts'] > 0,
                    'Reuse must avoid actual body/callee lifting; control must perform actual analysis')
    final_reads = [row for row in worker if row.get('kind') == 'artifact-read' and
                   row.get('artifact_id') == run['artifact']['id'] and row.get('final_chunk')]
    quality.require(len(final_reads) == 1, 'Full public artifact delivery must have one observed terminal chunk')
    boundaries = [event for event in invocation['events'] if event.get('kind') == 'window' and event.get('phase') == run['phase']]
    quality.require([event['state'] for event in boundaries] == ['begin', 'end'], 'One complete public delivery window is required')
    start, end = (event['received_monotonic_ns'] for event in boundaries)
    # The shared sampler labels before starting ps. Conservatively exclude a ps
    # result delivered after the end boundary, rather than count later oracle work.
    samples = [row for row in invocation['memory_samples'] if row['phase'] == run['phase'] and
               start <= row['monotonic_ns'] <= end]
    worker_peaks = [member['rss_kib'] * 1024 for sample in samples for member in sample['members']
                    if member['pid'] == operation['pid']]
    peak = max(worker_peaks) if worker_peaks else None
    result = {**run, 'invocation': str(directory / 'invocation.json'), 'worker': operation,
              'delivery_worker_endpoint': final_reads[0]['after'],
              'external_worker_peak_rss_bytes': peak,
              'external_window_samples': len(worker_peaks),
              'external_window_receipt_ns': {'start': start, 'end': end},
              'actual_window_ps_result_intervals_seconds': recording.distribution([
                  (right['monotonic_ns'] - left['monotonic_ns']) / 1e9
                  for left, right in zip(samples, samples[1:])]),
              'external_peak_unavailable': None if worker_peaks else 'No external worker sample overlapped this short request; unavailable, not zero',
              'lifetime_rss_is_not_operation_peak': True}
    quality.save(directory / 'matched-run.json', result)
    return result


def public_history_shape(history):
    """Only clone paths and independently validated opaque publication IDs differ."""
    result = []
    for row in history:
        request = dict(row['request'])
        if row['operation'] == 'project_open':
            request['source'] = {**request['source'], 'project_path': '<owned-byte-identical-snapshot-clone>'}
        elif row['operation'] == 'artifact_read':
            request['artifact_id'] = '<independently-sha256-validated-publication-for-label>'
        result.append({**row, 'request': request})
    return result


async def run_experiment(args):
    quality.require(not args.output.exists(), 'Never overwrite retained measurement evidence')
    args.output.mkdir(parents=True)
    quality.save(args.output / 'owner.json', {'schema': 'open-decomp/incremental-controlled-owner/1'})
    pinned = executable_inputs(args)
    plan = {'schema': 'open-decomp/incremental-controlled/1', 'target_executed': False,
            'forced_gc': False, 'runtime': {'python': sys.version, 'platform': platform.platform(),
                'node': subprocess.check_output([args.node, '--version'], text=True).strip()},
            'executable_inputs': pinned,
            'class': 'shared-host source functional, NOT normalized performance' if args.source_functional else 'exclusive compiled observed counterfactual',
            'protocol': 'Original leaf cases retained alongside fixture sum-loop and actual SQLite strnicmp. Closed byte-identical snapshots and identical fresh-worker public warmups. Offline exact-B candidate index availability is the sole treatment. Balanced serialized orders, independent output oracles, separate same-post-analysis reopen pairs.',
            'limitations': 'Sampled external maxima are lower bounds, not exact allocation peaks; unsampled windows remain unavailable. Heap/RSS endpoints and lifetime maxima stay separate. No GC forcing. Full request+artifact delivery latencies include integrity/schema work; none is subtracted. Reopen is compared only against its fresh-worker matched control, never against warm lifetime RSS. Raw proof derivation revisions are preserved; full result/catalog semantic equivalence explicitly alpha-renames proof IDs/revisions only.',
            'iterations': args.iterations, 'runs': [], 'pairs': [], 'failures': []}
    quality.save(args.output / 'experiment.json', plan)
    await invoke(args, 'plan', args.output / 'plan')
    cases = json.loads((args.output / 'plan/plan.json').read_text())['cases']
    quality.require([case['kind'] for case in cases] == EXPECTED_CASES, 'Do not remove or silently replace a historical/complex case')
    for case in cases:
        case['binary_bytes'] = Path(case['binary']).stat().st_size
    plan['cases'] = cases
    if args.plan_only:
        quality.save(args.output / 'experiment.json', plan)
        return plan
    for case_index, case in enumerate(cases):
        kind = case['kind']
        seed_dir = args.output / kind / 'seed'
        try:
            await invoke(args, 'prepare', seed_dir, ['--case', kind])
            spec_path = seed_dir / 'spec.json'
            spec = json.loads(spec_path.read_text())
            snapshot = freeze_closed_project(seed_dir / 'project', args.output / kind / 'snapshot')
            reopen_snapshot = None
            reopen_spec = None
            for lifecycle in ('first', 'reopen'):
                active_snapshot = snapshot if lifecycle == 'first' else reopen_snapshot
                active_spec_path = spec_path if lifecycle == 'first' else reopen_spec
                quality.require(active_snapshot is not None and active_spec_path is not None, 'Matched post-analysis reopen snapshot unavailable')
                active_spec = json.loads(Path(active_spec_path).read_text())
                for iteration in range(args.iterations):
                    trial = args.output / kind / lifecycle / f'trial-{iteration:02d}'
                    trial.mkdir(parents=True)
                    role_order = ('control', 'reuse') if (iteration + case_index) % 2 == 0 else ('reuse', 'control')
                    paired = {}
                    for role in role_order:
                        project = trial / f'{role}-project'
                        clone = clone_snapshot(active_snapshot, project)
                        if role == 'control':
                            disable_exact_b_candidates(project, active_spec, trial / 'cache-control.json')
                        else:
                            quality.save(trial / 'reuse-control.json', {'kind': 'unchanged byte-identical snapshot candidate availability', 'clone': clone})
                        directory = trial / role
                        invocation = await invoke(args, 'measure', directory,
                            ['--case', kind, '--project', project, '--spec', active_spec_path,
                             '--role', role, '--lifecycle', lifecycle], sampled=True)
                        run = bind_worker_evidence(directory, invocation)
                        paired[role] = run
                        plan['runs'].append(run)
                        quality.save(args.output / 'experiment.json', plan)
                    quality.require(paired['control']['warmup_payload_sha256'] == paired['reuse']['warmup_payload_sha256'],
                                    'Identical public warmup histories produced different full outputs before the treatment request')
                    control_history = public_history_shape(paired['control']['history'])
                    reuse_history = public_history_shape(paired['reuse']['history'])
                    quality.save(trial / 'matched-public-history.json', {
                        'normalization': 'Only owned clone paths and opaque artifact-read IDs; exact project/revision/function IDs, delivery, offsets, lengths and all request fields preserved',
                        'control': control_history, 'reuse': reuse_history})
                    quality.require(control_history == reuse_history, 'Public request/warmup/full-artifact-delivery histories differ')
                    await invoke(args, 'compare', trial / 'comparison',
                        ['--left', paired['control']['payload'], '--right', paired['reuse']['payload']])
                    plan['pairs'].append({'case': kind, 'lifecycle': lifecycle, 'iteration': iteration,
                        'order': role_order, 'same_warmup_payload': True, 'same_public_history': True, 'same_exact_identity': True,
                        'full_semantic_equivalence': True,
                        'control': paired['control']['payload'], 'reuse': paired['reuse']['payload'],
                        'control_delivery_ms': paired['control']['full_delivery_ms'],
                        'reuse_delivery_ms': paired['reuse']['full_delivery_ms'],
                        'control_peak_rss_bytes': paired['control']['external_worker_peak_rss_bytes'],
                        'reuse_peak_rss_bytes': paired['reuse']['external_worker_peak_rss_bytes'],
                        'control_endpoint_rss_bytes': paired['control']['delivery_worker_endpoint']['rss'],
                        'reuse_endpoint_rss_bytes': paired['reuse']['delivery_worker_endpoint']['rss'],
                        'control_endpoint_heap_used_bytes': paired['control']['delivery_worker_endpoint']['heapUsed'],
                        'reuse_endpoint_heap_used_bytes': paired['reuse']['delivery_worker_endpoint']['heapUsed']})
                    if lifecycle == 'first' and iteration == 0:
                        reopen_spec = trial / 'reuse' / 'post-spec.json'
                        reopen_snapshot = freeze_closed_project(trial / 'reuse-project', args.output / kind / 'reopen-snapshot')
                    quality.save(args.output / 'experiment.json', plan)
        except Exception as error:
            plan['failures'].append({'case': kind, 'error': repr(error)})
            quality.save(args.output / 'experiment.json', plan)
    distributions = []
    for case in EXPECTED_CASES:
        for lifecycle in ('first', 'reopen'):
            for role in ('control', 'reuse'):
                selected = [run for run in plan['runs'] if run['case'] == case and run['lifecycle'] == lifecycle and run['role'] == role]
                distributions.append({'case': case, 'lifecycle': lifecycle, 'role': role,
                    'full_delivery_ms': recording.distribution([run['full_delivery_ms'] for run in selected]),
                    'response_descriptor_ms': recording.distribution([run['response_ms'] for run in selected]),
                    'external_worker_peak_rss_bytes': recording.distribution([run['external_worker_peak_rss_bytes'] for run in selected if run['external_worker_peak_rss_bytes'] is not None]),
                    'worker_endpoint_rss_bytes': recording.distribution([run['delivery_worker_endpoint']['rss'] for run in selected]),
                    'worker_endpoint_heap_used_bytes': recording.distribution([run['delivery_worker_endpoint']['heapUsed'] for run in selected]),
                    'unavailable_external_peaks': sum(run['external_worker_peak_rss_bytes'] is None for run in selected)})
    plan['distributions'] = distributions
    paired_statistics = []
    for case in EXPECTED_CASES:
        for lifecycle in ('first', 'reopen'):
            pairs = [pair for pair in plan['pairs'] if pair['case'] == case and pair['lifecycle'] == lifecycle]
            endpoint_differences = [pair['reuse_endpoint_rss_bytes'] - pair['control_endpoint_rss_bytes'] for pair in pairs]
            complete_peaks = [pair for pair in pairs if pair['control_peak_rss_bytes'] is not None and pair['reuse_peak_rss_bytes'] is not None]
            paired_statistics.append({'case': case, 'lifecycle': lifecycle, 'pairs': len(pairs),
                'endpoint_rss_difference_reuse_minus_control_bytes': recording.distribution(endpoint_differences),
                'endpoint_heap_difference_reuse_minus_control_bytes': recording.distribution([
                    pair['reuse_endpoint_heap_used_bytes'] - pair['control_endpoint_heap_used_bytes'] for pair in pairs]),
                'full_delivery_difference_reuse_minus_control_ms': recording.distribution([
                    pair['reuse_delivery_ms'] - pair['control_delivery_ms'] for pair in pairs]),
                'sampled_peak_difference_reuse_minus_control_bytes': recording.distribution([
                    pair['reuse_peak_rss_bytes'] - pair['control_peak_rss_bytes'] for pair in complete_peaks]),
                'pairs_without_two_observed_peaks': len(pairs) - len(complete_peaks),
                'all_observed_endpoint_differences_positive': bool(endpoint_differences) and min(endpoint_differences) > 0,
                'interpretation': 'Raw paired endpoint differences, not allocations/peaks or an automatic memory-win claim. Missing peak pairs cannot support peak improvement; sustained regressions require owned-retention investigation.'})
    plan['paired_statistics'] = paired_statistics
    plan['executable_inputs_unchanged'] = executable_inputs(args) == pinned
    if not plan['executable_inputs_unchanged']:
        plan['failures'].append({'case': 'executable-build-scope', 'error': 'Pinned production/oracle files changed during the experiment; do not claim matched normalized results'})
    quality.save(args.output / 'experiment.json', plan)
    return plan


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--sqlite', type=Path, required=True)
    parser.add_argument('--node', default='node')
    parser.add_argument('--iterations', type=int, default=6)
    parser.add_argument('--memory-interval', type=float, default=.002)
    parser.add_argument('--lock', type=Path, default=REPO / '.local/performance/quality.measurement.lock')
    parser.add_argument('--build-ready', action='store_true', help='Main authorizes final compiled build and exclusive serialized host ownership')
    parser.add_argument('--source-functional', action='store_true', help='Correctness/source smoke only; never label its timing normalized')
    parser.add_argument('--plan-only', action='store_true', help='Validate declared static source oracle inputs; no project import/decompilation')
    args = parser.parse_args()
    args.output = args.output.resolve(); args.sqlite = args.sqlite.resolve(); args.lock = args.lock.resolve()
    quality.require(args.sqlite.is_file(), 'Explicit reviewed public SQLite input is required')
    quality.require(1 <= args.iterations <= 30 and .002 <= args.memory_interval <= 10, 'Bounded repetitions and explicit sampler sleep (not assumed cadence) required')
    quality.require(not os.environ.get('NODE_OPTIONS'), 'Do not inherit hidden observer/GC/runtime options')
    if not args.source_functional:
        quality.require(args.build_ready, 'No normalized recording before Main final build/exclusive release')
        quality.require(args.iterations >= 4 and args.iterations % 2 == 0, 'Normalized roles require balanced even repetition counts')
        quality.require((REPO / 'dist/scripts/bench/incremental-controlled.js').is_file(), 'Final compiled new benchmark driver is missing')
    acquired = False
    try:
        if not args.plan_only:
            quality.require(not args.lock.exists(), 'Measurement host is owned; never poll, steal or remove another lane lock')
            args.lock.parent.mkdir(parents=True, exist_ok=True)
            args.lock.mkdir()
            acquired = True
        plan = asyncio.run(run_experiment(args))
        print(json.dumps({'output': str(args.output), 'plan_only': args.plan_only,
                          'pairs': len(plan['pairs']), 'failures': plan['failures'],
                          'measurement_class': plan['class']}, indent=2))
        return 1 if plan['failures'] else 0
    finally:
        if acquired:
            args.lock.rmdir()


if __name__ == '__main__':
    sys.exit(main())

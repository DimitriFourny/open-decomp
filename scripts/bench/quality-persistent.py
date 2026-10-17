#!/usr/bin/env python3
"""Normalized, serialized real-MCP performance recording; no engine-speed ranking.

Uses quality.MCP unchanged for Open Decomp, the pinned unchanged real bridge,
and a separately identified persistent/reused Ghidra DecompInterface lane.
Run only after the coordinator's final build and with exclusive host ownership.
"""
import argparse
import asyncio
from collections import defaultdict
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import statistics
import subprocess
import sys
import time
import traceback

sys.dont_write_bytecode = True
import quality
from quality_persistent_snapshots import clone_snapshot, closed_project_facts, freeze_closed_project

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
LANES = ('open-decomp', 'open-decomp-observed', 'ghidra-bridge', 'ghidra-persistent')
HARNESS_FILES = ('quality.py', 'quality-ghidra.py', 'quality-persistent.py',
                 'quality-persistent-ghidra.py', 'quality-persistent-observer.mjs',
                 'quality-persistent-hooks.json', 'quality_persistent_snapshots.py')
METHOD = {
    'client': 'quality.MCP unchanged: same Python stdlib newline JSON-RPC path for all lanes',
    'target_execution': False,
    'source_debug_types_supplied': False,
    'dialect': 'C-like; upstream default Ghidra options in both Ghidra lanes',
    'work': 'Same manifest-selected function addresses, one request at a time, all failures retained',
    'budgets': 'OD original profile unchanged; Ghidra timeout matches deadline in whole seconds. '
               'Ghidra has no equivalent exposed instruction/node/work budget; never claim identical engine limits.',
    'output': 'Full OD artifact assembly is timed separately from initial delivery. Both Ghidra lanes '
              'use the same max_chars; truncated or missing text is ineligible, never a faster success.',
    'fresh': 'OD imports are measured independently as import_only. Fresh OD analysis opens two byte-identical '
             'cache-cold copies of one closed post-import project snapshot, preserving project ID/revision/context '
             'scope. Ghidra fresh means a new project/import/analysis owner. No OS/installation cache flushing.',
    'resume': 'OD paired resume owners open byte-identical copies of the same closed post-analysis snapshot, '
              'including identical cache state. Ghidra reopens its saved project without reanalysis and starts '
              'a cold native interface. Original binary input paths stay unchanged and authorized.',
    'repeated': 'Same process/program/request. Record actual OD cache marker. '
                'Pinned bridge creates/disposes an interface per call; persistent lane retains the real interface '
                'and its native caches, not a Python text cache.',
    'stages': {
        'startup': 'Wall time for quality.MCP.start including process launch, initialize and tools/list',
        'import': 'OD public project_open combines import/discovery, while trusted compiled hooks '
                  'separately time native loaders, immutable-byte import, discovery, navigation preparation '
                  'and SQLite transactions. Ghidra program_open(analyze=false) imports/saves only.',
        'analysis': 'OD trusted hooks time the actual compute callback, lift, SSA construction/simplification, '
                    'type recovery, source recovery, reconstruction, rendering, cache validation and publication. '
                    'Ghidra analysis_run is a separate real MCP operation including transaction/save.',
        'decompile': 'Request-boundary latency and separately full artifact delivery latency',
        'transport': 'Actual ping no-work RPC controls retained; include dispatch/logging and are NOT '
                     'transport-only time. No subtraction from decompile timings.',
        'memory': 'Sampled ps process-tree summed RSS in KiB; includes workers/native decompiler children. '
                  'Shared pages may be counted more than once; interval sampling misses peaks. '
                  'Client RSS is separate, not engine heap or unique resident memory.',
    },
    'unavailable': {
        'cross_engine_engine_only_ms': 'No shared isolated engine-only boundary across all four lanes; '
                                       'actual instrumented pass spans are retained, never inferred by subtraction',
        'unchanged_bridge_engine_only_ms': 'Pinned unchanged bridge exposes no isolated timer',
        'transport_only_ms': 'No transport-only hook; ping is an overhead control, not a decomposition',
        'cross_engine_semantic_coverage_equivalence': 'Not reported by Ghidra bridge; independent behavioral review required',
    },
    'observation': 'OD uses benchmark-only Node module hooks on an exact hashed compiled build. '
                   'AST selectors fail closed, existing trusted runtime observer seams bind jobs/progress, '
                   'and no production file, request, budget or output option is changed. Sidecars buffer '
                   'phase-boundary memory/timing evidence outside MCP. Nested/inclusive spans overlap and '
                   'must not be summed as exclusive engine costs. Instrumentation overhead remains in public timings.',
    'observer_control': 'Instrumented and uninstrumented OD analysis runs use the same closed project snapshot, '
                        'compiled build, input, profile, functions, cache state and repetition count. Exact '
                        'project/revision/native-context identity and component/inference/requirement/local-'
                        'validation metadata are compared without stripping context IDs, together with source '
                        'text, state/coverage and cache markers. Initial imports are separately paired by logical '
                        'fact/hash scope and public import state, not treated as the decompile control. Missing '
                        'outputs are unverifiable, not equality. Lanes never pool. Paired latency/RSS differences '
                        'include OS/order/cache noise and nonzero observer allocations; not isolated engine costs.',
    'statistics': 'Keep raw samples; min/max/mean/stdev and nearest-rank p50/p90/p95 by lane, '
                  'input, lifecycle, function, stage, observed state/cache and delivery eligibility; '
                  'do not pool failures, partial coverage, default/raised profiles or different lifecycles',
    'claim': 'Measurement evidence only. Equal requested addresses are not proof of equivalent '
             'semantic recovery. No engine speed claim from bridge startup/cache/transport differences.',
}


def distribution(values):
    ordered = sorted(values)
    if not ordered:
        return {'count': 0, 'values': []}
    return {
        'count': len(values), 'values': values,
        'min': ordered[0], 'max': ordered[-1], 'mean': statistics.mean(values),
        'stdev': statistics.stdev(values) if len(values) > 1 else None,
        **{f'p{p}': ordered[max(0, math.ceil(len(ordered) * p / 100) - 1)]
           for p in (50, 90, 95)},
    }


class MemorySampler:
    def __init__(self, client, interval):
        self.client, self.interval = client, interval
        self.phase = 'startup'
        self.samples = []
        self.stopped = False
        self.failures = []

    async def run(self):
        while not self.stopped:
            process = getattr(self.client, 'process', None)
            if process is not None:
                phase = self.phase
                try:
                    probe = await asyncio.create_subprocess_exec(
                        'ps', '-axo', 'pid=,ppid=,rss=',
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                    stdout, stderr = await probe.communicate()
                    quality.require(probe.returncode == 0, stderr.decode(errors='replace'))
                    rows = [tuple(map(int, row.split())) for row in stdout.decode().splitlines()]
                    pids = {process.pid}
                    while True:
                        children = {pid for pid, parent, _ in rows if parent in pids}
                        expanded = pids | children
                        if expanded == pids:
                            break
                        pids = expanded
                    members = [{'pid': pid, 'rss_kib': rss} for pid, _, rss in rows if pid in pids]
                    self.samples.append({
                        'monotonic_ns': time.monotonic_ns(), 'phase': phase,
                        'server_tree_rss_kib': sum(row['rss_kib'] for row in members),
                        'members': members,
                        'client_rss_kib': next((rss for pid, _, rss in rows if pid == os.getpid()), None),
                    })
                except Exception as error:
                    self.failures.append(repr(error))
            await asyncio.sleep(self.interval)

    def summary(self):
        grouped = defaultdict(list)
        for sample in self.samples:
            grouped[sample['phase']].append(sample['server_tree_rss_kib'])
        return {'interval_seconds': self.interval, 'units': 'KiB summed sampled RSS',
                'phases': {phase: {'samples': len(values), 'observed_max_kib': max(values)}
                           for phase, values in grouped.items()}, 'errors': self.failures,
                'unavailable': None if self.samples else 'No process-tree samples collected'}


def items_from_manifest(manifest, root, selected):
    items = []
    cells = manifest.get('inputs', manifest.get('cells', []))
    quality.require(bool(cells), 'Manifest has neither reviewed inputs nor matrix cells')
    known = {cell['id'] for cell in cells}
    quality.require(not selected or set(selected) <= known, 'Unknown requested input/cell')
    for cell in cells:
        if selected and cell['id'] not in selected:
            continue
        identity = cell.get('input', cell)
        status = cell.get('status', 'built')
        item = {'id': cell['id'], 'functions': cell.get('functions', []),
                'status': status, 'manifest_record': cell}
        if status == 'built':
            relative = Path(identity['path'])
            if relative.is_absolute() and manifest.get('root'):
                relative = relative.relative_to(Path(manifest['root']))
            binary = (root / relative).resolve()
            quality.require(binary.is_relative_to(root), 'Input escapes the authorized input root')
            quality.require(binary.stat().st_size == identity['bytes'] and
                            quality.digest(binary) == identity['sha256'], f'Input mismatch: {binary}')
            item['binary'] = str(binary)
            item['sha256'] = identity['sha256']
        items.append(item)
    return items


def retain_harness(output, expected=None):
    directory = output / 'harness'
    directory.mkdir()
    identities = {}
    for name in HARNESS_FILES:
        source = HERE / name
        identities[name] = quality.digest(source)
        if expected is not None:
            quality.require(identities[name] == expected[name], 'Harness changed after identity capture')
        (directory / name).write_bytes(source.read_bytes())
    return identities


def prepare_observer(args, identity=None):
    directory = args.output / 'observer'
    directory.mkdir()
    root = args.entry.parent.parent
    specification = HERE / 'quality-persistent-hooks.json'
    modules = json.loads(specification.read_text())['modules']
    files = {name: quality.digest(root / name) for name in modules}
    if identity is not None:
        for name, sha in files.items():
            quality.require(identity['compiled_files'].get(name) == sha, 'Compiled build changed before observation preparation')
    pins = {'schema': 1, 'root': str(root), 'prepared': str(directory / 'modules'),
            'observer_sha256': quality.digest(HERE / 'quality-persistent-observer.mjs'),
            'spec_sha256': quality.digest(specification), 'files': files}
    path = directory / 'pins.json'
    quality.save(path, pins)
    command = [args.node, str(HERE / 'quality-persistent-observer.mjs'), '--prepare', str(path)]
    process = subprocess.run(command, text=True, capture_output=True, check=False)
    quality.save(directory / 'preparation.json', {
        'command': command, 'exit_code': process.returncode,
        'stdout': process.stdout, 'stderr': process.stderr, 'measurements_exercised': False})
    quality.require(process.returncode == 0, 'Observer preparation failed; inspect observer/preparation.json')
    prepared = json.loads(process.stdout)
    quality.require(prepared['measurements_exercised'] is False, 'Observer preparation must not run a workload')
    return {'pins': str(path), 'preparation': prepared}


def command_for(args, lane, project, directory):
    if lane == 'open-decomp':
        return ([args.node, str(args.entry), 'mcp', 'start', '--root', str(args.inputs),
                 '--root', str(args.output)], {})
    if lane == 'open-decomp-observed':
        environment = {
            'OPEN_DECOMP_PHASE_PINS': str(args.output / 'observer/pins.json'),
            'OPEN_DECOMP_PHASE_METRICS': str(directory / 'od-phases'),
            # Inherited by the normal persistent worker, without a public plugin
            # or alternate QueryService/entrypoint.
            'NODE_OPTIONS': (os.environ.get('NODE_OPTIONS', '') + ' --import=' +
                             (HERE / 'quality-persistent-observer.mjs').as_uri()).strip(),
        }
        return ([args.node, str(args.entry), 'mcp', 'start', '--root', str(args.inputs),
                 '--root', str(args.output)], environment)
    launcher = 'quality-ghidra.py' if lane == 'ghidra-bridge' else 'quality-persistent-ghidra.py'
    environment = {
        'GHIDRA_INSTALL_DIR': str(args.ghidra), 'JAVA_HOME': str(args.java_home),
        'JAVA_TOOL_OPTIONS': '-Djava.awt.headless=true',
        'GHIDRA_MCP_STORAGE_ROOT': str(project), 'GHIDRA_MCP_TRANSPORT': 'stdio',
        'GHIDRA_MCP_ANALYSIS_TIMEOUT_SECONDS': str(args.timeout),
    }
    if lane == 'ghidra-persistent':
        environment['OPEN_DECOMP_PERSISTENT_METRICS'] = str(directory / 'phase-metrics.jsonl')
    return [str(args.ghidra_bridge / '.venv/bin/python'), str(HERE / launcher)], environment


async def session(args, config, item, lane, iteration, lifecycle, project=None, starting_snapshot=None):
    directory = args.output / item['id'] / f'run{iteration}' / lane / lifecycle
    project = project or directory.parent / 'project'
    command, environment = command_for(args, lane, project, directory)
    client = quality.MCP(directory, command, environment, args.timeout)
    memory = MemorySampler(client, args.memory_interval)
    sampling = asyncio.create_task(memory.run())
    run = {'input': item['id'], 'lane': lane, 'iteration': iteration, 'lifecycle': lifecycle,
           'profile': args.profile, 'functions': [], 'stages': [], 'transport_controls': [],
           'scope': None, 'target_executed': False, 'correctness_verified': False}
    run['directory'] = str(directory.relative_to(args.output))
    run['project_path'] = str(project)
    run['starting_snapshot'] = starting_snapshot
    run['lifecycle_definition'] = (
        'fresh import/discovery only; no selected function decompiled' if lifecycle == 'import_only'
        else 'cache-cold first analysis from the shared closed post-import snapshot'
        if lane.startswith('open-decomp') and lifecycle == 'fresh'
        else 'shared closed post-analysis cache snapshot, opened by a new owner'
        if lane.startswith('open-decomp') else 'native engine fresh/resumed project lifecycle')
    scope = None
    budget = config['budgets'][args.profile]

    async def stage(label, name, request):
        memory.phase = label
        value, record, failed = await client.call(name, request)
        run['stages'].append({'phase': label, 'call': record, 'is_error': failed, 'result': value})
        quality.require(not failed and isinstance(value, dict), f'{label} failed; inspect raw response')
        return value

    try:
        started = time.perf_counter()
        await client.start()
        run['startup_ms'] = (time.perf_counter() - started) * 1000
        run['server_info'] = client.server_info
        if lane.startswith('open-decomp'):
            source = ({'kind': 'import', 'input_path': item['binary'], 'project_path': str(project)}
                      if lifecycle == 'import_only' else {'kind': 'resume', 'project_path': str(project)})
            opened = await stage('import_discovery' if lifecycle == 'import_only' else 'snapshot_open',
                                 'project_open', {'source': source, 'wait': True, 'budget': budget})
            quality.require(opened.get('project_id') and opened.get('revision') is not None,
                            'Open Decomp did not acknowledge a snapshot')
            scope = {key: opened[key] for key in ('project_id', 'revision')}
            if starting_snapshot:
                quality.require(scope == {key: starting_snapshot[key] for key in ('project_id', 'revision')},
                                'Snapshot owner changed the exact project/revision namespace')
            info = await stage('metadata', 'binary_info', scope)
            image_id = info['data']['image']['id']
            run['image'] = info['data']['image']
            quality.require(run['image']['sha256'] == item['sha256'], 'Public image identity differs from the reviewed input')
        else:
            opened = await stage('import' if lifecycle == 'fresh' else 'resume_open',
                                 'program_open', {'binary_path': item['binary'], 'analyze': False})
            quality.require(opened.get('program_id'), 'Ghidra did not acknowledge a program')
            scope = {'program_id': opened['program_id']}
            if lifecycle == 'fresh':
                await stage('analysis', 'analysis_run', scope)
            await stage('metadata', 'program_info', scope)
        run['scope'] = scope
        for selected in ([] if lifecycle == 'import_only' else item['functions']):
            if args.function and selected['name'] not in args.function:
                continue
            row = {'name': selected['name'], 'address': selected['address'], 'samples': []}
            run['functions'].append(row)
            if lane.startswith('open-decomp'):
                memory.phase = 'function_lookup'
                found, record, failed = await client.call('functions_find', {
                    **scope, 'image_id': image_id, 'address': {
                        'image_id': image_id, 'space': 'va', 'value': selected['address']},
                    'page': {'limit': 1000}, 'budget': budget,
                })
                row['lookup'] = {'call': record, 'is_error': failed}
                matches = [fn for fn in (found.get('data') or {}).get('items', [])
                           if int(fn['entry']['value'], 16) == int(selected['address'], 16)] if isinstance(found, dict) else []
                if failed or len(matches) != 1:
                    row['gap'] = 'Selected entry missing or ambiguous; no narrowed/substitute function measured'
                    continue
                row['function_id'] = matches[0]['id']
                request = {**scope, 'function_id': matches[0]['id'], 'wait': True,
                           'options': {'emitter': 'c-like'}, 'budget': budget}
                operation = 'function_decompile'
            else:
                # The pinned tool resolves a containing function; verify the returned
                # entry below so an interior-address replacement cannot look like success.
                request = {**scope, 'address': selected['address'],
                           'timeout_seconds': min(300, max(1, budget['deadline_ms'] // 1000)),
                           'max_chars': config['ghidra']['max_chars']}
                operation = 'decompile_function'
            for repeat in range(args.warm_runs + 1):
                kind = 'first' if repeat == 0 else 'repeated'
                memory.phase = f'{kind}_decompile'
                started = time.perf_counter()
                value, record, failed = await client.call(operation, request)
                sample = {'kind': kind, 'repeat': repeat, 'call': record, 'is_error': failed,
                          'delivery_eligible': False, 'correctness_verified': False}
                row['samples'].append(sample)
                if isinstance(value, dict):
                    sample['operation_state'] = value.get('state')
                    failure = value.get('error')
                    sample['failure_code'] = failure.get('code') if isinstance(failure, dict) else None
                if failed or not isinstance(value, dict):
                    sample['gap'] = 'Real tool error or non-object payload'
                    sample['full_delivery_ms'] = (time.perf_counter() - started) * 1000
                    continue
                text = None
                emitted_metadata = None
                if lane.startswith('open-decomp'):
                    memory.phase = f'{kind}_artifact_delivery'
                    artifact_started = time.perf_counter()
                    emit, semantic, artifact = await quality.emission(
                        client, value, f'{selected["name"]}-{repeat}')
                    if artifact is not None:
                        sample['artifact_assembly_ms'] = (time.perf_counter() - artifact_started) * 1000
                    sample.update({'operation_state': value.get('state'), 'reason': value.get('reason'),
                                   'semantic_state': semantic.get('state'), 'coverage': semantic.get('coverage'),
                                   'diagnostics': semantic.get('diagnostics'), 'versions': semantic.get('versions'),
                                   'options': semantic.get('options'), 'budget': semantic.get('budget'),
                                   'cache': (value.get('data') or {}).get('cache'), 'artifact': artifact})
                    sample['cache_identity_scope'] = {
                        'image_sha256': run['image']['sha256'],
                        'slice_id': run['image']['selected_slice_id'], 'target': run['image']['target'],
                        'function_id': request['function_id'], 'versions': semantic.get('versions'),
                        'annotation_revision': semantic.get('revision'), 'evidence_revision': semantic.get('revision'),
                        'options': semantic.get('options'), 'budget': semantic.get('budget'),
                    }
                    quality.require(semantic.get('budget') == budget, 'Requested OD budget was changed')
                    if emit:
                        text = emit.get('text')
                        inferences = emit.get('inferences')
                        emitted_metadata = {
                            'schema_version': semantic.get('schema_version'),
                            'component_metadata': {'versions': semantic.get('versions'),
                                                   'emitter_version': emit.get('emitter_version'),
                                                   'target': run['image']['target']},
                            'context_metadata': [
                                {'inference_id': inference['id'], 'call_id': inference['details']['call_id'],
                                 'context_assumptions': inference['details']['context_assumptions']}
                                for inference in inferences or []
                                if inference.get('details', {}).get('kind') == 'call'
                                and 'context_assumptions' in inference['details']],
                            'inferences': inferences, 'requirements': emit.get('requirements'),
                            'local_validation': emit.get('local_validation'), 'helpers': emit.get('helpers'),
                            'signature': (semantic.get('data') or {}).get('signature'),
                            'capabilities': (semantic.get('data') or {}).get('capabilities'),
                        }
                    sample['delivery_eligible'] = bool(text) and semantic.get('state') == 'complete'
                else:
                    sample.update({'semantic_state': 'not_reported_by_bridge',
                                   'truncated': value.get('truncated'), 'cache': 'not_exposed'})
                    sample['entry_matches'] = int(value['entry_point'], 16) == int(selected['address'], 16)
                    text = value.get('c')
                    sample['delivery_eligible'] = bool(text) and sample['entry_matches'] and value.get('truncated') is False
                sample['full_delivery_ms'] = (time.perf_counter() - started) * 1000
                if emitted_metadata is not None:
                    # Extra audit serialization is outside the delivery timer; the
                    # complete original wire/schema parse/log costs remain inside MCP.
                    metadata_path = directory / f'{selected["name"]}-{repeat}.metadata.json'
                    quality.save(metadata_path, emitted_metadata)
                    sample['emission_metadata'] = {'path': str(metadata_path.relative_to(args.output)),
                                                   'sha256': quality.digest(metadata_path)}
                    for field in ('component_metadata', 'context_metadata', 'inferences', 'requirements', 'local_validation'):
                        encoded = json.dumps(emitted_metadata[field], sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
                        sample[field + '_sha256'] = hashlib.sha256(encoded).hexdigest()
                if text:
                    path = directory / f'{selected["name"]}-{repeat}.c'
                    path.write_text(text)
                    sample['output'] = {'path': str(path.relative_to(args.output)),
                                        'sha256': quality.digest(path), 'bytes': path.stat().st_size}
                else:
                    sample['gap'] = 'No source text delivered; not a successful fast result'
                quality.save(directory / 'run.json', run)
        memory.phase = 'transport_control'
        for _ in range(args.control_runs):
            response, record = await client.rpc('ping', {})
            run['transport_controls'].append(record)
            quality.require('error' not in response, 'MCP ping control failed')
    except Exception as error:
        run['error'] = repr(error)
        run['traceback'] = traceback.format_exc()
    finally:
        memory.phase = 'close'
        if scope is not None:
            try:
                operation = 'project_close' if lane.startswith('open-decomp') else 'program_close'
                request = {**scope, 'running_jobs': 'cancel'} if lane.startswith('open-decomp') else scope
                result, record, failed = await client.call(operation, request)
                run['close'] = {'call': record, 'result': result, 'is_error': failed}
                quality.require(not failed, 'Project close failed')
            except Exception as error:
                run['close_error'] = repr(error)
        try:
            await client.close()
        except Exception as error:
            run['shutdown_error'] = repr(error)
        finally:
            memory.stopped = True
            await sampling
            directory.mkdir(parents=True, exist_ok=True)
            with (directory / 'memory.jsonl').open('w') as stream:
                for sample in memory.samples:
                    stream.write(json.dumps(sample) + '\n')
            run['memory'] = memory.summary()
            run['server_exit_code'] = getattr(client, 'exit_code', None)
            if run['server_exit_code'] != 0 and not run.get('shutdown_error'):
                run['shutdown_error'] = f'MCP owner did not exit cleanly: {run["server_exit_code"]}'
            phase_files = ([directory / 'phase-metrics.jsonl'] if lane == 'ghidra-persistent'
                           else sorted((directory / 'od-phases').glob('*.jsonl')) if lane == 'open-decomp-observed' else [])
            if lane in ('open-decomp-observed', 'ghidra-persistent'):
                try:
                    quality.require(phase_files and all(path.is_file() for path in phase_files),
                                    'Trusted phase sidecars are missing; no unobserved success is claimed')
                    phases = [json.loads(line) for path in phase_files for line in path.read_text().splitlines()]
                    run['phase_sidecars'] = [{'path': str(path.relative_to(args.output)), 'sha256': quality.digest(path)}
                                             for path in phase_files]
                    run['internal_phases'] = associate_phases(run, phases)
                except Exception as error:
                    run['phase_metrics_error'] = repr(error)
            quality.save(directory / 'run.json', run)
    return run


async def open_decomp_pair(args, config, item, iteration, retain):
    """Initial imports are independent; paired projections share closed snapshots."""
    root = args.output / item['id'] / f'run{iteration}'
    lanes = ('open-decomp', 'open-decomp-observed')
    if iteration % 2 == 0:
        lanes = lanes[::-1]
    completed, imported = set(), {}
    result = {'input': item['id'], 'iteration': iteration, 'snapshots': {},
              'input_path': item['binary'], 'target_executed': False}

    async def obtain(lane, lifecycle, project, starting_snapshot=None):
        run = await session(args, config, item, lane, iteration, lifecycle, project, starting_snapshot)
        if (lifecycle == 'import_only' and not run.get('error') and
                not run.get('close_error') and not run.get('shutdown_error')):
            try:
                run['closed_project_facts'] = closed_project_facts(project)
                quality.require(run['scope'] == {key: run['closed_project_facts'][key]
                                                for key in ('project_id', 'revision')},
                                'Closed import project identity differs from its MCP acknowledgement')
            except Exception as error:
                run['error'] = repr(error)
                run['traceback'] = traceback.format_exc()
        completed.add((lane, lifecycle))
        retain(run)
        return run

    try:
        for lane in lanes:
            imported[lane] = await obtain(lane, 'import_only', root / lane / 'import-project')
        quality.require(all(not any(run.get(key) for key in
                                    ('error', 'close_error', 'shutdown_error', 'phase_metrics_error'))
                            and run.get('server_exit_code') == 0 for run in imported.values()),
                        'At least one initial import/observer/owner shutdown failed; no snapshot control is authorized')
        first, second = imported['open-decomp'], imported['open-decomp-observed']
        opened = [next(stage['result'] for stage in run['stages'] if stage['phase'] == 'import_discovery')
                  for run in (first, second)]
        checks = {
            'logical_import_facts': first['closed_project_facts']['facts_sha256'] ==
                                    second['closed_project_facts']['facts_sha256'],
            'public_image': first['image'] == second['image'],
            **{field: opened[0].get(field) == opened[1].get(field)
               for field in ('state', 'reason', 'revision', 'versions', 'options', 'budget', 'coverage')},
        }
        result['import_control'] = {
            'scope': 'Initial import logical SQLite schema/facts excluding only project handle/job history; '
                     'all payload IDs remain exact. Independent import namespace is not a decompile control.',
            'checks': checks, 'equivalent': all(checks.values()),
            'control_facts_sha256': first['closed_project_facts']['facts_sha256'],
            'observed_facts_sha256': second['closed_project_facts']['facts_sha256'],
        }
        if result['import_control']['equivalent']:
            metrics = {'startup_ms': {'control': first['startup_ms'], 'observed': second['startup_ms']}}
            for phase in ('import_discovery', 'metadata'):
                metrics[phase + '_request_ms'] = {
                    label: next(stage['call']['elapsed_ms'] for stage in run['stages'] if stage['phase'] == phase)
                    for label, run in (('control', first), ('observed', second))}
            left_memory, right_memory = first['memory']['phases'], second['memory']['phases']
            for phase in sorted(left_memory.keys() & right_memory.keys()):
                metrics['sampled_tree_rss_max_kib:' + phase] = {
                    'control': left_memory[phase]['observed_max_kib'],
                    'observed': right_memory[phase]['observed_max_kib']}
            result['import_control']['paired_metrics'] = metrics
        else:
            result['import_control']['perturbation_unavailable'] = 'Independent imports did not establish identical fact/hash scope'
        # Preserve both independent import projects. Only the uninstrumented,
        # closed one seeds the separately labeled cache-cold analysis controls.
        started = time.perf_counter()
        cold = freeze_closed_project(root / 'open-decomp/import-project',
                                     root / 'control-snapshots/post-import', cache_cold=True)
        result['snapshots']['cold'] = {**cold, 'preparation_ms': (time.perf_counter() - started) * 1000}
        fresh = {}
        for lane in lanes:
            project = root / lane / 'fresh-project'
            started = time.perf_counter()
            snapshot = clone_snapshot(cold, project)
            snapshot['clone_preparation_ms'] = (time.perf_counter() - started) * 1000
            fresh[lane] = await obtain(lane, 'fresh', project, snapshot)
        quality.require(not fresh['open-decomp'].get('close_error') and
                        not fresh['open-decomp'].get('shutdown_error') and
                        fresh['open-decomp'].get('server_exit_code') == 0,
                        'The uninstrumented analysis owner did not close cleanly; refusing a warm snapshot')
        started = time.perf_counter()
        warm = freeze_closed_project(root / 'open-decomp/fresh-project',
                                     root / 'control-snapshots/post-analysis')
        result['snapshots']['warm'] = {**warm, 'preparation_ms': (time.perf_counter() - started) * 1000}
        for lane in lanes:
            project = root / lane / 'resume-project'
            started = time.perf_counter()
            snapshot = clone_snapshot(warm, project)
            snapshot['clone_preparation_ms'] = (time.perf_counter() - started) * 1000
            await obtain(lane, 'resume', project, snapshot)
    except Exception as error:
        result['error'] = repr(error)
        result['traceback'] = traceback.format_exc()
        # Record every unexercised cell explicitly, never fabricate response time
        # or narrow away functions after a failed snapshot prerequisite.
        for lane in lanes:
            for lifecycle in ('import_only', 'fresh', 'resume'):
                if (lane, lifecycle) not in completed:
                    retain({'input': item['id'], 'iteration': iteration, 'lane': lane,
                            'lifecycle': lifecycle, 'functions': [], 'status': 'not_measured',
                            'error': 'Shared snapshot prerequisite failed: ' + repr(error)})
    root.mkdir(parents=True, exist_ok=True)
    quality.save(root / 'observer-snapshot-control.json', result)
    return result


def associate_phases(run, evidence):
    """Bind native spans to actual public outcomes; unmatched spans stay distinct."""
    rows = {row.get('function_id', str(int(row['address'], 16))): row for row in run['functions']}
    counts = defaultdict(int)
    jobs = {}
    for phase in evidence:
        if run['lane'] == 'open-decomp-observed':
            identity = phase.get('function_id')
            key = (phase.get('pid'), phase.get('job_id'))
        else:
            if phase.get('phase') != 'decompile_function' or not phase.get('address'):
                continue
            identity = str(int(phase['address'], 16))
            key = phase.get('sequence')
        row = rows.get(identity)
        if row is None or key in jobs:
            continue
        index = counts[identity]
        counts[identity] += 1
        sample = row['samples'][index] if index < len(row['samples']) else None
        jobs[key] = (row['name'], sample)
    result = []
    for phase in evidence:
        if 'elapsed_ms' not in phase:
            continue
        key = ((phase.get('pid'), phase.get('job_id')) if run['lane'] == 'open-decomp-observed'
               else phase.get('sequence'))
        name, sample = jobs.get(key, (None, None))
        record = {key: value for key, value in phase.items() if key not in ('before', 'after')}
        record['selected_function'] = name
        record['public_outcome'] = ({'kind': sample['kind'], 'error': sample['is_error'],
                                     'semantic_state': sample.get('semantic_state'),
                                     'cache': sample.get('cache'),
                                     'delivery_eligible': sample['delivery_eligible']} if sample else
                                    {'association': 'non-decompile or unmatched request; never pooled as a valid decompile'})
        result.append(record)
    return result


def observation_control(runs, items, repeats, selected_functions):
    controls = {tuple(run[key] for key in ('input', 'iteration', 'lifecycle')): run
                for run in runs if run['lane'] == 'open-decomp' and run['lifecycle'] != 'import_only'}
    observed = {tuple(run[key] for key in ('input', 'iteration', 'lifecycle')): run
                for run in runs if run['lane'] == 'open-decomp-observed' and run['lifecycle'] != 'import_only'}
    planned = {item['id']: item for item in items}
    pairs, memory_pairs = [], []
    perturbation = defaultdict(list)
    fields = ('is_error', 'operation_state', 'semantic_state', 'reason', 'failure_code',
              'coverage', 'cache', 'cache_identity_scope', 'component_metadata_sha256',
              'context_metadata_sha256', 'inferences_sha256', 'requirements_sha256', 'local_validation_sha256')
    for key in sorted(controls.keys() | observed.keys()):
        control, instrumented = controls.get(key), observed.get(key)
        left = {row['name']: row for row in control['functions']} if control else {}
        right = {row['name']: row for row in instrumented['functions']} if instrumented else {}
        complete = True
        snapshot_matches = bool(control and instrumented and control.get('scope') == instrumented.get('scope') and
                                control.get('starting_snapshot') and instrumented.get('starting_snapshot') and
                                control['starting_snapshot']['snapshot_manifest_sha256'] ==
                                instrumented['starting_snapshot']['snapshot_manifest_sha256'])
        for function in planned[key[0]]['functions']:
            name = function['name']
            if selected_functions and name not in selected_functions:
                continue
            baseline = left.get(name, {}).get('samples', [])
            measured = right.get(name, {}).get('samples', [])
            for index in range(repeats):
                a = baseline[index] if index < len(baseline) else None
                b = measured[index] if index < len(measured) else None
                pair = {'input': key[0], 'iteration': key[1], 'lifecycle': key[2],
                        'function': name, 'repeat': index,
                        'kind': 'first' if index == 0 else 'repeated',
                        'differences': [], 'unverifiable': []}
                if a is None or b is None:
                    pair['unverifiable'].append('The same requested sample was not recorded by both lanes')
                else:
                    pair['differences'] = [field for field in fields if a.get(field) != b.get(field)]
                    if not snapshot_matches:
                        pair['differences'].append('starting_project_revision_context_or_cache_snapshot')
                    metadata = [sample.get('emission_metadata', {}).get('sha256') for sample in (a, b)]
                    if not all(metadata):
                        pair['unverifiable'].append('Complete component/context/inference/requirement metadata was not retained')
                    elif metadata[0] != metadata[1]:
                        pair['differences'].append('emission_metadata')
                    hashes = [sample.get('output', {}).get('sha256') for sample in (a, b)]
                    pair['source_text_sha256'] = {'control': hashes[0], 'observed': hashes[1]}
                    if not all(hashes):
                        pair['unverifiable'].append('Full source text was not delivered by both lanes')
                    elif hashes[0] != hashes[1]:
                        pair['differences'].append('source_text')
                    if not a.get('cache_identity_scope') or not b.get('cache_identity_scope'):
                        pair['unverifiable'].append('Validated full cache-identity scope was not available')
                pair['equivalent'] = not pair['differences'] and not pair['unverifiable']
                complete = complete and pair['equivalent']
                if pair['equivalent']:
                    pair['outcome'] = {field: a.get(field) for field in ('semantic_state', 'cache', 'delivery_eligible')}
                    outcome = json.dumps(pair['outcome'], sort_keys=True)
                    for stage in ('request', 'full_delivery'):
                        before = a['call']['elapsed_ms'] if stage == 'request' else a['full_delivery_ms']
                        after = b['call']['elapsed_ms'] if stage == 'request' else b['full_delivery_ms']
                        pair[stage + '_ms'] = {'control': before, 'observed': after}
                        perturbation[(key[0], key[2], name, pair['kind'], outcome,
                                      stage + '_observed_minus_control_ms')].append(after - before)
                        if before > 0:
                            perturbation[(key[0], key[2], name, pair['kind'], outcome,
                                          stage + '_observed_over_control')].append(after / before)
                pairs.append(pair)
        left_memory = control.get('memory', {}).get('phases', {}) if control else {}
        right_memory = instrumented.get('memory', {}).get('phases', {}) if instrumented else {}
        for phase in sorted(left_memory.keys() | right_memory.keys()):
            memory_pair = {'input': key[0], 'iteration': key[1], 'lifecycle': key[2], 'phase': phase}
            if not complete:
                memory_pair['unavailable'] = 'Run did not establish equivalent outputs for every requested sample'
            elif phase not in left_memory or phase not in right_memory:
                memory_pair['unavailable'] = 'Interval sampling did not observe this phase in both lanes; not zero RSS'
            else:
                before, after = left_memory[phase]['observed_max_kib'], right_memory[phase]['observed_max_kib']
                memory_pair.update({'control_observed_max_kib': before, 'observed_observed_max_kib': after})
                perturbation[(key[0], key[2], None, phase, 'equivalent public output scope',
                              'sampled_tree_rss_observed_minus_control_kib')].append(after - before)
            memory_pairs.append(memory_pair)
    return {'pairs': pairs, 'memory_pairs': memory_pairs,
            'equivalence_complete': bool(pairs) and all(pair['equivalent'] for pair in pairs),
            'interpretation': 'Paired public-client latency and sampled RSS differences include observer allocations, '
                              'process/OS/cache/order noise; not isolated overhead or inferred engine cost.',
            'perturbation_distributions': [
                {'input': key[0], 'lifecycle': key[1], 'function': key[2], 'kind': key[3],
                 'outcome': key[4], 'metric': key[5], 'distribution': distribution(values)}
                for key, values in perturbation.items()]}


def summarize(runs):
    groups = defaultdict(list)
    for run in runs:
        prefix = (run['input'], run['lane'], run['lifecycle'])
        if 'startup_ms' in run:
            groups[(*prefix, 'startup', None, 'recorded')].append(run['startup_ms'])
        for stage in run.get('stages', []):
            groups[(*prefix, stage['phase'], None, 'error' if stage['is_error'] else 'recorded')].append(stage['call']['elapsed_ms'])
        for control in run.get('transport_controls', []):
            groups[(*prefix, 'ping_overhead_control', None, 'recorded')].append(control['elapsed_ms'])
        for phase, sample in run.get('memory', {}).get('phases', {}).items():
            groups[(*prefix, 'sampled_tree_rss_max_kib:' + phase, None, 'recorded')].append(sample['observed_max_kib'])
        for phase in run.get('internal_phases', []):
            if 'elapsed_ms' in phase:
                state = json.dumps({'error': phase.get('error'), 'operation': phase.get('operation'),
                                    'interface_reused': phase.get('interface_reused'),
                                    'image_identity': phase.get('image_identity'),
                                    'public_outcome': phase.get('public_outcome')}, sort_keys=True)
                label = phase['phase'] + (':' + phase['tool'] if 'tool' in phase else '')
                groups[(*prefix, 'internal:' + label, phase.get('selected_function'), state)].append(phase['elapsed_ms'])
        for row in run['functions']:
            for sample in row['samples']:
                state = json.dumps({'error': sample['is_error'], 'semantic_state': sample.get('semantic_state'),
                                    'cache': sample.get('cache'), 'delivery_eligible': sample['delivery_eligible']}, sort_keys=True)
                groups[(*prefix, sample['kind'] + '_request', row['name'], state)].append(sample['call']['elapsed_ms'])
                if 'full_delivery_ms' in sample:
                    groups[(*prefix, sample['kind'] + '_full_delivery', row['name'], state)].append(sample['full_delivery_ms'])
                if 'artifact_assembly_ms' in sample:
                    groups[(*prefix, sample['kind'] + '_artifact_assembly', row['name'], state)].append(sample['artifact_assembly_ms'])
    return [{'input': key[0], 'lane': key[1], 'lifecycle': key[2], 'stage': key[3],
             'function': key[4], 'observed_outcome': key[5], 'distribution': distribution(values)}
            for key, values in groups.items()]


def tool_identity(args, config):
    commit = subprocess.check_output(['git', '-C', str(args.ghidra_bridge), 'rev-parse', 'HEAD'], text=True).strip()
    quality.require(commit == config['ghidra']['bridge_commit'], 'Pinned bridge commit mismatch')
    changes = subprocess.check_output(['git', '-C', str(args.ghidra_bridge), 'status', '--porcelain', '--untracked-files=no'], text=True)
    quality.require(not changes, 'Pinned bridge tracked sources must remain unchanged')
    properties = args.ghidra / 'Ghidra/application.properties'
    quality.require(f'application.version={config["ghidra"]["version"]}' in properties.read_text().splitlines(), 'Ghidra version mismatch')
    scripts = HARNESS_FILES
    compiled = args.entry.parent.parent
    return {
        'bridge_commit': commit,
        'scripts': {name: quality.digest(HERE / name) for name in scripts},
        'compiled_files': {str(path.relative_to(compiled)): quality.digest(path)
                           for path in sorted(compiled.rglob('*.js'))},
        'node': subprocess.check_output([args.node, '--version'], text=True).strip(),
        'bridge_runtime': json.loads(subprocess.check_output([
            str(args.ghidra_bridge / '.venv/bin/python'), '-c',
            'import importlib.metadata,json,sys; print(json.dumps({"python":sys.version,'
            '"packages":{d.metadata["Name"]:d.version for d in importlib.metadata.distributions()}}))'], text=True)),
        'java': subprocess.check_output([str(args.java_home / 'bin/java'), '-version'], stderr=subprocess.STDOUT, text=True),
        'ghidra_properties_sha256': quality.digest(properties),
        'native_decompilers': {str(path.relative_to(args.ghidra)): quality.digest(path)
                               for path in sorted(args.ghidra.glob('Ghidra/Features/Decompiler/os/*/decompile*')) if path.is_file()},
    }


async def record(args):
    for key in ('inputs', 'output', 'manifest', 'entry', 'ghidra_bridge', 'ghidra', 'java_home', 'lock'):
        setattr(args, key, getattr(args, key).resolve())
    manifest = json.loads(args.manifest.read_text())
    config = json.loads(quality.MANIFEST.read_text())
    items = items_from_manifest(manifest, args.inputs, args.input)
    if args.function:
        names = {fn['name'] for item in items for fn in item['functions']}
        quality.require(set(args.function) <= names, 'Unknown selected function')
    quality.require(not args.output.exists(), 'Output must be new; evidence is never overwritten')
    quality.require(not args.output.is_relative_to(Path('/tmp').resolve()), 'Choose durable output outside /tmp')
    quality.require(not any(part.startswith('.') for part in args.output.parts), 'Ghidra rejects hidden project path elements')
    plan = {'schema': 1, 'method': METHOD, 'manifest_sha256': quality.digest(args.manifest),
            'config_sha256': quality.digest(quality.MANIFEST),
            'arguments': {key: str(value) if isinstance(value, Path) else value for key, value in vars(args).items()},
            'host': {'platform': platform.platform(), 'python': sys.version},
            'selected': items, 'lanes': LANES, 'runs': [], 'measurements_exercised': False}
    if args.command == 'plan':
        args.output.mkdir(parents=True)
        plan['harness_sha256'] = retain_harness(args.output)
        if args.prepare_observer:
            quality.require(args.entry.is_file(), 'Observer preparation requires an existing compiled build')
            plan['observer'] = prepare_observer(args)
        quality.save(args.output / 'plan.json', plan)
        print(json.dumps({'plan': str(args.output / 'plan.json'), 'measurements_exercised': False}))
        return 0
    quality.require(args.build_ready, 'Coordinator final build/host authorization is required: --build-ready')
    quality.require(not os.environ.get('NODE_OPTIONS'),
                    'Use an empty NODE_OPTIONS environment so the uninstrumented OD control cannot inherit hooks')
    quality.require(args.entry.is_file(), 'Final compiled CLI is missing')
    plan['tool_identity'] = tool_identity(args, config)
    args.lock.parent.mkdir(parents=True, exist_ok=True)
    args.lock.mkdir()  # Never steal an existing lock or overlap measured runs.
    quality.save(args.lock / 'owner.json', {'pid': os.getpid(), 'output': str(args.output)})
    try:
        args.output.mkdir(parents=True)
        plan['harness_sha256'] = retain_harness(args.output, plan['tool_identity']['scripts'])
        plan['observer'] = prepare_observer(args, plan['tool_identity'])
        quality.save(args.output / 'input-manifest.json', manifest)
        quality.save(args.output / 'protocol-config.json', config)
        quality.save(args.output / 'comparison.json', plan)

        def retain(run):
            plan['runs'].append(run)
            if 'directory' in run:
                plan['measurements_exercised'] = True
                quality.save(args.output / run['directory'] / 'run.json', run)
            plan['distributions'] = summarize(plan['runs'])
            quality.save(args.output / 'comparison.json', plan)
            print(json.dumps({key: run.get(key) for key in
                              ('input', 'lane', 'iteration', 'lifecycle', 'error')}), flush=True)

        for item in items:
            if item['status'] != 'built':
                plan.setdefault('unavailable_inputs', []).append(item)
                continue
            for iteration in range(1, args.fresh_runs + 1):
                # The paired OD snapshot is one serialized unit. Rotate units,
                # and alternate observed/control order inside that pair.
                units = ('od-pair', 'ghidra-bridge', 'ghidra-persistent')
                offset = (iteration - 1) % len(units)
                for unit in units[offset:] + units[:offset]:
                    if unit == 'od-pair':
                        result = await open_decomp_pair(args, config, item, iteration, retain)
                        plan.setdefault('od_snapshot_controls', []).append(result)
                        quality.save(args.output / 'comparison.json', plan)
                        continue
                    for lifecycle in ('fresh', 'resume'):
                        if lifecycle == 'resume' and not (args.output / item['id'] / f'run{iteration}' / unit / 'project').exists():
                            retain({'input': item['id'], 'lane': unit, 'iteration': iteration,
                                    'lifecycle': lifecycle, 'functions': [], 'status': 'not_measured',
                                    'error': 'Fresh project unavailable; no pretend resume measurement'})
                            continue
                        retain(await session(args, config, item, unit, iteration, lifecycle))
        plan['recording_complete'] = not any(
            run.get('error') or run.get('close_error') or run.get('shutdown_error') or run.get('phase_metrics_error')
            for run in plan['runs'])
        plan['matched_work'] = []
        for item in items:
            for iteration in range(1, args.fresh_runs + 1):
                for lifecycle in ('fresh', 'resume'):
                    for function in item['functions']:
                        if args.function and function['name'] not in args.function:
                            continue
                        matched = {'input': item['id'], 'iteration': iteration,
                                   'lifecycle': lifecycle, 'function': function['name'],
                                   'address': function['address'], 'lanes': {},
                                   'semantic_equivalence_verified': False}
                        for lane in LANES:
                            run = next((run for run in plan['runs']
                                        if (run['input'], run['iteration'], run['lifecycle'], run['lane']) ==
                                        (item['id'], iteration, lifecycle, lane)), None)
                            row = next((row for row in run['functions']
                                        if row['name'] == function['name']), None) if run else None
                            matched['lanes'][lane] = {
                                'samples_recorded': len(row['samples']) if row else 0,
                                'all_deliveries_eligible': bool(row and row['samples']) and
                                    all(sample['delivery_eligible'] for sample in row['samples']),
                                'gap': row.get('gap') if row else
                                    (run.get('error', 'Function was not measured') if run else
                                     'Input unavailable; retained in unavailable_inputs'),
                            }
                        matched['equal_request_count'] = all(
                            row['samples_recorded'] == args.warm_runs + 1
                            for row in matched['lanes'].values())
                        matched['all_lanes_delivered_full_text'] = all(
                            row['all_deliveries_eligible'] for row in matched['lanes'].values())
                        plan['matched_work'].append(matched)
        plan['distributions'] = summarize(plan['runs'])
        plan['observer_controls'] = observation_control(
            plan['runs'], items, args.warm_runs + 1, args.function)
        plan['initial_import_control_complete'] = bool(plan.get('od_snapshot_controls')) and all(
            not row.get('error') and row.get('import_control', {}).get('equivalent')
            for row in plan.get('od_snapshot_controls', []))
        initial_perturbation = defaultdict(list)
        for row in plan.get('od_snapshot_controls', []):
            for metric, pair in row.get('import_control', {}).get('paired_metrics', {}).items():
                initial_perturbation[(row['input'], metric)].append(pair['observed'] - pair['control'])
        plan['initial_import_perturbation'] = [
            {'input': key[0], 'metric': key[1] + ':observed_minus_control',
             'scope': 'Independently imported, matching logical facts; not the shared decompile snapshot',
             'distribution': distribution(values)} for key, values in initial_perturbation.items()]
        plan['control_equivalence_complete'] = (
            plan['observer_controls']['equivalence_complete'] and plan['initial_import_control_complete'])
        quality.save(args.output / 'comparison.json', plan)
        quality.require(plan['control_equivalence_complete'],
                        'Observed/uninstrumented OD source/state/cache-identity equivalence failed or is unverifiable; inspect observer_controls')
        return 0 if plan['recording_complete'] else 1
    finally:
        (args.lock / 'owner.json').unlink()
        args.lock.rmdir()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('plan', 'run'))
    parser.add_argument('--manifest', type=Path, default=quality.MANIFEST)
    parser.add_argument('--inputs', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--entry', type=Path, default=REPO / 'dist/src/cli/entry.js')
    parser.add_argument('--node', default='node')
    parser.add_argument('--ghidra-bridge', type=Path, required=True)
    parser.add_argument('--ghidra', type=Path, required=True)
    parser.add_argument('--java-home', type=Path, required=True)
    parser.add_argument('--input', action='append')
    parser.add_argument('--function', action='append')
    parser.add_argument('--profile', choices=('default', 'raised'), default='default')
    parser.add_argument('--fresh-runs', type=int, choices=range(1, 21), default=3)
    parser.add_argument('--warm-runs', type=int, choices=range(0, 101), default=10)
    parser.add_argument('--control-runs', type=int, choices=range(1, 101), default=10)
    parser.add_argument('--timeout', type=int, choices=range(1, 1201), default=360)
    parser.add_argument('--memory-interval', type=float, default=0.1)
    parser.add_argument('--lock', type=Path, default=REPO / '.local/performance/quality.measurement.lock')
    parser.add_argument('--build-ready', action='store_true', help='Coordinator authorizes final build and exclusive measurement host')
    parser.add_argument('--prepare-observer', action='store_true', help='Plan-only: prepare pinned compiled hooks without launching a workload')
    args = parser.parse_args()
    quality.require(0.01 <= args.memory_interval <= 10, 'Memory interval must be between 0.01 and 10 seconds')
    return asyncio.run(record(args))


if __name__ == '__main__':
    sys.exit(main())

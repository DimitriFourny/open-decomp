#!/usr/bin/env python3
"""Record angr decompiler C for every frozen published-suite cell (static analysis only).

Run with the isolated angr venv (`.local/angr-venv/bin/python`). Each selected
function is decompiled in its own fresh worker process: load the unchanged input,
CFGFast(normalize=True) with every other CFGFast argument at its default, then
Decompiler(function, cfg=model) with default options/preset. Functions are
addressed exactly like the Ghidra and Open Decomp lanes: by the compiler-derived
VA recorded in the build manifest (identical in symbol-bearing and stripped
cells). No name, prototype, type, source or debug hint is supplied. The analyzed
binary is never executed or emulated: no SimulationManager is created and
unicorn is not used. Every failure is retained as an unavailable cell; nothing
is retried or dropped selectively.

The output directory mirrors `quality-heldout.py run` (`comparison.json` with
`runs`/`matched`, texts at `<cell>/angr/<function>.c`), so the evaluator and
packet scripts consume it through `--results`/`--extra-results`.
"""
import argparse
from collections import Counter
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time
import traceback

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import quality

TOOL = 'angr'
PROJECT_OPTIONS = {'auto_load_libs': False}
CFG_OPTIONS = {'normalize': True}
# Worker processes run with a fixed hash seed so set/dict iteration inside angr
# cannot vary between otherwise identical recordings.
WORKER_ENVIRONMENT = {'PYTHONHASHSEED': '0'}


def selection():
    value = json.loads((HERE / 'quality-heldout-selection.json').read_text())
    quality.require(quality.digest(HERE.parent.parent / value['source']['path']) == value['source']['sha256'],
                    'Frozen published-suite source changed; do not silently reseal or retune')
    return value


def identity():
    import angr
    from angr.analyses.decompiler import decompilation_options
    from angr.analyses.decompiler.presets import DECOMPILATION_PRESETS
    distributions = sorted({dist.metadata['Name'].lower(): dist.version
                            for dist in importlib.metadata.distributions()}.items())
    return {'angr_version': angr.__version__, 'python': sys.version, 'platform': platform.platform(),
            'distributions': dict(distributions),
            'project_options': PROJECT_OPTIONS, 'cfg_fast_options': CFG_OPTIONS,
            'cfg_fast_note': 'Only normalize=True (required by Decompiler) is set; all other CFGFast arguments are angr defaults.',
            'decompiler_call': 'Decompiler(function, cfg=cfg.model); options/preset/optimization passes left at defaults',
            'decompiler_preset': 'default', 'decompiler_presets_available': sorted(DECOMPILATION_PRESETS),
            'decompiler_option_defaults': {option.param: option.default_value for option in decompilation_options.options},
            'decompiler_builtin_fallback': 'angr retries a failed decompilation once with its basic preset (default behavior, retained; errors recorded)',
            'worker_environment': WORKER_ENVIRONMENT, 'unicorn_used': False, 'simulation_manager_used': False}


def worker(args):
    # One function per fresh process: no knowledge-base state carries between functions.
    import logging
    import angr
    logging.getLogger('angr').setLevel(logging.ERROR)
    logging.getLogger('cle').setLevel(logging.ERROR)
    report = {'address': args.address, 'phases_seconds': {}}
    started = time.perf_counter()
    try:
        project = angr.Project(str(args.binary), **PROJECT_OPTIONS)
        report['phases_seconds']['load'] = time.perf_counter() - started
        mark = time.perf_counter()
        cfg = project.analyses.CFGFast(**CFG_OPTIONS)
        report['phases_seconds']['cfg_fast'] = time.perf_counter() - mark
        report['discovered_functions'] = len(cfg.kb.functions)
        function = cfg.kb.functions.function(addr=int(args.address, 16))
        if function is None:
            containing = cfg.kb.functions.floor_func(int(args.address, 16))
            report.update({'status': 'function_not_discovered', 'angr_status': 'failed',
                           'error': 'CFGFast discovered no function entry at this selected address',
                           'nearest_lower_function': None if containing is None else
                           {'name': containing.name, 'address': hex(containing.addr)}})
            return report
        report['function'] = {'name': function.name, 'address': hex(function.addr),
                              'blocks': len(function.block_addrs_set)}
        mark = time.perf_counter()
        decompiler = project.analyses.Decompiler(function, cfg=cfg.model)
        report['phases_seconds']['decompile'] = time.perf_counter() - mark
        report['decompiler_errors'] = [error.format() for error in decompiler.errors]
        text = decompiler.codegen.text if decompiler.codegen is not None else None
        if text:
            args.output.write_text(text)
            report.update({'status': 'text_returned', 'angr_status': 'ok'})
        else:
            report.update({'status': 'no_text', 'angr_status': 'no_output'})
    except Exception as error:
        report.update({'status': 'tool_error', 'angr_status': 'failed', 'error': repr(error),
                       'traceback': traceback.format_exc()})
    finally:
        report['phases_seconds']['total_in_worker'] = time.perf_counter() - started
    return report


def record(args):
    frozen = selection()
    args.inputs, args.output = args.inputs.resolve(), args.output.resolve()
    quality.require(not args.output.exists(), 'Use a new output directory')
    manifest = json.loads((args.inputs / 'build-manifest.json').read_text())
    quality.require(manifest['selection']['source']['sha256'] == frozen['source']['sha256'], 'Wrong frozen-suite source build')
    quality.require(len(manifest['cells']) == 24, 'Retain every planned frozen-suite cell')
    tool = identity()
    result = {'schema': 1, 'purpose': 'angr decompiler lane over the frozen published suite; equal inputs and addresses, no hints',
              'tool': TOOL, 'tool_identity': tool, 'build_manifest': manifest,
              'arguments': {key: str(value) if isinstance(value, Path) else value for key, value in vars(args).items()},
              'runs': [], 'matched': [],
              'limitations': ['Default angr options; no tuning against suite source or outputs.',
                              'Wall times include a fresh process, load and CFGFast per function; not a performance comparison.',
                              'One observation per function cell; every failure retained.']}
    args.output.mkdir(parents=True)
    for cell in manifest['cells']:
        directory = args.output / cell['id'] / TOOL
        directory.mkdir(parents=True)
        run = {'cell': cell['id'], 'tool': TOOL, 'status': 'recording', 'functions': [], 'target_executed': False,
               'input': cell.get('input'), 'source_debug_types_supplied': False,
               **{key: cell[key] for key in ('target', 'compiler', 'optimization', 'symbols')}}
        result['runs'].append(run)
        if cell['status'] != 'built':
            run.update({'status': 'build_failed', 'gap': cell.get('error', 'Input not built'),
                        'functions': [{**function, 'status': 'build_failed'} for function in cell['functions']]})
        else:
            path = args.inputs / Path(cell['input']['path']).relative_to(manifest['root'])
            quality.require(quality.digest(path) == cell['input']['sha256'], 'Input changed after reviewed build')
            for function in cell['functions']:
                row = {**function, 'status': 'recording'}
                run['functions'].append(row)
                output = directory / (function['name'] + '.c')
                command = [sys.executable, str(Path(__file__).resolve()), 'worker', '--binary', str(path),
                           '--address', function['address'], '--output', str(output)]
                started = time.perf_counter()
                try:
                    observed = subprocess.run(command, capture_output=True, text=True, timeout=args.timeout,
                                              env={**os.environ, **WORKER_ENVIRONMENT})
                    row['wall_seconds'] = time.perf_counter() - started
                    (directory / (function['name'] + '.worker.stderr.txt')).write_text(observed.stderr)
                    row['worker_exit_code'] = observed.returncode
                    lines = observed.stdout.splitlines()
                    if observed.returncode or not lines:
                        row.update({'status': 'tool_error', 'angr_status': 'failed',
                                    'error': 'Worker process failed without a report; stderr retained'})
                    else:
                        row.update(json.loads(lines[-1]))
                except subprocess.TimeoutExpired:
                    row.update({'status': 'tool_timeout', 'angr_status': 'failed', 'wall_seconds': time.perf_counter() - started,
                                'error': f'Worker exceeded {args.timeout} s; no retry'})
                if row['status'] == 'text_returned':
                    row['output'] = {'path': str(output.relative_to(args.output)), 'bytes': output.stat().st_size,
                                     'sha256': quality.digest(output)}
                quality.save(directory / 'run.json', run)
                print(json.dumps({'cell': cell['id'], 'function': function['name'], 'status': row['status'],
                                  'wall_seconds': round(row['wall_seconds'], 2)}), flush=True)
            run['status'] = 'recorded'
        quality.save(directory / 'run.json', run)
        for function in cell['functions']:
            result['matched'].append({'cell': cell['id'], **function,
                                      TOOL: next(row for row in run['functions'] if row['name'] == function['name'])})
        quality.save(args.output / 'comparison.json', result)
    result['complete_recording'] = len(result['runs']) == 24 and len(result['matched']) == 120
    result['availability'] = {
        'per_cell': {run['cell']: dict(Counter(row['status'] for row in run['functions'])) for run in result['runs']},
        'per_target': {target: dict(Counter(row['status'] for run in result['runs'] if run['target'] == target
                                            for row in run['functions']))
                       for target in dict.fromkeys(run['target'] for run in result['runs'])},
        'total': dict(Counter(row['status'] for run in result['runs'] for row in run['functions']))}
    quality.save(args.output / 'comparison.json', result)
    quality.save(args.output / 'summary.json', {key: result[key] for key in ('tool_identity', 'complete_recording', 'availability', 'limitations')})
    print(json.dumps(result['availability']['total']))
    return 0 if result['complete_recording'] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest='command', required=True)
    run = commands.add_parser('run')
    run.add_argument('--inputs', type=Path, required=True)
    run.add_argument('--output', type=Path, required=True)
    run.add_argument('--timeout', type=int, choices=range(1, 1201), default=360, metavar='SECONDS')
    work = commands.add_parser('worker')
    work.add_argument('--binary', type=Path, required=True)
    work.add_argument('--address', required=True)
    work.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'worker':
        print(json.dumps(worker(args)), flush=True)
        return 0
    return record(args)


if __name__ == '__main__':
    sys.exit(main())

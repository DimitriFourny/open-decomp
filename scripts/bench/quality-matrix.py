#!/usr/bin/env python3
"""Record every broader source-known matrix cell through both actual MCP servers.

No analyzed input is executed. This is static-analysis coverage evidence, not an
independent behavioral-equivalence check or a comparative quality/performance win.
"""
import argparse
import asyncio
from collections import Counter
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import traceback

sys.dont_write_bytecode = True
import quality

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent


def source_identity(entry):
    root = entry.parent.parent if entry.suffix == '.ts' else entry.parents[2]
    files = [{'path': str(path.relative_to(root)), 'sha256': quality.digest(path)}
             for path in sorted(root.rglob('*')) if path.is_file()]
    return {'root': str(root), 'entry': str(entry), 'entry_sha256': quality.digest(entry), 'files': files}


async def tool_cell(args, manifest, cell, tool, budget):
    directory = args.output / cell['id'] / tool
    run = {'cell': cell['id'], 'tool': tool, 'status': 'recording', 'functions': [],
           'target_executed': False, 'input': cell.get('input'), 'source_debug_types_supplied': False}
    if cell['status'] != 'built':
        run.update({'status': 'build_failed', 'gap': cell.get('error', 'Input not built'),
                    'functions': [{**function, 'status': 'build_failed'} for function in cell['functions']]})
        return run
    path = args.inputs / Path(cell['input']['path']).relative_to(manifest['root'])
    quality.require(quality.digest(path) == cell['input']['sha256'], 'Input changed after reviewed build')
    if tool == 'open-decomp':
        command = [args.node, *(['--import', 'tsx'] if args.entry.suffix == '.ts' else []),
                   str(args.entry), 'mcp', 'start', '--root', str(args.inputs), '--root', str(args.output)]
        environment = {}
        run['implementation_before'] = source_identity(args.entry)
    else:
        command = [str(args.bridge / '.venv/bin/python'), str(HERE / 'quality-ghidra.py')]
        environment = {'GHIDRA_INSTALL_DIR': str(args.ghidra), 'JAVA_HOME': str(args.java_home),
                       'JAVA_TOOL_OPTIONS': '-Djava.awt.headless=true', 'GHIDRA_MCP_TRANSPORT': 'stdio',
                       'GHIDRA_MCP_STORAGE_ROOT': str(directory / 'project'),
                       'GHIDRA_MCP_ANALYSIS_TIMEOUT_SECONDS': str(args.timeout)}
    client = quality.MCP(directory, command, environment, args.timeout)
    scope, image = None, None
    try:
        await client.start()
        run['server_info'] = client.server_info
        if tool == 'open-decomp':
            opened, record, failed = await client.call('project_open', {
                'source': {'kind': 'import', 'input_path': str(path), 'project_path': str(directory / 'project')},
                'wait': True, 'budget': budget})
            run['import'] = {'result': opened, 'is_error': failed, 'call': record}
            quality.require(not failed and isinstance(opened, dict) and opened.get('project_id'),
                            'Import did not return project identity; raw result retained')
            scope = {key: opened[key] for key in ('project_id', 'revision')}
            info, _, failed = await client.call('binary_info', scope)
            quality.require(not failed and (info.get('data') or {}).get('image'), 'No ready imported image')
            image = info['data']['image']
        else:
            opened, record, failed = await client.call('program_open', {'binary_path': str(path), 'analyze': True})
            run['import'] = {'result': opened, 'is_error': failed, 'call': record}
            quality.require(not failed and isinstance(opened, dict) and opened.get('program_id'),
                            'Import did not return Ghidra program identity; raw result retained')
            scope = {'program_id': opened['program_id']}
        for function in cell['functions']:
            row = {**function, 'status': 'recording'}
            run['functions'].append(row)
            try:
                if tool == 'open-decomp':
                    found, record, failed = await client.call('functions_find', {
                        **scope, 'image_id': image['id'], 'page': {'limit': 25},
                        'address': {'image_id': image['id'], 'space': 'va', 'value': function['address']}})
                    row['lookup'] = record
                    matches = [item for item in (found.get('data') or {}).get('items', [])
                               if int(item['entry']['value'], 16) == int(function['address'], 16)] if isinstance(found, dict) else []
                    if failed or len(matches) != 1:
                        row.update({'status': 'function_not_discovered',
                                    'gap': 'Public address lookup did not establish exactly this selected entry',
                                    'lookup_result': found})
                        continue
                    row['discovered'] = matches[0]
                    # The text-first default (header + pseudocode, no structuredContent) carries no
                    # emission or semantic state; this harness reads the full envelope.
                    value, record, failed = await client.call('function_decompile', {
                        **scope, 'function_id': matches[0]['id'], 'wait': True, 'budget': budget,
                        'detail': 'full'})
                else:
                    value, record, failed = await client.call('decompile_function', {
                        **scope, 'address': function['address'].removeprefix('0x'), 'max_chars': 200000})
                row.update({'call': record, 'is_error': failed})
                if failed or not isinstance(value, dict):
                    row.update({'status': 'tool_error', 'raw_result': value})
                    continue
                if tool == 'open-decomp':
                    emit, semantic, artifact = await quality.emission(client, value, function['name'])
                    row.update({'operation_state': value.get('state'), 'operation_reason': value.get('reason'),
                                'semantic_state': semantic.get('state'), 'semantic_reason': semantic.get('reason'),
                                'coverage': semantic.get('coverage'), 'diagnostics': semantic.get('diagnostics'),
                                'versions': semantic.get('versions'), 'artifact': artifact,
                                'budget': semantic.get('budget'), 'options': semantic.get('options')})
                    text = emit.get('text') if emit else None
                else:
                    text = value.get('c')
                    row.update({'semantic_state': 'not_reported_by_bridge', 'truncated': value.get('truncated')})
                if text:
                    output = directory / (function['name'] + '.c')
                    output.write_text(text)
                    row.update({'status': 'text_returned', 'output': {'path': str(output.relative_to(args.output)),
                                'bytes': output.stat().st_size, 'sha256': quality.digest(output)}})
                else:
                    row.update({'status': 'no_text', 'raw_result': value})
            except Exception as error:
                row.update({'status': 'request_failed', 'error': repr(error), 'traceback': traceback.format_exc()})
            finally:
                quality.save(directory / 'run.json', run)
        run['status'] = 'recorded'
    except Exception as error:
        run.update({'status': 'import_or_transport_failed', 'error': repr(error), 'traceback': traceback.format_exc()})
    finally:
        for function in cell['functions']:
            if not any(row['name'] == function['name'] for row in run['functions']):
                run['functions'].append({**function, 'status': 'not_reached', 'gap': run.get('error', 'No result')})
        if scope:
            try:
                name = 'project_close' if tool == 'open-decomp' else 'program_close'
                arguments = {**scope, 'running_jobs': 'cancel'} if tool == 'open-decomp' else scope
                value, record, failed = await client.call(name, arguments)
                run['close'] = {'result': value, 'call': record, 'is_error': failed}
            except Exception as error:
                run['close_error'] = repr(error)
        await client.close()
        run['server_exit_code'] = getattr(client, 'exit_code', None)
        if tool == 'open-decomp':
            after = source_identity(args.entry)
            run['implementation_unchanged_during_cell'] = after == run['implementation_before']
            if not run['implementation_unchanged_during_cell']:
                run['implementation_after'] = after
        quality.save(directory / 'run.json', run)
    return run


def summary(result):
    rows = []
    for tool in ('open-decomp', 'ghidra'):
        for target in ('macho-arm64', 'pe-x86_64', 'elf-x86_64'):
            selected = [run for run in result['runs'] if run['tool'] == tool and run['target'] == target]
            states = Counter(row['status'] for run in selected for row in run['functions'])
            semantic = Counter(row.get('semantic_state', 'not_reported') for run in selected for row in run['functions'])
            rows.append({'tool': tool, 'target': target, 'input_cells': len(selected),
                         'selected_function_cells': sum(states.values()), 'result_states': dict(states),
                         'semantic_states': dict(semantic)})
    return rows


async def record(args):
    args.inputs, args.output, args.entry = args.inputs.resolve(), args.output.resolve(), args.entry.resolve()
    quality.require(args.entry.is_file(), 'Actual source entry or integration build is required')
    quality.require(not args.output.exists(), 'Choose a new output directory')
    quality.require(not args.output.is_relative_to(Path('/tmp').resolve()), 'Output must be durable, outside /tmp')
    quality.require(not any(part.startswith('.') for part in args.output.parts), 'Pinned Ghidra needs non-hidden project paths')
    manifest_path = args.inputs / 'build-manifest.json'
    manifest = json.loads(manifest_path.read_text())
    quality.require(len(manifest['cells']) == 24, 'Do not drop any planned matrix input cells')
    original = json.loads((HERE / 'quality-inputs.json').read_text())
    commit = subprocess.check_output(['git', '-C', str(args.bridge), 'rev-parse', 'HEAD'], text=True).strip()
    quality.require(commit == original['ghidra']['bridge_commit'], 'Wrong bridge commit')
    quality.require(not subprocess.check_output(['git', '-C', str(args.bridge), 'status', '--porcelain', '--untracked-files=no'], text=True),
                    'Bridge tracked source must be unchanged')
    properties = args.ghidra / 'Ghidra/application.properties'
    quality.require('application.version=12.1.4' in properties.read_text().splitlines(), 'Wrong Ghidra version')
    result = {'schema': 1, 'purpose': 'P2.2 full broader source-known static-analysis matrix',
              'build_manifest_sha256': quality.digest(manifest_path), 'build_manifest': manifest,
              'arguments': {key: str(value) if isinstance(value, Path) else value for key, value in vars(args).items()},
              'host': {'platform': platform.platform(), 'python': sys.version,
                       'node': subprocess.check_output([args.node, '--version'], text=True).strip()},
              'implementation_initial': source_identity(args.entry), 'bridge_commit': commit,
              'ghidra_properties_sha256': quality.digest(properties),
              'budget': original['budgets'][args.profile], 'method': manifest['method'], 'runs': [], 'matched': [],
              'limitations': ['One serialized static-analysis observation per cell, no repeated-run performance claim.',
                             'Source and build-time function addresses known; no independent behavioral equivalence validation.',
                             'Only zlib checksum/combine routines, not all compression or arbitrary real-world programs.',
                             'Both compiler variants share Clang lineage; independently built Apple21 and upstream LLVM23, not independent front-end algorithms.']}
    args.lock.parent.mkdir(parents=True, exist_ok=True)
    args.lock.mkdir()
    quality.save(args.lock / 'owner.json', {'pid': os.getpid(), 'output': str(args.output)})
    try:
        args.output.mkdir(parents=True)
        for cell in manifest['cells']:
            pair = []
            for tool in ('open-decomp', 'ghidra'):
                run = await tool_cell(args, manifest, cell, tool, result['budget'])
                run.update({key: cell[key] for key in ('target', 'compiler', 'optimization', 'symbols')})
                result['runs'].append(run)
                pair.append(run)
                result['summary'] = summary(result)
                quality.save(args.output / 'comparison.json', result)
                print(json.dumps({'cell': cell['id'], 'tool': tool, 'status': run['status'],
                                  'functions': dict(Counter(row['status'] for row in run['functions']))}), flush=True)
            for function in cell['functions']:
                result['matched'].append({'cell': cell['id'], **function,
                    **{run['tool']: next(row for row in run['functions'] if row['name'] == function['name']) for run in pair}})
        result['complete_recording'] = len(result['runs']) == 48 and len(result['matched']) == 24 * 12
        result['implementation_unchanged_over_matrix'] = source_identity(args.entry) == result['implementation_initial']
        result['summary'] = summary(result)
        quality.save(args.output / 'comparison.json', result)
        quality.save(args.output / 'summary.json', {key: result[key] for key in
                     ('complete_recording', 'implementation_unchanged_over_matrix', 'summary', 'limitations')})
        return 0 if result['complete_recording'] else 1
    finally:
        (args.lock / 'owner.json').unlink()
        args.lock.rmdir()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    prep = commands.add_parser('prepare', help='Hash-check and extract retained source-built matrix inputs')
    prep.add_argument('--destination', type=Path, required=True)
    run = commands.add_parser('run', help='Record all matrix cells, including failures, through both MCP servers')
    run.add_argument('--inputs', type=Path, required=True)
    run.add_argument('--output', type=Path, required=True)
    run.add_argument('--entry', type=Path, default=REPO / 'src/cli/entry.ts')
    run.add_argument('--node', default='node')
    run.add_argument('--bridge', type=Path, required=True)
    run.add_argument('--ghidra', type=Path, required=True)
    run.add_argument('--java-home', type=Path, required=True)
    run.add_argument('--profile', choices=['default', 'raised'], default='default')
    run.add_argument('--timeout', type=int, choices=range(1, 1201), default=360)
    run.add_argument('--lock', type=Path, default=REPO / '.local/performance/quality.measurement.lock')
    args = parser.parse_args()
    if args.command == 'prepare':
        quality.prepare(args, json.loads((HERE / 'quality-matrix-inputs.json').read_text()))
        return 0
    return asyncio.run(record(args))


if __name__ == '__main__':
    sys.exit(main())

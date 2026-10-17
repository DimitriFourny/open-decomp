#!/usr/bin/env python3
"""Equal-binary pinned-MCP context workflow evidence; no target execution.

Use the retained analyzed image from the native-context oracle, never its
separately compiled trusted macro oracle. Record every selected family/failure.
"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import traceback

sys.dont_write_bytecode = True
import quality

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SELECTED = ['context_increment', 'context_double', 'context_choose', 'context_two',
            'context_recursive', 'context_recursive_caller', 'context_alias', 'context_same',
            'context_conflict', 'context_conflict_caller', 'context_words', 'context_words_caller']


def implementation(entry):
    root = entry.parent.parent if entry.suffix == '.ts' else entry.parents[2]
    return {'entry': str(entry), 'files': [{'path': str(path.relative_to(root)), 'sha256': quality.digest(path)}
            for path in sorted(root.rglob('*')) if path.is_file()]}


async def run_tool(args, tool, budget):
    directory = args.output / tool
    before = implementation(args.entry) if tool == 'open-decomp' else None
    if tool == 'open-decomp':
        argv = [args.node, *(['--import', 'tsx'] if args.entry.suffix == '.ts' else []), str(args.entry),
                'mcp', 'start', '--root', str(args.output)]
        environment = {}
    else:
        argv = [str(args.bridge / '.venv/bin/python'), str(HERE / 'quality-ghidra.py')]
        environment = {'GHIDRA_INSTALL_DIR': str(args.ghidra), 'JAVA_HOME': str(args.java_home),
                       'JAVA_TOOL_OPTIONS': '-Djava.awt.headless=true', 'GHIDRA_MCP_TRANSPORT': 'stdio',
                       'GHIDRA_MCP_STORAGE_ROOT': str(directory / 'project'),
                       'GHIDRA_MCP_ANALYSIS_TIMEOUT_SECONDS': str(args.timeout)}
    client = quality.MCP(directory, argv, environment, args.timeout)
    run = {'tool': tool, 'functions': [], 'target_executed': False, 'source_debug_types_supplied': False}
    if before:
        run['implementation_before'] = before
    scope = None
    try:
        await client.start()
        run['server_info'] = client.server_info
        if tool == 'open-decomp':
            value, call, failed = await client.call('project_open', {'source': {'kind': 'import',
                'input_path': str(args.output / 'analyzed'), 'project_path': str(directory / 'project')},
                'wait': True, 'budget': budget})
            run['import'] = {'result': value, 'call': call, 'is_error': failed}
            quality.require(not failed and isinstance(value, dict) and value.get('project_id'), 'Import returned no project')
            scope = {key: value[key] for key in ('project_id', 'revision')}
            info, _, failed = await client.call('binary_info', scope)
            quality.require(not failed and info.get('data', {}).get('image'), 'No imported image')
            image = info['data']['image']
        else:
            value, call, failed = await client.call('program_open', {'binary_path': str(args.output / 'analyzed'), 'analyze': True})
            run['import'] = {'result': value, 'call': call, 'is_error': failed}
            quality.require(not failed and isinstance(value, dict) and value.get('program_id'), 'Import returned no Ghidra program')
            scope = {'program_id': value['program_id']}
        for name in SELECTED:
            row = {'name': name, 'outputs': []}
            run['functions'].append(row)
            try:
                if tool == 'open-decomp':
                    value, lookup, failed = await client.call('functions_find', {**scope, 'image_id': image['id'],
                        'page': {'limit': 25}, 'query': {'text': '_' + name, 'match': 'exact', 'case_sensitive': True}})
                    items = [item for item in (value.get('data') or {}).get('items', []) if item.get('original_name') == '_' + name] if isinstance(value, dict) else []
                    row['lookup'] = lookup
                    quality.require(not failed and len(items) == 1, 'Exact function symbol not uniquely discovered')
                    function = items[0]
                    row['address'] = function['entry']['value']
                else:
                    value, lookup, failed = await client.call('symbols_list', {**scope, 'contains': name})
                    items = [item for item in value if item['name'] in (name, '_' + name)] if isinstance(value, list) else []
                    row['lookup'] = lookup
                    quality.require(not failed and len(items) == 1, 'Exact Ghidra symbol not uniquely discovered')
                    row['address'] = '0x' + items[0]['address'].removeprefix('0x')
                for language in (('c-like', 'python-like') if tool == 'open-decomp' else ('c-like',)):
                    output = {'language': language}
                    row['outputs'].append(output)
                    if tool == 'open-decomp':
                        value, call, failed = await client.call('function_decompile', {**scope,
                            'function_id': function['id'], 'wait': True, 'budget': budget, 'options': {'emitter': language}})
                    else:
                        value, call, failed = await client.call('decompile_function', {**scope,
                            'address': row['address'].removeprefix('0x'), 'max_chars': 200000})
                    output.update({'call': call, 'is_error': failed})
                    if failed or not isinstance(value, dict):
                        output.update({'status': 'tool_error', 'raw_result': value})
                        continue
                    if tool == 'open-decomp':
                        emit, semantic, artifact = await quality.emission(client, value, name + '-' + language)
                        output.update({'operation_state': value.get('state'), 'semantic_state': semantic.get('state'),
                            'reason': semantic.get('reason'), 'coverage': semantic.get('coverage'), 'diagnostics': semantic.get('diagnostics'),
                            'versions': semantic.get('versions'), 'artifact': artifact})
                        text = emit.get('text') if emit else None
                        if emit:
                            quality.save(directory / (name + '-' + language + '.emission.json'), emit)
                    else:
                        text = value.get('c')
                        output.update({'semantic_state': 'not_reported_by_bridge', 'truncated': value.get('truncated')})
                    if text:
                        path = directory / (name + ('.py' if language == 'python-like' else '.c'))
                        path.write_text(text)
                        output.update({'status': 'text_returned', 'path': str(path.relative_to(args.output)),
                                       'sha256': quality.digest(path), 'bytes': path.stat().st_size})
                    else:
                        output.update({'status': 'no_text', 'raw_result': value})
            except Exception as error:
                row.update({'error': repr(error), 'traceback': traceback.format_exc()})
            finally:
                quality.save(directory / 'run.json', run)
    except Exception as error:
        run.update({'error': repr(error), 'traceback': traceback.format_exc()})
    finally:
        for name in SELECTED:
            if not any(row['name'] == name for row in run['functions']):
                run['functions'].append({'name': name, 'error': run.get('error', 'Not reached'), 'outputs': []})
        if scope:
            try:
                value, call, failed = await client.call('project_close' if tool == 'open-decomp' else 'program_close',
                    {**scope, 'running_jobs': 'cancel'} if tool == 'open-decomp' else scope)
                run['close'] = {'result': value, 'call': call, 'is_error': failed}
            except Exception as error:
                run['close_error'] = repr(error)
        await client.close()
        run['server_exit_code'] = getattr(client, 'exit_code', None)
        if before:
            after = implementation(args.entry)
            run['implementation_unchanged_during_run'] = before == after
            if before != after:
                run['implementation_after'] = after
        quality.save(directory / 'run.json', run)
    return run


async def record(args):
    args.output, args.entry = args.output.resolve(), args.entry.resolve()
    quality.require(not args.output.exists() and not args.output.is_relative_to(Path('/tmp').resolve()), 'Use a new durable output directory')
    quality.require(not any(part.startswith('.') for part in args.output.parts), 'Ghidra needs non-hidden project paths')
    original = json.loads((HERE / 'quality-inputs.json').read_text())
    commit = subprocess.check_output(['git', '-C', str(args.bridge), 'rev-parse', 'HEAD'], text=True).strip()
    quality.require(commit == original['ghidra']['bridge_commit'], 'Wrong bridge commit')
    quality.require(not subprocess.check_output(['git', '-C', str(args.bridge), 'status', '--porcelain', '--untracked-files=no'], text=True), 'Modified bridge source')
    quality.require('application.version=12.1.4' in (args.ghidra / 'Ghidra/application.properties').read_text().splitlines(), 'Wrong Ghidra version')
    args.output.mkdir(parents=True)
    shutil.copyfile(args.input, args.output / 'analyzed')
    quality.require(quality.digest(args.input) == quality.digest(args.output / 'analyzed'), 'Retained input changed during copy')
    shutil.copyfile(args.source, args.output / 'native-context-source.c')
    shutil.copyfile(REPO / 'LICENSE', args.output / 'LICENSE')
    report = {'schema': 1, 'purpose': 'P3.4 equal-binary native-context MCP source-workflow evidence; no parity/performance claim',
        'arguments': {key: str(value) if isinstance(value, Path) else value for key, value in vars(args).items()},
        'input': {'original': str(args.input), 'retained': 'analyzed', 'bytes': (args.output / 'analyzed').stat().st_size,
                  'sha256': quality.digest(args.output / 'analyzed'), 'executed': False, 'trusted_oracle_macro': False},
        'source': {'path': 'native-context-source.c', 'sha256': quality.digest(args.output / 'native-context-source.c'), 'license': 'MIT; LICENSE'},
        'selected': SELECTED, 'budget': original['budgets']['default'], 'bridge_commit': commit, 'runs': [], 'matched': [],
        'method': {'equal_binary_bytes': True, 'source_debug_types_annotations_supplied': False,
                   'open_decomp_dialects': ['c-like', 'python-like'], 'comparator_dialect': 'c-like',
                   'target_execution': False, 'host_idle': False, 'performance_claim': False,
                   'annotations_provenance': 'Separate evidence; no annotations injected in this comparison'},
        'limitations': ['Returning text and complete states are not behavioral-equivalence proofs.',
                       'Native source-oracle outcomes are separately supplied by ContextRecovery; not rerun by this harness.',
                       'Source-entry implementation hashes expose concurrent changes; no stable checkpoint claim if they differ.']}
    args.lock.parent.mkdir(parents=True, exist_ok=True)
    args.lock.mkdir()
    quality.save(args.lock / 'owner.json', {'pid': os.getpid(), 'output': str(args.output)})
    try:
        for tool in ('open-decomp', 'ghidra'):
            run = await run_tool(args, tool, report['budget'])
            report['runs'].append(run)
            quality.save(args.output / 'comparison.json', report)
            print(json.dumps({'tool': tool, 'error': run.get('error'), 'functions': len(run['functions']),
                              'text_outputs': sum(output.get('status') == 'text_returned' for row in run['functions'] for output in row['outputs'])}), flush=True)
        for name in SELECTED:
            pair = {'name': name}
            for run in report['runs']:
                pair[run['tool']] = next(row for row in run['functions'] if row['name'] == name)
            addresses = [pair[tool].get('address') for tool in ('open-decomp', 'ghidra')]
            pair['addresses_match'] = all(addresses) and int(addresses[0], 16) == int(addresses[1], 16)
            report['matched'].append(pair)
        report['complete_recording'] = len(report['matched']) == len(SELECTED)
        quality.save(args.output / 'comparison.json', report)
        return 0 if report['complete_recording'] else 1
    finally:
        (args.lock / 'owner.json').unlink()
        args.lock.rmdir()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('input', 'output', 'bridge', 'ghidra', 'java-home'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--entry', type=Path, default=REPO / 'src/cli/entry.ts')
    parser.add_argument('--source', type=Path, default=REPO / 'test/service/analysis/native-context-source.c',
                        help='Exact retained build-source snapshot; provenance only, never supplied to either MCP')
    parser.add_argument('--node', default='node')
    parser.add_argument('--timeout', type=int, choices=range(1, 1201), default=360)
    parser.add_argument('--lock', type=Path, default=REPO / '.local/performance/quality.measurement.lock')
    return asyncio.run(record(parser.parse_args()))


if __name__ == '__main__':
    sys.exit(main())

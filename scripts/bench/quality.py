#!/usr/bin/env python3
"""Reviewed, analysis-only paired MCP comparison. See docs/PERFORMANCE.md.

Python's stdlib is the same newline JSON-RPC client for both real servers. This
records evidence, not equivalence or a ranking. No analyzed input is executed.
"""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import sys
import tarfile
import time
import traceback
from evidence import evidence_path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
MANIFEST = HERE / 'quality-inputs.json'


def save(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def payload(response):
    require('error' not in response, f'JSON-RPC failure: {response.get("error")}')
    result = response['result']
    if 'structuredContent' in result:
        value = result['structuredContent']
    else:
        texts = [v['text'] for v in result.get('content', []) if v.get('type') == 'text']
        value = texts
        if len(texts) == 1:
            try:
                value = json.loads(texts[0])
            except json.JSONDecodeError:
                value = texts[0]  # Real MCP tool failures may be plain text.
    if isinstance(value, dict) and set(value) == {'result'}:
        value = value['result']
    return value


class MCP:
    def __init__(self, directory, command, environment, timeout):
        self.directory, self.command, self.environment = directory, command, environment
        self.timeout, self.sequence, self.pending = timeout, 0, {}
        self.records = []

    async def start(self):
        self.directory.mkdir(parents=True)
        self.wire = (self.directory / 'wire.jsonl').open('w')
        self.stdout = (self.directory / 'stdout.bin').open('wb')
        self.stderr = (self.directory / 'stderr.txt').open('wb')
        save(self.directory / 'invocation.json', {'argv': self.command, 'cwd': str(REPO),
             'env_overrides': self.environment})
        self.started = time.perf_counter()
        self.process = await asyncio.create_subprocess_exec(
            *self.command, cwd=REPO, env=dict(os.environ, **self.environment),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=self.stderr, limit=64 * 1024 * 1024, start_new_session=True)
        self.reader = asyncio.create_task(self.consume())
        initialized, _ = await self.rpc('initialize', {
            'protocolVersion': '2025-11-25', 'capabilities': {},
            'clientInfo': {'name': 'open-decomp-quality', 'version': '1'}})
        self.server_info = initialized['result'].get('serverInfo')
        await self.send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        schemas, _ = await self.rpc('tools/list', {})
        save(self.directory / 'tools.json', schemas)

    async def consume(self):
        try:
            while line := await self.process.stdout.readline():
                self.stdout.write(line)
                self.stdout.flush()
                message = json.loads(line)
                self.wire.write(json.dumps({'direction': 'response', 'message': message}) + '\n')
                self.wire.flush()
                future = self.pending.pop(message.get('id'), None)
                if future is not None and not future.done():
                    future.set_result(message)
        except Exception as error:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(error)
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(RuntimeError('MCP stdout closed'))

    async def send(self, message):
        self.wire.write(json.dumps({'direction': 'request', 'message': message}) + '\n')
        self.wire.flush()
        self.process.stdin.write((json.dumps(message) + '\n').encode())
        await self.process.stdin.drain()

    async def rpc(self, method, params):
        self.sequence += 1
        sequence = self.sequence
        request = {'jsonrpc': '2.0', 'id': sequence, 'method': method, 'params': params}
        prefix = self.directory / f'{sequence:04}'
        save(prefix.with_suffix('.request.json'), request)
        future = asyncio.get_running_loop().create_future()
        self.pending[sequence] = future
        started = time.perf_counter()
        record = {'method': method, 'request': prefix.name + '.request.json'}
        try:
            await self.send(request)
            response = await asyncio.wait_for(future, self.timeout)
            record['elapsed_ms'] = (time.perf_counter() - started) * 1000
            record['response'] = prefix.name + '.response.json'
            save(prefix.with_suffix('.response.json'), response)
            return response, record
        except Exception as error:
            record['error'] = repr(error)
            raise
        finally:
            self.pending.pop(sequence, None)
            self.records.append(record)
            save(self.directory / 'calls.json', self.records)

    async def call(self, name, arguments):
        response, record = await self.rpc('tools/call', {'name': name, 'arguments': arguments})
        return payload(response), record, response['result'].get('isError', False)

    async def close(self):
        if hasattr(self, 'process'):
            if self.process.returncode is None:
                self.process.stdin.close()
                try:
                    await asyncio.wait_for(self.process.wait(), 2)
                except asyncio.TimeoutError:
                    os.killpg(self.process.pid, signal.SIGTERM)
                    try:
                        await asyncio.wait_for(self.process.wait(), 3)
                    except asyncio.TimeoutError:
                        os.killpg(self.process.pid, signal.SIGKILL)
                        await self.process.wait()
            await self.reader
            self.exit_code = self.process.returncode
        for name in ('wire', 'stdout', 'stderr'):
            if hasattr(self, name):
                getattr(self, name).close()


async def emission(client, value, target):
    """Read and hash the actual published artifact, never infer semantic state."""
    stored = value
    data = value.get('data') or {}
    artifact_record = None
    if data.get('delivery') == 'artifact':
        artifact = next(a for a in value['artifacts'] if a['id'] == data['artifact_id'])
        offset, chunks, seen = '0x0', [], set()
        while offset is not None:
            require(offset not in seen, 'Repeated artifact page offset')
            seen.add(offset)
            uri = (f'open-decomp://artifact/{artifact["project_id"]}/{artifact["revision"]}/'
                   f'{artifact["id"]}?offset={offset}&length=524288')
            response, _ = await client.rpc('resources/read', {'uri': uri})
            part = response['result']['contents'][0]
            chunks.append(part['text'].encode())
            offset = part.get('_meta', {}).get('open-decomp/artifact', {}).get('next_offset')
        raw = b''.join(chunks)
        require(hashlib.sha256(raw).hexdigest() == artifact['sha256'], 'Artifact hash mismatch')
        require(len(raw) == int(artifact['size'], 16), 'Artifact size mismatch')
        path = client.directory / f'{target}.artifact.json'
        path.write_bytes(raw)
        artifact_record = {'path': path.name, 'sha256': artifact['sha256'], 'bytes': len(raw)}
        decoded = json.loads(raw)
        stored = decoded.get('result', decoded)
    return (stored.get('data') or {}).get('emission'), stored, artifact_record


async def run_one(args, manifest, item, iteration, tool):
    directory = args.output / f'{item["id"]}-run{iteration}' / tool
    if tool == 'open-decomp':
        command = [args.node, str(args.entry), 'mcp', 'start', '--root', str(args.inputs),
                   '--root', str(args.output)]
        environment = {}
    else:
        command = [str(args.ghidra_bridge / '.venv/bin/python'), str(HERE / 'quality-ghidra.py')]
        environment = {'GHIDRA_INSTALL_DIR': str(args.ghidra), 'JAVA_HOME': str(args.java_home),
                       'JAVA_TOOL_OPTIONS': '-Djava.awt.headless=true',
                       'GHIDRA_MCP_STORAGE_ROOT': str(directory / 'project'),
                       'GHIDRA_MCP_TRANSPORT': 'stdio',
                       'GHIDRA_MCP_ANALYSIS_TIMEOUT_SECONDS': str(args.timeout)}
    client = MCP(directory, command, environment, args.timeout)
    run = {'input': item['id'], 'iteration': iteration, 'tool': tool, 'functions': [],
           'profile': args.profile, 'project_lifecycle': 'fresh', 'target_executed': False}
    scope = None
    try:
        await client.start()
        run['server_info'] = client.server_info
        binary = str(args.inputs / item['path'])
        budget = manifest['budgets'][args.profile]
        if tool == 'open-decomp':
            opened, record, failed = await client.call('project_open', {
                'source': {'kind': 'import', 'input_path': binary,
                           'project_path': str(directory / 'project')}, 'wait': True, 'budget': budget})
            run['import'] = {'call': record, 'result': opened, 'is_error': failed}
            require(not failed and opened.get('project_id'), 'Open Decomp import returned no project')
            scope = {k: opened[k] for k in ('project_id', 'revision')}
            info, _, _ = await client.call('binary_info', scope)
            image = info['data']['image']
        else:
            opened, record, failed = await client.call('program_open', {'binary_path': binary, 'analyze': True})
            run['import'] = {'call': record, 'result': opened, 'is_error': failed}
            require(not failed and isinstance(opened, dict) and opened.get('program_id'),
                    'Ghidra import returned no program')
            scope = {'program_id': opened['program_id']}
        for selected in item['functions']:
            name = selected['name']
            if args.function and name not in args.function:
                continue
            row = {'name': name, 'reviewed_address': selected['address'], 'samples': []}
            run['functions'].append(row)
            if tool == 'open-decomp':
                matches = []
                for exact in (name, '_' + name):
                    found, _, _ = await client.call('functions_find', {
                        **scope, 'image_id': image['id'], 'page': {'limit': 25},
                        'query': {'text': exact, 'match': 'exact', 'case_sensitive': True}})
                    matches = [f for f in (found.get('data') or {}).get('items', [])
                               if f['original_name'] == exact or f['display_name'] == exact]
                    if matches:
                        break
                if not matches:
                    row['gap'] = 'Requested symbol not discovered'
                    continue
                require(len(matches) == 1, f'Ambiguous symbol {name}')
                function = matches[0]
                address = function['entry']['value']
                tool_name = 'function_decompile'
                request = {**scope, 'function_id': function['id'], 'wait': True, 'budget': budget}
            else:
                found, _, failed = await client.call('symbols_list', {**scope, 'contains': name})
                require(not failed and isinstance(found, list), f'Failed symbol lookup: {name}')
                matches = [f for f in found if f['name'] in (name, '_' + name)]
                if not matches:
                    row['gap'] = 'Requested symbol not discovered'
                    continue
                require(len(matches) == 1, f'Ambiguous symbol {name}')
                address = matches[0]['address']
                tool_name = 'decompile_function'
                request = {**scope, 'address': address, 'max_chars': manifest['ghidra']['max_chars']}
            require(int(address, 16) == int(selected['address'], 16), f'Reviewed address mismatch: {name}')
            row['address'] = address
            for repeat in range(args.warm_runs + 1):
                value, record, failed = await client.call(tool_name, request)
                sample = {'kind': 'first' if repeat == 0 else 'repeated', 'call': record,
                          'is_error': failed}
                row['samples'].append(sample)
                text = None
                if failed or not isinstance(value, dict):
                    sample['gap'] = 'Tool error or non-object payload; inspect raw response'
                    continue
                if tool == 'open-decomp':
                    emit, semantic, artifact = await emission(client, value, f'{name}-{repeat}')
                    sample.update({'operation_state': value.get('state'), 'reason': value.get('reason'),
                                   'semantic_state': semantic.get('state'), 'coverage': semantic.get('coverage'),
                                   'diagnostics': semantic.get('diagnostics'), 'versions': semantic.get('versions'),
                                   'cache': (value.get('data') or {}).get('cache'), 'artifact': artifact})
                    if emit:
                        text = emit.get('text')
                        sample['emitter_version'] = emit.get('emitter_version')
                else:
                    sample.update({'semantic_state': 'not_reported_by_bridge',
                                   'truncated': value.get('truncated') if isinstance(value, dict) else None})
                    if isinstance(value, dict):
                        text = value.get('c')
                if text and not failed:
                    path = directory / f'{name}-{repeat}.c'
                    path.write_text(text)
                    sample['output'] = {'path': str(path.relative_to(args.output)),
                                        'sha256': digest(path), 'bytes': path.stat().st_size}
                else:
                    sample['gap'] = 'No source text returned; inspect raw response'
            save(directory / 'run.json', run)
    except Exception as error:
        run['error'] = repr(error)
        run['traceback'] = traceback.format_exc()
    finally:
        if scope:
            try:
                close_name = 'project_close' if tool == 'open-decomp' else 'program_close'
                close_args = {**scope, 'running_jobs': 'cancel'} if tool == 'open-decomp' else scope
                value, record, failed = await client.call(close_name, close_args)
                run['close'] = {'call': record, 'result': value, 'is_error': failed}
                require(not failed, 'Tool returned an error while closing project')
            except Exception as error:
                run['close_error'] = repr(error)
        await client.close()
        run['server_exit_code'] = getattr(client, 'exit_code', None)
        save(directory / 'run.json', run)
    return run


def prepare(args, manifest):
    archive = evidence_path(f"scripts/bench/{manifest['baseline']['archive']}")
    require(digest(archive) == manifest['baseline']['sha256'], 'Baseline archive hash mismatch')
    args.destination.mkdir(parents=True, exist_ok=False)
    with tarfile.open(archive) as bundle:
        bundle.extractall(args.destination, filter='data')
    for entry in manifest['baseline']['files']:
        path = args.destination / entry['path']
        require(path.stat().st_size == entry['bytes'] and digest(path) == entry['sha256'],
                f'Baseline evidence mismatch: {entry["path"]}')
    print(json.dumps({'prepared': str(args.destination), 'files': len(manifest['baseline']['files'])}))


async def compare(args, manifest):
    args.inputs = args.inputs.resolve()
    args.output = args.output.resolve()
    require(not args.output.is_relative_to(Path('/tmp').resolve()), 'Choose durable output outside /tmp')
    require(not args.output.exists(), 'Output must be a new directory; never overwrite evidence')
    selected = [item for item in manifest['inputs'] if not args.input or item['id'] in args.input]
    require(bool(selected), 'No selected inputs')
    if args.function:
        available = {f['name'] for item in selected for f in item['functions']}
        require(set(args.function) <= available, 'Unknown selected function')
    for item in selected:
        path = args.inputs / item['path']
        require(path.stat().st_size == item['bytes'] and digest(path) == item['sha256'],
                f'Input hash/size mismatch: {path}')
    args.entry = args.entry.resolve()
    require(args.entry.is_file(), 'Build Open Decomp before running the comparison')
    args.ghidra_bridge = args.ghidra_bridge.resolve()
    commit = subprocess.check_output(['git', '-C', str(args.ghidra_bridge), 'rev-parse', 'HEAD'], text=True).strip()
    require(commit == manifest['ghidra']['bridge_commit'], 'Wrong Ghidra bridge revision')
    changes = subprocess.check_output(['git', '-C', str(args.ghidra_bridge), 'status', '--porcelain', '--untracked-files=no'], text=True)
    require(not changes, 'Ghidra bridge tracked sources must be unchanged')
    properties = args.ghidra / 'Ghidra/application.properties'
    require(f'application.version={manifest["ghidra"]["version"]}' in properties.read_text().splitlines(),
            'Wrong Ghidra version')
    require(not any(part.startswith('.') for part in args.output.parts),
            'Ghidra rejects dot-prefixed project path elements; use a non-hidden durable output directory')
    bridge_python = args.ghidra_bridge / '.venv/bin/python'
    bridge_versions = json.loads(subprocess.check_output([
        str(bridge_python), '-c',
        'import importlib.metadata,json,sys; print(json.dumps({'
        '"python":sys.version,"packages":{d.metadata["Name"]:d.version '
        'for d in importlib.metadata.distributions()}}))'], text=True))
    java_version = subprocess.check_output(
        [str(args.java_home / 'bin/java'), '-version'], stderr=subprocess.STDOUT, text=True).strip()
    native_files = [
        {'path': str(path.relative_to(args.ghidra)), 'sha256': digest(path)}
        for path in sorted(args.ghidra.glob('Ghidra/Features/Decompiler/os/*/decompile*'))
        if path.is_file()
    ]
    result = {'schema': 1, 'purpose': 'Reproducible raw matched outputs; no equivalence or ranking claim',
              'manifest_sha256': digest(MANIFEST), 'arguments': vars(args).copy(),
              'host': {'platform': platform.platform(), 'python': sys.version},
              'tool_identity': {'entry_sha256': digest(args.entry),
                                'node': subprocess.check_output([args.node, '--version'], text=True).strip(),
                                'bridge_commit': commit, 'bridge_runtime': bridge_versions,
                                'java': java_version, 'ghidra_properties_sha256': digest(properties),
                                'native_decompilers': native_files},
              'method': manifest['method'], 'runs': [], 'matched': []}
    result['arguments'] = {key: str(value) if isinstance(value, Path) else value
                           for key, value in result['arguments'].items()}
    args.lock.parent.mkdir(parents=True, exist_ok=True)
    args.lock.mkdir()  # Fail rather than silently overlap or steal another measurement.
    save(args.lock / 'owner.json', {'pid': os.getpid(), 'output': str(args.output)})
    try:
        args.output.mkdir(parents=True)
        save(args.output / 'reviewed-manifest.json', manifest)
        for item in selected:
            for iteration in range(1, args.cold_runs + 1):
                pair = []
                for tool in ('open-decomp', 'ghidra'):
                    run = await run_one(args, manifest, item, iteration, tool)
                    pair.append(run)
                    result['runs'].append(run)
                    save(args.output / 'comparison.json', result)
                    print(json.dumps({'input': item['id'], 'iteration': iteration, 'tool': tool,
                                      'error': run.get('error'), 'functions': len(run['functions'])}), flush=True)
                for function in item['functions']:
                    if args.function and function['name'] not in args.function:
                        continue
                    matched = {'input': item['id'], 'iteration': iteration, **function}
                    for run in pair:
                        matched[run['tool']] = next((row for row in run['functions']
                                                     if row['name'] == function['name']), {'gap': run.get('error', 'No result')})
                    result['matched'].append(matched)
        result['complete_recording'] = not any(run.get('error') or run.get('close_error') for run in result['runs'])
        save(args.output / 'comparison.json', result)
        # Coverage failures are recorded results, not success or proof of correctness.
        return 0 if result['complete_recording'] else 1
    finally:
        (args.lock / 'owner.json').unlink()
        args.lock.rmdir()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    prep = commands.add_parser('prepare', help='Extract and hash-check the retained reviewed baseline')
    prep.add_argument('--destination', type=Path, required=True)
    run = commands.add_parser('run', help='Run both real MCP servers serially against reviewed inputs')
    run.add_argument('--inputs', type=Path, required=True, help='Extracted baseline root, not its inputs subdirectory')
    run.add_argument('--output', type=Path, required=True)
    run.add_argument('--node', default='node')
    run.add_argument('--entry', type=Path, default=REPO / 'dist/src/cli/entry.js')
    run.add_argument('--ghidra-bridge', type=Path, required=True)
    run.add_argument('--ghidra', type=Path, required=True)
    run.add_argument('--java-home', type=Path, required=True)
    run.add_argument('--input', action='append', choices=['corpus-arm64', 'sqlite3-arm64'])
    run.add_argument('--function', action='append')
    run.add_argument('--profile', choices=['default', 'raised'], default='default')
    run.add_argument('--cold-runs', type=int, choices=range(1, 21), default=3)
    run.add_argument('--warm-runs', type=int, choices=range(0, 101), default=10)
    run.add_argument('--timeout', type=int, choices=range(1, 1201), default=360)
    run.add_argument('--lock', type=Path, default=REPO / '.local/performance/quality.measurement.lock')
    args = parser.parse_args()
    manifest = json.loads(MANIFEST.read_text())
    if args.command == 'prepare':
        prepare(args, manifest)
        return 0
    return asyncio.run(compare(args, manifest))


if __name__ == '__main__':
    sys.exit(main())

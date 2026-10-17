#!/usr/bin/env python3
"""Build and record the frozen held-out corpus without modifying matrix/baseline.
No analyzed matrix binary is executed. All unsupported cells remain explicit.
"""
import argparse
import asyncio
from collections import Counter
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True
import quality

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


matrix = load('quality_matrix', 'quality-matrix.py')
builder = load('quality_matrix_build', 'quality-matrix-build.py')


def selection():
    value = json.loads((HERE / 'quality-heldout-selection.json').read_text())
    quality.require(quality.digest(REPO / value['source']['path']) == value['source']['sha256'],
                    'Frozen held-out source changed; do not silently reseal or retune')
    return value


def build(args):
    frozen = selection()
    root = args.output.resolve()
    quality.require(not root.exists(), 'Use a new held-out build directory')
    root.mkdir(parents=True)
    source = root / 'source'
    source.mkdir()
    shutil.copyfile(HERE / 'quality-heldout-corpus.c', source / 'quality-heldout-corpus.c')
    shutil.copyfile(REPO / 'LICENSE', source / 'LICENSE')
    sdk = builder.execute(['/usr/bin/xcrun', '--show-sdk-path'], root)['stdout'].strip()
    llvm, lld = Path('/opt/homebrew/opt/llvm/bin'), Path('/opt/homebrew/opt/lld/bin')
    compilers = {'apple-clang21': '/usr/bin/clang', 'llvm-clang23': str(llvm / 'clang')}
    tools = {name: {'path': path, 'sha256': quality.digest(Path(path)),
                    'version': builder.execute([path, '--version'], root)['stdout']}
             for name, path in compilers.items()}
    for name, path in [('ld.lld', lld / 'ld.lld'), ('lld-link', lld / 'lld-link'),
                       *[(name, llvm / name) for name in ('llvm-nm', 'llvm-objcopy', 'llvm-readobj', 'llvm-objdump')]]:
        tools[name] = {'path': str(path), 'sha256': quality.digest(path),
                       'version': builder.execute([str(path), '--version'], root)['stdout']}
    plan = {'schema': 1, 'root': str(root), 'selection': frozen,
            'selection_sha256': quality.digest(HERE / 'quality-heldout-selection.json'),
            'tools': tools, 'sdk': sdk, 'cells': [],
            'method': {'target_execution': False, 'source_debug_types_supplied': False,
                       'selection': 'Compiler VA identically selected for both tools; no names/prototypes/annotations injected.',
                       'heldout_policy': frozen['separation'],
                       'limitations': 'Static-analysis recording is not behavioral-equivalence proof.'}}
    for target, triple in builder.TARGETS.items():
        for compiler, cc in compilers.items():
            for opt in ('O0', 'O2'):
                name = f'{target}-{compiler}-{opt}'
                directory = root / name
                directory.mkdir()
                functions = [{**item, 'address': None} for item in frozen['selected_functions']]
                commands, cells = [], []
                for symbols in ('symbol-bearing', 'stripped'):
                    cell = {'id': name + '-' + symbols, 'target': target, 'compiler': compiler,
                            'optimization': opt, 'symbols': symbols, 'functions': functions,
                            'commands': commands, 'target_executed': False}
                    cells.append(cell)
                    plan['cells'].append(cell)
                try:
                    obj = directory / 'heldout.o'
                    commands.append(builder.execute([cc, '--target=' + triple, '-std=c11', '-' + opt,
                        '-g0', '-ffreestanding', '-fno-builtin', '-fno-stack-protector', '-ffp-contract=off',
                        '-ffile-prefix-map=' + str(root) + '=.', '-c', str(source / 'quality-heldout-corpus.c'),
                        '-o', str(obj)], directory))
                    binary = directory / ('symbols.exe' if target.startswith('pe') else 'symbols')
                    if target.startswith('macho'):
                        command = [cc, '--target=' + triple, '-isysroot', sdk, '-nostdlib',
                                   '-Wl,-e,_heldout_entry', '-Wl,-no_uuid', str(obj), '-lSystem', '-o', str(binary)]
                    elif target.startswith('pe'):
                        command = [str(lld / 'lld-link'), '/nodefaultlib', '/machine:x64', '/subsystem:console',
                                   '/entry:heldout_entry', '/timestamp:0', '/debug:dwarf', '/opt:noref',
                                   '/base:0x140000000', '/out:' + str(binary), str(obj)]
                    else:
                        command = [str(lld / 'ld.lld'), '-m', 'elf_x86_64', '--build-id=none', '-z', 'noexecstack',
                                   '--entry=heldout_entry', '--image-base=0x400000', '-o', str(binary), str(obj)]
                    commands.append(builder.execute(command, directory))
                    nm = builder.execute([str(llvm / 'llvm-nm'), '--defined-only', '--format=posix', str(binary)], directory)
                    commands.append(nm)
                    addresses = {parts[0].removeprefix('_'): '0x' + parts[2]
                                 for line in nm['stdout'].splitlines() if len(parts := line.split()) >= 3 and parts[1].upper() == 'T'}
                    for function in functions:
                        function['address'] = addresses[function['name']]
                    stripped = directory / ('stripped.exe' if target.startswith('pe') else 'stripped')
                    shutil.copyfile(binary, stripped)
                    command = ['/usr/bin/strip', str(stripped)] if target.startswith('macho') else [str(llvm / 'llvm-objcopy'), '--strip-all', str(stripped)]
                    commands.append(builder.execute(command, directory))
                    for cell, path in zip(cells, (binary, stripped)):
                        metadata = builder.execute([str(llvm / 'llvm-readobj'), '--file-headers', '--sections', '--symbols', str(path)], directory)
                        disasm = builder.execute([str(llvm / 'llvm-objdump'), '--disassemble', str(path)], directory)
                        (directory / (cell['symbols'] + '.metadata.txt')).write_text(metadata['stdout'])
                        (directory / (cell['symbols'] + '.disassembly.txt')).write_text(disasm['stdout'])
                        text = directory / (cell['symbols'] + '.text.bin')
                        section = '__TEXT,__text' if target.startswith('macho') else '.text'
                        commands.append(builder.execute([str(llvm / 'llvm-objcopy'), '--dump-section=' + section + '=' + str(text), str(path)], directory))
                        cell.update({'status': 'built', 'input': builder.identify(path), 'text': builder.identify(text)})
                    quality.require(cells[0]['text']['sha256'] == cells[1]['text']['sha256'], 'Stripping changed code')
                    stripped_nm = builder.execute([str(llvm / 'llvm-nm'), '--defined-only', str(stripped)], directory)
                    commands.append(stripped_nm)
                    quality.require(not any(function['name'] in stripped_nm['stdout'] for function in functions), 'Selected names survived stripping')
                except Exception as error:
                    for cell in cells:
                        cell.update({'status': 'build_failed', 'error': repr(error)})
                quality.save(root / 'build-manifest.json', plan)
                print(json.dumps({'configuration': name, 'states': [cell['status'] for cell in cells]}), flush=True)
    return 0 if all(cell['status'] == 'built' for cell in plan['cells']) else 1


async def record(args):
    frozen = selection()
    args.inputs, args.output, args.entry = args.inputs.resolve(), args.output.resolve(), args.entry.resolve()
    quality.require(not args.output.exists() and not args.output.is_relative_to(Path('/tmp').resolve()), 'Use a new durable output directory')
    quality.require(not any(part.startswith('.') for part in args.output.parts), 'Ghidra needs non-hidden project paths')
    manifest = json.loads((args.inputs / 'build-manifest.json').read_text())
    quality.require(manifest['selection']['source']['sha256'] == frozen['source']['sha256'], 'Wrong held-out source build')
    quality.require(len(manifest['cells']) == 24, 'Retain every planned held-out cell')
    original = json.loads((HERE / 'quality-inputs.json').read_text())
    commit = subprocess.check_output(['git', '-C', str(args.bridge), 'rev-parse', 'HEAD'], text=True).strip()
    quality.require(commit == original['ghidra']['bridge_commit'], 'Wrong bridge commit')
    quality.require(not subprocess.check_output(['git', '-C', str(args.bridge), 'status', '--porcelain', '--untracked-files=no'], text=True), 'Modified bridge source')
    quality.require('application.version=12.1.4' in (args.ghidra / 'Ghidra/application.properties').read_text().splitlines(), 'Wrong Ghidra version')
    result = {'schema': 1, 'purpose': 'P2.3 frozen held-out equal-access recording, no tuning or parity claim',
              'build_manifest': manifest, 'arguments': {key: str(value) if isinstance(value, Path) else value for key, value in vars(args).items()},
              'bridge_commit': commit, 'budget': original['budgets']['default'], 'runs': [], 'matched': [],
              'implementation_initial': matrix.source_identity(args.entry),
              'limitations': ['No source or output provided to reconstruction tuners.', 'No performance inference; host not reserved idle.',
                             'Source/native oracle checks are separate from decompiled-output equivalence.', 'One equal-access observation per cell, all failures retained.']}
    args.lock.parent.mkdir(parents=True, exist_ok=True)
    args.lock.mkdir()
    quality.save(args.lock / 'owner.json', {'pid': os.getpid(), 'output': str(args.output)})
    try:
        args.output.mkdir(parents=True)
        for cell in manifest['cells']:
            pair = []
            for tool in ('open-decomp', 'ghidra'):
                run = await matrix.tool_cell(args, manifest, cell, tool, result['budget'])
                run.update({key: cell[key] for key in ('target', 'compiler', 'optimization', 'symbols')})
                result['runs'].append(run)
                pair.append(run)
                quality.save(args.output / 'comparison.json', result)
                print(json.dumps({'cell': cell['id'], 'tool': tool, 'status': run['status'],
                                  'functions': dict(Counter(row['status'] for row in run['functions']))}), flush=True)
            for function in cell['functions']:
                result['matched'].append({'cell': cell['id'], **function,
                    **{run['tool']: next(row for row in run['functions'] if row['name'] == function['name']) for run in pair}})
        result['complete_recording'] = len(result['runs']) == 48 and len(result['matched']) == 120
        result['implementation_unchanged_over_matrix'] = matrix.source_identity(args.entry) == result['implementation_initial']
        result['summary'] = matrix.summary(result)
        quality.save(args.output / 'comparison.json', result)
        quality.save(args.output / 'summary.json', {key: result[key] for key in ('complete_recording', 'implementation_unchanged_over_matrix', 'summary', 'limitations')})
        return 0 if result['complete_recording'] else 1
    finally:
        (args.lock / 'owner.json').unlink()
        args.lock.rmdir()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    compile_parser = commands.add_parser('build')
    compile_parser.add_argument('--output', type=Path, required=True)
    run = commands.add_parser('run')
    for name in ('inputs', 'output', 'entry', 'bridge', 'ghidra', 'java-home'):
        run.add_argument('--' + name, type=Path, required=True)
    run.add_argument('--node', default='node')
    run.add_argument('--timeout', type=int, choices=range(1, 1201), default=360)
    run.add_argument('--lock', type=Path, default=REPO / '.local/performance/quality.measurement.lock')
    args = parser.parse_args()
    return build(args) if args.command == 'build' else asyncio.run(record(args))


if __name__ == '__main__':
    sys.exit(main())

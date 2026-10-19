#!/usr/bin/env python3
"""Build and record the second sealed held-out suite (24 cells, private source).

Mirrors quality-heldout.py, parameterised by quality-heldout2-selection.json. The
C source lives under the gitignored .local/quality-heldout2/source/ and is never
copied next to the inputs. No analyzed binary is executed and all unsupported
cells remain explicit. `build` runs only trusted compilers/linkers/objcopy;
`run` records Open Decomp and Ghidra and must only be used at a measurement round.
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
SELECTION = HERE / 'quality-heldout2-selection.json'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


matrix = load('quality_matrix', 'quality-matrix.py')
builder = load('quality_matrix_build', 'quality-matrix-build.py')


def selection():
    value = json.loads(SELECTION.read_text())
    quality.require(quality.digest(REPO / value['source']['path']) == value['source']['sha256'],
                    'Sealed held-out source changed; do not silently reseal or retune')
    return value


def build(args):
    frozen = selection()
    quality.require(quality.digest(REPO / frozen['oracle_models']['path']) == frozen['oracle_models']['sha256'],
                    'Private oracle models changed; do not silently reseal or retune')
    root = args.output.resolve()
    quality.require(not root.exists(), 'Use a new held-out build directory')
    root.mkdir(parents=True)
    root.chmod(0o700)
    source = (REPO / frozen['source']['path']).resolve()
    sdk = builder.execute(['/usr/bin/xcrun', '--show-sdk-path'], root)['stdout'].strip()
    quality.require(sdk == frozen['sdk'], f'SDK differs from the pinned {frozen["sdk"]}')
    tools = {}
    for name, pin in frozen['toolchain'].items():
        quality.require(quality.digest(Path(pin['path'])) == pin['sha256'], f'Toolchain pin mismatch: {name}')
        tools[name] = {'path': pin['path'], 'sha256': pin['sha256'],
                       'version': builder.execute([pin['path'], '--version'], root)['stdout']}
    compilers = {name: tools[name]['path'] for name in frozen['planned_matrix']['compiler_builds']}
    llvm = Path(tools['llvm-nm']['path']).parent
    lld = Path(tools['ld.lld']['path']).parent
    functions_selected = frozen['selected_functions']
    plan = {'schema': 1, 'root': str(root), 'selection': frozen,
            'selection_sha256': quality.digest(SELECTION),
            'tools': tools, 'sdk': sdk, 'cells': [],
            'method': {'target_execution': False, 'source_debug_types_supplied': False,
                       'selection': 'Compiler VA identically selected for both tools; no names/prototypes/annotations injected.',
                       'heldout_policy': frozen['separation'],
                       'limitations': 'Static-analysis recording is not behavioral-equivalence proof.'}}
    flags = ['-std=c11', '-g0', '-ffreestanding', '-fno-builtin', '-fno-stack-protector', '-ffp-contract=off']
    for target, triple in builder.TARGETS.items():
        for compiler, cc in compilers.items():
            for opt in frozen['planned_matrix']['optimizations']:
                name = f'{target}-{compiler}-{opt}'
                directory = root / name
                directory.mkdir()
                functions = [{**item, 'address': None} for item in functions_selected]
                commands, cells = [], []
                for symbols in frozen['planned_matrix']['symbols']:
                    cell = {'id': name + '-' + symbols, 'target': target, 'compiler': compiler,
                            'optimization': opt, 'symbols': symbols, 'functions': functions,
                            'commands': commands, 'target_executed': False}
                    cells.append(cell)
                    plan['cells'].append(cell)
                try:
                    obj = directory / 'heldout2.o'
                    commands.append(builder.execute([cc, '--target=' + triple, *flags, '-' + opt,
                        '-ffile-prefix-map=' + str(root) + '=.', '-c', str(source), '-o', str(obj)], directory))
                    binary = directory / ('symbols.exe' if target.startswith('pe') else 'symbols')
                    objects = [str(obj)]
                    if not target.startswith('macho'):
                        # Freestanding images have no libc: link the two callees as ordinary functions.
                        stubs = directory / 'libc-stubs.o'
                        commands.append(builder.execute([cc, '--target=' + triple, *flags, '-O0', '-DH2_STUBS_ONLY',
                            '-ffile-prefix-map=' + str(root) + '=.', '-c', str(source), '-o', str(stubs)], directory))
                        objects.append(str(stubs))
                    if target.startswith('macho'):
                        command = [cc, '--target=' + triple, '-isysroot', sdk, '-nostdlib',
                                   '-Wl,-e,_h2_entry', '-Wl,-no_uuid', *objects, '-lSystem', '-o', str(binary)]
                    elif target.startswith('pe'):
                        command = [str(lld / 'lld-link'), '/nodefaultlib', '/machine:x64', '/subsystem:console',
                                   '/entry:h2_entry', '/timestamp:0', '/debug:dwarf', '/opt:noref',
                                   '/base:0x140000000', '/out:' + str(binary), *objects]
                    else:
                        command = [str(lld / 'ld.lld'), '-m', 'elf_x86_64', '--build-id=none', '-z', 'noexecstack',
                                   '--entry=h2_entry', '--image-base=0x400000', '-o', str(binary), *objects]
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
    quality.require([cell['id'] for cell in plan['cells']] == frozen['cells'], 'Built cells differ from the selection cell list')
    return 0 if all(cell['status'] == 'built' for cell in plan['cells']) else 1


async def record(args):
    frozen = selection()
    args.inputs, args.output, args.entry = args.inputs.resolve(), args.output.resolve(), args.entry.resolve()
    quality.require(not args.output.exists() and not args.output.is_relative_to(Path('/tmp').resolve()), 'Use a new durable output directory')
    quality.require(not any(part.startswith('.') for part in args.output.parts), 'Ghidra needs non-hidden project paths')
    manifest = json.loads((args.inputs / 'build-manifest.json').read_text())
    quality.require(manifest['selection']['source']['sha256'] == frozen['source']['sha256'], 'Wrong held-out source build')
    quality.require([cell['id'] for cell in manifest['cells']] == frozen['cells'], 'Retain every planned held-out cell')
    expected_matched = len(manifest['cells']) * len(frozen['selected_functions'])
    original = json.loads((HERE / 'quality-inputs.json').read_text())
    commit = subprocess.check_output(['git', '-C', str(args.bridge), 'rev-parse', 'HEAD'], text=True).strip()
    quality.require(commit == original['ghidra']['bridge_commit'], 'Wrong bridge commit')
    quality.require(not subprocess.check_output(['git', '-C', str(args.bridge), 'status', '--porcelain', '--untracked-files=no'], text=True), 'Modified bridge source')
    quality.require('application.version=12.1.4' in (args.ghidra / 'Ghidra/application.properties').read_text().splitlines(), 'Wrong Ghidra version')
    result = {'schema': 1, 'purpose': 'Second sealed held-out equal-access recording, no tuning or parity claim',
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
        result['complete_recording'] = len(result['runs']) == 2 * len(manifest['cells']) and len(result['matched']) == expected_matched
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

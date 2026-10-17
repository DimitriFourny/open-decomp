#!/usr/bin/env python3
"""Build source-known analysis inputs; never launch the resulting binaries.

The complete Cartesian product is recorded, including failed cells. Compiler
and linker subprocesses are trusted development tools, not analyzed inputs.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import sys

sys.dont_write_bytecode = True
import quality

HERE = Path(__file__).resolve().parent
ARCHIVE = HERE / 'quality-matrix-zlib-1.3.1.tar.gz'
ZLIB_SHA256 = '9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23'
FUNCTIONS = [
    ('matrix_multi_exit', 'loop with break, continue and early return'),
    ('matrix_switch', 'dense switch; optimized lowering inspected in retained disassembly'),
    ('matrix_alias', 'possibly aliased read/write ordering'),
    ('matrix_aggregate', 'by-value mixed integer/FP aggregate input and return'),
    ('matrix_callback', 'indirect callback in loop with early exit'),
    ('matrix_variadic', 'ABI-specific double varargs and zero-count path'),
    ('matrix_mixed', 'mixed integer/double parameter banks and FP result'),
    ('matrix_variadic_call', 'mixed/variadic FP call sites'),
    ('matrix_checksum', 'calls to actual zlib checksum APIs'),
    ('adler32_z', 'unmodified zlib 1.3.1 Adler-32 library implementation'),
    ('crc32_z', 'unmodified zlib 1.3.1 CRC-32 library implementation'),
    ('crc32_combine', 'unmodified zlib polynomial checksum combination'),
]
TARGETS = {
    'macho-arm64': 'arm64-apple-macos13.0',
    'pe-x86_64': 'x86_64-pc-windows-msvc',
    'elf-x86_64': 'x86_64-unknown-linux-gnu',
}


def execute(command, directory):
    result = subprocess.run(command, cwd=directory, capture_output=True, text=True,
                            env=dict(os.environ, LC_ALL='C', SOURCE_DATE_EPOCH='0'))
    record = {'argv': command, 'exit_code': result.returncode,
              'stdout': result.stdout, 'stderr': result.stderr}
    if result.returncode:
        raise RuntimeError(json.dumps(record))
    return record


def identify(path):
    return {'path': str(path), 'bytes': path.stat().st_size, 'sha256': quality.digest(path)}


def build(args):
    args.output = args.output.resolve()
    quality.require(not args.output.exists(), 'Choose a new build output directory')
    quality.require(quality.digest(ARCHIVE) == ZLIB_SHA256, 'Reviewed zlib archive hash mismatch')
    args.output.mkdir(parents=True)
    source = args.output / 'source'
    source.mkdir()
    with tarfile.open(ARCHIVE) as archive:
        # Only source dependencies and original license are extracted. No build script is executed.
        needed = ['adler32.c', 'crc32.c', 'crc32.h', 'zutil.h', 'zlib.h', 'zconf.h', 'LICENSE']
        for name in needed:
            member = archive.extractfile(f'zlib-1.3.1/{name}')
            quality.require(member is not None, f'Missing reviewed upstream file {name}')
            (source / name).write_bytes(member.read())
    shutil.copyfile(HERE / 'quality-matrix-corpus.c', source / 'quality-matrix-corpus.c')
    shutil.copyfile(HERE.parent.parent / 'LICENSE', source / 'corpus-LICENSE')
    compilers = {'apple-clang21': str(args.apple_clang.resolve()),
                 'llvm-clang23': str(args.llvm_clang.resolve())}
    tools = {name: {'path': command, 'sha256': quality.digest(Path(command)),
                    'version': execute([command, '--version'], args.output)['stdout'].strip()}
             for name, command in compilers.items()}
    for name in ('ld.lld', 'lld-link', 'llvm-objcopy', 'llvm-nm', 'llvm-readobj', 'llvm-objdump'):
        path = (args.lld_bin if name in ('ld.lld', 'lld-link') else args.llvm_bin) / name
        tools[name] = {'path': str(path), 'sha256': quality.digest(path),
                       'version': execute([str(path), '--version'], args.output)['stdout'].strip()}
    sdk_discovery = execute(['/usr/bin/xcrun', '--show-sdk-path'], args.output)
    sdk = sdk_discovery['stdout'].strip()
    tools['macos_sdk'] = {'path': sdk, 'discovery': sdk_discovery}
    plan = {
        'schema': 1, 'purpose': 'P2.2 broader source-known static-analysis corpus; no correctness/ranking claim',
        'root': str(args.output),
        'source': {'corpus_license': 'MIT; repository LICENSE',
                   'zlib_version': '1.3.1', 'zlib_license': 'Zlib; original source/LICENSE retained verbatim',
                   'zlib_url': 'https://zlib.net/fossils/zlib-1.3.1.tar.gz',
                   'zlib_archive_sha256': ZLIB_SHA256,
                   'files': [identify(path) for path in sorted(source.iterdir())]},
        'tools': tools,
        'matrix': {'targets': list(TARGETS), 'compiler_variants': list(compilers),
                   'optimizations': ['O0', 'O2'], 'symbol_states': ['symbol-bearing', 'stripped'],
                   'expected_input_cells': 24, 'selected_functions_per_cell': len(FUNCTIONS)},
        'method': {
            'target_execution': False, 'source_or_sidecar_debug_types_supplied_to_decompilers': False,
            'symbol_selection': 'Exact VA from compiler symbol table of paired unstripped image, identically provided to both tools. Labels remain evidence-only, not injected annotations.',
            'stripping': 'Static/debug symbols removed, no exported fixture symbols. Function VAs inherited only after exact text-section byte equality is checked.',
            'library_configuration': 'Actual unmodified zlib adler32.c/crc32.c, supported Z_SOLO configuration; real checksum workload, not full deflate/inflate coverage.',
            'entry': 'matrix_entry is an analysis root, not platform process startup. No analyzed binary is executed.',
            'oracle_limits': 'Source known; no behavioral-equivalence or undefined-input/exceptional FP environment claim.'},
        'cells': []}
    quality.save(args.output / 'build-manifest.json', plan)
    for target, triple in TARGETS.items():
        for compiler, command in compilers.items():
            for optimization in ('O0', 'O2'):
                base = f'{target}-{compiler}-{optimization}'
                directory = args.output / base
                directory.mkdir()
                records = []
                functions = [{'name': name, 'address': None, 'category': category}
                             for name, category in FUNCTIONS]
                cell_pair = []
                for symbols in ('symbol-bearing', 'stripped'):
                    cell = {'id': base + '-' + symbols, 'target': target, 'compiler': compiler,
                            'optimization': optimization, 'symbols': symbols, 'commands': records,
                            'functions': functions, 'target_executed': False}
                    plan['cells'].append(cell)
                    cell_pair.append(cell)
                try:
                    common = [command, '--target=' + triple, '-std=c11', '-' + optimization,
                              '-g0', '-ffreestanding', '-fno-builtin', '-fno-stack-protector',
                              '-ffp-contract=off', '-DZ_SOLO', '-I' + str(source),
                              '-ffile-prefix-map=' + str(args.output) + '=.', '-c']
                    objects = []
                    for filename in ('quality-matrix-corpus.c', 'adler32.c', 'crc32.c'):
                        obj = directory / (filename + '.o')
                        records.append(execute([*common, str(source / filename), '-o', str(obj)], directory))
                        objects.append(str(obj))
                    binary = directory / ('symbols.exe' if target.startswith('pe') else 'symbols')
                    if target.startswith('pe'):
                        link = [str(args.lld_bin / 'lld-link'), '/nodefaultlib', '/machine:x64',
                                '/subsystem:console', '/entry:matrix_entry', '/timestamp:0',
                                '/debug:dwarf', '/opt:noref', '/base:0x140000000', '/out:' + str(binary), *objects]
                    elif target.startswith('elf'):
                        link = [str(args.lld_bin / 'ld.lld'), '-m', 'elf_x86_64', '--build-id=none',
                                '-z', 'noexecstack', '--entry=matrix_entry', '--image-base=0x400000',
                                '-o', str(binary), *objects]
                    else:
                        link = [command, '--target=' + triple, '-isysroot', sdk, '-nostdlib',
                                '-Wl,-e,_matrix_entry', '-Wl,-no_uuid',
                                '-o', str(binary), *objects, '-lSystem']
                    records.append(execute(link, directory))
                    nm = execute([str(args.llvm_bin / 'llvm-nm'), '--defined-only', '--format=posix', str(binary)], directory)
                    records.append(nm)
                    (directory / 'symbols.nm.txt').write_text(nm['stdout'])
                    addresses = {}
                    for line in nm['stdout'].splitlines():
                        fields = line.split()
                        if len(fields) >= 3 and fields[1].upper() == 'T':
                            addresses[fields[0].removeprefix('_')] = '0x' + fields[2]
                    for function in functions:
                        name = function['name']
                        quality.require(name in addresses, f'Compiler output has no selected symbol {name}')
                        function['address'] = addresses[name]
                    stripped = directory / ('stripped.exe' if target.startswith('pe') else 'stripped')
                    shutil.copyfile(binary, stripped)
                    strip = (['/usr/bin/strip', str(stripped)] if target.startswith('macho') else
                             [str(args.llvm_bin / 'llvm-objcopy'), '--strip-all', str(stripped)])
                    records.append(execute(strip, directory))
                    for cell, path in zip(cell_pair, (binary, stripped)):
                        metadata = execute([str(args.llvm_bin / 'llvm-readobj'), '--file-headers', '--sections', '--symbols', str(path)], directory)
                        (directory / (cell['symbols'] + '.metadata.txt')).write_text(metadata['stdout'])
                        disasm = execute([str(args.llvm_bin / 'llvm-objdump'), '--disassemble', str(path)], directory)
                        (directory / (cell['symbols'] + '.disassembly.txt')).write_text(disasm['stdout'])
                        # Removing symbols must not change the actual text bytes or selected VAs.
                        text = directory / (cell['symbols'] + '.text.bin')
                        section = '__TEXT,__text' if target.startswith('macho') else '.text'
                        records.append(execute([str(args.llvm_bin / 'llvm-objcopy'),
                                                '--dump-section=' + section + '=' + str(text), str(path)], directory))
                        cell.update({'status': 'built', 'input': identify(path),
                                     'text': identify(text), 'metadata': identify(directory / (cell['symbols'] + '.metadata.txt')),
                                     'disassembly': identify(directory / (cell['symbols'] + '.disassembly.txt'))})
                    quality.require(cell_pair[0]['text']['sha256'] == cell_pair[1]['text']['sha256'],
                                    'Stripping changed selected code bytes; address pairing invalid')
                    stripped_nm = execute([str(args.llvm_bin / 'llvm-nm'), '--defined-only', str(stripped)], directory)
                    records.append(stripped_nm)
                    quality.require(not any(name in stripped_nm['stdout'] for name, _ in FUNCTIONS),
                                    'Stripped image still exposes selected static symbol names')
                except Exception as error:
                    for cell in cell_pair:
                        cell['status'] = 'build_failed'
                        cell['error'] = repr(error)
                quality.save(args.output / 'build-manifest.json', plan)
                print(json.dumps({'configuration': base, 'states': [cell['status'] for cell in cell_pair]}), flush=True)
    # Inputs + source + provenance are durable, independently hash-addressed artifacts.
    return 0 if all(cell['status'] == 'built' for cell in plan['cells']) else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--apple-clang', type=Path, default=Path('/usr/bin/clang'))
    parser.add_argument('--llvm-clang', type=Path, default=Path('/opt/homebrew/opt/llvm/bin/clang'))
    parser.add_argument('--llvm-bin', type=Path, default=Path('/opt/homebrew/opt/llvm/bin'))
    parser.add_argument('--lld-bin', type=Path, default=Path('/opt/homebrew/opt/lld/bin'))
    return build(parser.parse_args())


if __name__ == '__main__':
    sys.exit(main())

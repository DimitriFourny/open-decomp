#!/usr/bin/env python3
"""Compile exact recorded C text plus real scalar typedefs and a trusted driver.

No generated-code repair is performed. Uncompilable pseudocode/interfaces remain
explicitly unverified. Only outputs of the frozen trusted-source held-out suite
may enter this developer harness; never use it on arbitrary analyzed programs.
"""
import argparse
from collections import Counter
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import types

sys.dont_write_bytecode = True
import quality

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('heldout_oracle', HERE / 'quality-heldout-oracle.py')
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)

HEADER = '''#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
typedef unsigned char byte;
typedef unsigned short ushort;
typedef unsigned int uint;
typedef long long longlong;
typedef unsigned long long ulonglong;
typedef uint8_t undefined;
typedef uint8_t undefined1;
typedef uint16_t undefined2;
typedef uint32_t undefined4;
typedef uint64_t undefined8;
typedef __uint128_t uint128_t;
typedef __int128 int128_t;
typedef uint8_t unaligned_uint8_t __attribute__((aligned(1),may_alias));
typedef uint16_t unaligned_uint16_t __attribute__((aligned(1),may_alias));
typedef uint32_t unaligned_uint32_t __attribute__((aligned(1),may_alias));
typedef uint64_t unaligned_uint64_t __attribute__((aligned(1),may_alias));
typedef int8_t unaligned_int8_t __attribute__((aligned(1),may_alias));
typedef int16_t unaligned_int16_t __attribute__((aligned(1),may_alias));
typedef int32_t unaligned_int32_t __attribute__((aligned(1),may_alias));
typedef int64_t unaligned_int64_t __attribute__((aligned(1),may_alias));
'''
CONTRACTS = {
 'heldout_roll': ('uint64_t', ['const uint8_t *', 'uint32_t', 'uint32_t', 'uint8_t']),
 'heldout_runs': ('uint32_t', ['const uint8_t *', 'uint32_t', 'uint8_t *', 'uint32_t']),
 'heldout_merge': ('void', ['uint32_t *', 'const uint32_t *', 'uint32_t', 'const uint32_t *', 'uint32_t']),
 'heldout_saturate': ('uint32_t', ['uint16_t *', 'uint32_t', 'uint16_t']),
 'heldout_weighted': ('double', ['const double *', 'const double *', 'uint32_t']),
}


def worker(args):
    import ctypes
    library = ctypes.CDLL(str(args.library))
    proxy = types.SimpleNamespace(**{args.function: library.verify_target})
    cases = [case for case in oracle.cases() if case['function'] == args.function]
    observations = []
    for index, case in enumerate(cases):
        print(json.dumps({'starting_case': index}), flush=True)
        actual = oracle.native(proxy, case)
        expected = oracle.reference(case)
        observations.append({'case': index, 'input': case, 'expected': expected,
                             'actual': actual, 'matches': actual == expected})
    print(json.dumps({'observations': observations}), flush=True)
    return 0


def wrapper(text, function):
    # Parse only the declaration for a positional caller adapter. The source text
    # itself is retained verbatim; unsupported declarations are not repaired.
    clean = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    match = re.search(r'([A-Za-z_]\w*)\s*\(([^()]*)\)\s*\{', clean)
    if not match:
        raise ValueError('No supported plain C function declaration')
    name, parameters = match.groups()
    params = [] if parameters.strip() in ('', 'void') else parameters.split(',')
    return_type, source_types = CONTRACTS[function]
    if len(params) != len(source_types):
        raise ValueError(f'Recovered interface has {len(params)} inputs; source has {len(source_types)}')
    actual_types = []
    for param in params:
        formal = re.fullmatch(r'\s*([A-Za-z_][\w\s*]*?)\s+([A-Za-z_]\w*)\s*', param)
        if not formal:
            # Ghidra often attaches the pointer star to the parameter name.
            formal = re.fullmatch(r'\s*([A-Za-z_][\w\s]*\*)\s*([A-Za-z_]\w*)\s*', param)
        if not formal:
            raise ValueError('Unsupported C parameter declaration: ' + param)
        if formal.group(2).startswith('entry_'):
            raise ValueError('Explicit machine-entry storage/state input is outside the source-ABI positional executable subset')
        actual_types.append(formal.group(1).strip())
    arguments = []
    for index, (source_type, actual_type) in enumerate(zip(source_types, actual_types)):
        argument = f'a{index}'
        if '*' in source_type and '*' not in actual_type:
            argument = '(uintptr_t)' + argument
        arguments.append(f'({actual_type})({argument})')
    prototype = ', '.join(f'{kind} a{index}' for index, kind in enumerate(source_types))
    call = f'{name}({", ".join(arguments)})'
    statement = call + ';' if return_type == 'void' else 'return ' + call + ';'
    return f'\n{return_type} verify_target({prototype}) {{ {statement} }}\n'


def evaluate(args):
    result = json.loads((args.results / 'comparison.json').read_text())
    frozen = json.loads((HERE / 'quality-heldout-selection.json').read_text())
    quality.require(result['build_manifest']['selection']['source']['sha256'] == frozen['source']['sha256'], 'Only frozen trusted held-out outputs are authorized')
    args.output.mkdir(parents=True, exist_ok=False)
    records = []
    quality.save(args.output / 'helper-definitions.json', {'header': HEADER,
                 'contracts': CONTRACTS, 'source_sha256': frozen['source']['sha256'],
                 'policy': 'Exact emitted text compiled unchanged. Scalar aliases have explicit real widths; no unknown/helper/no-op fallback. PE plain long rejected because host C long width differs.'})
    for run in result['runs']:
        for row in run['functions']:
            record = {'cell': run['cell'], 'tool': run['tool'], 'function': row['name'],
                      'status': 'unverified', 'output_state': row['status']}
            records.append(record)
            if row['status'] != 'text_returned':
                record['reason'] = 'No emitted source text'
                continue
            original = args.results / row['output']['path']
            quality.require(quality.digest(original) == row['output']['sha256'], 'Recorded emitted text changed')
            record['emitted_sha256'] = row['output']['sha256']
            text = original.read_text()
            # C keyword long has a different target data model on Windows.
            if run['target'].startswith('pe') and re.search(r'\blong\b', text):
                record['reason'] = 'Target plain-long data model not host-executable without rewriting'
                continue
            directory = args.output / run['cell'] / run['tool'] / row['name']
            directory.mkdir(parents=True)
            try:
                adapter = wrapper(text, row['name'])
            except ValueError as error:
                record['reason'] = str(error)
                continue
            source = directory / 'exact-output-with-driver.c'
            # Identity line directives do not change statements or helper calls.
            header = HEADER + ('typedef uint32_t ulong;\n' if run['target'].startswith('pe') else 'typedef uint64_t ulong;\n')
            source.write_text(header + '\n#line 1 "recorded-output.c"\n' + text + '\n' + adapter)
            library = directory / 'output.dylib'
            command = ['/usr/bin/clang', '-dynamiclib', '-std=c11', '-O0', '-ffp-contract=off',
                       '-Werror=implicit-function-declaration', '-Werror=int-conversion',
                       str(source), '-o', str(library)]
            compiled = subprocess.run(command, capture_output=True, text=True, timeout=30)
            quality.save(directory / 'compile.json', {'argv': command, 'exit_code': compiled.returncode,
                         'stdout': compiled.stdout, 'stderr': compiled.stderr})
            if compiled.returncode:
                record['reason'] = 'Exact emitted C outside executable subset; compiler diagnostics retained'
                continue
            command = [sys.executable, str(Path(__file__).resolve()), 'worker', '--library', str(library), '--function', row['name']]
            try:
                observed = subprocess.run(command, capture_output=True, text=True, timeout=10)
                (directory / 'worker.stdout.jsonl').write_text(observed.stdout)
                (directory / 'worker.stderr.txt').write_text(observed.stderr)
                record['worker_exit_code'] = observed.returncode
                if observed.returncode:
                    record.update({'status': 'runtime_fault', 'reason': 'Isolated executable-output worker failed; last starting-case marker retained'})
                    continue
                observations = json.loads(observed.stdout.splitlines()[-1])['observations']
                record.update({'status': 'cases_passed' if all(case['matches'] for case in observations) else 'counterexample',
                               'passed': sum(case['matches'] for case in observations), 'total': len(observations),
                               'observations': observations, 'library_sha256': quality.digest(library)})
            except subprocess.TimeoutExpired:
                record.update({'status': 'execution_timeout', 'reason': 'Bounded isolated output execution did not terminate'})
            quality.save(args.output / 'correctness.json', {'records': records})
    report = {'scope': 'Actual exact emitted-C executable subset versus independent source-derived oracles; finite cases only',
              'gold_only_is_not_engine_correctness': True, 'target_binaries_executed': False,
              'evaluator_sha256': quality.digest(Path(__file__)), 'oracle_sha256': quality.digest(HERE / 'quality-heldout-oracle.py'),
              'limitations': ['Unsupported pseudocode/helpers/interfaces are unverified, not repaired or treated as passing.',
                             'Host execution of explicit scalar subset only; PE long data-model differences excluded.',
                             'Finite case agreement is not whole-program or all-input equivalence.',
                             'Cases compare return values, destination bytes and write guard bytes; do not establish absence of every extra read.'],
              'summary': {tool: dict(Counter(record['status'] for record in records if record['tool'] == tool)) for tool in ('open-decomp', 'ghidra')},
              'records': records}
    quality.save(args.output / 'correctness.json', report)
    print(json.dumps(report['summary']))
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    run = commands.add_parser('run')
    run.add_argument('--results', type=Path, required=True)
    run.add_argument('--output', type=Path, required=True)
    work = commands.add_parser('worker')
    work.add_argument('--library', type=Path, required=True)
    work.add_argument('--function', choices=list(CONTRACTS), required=True)
    args = parser.parse_args()
    return worker(args) if args.command == 'worker' else evaluate(args)


if __name__ == '__main__':
    sys.exit(main())

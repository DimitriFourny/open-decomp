#!/usr/bin/env python3
"""Independent Python models versus trusted source-built native held-out functions.

Only freshly compiled dylibs from the frozen reviewed C source are loaded. Never
load or execute an analyzed matrix image. These checks establish oracle cases,
not equivalence of either decompiler's generated text.
"""
import argparse
import ctypes as C
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import random
import subprocess
import sys

sys.dont_write_bytecode = True
import quality

HERE = Path(__file__).resolve().parent
MASK = (1 << 32) - 1


def cases():
    rng = random.Random(0x62F19)
    output = []
    for data, seed, stop in [(list(b'abc'), 0, 0), ([], MASK, 0), ([7, 0, 9], MASK, 0),
                             ([255] * 260, 0x80000000, 17)]:
        output.append({'function': 'heldout_roll', 'data': data, 'seed': seed, 'stop': stop})
    for data, capacity in [([], 0), ([7], 0), ([7], 1), ([7], 2), ([1, 2, 3], 4),
                           ([5] * 256, 4), ([5] * 256, 3)]:
        output.append({'function': 'heldout_runs', 'data': data, 'capacity': capacity})
    for left, right in [([], []), ([1, 3], []), ([], [2]), ([1, 1, 8], [1, 2, 8]),
                         ([0, MASK], [0, 1, MASK])]:
        output.append({'function': 'heldout_merge', 'left': left, 'right': right})
    for values, delta in [([], 0), ([0, 1, 65534, 65535], 1), ([1, 2], 0), ([0, 1], 65535)]:
        output.append({'function': 'heldout_saturate', 'values': values, 'delta': delta})
    for values, weights in [([], []), ([2, 4], [0, -1]), ([2, 4], [1, 1]), ([1, 9, 3], [2, 0, 4])]:
        output.append({'function': 'heldout_weighted', 'values': values, 'weights': weights})
    for _ in range(32):
        data = [rng.randrange(256) for _ in range(rng.randrange(32))]
        output.append({'function': 'heldout_roll', 'data': data, 'seed': rng.randrange(1 << 32), 'stop': rng.randrange(256)})
        output.append({'function': 'heldout_runs', 'data': [rng.randrange(4) for _ in range(rng.randrange(40))],
                       'capacity': rng.randrange(60)})
        output.append({'function': 'heldout_merge', 'left': sorted(rng.randrange(32) for _ in range(rng.randrange(20))),
                       'right': sorted(rng.randrange(32) for _ in range(rng.randrange(20)))})
        output.append({'function': 'heldout_saturate', 'values': [rng.randrange(65536) for _ in range(rng.randrange(32))],
                       'delta': rng.randrange(65536)})
        n = rng.randrange(24)
        output.append({'function': 'heldout_weighted', 'values': [rng.randrange(-128, 129) / 4 for _ in range(n)],
                       'weights': [rng.choice([-1, 0, 1, 2, 4]) for _ in range(n)]})
    return output


def reference(case):
    name = case['function']
    if name == 'heldout_roll':
        prefix = case['data'][:case['data'].index(case['stop'])] if case['stop'] in case['data'] else case['data']
        checksum = case['seed']
        for byte in prefix:
            checksum = (((checksum << 5) & MASK) | (checksum >> 27)) ^ byte
        return {'return': (len(prefix) << 32) | checksum}
    if name == 'heldout_runs':
        # Independent grouping, not the source's nested increment loop.
        from itertools import groupby
        encoded = []
        for value, group in groupby(case['data']):
            remaining = len(list(group))
            while remaining:
                length = min(255, remaining)
                encoded.extend([length, value])
                remaining -= length
        capacity = case['capacity']
        copied = encoded[:(capacity // 2) * 2]
        memory = [0xA5] * (capacity + 4)
        memory[2:2 + len(copied)] = copied
        return {'return': len(encoded) if len(encoded) <= capacity else MASK, 'memory': memory}
    if name == 'heldout_merge':
        return {'memory': [0xA5A5A5A5] + sorted(case['left'] + case['right']) + [0xA5A5A5A5]}
    if name == 'heldout_saturate':
        values = [min(65535, value + case['delta']) for value in case['values']]
        return {'return': sum(left != right for left, right in zip(case['values'], values)),
                'memory': [0xA5A5] + values + [0xA5A5]}
    pairs = [(Fraction(value), Fraction(weight)) for value, weight in zip(case['values'], case['weights']) if weight > 0]
    weight = sum((pair[1] for pair in pairs), Fraction(0))
    exact = sum((value * w for value, w in pairs), Fraction(0)) / weight if weight else Fraction(0)
    return {'return': float(exact)}


def native(lib, case):
    name = case['function']
    function = getattr(lib, name)
    if name == 'heldout_roll':
        function.argtypes, function.restype = [C.POINTER(C.c_ubyte), C.c_uint, C.c_uint, C.c_ubyte], C.c_ulonglong
        data = (C.c_ubyte * max(1, len(case['data'])))(*case['data'])
        return {'return': function(data, len(case['data']), case['seed'], case['stop'])}
    if name == 'heldout_runs':
        function.argtypes, function.restype = [C.POINTER(C.c_ubyte), C.c_uint, C.POINTER(C.c_ubyte), C.c_uint], C.c_uint
        data = (C.c_ubyte * max(1, len(case['data'])))(*case['data'])
        output = (C.c_ubyte * (case['capacity'] + 4))(*([0xA5] * (case['capacity'] + 4)))
        pointer = C.cast(C.byref(output, 2), C.POINTER(C.c_ubyte))
        result = function(data, len(case['data']), pointer, case['capacity'])
        return {'return': result, 'memory': list(output)}
    if name == 'heldout_merge':
        function.argtypes, function.restype = [C.POINTER(C.c_uint), C.POINTER(C.c_uint), C.c_uint, C.POINTER(C.c_uint), C.c_uint], None
        left = (C.c_uint * max(1, len(case['left'])))(*case['left'])
        right = (C.c_uint * max(1, len(case['right'])))(*case['right'])
        output = (C.c_uint * (len(case['left']) + len(case['right']) + 2))(*([0xA5A5A5A5] * (len(case['left']) + len(case['right']) + 2)))
        function(C.cast(C.byref(output, 4), C.POINTER(C.c_uint)), left, len(case['left']), right, len(case['right']))
        return {'memory': list(output)}
    if name == 'heldout_saturate':
        function.argtypes, function.restype = [C.POINTER(C.c_ushort), C.c_uint, C.c_ushort], C.c_uint
        output = (C.c_ushort * (len(case['values']) + 2))(0xA5A5, *case['values'], 0xA5A5)
        result = function(C.cast(C.byref(output, 2), C.POINTER(C.c_ushort)), len(case['values']), case['delta'])
        return {'return': result, 'memory': list(output)}
    function.argtypes, function.restype = [C.POINTER(C.c_double), C.POINTER(C.c_double), C.c_uint], C.c_double
    values = (C.c_double * max(1, len(case['values'])))(*case['values'])
    weights = (C.c_double * max(1, len(case['weights'])))(*case['weights'])
    return {'return': function(values, weights, len(case['values']))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    frozen = json.loads((HERE / 'quality-heldout-selection.json').read_text())
    source = HERE / 'quality-heldout-corpus.c'
    quality.require(quality.digest(source) == frozen['source']['sha256'], 'Held-out source changed')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    vectors = cases()
    expected = [{**case, 'expected': reference(case)} for case in vectors]
    quality.save(output / 'source-oracle-cases.json', expected)
    record = {'source_sha256': quality.digest(source), 'oracle_sha256': quality.digest(Path(__file__)),
              'scope': 'Source-oracle validation only; not decompiled-output correctness',
              'valid_input_contract': frozen['valid_input_contract'], 'analyzed_input_executed': False,
              'native_execution': 'Only fresh dylibs compiled here from the frozen trusted C source', 'runs': []}
    for compiler, cc in [('apple-clang21', '/usr/bin/clang'), ('llvm-clang23', '/opt/homebrew/opt/llvm/bin/clang')]:
        for opt in ('O0', 'O2'):
            library = output / (compiler + '-' + opt + '.dylib')
            command = [cc, '-dynamiclib', '-std=c11', '-' + opt, '-ffp-contract=off', '-fno-builtin',
                       '-fno-stack-protector', str(source), '-o', str(library)]
            compiled = subprocess.run(command, text=True, capture_output=True)
            quality.require(compiled.returncode == 0, compiled.stderr)
            lib = C.CDLL(str(library))
            observations = []
            for index, case in enumerate(vectors):
                actual = native(lib, case)
                observations.append({'case': index, 'actual': actual, 'matches': actual == expected[index]['expected']})
            run = {'compiler': compiler, 'optimization': opt, 'command': command,
                   'library_sha256': quality.digest(library), 'observations': observations,
                   'passed': sum(item['matches'] for item in observations), 'total': len(observations)}
            record['runs'].append(run)
            quality.save(output / 'oracle-results.json', record)
            print(json.dumps({key: run[key] for key in ('compiler', 'optimization', 'passed', 'total')}))
    record['all_passed'] = all(run['passed'] == run['total'] for run in record['runs'])
    quality.save(output / 'oracle-results.json', record)
    return 0 if record['all_passed'] else 1


if __name__ == '__main__':
    sys.exit(main())

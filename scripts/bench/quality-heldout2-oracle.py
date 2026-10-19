#!/usr/bin/env python3
"""Source-built native oracle for the second sealed held-out suite.

Only freshly compiled dylibs from the private reviewed C source are loaded; never
load or execute an analyzed image. The reference models, valid-input contract,
vector generator and ctypes bindings live in a private file pinned by SHA256 in
quality-heldout2-selection.json; this script is the generic harness around it and
also exposes cases/reference/native for quality-heldout2-evaluate.py. These
checks establish oracle cases, not equivalence of any decompiler's generated text.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

sys.dont_write_bytecode = True
import quality

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SELECTION = HERE / 'quality-heldout2-selection.json'


def selection():
    return json.loads(SELECTION.read_text())


_MODELS = []


def models():
    if not _MODELS:
        frozen = selection()
        path = REPO / frozen['oracle_models']['path']
        quality.require(quality.digest(path) == frozen['oracle_models']['sha256'],
                        'Private oracle models changed; do not silently reseal or retune')
        spec = importlib.util.spec_from_file_location('heldout2_models', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _MODELS.append(module)
    return _MODELS[0]


def cases():
    return models().cases()


def reference(case):
    return models().reference(case)


def native(lib, case):
    return models().native(lib, case)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    frozen = selection()
    source = REPO / frozen['source']['path']
    quality.require(quality.digest(source) == frozen['source']['sha256'], 'Sealed source changed')
    import ctypes as C
    module = models()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    vectors = module.cases()
    expected = [{**case, 'expected': module.reference(case)} for case in vectors]
    quality.save(output / 'source-oracle-cases.json', expected)
    per_function = {}
    for case in vectors:
        per_function[case['function']] = per_function.get(case['function'], 0) + 1
    quality.require(set(per_function) == {item['name'] for item in frozen['selected_functions']},
                    'Vectors do not cover exactly the selected functions')
    record = {'schema': 1, 'source_sha256': quality.digest(source), 'models_sha256': quality.digest(Path(module.__file__)),
              'oracle_sha256': quality.digest(Path(__file__)), 'selection_sha256': quality.digest(SELECTION),
              'scope': 'Source-oracle validation only; not decompiled-output correctness',
              'valid_input_contract': module.CONTRACT, 'vectors_per_function': per_function, 'total_vectors': len(vectors),
              'cases_sha256': quality.digest(output / 'source-oracle-cases.json'), 'analyzed_input_executed': False,
              'native_execution': 'Only fresh dylibs compiled here from the private trusted C source', 'runs': []}
    configurations = [(compiler, cc, opt, [])
                      for compiler, cc in [('apple-clang21', frozen['toolchain']['apple-clang21']['path']),
                                           ('llvm-clang23', frozen['toolchain']['llvm-clang23']['path'])]
                      for opt in ('O0', 'O2')]
    # Trap-mode UBSan pass: any undefined behavior on a vector aborts the run instead of matching silently.
    configurations.append(('apple-clang21', frozen['toolchain']['apple-clang21']['path'], 'O1',
                           ['-fsanitize=undefined', '-fsanitize-trap=undefined']))
    for compiler, cc, opt, extra in configurations:
        label = compiler + '-' + opt + ('-ubtrap' if extra else '')
        library = output / (label + '.dylib')
        command = [cc, '-dynamiclib', '-std=c11', '-' + opt, '-ffp-contract=off', '-fno-builtin',
                   '-fno-stack-protector', *extra, str(source), '-o', str(library)]
        compiled = subprocess.run(command, text=True, capture_output=True)
        quality.require(compiled.returncode == 0, compiled.stderr)
        lib = C.CDLL(str(library))
        observations = []
        for index, case in enumerate(vectors):
            actual = module.native(lib, case)
            observations.append({'case': index, 'actual': actual, 'matches': actual == expected[index]['expected']})
        run = {'label': label, 'compiler': compiler, 'optimization': opt, 'command': command[:-3] + ['<private source>', '-o', command[-1]],
               'library_sha256': quality.digest(library), 'observations': observations,
               'passed': sum(item['matches'] for item in observations), 'total': len(observations)}
        record['runs'].append(run)
        quality.save(output / 'oracle-results.json', record)
        print(json.dumps({key: run[key] for key in ('label', 'passed', 'total')}))
    record['all_passed'] = all(run['passed'] == run['total'] for run in record['runs'])
    quality.save(output / 'oracle-results.json', record)
    quality.save(output / 'gold-hash.json', {'cases_sha256': record['cases_sha256'], 'results_sha256': quality.digest(output / 'oracle-results.json'),
                                             'total_vectors': len(vectors), 'vectors_per_function': per_function,
                                             'all_passed': record['all_passed']})
    print(json.dumps({'cases_sha256': record['cases_sha256'], 'total_vectors': len(vectors),
                      'vectors_per_function': per_function, 'all_passed': record['all_passed']}))
    return 0 if record['all_passed'] else 1


if __name__ == '__main__':
    sys.exit(main())

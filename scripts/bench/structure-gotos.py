#!/usr/bin/env python3
"""Structuring sample: printed control constructs per function for one build.

A fixed development sample (not held out): the brotli CLI, three SQLite name
filters and the Mach-O / ELF fixture libraries, exported with `open-decomp
export` (c-like source view). Analyzed binaries are never executed.

  run      export the sample with one build into OUT/LABEL
  metrics  totals per label, then per-function goto changes between the first
           label and each later one

Counts come from the printed text: `goto` statements, labels, `do { } while
(0)` blocks, `while (true)`, `for` loops and loops with a test (`while (c)`,
`do { } while (c)`, `for`).
"""
import argparse
from collections import Counter
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SQLITE = REPO / '.local/performance/quality-reviewed/inputs/sqlite3-arm64'
SAMPLE = (
    ('brotli', Path('/opt/homebrew/bin/brotli'), ()),
    ('sqlite-btree', SQLITE, ('--name', 'btree')),
    ('sqlite-vdbe', SQLITE, ('--name', 'vdbemem')),
    ('sqlite-expr', SQLITE, ('--name', 'exprcode')),
    ('macho', REPO / 'fixtures/bin/macho-arm64-symbols', ()),
    ('elf', REPO / 'fixtures/bin/libcorpus-elf-x86_64-symbols.so', ()),
)
KEYS = ('gotos', 'labels', 'breakable', 'while_true', 'for', 'tested')
KEYWORDS = {'default', 'case', 'public', 'private'}


def count(text: str) -> Counter:
    result = Counter()
    result['gotos'] = len(re.findall(r'\bgoto\s+\w+\s*;', text))
    result['labels'] = sum(
        1 for name in re.findall(r'^\s*([A-Za-z_]\w*):(?!:)', text, re.M) if name not in KEYWORDS
    )
    result['breakable'] = len(re.findall(r'\}\s*while\s*\(\s*0\s*\)\s*;', text))
    result['while_true'] = len(re.findall(r'\bwhile\s*\(\s*(?:true|1)\s*\)', text))
    result['for'] = len(re.findall(r'^\s*for\s*\(', text, re.M))
    whiles = len(re.findall(r'\bwhile\s*\(', text))
    result['tested'] = whiles - result['breakable'] - result['while_true'] + result['for']
    return result


def functions(root: Path) -> dict[str, Counter]:
    result = {}
    for path in sorted(root.glob('*/functions/*.c')):
        result[f'{path.parent.parent.name}/{path.stem}'] = count(path.read_text(errors='replace'))
    return result


def run(args: argparse.Namespace) -> None:
    out = Path(args.out) / args.label
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    for name, binary, extra in SAMPLE:
        cache = out / f'.cache-{name}'
        command = ['node', args.entry, 'export', str(binary), '--out', str(out / name), '--jobs', str(args.jobs), '--cache', str(cache), *extra]
        with open(out / f'{name}.log', 'w') as log:
            code = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT).returncode
        shutil.rmtree(cache, ignore_errors=True)
        if code:
            print(f'{name}: export failed ({code}), see {out / name}.log', file=sys.stderr)
    metrics(argparse.Namespace(out=args.out, label=[args.label], all=False))


def metrics(args: argparse.Namespace) -> None:
    tables = {label: functions(Path(args.out) / label) for label in args.label}
    common = set.intersection(*(set(table) for table in tables.values()))
    print('label'.ljust(28) + ''.join(key.rjust(11) for key in ('functions', *KEYS, 'with_goto')))
    for label, table in tables.items():
        for suffix, names in (('', table.keys()), (' (common)', common)):
            if suffix and len(common) == len(table):
                continue
            total = sum((table[name] for name in names), Counter())
            with_goto = sum(1 for name in names if table[name]['gotos'])
            print((label + suffix).ljust(28) + str(len(names)).rjust(11) + ''.join(str(total[key]).rjust(11) for key in KEYS) + str(with_goto).rjust(11))
    first, *rest = args.label
    for label in rest:
        print(f'\n{first} -> {label}: functions whose gotos or loop forms changed')
        old, new = tables[first], tables[label]
        rows = []
        for name in sorted(set(old) | set(new)):
            a, b = old.get(name, Counter()), new.get(name, Counter())
            if any(a[key] != b[key] for key in ('gotos', 'for')) or args.all and a != b:
                rows.append((b['gotos'] - a['gotos'], name, a, b))
        for delta, name, a, b in sorted(rows, key=lambda row: (-row[0], row[1])):
            print(f'  {delta:+4d}  {name}: gotos {a["gotos"]} -> {b["gotos"]}, for {a["for"]} -> {b["for"]}')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--out', default=os.environ.get('STRUCTURE_GOTOS_OUT', '/tmp/structure-gotos'))
    commands = parser.add_subparsers(dest='command', required=True)
    run_parser = commands.add_parser('run')
    run_parser.add_argument('--entry', required=True)
    run_parser.add_argument('--label', required=True)
    run_parser.add_argument('--jobs', type=int, default=2)
    run_parser.set_defaults(handler=run)
    metrics_parser = commands.add_parser('metrics')
    metrics_parser.add_argument('--label', action='append', required=True)
    metrics_parser.add_argument('--all', action='store_true', help='also list functions whose other counts changed')
    metrics_parser.set_defaults(handler=metrics)
    args = parser.parse_args()
    args.handler(args)


if __name__ == '__main__':
    main()

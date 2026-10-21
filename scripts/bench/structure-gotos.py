#!/usr/bin/env python3
"""Structuring sample: printed control constructs per function for one build.

A fixed development sample (not held out): the brotli CLI, three SQLite name
filters and the Mach-O / ELF fixture libraries, exported with `open-decomp
export` (c-like source view). Ghidra decompiles the same functions as a second
lane. Analyzed binaries are never executed (Ghidra only loads them).

  run      export the sample with one build into OUT/LABEL
  ghidra   decompile the same functions with Ghidra headless into OUT/LABEL
           (function lists come from an Open Decomp export, `--from`, or from
           `*.list` files, `--lists`); needs GHIDRA_INSTALL_DIR and JAVA_HOME
  metrics  one column per label (Open Decomp builds, optionally `--ghidra`),
           then per-function changes between the first label and each later
           one and, with `--ghidra`, the functions furthest from Ghidra

Both lanes write OUT/LABEL/SAMPLE/functions/NAME@ADDR.c. A label is a
directory name under OUT, or NAME=DIR to read an existing directory (also the
flat layout DIR/SAMPLE/*.c; sample directories `sqlite-*` are one sample).

Counts come from the printed text (comments and string literals removed):
`goto`, `break`, `continue`, exit flags (`loop_exit_N` variables) and `do { }
while (0)` blocks (jump statements together), `while (true)`, `for`, `else
if`, comma conditions (`if (x = f(), x != 0)`), non-blank lines, bytes by part
(everything before the signature, `entry_sp` lines, local declarations at the
top of the body, comments, `unknown_*` / `requirement_predicate` / `physical_*`
uncertainty helpers, other = statements and control flow), call lines ending in
`, ...)`, 64-bit values rebuilt from two 32-bit cells (`x | ((uint64_t)y << 32)`)
and functions with a goto. A line is counted in the first part that matches in
the order above (comments, preamble, entry_sp, helpers, declarations, other).
"""
import argparse
from collections import Counter
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

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
GHIDRA_SCRIPT = HERE / 'ghidra-decompile-list.java'
GHIDRA_CLASS = 'DecompileList'  # Ghidra needs the Java class name to equal the script file name

NOISE = re.compile(r'/\*.*?\*/|//[^\n]*|"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'', re.S)
NOT_BODY = re.compile(r'(?:typedef|struct|union|enum|extern|static|inline|#)')
DECLARATION = re.compile(
    r'\s+(?!(?:return|goto|break|continue|else|case|default|do|typedef|throw)\b)'
    r'[A-Za-z_][\w \t]*?[ \t*]+\w+[ \t]*(?:\[[^\]\n]*\][ \t]*)*;\s*'
)
HELPER = re.compile(r'\b(?:unknown_\w+|requirement_predicate|physical_\w+)\b')
ENTRY_SP = re.compile(r'\bentry_sp\b')
OPEN_CALL = re.compile(r',\s*\.\.\.\)')
# `x | ((uint64_t)y << 32)`: a 64-bit value rebuilt from two 32-bit cells
CELL64 = re.compile(r'\|\s*\(\s*\(\s*uint64_t\s*\)\s*[A-Za-z_]\w*\s*<<\s*32\s*\)')
EXIT_FLAG = re.compile(r'\bloop_exit_\d+\b')
PARTS = ('preamble', 'entry_sp', 'decls', 'comments', 'helpers', 'other')


def blank(match: re.Match) -> str:
    text = match.group(0)
    if text[0] in '"\'':
        return text[0] * 2
    return re.sub(r'[^\n]', ' ', text)


def comma_conditions(code: str) -> int:
    """`if` / `while` conditions holding a comma operator, e.g. `(x = f(), x != 0)`."""
    found = 0
    for match in re.finditer(r'\b(?:if|while)\s*\(', code):
        groups = [True]  # innermost open group may hold a comma operator (False: call arguments)
        for index in range(match.end(), len(code)):
            char = code[index]
            if char == '(':
                before = code[:index].rstrip()[-1:]
                groups.append(not (before.isalnum() or before in '_)]'))
            elif char == ')':
                groups.pop()
                if not groups:
                    break
            elif char == ',' and groups[-1]:
                found += 1
                break
            elif char in ';{}':
                break
    return found


def signature_lines(clean: list[str]) -> tuple[int, int]:
    """(first line of the function signature, line that opens the body); lines before it are the preamble."""
    for body, line in enumerate(clean):
        if line[:1].isspace() or not line.rstrip().endswith('{') or NOT_BODY.match(line):
            continue
        if line.strip() != '{':
            return body, body  # `type name(args) {`
        start = body - 1  # `{` on its own line: the signature is the block of lines above, after a blank line
        while start > 0 and not clean[start].strip():
            start -= 1
        while start > 0 and clean[start - 1].strip():
            start -= 1
        return start, body
    return len(clean), len(clean)


def count(text: str) -> Counter:
    result = Counter()
    code = NOISE.sub(blank, text)
    lines = text.splitlines()
    clean = code.splitlines()
    result['functions'] = 1
    result['gotos'] = len(re.findall(r'\bgoto\s+\w+\s*;', code))
    result['labels'] = sum(
        1 for name in re.findall(r'^\s*([A-Za-z_]\w*):(?!:)', code, re.M) if name not in KEYWORDS
    )
    result['breakable'] = len(re.findall(r'\}\s*while\s*\(\s*0\s*\)\s*;', code))
    result['while_true'] = len(re.findall(r'\bwhile\s*\(\s*(?:true|1)\s*\)', code))
    result['for'] = len(re.findall(r'^\s*for\s*\(', code, re.M))
    whiles = len(re.findall(r'\bwhile\s*\(', code))
    result['tested'] = whiles - result['breakable'] - result['while_true'] + result['for']
    result['breaks'] = len(re.findall(r'\bbreak\s*;', code))
    result['continues'] = len(re.findall(r'\bcontinue\s*;', code))
    result['exit_flags'] = len(set(EXIT_FLAG.findall(code)))
    result['jumps'] = sum(result[key] for key in ('gotos', 'breaks', 'continues', 'exit_flags', 'breakable'))
    result['else_if'] = len(re.findall(r'\belse\s+if\b', code))
    result['comma_conditions'] = comma_conditions(code)
    result['cells64'] = len(CELL64.findall(code))
    signature, body = signature_lines(clean)
    for index, line in enumerate(lines):
        size = len(line.encode('utf-8', 'replace')) + 1
        result['bytes'] += size
        shown = clean[index].strip() if index < len(clean) else ''
        if ENTRY_SP.search(line):
            result['entry_sp_lines'] += 1
        if not line.strip():
            result['bytes_other'] += size
            continue
        if not shown:
            part = 'comments'
        else:
            result['lines'] += 1
            if index < signature:
                part = 'preamble'
            elif ENTRY_SP.search(shown):
                part = 'entry_sp'
            elif HELPER.search(shown):
                part = 'helpers'
            elif index > body and DECLARATION.fullmatch(clean[index]):
                part = 'decls'
                result['decls'] += 1
            else:
                part = 'other'
            if index > body and OPEN_CALL.search(shown):
                result['open_calls'] += 1
        result['bytes_' + part] += size
    for key, source in (('with_goto', 'gotos'), ('with_entry_sp', 'entry_sp_lines'), ('with_cells64', 'cells64')):
        result[key] = int(result[source] > 0)
    return result


def functions(root: Path) -> dict[str, Counter]:
    """Counters per function: `SAMPLE/NAME@ADDR` (`sqlite-*` directories are one sample)."""
    result = {}
    for directory in sorted(path for path in root.iterdir() if path.is_dir()):
        files = sorted((directory / 'functions').glob('*.c')) or sorted(directory.glob('*.c'))
        for path in files:
            result[f'{directory.name.split("-")[0]}/{path.stem}'] = count(path.read_text(errors='replace'))
    return result


def resolve(out: str, spec: str) -> tuple[str, Path]:
    if '=' in spec:
        name, path = spec.split('=', 1)
        return name, Path(path)
    return spec, Path(out) / spec


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
    metrics(argparse.Namespace(out=args.out, label=[args.label], ghidra=None, all=False, top=10))


def function_lists(args: argparse.Namespace, name: str) -> list[tuple[str, str]]:
    """(address, NAME@ADDR) for one sample: from an Open Decomp export's index.tsv or a `*.list` file."""
    rows = []
    if args.lists:
        path = Path(args.lists) / f'{name}.list'
        for line in path.read_text().splitlines() if path.exists() else ():
            address, _, stem = line.strip().split('\t')
            rows.append((address, stem))
    else:
        _, root = resolve(args.out, args.source)
        index = root / name / 'index.tsv'
        for line in index.read_text().splitlines()[1:] if index.exists() else ():
            address, _, file = line.split('\t')[:3]
            rows.append((address, Path(file).stem))
    return rows[: args.limit] if args.limit else rows


def ghidra(args: argparse.Namespace) -> None:
    install = args.install or os.environ.get('GHIDRA_INSTALL_DIR')
    java_home = args.java_home or os.environ.get('JAVA_HOME')
    if not install or not (Path(install) / 'support/analyzeHeadless').exists():
        sys.exit('set GHIDRA_INSTALL_DIR (or --install) to a Ghidra installation')
    environment = {**os.environ, 'JAVA_TOOL_OPTIONS': '-Djava.awt.headless=true'}
    if java_home:
        environment['JAVA_HOME'] = java_home
    if not args.lists and not args.source:
        sys.exit('give --from (an Open Decomp export label or NAME=DIR) or --lists DIR')
    out = Path(args.out) / args.label
    if out.exists() and not args.only:
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)
    scripts = Path(tempfile.mkdtemp(prefix='ghidra-scripts-'))
    shutil.copyfile(GHIDRA_SCRIPT, scripts / f'{GHIDRA_CLASS}.java')
    binaries: dict[Path, list[str]] = {}
    for name, binary, _ in SAMPLE:
        if not args.only or name in args.only:
            binaries.setdefault(binary, []).append(name)
    for binary, names in binaries.items():
        lists = {name: function_lists(args, name) for name in names}
        wanted = {stem: address for rows in lists.values() for address, stem in rows}
        if not wanted:
            print(f'{binary.name}: no functions listed, skipped', file=sys.stderr)
            continue
        work = Path(tempfile.mkdtemp(prefix='ghidra-work-'))
        # one analysis per binary: the samples that share it (the SQLite filters) share one combined list
        (work / 'functions.list').write_text(''.join(f'{address}\t{stem.split("@")[0]}\t{stem}\n' for stem, address in wanted.items()))
        command = [
            str(Path(install) / 'support/analyzeHeadless'), str(work / 'project'), 'structure-sample',
            '-import', str(binary), '-overwrite', '-deleteProject',
            '-scriptPath', str(scripts), '-postScript', f'{GHIDRA_CLASS}.java', str(work / 'functions.list'), str(work / 'out'),
        ]
        (work / 'project').mkdir()
        with open(out / f'{binary.name}.log', 'w') as log:
            code = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, env=environment).returncode
        if code:
            print(f'{binary.name}: ghidra failed ({code}), see {out / binary.name}.log', file=sys.stderr)
        for name, rows in lists.items():
            target = out / name / 'functions'
            target.mkdir(parents=True, exist_ok=True)
            for _, stem in rows:
                produced = work / 'out' / f'{stem}.c'
                if produced.exists():
                    shutil.copyfile(produced, target / f'{stem}.c')
        produced = {stem: work / 'out' / f'{stem}.c' for stem in wanted}
        texts = {stem: path.read_text(errors='replace') for stem, path in produced.items() if path.exists()}
        failed = sum(1 for text in texts.values() if '/* NOT FOUND */' in text or '/* FAILED' in text)
        print(f'{binary.name}: {len(texts)}/{len(wanted)} functions decompiled, {failed} not found or failed')
        shutil.rmtree(work, ignore_errors=True)
    shutil.rmtree(scripts, ignore_errors=True)


TABLE = (
    ('functions', 'functions'),
    ('goto', 'gotos'),
    ('functions with a goto', 'with_goto'),
    ('labels', 'labels'),
    ('do { } while (0)', 'breakable'),
    ('break', 'breaks'),
    ('continue', 'continues'),
    ('exit-flag variables', 'exit_flags'),
    ('jump statements', 'jumps'),
    ('while (true)', 'while_true'),
    ('for', 'for'),
    ('loops with a test', 'tested'),
    ('else if', 'else_if'),
    ('comma conditions', 'comma_conditions'),
    ('non-blank lines, no comments', 'lines'),
    ('bytes', 'bytes'),
    ('  preamble', 'bytes_preamble'),
    ('  entry_sp lines', 'bytes_entry_sp'),
    ('  local declarations', 'bytes_decls'),
    ('  comments', 'bytes_comments'),
    ('  uncertainty helpers', 'bytes_helpers'),
    ('  other (statements, control flow)', 'bytes_other'),
    ('local declarations', 'decls'),
    ('lines with entry_sp', 'entry_sp_lines'),
    ('functions with entry_sp', 'with_entry_sp'),
    ('body lines with a call ending , ...)', 'open_calls'),
    ('64-bit cell reassemblies', 'cells64'),
    ('functions with a reassembly', 'with_cells64'),
)


def paired_table(tables: dict[str, dict[str, Counter]], names: set[str] | None, title: str) -> None:
    totals = {
        label: sum((table[name] for name in (table.keys() if names is None else names)), Counter())
        for label, table in tables.items()
    }
    width = max(len(label) for label in totals) + 2
    print(f'\n{title}')
    print('metric'.ljust(40) + ''.join(label.rjust(max(width, 12)) for label in totals))
    for title_, key in TABLE:
        cells = []
        for total in totals.values():
            cell = f'{total[key]:,}'
            if key.startswith('bytes_') and total['bytes']:
                cell += f' ({100 * total[key] / total["bytes"]:.0f}%)'
            cells.append(cell)
        print(title_.ljust(40) + ''.join(cell.rjust(max(width, 12)) for cell in cells))


def metrics(args: argparse.Namespace) -> None:
    specs = [resolve(args.out, spec) for spec in args.label]
    if args.ghidra:
        specs.append(resolve(args.out, args.ghidra))
    tables = {label: functions(root) for label, root in specs}
    common = set.intersection(*(set(table) for table in tables.values()))
    paired_table(tables, None, 'all functions of each label')
    if any(len(common) != len(table) for table in tables.values()):
        paired_table(tables, common, f'{len(common)} functions every label has')
    first, *rest = (label for label, _ in specs[: len(args.label)])
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
    if args.ghidra:
        ghidra_label = specs[-1][0]
        ours, theirs = tables[first], tables[ghidra_label]
        rows = sorted(
            ((ours[name]['jumps'] - theirs[name]['jumps'], name) for name in common),
            key=lambda row: (-row[0], row[1]),
        )
        for title, selected in (
            (f'jump statements, {first} minus {ghidra_label}: most over', rows[: args.top]),
            ('most under', [row for row in reversed(rows[-args.top:]) if row[0] < 0]),
        ):
            print(f'\n{title}')
            print('  ' + 'function'.ljust(52) + ''.join(f'{key:>20}' for key in ('jumps', 'lines', 'bytes')))
            for delta, name in selected:
                a, b = ours[name], theirs[name]
                cells = ''.join(f'{f"{a[key]} / {b[key]}":>20}' for key in ('jumps', 'lines', 'bytes'))
                print(f'{delta:+4d}  {name[:52].ljust(52)}{cells}')
        print(f'\nper-function deltas ({first} minus {ghidra_label}), summed over the {len(common)} common functions:')
        for key in ('jumps', 'lines', 'bytes'):
            deltas = [ours[name][key] - theirs[name][key] for name in common]
            print(f'  {key}: {sum(deltas):+,}; larger in {sum(d > 0 for d in deltas)}, equal in {sum(d == 0 for d in deltas)}, smaller in {sum(d < 0 for d in deltas)} functions')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--out', default=os.environ.get('STRUCTURE_GOTOS_OUT', '/tmp/structure-gotos'))
    commands = parser.add_subparsers(dest='command', required=True)
    run_parser = commands.add_parser('run')
    run_parser.add_argument('--entry', required=True)
    run_parser.add_argument('--label', required=True)
    run_parser.add_argument('--jobs', type=int, default=2)
    run_parser.set_defaults(handler=run)
    ghidra_parser = commands.add_parser('ghidra', help='decompile the sample functions with Ghidra headless')
    ghidra_parser.add_argument('--label', default='ghidra')
    ghidra_parser.add_argument('--from', dest='source', help='Open Decomp export (LABEL under --out, or NAME=DIR) whose index.tsv files list the functions')
    ghidra_parser.add_argument('--lists', help='directory of SAMPLE.list files (address, name, NAME@ADDR per line) instead of --from')
    ghidra_parser.add_argument('--only', action='append', help='sample name to decompile (repeatable); keeps the other samples of the label')
    ghidra_parser.add_argument('--limit', type=int, default=0, help='at most this many functions per sample (smoke runs)')
    ghidra_parser.add_argument('--install', help='Ghidra installation (default: GHIDRA_INSTALL_DIR)')
    ghidra_parser.add_argument('--java-home', help='JDK for Ghidra (default: JAVA_HOME)')
    ghidra_parser.set_defaults(handler=ghidra)
    metrics_parser = commands.add_parser('metrics')
    metrics_parser.add_argument('--label', action='append', required=True, help='LABEL under --out, or NAME=DIR; repeat to compare builds')
    metrics_parser.add_argument('--ghidra', help='Ghidra lane (LABEL or NAME=DIR): adds its column and the per-function deltas against the first label')
    metrics_parser.add_argument('--top', type=int, default=10, help='functions listed per side of the Ghidra deltas')
    metrics_parser.add_argument('--all', action='store_true', help='also list functions whose other counts changed')
    metrics_parser.set_defaults(handler=metrics)
    args = parser.parse_args()
    args.handler(args)


if __name__ == '__main__':
    main()

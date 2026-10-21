import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ARTIFACT_PATTERNS,
  PLACEHOLDER_PATTERNS,
  SCALAR_METRICS,
  computeMetrics,
} from '../../scripts/bench/odbench/metrics.js';

test('comments and string literals never count as code', () => {
  const metrics = computeMetrics(
    [
      'int f(int a) {',
      '  /* goto bad; { while (true) { break; */',
      '  const char *s = "goto x; } } while (0); loop_exit_1";',
      '  // continue; for (;;) {',
      "  char c = '{';",
      '  if (a) { return 1; }',
      '  return 0;',
      '}',
      '',
    ].join('\n'),
  );
  assert.equal(metrics.gotos, 0);
  assert.equal(metrics.breaks, 0);
  assert.equal(metrics.continues, 0);
  assert.equal(metrics.while_true, 0);
  assert.equal(metrics.for, 0);
  assert.equal(metrics.breakable, 0);
  assert.equal(metrics.exit_flags, 0);
  assert.equal(metrics.max_nesting, 1);
  assert.equal(metrics.decision_points, 1);
  assert.equal(metrics.lines, 6);
  assert.equal(
    metrics.comment_bytes,
    '/* goto bad; { while (true) { break; */'.length + '// continue; for (;;) {'.length,
  );
  assert.equal(metrics.identifiers, 4); // f, a, s, c: keywords are not identifiers
});

test('jumps, labels, loops and declarations are counted like the retired structure sample', () => {
  const metrics = computeMetrics(
    [
      'int g(int n)',
      '{',
      '  int i;',
      '  int j[4];',
      '  i = 0;',
      'loop:',
      '  do {',
      '    if (i >= n) break;',
      '    i++;',
      '    if (i == 2) continue;',
      '  } while (0);',
      '  while (true) { if (i) goto loop; else if (j[0]) goto done; }',
      '  for (i = 0; i < n; i++) { n--; }',
      '  while (i < n) { i++; }',
      '  while ((i = h(), i)) { i++; }',
      '  if (x = f(), x != 0) { y(1, 2); }',
      '  switch (n) { case 1: break; default: break; }',
      'done:',
      '  return i;',
      '}',
      '',
    ].join('\n'),
  );
  assert.equal(metrics.gotos, 2);
  assert.equal(metrics.labels, 2); // loop, done; not `case 1:` or `default:`
  assert.equal(metrics.breakable, 1);
  assert.equal(metrics.while_true, 1);
  assert.equal(metrics.for, 1);
  assert.equal(metrics.tested, 4 - 1 - 1 + 1); // whiles - breakable - while(true) + for
  assert.equal(metrics.breaks, 3);
  assert.equal(metrics.continues, 1);
  assert.equal(metrics.jumps, 2 + 3 + 1 + 0 + 1);
  assert.equal(metrics.else_if, 1);
  assert.equal(metrics.comma_conditions, 2);
  assert.equal(metrics.decls, 2);
  assert.equal(metrics.with_goto, 1);
  assert.equal(metrics.max_nesting, 1);
});

test('comma conditions ignore commas of call arguments', () => {
  assert.equal(
    computeMetrics('void f() {\n  if (g(a, b)) {}\n  while (h(c, d) && k(e, f)) {}\n}\n')
      .comma_conditions,
    0,
  );
  assert.equal(computeMetrics('void f() {\n  if ((c = *p++), c) {}\n}\n').comma_conditions, 1);
});

test('Ghidra sample: placeholder names and artifacts', () => {
  const metrics = computeMetrics(
    [
      'undefined8 FUN_100001000(long param_1)',
      '',
      '{',
      '  uint uVar1;',
      '  undefined8 uVar2;',
      '  long local_10;',
      '  ',
      '  /* WARNING: Unknown calling convention */',
      '  uVar1 = *(uint *)(param_1 + 8);',
      '  uVar2 = CONCAT44(uVar1,0);',
      '  return uVar2;',
      '}',
      '',
    ].join('\n'),
  );
  assert.equal(metrics.artifacts['CONCAT<N>'], 1);
  assert.equal(metrics.artifacts['undefined[N]'], 2);
  assert.equal(metrics.artifacts['WARNING'], 1);
  assert.equal(metrics.artifacts['entry_sp'], 0);
  assert.equal(metrics.artifacts_total, 4);
  // distinct identifiers: undefined8 FUN_100001000 param_1 uint uVar1 uVar2 local_10 CONCAT44
  assert.equal(metrics.identifiers, 8);
  assert.equal(metrics.placeholder_names, 5); // FUN_, param_1, uVar1, uVar2, local_10
  assert.equal(metrics.placeholder_ratio, 5 / 8);
  assert.equal(metrics.decls, 3);
  assert.equal(metrics.casts, 1);
  assert.equal(metrics.lines, 9);
  assert.equal(metrics.comment_bytes, '/* WARNING: Unknown calling convention */'.length);
});

test('Open Decomp sample: entry_sp, open-arity calls, field names', () => {
  const metrics = computeMetrics(
    [
      '/* C-like */',
      'uint64_t sub_100002f0c(uint64_t arg0, struct S *p)',
      '{',
      '  uint64_t v0;',
      '  uint64_t entry_sp = 0;',
      '  v0 = unknown_call(arg0, ...);',
      '  if (v0 != 0 && arg0 > 1) {',
      '    v0 = p->field_0x10;',
      '  }',
      '  return v0;',
      '}',
      '',
    ].join('\n'),
  );
  assert.equal(metrics.entry_sp_lines, 1);
  assert.equal(metrics.with_entry_sp, 1);
  assert.equal(metrics.open_calls, 1);
  assert.equal(metrics.decls, 1);
  assert.equal(metrics.artifacts['entry_sp'], 1);
  assert.equal(metrics.artifacts['unknown_*'], 1);
  assert.equal(metrics.artifacts['open call ", ...)"'], 1);
  assert.equal(metrics.artifacts_total, 3);
  assert.equal(metrics.decision_points, 2); // if, &&
  assert.equal(metrics.lines, 10);
  // distinct: uint64_t sub_100002f0c arg0 S p v0 entry_sp unknown_call field_0x10
  assert.equal(metrics.identifiers, 9);
  assert.equal(metrics.placeholder_names, 4); // sub_, arg0, v0, field_0x10
  assert.equal(metrics.comment_bytes, '/* C-like */'.length);
});

test('nesting counts blocks inside the function body', () => {
  assert.equal(computeMetrics('int f() { return 0; }').max_nesting, 0);
  assert.equal(computeMetrics('int f() { if (a) { while (b) { x(); } } }').max_nesting, 2);
  assert.equal(computeMetrics('int f() { if (a) { g("}}}}"); } /* { { { */ }').max_nesting, 1);
  assert.equal(computeMetrics('x = 1;').max_nesting, 0);
});

test('lexical tokens: maximal munch, literals, comments, preprocessor lines', () => {
  assert.equal(computeMetrics('int f(int a){return a+1;}').lexical_tokens, 13);
  assert.equal(computeMetrics('x = "a b" + \'c\' + 0x1F + 1.5e+3;').lexical_tokens, 10);
  assert.equal(computeMetrics('a <<= b >> c -> d').lexical_tokens, 7);
  assert.equal(computeMetrics('/* x */ a // y\n').lexical_tokens, 1);
  assert.equal(computeMetrics('a ... b && c || d ? e : f').lexical_tokens, 11);
  assert.equal(computeMetrics('#include <stdio.h>\n').lexical_tokens, 7); // # include < stdio . h >
  assert.equal(computeMetrics('s = L"wide" "x\\"y";').lexical_tokens, 5);
  assert.equal(computeMetrics('').lexical_tokens, 0);
});

test('casts: scalar, pointer and struct types followed by an operand', () => {
  const casts = (text: string): number => computeMetrics(text).casts;
  assert.equal(casts('x = (unsigned long)y;'), 1);
  assert.equal(casts('x = (char *)p + (uint8_t)v;'), 2);
  assert.equal(casts('x = (struct S *)q;'), 1);
  assert.equal(casts('x = (const char **)q;'), 1);
  assert.equal(casts('(void)f();'), 1);
  assert.equal(casts('x = (undefined8)y;'), 1);
  assert.equal(casts('x = (code *)0x10;'), 1);
  assert.equal(casts('x = (long)-1;'), 1);
  assert.equal(casts('n = sizeof(int) * 2;'), 0);
  assert.equal(casts('int f(int);'), 0);
  assert.equal(casts('x = (y) + 1; z = (a * b);'), 0);
});

test('pattern tables name every placeholder and artifact family of both tools', () => {
  const names = ARTIFACT_PATTERNS.map((pattern) => pattern.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(ARTIFACT_PATTERNS.some((pattern) => pattern.tool === 'od'));
  assert.ok(ARTIFACT_PATTERNS.some((pattern) => pattern.tool === 'ghidra'));
  assert.ok(PLACEHOLDER_PATTERNS.some((pattern) => pattern.tool === 'od'));
  assert.ok(PLACEHOLDER_PATTERNS.some((pattern) => pattern.tool === 'ghidra'));
  const metrics = computeMetrics('');
  for (const { key } of SCALAR_METRICS) assert.equal(typeof metrics[key], 'number', key);
  assert.deepEqual(Object.keys(metrics.artifacts), names);
});

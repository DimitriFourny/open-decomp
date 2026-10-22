import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { digestDiagnostics, firstSentence } from '../../scripts/bench/odbench/diagnostics.js';
import { computeMetrics } from '../../scripts/bench/odbench/metrics.js';
import {
  readDefinition,
  readDefinitions,
  signatureTable,
} from '../../scripts/bench/odbench/signature.js';
import { readLane, resetLane, writeLane } from '../../scripts/bench/odbench/store.js';
import type { FunctionResult, LaneRun } from '../../scripts/bench/odbench/types.js';

const OD_TEXT = [
  '/* C-like */',
  '/* open arity (calls show proven args only): helper (not a definition) */',
  'typedef struct node_arg0_1f2e node_arg0_1f2e;',
  'struct node_arg0_1f2e { uint64_t field_0x0; uint8_t pad_0x8[8]; };',
  'extern _Noreturn void __stack_chk_fail(void);',
  'static inline uint64_t __od_bitcast_u64_f64(double value) { uint64_t result; return result; }',
  'unknown_result walk(',
  '  node_arg0_1f2e* address,',
  '  uint64_t (*callback)(uint64_t, ...),',
  '  uint64_t arg2',
  ') {',
  '  _Alignas(16) struct {',
  '    uint64_t local_8;',
  '  } frame;',
  '  return;',
  '}',
  '',
].join('\n');

const GHIDRA_TEXT = [
  '',
  'void _walk(long *param_1,code *param_2,undefined8 param_3)',
  '',
  '{',
  '  (*param_2)(*param_1);',
  '  return;',
  '}',
  '',
].join('\n');

const SOURCE_TEXT = [
  '/* Walk the list. (keeps parentheses in comments harmless) */',
  'SQLITE_PRIVATE void walk(',
  '  Node *pNode,                 /* the head */',
  '  int (*xCallback)(void*,int,void(*)(int)),',
  '  const char *zName            /* a name */',
  '){',
  '  if( pNode==0 ) return;',
  '}',
  '',
].join('\n');

test('Open Decomp style: preamble, helpers, multi-line parameters, function-pointer parameter, unknown_result', () => {
  const definitions = readDefinitions(OD_TEXT);
  assert.deepEqual(
    definitions.map((definition) => definition.name),
    ['__od_bitcast_u64_f64', 'walk'],
  );
  const walk = readDefinition(OD_TEXT, 'walk');
  assert.ok(walk);
  assert.equal(walk.returns, 'unknown_result');
  assert.equal(walk.parameters.length, 3);
  assert.equal(walk.parameters[1], 'uint64_t (*callback)(uint64_t, ...)');
  assert.equal(walk.variadic, false); // the `...` belongs to the pointer's own parameter list
});

test('Ghidra style: signature line, blank line, brace line; leading underscore names match', () => {
  const walk = readDefinition(GHIDRA_TEXT, 'walk');
  assert.ok(walk);
  assert.equal(walk.name, '_walk');
  assert.equal(walk.returns, 'void');
  assert.equal(walk.parameters.length, 3);
});

test('source style: export macros, comments between parameters, nested function-pointer parameter', () => {
  const walk = readDefinition(SOURCE_TEXT, 'walk');
  assert.ok(walk);
  assert.equal(walk.head, 'SQLITE_PRIVATE void');
  assert.equal(walk.returns, 'void');
  assert.deepEqual(walk.parameters, [
    'Node *pNode',
    'int (*xCallback)(void*,int,void(*)(int))',
    'const char *zName',
  ]);
});

test('return kind comes from the tokens before the name, not from known macro names', () => {
  const kinds = (text: string): string | undefined => readDefinitions(text)[0]?.returns;
  assert.equal(kinds('static BROTLI_BOOL f(void) {\n return 1;\n}\n'), 'value');
  assert.equal(kinds('uLong ZEXPORT adler(uLong a, const Bytef *b) {\n return a;\n}\n'), 'value');
  assert.equal(kinds('KEEP u64 g(u32 op) {\n return op;\n}\n'), 'value');
  assert.equal(kinds('KEEP void g(u32 op) {\n}\n'), 'void');
  assert.equal(kinds('SQLITE_API void ZEXPORT h(int a) {\n}\n'), 'void');
  assert.equal(kinds('static void *h(int a) {\n return 0;\n}\n'), 'value');
  assert.equal(kinds('_Noreturn void die(const char *m) __attribute__((noreturn)) {\n}\n'), 'void');
  assert.equal(kinds('unknown_result k(uint64_t arg0) {\n}\n'), 'unknown_result');
});

test('parameter lists: (void), (), variadic and preprocessor lines', () => {
  const none = readDefinition('int a(void) {\n return 0;\n}\n', 'a');
  const empty = readDefinition('int b() {\n return 0;\n}\n', 'b');
  const variadic = readDefinition('double c(unsigned count, ...) {\n return 0;\n}\n', 'c');
  assert.deepEqual([none?.parameters.length, empty?.parameters.length], [0, 0]);
  assert.equal(variadic?.parameters.length, 1);
  assert.equal(variadic?.variadic, true);
  const guarded = readDefinition(
    [
      '#if defined(X)',
      '#define Y(a) \\',
      '  a',
      '#endif',
      'static int d(int a) {',
      '  return a;',
      '}',
    ].join('\n'),
    'd',
  );
  assert.equal(guarded?.parameters.length, 1);
});

test('control statements and initializers are not definitions', () => {
  const text = [
    'static const struct { int a; } table[] = { { 1 }, { 2 } };',
    'int user(int n) {',
    '  if (n) { return 1; }',
    '  while (n--) { }',
    '  return 0;',
    '}',
  ].join('\n');
  assert.deepEqual(
    readDefinitions(text).map((definition) => definition.name),
    ['user'],
  );
});

test('signature table counts return kinds against the source and parameter counts', () => {
  const table = signatureTable('od', [
    // void source, OD prints unknown_result, two parameters fewer than source's three
    { name: 'walk', lane: 'unknown_result walk(uint64_t a) {\n}\n', source: SOURCE_TEXT },
    // void source, Ghidra-like void with equal parameters
    { name: 'walk', lane: GHIDRA_TEXT, source: SOURCE_TEXT },
    // value source, lane prints void with one more parameter
    {
      name: 'm',
      lane: 'void m(int a, int b) {\n}\n',
      source: 'static int m(int a) {\n  return a;\n}\n',
    },
    // value source and value
    { name: 'n', lane: 'uint64_t n(void) {\n}\n', source: 'int n(void) {\n  return 0;\n}\n' },
    // unreadable lane text
    { name: 'o', lane: 'no definition here', source: 'int o(void) {\n  return 0;\n}\n' },
  ]);
  assert.equal(table.compared, 4);
  assert.equal(table.unread_lane, 1);
  assert.equal(table.unread_source, 0);
  assert.deepEqual(table.returns.void, { void: 1, value: 0, unknown_result: 1 });
  assert.deepEqual(table.returns.value, { void: 1, value: 1, unknown_result: 0 });
  assert.deepEqual(table.parameters, { equal: 2, fewer: 1, more: 1 });
});

test('diagnostics keep severity, code and the first sentence, once each', () => {
  assert.equal(
    firstSentence('Callee summary was cut. It spent 12 units. More.'),
    'Callee summary was cut',
  );
  assert.equal(firstSentence('no sentence end'), 'no sentence end');
  assert.equal(firstSentence('x'.repeat(200)).length, 161);
  const digest = digestDiagnostics([
    { code: 'unavailable_semantics', severity: 'warning', message: 'Open arity for f. Subject a.' },
    { code: 'unavailable_semantics', severity: 'warning', message: 'Open arity for f. Subject b.' },
    { code: 'resource_limit', severity: 'info', message: 'Budget reached' },
  ]);
  assert.deepEqual(digest, [
    { code: 'unavailable_semantics', severity: 'warning', text: 'Open arity for f' },
    { code: 'resource_limit', severity: 'info', text: 'Budget reached' },
  ]);
});

test('diagnostics round-trip through lane.json and stay out of the text identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'odbench-signature-test-'));
  const previous = process.env['OPEN_DECOMP_BENCH_DIR'];
  process.env['OPEN_DECOMP_BENCH_DIR'] = dir;
  try {
    const base = {
      state: 'complete',
      reason: null,
      ms: 1,
      text_file: null,
      sha256: 'abc',
      bytes: 3,
    } as const;
    const functions: Record<string, FunctionResult> = {
      'b/with@0x1': {
        ...base,
        diagnostics: [{ code: 'unavailable_semantics', severity: 'warning', text: 'Open arity' }],
      },
      'b/none@0x2': { ...base, diagnostics: [] },
      'b/lost@0x3': { ...base, state: 'failed', diagnostics: null },
      'b/old@0x4': { ...base },
    };
    const run: LaneRun = {
      schema: 'odbench-lane/1',
      lane: 'od-test',
      kind: 'od',
      tool: { name: 'open-decomp', version: null, path: null },
      corpus_sha256: 'x',
      tier: 'full',
      started: '',
      finished: '',
      host: {
        platform: 'p',
        cpu: 'c',
        cores: 1,
        memory_bytes: 1,
        node: 'n',
        loadavg_start: [],
        loadavg_end: [],
      },
      repeat: 1,
      jobs: 1,
      binaries: {},
      functions,
      notes: [],
    };
    await resetLane('od-test');
    await writeLane(run);
    const read = await readLane('od-test');
    assert.deepEqual(read?.functions['b/with@0x1']?.diagnostics, [
      { code: 'unavailable_semantics', severity: 'warning', text: 'Open arity' },
    ]);
    assert.deepEqual(read?.functions['b/none@0x2']?.diagnostics, []);
    assert.equal(read?.functions['b/lost@0x3']?.diagnostics, null);
    assert.equal(read?.functions['b/old@0x4']?.diagnostics, undefined);
    assert.equal(read?.functions['b/with@0x1']?.sha256, 'abc');
  } finally {
    if (previous === undefined) delete process.env['OPEN_DECOMP_BENCH_DIR'];
    else process.env['OPEN_DECOMP_BENCH_DIR'] = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('section 5 counters: helper vocabulary, open pointer casts, frame structs', () => {
  const metrics = computeMetrics(
    [
      'unknown_result f(uint64_t a) {',
      '  _Alignas(16) struct {',
      '    uint64_t local_8;',
      '  } frame;',
      '  uint64_t v = unknown_value("bits64_t", "entry register");',
      '  v = __unknown_effect("why", physical_inputs(), "unknown_read_write", {});',
      '  boundary("unknown_read_write", {"x"});',
      '  if (!requirement_predicate("r", "s", "e", v == 0, 1)) { return; }',
      '  r = ((uint64_t (*)(uint64_t, uint64_t*, ...))a)(v, &v);',
      '  s = ((uint64_t (*)(uint64_t))a)(v);',
      '  // unknown_value( boundary( inside a comment',
      '  puts("unknown_value(");',
      '}',
      '',
    ].join('\n'),
  );
  assert.equal(metrics.unknown_result, 1);
  assert.equal(metrics.unknown_values, 1);
  assert.equal(metrics.unknown_effects, 1);
  assert.equal(metrics.boundaries, 1);
  assert.equal(metrics.requirement_predicates, 1);
  assert.equal(metrics.open_pointer_casts, 1);
  assert.equal(metrics.with_frame, 1);
  assert.equal(computeMetrics('int g(void) {\n  return 0;\n}\n').with_frame, 0);
});

test('embedded-assignment conditions are separate from comma conditions', () => {
  const metrics = computeMetrics(
    [
      'int g(int n) {',
      '  if (n != 0 && (a = f(n)) != 0) { x(); }', // counted
      '  if ((int32_t)(b = *p) >= 1) { x(); }', // counted: a cast before the group
      '  while ((c = next(c)) > 0) { x(); }', // counted
      '  if ((d = e + 1) >> 16 != 0) { x(); }', // counted: arithmetic operator on the value
      '  if (a == 0 && b <= 3) { x(); }', // comparisons are not assignments
      '  if (f(a = 1) != 0) { x(); }', // assignment inside a call argument
      '  if (n && (m = h(n))) { x(); }', // no operator on the value
      '  if (a != 0 && (v = 1, v == 2)) { x(); }', // comma condition: the other counter
      '  y = (z = 3) + 1;', // not a condition
      '  return 0;',
      '}',
      '',
    ].join('\n'),
  );
  assert.equal(metrics.embedded_assignment_conditions, 4);
  assert.equal(metrics.comma_conditions, 1);
});

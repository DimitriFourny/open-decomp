import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractDefinition,
  extractDefinitions,
  stripComments,
} from '../../scripts/bench/odbench/sources.js';

test('extractDefinition returns the definition, not an earlier prototype or a call', () => {
  const text = [
    'int add(int a, int b);',
    'static int twice(int x) { return add(x, x); }',
    '',
    '/* header comment of add */',
    'int',
    'add(int a, int b)',
    '{',
    '  return a + b;',
    '}',
    'int other(void) { return add(1, 2); }',
  ].join('\n');
  assert.equal(extractDefinition(text, 'add'), 'int\nadd(int a, int b)\n{\n  return a + b;\n}');
  assert.equal(extractDefinition(text, 'twice'), 'static int twice(int x) { return add(x, x); }');
  assert.equal(extractDefinition(text, 'other'), 'int other(void) { return add(1, 2); }');
  assert.equal(extractDefinition('int add(int a, int b);\n', 'add'), null, 'prototype only');
  assert.equal(extractDefinition(text, 'missing'), null);
});

test('braces, quotes and comment markers inside literals and comments do not end or extend a definition', () => {
  const text = [
    'static int first(const char *s) {',
    '  const char *open = "{ /* not a comment";',
    "  char brace = '}';",
    "  char quote = '\\'';",
    '  char *escaped = "a \\" } still string";',
    '  /* a } closing brace in a comment */',
    '  // and { an opening one',
    '  return open[0] + brace + quote + escaped[0];',
    '}',
    'static int second(void) { return 2; }',
  ].join('\n');
  const first = extractDefinition(text, 'first');
  assert.ok(first?.startsWith('static int first(const char *s) {'));
  assert.ok(first?.endsWith('escaped[0];\n}'));
  assert.equal(extractDefinition(text, 'second'), 'static int second(void) { return 2; }');
});

test('SQLite-style specifiers, multi-line parameter lists and call-like macros', () => {
  const text = [
    '#define SQLITE_PRIVATE static',
    '#define LIKELY(X) __builtin_expect((X)!=0,1)',
    'SQLITE_API const char *sqlite3_libversion(void);',
    'SQLITE_PRIVATE void sqlite3Fn(',
    '  sqlite3 *db,   /* the database */',
    '  const char *zName',
    '){',
    '  if( LIKELY(db) ){ use(zName); }',
    '}',
    'static void SQLITE_NOINLINE slowPath(sqlite3 *db){',
    '  SQLITE_MISUSE_BKPT;',
    '}',
    'SQLITE_NOINLINE int fastPath(int x){ return x; }',
    'SQLITE_API const char *sqlite3_libversion(void){ return "3.54"; }',
    'WRAP_CALL(slowPath(0));',
    'static const struct Item { int a; } aItem[] = { {1}, {2} };',
    'SQLITE_PRIVATE int after(void){ return aItem[0].a; }',
  ].join('\n');
  assert.equal(
    extractDefinition(text, 'sqlite3Fn'),
    [
      'SQLITE_PRIVATE void sqlite3Fn(',
      '  sqlite3 *db,   /* the database */',
      '  const char *zName',
      '){',
      '  if( LIKELY(db) ){ use(zName); }',
      '}',
    ].join('\n'),
  );
  assert.equal(
    extractDefinition(text, 'slowPath'),
    'static void SQLITE_NOINLINE slowPath(sqlite3 *db){\n  SQLITE_MISUSE_BKPT;\n}',
  );
  assert.equal(
    extractDefinition(text, 'fastPath'),
    'SQLITE_NOINLINE int fastPath(int x){ return x; }',
  );
  assert.equal(
    extractDefinition(text, 'sqlite3_libversion'),
    'SQLITE_API const char *sqlite3_libversion(void){ return "3.54"; }',
  );
  assert.equal(
    extractDefinition(text, 'after'),
    'SQLITE_PRIVATE int after(void){ return aItem[0].a; }',
  );
  assert.equal(extractDefinition(text, 'LIKELY'), null, 'function-like macros are not definitions');
  assert.equal(
    extractDefinition(text, 'WRAP_CALL'),
    null,
    'a top-level invocation is not a definition',
  );
  assert.equal(extractDefinition(text, 'aItem'), null, 'initializers are not definitions');
});

test('a name defined twice is ambiguous: null, with every definition still listed', () => {
  const text = [
    '#ifdef FAST',
    'int pick(int x) { return x; }',
    '#else',
    'int pick(int x) { return x + 1; }',
    '#endif',
    'int unique(void) { return 0; }',
  ].join('\n');
  assert.equal(extractDefinition(text, 'pick'), null);
  assert.deepEqual(extractDefinitions(text, 'pick'), [
    'int pick(int x) { return x; }',
    'int pick(int x) { return x + 1; }',
  ]);
  assert.equal(extractDefinition(text, 'unique'), 'int unique(void) { return 0; }');
});

test('preprocessor lines and conditional branches do not desynchronize brace matching', () => {
  const text = [
    '#ifdef __cplusplus',
    'extern "C" {',
    '#endif',
    '#define OPEN {',
    'int before(void) { return 1; }',
    '#if 0',
    "text with an unbalanced ' quote and { brace",
    '#endif',
    'int branchy(int x){',
    '#ifdef A',
    '  if( x ){',
    '#else',
    '  if( !x ){',
    '#endif',
    '    x++;',
    '  }',
    '  return x;',
    '}',
    'int after(void) { return 3; }',
    '#ifdef __cplusplus',
    '}',
    '#endif',
  ].join('\n');
  assert.equal(extractDefinition(text, 'before'), 'int before(void) { return 1; }');
  assert.equal(extractDefinition(text, 'after'), 'int after(void) { return 3; }');
  assert.ok(extractDefinition(text, 'branchy')?.endsWith('  return x;\n}'));
});

test('stripComments drops comments and comment-only lines, keeps code, literals and layout', () => {
  const text = [
    '/* leading',
    '   block */',
    'int f(int a) { // trailing',
    '  /* only a comment */',
    '  const char *s = "/* keep */ // keep";',
    "  char c = '\"';  /* after code */",
    '',
    '  return a/* glued */+1;',
    '}',
    '',
  ].join('\n');
  assert.equal(
    stripComments(text),
    [
      'int f(int a) {',
      '  const char *s = "/* keep */ // keep";',
      "  char c = '\"';",
      '',
      '  return a +1;',
      '}',
      '',
    ].join('\n'),
  );
});

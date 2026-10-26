import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseCDeclarations,
  type CDeclarationTarget,
  type CParseResult,
  type CTypeDefinition,
} from '../../src/metadata/c-declarations/index.js';

const SYSV: CDeclarationTarget = { abi: 'sysv-amd64' };
const DARWIN: CDeclarationTarget = { abi: 'darwin-arm64' };
const WINDOWS: CDeclarationTarget = { abi: 'windows-x64' };

function parse(source: string, target: CDeclarationTarget = SYSV): CParseResult {
  const result = parseCDeclarations(source, target);
  assert.deepEqual(result.diagnostics, []);
  return result;
}

function definition(result: CParseResult, key: string): CTypeDefinition {
  const found = result.types.find((type) => type.key === key);
  assert.ok(
    found,
    `type ${key} is missing; have ${result.types.map((type) => type.key).join(', ')}`,
  );
  return found.definition;
}

function structure(result: CParseResult, key: string) {
  const def = definition(result, key);
  assert.equal(def.kind, 'structure');
  return def as Extract<CTypeDefinition, { kind: 'structure' }>;
}

function layout(result: CParseResult, key: string): { size: bigint | null; fields: string[] } {
  const def = structure(result, key);
  return { size: def.size, fields: def.fields.map((field) => `${field.name}@${field.offset}`) };
}

test('struct layout follows natural alignment and rounds the size up', () => {
  const result = parse(`
    #include <stdint.h>
    struct S { char a; int64_t b; char c; };
    struct T { uint8_t a; uint16_t b; uint8_t c; uint32_t d; };
  `);
  assert.deepEqual(layout(result, 'S'), { size: 24n, fields: ['a@0', 'b@8', 'c@16'] });
  assert.equal(structure(result, 'S').alignment, 8);
  assert.deepEqual(layout(result, 'T'), { size: 12n, fields: ['a@0', 'b@2', 'c@4', 'd@8'] });
  const field = structure(result, 'S').fields[1];
  assert.equal(field?.id, 'b');
  assert.equal(field?.type_id, 'int64_t');
  assert.deepEqual(definition(result, 'int64_t'), { kind: 'integer', bits: 64, signed: true });
  assert.equal(result.named.get('S'), 'S');
});

test('packed attribute and #pragma pack remove padding; aligned raises it', () => {
  const result = parse(`
    struct __attribute__((packed)) A { char a; long long b; char c; };
    struct B { char a; long long b; char c; } __attribute__((packed));
    #pragma pack(push, 1)
    struct C { char a; long long b; char c; };
    #pragma pack(pop)
    #pragma pack(2)
    struct D { char a; long long b; char c; };
    #pragma pack()
    struct E { char a; long long b; char c; };
    struct F { char a; int b __attribute__((packed)); };
    struct __attribute__((aligned(32))) G { char a; };
  `);
  for (const key of ['A', 'B', 'C'])
    assert.deepEqual(layout(result, key), { size: 10n, fields: ['a@0', 'b@1', 'c@9'] }, key);
  assert.equal(structure(result, 'A').alignment, 1);
  assert.deepEqual(layout(result, 'D'), { size: 12n, fields: ['a@0', 'b@2', 'c@10'] });
  assert.equal(structure(result, 'D').alignment, 2);
  assert.deepEqual(layout(result, 'E'), { size: 24n, fields: ['a@0', 'b@8', 'c@16'] });
  assert.deepEqual(layout(result, 'F'), { size: 5n, fields: ['a@0', 'b@1'] });
  assert.deepEqual(layout(result, 'G'), { size: 32n, fields: ['a@0'] });
});

test('unions place every member at offset 0 with size and alignment of the largest', () => {
  const result = parse(`
    union U { char c; int i; double d; char bytes[12]; };
    struct W { char tag; union U u; };
  `);
  assert.deepEqual(layout(result, 'U'), {
    size: 16n,
    fields: ['c@0', 'i@0', 'd@0', 'bytes@0'],
  });
  assert.equal(structure(result, 'U').alignment, 8);
  assert.deepEqual(layout(result, 'W'), { size: 24n, fields: ['tag@0', 'u@8'] });
});

test('nested and anonymous aggregates get deterministic keys and flatten C11 members', () => {
  const result = parse(`
    struct Outer {
      int id;
      struct { short x; short y; } point;
      union { int i; float f; } value;
      struct { char a; char b; };
      union { long long wide; double d; };
      struct Named { int z; } named;
    };
  `);
  assert.deepEqual(layout(result, 'Outer'), {
    size: 32n,
    fields: ['id@0', 'point@4', 'value@8', 'a@12', 'b@13', 'wide@16', 'd@16', 'named@24'],
  });
  const outer = structure(result, 'Outer');
  assert.equal(outer.fields[1]?.type_id, 'Outer$point');
  assert.deepEqual(layout(result, 'Outer$point'), { size: 4n, fields: ['x@0', 'y@2'] });
  assert.equal(structure(result, 'Outer$value').size, 4n);
  assert.equal(outer.fields[7]?.type_id, 'Named');
  assert.equal(result.types.find((type) => type.key === 'Outer$point')?.name, null);
  assert.deepEqual(
    result.types.map((type) => type.key).filter((key) => key.includes('<')),
    [],
  );
});

test('typedef of an anonymous struct takes the typedef name; nested anonymous types extend it', () => {
  const result = parse(`
    typedef struct { int a; struct { char b; } inner; char *name; } Rec, *RecPtr;
    typedef enum { RED, GREEN = 4, BLUE } Color;
    typedef struct Node Node;
    typedef struct Node *NodeRef;
    struct Node { Node *next; NodeRef prev; Color color; };
  `);
  assert.deepEqual(layout(result, 'Rec'), { size: 16n, fields: ['a@0', 'inner@4', 'name@8'] });
  assert.equal(structure(result, 'Rec').fields[1]?.type_id, 'Rec$inner');
  assert.equal(structure(result, 'Rec').fields[2]?.type_id, 'Rec$name');
  assert.deepEqual(definition(result, 'Rec$name'), { kind: 'pointer', to: 'int8_t', bits: 64 });
  assert.deepEqual(definition(result, 'RecPtr'), { kind: 'pointer', to: 'Rec', bits: 64 });
  assert.deepEqual(definition(result, 'Color'), { kind: 'integer', bits: 32, signed: true });
  assert.equal(result.named.get('Node'), 'Node');
  assert.deepEqual(layout(result, 'Node'), { size: 24n, fields: ['next@0', 'prev@8', 'color@16'] });
  assert.deepEqual(definition(result, 'NodeRef'), { kind: 'pointer', to: 'Node', bits: 64 });
  assert.equal(result.types.find((type) => type.key === 'NodeRef')?.name, 'NodeRef');
});

test('typedef of a tagged struct aliases the tag key; other typedefs get their own type', () => {
  const result = parse(`
    typedef struct Pair { int a, b; } PairT;
    typedef PairT PairU;
    typedef unsigned int u32;
    typedef u32 DWORD;
    typedef int Matrix[2][3];
    typedef unsigned char uint8_t;
  `);
  assert.equal(result.named.get('Pair'), 'Pair');
  assert.equal(result.named.get('PairT'), 'Pair');
  assert.equal(result.named.get('PairU'), 'Pair');
  assert.equal(result.types.filter((type) => type.key === 'PairT').length, 0);
  assert.deepEqual(definition(result, 'u32'), { kind: 'integer', bits: 32, signed: false });
  assert.deepEqual(definition(result, 'DWORD'), { kind: 'integer', bits: 32, signed: false });
  assert.equal(result.named.get('DWORD'), 'DWORD');
  assert.deepEqual(definition(result, 'Matrix'), { kind: 'array', element: 'Matrix#1', count: 2n });
  assert.deepEqual(definition(result, 'Matrix#1'), {
    kind: 'array',
    element: 'int32_t',
    count: 3n,
  });
  assert.equal(result.named.has('uint8_t'), false);
});

test('self-referential and mutually recursive structs use pointers and forward declarations', () => {
  const result = parse(`
    struct A { struct B *b; struct A *self; struct Opaque *handle; };
    struct B { struct A *a; };
  `);
  assert.deepEqual(layout(result, 'A'), { size: 24n, fields: ['b@0', 'self@8', 'handle@16'] });
  assert.deepEqual(definition(result, 'A$b'), { kind: 'pointer', to: 'B', bits: 64 });
  assert.deepEqual(definition(result, 'Opaque'), {
    kind: 'structure',
    size: null,
    alignment: null,
    fields: [],
  });
  const keys = result.types.map((type) => type.key);
  assert.equal(new Set(keys).size, keys.length);
  // Every referenced key is defined, and non-cyclic dependencies precede their users.
  for (const type of result.types) {
    const def = type.definition;
    const refs =
      def.kind === 'pointer'
        ? [def.to]
        : def.kind === 'array' || def.kind === 'vector'
          ? [def.element]
          : def.kind === 'structure'
            ? def.fields.map((field) => field.type_id)
            : [];
    for (const ref of refs) assert.ok(keys.includes(ref), `${type.key} -> ${ref}`);
  }
  assert.ok(keys.indexOf('int8_t') < 0);
  assert.ok(keys.indexOf('Opaque') < keys.indexOf('A'));
});

test('forward declaration is replaced in place by a later definition', () => {
  const result = parse(`
    struct Late;
    struct User { struct Late *p; };
    struct Late { int x; };
  `);
  assert.deepEqual(layout(result, 'Late'), { size: 4n, fields: ['x@0'] });
});

test('function pointers are pointers to void, including through typedefs and arrays', () => {
  const result = parse(`
    typedef int (*Callback)(void *ctx, int (*inner)(char), ...);
    typedef void Handler(int);
    struct Ops {
      int (*open)(const char *path, int flags);
      void (__stdcall *close)(int fd);
      Callback cb;
      Handler *handler;
      int (*table[4])(int);
      int (**indirect)(void);
    };
  `);
  assert.deepEqual(definition(result, 'Callback'), { kind: 'pointer', to: 'void', bits: 64 });
  assert.deepEqual(definition(result, 'Ops$open'), { kind: 'pointer', to: 'void', bits: 64 });
  assert.deepEqual(definition(result, 'Ops$handler'), { kind: 'pointer', to: 'void', bits: 64 });
  assert.deepEqual(definition(result, 'Ops$table'), {
    kind: 'array',
    element: 'Ops$table#1',
    count: 4n,
  });
  assert.deepEqual(definition(result, 'Ops$table#1'), { kind: 'pointer', to: 'void', bits: 64 });
  assert.deepEqual(definition(result, 'Ops$indirect'), {
    kind: 'pointer',
    to: 'Ops$indirect#1',
    bits: 64,
  });
  assert.deepEqual(definition(result, 'Ops$indirect#1'), {
    kind: 'pointer',
    to: 'void',
    bits: 64,
  });
  assert.deepEqual(layout(result, 'Ops'), {
    size: 72n,
    fields: ['open@0', 'close@8', 'cb@16', 'handler@24', 'table@32', 'indirect@64'],
  });
  assert.equal(result.named.has('Handler'), false);
});

test('multi-dimensional arrays, enumerator-sized arrays and flexible array members', () => {
  const result = parse(`
    enum { ROWS = 2, COLS = ROWS + 1 };
    struct Grid { int cells[ROWS][COLS]; char tag[sizeof(long) * 2]; short n; };
    struct Packet { int length; char data[]; };
    struct Tail { char a; int values[]; };
    struct Zero { int x[0]; };
  `);
  assert.deepEqual(layout(result, 'Grid'), { size: 44n, fields: ['cells@0', 'tag@24', 'n@40'] });
  assert.deepEqual(definition(result, 'Grid$cells'), {
    kind: 'array',
    element: 'Grid$cells#1',
    count: 2n,
  });
  assert.deepEqual(definition(result, 'Grid$cells#1'), {
    kind: 'array',
    element: 'int32_t',
    count: 3n,
  });
  assert.deepEqual(definition(result, 'Grid$tag'), {
    kind: 'array',
    element: 'int8_t',
    count: 16n,
  });
  assert.deepEqual(definition(result, 'Packet$data'), {
    kind: 'array',
    element: 'int8_t',
    count: null,
  });
  assert.deepEqual(layout(result, 'Packet'), { size: 4n, fields: ['length@0', 'data@4'] });
  assert.deepEqual(layout(result, 'Tail'), { size: 4n, fields: ['a@0', 'values@4'] });
  assert.equal(definition(result, 'Zero$x').kind, 'array');
});

test('base type sizes follow the target ABI (LP64 vs LLP64) and long double', () => {
  const source = `
    struct Base {
      long l; unsigned long ul; long long ll; short s; unsigned char uc; signed char sc; char c;
      float f; double d; long double ld; size_t sz; ssize_t ssz; uintptr_t up; wchar_t w;
      _Bool b; void *p; int i;
    };
  `;
  const keys = (result: CParseResult): string[] =>
    structure(result, 'Base').fields.map((field) => field.type_id);
  const sysv = parse(source, SYSV);
  assert.deepEqual(keys(sysv), [
    'int64_t',
    'uint64_t',
    'int64_t',
    'int16_t',
    'uint8_t',
    'int8_t',
    'int8_t',
    'float',
    'double',
    'long double',
    'uint64_t',
    'int64_t',
    'uint64_t',
    'int32_t',
    'bool',
    'Base$p',
    'int32_t',
  ]);
  assert.deepEqual(definition(sysv, 'long double'), { kind: 'float', bits: 80 });
  assert.equal(structure(sysv, 'Base').fields.find((field) => field.name === 'ld')?.offset, 48n);
  assert.equal(structure(sysv, 'Base').alignment, 16);
  assert.equal(structure(sysv, 'Base').size, 112n);

  const darwin = parse(source, DARWIN);
  assert.equal(keys(darwin)[0], 'int64_t');
  assert.equal(keys(darwin)[9], 'double');
  assert.equal(structure(darwin, 'Base').alignment, 8);

  const windows = parse(source, WINDOWS);
  assert.deepEqual(keys(windows).slice(0, 3), ['int32_t', 'uint32_t', 'int64_t']);
  assert.equal(keys(windows)[9], 'double');
  assert.equal(keys(windows)[13], 'uint16_t');
  assert.deepEqual(definition(windows, 'int32_t'), { kind: 'integer', bits: 32, signed: true });
  assert.deepEqual(layout(windows, 'Base').fields.slice(0, 3), ['l@0', 'ul@4', 'll@8']);
});

test('long in an LLP64 struct is 4 bytes and 4-aligned', () => {
  const source = 'struct L { char a; long b; };';
  assert.equal(structure(parse(source, WINDOWS), 'L').size, 8n);
  assert.equal(structure(parse(source, SYSV), 'L').size, 16n);
});

test('qualifiers, calling conventions, comments and other preprocessor lines are ignored', () => {
  const result = parse(`
    #define N 4
    #ifdef FOO
    # include <stddef.h>
    #endif
    // line comment struct Bogus { int x; };
    /* block
       comment */
    typedef const volatile struct Q { const int a; volatile char * restrict b; } Q;
    static const int unused = 5;
    int helper(struct Q *q, int n) { return n; }
    extern int declared(int);
  `);
  assert.deepEqual(layout(result, 'Q'), { size: 16n, fields: ['a@0', 'b@8'] });
  assert.equal(result.named.has('Bogus'), false);
  assert.equal(result.named.has('helper'), false);
});

test('bit-fields are rejected with a position and do not hide later declarations', () => {
  const result = parseCDeclarations(
    ['struct Flags {', '  int a : 3;', '  int b;', '};', 'struct After { int z; };'].join('\n'),
    SYSV,
  );
  assert.deepEqual(result.diagnostics, [
    { message: 'bit-fields are not supported', line: 2, column: 9 },
  ]);
  assert.deepEqual(layout(result, 'After'), { size: 4n, fields: ['z@0'] });
  assert.ok(structure(result, 'Flags').fields.some((field) => field.name === 'b'));
  const unnamed = parseCDeclarations('struct U { int : 4; };', SYSV);
  assert.equal(unnamed.diagnostics.length, 1);
  assert.equal(unnamed.diagnostics[0]?.line, 1);
  assert.equal(unnamed.diagnostics[0]?.column, 16);
});

test('errors carry line and column, unknown names are diagnostics, and parsing continues', () => {
  const source = [
    'struct Good { int a; };', // 1
    'struct Bad { Mystery m; int ok; };', // 2
    'typedef struct Missing Ptr', // 3 (missing semicolon; the next declaration is swallowed by recovery)
    'struct Next { Good g; };', // 4
    'struct Dup { int a; int a; };', // 5
    'struct Inc { struct Good g; struct Inc self; };', // 6
    'struct Final { char c; };', // 7
  ].join('\n');
  const result = parseCDeclarations(source, SYSV);
  assert.deepEqual(
    result.diagnostics.map((d) => [d.line, d.column, d.message]),
    [
      [2, 14, "unknown type name 'Mystery'"],
      [4, 1, "expected ';', found 'struct'"],
      [5, 25, "duplicate member 'a'"],
      [6, 40, "member 'self' has incomplete type"],
    ],
  );
  assert.deepEqual(layout(result, 'Good'), { size: 4n, fields: ['a@0'] });
  assert.deepEqual(layout(result, 'Final'), { size: 1n, fields: ['c@0'] });
  assert.deepEqual(layout(result, 'Bad'), { size: 4n, fields: ['ok@0'] });
});

test('redefinitions and conflicting names are reported', () => {
  const result = parseCDeclarations(
    ['struct A { int x; };', 'struct A { int y; };', 'union A { int z; };', 'typedef int A;'].join(
      '\n',
    ),
    SYSV,
  );
  assert.deepEqual(
    result.diagnostics.map((d) => [d.line, d.message]),
    [
      [2, "redefinition of struct 'A'"],
      [3, "'A' is a struct, not a union"],
      [4, "'A' is already declared as struct A"],
    ],
  );
  assert.deepEqual(layout(result, 'A'), { size: 4n, fields: ['x@0'] });
});

test('lexical and syntax errors do not throw', () => {
  for (const source of [
    'struct {',
    'struct S { int a',
    'typedef',
    '@ struct S { int a; };',
    '/* unterminated',
    'int x[',
    'struct S { int a[-1]; };',
    'struct S { int a[N]; };',
    `typedef int ${'('.repeat(200)}x${')'.repeat(200)};`,
    `typedef int T; ${'struct A { '.repeat(300)}`,
    'struct S { void v; };',
    'struct S { long long long x; };',
  ]) {
    const result = parseCDeclarations(source, SYSV);
    assert.ok(result.diagnostics.length > 0, source);
    for (const diagnostic of result.diagnostics) {
      assert.ok(diagnostic.line >= 1 && diagnostic.column >= 1, source);
    }
  }
});

test('output is deterministic and lists dependencies before their users', () => {
  const source = `
    struct Inner { char c; };
    typedef struct Inner InnerT;
    struct Holder { InnerT inner; int *p; };
  `;
  const first = parse(source);
  const second = parse(source);
  assert.deepEqual(
    first.types.map((type) => type.key),
    second.types.map((type) => type.key),
  );
  const keys = first.types.map((type) => type.key);
  assert.ok(keys.indexOf('Inner') < keys.indexOf('Holder'));
  assert.ok(keys.indexOf('int32_t') < keys.indexOf('Holder$p'));
  assert.ok(keys.indexOf('Holder$p') < keys.indexOf('Holder'));
});

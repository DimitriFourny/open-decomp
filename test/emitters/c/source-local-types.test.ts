import assert from 'node:assert/strict';
import test from 'node:test';
import { windowsX64Abi } from '../../../src/abi/windows-x64/index.js';
import { recoverTypes } from '../../../src/analysis/types/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { createOperationContext, type Address, type Emission } from '../../../src/core/index.js';
import { integer, type SSAForm, type Value } from '../../../src/ir/index.js';
import { recoverLibraryContracts } from '../../../src/metadata/library-contracts/index.js';
import { navigationBytes } from '../../analysis/navigation-fixture.js';
import { builder, register } from '../../ir/support.js';
import { pointerAssignable } from '../../../src/emitters/expressions.js';
import type { IntegerPredicate } from '../../../src/ir/index.js';
import { emit, emittedFormals, execute, type SourceCallOracle } from './support.js';

const i64 = integer(64);
const rcx = register('rcx', 64, 0, 'replace_root', 'x86_64:rcx');
const rdx = register('rdx', 64, 0, 'replace_root', 'x86_64:rdx');
const rax = register('rax', 64, 0, 'replace_root', 'x86_64:rax');

/** `p = *(uint64_t *)arg0` (a 64-bit field), passed to each ucrtbase function in
 * order as its first argument; the returned value is the sum of the results plus
 * `p + addend` when `addend` is given. `p` is read several times, so it is a local. */
function program(calls: readonly string[], addend?: bigint, unused: readonly string[] = []) {
  const base = navigationBytes(Uint8Array.of(0xc3), Buffer.alloc(16));
  const loaded = {
    ...base,
    imports: calls.map((name, index) => ({
      id: `${name}-import-${index}`,
      original_name: name,
      display_name: null,
      library: 'ucrtbase.dll',
      ordinal: null,
      slot: null,
      callable_entry: {
        image_id: base.id,
        space: 'va' as const,
        value: 0x1000n + BigInt(index) * 16n,
      },
      delayed: false,
      weak: false,
      evidence_ids: [`${name}-binding-${index}`],
    })),
  };
  const library = recoverLibraryContracts(
    { image: loaded, abi: windowsX64Abi, revision: 0 },
    createOperationContext(),
  );
  const b = builder('local-types'),
    block = b.block('entry');
  const formal = block.readRegister(rcx);
  const pointer = block.load(i64, formal);
  let sum: Value | undefined;
  calls.forEach((_, index) => {
    block.writeRegister(rcx, pointer);
    block.writeRegister(rdx, block.constant(i64, 0n));
    const target: Address = {
      image_id: base.id,
      space: 'va',
      value: 0x1000n + BigInt(index) * 16n,
    };
    block.call({ kind: 'direct', address: target }, [], [], windowsX64Abi.unknown_call_clobbers);
    if (unused.includes(calls[index]!)) return;
    const result = block.readRegister(rax);
    sum = sum ? block.int('add', sum, result) : result;
  });
  const returned =
    addend === undefined
      ? sum!
      : block.int('add', sum!, block.int('add', pointer, block.constant(i64, addend)));
  block.return([returned]);
  const ir = constructSSA(b.finish(block, [i64])).value as SSAForm;
  const types = recoverTypes(ir, windowsX64Abi, createOperationContext(), {
    image_id: base.id,
    slice_id: base.selected_slice_id,
    revision: 0,
    library,
  });
  const names = ir.blocks[0]!.instructions.filter((node) => node.kind === 'call').map(
    (node, index) => ({ entity_id: node.id, name: calls[index]! }),
  );
  return (language: 'c-like' | 'python-like') =>
    emit(ir, { types, source: { abi: windowsX64Abi, callees: [], addresses: [] }, names }, language)
      .emission;
}

const FIELD = 0x3000n,
  STRING = 0x5000n;
/** Run the emitted program: `arg0` points at a field holding `STRING`. */
function run(emission: Emission, calls: Record<string, bigint>) {
  const formal = emittedFormals(emission)[0]!;
  const memory = new Map<bigint, number>();
  for (let byte = 0; byte < 8; byte++)
    memory.set(FIELD + BigInt(byte), Number((STRING >> BigInt(byte * 8)) & 255n));
  const seen: bigint[] = [];
  const oracles = new Map<string, SourceCallOracle>(
    Object.entries(calls).map(([name, result]) => [
      name,
      (args) => {
        seen.push(args[0]!);
        return result;
      },
    ]),
  );
  const observed = execute(
    emission,
    new Map(formal.semantic_ids.map((id) => [id, FIELD])),
    memory,
    0n,
    new Map(),
    new Map(),
    oracles,
  );
  return { observed, seen };
}

for (const language of ['c-like', 'python-like'] as const) {
  const pointer = language === 'c-like' ? 'const char*' : 'pointer[char]';

  test(`${language} a local only passed as a typed library pointer takes that pointer type`, () => {
    const emission = program(['strlen', 'strchr'], undefined, ['strchr'])(language);
    const text = emission.text;
    assert.match(
      text,
      language === 'c-like' ? /\bconst char\* \w+;/ : /\w+: pointer\[char\]$/m,
      text,
    );
    // Every argument is the pointer variable itself: no integer round trip.
    assert.doesNotMatch(text, /uintptr_t\)\(?\w+\)?\)?,/, text);
    if (language === 'c-like') {
      assert.match(text, /strlen\(\w+\)/, text);
      assert.doesNotMatch(text, /\(const char\*\)\(uintptr_t\)/, text);
    }
    assert.ok(emission.local_validation?.some((record) => record.rule === 'local_source_type'));
    // The loaded field converts to the pointer once; both calls receive its exact bits.
    const { observed, seen } = run(emission, { strlen: 3n, strchr: 4n });
    assert.deepEqual(observed.values, [3n]);
    assert.deepEqual(seen, [STRING, STRING]);
  });

  test(`${language} conflicting pointer uses keep the integer type and an explicit conversion per call`, () => {
    const emission = program(['strlen', 'fclose'], undefined, ['fclose'])(language);
    const text = emission.text;
    assert.doesNotMatch(
      text,
      language === 'c-like' ? /const char\* \w+;/ : /: pointer\[char\]$/m,
      text,
    );
    assert.match(text, language === 'c-like' ? /uint64_t \w+;/ : /\w+: uint64_t$/m, text);
    assert.ok(!emission.local_validation?.some((record) => record.rule === 'local_source_type'));
    const { observed, seen } = run(emission, { strlen: 3n, fclose: 4n });
    assert.deepEqual(observed.values, [3n], text);
    assert.deepEqual(seen, [STRING, STRING]);
  });

  test(`${language} arithmetic on a typed local stays integer arithmetic: no pointer scaling`, () => {
    // Three typed uses outweigh one integer use and the untyped load: p is `${pointer}`,
    // and `p + 8` is computed on its address bits (`(uintptr_t)p + 8`), never as
    // scaled pointer arithmetic.
    const emission = program(['strlen', 'strchr', 'strrchr'], 8n, ['strchr', 'strrchr'])(language);
    const text = emission.text;
    assert.match(
      text,
      language === 'c-like' ? /\(uintptr_t\)\w+ \+ 8/ : /\w+ \+ 8/,
      `${pointer}\n${text}`,
    );
    const { observed } = run(emission, { strlen: 3n, strchr: 4n, strrchr: 5n });
    assert.deepEqual(observed.values, [3n + STRING + 8n]);
    // Two typed uses against one integer use and the untyped load do not pay for the declaration.
    const mixed = program(['strlen', 'strchr'], 8n, ['strchr'])(language);
    assert.doesNotMatch(
      mixed.text,
      language === 'c-like' ? /const char\* \w+;/ : /: pointer\[char\]$/m,
    );
    assert.deepEqual(run(mixed, { strlen: 3n, strchr: 4n }).observed.values, [3n + STRING + 8n]);
  });
}

const eax = register('eax', 32, 0, 'zero_extend_root', 'x86_64:rax');

/** `r = fclose(*arg0)` (a signed `int32_t` library result), then `r <op> bound` selects 1 or 2. */
function signedResult(op: IntegerPredicate, bound: bigint) {
  const base = navigationBytes(Uint8Array.of(0xc3), Buffer.alloc(16));
  const loaded = {
    ...base,
    imports: [
      {
        id: 'fclose-import',
        original_name: 'fclose',
        display_name: null,
        library: 'ucrtbase.dll',
        ordinal: null,
        slot: null,
        callable_entry: { image_id: base.id, space: 'va' as const, value: 0x1000n },
        delayed: false,
        weak: false,
        evidence_ids: ['fclose-binding'],
      },
    ],
  };
  const library = recoverLibraryContracts(
    { image: loaded, abi: windowsX64Abi, revision: 0 },
    createOperationContext(),
  );
  const b = builder('signed-compare'),
    entry = b.block('entry'),
    yes = b.block('yes'),
    no = b.block('no');
  entry.writeRegister(rcx, entry.readRegister(rcx));
  const target: Address = { image_id: base.id, space: 'va', value: 0x1000n };
  entry.call({ kind: 'direct', address: target }, [], [], windowsX64Abi.unknown_call_clobbers);
  const result = entry.readRegister(eax);
  entry.branch(
    entry.compare(op, result, entry.constant(integer(32), bound)),
    entry.edge(yes),
    entry.edge(no),
  );
  yes.return([yes.constant(i64, 1n)]);
  no.return([no.constant(i64, 2n)]);
  const ir = constructSSA(b.finish(entry, [i64])).value as SSAForm;
  const types = recoverTypes(ir, windowsX64Abi, createOperationContext(), {
    image_id: base.id,
    slice_id: base.selected_slice_id,
    revision: 0,
    library,
  });
  const names = ir.blocks[0]!.instructions.filter((node) => node.kind === 'call').map((node) => ({
    entity_id: node.id,
    name: 'fclose',
  }));
  return (language: 'c-like' | 'python-like') =>
    emit(ir, { types, source: { abi: windowsX64Abi, callees: [], addresses: [] }, names }, language)
      .emission;
}

for (const language of ['c-like', 'python-like'] as const) {
  const runWith = (emission: Emission, value: bigint) =>
    execute(
      emission,
      new Map(emittedFormals(emission)[0]!.semantic_ids.map((id) => [id, 0x1234n])),
      new Map(),
      0n,
      new Map(),
      new Map(),
      new Map<string, SourceCallOracle>([['fclose', () => value]]),
    ).values;
  test(`${language} equality of a signed library result drops the unsigned reinterpretation only in C`, () => {
    const emission = signedResult('eq', 0n)(language);
    // C converts the signed operand to the unsigned type of the same bits; Python
    // integers do not, so the python-like text keeps its explicit reduction. The
    // single-use result may print as the call itself.
    if (language === 'c-like')
      assert.doesNotMatch(emission.text, /\(uint32_t\)(?:\w+|fclose\(.*\)) ==/, emission.text);
    else assert.match(emission.text, /uint32\((?:\w+|fclose\(.*\))\) == 0/, emission.text);
    for (const [value, expected] of [
      [0n, 1n],
      [1n, 2n],
      [0xffffffffn, 2n],
    ] as const)
      assert.deepEqual(runWith(emission, value), [expected], `${value}`);
  });

  test(`${language} an unsigned ordered comparison of a signed result keeps its conversion`, () => {
    // -1 as int32_t is 0xffffffff: `ult 5` is false. Without the conversion C
    // would compare the signed value, true, and take the other branch.
    const unsigned = signedResult('ult', 5n)(language);
    assert.match(
      unsigned.text,
      language === 'c-like'
        ? /\(uint32_t\)(?:\w+|fclose\(.*\)) < 5/
        : /uint32\((?:\w+|fclose\(.*\))\) < 5/,
      unsigned.text,
    );
    for (const [value, expected] of [
      [0xffffffffn, 2n],
      [4n, 1n],
      [5n, 2n],
    ] as const)
      assert.deepEqual(runWith(unsigned, value), [expected], `ult ${value}`);
    const signed = signedResult('slt', 5n)(language);
    for (const [value, expected] of [
      [0xffffffffn, 1n],
      [4n, 1n],
      [5n, 2n],
    ] as const)
      assert.deepEqual(runWith(signed, value), [expected], `slt ${value}`);
  });
}

test('implicit pointer conversions: same type, void and added const only', () => {
  assert.ok(pointerAssignable('char*', 'char*'));
  assert.ok(pointerAssignable('char*', 'const char*'));
  assert.ok(!pointerAssignable('const char*', 'char*'), 'never drops const');
  assert.ok(pointerAssignable('FILE*', 'void*'));
  assert.ok(pointerAssignable('void*', 'FILE*'));
  assert.ok(!pointerAssignable('uint8_t*', 'char*'), 'distinct pointee types convert explicitly');
});

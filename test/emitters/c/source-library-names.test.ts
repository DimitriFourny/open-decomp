import assert from 'node:assert/strict';
import test from 'node:test';
import { windowsX64Abi } from '../../../src/abi/windows-x64/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { recoverTypes } from '../../../src/analysis/types/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { createOperationContext, type Address } from '../../../src/core/index.js';
import { integer, type SSAForm, type Value } from '../../../src/ir/index.js';
import { findDeclaration } from '../../../src/metadata/library-contracts/catalog.js';
import { recoverLibraryContracts } from '../../../src/metadata/library-contracts/index.js';
import {
  libraryParameterStem,
  libraryCallNames,
} from '../../../src/reconstruction/library-names.js';
import type { SourceAddress } from '../../../src/reconstruction/source-model.js';
import { navigationBytes } from '../../analysis/navigation-fixture.js';
import { builder, register } from '../../ir/support.js';
import { emit } from './support.js';

const i32 = integer(32),
  i64 = integer(64);
const rcx = register('rcx', 64, 0, 'replace_root', 'x86_64:rcx');
const rdx = register('rdx', 64, 0, 'replace_root', 'x86_64:rdx');

/** Header parameter stem of a ucrtbase function's `index`th parameter. */
function declared(name: string, index: number): string | undefined {
  const entry = findDeclaration(name, 'ucrtbase.dll', 'pe')!;
  return libraryParameterStem(entry.parameters[index]![0]);
}

/** One block calling the imported ucrtbase functions in order; each call's first
 * argument is the formal `rcx` unless `chain` feeds it the previous call's result. */
function libraryProgram(
  calls: readonly { name: string; chain?: boolean; second?: bigint }[],
): { text: string; python: string } {
  const base = navigationBytes(Uint8Array.of(0xc3), Buffer.alloc(16));
  const loaded = {
    ...base,
    imports: calls.map((call, index) => ({
      id: `${call.name}-import`,
      original_name: call.name,
      display_name: null,
      library: 'ucrtbase.dll',
      ordinal: null,
      slot: null,
      callable_entry: { image_id: base.id, space: 'va' as const, value: 0x1000n + BigInt(index) * 16n },
      delayed: false,
      weak: false,
      evidence_ids: [`${call.name}-binding`],
    })),
  };
  const library = recoverLibraryContracts(
    { image: loaded, abi: windowsX64Abi, revision: 0 },
    createOperationContext(),
  );
  const b = builder('library-names'),
    block = b.block('entry');
  const formal = block.readRegister(rcx);
  let previous: Value = formal;
  const ids: string[] = [];
  calls.forEach((call, index) => {
    block.writeRegister(rcx, call.chain ? previous : formal);
    block.writeRegister(rdx, block.constant(i64, call.second ?? 0n));
    const target: Address = { image_id: base.id, space: 'va', value: 0x1000n + BigInt(index) * 16n };
    block.call({ kind: 'direct', address: target }, [], [], windowsX64Abi.unknown_call_clobbers);
    ids.push(call.name);
    previous = block.readRegister(register('rax', 64, 0, 'replace_root', 'x86_64:rax'));
  });
  // The last result is used twice, so it is a named local rather than an inline call.
  block.return([block.int('add', previous, previous)]);
  const ir = constructSSA(b.finish(block, [i64])).value as SSAForm;
  const types = recoverTypes(ir, windowsX64Abi, createOperationContext(), {
    image_id: base.id,
    slice_id: base.selected_slice_id,
    revision: 0,
    library,
  });
  const names = ir.blocks[0]!.instructions
    .filter((node) => node.kind === 'call')
    .map((node, index) => ({ entity_id: node.id, name: calls[index]!.name }));
  const run = (language: 'c-like' | 'python-like') =>
    emit(ir, { types, source: { abi: windowsX64Abi, callees: [], addresses: [] }, names }, language)
      .emission.text;
  return { text: run('c-like'), python: run('python-like') };
}

test('library parameter stems drop reserved underscores and uninformative names', () => {
  assert.equal(libraryParameterStem('__filename'), 'filename');
  assert.equal(libraryParameterStem('s'), 's');
  for (const meaningless of ['a1', 'arg', 'arg3', 'p', 'ptr', '_', '', '9x', 'a b'])
    assert.equal(libraryParameterStem(meaningless), undefined, meaningless);
});

test('a library result takes its curated role or declared type, else the callee', () => {
  assert.match(libraryProgram([{ name: 'strlen' }]).text, /\blength\b/, 'curated role');
  const stream = libraryProgram([{ name: 'fopen' }]);
  assert.match(stream.text, /\bstream\b/, 'FILE* result type');
  assert.match(stream.python, /\bstream\b/);
  assert.doesNotMatch(stream.text, /call_result/);
  const other = libraryProgram([{ name: 'toupper' }]);
  assert.match(other.text, /toupper_result/, 'callee fallback');
  assert.match(other.python, /toupper_result/, 'both dialects');
});

test('a value passed to library parameters takes the one name they agree on', () => {
  const agree = libraryProgram([{ name: 'strlen' }, { name: 'strlen' }]);
  const stem = declared('strlen', 0);
  assert.ok(stem);
  assert.match(agree.text, new RegExp(`\\(${stem}[,:)]|\\b${stem}\\b`));
  // fopen's and strlen's first parameters are named differently: the shared
  // formal has no single name and stays neutral.
  const first = declared('fopen', 0);
  assert.notEqual(first, stem);
  const conflict = libraryProgram([{ name: 'strlen' }, { name: 'fopen' }]);
  const header = /^[^\n]*\bWriteOutput|^[^\n]*\blibrary_names?\b|^[^\n]*\bfn\w*\(([^)]*)\)/m.exec(
    conflict.text,
  );
  void header;
  const signature = conflict.text.split('\n').find((line) => /\(.*\)\s*\{$/.test(line))!;
  assert.doesNotMatch(signature, new RegExp(`\\b(?:${stem}|${first})\\b`), signature);
});

test('library contracts name nothing when none establishes the call', () => {
  assert.equal(libraryCallNames(undefined).size, 0);
});

/* ------------------------------------------------------------ typed data */

const IMAGE = navigationBytes(Uint8Array.of(0xc3), Buffer.alloc(16)).id;
const SLOT: Address = { image_id: IMAGE, space: 'va', value: 0x2010n };
function slot(variable?: NonNullable<SourceAddress['import']>['variable']): SourceAddress {
  return {
    address: SLOT,
    object: {
      address: SLOT,
      byte_length: 8n,
      offset: 0n,
      mutable: true,
      kind: 'bytes',
      evidence_ids: ['slot-evidence'],
    },
    import: {
      id: 'import-stderr',
      name: '___stderrp',
      source_name: '__stderrp',
      library: '/usr/lib/libSystem.B.dylib',
      evidence_ids: ['bind-evidence'],
      ...(variable ? { variable } : {}),
    },
  };
}
const FILE_POINTER = {
  type: { kind: 'pointer', to: { kind: 'opaque', name: 'FILE' } } as const,
  constant: false,
  source: 'test header',
};
function dataProgram(store: boolean): SSAForm {
  const b = builder('typed-data'),
    block = b.block('entry');
  const pointer = block.load(i64, block.address(SLOT));
  if (store) block.store(pointer, block.constant(i64, 0n));
  block.return([block.load(i64, pointer)]);
  return constructSSA(b.finish(block, [i64])).value as SSAForm;
}

for (const language of ['c-like', 'python-like'] as const) {
  test(`${language} a header-declared pointer import is typed and read as its address bits`, () => {
    const text = emit(
      dataProgram(false),
      { source: { abi: sysvAMD64Abi, callees: [], addresses: [slot(FILE_POINTER)] } },
      language,
    ).emission.text;
    if (language === 'c-like') {
      assert.match(text, /extern FILE\* __stderrp;/);
      assert.match(text, /typedef struct FILE FILE;/);
      assert.match(text, /return \(uintptr_t\)__stderrp;/);
    } else assert.match(text, /import_view\("[^"]*", "___stderrp", "pointer\[FILE\]"\)/);
  });

  test(`${language} a pointer import the function writes keeps its access type`, () => {
    const text = emit(
      dataProgram(true),
      { source: { abi: sysvAMD64Abi, callees: [], addresses: [slot(FILE_POINTER)] } },
      language,
    ).emission.text;
    assert.doesNotMatch(text, /FILE/);
    assert.match(text, /uint64_t/);
  });
}

test('an import without a header declaration keeps its observed-access type', () => {
  const text = emit(
    dataProgram(false),
    { source: { abi: sysvAMD64Abi, callees: [], addresses: [slot()] } },
    'c-like',
  ).emission.text;
  assert.match(text, /extern uint64_t __stderrp;/);
});

/* ------------------------------------------------------- constant returns */

function exits(second: 'constant' | 'variable'): SSAForm {
  const b = builder('constant-exits'),
    entry = b.block('entry', [i32]),
    outer = b.block('outer', [i32]),
    inner = b.block('inner', [i32, i32]),
    step = b.block('step', [i32, i32]),
    done = b.block('done', [i32]);
  const limit = entry.parameters[0]!;
  entry.jump(outer, [entry.constant(i32, 0n)]);
  const row = outer.parameters[0]!;
  outer.branch(
    outer.compare('eq', row, outer.constant(i32, 3n)),
    outer.edge(done, [outer.constant(i32, 0n)]),
    outer.edge(inner, [row, outer.constant(i32, 0n)]),
  );
  const [i, j] = inner.parameters as [Value, Value];
  inner.store(inner.constant(i64, 0x1000n), inner.int('add', i, j));
  inner.branch(
    inner.compare('eq', inner.int('add', i, j), limit),
    inner.edge(done, [second === 'constant' ? inner.constant(i32, 1n) : inner.int('add', j, i)]),
    inner.edge(step, [i, j]),
  );
  const [si, sj] = step.parameters as [Value, Value];
  step.branch(
    step.compare('eq', sj, step.constant(i32, 1n)),
    step.edge(outer, [step.int('add', si, step.constant(i32, 1n))]),
    step.edge(inner, [si, step.int('add', sj, step.constant(i32, 1n))]),
  );
  done.return(done.parameters);
  return constructSSA(b.finish(entry, [i32])).value as SSAForm;
}

for (const language of ['c-like', 'python-like'] as const) {
  test(`${language} a carrier written only from constants on duplicated return edges is the constant`, () => {
    const text = emit(
      exits('constant'),
      { source: { abi: sysvAMD64Abi, callees: [], addresses: [] } },
      language,
    ).emission.text;
    assert.match(text, /return 1\b/, 'the exit followed by its own return copy returns the constant');
    assert.doesNotMatch(text, /result = 1\b/);
    // The loop exit that still reaches the shared return keeps its carrier copy.
    assert.match(text, /result = 0\b/);
  });

  test(`${language} an edge that writes a computed value keeps the carrier for that edge`, () => {
    const text = emit(
      exits('variable'),
      { source: { abi: sysvAMD64Abi, callees: [], addresses: [] } },
      language,
    ).emission.text;
    assert.doesNotMatch(text, /return 1\b/);
    assert.match(text, /result = 0\b/);
    assert.match(text, /\breturn \w+/);
  });
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { windowsX64Abi } from '../../../src/abi/windows-x64/index.js';
import { observePreparedTailInterfaces } from '../../../src/analysis/calls/observed.js';
import { recoverTypes } from '../../../src/analysis/types/index.js';
import { recoverLibraryContracts } from '../../../src/metadata/library-contracts/index.js';
import { recoverDataAddress } from '../../../src/analysis/strings/source-data.js';
import { navigationBytes } from '../../analysis/navigation-fixture.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import {
  createOperationContext,
  globalDataIdentity,
  type Address,
} from '../../../src/core/index.js';
import { characterLiteral, stringLiteral } from '../../../src/emitters/string-literals.js';
import { integer, type IRBuilder, type RegisterIR, type SSAForm } from '../../../src/ir/index.js';
import type { SourceAddress } from '../../../src/reconstruction/source-model.js';
import { constantCandidates } from '../../../src/service/analysis/source-variadic.js';
import { registerConstantCandidates } from '../../../src/service/analysis/source-literal-candidates.js';
import { sourceConstantValues } from '../../../src/reconstruction/source-data.js';
import { builder, image, register, slice } from '../../ir/support.js';
import { emit } from './support.js';

const languages = ['c-like', 'python-like'] as const;
const i8 = integer(8),
  i32 = integer(32),
  i64 = integer(64);
const at = (value: bigint): Address => ({ image_id: image, space: 'va', value });
const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');
const rsi = register('rsi', 64, 0, 'replace_root', 'x86_64:rsi');

function stringAt(value: bigint, text: string, mutable = false, start = true): SourceAddress {
  return {
    address: at(value),
    string: text,
    string_byte_length: BigInt(Buffer.byteLength(text)),
    string_encoding: /^[\x00-\x7f]*$/.test(text) ? 'ascii' : 'utf8',
    ...(start ? { string_start: true as const } : {}),
    object: {
      address: at(value),
      entity_id: globalDataIdentity(slice, at(value)),
      byte_length: null,
      offset: 0n,
      mutable,
      kind: 'bytes',
      evidence_ids: [],
    },
  };
}

function ssa(build: (b: IRBuilder<'register'>) => RegisterIR, name: string): SSAForm {
  const b = builder(name);
  const form = constructSSA(build(b)).value;
  assert.equal(form.form, 'ssa');
  return form as SSAForm;
}

/** `(rdi == 0) ? <address> : rdi`, stored to *rsi and returned. */
function selected(target: Address) {
  return ssa((b) => {
    const entry = b.block('entry');
    const p = entry.readRegister(rdi);
    const out = entry.readRegister(rsi);
    const choice = entry.select(
      entry.compare('eq', p, entry.constant(i64, 0n)),
      entry.address(target),
      p,
    );
    entry.store(out, choice);
    entry.return([choice]);
    return b.finish(entry, [i64]);
  }, 'literal-select');
}

test('string escaping follows the dialect and bounds long strings', () => {
  const awkward = 'a"b\\c\n\0é\u0001??-*/\u202e';
  const c = stringLiteral(awkward, 'c-like');
  assert.equal(c.omitted_bytes, 0);
  assert.equal(c.text, '"a\\"b\\\\c\\n\\0\u00e9\\001?\\?-*\\057\\342\\200\\256"');
  const py = stringLiteral(awkward, 'python-like');
  assert.equal(py.text, '"a\\"b\\\\c\\n\\u0000\u00e9\\u0001??-*\\u002f\\u202e"');
  // A NUL before an octal digit must not merge with it.
  assert.equal(stringLiteral('\x001', 'c-like').text, '"\\0001"');
  const long = stringLiteral('x'.repeat(250), 'c-like', 100);
  assert.equal(long.text, `"${'x'.repeat(100)}"`);
  assert.equal(long.omitted_bytes, 150);
});

test('character constants need a printable code or a standard escape', () => {
  assert.equal(characterLiteral(47n, 'c-like', false), "'/'");
  assert.equal(characterLiteral(92n, 'c-like', false), "'\\\\'");
  assert.equal(characterLiteral(39n, 'c-like', false), "'\\''");
  assert.equal(characterLiteral(10n, 'c-like', false), undefined);
  assert.equal(characterLiteral(10n, 'c-like', true), "'\\n'");
  assert.equal(characterLiteral(0n, 'c-like', true), "'\\0'");
  assert.equal(characterLiteral(0n, 'c-like', false), undefined);
  assert.equal(characterLiteral(0x80n, 'c-like', true), undefined);
  assert.equal(characterLiteral(47n, 'python-like', false), "ord('/')");
  assert.equal(characterLiteral(92n, 'python-like', true), "ord('\\\\')");
});

for (const language of languages)
  test(`${language} constant addressing an immutable string is a literal in value positions`, () => {
    const output = emit(
      selected(at(0x2000n)),
      { source: { abi: sysvAMD64Abi, callees: [], addresses: [stringAt(0x2000n, 'con')] } },
      language,
    );
    assert.match(output.emission.text, /"con"/);
    assert.doesNotMatch(output.emission.text, /0x2000/);
    // Both the stored and the returned value show the literal, and the string
    // address stays reachable from the mappings' evidence.
    assert.ok(output.emission.text.split('"con"').length >= 2);
  });

for (const language of languages)
  test(`${language} interior string addresses and the empty string`, () => {
    const interior = emit(
      selected(at(0x2001n)),
      {
        source: {
          abi: sysvAMD64Abi,
          callees: [],
          addresses: [stringAt(0x2001n, 'on', false, false)],
        },
      },
      language,
    );
    assert.match(interior.emission.text, /"on"/);
    // The empty string is not announced without a character-pointer context.
    const empty = emit(
      selected(at(0x2000n)),
      { source: { abi: sysvAMD64Abi, callees: [], addresses: [stringAt(0x2000n, '')] } },
      language,
    );
    assert.doesNotMatch(empty.emission.text, /""/);
  });

for (const language of languages)
  test(`${language} writable or unterminated storage never prints as a literal`, () => {
    const mutable = emit(
      selected(at(0x2000n)),
      {
        source: { abi: sysvAMD64Abi, callees: [], addresses: [stringAt(0x2000n, 'con', true)] },
      },
      language,
    );
    assert.doesNotMatch(mutable.emission.text, /"con"/);
    const { string: _string, ...bare } = stringAt(0x2000n, 'con');
    const unknown = emit(
      selected(at(0x2000n)),
      { source: { abi: sysvAMD64Abi, callees: [], addresses: [bare] } },
      language,
    );
    assert.doesNotMatch(unknown.emission.text, /"con"/);
  });

for (const language of languages)
  test(`${language} string address used as arithmetic stays an integer`, () => {
    const output = emit(
      ssa((b) => {
        const entry = b.block('entry');
        const p = entry.readRegister(rdi);
        entry.return([entry.int('add', p, entry.address(at(0x2000n)))]);
        return b.finish(entry, [i64]);
      }, 'literal-arith'),
      { source: { abi: sysvAMD64Abi, callees: [], addresses: [stringAt(0x2000n, 'con')] } },
      language,
    );
    assert.doesNotMatch(output.emission.text, /"con"/);
  });

/** `byte = *rdi; return byte == 0x2f ? (byte - 0x30) : byte == 0x5c`. */
function loaded(viaPointer: boolean) {
  return ssa((b) => {
    const entry = b.block('entry');
    const p = entry.readRegister(rdi);
    const byte = viaPointer
      ? entry.load(i8, p)
      : entry.cast('truncate', i8, entry.readRegister(rsi));
    const wide = entry.cast('zero_extend', i32, byte);
    const slash = entry.compare('eq', wide, entry.constant(i32, 0x2fn));
    const digit = entry.int('sub', wide, entry.constant(i32, 0x30n));
    const choice = entry.select(
      slash,
      digit,
      entry.cast('zero_extend', i32, entry.compare('eq', wide, entry.constant(i32, 0x5cn))),
    );
    entry.return([choice]);
    return b.finish(entry, [i32]);
  }, `char-${viaPointer}`);
}

for (const language of languages)
  test(`${language} constants combined with a byte loaded through a pointer print as characters`, () => {
    const text = emit(
      loaded(true),
      { source: { abi: sysvAMD64Abi, callees: [], addresses: [] } },
      language,
    ).emission.text;
    const slash = language === 'c-like' ? "'/'" : "ord('/')";
    const backslash = language === 'c-like' ? "'\\\\'" : "ord('\\\\')";
    const zero = language === 'c-like' ? "'0'" : "ord('0')";
    assert.ok(text.includes(slash), text);
    assert.ok(text.includes(backslash), text);
    assert.ok(text.includes(zero), text);
    assert.doesNotMatch(text, /\b47\b|0x2f|\b92\b|0x5c/);
  });

for (const language of languages)
  test(`${language} an integer without character evidence keeps its decimal constant`, () => {
    const text = emit(
      loaded(false),
      { source: { abi: sysvAMD64Abi, callees: [], addresses: [] } },
      language,
    ).emission.text;
    assert.doesNotMatch(text, /'\/'|ord\('/);
    assert.match(text, /0x2f|\b47\b/);
  });

/** A direct call of the imported ucrtbase `name`, with `rcx`/`rdx` set. */
function importedCall(name: string, first: 'string' | bigint, second: bigint): string {
  const base = navigationBytes(Uint8Array.of(0xc3), Buffer.from('a/b\0'));
  const target = { image_id: base.id, space: 'va' as const, value: 0x1000n };
  const text = { ...target, value: 0x2000n };
  const loaded = {
    ...base,
    mappings: base.mappings.map((mapping) => ({ ...mapping, permissions: ['read'] as const })),
    sections: base.sections.map((section) => ({ ...section, permissions: ['read'] as const })),
    imports: [
      {
        id: `${name}-import`,
        original_name: name,
        display_name: null,
        library: 'ucrtbase.dll',
        ordinal: null,
        slot: null,
        callable_entry: target,
        delayed: false,
        weak: false,
        evidence_ids: [`${name}-binding`],
      },
    ],
  };
  const library = recoverLibraryContracts(
    { image: loaded, abi: windowsX64Abi, revision: 0 },
    createOperationContext(),
  );
  const string = recoverDataAddress(loaded, text, createOperationContext())!;
  const b = builder(`library-${name}`),
    block = b.block('entry');
  block.writeRegister(
    register('rcx', 64, 0, 'replace_root', 'x86_64:rcx'),
    first === 'string' ? block.address(text) : block.constant(i64, first),
  );
  block.writeRegister(
    register('rdx', 64, 0, 'replace_root', 'x86_64:rdx'),
    block.constant(i64, second),
  );
  block.call({ kind: 'direct', address: target }, [], [], windowsX64Abi.unknown_call_clobbers);
  block.return([block.constant(i32, 0n)]);
  const ir = constructSSA(b.finish(block, [i32])).value as SSAForm;
  const types = recoverTypes(ir, windowsX64Abi, createOperationContext(), {
    image_id: base.id,
    slice_id: base.selected_slice_id,
    revision: 0,
    library,
  });
  const call = ir.blocks[0]!.instructions.find((node) => node.kind === 'call')!;
  return emit(
    ir,
    {
      types,
      source: { abi: windowsX64Abi, callees: [], addresses: [string] },
      names: [{ entity_id: call.id, name }],
    },
    'c-like',
  ).emission.text;
}

test('library character parameters take character constants; other int parameters do not', () => {
  assert.match(importedCall('strchr', 'string', 47n), /strchr\("a\/b", '\/'\)/);
  assert.match(importedCall('toupper', 0x61n, 0n), /toupper\('a'\)/);
  assert.match(importedCall('putchar', 10n, 0n), /putchar\('\\n'\)/);
  // labs takes a long, not a character code.
  const number = importedCall('labs', 47n, 0n);
  assert.doesNotMatch(number, /'\/'/);
  assert.match(number, /labs\((?:0x2f|47)/);
});

/** `rdi` is two 32-bit cells: arm A writes the address `0x2000`, arm B a loaded value. The join
 * leaves (`g(rdi, rsi, rdx)`: `push rdx; ...; add rsp, 8; jmp rax`) through a tail call that passes
 * the whole register as its first argument. */
function partlyConstant() {
  const low = register('edi', 32, 0, 'preserve_other_bits', 'x86_64:rdi'),
    high = register('rdi_high', 32, 32, 'preserve_other_bits', 'x86_64:rdi');
  const rdx = register('rdx', 64, 0, 'replace_root', 'x86_64:rdx'),
    rax = register('rax', 64, 0, 'replace_root', 'x86_64:rax'),
    rsp = register('rsp', 64, 0, 'replace_root', 'x86_64:rsp');
  return ssa((b) => {
    const entry = b.block('entry'),
      constant = b.block('constant'),
      other = b.block('other'),
      done = b.block('done');
    const sp0 = entry.readRegister(rsp);
    const pushed = entry.int('sub', sp0, entry.constant(i64, 8n));
    entry.writeRegister(rsp, pushed);
    entry.store(pushed, entry.readRegister(rdx));
    const p = entry.readRegister(rsi);
    entry.branch(
      entry.compare('eq', p, entry.constant(i64, 0n)),
      entry.edge(constant),
      entry.edge(other),
    );
    constant.writeRegister(low, constant.constant(i32, 0x2000n));
    constant.writeRegister(high, constant.constant(i32, 0n));
    constant.jump(done);
    const loadedValue = other.load(i64, other.readRegister(rsi));
    other.writeRegister(low, other.extract(loadedValue, 0, 32));
    other.writeRegister(high, other.extract(loadedValue, 32, 32));
    other.jump(done);
    done.writeRegister(rax, done.readRegister(rsi));
    done.writeRegister(rsp, sp0);
    done.terminate({
      kind: 'indirect',
      target: done.readRegister(rax),
      reason: 'Indirect branch target is unresolved',
    });
    return b.finish(entry, []);
  }, 'partly-constant');
}

/** The string fact of `0x2000` the way the pipeline recovers it: only addresses of the
 * function's own candidate set are looked up, and only immutable terminated bytes qualify. */
function candidateFacts(ir: SSAForm): SourceAddress[] {
  const base = navigationBytes(Uint8Array.of(0xc3), Buffer.from('partly\0'));
  const loaded = {
    ...base,
    mappings: base.mappings.map((mapping) => ({ ...mapping, permissions: ['read'] as const })),
    sections: base.sections.map((section) => ({ ...section, permissions: ['read'] as const })),
  };
  const context = createOperationContext();
  const expressions = new Map(
    ir.blocks.flatMap((block) =>
      block.instructions.flatMap((node) =>
        node.kind === 'assign' ? [[node.result.id, node.expression] as const] : [],
      ),
    ),
  );
  return registerConstantCandidates({
    ir,
    image: loaded,
    expressions,
    constant: sourceConstantValues(expressions, context, loaded.id),
    candidates: constantCandidates(ir, null, context),
    context,
  }).flatMap((address) => {
    const item = recoverDataAddress(loaded, address, context);
    // The IR's constants are in the fixture image's own address space.
    return item ? [{ ...item, address: at(address.value) }] : [];
  });
}

/** A tail call of an unknown target through `rdi` (the `partlyConstant` join), as the pipeline
 * prepares it: stack-aware types and the tail interface `recoverSourceEvidence` publishes. */
function tailText(ir: SSAForm, facts: SourceAddress[], language: (typeof languages)[number]) {
  const types = recoverTypes(ir, sysvAMD64Abi, createOperationContext(), {
    image_id: image,
    slice_id: slice,
    revision: 0,
  });
  return emit(
    ir,
    {
      types,
      source: {
        abi: sysvAMD64Abi,
        callees: [],
        source_callees: observePreparedTailInterfaces(ir, sysvAMD64Abi, createOperationContext()),
        addresses: facts,
        executable_ranges: [{ start: 0x1000n, end: 0x1001n }],
      },
    },
    language,
  ).emission.text;
}

for (const language of languages)
  test(`${language} a tail call with a phi of a literal and a loaded value prints the literal on the constant edge`, () => {
    const ir = partlyConstant();
    const facts = candidateFacts(ir);
    assert.deepEqual(
      facts.map((item) => item.string),
      ['partly'],
    );
    const text = tailText(ir, facts, language);
    assert.match(text, /"partly"/, text);
    assert.doesNotMatch(text, /0x2000\b|\b8192\b/, text);
    // The edge that loads a value keeps printing the load, not a literal.
    assert.equal(text.match(/"partly"/g)?.length, 1, text);
  });

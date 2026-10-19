import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createOperationContext } from '../../src/core/index.js';
import { recoverRuntimeMetadata } from '../../src/metadata/runtime/index.js';
import { objcImageIndex } from '../../src/metadata/runtime/objc-index.js';
import { parseObjCMethodType, selectorArity } from '../../src/metadata/runtime/objc-types.js';
import { fileAt, fixtureBytes, fixtureImage, loadBytes } from './fixture.js';

const recover = (name: string) =>
  recoverRuntimeMetadata({ image: fixtureImage(name), revision: 1 }, createOperationContext());

test('Objective-C Foundation fixtures match their recorded provenance hashes', () => {
  const provenance = JSON.parse(
    readFileSync(new URL('./fixtures/provenance.json', import.meta.url), 'utf8'),
  ) as { sha256: Record<string, string> };
  for (const name of [
    'objc-foundation.m',
    'objc-foundation',
    'objc-foundation-classic',
    'objc-foundation-stripped',
  ])
    assert.equal(
      createHash('sha256').update(fixtureBytes(name)).digest('hex'),
      provenance.sha256[name],
      name,
    );
});

test('selector stubs, constant strings and method symbols come from static metadata', () => {
  const result = recover('objc-foundation');
  assert.equal(result.state, 'complete');
  const stubs = new Map(
    result.records
      .filter((record) => record.kind === 'objc_selector_stub')
      .map((record) => [record.name, record]),
  );
  // Every selector the program sends through __objc_stubs, and no other record.
  assert.deepEqual(
    [...stubs.keys()].sort(),
    [
      'addValue:times:',
      'copy',
      'count',
      'counterWithLabel:',
      'greeting',
      'increment',
      'initWithLabel:',
      'label',
      'setCount:',
      'stringWithFormat:',
      'summary',
    ],
  );
  const stub = stubs.get('addValue:times:')!;
  assert.equal(stub.target_role, 'code');
  assert.equal(stub.target?.value, stub.address.value);
  assert.ok(
    result.symbols.some(
      (symbol) =>
        symbol.kind === 'function' &&
        symbol.original_name === '_objc_msgSend$addValue:times:' &&
        symbol.address?.value === stub.address.value,
    ),
  );
  assert.deepEqual(
    result.records
      .filter((record) => record.kind === 'objc_string')
      .map((record) => record.name)
      .sort(),
    ['%@ %@', '%@=%ld', 'hello, fixture', 'main'],
  );
  // Constant strings are data, never callable symbols.
  const strings = new Set(
    result.records.filter((record) => record.kind === 'objc_string').map((r) => r.address.value),
  );
  assert.ok(!result.symbols.some((symbol) => strings.has(symbol.address?.value ?? -1n)));
  const names = new Set(
    result.symbols.filter((symbol) => symbol.kind === 'function').map((s) => s.original_name),
  );
  for (const name of [
    '-[ODCounter initWithLabel:]',
    '-[ODCounter addValue:times:]',
    '+[ODCounter counterWithLabel:]',
    '+[ODCounter greeting]',
    '-[ODCounter summary]',
  ])
    assert.ok(names.has(name), name);
});

test('stripped images keep runtime method names; classic sends have no selector stubs', () => {
  const stripped = recover('objc-foundation-stripped');
  assert.ok(
    stripped.symbols.some(
      (symbol) => symbol.kind === 'function' && symbol.original_name === '+[ODCounter greeting]',
    ),
  );
  const classic = recover('objc-foundation-classic');
  assert.equal(classic.state, 'complete');
  assert.equal(classic.records.filter((record) => record.kind === 'objc_selector_stub').length, 0);
  const index = objcImageIndex(fixtureImage('objc-foundation-classic'), 1, createOperationContext())!;
  assert.deepEqual(
    [...index.selector_refs.values()].map((fact) => fact.name).filter((name) => name === 'addValue:times:'),
    ['addValue:times:'],
  );
  const classes = new Set([...index.class_refs.values()].map((fact) => fact.name));
  assert.ok(classes.has('NSString') && classes.has('ODCounter'));
});

test('an unrecognized selector stub publishes no selector for it or after it', () => {
  const bytes = fixtureBytes('objc-foundation'),
    image = loadBytes(bytes),
    before = recoverRuntimeMetadata({ image, revision: 1 }, createOperationContext());
  const first = before.records
    .filter((record) => record.kind === 'objc_selector_stub')
    .sort((a, b) => (a.address.value < b.address.value ? -1 : 1))[0]!;
  bytes.writeUInt32LE(0xd503201f, fileAt(image, first.address.value) + 8); // adrp x16 -> nop
  const after = recoverRuntimeMetadata({ image: loadBytes(bytes), revision: 1 }, createOperationContext());
  assert.equal(after.state, 'partial');
  assert.equal(after.records.filter((record) => record.kind === 'objc_selector_stub').length, 0);
  assert.ok(!after.symbols.some((symbol) => symbol.original_name.startsWith('_objc_msgSend$')));
});

test('method type encodings yield ABI classes only for supported scalar and pointer elements', () => {
  const parsed = parseObjCMethodType('q32@0:8q16q24')!;
  assert.deepEqual(parsed.returns.abi, { kind: 'integer', bits: 64, signed: true });
  assert.deepEqual(
    parsed.parameters.map((item) => item.role),
    ['object', 'selector', 'scalar', 'scalar'],
  );
  assert.deepEqual(parseObjCMethodType('d24@0:8d16')!.parameters[2]!.abi, {
    kind: 'float',
    bits: 64,
  });
  assert.equal(parseObjCMethodType('@"NSString"16@0:8')!.returns.role, 'object');
  assert.equal(parseObjCMethodType('v24@0:8@?16')!.parameters[2]!.role, 'object');
  assert.equal(parseObjCMethodType('B24@0:8:16')!.returns.role, 'bool');
  // Aggregates and malformed encodings are not guessed.
  assert.equal(parseObjCMethodType('{CGRect={CGPoint=dd}{CGSize=dd}}16@0:8'), null);
  assert.equal(parseObjCMethodType('v16@0:8{CGPoint=dd}16'), null);
  assert.equal(parseObjCMethodType('v16@0'), null);
  assert.equal(selectorArity('addValue:times:'), 2);
  assert.equal(selectorArity('count'), 0);
});

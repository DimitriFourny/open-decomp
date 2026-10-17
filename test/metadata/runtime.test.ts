import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, OperationError } from '../../src/core/index.js';
import { recoverRuntimeMetadata } from '../../src/metadata/runtime/index.js';
import {
  BASE,
  fixtureBytes,
  fixtureImage,
  fileAt,
  loadBytes,
  objcBytes,
  swiftBytes,
} from './fixture.js';

function recover(bytes: Uint8Array) {
  return recoverRuntimeMetadata({ image: loadBytes(bytes), revision: 1 }, createOperationContext());
}

test('real Objective-C compiler metadata distinguishes code, declarations and external class identities', () => {
  const image = fixtureImage('objc-cxx.dylib'),
    result = recoverRuntimeMetadata({ image, revision: 1 }, createOperationContext());
  assert.equal(result.state, 'complete');
  assert.deepEqual(
    result.records
      .filter((record) => record.kind === 'objc_class')
      .map((record) => record.name)
      .sort(),
    ['ODChild', 'ODObject'],
  );
  const number = result.records.find(
    (record) =>
      record.kind === 'objc_method' && record.name === 'number' && record.owner === 'ODObject',
  )!;
  assert.equal(number.target_role, 'code');
  assert.ok(number.target);
  assert.equal(number.method_kind, 'instance');
  assert.equal(number.type_name, 'i16@0:8');
  assert.ok(
    result.symbols.some(
      (symbol) =>
        symbol.kind === 'function' &&
        symbol.address?.value === number.target!.value &&
        symbol.evidence_ids.includes(number.evidence_ids[0]!),
    ),
  );
  const protocol = result.records.find(
    (record) => record.kind === 'objc_method_declaration' && record.name === 'ping:',
  )!;
  assert.equal(protocol.target, null);
  assert.equal(protocol.method_kind, 'instance');
  assert.ok(
    result.symbols.some(
      (symbol) =>
        symbol.kind === 'object' &&
        symbol.address?.value === protocol.address.value &&
        symbol.evidence_ids.includes(protocol.evidence_ids[0]!),
    ),
  );
  const superclass = result.records.find(
    (record) => record.kind === 'objc_superclass_reference' && record.owner === 'ODChild',
  )!;
  assert.equal(superclass.name, 'NSObject');
  assert.equal(superclass.target, null);
  assert.equal(superclass.target_role, 'unresolved');
  assert.equal(
    result.records.find((record) => record.kind === 'objc_ivar' && record.name === '_number')!
      .type_name,
    'i',
  );
});

test('real Swift reflection retains nominal kinds, fields, enum payloads and symbolic bytes', () => {
  const result = recoverRuntimeMetadata(
    { image: fixtureImage('swift.dylib'), revision: 1 },
    createOperationContext(),
  );
  assert.equal(result.state, 'complete');
  assert.ok(
    result.records.some(
      (record) =>
        record.kind === 'swift_structure' &&
        record.name === 'MetadataPoint' &&
        record.owner === 'FixtureMetadata',
    ),
  );
  assert.ok(
    result.records.some(
      (record) => record.kind === 'swift_class' && record.name === 'MetadataChild',
    ),
  );
  assert.deepEqual(
    result.records
      .filter(
        (record) =>
          record.kind === 'swift_field' && record.owner === 'FixtureMetadata.MetadataPoint',
      )
      .map((record) => record.name)
      .sort(),
    ['x', 'y'],
  );
  const x = result.records.find((record) => record.kind === 'swift_field' && record.name === 'x')!;
  assert.equal(x.type_encoding, 'swift-mangled');
  assert.match(x.type_name!, /^\\x02\{[0-9a-f]{4}0000\}$/);
  const cases = result.records.filter((record) => record.kind === 'swift_enum_case');
  assert.deepEqual(cases.map((record) => record.name).sort(), ['amount', 'empty', 'point']);
  assert.equal(cases.find((record) => record.name === 'amount')!.type_name, 'Si');
  assert.equal(cases.find((record) => record.name === 'empty')!.type_name, null);
  assert.equal(
    result.records.find((record) => record.kind === 'objc_ivar' && record.name === 'label')!
      .type_name,
    null,
  );
});

test('real relative method retargeted into metadata remains unresolved, never callable', () => {
  const bytes = fixtureBytes('objc-cxx.dylib'),
    image = loadBytes(bytes),
    before = recoverRuntimeMetadata({ image, revision: 1 }, createOperationContext());
  const method = before.records.find(
    (record) => record.kind === 'objc_method' && record.name === 'number',
  )!;
  assert.ok(method.flags !== null && (method.flags & 0x80000000n) !== 0n);
  bytes.writeInt32LE(-8, fileAt(image, method.address.value) + 8); // IMP now points at its own data record.
  const result = recover(bytes),
    changed = result.records.find(
      (record) =>
        record.kind === method.kind && record.name === method.name && record.owner === method.owner,
    )!;
  assert.equal(result.state, 'partial');
  assert.equal(changed.target, null);
  assert.equal(changed.target_role, 'unresolved');
  assert.ok(
    result.symbols.some(
      (symbol) =>
        symbol.kind === 'object' && symbol.evidence_ids.includes(changed.evidence_ids[0]!),
    ),
  );
});

test('absolute Objective-C records retain category, protocol, metaclass and selector relationships', () => {
  const fixture = objcBytes();
  fixture.pointer(0x2698, 0x6000); // A protocol declaration must ignore even an executable IMP.
  const result = recover(fixture.bytes);
  assert.equal(result.state, 'complete');
  assert.ok(
    result.records.some(
      (record) =>
        record.kind === 'objc_category' &&
        record.name === 'Extras' &&
        record.owner === 'Widget' &&
        record.target?.value === BASE + 0x2000n,
    ),
  );
  assert.ok(
    result.records.some(
      (record) => record.kind === 'objc_metaclass_link' && record.target?.value === BASE + 0x2040n,
    ),
  );
  assert.deepEqual(
    result.records
      .filter((record) => record.kind === 'objc_protocol_adoption')
      .map((record) => record.owner)
      .sort(),
    ['Widget', 'Widget(Extras)'],
  );
  assert.ok(
    result.records.some(
      (record) =>
        record.kind === 'objc_selector' &&
        record.name === 'value' &&
        record.target_role === 'metadata',
    ),
  );
  assert.ok(
    result.records.some(
      (record) =>
        record.kind === 'objc_method' &&
        record.method_kind === 'class' &&
        record.name === 'shared' &&
        record.target?.value === BASE + 0x6004n,
    ),
  );
  assert.equal(
    result.records.find((record) => record.kind === 'objc_method_declaration')!.target,
    null,
  );
});

for (const direct of [false, true])
  test(`small Objective-C methods use per-field offsets and ${direct ? 'direct' : 'indirect'} selectors`, () => {
    const fixture = objcBytes();
    fixture.u32(0x2200, direct ? 0xc000000c : 0x8000000c);
    fixture.pointer(0x2700, fixture.selector);
    fixture.relative(0x2208, direct ? fixture.selector : 0x2700);
    fixture.relative(0x220c, fixture.encoding);
    fixture.relative(0x2210, 0x6000);
    const method = recover(fixture.bytes).records.find(
      (record) => record.kind === 'objc_method' && record.name === 'value',
    )!;
    assert.equal(method.owner, 'Widget');
    assert.equal(method.target?.value, BASE + 0x6000n);
    assert.equal(method.type_name, 'q16@0:8');
  });

test('data-in-code cannot acquire a function symbol through an Objective-C IMP', () => {
  const result = recover(objcBytes({ data_in_code: { offset: 0x6000, size: 4 } }).bytes);
  const method = result.records.find(
    (record) => record.kind === 'objc_method' && record.name === 'value',
  )!;
  assert.equal(method.target, null);
  assert.equal(result.state, 'partial');
  assert.ok(
    result.records.some(
      (record) =>
        record.kind === 'objc_method' &&
        record.name === 'shared' &&
        record.target?.value === BASE + 0x6004n,
    ),
  );
  assert.ok(
    !result.symbols.some(
      (symbol) => symbol.kind === 'function' && symbol.address?.value === BASE + 0x6000n,
    ),
  );
});

test('chained-pointer uncertainty and encryption do not fall back to plausible raw addresses', () => {
  for (const fixture of [
    objcBytes({ chained: true }),
    objcBytes({ encrypted: { offset: 0x2000, size: 0x100 } }),
  ]) {
    const result = recover(fixture.bytes);
    assert.equal(result.state, 'partial');
    assert.ok(!result.records.some((record) => record.kind === 'objc_class'));
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'unavailable_semantics'));
  }
});

test('runtime names stop at section backing rather than following a terminating byte in a gap', () => {
  const fixture = objcBytes();
  fixture.pointer(0x2118, 0x4ffb);
  fixture.bytes.write('Other', 0x4ffb);
  const result = recover(fixture.bytes);
  assert.equal(result.state, 'partial');
  assert.ok(!result.records.some((record) => record.kind === 'objc_class'));
});

test('dynamic class flags and cyclic protocol adoption remain explicit partial metadata', () => {
  const dynamic = objcBytes();
  dynamic.u32(0x2100, 0x80000002);
  assert.ok(!recover(dynamic.bytes).records.some((record) => record.kind === 'objc_class'));
  const cycle = objcBytes();
  cycle.pointer(0x2410, 0x2500);
  const result = recover(cycle.bytes);
  assert.equal(result.state, 'partial');
  assert.ok(
    !result.records.some(
      (record) => record.kind === 'objc_protocol_adoption' && record.owner === 'Readable',
    ),
  );
  assert.ok(
    result.records.some((record) => record.kind === 'objc_protocol' && record.name === 'Readable'),
  );
});

test('Swift signed parent references and embedded-NUL symbolic payloads retain full identities', () => {
  const result = recover(swiftBytes().bytes);
  assert.equal(result.state, 'complete');
  const field = result.records.find((record) => record.kind === 'swift_field')!;
  assert.equal(field.owner, 'Main.Box');
  assert.equal(field.name, 'value');
  assert.equal(field.type_name, '\\x01{34000000}V');
  assert.ok(
    result.records.some(
      (record) => record.kind === 'swift_parent' && record.target?.value === BASE + 0x2000n,
    ),
  );
});

test('truncated Swift field tables cannot publish a valid prefix or retry into a following gap', () => {
  const fixture = swiftBytes();
  fixture.u32(0x110c, 2);
  fixture.u32(0x111c, 2);
  fixture.relative(0x1120, 0x4800);
  fixture.relative(0x1124, fixture.string('outside'));
  const result = recover(fixture.bytes);
  assert.equal(result.state, 'partial');
  assert.deepEqual(
    result.records.filter((record) => record.kind === 'swift_field'),
    [],
  );
});

test('runtime record bounds return explicit partial facts and cancellation publishes nothing', () => {
  const image = loadBytes(objcBytes().bytes),
    result = recoverRuntimeMetadata(
      { image, revision: 1, limits: { max_records: 1 } },
      createOperationContext(),
    );
  assert.equal(result.state, 'partial');
  assert.equal(result.records.length, 1);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'resource_limit'));
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () =>
      recoverRuntimeMetadata(
        { image, revision: 1 },
        createOperationContext({ signal: controller.signal }),
      ),
    (error: unknown) => error instanceof OperationError && error.code === 'cancelled',
  );
});

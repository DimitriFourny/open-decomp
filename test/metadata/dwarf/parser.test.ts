import assert from 'node:assert/strict';
import test from 'node:test';
import { DwarfReader, DwarfTextBudget, DWARF_LIMITS } from '../../../src/metadata/dwarf/reader.js';
import { readLineProgram } from '../../../src/metadata/dwarf/line.js';
import { ADDRESS, UUID, Bytes, concat, lengthPrefixed, abbreviation, macho, load, lineProgram, v4Unit, v5Unit, storageUnit, locationContribution, readDebug } from './helpers.js';


test('matched DWARF4 dSYM recovers real types, specification prototypes and bounded source intervals', () => {
  const fixture = v4Unit(), result = load({ __debug_info: fixture.info, __debug_abbrev: fixture.abbrev, __debug_line: lineProgram(4) });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.uuid, '01020304-0506-0708-090a-0b0c0d0e0f10');
  assert.equal(result.functions[0]!.address, ADDRESS);
  assert.equal(result.functions[0]!.size, 12n);
  assert.deepEqual(result.lines, [
    { address: ADDRESS, endAddress: ADDRESS + 4n, file: '/src/main.c', line: 10, column: 0 },
    { address: ADDRESS + 4n, endAddress: ADDRESS + 12n, file: '/src/main.c', line: 8, column: 7 },
  ]);
});


test('DWARF5 indexed strings, addresses, ranges, implicit constants and line-string tables', () => {
  const result = load(v5Unit());
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.functions[0]!.address, ADDRESS);
  assert.deepEqual(result.functions[0]!.ranges, [{ start: ADDRESS, end: ADDRESS + 12n }]);
  assert.equal(result.types[0]!.byteSize, 4);
  assert.equal(result.lines[0]!.file, '/src/main.c');
  assert.equal(result.lines[1]!.endAddress, ADDRESS + 12n);
});


test('multiple compilation units resolve local references relative to each unit', () => {
  const first = v4Unit('first'), second = v4Unit('second');
  const result = load({ __debug_info: concat(first.info, second.info), __debug_abbrev: first.abbrev, __debug_line: lineProgram(4) });
  assert.deepEqual(result.functions.map(fn => fn.name), ['first', 'second']);
  assert.equal(result.types.filter(type => type.kind === 'struct').length, 2);
  assert.equal(result.lines.length, 2);
  assert.deepEqual(result.diagnostics, []);
});


test('UUID and exact CPU subtype mismatch reject before producing an overlay', () => {
  const fixture = v4Unit(), sections = { __debug_info: fixture.info, __debug_abbrev: fixture.abbrev };
  const target = new Uint8Array(macho());
  assert.throws(() => readDebug(target, macho(sections, 2)), /does not exactly match/);
  const wrongUuid = UUID.slice(); wrongUuid[0]! ^= 255;
  assert.throws(() => readDebug(target, macho(sections, 0, wrongUuid)), /does not exactly match/);
  const noUuid = macho(); new DataView(noUuid).setUint32(32, 0x123, true);
  assert.throws(() => readDebug(target, noUuid), /does not exactly match/);
});


test('universal dSYM selects only the exact UUID and architecture slice', () => {
  const fixture = v4Unit(), sections = { __debug_info: fixture.info, __debug_abbrev: fixture.abbrev };
  const slices = [new Uint8Array(macho(sections, 2)), new Uint8Array(macho(sections))];
  const fat = new Uint8Array(48 + slices[0]!.length + slices[1]!.length), view = new DataView(fat.buffer);
  view.setUint32(0, 0xcafebabe); view.setUint32(4, 2);
  let offset = 48;
  slices.forEach((slice, i) => {
    const p = 8 + i * 20;
    view.setUint32(p, 0x100000c); view.setUint32(p + 4, i ? 0 : 2); view.setUint32(p + 8, offset); view.setUint32(p + 12, slice.length);
    fat.set(slice, offset); offset += slice.length;
  });
  const target = new Uint8Array(macho());
  assert.equal(readDebug(target, fat.buffer).functions[0]!.name, 'sum');
  view.setUint32(28 + 4, 2);
  assert.throws(() => readDebug(target, fat.buffer), /does not exactly match/);
});


test('malformed unit is isolated at its declared boundary without losing the next unit', () => {
  const good = v4Unit(), bad = good.info.slice(); bad[11]! = 127;
  const result = load({ __debug_info: concat(bad, good.info), __debug_abbrev: good.abbrev });
  assert.equal(result.functions.length, 1);
  assert.ok(result.diagnostics.some(message => message.includes('Unknown abbreviation')));
  assert.throws(() => load({ __debug_info: bad, __debug_abbrev: good.abbrev }), /No valid DWARF compilation units/);
});


test('cyclic inheritance and type references terminate with explicit diagnostics', () => {
  const a = new Bytes();
  abbreviation(a, 1, 0x11, true, []);
  abbreviation(a, 2, 0x2e, false, [[0x31, 0x13], [0x11, 1], [0x12, 6]]);
  abbreviation(a, 3, 15, false, [[0x49, 0x13]]); a.byte(0);
  const b = new Bytes().uint(0).uint(4, 2).uint(0).byte(8).uleb(1);
  b.label('function').uleb(2).ref('function').uint(ADDRESS, 8).uint(4).label('pointer').uleb(3).ref('pointer').byte(0);
  const info = b.finish(); new DataView(info.buffer).setUint32(0, info.length - 4, true);
  const result = load({ __debug_info: info, __debug_abbrev: a.finish() });
  assert.equal(result.functions.length, 0);
  assert.ok(result.diagnostics.some(message => /Cyclic.*inheritance/.test(message)));
  assert.ok(result.diagnostics.some(message => /Cyclic.*type/.test(message)));
});


test('indexed reads cannot spill into the next DWARF5 table contribution', () => {
  const sections = v5Unit();
  sections.__debug_str_offs! = concat(lengthPrefixed(new Bytes().uint(5, 2).uint(0, 2).uint(0).finish()), sections.__debug_str_offs!);
  const result = load(sections);
  assert.equal(result.functions.length, 0);
  assert.ok(result.diagnostics.some(message => /Truncated|bounds/.test(message)));
  assert.equal(result.types[0]!.name, 'int');
});


test('line programs are isolated and never map beyond missing or malformed end_sequence', () => {
  const fixture = v4Unit(), bad = lineProgram(4).slice(0, -3);
  new DataView(bad.buffer).setUint32(0, bad.length - 4, true);
  const result = load({ __debug_info: fixture.info, __debug_abbrev: fixture.abbrev, __debug_line: bad });
  assert.equal(result.functions.length, 1);
  assert.equal(result.lines.length, 0);
  assert.ok(result.diagnostics.some(message => message.includes('missing end_sequence')));
  assert.throws(() => readLineProgram(new Map([['__debug_line', lineProgram(4)]]), 0, 8, '/src', true, 1), /row limit/);
});


test('bounded readers reject overflowing LEB and deeply nested DIE trees', () => {
  assert.equal(new DwarfReader(new Bytes().sleb(-65).finish()).leb(true), -65n);
  assert.throws(() => new DwarfReader(Uint8Array.from({ length: 11 }, () => 128)).leb(), /10-byte limit/);
  assert.throws(() => new DwarfReader(new Bytes().uint(0xffffffff).uint(1n << 63n, 8).finish()).initialLength(), /safe integer/);
  const a = new Bytes(); abbreviation(a, 1, 0x11, true, []); a.byte(0);
  const b = new Bytes().uint(4, 2).uint(0).byte(8);
  for (let i = 0; i < DWARF_LIMITS.depth + 1; i++) b.byte(1);
  assert.throws(() => load({ __debug_info: lengthPrefixed(b.finish()), __debug_abbrev: a.finish() }), /nesting depth limit/);
});


test('compression and unsupported forms produce explicit non-fabricated failures', () => {
  const target = new Uint8Array(macho());
  assert.throws(() => readDebug(target, macho({ __zdebug_info: new Uint8Array([1]), __debug_abbrev: new Uint8Array([0]) })), /compressed DWARF/);
  const a = new Bytes(); abbreviation(a, 1, 0x11, false, [[3, 0x77]]); a.byte(0);
  const info = lengthPrefixed(new Bytes().uint(4, 2).uint(0).byte(8, 1).finish());
  assert.throws(() => load({ __debug_info: info, __debug_abbrev: a.finish() }), /Unsupported DWARF form 0x77/);
});


test('DWARF64 units support wide offsets, ref8, indirect strings and absolute high_pc', () => {
  const a = new Bytes();
  abbreviation(a, 1, 0x11, true, []);
  abbreviation(a, 2, 0x24, false, [[3, 0xe], [0xb, 0xb]]);
  abbreviation(a, 3, 0x2e, false, [[3, 0x16], [0x49, 0x14], [0x11, 1], [0x12, 1]]); a.byte(0);
  const body = new Bytes().uint(4, 2).uint(0, 8).byte(8, 1);
  body.byte(2).uint(0, 8).byte(4).byte(3).uleb(8).string('wide').uint(24, 8).uint(ADDRESS, 8).uint(ADDRESS + 8n, 8).byte(0);
  const info = concat(new Bytes().uint(0xffffffff).uint(body.data.length, 8).finish(), body.finish());
  const result = load({ __debug_info: info, __debug_abbrev: a.finish(), __debug_str: new Bytes().string('int').finish() });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.functions[0]!.size, 8n);
});


test('abstract_origin can resolve an absolute DIE reference across compilation units', () => {
  const a = new Bytes();
  abbreviation(a, 1, 0x11, true, []);
  abbreviation(a, 2, 0x24, false, [[3, 8]]);
  abbreviation(a, 3, 0x2e, false, [[3, 8], [0x49, 0x13]]);
  abbreviation(a, 4, 0x2e, false, [[0x31, 0x10], [0x11, 1], [0x12, 6]]); a.byte(0);
  const first = new Bytes().uint(0).uint(4, 2).uint(0).byte(8, 1).label('int').byte(2).string('int');
  first.label('origin').byte(3).string('original').ref('int').byte(0);
  const firstInfo = first.finish(); new DataView(firstInfo.buffer).setUint32(0, firstInfo.length - 4, true);
  const second = lengthPrefixed(new Bytes().uint(4, 2).uint(0).byte(8, 1, 4).uint(first.labels.get('origin')!).uint(ADDRESS, 8).uint(4).byte(0).finish());
  const result = load({ __debug_info: concat(firstInfo, second), __debug_abbrev: a.finish() });
  assert.deepEqual(result.diagnostics, []);
});


test('DWARF4 base-selection range lists preserve discontiguous code without covering gaps', () => {
  const a = new Bytes();
  abbreviation(a, 1, 0x11, true, []);
  abbreviation(a, 2, 0x2e, false, [[3, 8], [0x55, 0x17]]); a.byte(0);
  const info = lengthPrefixed(new Bytes().uint(4, 2).uint(0).byte(8, 1, 2).string('split').uint(0).byte(0).finish());
  const ranges = new Bytes().uint(0xffffffffffffffffn, 8).uint(ADDRESS, 8).uint(0, 8).uint(4, 8).uint(16, 8).uint(24, 8).uint(0, 8).uint(0, 8).finish();
  const result = load({ __debug_info: info, __debug_abbrev: a.finish(), __debug_ranges: ranges });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.functions[0]!.size, 4n);
  assert.deepEqual(result.functions[0]!.ranges, [{ start: ADDRESS, end: ADDRESS + 4n }, { start: ADDRESS + 16n, end: ADDRESS + 24n }]);
});


test('unit-relative references may not escape into another unit or become invented void types', () => {
  const a = new Bytes();
  abbreviation(a, 1, 0x11, true, []);
  abbreviation(a, 2, 0xf, false, [[0x49, 0x13]]); a.byte(0);
  const info = lengthPrefixed(new Bytes().uint(4, 2).uint(0).byte(8, 1, 2).uint(0x1000).byte(0).finish());
  const result = load({ __debug_info: info, __debug_abbrev: a.finish() });
  assert.equal(result.types.length, 0);
  assert.ok(result.diagnostics.some(message => message.includes('escapes its compilation unit')));
  assert.ok(result.diagnostics.some(message => message.includes('refusing to infer a void type')));
});


test('split DWARF unit kinds are explicitly rejected rather than treated as ordinary units', () => {
  const good = v4Unit();
  const split = lengthPrefixed(new Bytes().uint(5, 2).byte(5, 8).uint(0).uint(42, 8).finish());
  const result = load({ __debug_info: concat(split, good.info), __debug_abbrev: good.abbrev });
  assert.equal(result.functions.length, 1);
  assert.ok(result.diagnostics.some(message => message.includes('split/type units')));
});


test('line-table referenced strings share a pre-allocation budget across contributions', () => {
  const h = new Bytes().byte(1, 1, 1, 251, 14, 13).byte(0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1);
  h.byte(1).uleb(1).uleb(0x1f).uleb(3).uint(0).uint(0).uint(0);
  h.byte(0).uleb(0);
  const line = lengthPrefixed(concat(new Bytes().uint(5, 2).byte(8, 0).uint(h.data.length).finish(), h.finish()));
  const sections = new Map([['__debug_line', line], ['__debug_line_str', new Bytes().string('abcdefghijklmnop').finish()]]);
  const budget = new DwarfTextBudget(40);
  assert.throws(() => readLineProgram(sections, 0, 8, '', true, 10, undefined, budget), /aggregate text budget/);
  const shared = new DwarfTextBudget(30);
  const ordinary = new Map([['__debug_line', lineProgram(4)]]);
  assert.equal(readLineProgram(ordinary, 0, 8, '/src', true, 10, undefined, shared).lines.length, 2);
  assert.throws(() => readLineProgram(ordinary, 0, 8, '/src', true, 10, undefined, shared), /aggregate text budget/);
});


test('generated source paths are charged before joining and reused across rows', () => {
  const sections = new Map([['__debug_line', lineProgram(4)]]);
  // Six bytes decode main.c; the 107-character generated path cannot fit.
  assert.throws(() => readLineProgram(sections, 0, 8, '/' + 'x'.repeat(99), true, 10, undefined, new DwarfTextBudget(32)), /aggregate text budget/);
  const budget = new DwarfTextBudget(17);
  const result = readLineProgram(sections, 0, 8, '/src', true, 10, undefined, budget);
  assert.equal(result.lines.length, 2);
  assert.equal(budget.remaining, 0);
  assert.equal(result.lines[0]!.file, '/src/main.c');
});


test('structural references preserve qualifiers, callback contracts and every array dimension', () => {
  const a = new Bytes();
  abbreviation(a, 1, 0x11, true, []);
  abbreviation(a, 2, 0x24, false, [[3, 8]]);
  abbreviation(a, 3, 0xf, false, [[0x49, 0x13]]);
  abbreviation(a, 4, 0x26, false, [[0x49, 0x13]]);
  abbreviation(a, 5, 0x35, false, [[0x49, 0x13]]);
  abbreviation(a, 6, 0x15, true, [[0x49, 0x13]]);
  abbreviation(a, 7, 5, false, [[0x49, 0x13]]);
  abbreviation(a, 8, 1, true, [[0x49, 0x13]]);
  abbreviation(a, 9, 0x21, false, [[0x37, 0xf]]);
  abbreviation(a, 10, 0x21, false, [[0x22, 0xd], [0x2f, 0xd]]);
  abbreviation(a, 11, 0x21, false, []);
  abbreviation(a, 12, 0x13, true, [[3, 8]]);
  abbreviation(a, 13, 0xd, false, [[3, 8], [0x49, 0x13]]);
  abbreviation(a, 14, 0x2e, true, [[3, 8], [0x11, 1], [0x12, 6]]);
  abbreviation(a, 15, 5, false, [[3, 8], [0x49, 0x13]]);
  abbreviation(a, 16, 0x16, false, [[3, 8], [0x49, 0x13]]);
  a.byte(0);
  const b = new Bytes().uint(0).uint(4, 2).uint(0).byte(8, 1);
  b.label('int').byte(2).string('int');
  b.label('pointer').byte(3).ref('int');
  b.label('constPointer').byte(4).ref('pointer');
  b.label('constInt').byte(4).ref('int');
  b.label('pointerToConst').byte(3).ref('constInt');
  b.label('volatileConstPointer').byte(5).ref('constPointer');
  b.label('callback').byte(6).ref('int').byte(7).ref('int').byte(0);
  b.label('callbackPointer').byte(3).ref('callback');
  b.label('matrix').byte(8).ref('int').byte(9).uleb(2).byte(10).sleb(4).sleb(6).byte(0);
  b.label('arrayPointer').byte(3).ref('matrix');
  b.label('unknownArray').byte(8).ref('int').byte(9).uleb(2).byte(11, 0);
  b.label('pointerArray').byte(8).ref('pointer').byte(9).uleb(3).byte(0);
  b.byte(16).string('Callback').ref('callbackPointer');
  b.byte(12).string('Fields');
  b.byte(13).string('constant').ref('constPointer');
  b.byte(13).string('pointee').ref('pointerToConst');
  b.byte(13).string('both').ref('volatileConstPointer');
  b.byte(13).string('cb').ref('callbackPointer');
  b.byte(13).string('values').ref('matrix');
  b.byte(13).string('matrix').ref('arrayPointer');
  b.byte(13).string('unknown').ref('unknownArray');
  b.byte(13).string('pointers').ref('pointerArray').byte(0);
  b.byte(14).string('use').uint(ADDRESS, 8).uint(4).byte(15).string('cb').ref('callbackPointer').byte(0, 0);
  const info = b.finish(); new DataView(info.buffer).setUint32(0, info.length - 4, true);
  const result = load({ __debug_info: info, __debug_abbrev: a.finish() });
  assert.deepEqual(result.diagnostics, []);
  const byId = new Map(result.types.map(type => [type.id, type]));
  const matrix = byId.get(`die-${b.labels.get('matrix')!.toString(16)}`)!;
  const unknown = byId.get(`die-${b.labels.get('unknownArray')!.toString(16)}`)!;
  assert.deepEqual(matrix.dimensions, [2n, 3n]);
  assert.equal(matrix.elementCount, 6);
  assert.deepEqual(unknown.dimensions, [2n, null]);
  assert.equal(unknown.elementCount, undefined);
  const pointer = byId.get(`die-${b.labels.get('pointer')!.toString(16)}`)!;
  assert.equal(pointer.byteSize, 8);
  assert.equal(pointer.targetTypeId, `die-${b.labels.get('int')!.toString(16)}`);
  assert.equal(result.functions[0]!.signature?.parameters[0]?.type.kind, 'subroutine-pointer');
});


test('concrete lexical storage, nested inline origins, frame bases and globals preserve exact scope', () => {
  const result = load(storageUnit(4));
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.functions[0]!.frameBase, [{ ranges: [{ start: ADDRESS, end: ADDRESS + 100n }], location: { kind: 'register', register: 29 } }]);
  const readfd = result.variables!.find(variable => variable.name === 'readfd')!;
  assert.deepEqual(readfd.locations, [{ ranges: [{ start: ADDRESS + 20n, end: ADDRESS + 80n }], location: { kind: 'register-offset', register: 31, offset: 64n } }]);
  const outer = result.inlineScopes!.find(scope => scope.name === '__darwin_fd_isset')!;
  const inner = result.inlineScopes!.find(scope => scope.name === '__darwin_check_fd_set')!;
  assert.equal(inner.parentId, outer.id);
  assert.equal(outer.callFile, '/src/main.c');
  assert.equal(outer.callLine, 42);
  assert.deepEqual(inner.ranges, [{ start: ADDRESS + 40n, end: ADDRESS + 60n }]);
  const fd = result.variables!.find(variable => variable.name === '_fd')!;
  assert.equal(fd.scopeId, outer.id);
  assert.equal(fd.parameter, true);
  assert.equal(fd.file, '/src/main.c');
  assert.equal(fd.line, 20);
  assert.deepEqual(fd.locations, [{ ranges: outer.ranges, location: { kind: 'frame-offset', offset: -56n } }]);
  assert.deepEqual(result.variables!.find(variable => variable.name === '_a')!.locations, [{ ranges: inner.ranges, location: { kind: 'frame-offset', offset: -40n } }]);
  assert.equal(result.variables!.filter(variable => variable.name === '_fd').length, 1);
  assert.deepEqual(result.variables!.find(variable => variable.name === 'masterpt')!.locations, [{ ranges: [], location: { kind: 'address', address: ADDRESS + 0x1000n } }]);
  const type = result.types.find(type => type.id === readfd.typeId)!;
  const structure = result.types.find(candidate => candidate.id === type.targetTypeId)!;
  assert.equal(structure.byteSize, 128);
  assert.equal(structure.members![0]!.byteOffset, 0);
  assert.equal(result.types.find(candidate => candidate.id === structure.members![0]!.typeId)!.elementCount, 32);
});


test('DWARF4 location lists honor CU/base-selection addresses and lexical clipping', () => {
  const sections = storageUnit(4, 0x17);
  sections.__debug_loc! = new Bytes()
    .uint(0, 8).uint(30, 8).uint(1, 2).byte(0x50)
    .uint(0xffffffffffffffffn, 8).uint(ADDRESS + 40n, 8)
    .uint(0, 8).uint(60, 8).uint(2, 2).byte(0x91).sleb(-16)
    .uint(0, 8).uint(0, 8).finish();
  const result = load(sections);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.variables!.find(variable => variable.name === 'readfd')!.locations, [
    { ranges: [{ start: ADDRESS + 20n, end: ADDRESS + 30n }], location: { kind: 'register', register: 0 } },
    { ranges: [{ start: ADDRESS + 40n, end: ADDRESS + 80n }], location: { kind: 'frame-offset', offset: -16n } },
  ]);
  sections.__debug_loc! = sections.__debug_loc!.subarray(0, sections.__debug_loc!.length - 1);
  const malformed = load(sections);
  assert.deepEqual(malformed.variables!.find(variable => variable.name === 'readfd')!.locations, []);
  assert.ok(malformed.diagnostics.some(message => /Truncated/.test(message)));
});


test('DWARF5 indexed and direct loclists bound defaults and unavailable entries to lexical scopes', () => {
  for (const form of [0x17, 0x22] as const) {
    const sections = storageUnit(5, form);
    sections.__debug_loclists! = locationContribution(new Bytes()
      .byte(1).uleb(0) // base_addressx
      .byte(4).uleb(0).uleb(30).uleb(3).byte(0x92).uleb(31).sleb(0)
      .byte(4).uleb(30).uleb(40).uleb(0) // explicitly unavailable, not the default
      .byte(3).uleb(1).uleb(10).uleb(1).byte(0x51) // entirely outside lexical scope
      .byte(5).uleb(2).byte(0x91).sleb(-8).byte(0));
    const result = load(sections);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.variables!.find(variable => variable.name === 'readfd')!.locations, [
      { ranges: [{ start: ADDRESS + 20n, end: ADDRESS + 30n }], location: { kind: 'register-offset', register: 31, offset: 0n } },
      { ranges: [{ start: ADDRESS + 40n, end: ADDRESS + 80n }], location: { kind: 'frame-offset', offset: -8n } },
    ]);
  }
});


test('indexed loclist displacements cannot escape into another contribution', () => {
  const sections = storageUnit(5, 0x22);
  const second = locationContribution(new Bytes().byte(5).uleb(1).byte(0x50).byte(0));
  const first = locationContribution(new Bytes().byte(0), 21);
  sections.__debug_loclists! = concat(first, second);
  const result = load(sections);
  assert.deepEqual(result.variables!.find(variable => variable.name === 'readfd')!.locations, []);
  assert.ok(result.diagnostics.some(message => /escapes its contribution/.test(message)));
});


test('unsupported and malformed storage expressions never guess addresses or lose declarations', () => {
  for (const expression of [
    new Bytes().byte(0x91, 0x80).finish(),
    new Bytes().byte(0x50, 0x9f).finish(),
    new Bytes().byte(0x06).finish(),
    new Bytes().byte(0x03, 1).finish(),
  ]) {
    const result = load(storageUnit(4, undefined, expression));
    assert.equal(result.functions[0]!.name, 'runprogram');
    assert.equal(result.types.find(type => type.name === 'fd_set')!.kind, 'typedef');
    assert.deepEqual(result.variables!.find(variable => variable.name === 'readfd')!.locations, []);
    assert.ok(result.diagnostics.some(message => /Truncated|Unsupported/.test(message)));
    assert.equal(result.variables!.find(variable => variable.name === 'masterpt')!.locations.length, 1);
  }
});


test('addrx resolves only within the compilation unit address contribution', () => {
  const sections = storageUnit(5, undefined, new Bytes().byte(0xa1).uleb(1).finish());
  const result = load(sections);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.variables!.find(variable => variable.name === 'readfd')!.locations, [{ ranges: [{ start: ADDRESS + 20n, end: ADDRESS + 80n }], location: { kind: 'address', address: ADDRESS + 90n } }]);
  sections.__debug_addr! = concat(lengthPrefixed(new Bytes().uint(5, 2).byte(8, 0).uint(ADDRESS, 8).finish()), sections.__debug_addr!);
  const invalid = load(sections);
  assert.deepEqual(invalid.variables!.find(variable => variable.name === 'readfd')!.locations, []);
  assert.ok(invalid.diagnostics.some(message => /Truncated|bounds/.test(message)));
});


test('v5 location contribution bases and all address-range encodings remain CU-relative', () => {
  const prefix = locationContribution(new Bytes().byte(0));
  const addressPrefix = lengthPrefixed(new Bytes().uint(5, 2).byte(8, 0).uint(0x1234n, 8).finish());
  const sections = storageUnit(5, 0x22, undefined, { locationBase: prefix.length + 12, addressBase: addressPrefix.length + 8, frameList: true });
  sections.__debug_addr! = concat(addressPrefix, sections.__debug_addr!);
  sections.__debug_loclists! = concat(prefix, locationContribution(new Bytes()
    .byte(6).uint(ADDRESS, 8) // base_address
    .byte(4).uleb(0).uleb(10).uleb(1).byte(0x50)
    .byte(7).uint(ADDRESS + 10n, 8).uint(ADDRESS + 20n, 8).uleb(1).byte(0x51)
    .byte(8).uint(ADDRESS + 20n, 8).uleb(10).uleb(1).byte(0x52)
    .byte(2).uleb(1).uleb(1).uleb(1).byte(0x53) // valid empty startx_endx
    .byte(5).uleb(1).byte(0x6d).byte(0)));
  const result = load(sections);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.functions[0]!.frameBase, [
    { ranges: [{ start: ADDRESS, end: ADDRESS + 10n }], location: { kind: 'register', register: 0 } },
    { ranges: [{ start: ADDRESS + 10n, end: ADDRESS + 20n }], location: { kind: 'register', register: 1 } },
    { ranges: [{ start: ADDRESS + 20n, end: ADDRESS + 30n }], location: { kind: 'register', register: 2 } },
    { ranges: [{ start: ADDRESS + 30n, end: ADDRESS + 100n }], location: { kind: 'register', register: 29 } },
  ]);
  assert.deepEqual(result.variables!.find(variable => variable.name === 'readfd')!.locations, [
    { ranges: [{ start: ADDRESS + 20n, end: ADDRESS + 30n }], location: { kind: 'register', register: 2 } },
    { ranges: [{ start: ADDRESS + 30n, end: ADDRESS + 80n }], location: { kind: 'register', register: 29 } },
  ]);
});


test('empty scope intersections never turn local expressions or defaults into global storage', () => {
  for (const form of [undefined, 0x22] as const) {
    const sections = storageUnit(5, form, undefined, { lexicalStart: ADDRESS + 200n });
    sections.__debug_loclists! = locationContribution(new Bytes().byte(5).uleb(1).byte(0x50).byte(0));
    const result = load(sections);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.variables!.find(variable => variable.name === 'readfd')!.locations, []);
    assert.deepEqual(result.inlineScopes, []);
    assert.equal(result.variables!.find(variable => variable.name === 'masterpt')!.functionAddress, undefined);
  }
});


test('unsupported list expressions exclude default coverage and malformed lists fail closed', () => {
  const sections = storageUnit(5, 0x22);
  sections.__debug_loclists! = locationContribution(new Bytes()
    .byte(4).uleb(20).uleb(40).uleb(1).byte(0x06)
    .byte(5).uleb(1).byte(0x6d).byte(0));
  const result = load(sections);
  assert.ok(result.diagnostics.some(message => /Unsupported DWARF location opcode/.test(message)));
  assert.deepEqual(result.variables!.find(variable => variable.name === 'readfd')!.locations, [
    { ranges: [{ start: ADDRESS + 40n, end: ADDRESS + 80n }], location: { kind: 'register', register: 29 } },
  ]);
  for (const entries of [
    new Bytes().byte(0xff),
    new Bytes().byte(4).uleb(40).uleb(20).uleb(1).byte(0x50).byte(0),
    new Bytes().byte(4).uleb(20).uleb(50).uleb(1).byte(0x50).byte(4).uleb(40).uleb(60).uleb(1).byte(0x51).byte(0),
    new Bytes().byte(5).uleb(1).byte(0x50),
  ]) {
    sections.__debug_loclists! = locationContribution(entries);
    const invalid = load(sections);
    assert.deepEqual(invalid.variables!.find(variable => variable.name === 'readfd')!.locations, []);
    assert.ok(invalid.diagnostics.some(message => /Unsupported|Invalid|Overlapping|Truncated/.test(message)));
  }
});


test('extended register descriptions stay symbolic and retain their signed displacement', () => {
  const cases = [
    { bytes: new Bytes().byte(0x90).uleb(64).finish(), location: { kind: 'register', register: 64 } },
    { bytes: new Bytes().byte(0x92).uleb(29).sleb(-128).finish(), location: { kind: 'register-offset', register: 29, offset: -128n } },
  ];
  for (const { bytes, location } of cases) {
    const result = load(storageUnit(4, undefined, bytes));
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.variables!.find(variable => variable.name === 'readfd')!.locations, [
      { ranges: [{ start: ADDRESS + 20n, end: ADDRESS + 80n }], location },
    ]);
  }
});
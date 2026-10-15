import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext } from '../../../src/core/index.js';
import { debugContextAt, variableLocationsAt } from '../../../src/metadata/debug/index.js';
import { ADDRESS, Bytes, load, locationContribution, storageUnit } from '../dwarf/helpers.js';

test('scoped storage names resolve only through intersecting variable and frame-base evidence', () => {
  const data = load(storageUnit(4));
  const fd = data.variables!.find(variable => variable.name === '_fd')!;
  assert.deepEqual(variableLocationsAt(data, fd.id, ADDRESS + 35n, createOperationContext()).locations, [{ kind: 'register-offset', register: 29, offset: -56n }]);
  assert.deepEqual(variableLocationsAt(data, fd.id, ADDRESS + 60n, createOperationContext()).locations, []);
  const set = data.variables!.find(variable => variable.name === 'readfd')!;
  assert.deepEqual(variableLocationsAt(data, set.id, ADDRESS + 20n, createOperationContext()).locations, [{ kind: 'register-offset', register: 31, offset: 64n }]);
  assert.deepEqual(variableLocationsAt(data, set.id, ADDRESS + 19n, createOperationContext()).locations, []);
  assert.deepEqual(variableLocationsAt(data, set.id, ADDRESS + 80n, createOperationContext()).locations, []);
  const global = data.variables!.find(variable => variable.name === 'masterpt')!;
  assert.deepEqual(variableLocationsAt(data, global.id, ADDRESS, createOperationContext()).locations, [{ kind: 'address', address: ADDRESS + 0x1000n }]);
  assert.equal(variableLocationsAt(data, 'missing', ADDRESS, createOperationContext()).variable, null);
});

test('source intervals and nested inline contexts never leak beyond their half-open bounds', () => {
  const data = load(storageUnit(4));
  assert.deepEqual(debugContextAt(data, ADDRESS, createOperationContext()).sources.map(row => [row.file, row.line]), [['/src/main.c', 10]]);
  assert.deepEqual(debugContextAt(data, ADDRESS + 4n, createOperationContext()).sources.map(row => row.line), [8]);
  assert.deepEqual(debugContextAt(data, ADDRESS + 12n, createOperationContext()).sources, []);
  assert.deepEqual(debugContextAt(data, ADDRESS + 40n, createOperationContext()).inline_scopes.map(scope => scope.name), ['__darwin_fd_isset', '__darwin_check_fd_set']);
  assert.deepEqual(debugContextAt(data, ADDRESS + 60n, createOperationContext()).inline_scopes, []);
  assert.deepEqual(debugContextAt(null, ADDRESS, createOperationContext()), { sources: [], inline_scopes: [], conflicting: false });
});

test('unsupported frame bases preserve symbolic frame offsets instead of guessing SP', () => {
  const sections = storageUnit(5, undefined, undefined, { frameList: true });
  sections.__debug_loclists = locationContribution(new Bytes().byte(5).uleb(1).byte(0x06).byte(0));
  const data = load(sections), variable = data.variables!.find(candidate => candidate.name === '_fd')!;
  const result = variableLocationsAt(data, variable.id, ADDRESS + 35n, createOperationContext());
  assert.deepEqual(result.locations, [{ kind: 'frame-offset', offset: -56n }]);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'unavailable_semantics'));
});

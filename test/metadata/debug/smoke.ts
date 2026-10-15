import assert from 'node:assert/strict';
import { createOperationContext } from '../../../src/core/index.js';
import { debugContextAt, recoverDebugInfo, variableLocationsAt } from '../../../src/metadata/debug/index.js';
import { fixtureDebug, fixtureImage } from './fixture.js';

// node --import tsx test/metadata/debug/smoke.ts
// Reads the real compiler fixture; never launches the target or reads its source paths.
const image = fixtureImage(), external = fixtureDebug();
assert.equal(recoverDebugInfo(image, createOperationContext()).status, 'absent');
const recovered = recoverDebugInfo(image, createOperationContext(), external);
assert.ok(recovered.data);
const sum = recovered.functions.find(fn => fn.dwarf.name === 'debug_sum');
assert.ok(sum?.signature);
assert.equal(sum.signature.parameters.length, 2);
assert.deepEqual(recovered.types.find(type => type.id === sum.signature?.return_type)?.definition, { kind: 'integer', bits: 32, signed: true });
assert.ok(recovered.data.lines.length > 0);
const local = recovered.data.variables?.find(variable => variable.name === 'scoped');
assert.ok(local?.locations.length);
const start = local.locations[0]?.ranges[0]?.start;
assert.notEqual(start, undefined);
assert.ok(variableLocationsAt(recovered.data, local.id, start!, createOperationContext()).locations.length > 0);
const line = recovered.data.lines.find(row => row.endAddress !== undefined && row.address < row.endAddress);
assert.ok(line);
assert.ok(debugContextAt(recovered.data, line.address, createOperationContext()).sources.length > 0);
assert.ok((recovered.data.inlineScopes?.length ?? 0) > 0);
assert.throws(() => recoverDebugInfo(image, createOperationContext(), { ...external, expectedSha256: '0'.repeat(64) }), /SHA256/);
console.log(JSON.stringify({ status: recovered.status, uuid: recovered.uuid, functions: recovered.functions.length, types: recovered.types.length, variables: recovered.data.variables?.length, lines: recovered.data.lines.length, inline_scopes: recovered.data.inlineScopes?.length, diagnostics: recovered.diagnostics.map(item => ({ code: item.code, message: item.message })) }));

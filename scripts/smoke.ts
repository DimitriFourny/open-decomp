import assert from 'node:assert/strict';
import { formatHexU64, parseHexU64 } from '../src/index.js';

const bytes = Uint8Array.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00]);
const address = new DataView(bytes.buffer).getBigUint64(0, true);
const wire = formatHexU64(address);
assert.equal(wire, '0x20000000000001');
assert.equal(parseHexU64(wire), address);
console.log(JSON.stringify({ runtime: process.version, address: wire, preserved: true }));

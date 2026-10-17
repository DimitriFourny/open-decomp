import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate, fromWords, lift, registerBits } from './support.js';

// Compiler MOV vN.16b aliases expose opaque display operands in the pinned
// decoder. Canonical ORR fields, not those strings, specify the source registers.
test('canonical SIMD ORR and MOV aliases preserve bits and Q=0 clears the high half', () => {
  const left = 0x7ff0000000000123_8000000000000000n;
  const right = 0x0011223344556677_8899aabbccddeeffn;
  for (const [word, width, alias] of [
    [0x4ea11c20, 128, true],
    [0x0ea11c20, 64, true],
    [0x4ea21c20, 128, false],
    [0x0ea21c20, 64, false],
  ] as const) {
    const graph = fromWords([word, 0xd65f03c0]);
    assert.equal(graph.instructions[0]!.payload?.architecture, 'arm64');
    const payload = graph.instructions[0]!.payload!;
    if (payload.architecture !== 'arm64') assert.fail('Expected ARM64');
    assert.equal(payload.canonical_encoding, 'ORR_asimdsame_only');
    const lifted = lift(graph);
    assert.equal(lifted.coverage.state, 'complete');
    const inputs = new Map<string, bigint>();
    inputs.set('arm64:v0', (1n << 128n) - 1n);
    inputs.set('arm64:v1', left);
    if (!alias) inputs.set('arm64:v2', right);
    const observed = evaluate(lifted.ir, inputs);
    assert.equal(observed.status, 'returned');
    assert.equal(
      registerBits(observed, 'arm64:v0', 128),
      BigInt.asUintN(width, alias ? left : left | right),
    );
  }
});

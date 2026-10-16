import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, OperationError } from '../../../src/core/index.js';
import { X86Decoder } from '../../../src/decoders/x86_64/index.js';
import { imageFromBytes, region } from './helpers.js';

test('an aborted request leaves the adapter usable and disabled formatting rejects presentation', () => {
  const image = imageFromBytes(Uint8Array.of(0xc3));
  const adapter = new X86Decoder({ formatting: false });
  const request = { image, regions: [region(image)], features: [], mode: 'long64' as const };
  try {
    const controller = new AbortController(); controller.abort();
    assert.throws(() => adapter.decode(request, createOperationContext({ signal: controller.signal })),
      (error: unknown) => error instanceof OperationError && error.code === 'cancelled');
    const result = adapter.decode(request, createOperationContext());
    assert.equal(result.instructions[0]?.flow.kind, 'return');
    assert.throws(() => adapter.format(result.instructions[0]!), Error);
  } finally { adapter.dispose(); }
});

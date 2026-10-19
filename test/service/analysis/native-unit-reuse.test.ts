import assert from 'node:assert/strict';
import test from 'node:test';
import type { ToolResult } from '../../../src/core/index.js';
import { project } from './support.js';

// Prepared native callee units are reused across requests in one process. Reuse must
// leave exactly what preparing them would, so every function's output in a shared
// project equals its output in a fresh project of its own.
test('callee units reused across decompilations never change any output', async (t) => {
  const shared = await project(t, 'libcorpus-arm64-symbols.dylib');
  const ids = shared.functions.map((fn) => fn.id);
  assert.ok(ids.length > 4);
  // Functions without text (for example import stubs) compare by state and reason.
  const text = (result: ToolResult<'function_decompile'>): string =>
    'data' in result && result.data.delivery === 'inline'
      ? result.data.emission.text
      : `${result.state}:${'reason' in result ? result.reason : ''}`;
  const together: string[] = [];
  for (const id of ids) together.push(text((await shared.decompile(id)).result));
  for (const [index, id] of ids.entries()) {
    const alone = await project(t, 'libcorpus-arm64-symbols.dylib');
    assert.equal(text((await alone.decompile(id)).result), together[index], id);
  }
});

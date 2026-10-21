import assert from 'node:assert/strict';
import { copyFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { FunctionSelectionError, openBinary } from '../../src/api/index.js';
import type { BinarySession, ToolResult } from '../../src/api/index.js';

// Stripped ELF fixture (no symbols, no unwind): only the entry and its calls are grounded; the
// rest of .text is found by the whole-image sweep. Statically analyzed only, never executed.
const FIXTURE = 'fixtures/bin/elf-x86_64-stripped';
const SMALL = { instructions: 200 };

async function open(t: TestContext, budget?: { instructions: number }): Promise<BinarySession> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-resume-')));
  const input = join(root, 'stripped');
  await copyFile(resolve(FIXTURE), input);
  const session = await openBinary(input, budget ? { budget } : {});
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  return session;
}
async function functions(session: BinarySession) {
  const page = await session.findFunctions({ page: { limit: 1000 } });
  assert.ok('data' in page);
  return {
    state: page.data.page.index_state,
    items: page.data.items.map((item) => ({
      id: item.id,
      entry: item.entry.value,
      boundary: item.boundary,
      analysis: item.analysis,
      ranges: item.ranges.map((range) => [range.start.value, range.size]),
    })),
  };
}
function text(result: ToolResult<'function_decompile'>): string {
  assert.ok('data' in result && result.data.delivery === 'inline', JSON.stringify(result));
  return result.data.emission.text;
}

test(
  'a budget-limited stripped import resumes to the complete enumeration, deterministically, and then proves absence',
  { timeout: 240000 },
  async (t) => {
    const reference = await open(t);
    const once = await functions(reference);
    assert.equal(once.state, 'complete');

    const session = await open(t, SMALL);
    const first = await functions(session);
    assert.equal(first.state, 'partial');
    const swept = once.items.at(-1)!;
    // Until discovery completes the selector cannot settle the address.
    const start = session.revision;
    assert.equal(await session.completeDiscovery(SMALL), true);
    assert.ok(session.revision > start, 'each progressing step commits one revision');
    const resumed = await functions(session);
    assert.equal(resumed.state, 'complete');
    assert.deepEqual(
      resumed.items.map((item) => [item.entry, item.boundary]),
      once.items.map((item) => [item.entry, item.boundary]),
    );
    assert.equal(await session.completeDiscovery(SMALL), false, 'nothing left to continue');

    const address = { address: { space: 'va' as const, value: swept.entry } };
    const found = text(await session.decompile(address));
    assert.equal(text(await session.decompile(address)), found, 'same request twice');

    // Fill between two functions belongs to no function: absent once enumeration is complete.
    const sorted = [...resumed.items].sort((a, b) => (BigInt(a.entry) < BigInt(b.entry) ? -1 : 1));
    let fill: bigint | null = null;
    for (let index = 0; index + 1 < sorted.length && fill === null; index++) {
      const end = sorted[index]!.ranges.reduce((max, [start, size]) => {
        const value = BigInt(start!) + BigInt(size!);
        return value > max ? value : max;
      }, 0n);
      if (end < BigInt(sorted[index + 1]!.entry)) fill = end;
    }
    assert.ok(fill !== null, 'the fixture has padding between functions');
    await assert.rejects(
      session.decompile({ address: { space: 'va', value: `0x${fill.toString(16)}` } }),
      (error) => error instanceof FunctionSelectionError && error.reason === 'not_found',
    );

    // A cold project at the same budget, fresh process state: the unsettled fill selection
    // itself drives the continuation to the end, then proves absence; records, revision and
    // text match the first project exactly.
    const cold = await open(t, SMALL);
    assert.equal((await functions(cold)).state, 'partial');
    await assert.rejects(
      cold.decompile(
        { address: { space: 'va', value: `0x${fill.toString(16)}` } },
        { budget: SMALL },
      ),
      (error) => error instanceof FunctionSelectionError && error.reason === 'not_found',
    );
    assert.deepEqual(await functions(cold), resumed);
    assert.equal(cold.revision, session.revision);
    assert.equal(text(await cold.decompile(address)), found);
  },
);

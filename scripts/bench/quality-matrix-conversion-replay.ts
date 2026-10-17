#!/usr/bin/env node
/** Re-analyze every ranked conversion cell; never execute retained targets. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openBinary } from '../../src/api/index.js';

const comparisonPath = resolve(process.argv[2]!);
const rankingPath = resolve(process.argv[3]!);
const output = resolve(process.argv[4]!);
const comparison = JSON.parse(await readFile(comparisonPath, 'utf8'));
const ranking = JSON.parse(await readFile(rankingPath, 'utf8'));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(await readFile(comparisonPath)), ranking.comparison_sha256);
const selected = ranking.instruction_ranking.flatMap((family: { reason: string; occurrences: { cell: string; function: string }[] }) =>
  family.occurrences.map((occurrence) => ({ ...occurrence, reason: family.reason })));
assert.equal(selected.length, 12, 'Replay the full recorded integer-conversion demand');
await mkdir(output);
const results = [];
for (const occurrence of selected) {
  const run = comparison.runs.find((run: { tool: string; cell: string }) =>
    run.tool === 'open-decomp' && run.cell === occurrence.cell);
  const before = run.functions.find((row: { name: string }) => row.name === occurrence.function);
  assert.equal(sha256(await readFile(run.input.path)), run.input.sha256);
  const session = await openBinary(run.input.path, { cachePath: join(output, occurrence.cell + '-cache') });
  try {
    const result = await session.decompile({ address: { space: 'va', value: before.address } });
    assert.ok('data' in result && result.data.delivery === 'inline', JSON.stringify(result));
    const text = result.data.emission.text;
    const afterOccurrences = text.split(`opaque_effect(${JSON.stringify(occurrence.reason)}`).length - 1;
    assert.equal(afterOccurrences, 0, `${occurrence.cell}: selected instruction still unsupported`);
    results.push({ cell: occurrence.cell, function: occurrence.function, input_sha256: run.input.sha256,
      selected_reason: occurrence.reason, before_occurrences: 1, after_occurrences: afterOccurrences,
      state: result.state, diagnostics: result.diagnostics, coverage: result.coverage });
    await writeFile(join(output, occurrence.cell + '.json'), JSON.stringify(result, null, 2) + '\n');
  } finally { await session.close(); }
}
const evidence = { schema: 1, comparison_sha256: ranking.comparison_sha256, target_executed: false,
  scope: 'Static public API replay of every ranked integer-conversion occurrence, not a full matrix rerun or whole-function equivalence proof',
  selected_function_cells: results.length, before_instruction_occurrences: selected.length,
  after_instruction_occurrences: results.reduce((sum, row) => sum + row.after_occurrences, 0), results };
await writeFile(join(output, 'replay.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ selected: results.length, before: selected.length, after: evidence.after_instruction_occurrences }));

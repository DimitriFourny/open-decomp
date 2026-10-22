import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { runOdLane, firstFunctionsMs, largestPeak } from '../../scripts/bench/odbench/lane-od.js';
import {
  buildReport,
  renderMarkdown,
  renderScorecard,
} from '../../scripts/bench/odbench/report.js';
import { foldSample, nameProcesses } from '../../scripts/bench/odbench/rss.js';
import {
  D8_FIRST10_BINARY,
  D8_RATIO,
  d8Rows,
  laneSpeedFacts,
} from '../../scripts/bench/odbench/speed.js';
import { hostInfo, writeLane, writeText } from '../../scripts/bench/odbench/store.js';
import type {
  BinaryTiming,
  Corpus,
  CorpusFunction,
  FunctionResult,
  LaneKind,
  LaneRun,
} from '../../scripts/bench/odbench/types.js';

const SQLITE = D8_FIRST10_BINARY;
const SMALL = 'brotli';

const fn = (binary: string, name: string): CorpusFunction => ({
  id: `${binary}/${name}@0x1000`,
  binary,
  va: '0x1000',
  name,
  source: null,
  code_bytes: 64,
  size: 'small',
  tiers: ['quick', 'full'],
});
const corpus: Corpus = {
  schema: 'odbench-corpus/1',
  frozen: 'test',
  method: 'synthetic',
  binaries: [],
  sources: [],
  functions: [fn(SQLITE, 'a'), fn(SMALL, 'b')],
};

const timing = (
  cold: number,
  decompile: number,
  extra: Partial<BinaryTiming> = {},
): BinaryTiming => ({
  cold_ms: cold,
  import_ms: cold - decompile,
  analysis_ms: null,
  decompile_ms_total: decompile,
  ...extra,
});

async function lane(
  name: string,
  kind: LaneKind,
  binaries: Record<string, BinaryTiming>,
  jobs = 1,
): Promise<LaneRun> {
  const functions: Record<string, FunctionResult> = {};
  for (const item of corpus.functions)
    functions[item.id] = {
      state: 'complete',
      reason: null,
      ms: 5,
      ...(await writeText(name, item.id, `int ${item.name}(void) { return 1; }\n`)),
    };
  const run: LaneRun = {
    schema: 'odbench-lane/1',
    lane: name,
    kind,
    tool: { name: kind === 'ghidra' ? 'ghidra' : 'open-decomp', version: null, path: null },
    corpus_sha256: 'synthetic',
    tier: 'full',
    started: '2026-01-01T00:00:00.000Z',
    finished: '2026-01-01T00:01:00.000Z',
    host: hostInfo([0]),
    repeat: 1,
    jobs,
    binaries,
    functions,
    notes: [],
  };
  await writeLane(run);
  return run;
}

let directory: string;
const savedDir = process.env['OPEN_DECOMP_BENCH_DIR'];
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'odbench-speed-'));
  process.env['OPEN_DECOMP_BENCH_DIR'] = directory;
});
after(async () => {
  if (savedDir === undefined) delete process.env['OPEN_DECOMP_BENCH_DIR'];
  else process.env['OPEN_DECOMP_BENCH_DIR'] = savedDir;
  await rm(directory, { recursive: true, force: true });
});

const ghidraTimings = {
  [SQLITE]: timing(40_000, 3_000),
  [SMALL]: timing(4_000, 400),
};
const MB = 2 ** 20;

test('D8 rows: per binary and total ratio against the reference cold time, threshold 1.25', async () => {
  const reference = await lane('ghidra', 'ghidra', ghidraTimings);
  const od = await lane('od-new', 'od', {
    [SQLITE]: timing(60_000, 50_000, { open_ms: 2_000, first10_ms: 4_000, peak_rss: [] }),
    [SMALL]: timing(5_000, 4_000),
  });
  const rows = d8Rows(od, reference, [SQLITE, SMALL]);
  assert.deepEqual(
    rows.map((row) => [row.binary, row.decompile_ms, row.reference_ms, row.within]),
    [
      [SQLITE, 50_000, 40_000, true],
      [SMALL, 4_000, 4_000, true],
      [null, 54_000, 44_000, true],
    ],
  );
  assert.equal(rows[0]?.ratio, 1.25);
  assert.equal(rows[0]?.threshold, D8_RATIO);
  const slow = await lane('od-slow', 'od', {
    [SQLITE]: timing(70_000, 50_001),
    [SMALL]: timing(1_000, 100),
  });
  const slowRows = d8Rows(slow, reference, [SQLITE, SMALL]);
  assert.deepEqual(
    slowRows.map((row) => row.within),
    [false, true, true],
  );
  // Only an Open Decomp lane against a Ghidra reference has D8 rows.
  assert.deepEqual(d8Rows(reference, od, [SQLITE]), []);
  assert.deepEqual(d8Rows(od, od, [SQLITE]), []);
  // A binary one lane lacks is left out of the total.
  const partial = await lane('od-partial', 'od', { [SMALL]: timing(1_000, 800) });
  assert.deepEqual(
    d8Rows(partial, reference, [SQLITE, SMALL]).map((row) => row.binary),
    [SMALL, null],
  );
});

test('lane speed facts: SQLite first-10, summed open time, largest process peak; old lanes give nulls', async () => {
  const reference = await lane('ghidra', 'ghidra', ghidraTimings);
  const od = await lane('od-new', 'od', {
    [SQLITE]: timing(60_000, 50_000, {
      open_ms: 2_000,
      first10_ms: 4_000,
      peak_rss: [
        { role: 'bench worker', bytes: 200 * MB },
        { role: 'analysis worker', bytes: 900 * MB },
      ],
    }),
    [SMALL]: timing(5_000, 4_000, { open_ms: 500, first10_ms: null, peak_rss: [] }),
  });
  assert.deepEqual(laneSpeedFacts(od, reference, [SQLITE, SMALL]), {
    decompile_ms: 54_000,
    d8_ratio: 54_000 / 44_000,
    open_ms: 2_500,
    first10_ms: 4_000,
    peak_rss_bytes: 900 * MB,
  });
  const old = await lane('od-old', 'od', { [SQLITE]: timing(60_000, 50_000) });
  const facts = laneSpeedFacts(old, reference, [SQLITE]);
  assert.equal(facts.open_ms, null);
  assert.equal(facts.first10_ms, null);
  assert.equal(facts.peak_rss_bytes, null);
  assert.equal(facts.d8_ratio, 50_000 / 40_000);
});

test('report renders the D8 rows from a synthetic lane, and old lanes show n/a', async () => {
  await lane('ghidra', 'ghidra', ghidraTimings);
  await lane('od-new', 'od', {
    [SQLITE]: timing(60_000, 50_000, {
      open_ms: 2_000,
      first10_ms: 4_000,
      peak_rss: [{ role: 'analysis worker', bytes: 900 * MB }],
    }),
    [SMALL]: timing(9_000, 8_000),
  });
  await lane('od-old', 'od', { [SQLITE]: timing(60_000, 50_000), [SMALL]: timing(9_000, 8_000) });
  const report = await buildReport({
    corpus,
    corpusSha256: 'synthetic',
    tier: 'full',
    lanes: ['od-new', 'od-old'],
    reference: 'ghidra',
    judgments: null,
  });
  assert.deepEqual(
    report.speed.d8.filter((row) => row.lane === 'od-new').map((row) => row.ratio),
    [1.25, 2, 58_000 / 44_000],
  );
  const card = (name: string) => report.scorecard.find((item) => item.lane === name)!.speed.d8;
  assert.equal(card('od-new').first10_ms, 4_000);
  assert.equal(card('od-new').peak_rss_bytes, 900 * MB);
  assert.equal(card('od-old').first10_ms, null);
  assert.equal(card('ghidra').d8_ratio, null);

  const markdown = renderMarkdown(report);
  assert.match(markdown, /\| sqlite3-arm64 \| od-new \| 50\.0 s \| 40\.0 s \| 1\.25× \| within \|/);
  assert.match(markdown, /\| brotli \| od-new \| 8\.0 s \| 4\.0 s \| 2\.00× \| over \|/);
  assert.match(markdown, /\| total \| od-new \| 58\.0 s \| 44\.0 s \| 1\.32× \| over \|/);
  const scorecard = renderScorecard(report);
  assert.match(
    scorecard,
    /decompile time after open ÷ ghidra cold time \(D8\) \| 1\.32× \(over 1\.25×\)/,
  );
  assert.match(
    scorecard,
    /first 10 functions after open, sqlite3-arm64 \(D8\) \| 4\.00 s \(within 5\.00 s\)/,
  );
  assert.match(scorecard, /peak RSS, largest process \| 900 MB/);
  // The old lane has no first-10 / open / RSS: n/a, but its D8 ratio still renders.
  assert.match(
    scorecard,
    /first 10 functions after open, sqlite3-arm64 \(D8\) \| 4\.00 s \(within 5\.00 s\) \| — \| —/,
  );
  assert.match(
    markdown,
    /\| sqlite3-arm64 \| od-old \| 1m00s \| 10\.00 s \| — \| 50\.00 s \| — \| — \| — \|/,
  );
});

test('a jobs=1 lane re-renders unchanged through the store', async () => {
  await lane('ghidra', 'ghidra', ghidraTimings);
  const run = await lane(
    'od-j1',
    'od',
    { [SQLITE]: timing(60_000, 50_000), [SMALL]: timing(9_000, 8_000) },
    1,
  );
  const options = {
    corpus,
    corpusSha256: 'synthetic',
    tier: 'full' as const,
    lanes: ['od-j1'],
    reference: 'ghidra',
    judgments: null,
  };
  const first = await buildReport(options);
  await writeLane(run);
  const second = await buildReport(options);
  assert.equal(first.header.lanes.find((item) => item.lane === 'od-j1')?.jobs, 1);
  assert.equal(
    renderMarkdown({ ...first, generated: '' }),
    renderMarkdown({ ...second, generated: '' }),
  );
  assert.equal(
    first.speed.load_warnings.some((warning) => warning.includes('jobs=')),
    false,
  );
});

test('--jobs above 1 is refused until parallel requests exist', async () => {
  await assert.rejects(
    runOdLane({
      corpus,
      corpusSha256: 'synthetic',
      label: 'jobs-test',
      repo: directory,
      tier: 'quick',
      repeat: 1,
      inference: 'proven',
      only: null,
      jobs: 4,
    }),
    /--jobs 4 is not supported yet.*T9/,
  );
});

test('first10 is the 10th corpus function result, null below 10 functions', () => {
  const at = Array.from({ length: 12 }, (_, index) => (index + 1) * 100);
  assert.equal(firstFunctionsMs(at), 1000);
  assert.equal(firstFunctionsMs(at.slice(0, 9)), null);
  assert.equal(firstFunctionsMs([...at.slice(0, 9), null]), null);
});

test('largestPeak keeps the repeat with the largest process; process sampling follows the tree', () => {
  const small = [{ role: 'bench worker', bytes: 10 }];
  const big = [
    { role: 'bench worker', bytes: 5 },
    { role: 'analysis worker', bytes: 50 },
  ];
  assert.equal(largestPeak([small, big, small]), big);
  assert.deepEqual(largestPeak([]), []);

  const peaks = new Map<number, number>();
  foldSample(peaks, 10, [
    { pid: 1, ppid: 0, rssKb: 999_999 },
    { pid: 10, ppid: 1, rssKb: 100 },
    { pid: 11, ppid: 10, rssKb: 200 },
    { pid: 12, ppid: 11, rssKb: 300 },
    { pid: 20, ppid: 1, rssKb: 400 },
  ]);
  foldSample(peaks, 10, [
    { pid: 10, ppid: 1, rssKb: 90 },
    { pid: 11, ppid: 10, rssKb: 250 },
  ]);
  assert.deepEqual(nameProcesses(peaks, 10), [
    { role: 'bench worker', bytes: 100 * 1024 },
    { role: 'analysis worker', bytes: 250 * 1024 },
    { role: 'analysis worker', bytes: 300 * 1024 },
  ]);
});

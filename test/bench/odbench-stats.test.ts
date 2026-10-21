import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bootstrapCi,
  geomean,
  mean,
  median,
  mulberry32,
  pairedRatioGeomean,
  quantile,
  signTest,
} from '../../scripts/bench/odbench/stats.js';

const close = (actual: number, expected: number, tolerance = 1e-9): void =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} is not within ${tolerance} of ${expected}`,
  );

test('summaries: mean, median, quantile, geomean', () => {
  assert.equal(mean([1, 2, 3, 6]), 3);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  close(quantile([1, 2, 3, 4, 5], 0.9), 4.6);
  assert.equal(quantile([7], 0.9), 7);
  close(geomean([1, 4]), 2);
  close(geomean([0.5, 2]), 1);
  assert.ok(Number.isNaN(geomean([])));
  assert.ok(Number.isNaN(geomean([1, 0])));
  assert.ok(Number.isNaN(mean([])));
});

test('mulberry32 is deterministic and uniform enough', () => {
  const first = mulberry32(7);
  const second = mulberry32(7);
  const draws = Array.from({ length: 1000 }, () => first());
  assert.deepEqual(
    draws,
    Array.from({ length: 1000 }, () => second()),
  );
  assert.ok(draws.every((value) => value >= 0 && value < 1));
  assert.ok(Math.abs(mean(draws) - 0.5) < 0.05);
  assert.notEqual(mulberry32(8)(), mulberry32(7)());
});

test('bootstrap CI: deterministic per seed, contains the estimate, shrinks with agreement', () => {
  const values = [0.9, 1.1, 0.8, 1.3, 0.7, 1.0, 1.2, 0.95, 1.05, 0.85];
  const one = bootstrapCi(values, mean, { iterations: 500, seed: 11 });
  const again = bootstrapCi(values, mean, { iterations: 500, seed: 11 });
  const other = bootstrapCi(values, mean, { iterations: 500, seed: 12 });
  assert.deepEqual(one, again);
  assert.notDeepEqual(one, other);
  close(one.estimate, mean(values));
  assert.ok(one.lo <= one.estimate && one.estimate <= one.hi);
  assert.ok(one.lo < one.hi);
  const constant = bootstrapCi([2, 2, 2, 2], mean, { seed: 1 });
  assert.deepEqual(constant, { estimate: 2, lo: 2, hi: 2 });
  const empty = bootstrapCi([], mean);
  assert.ok(Number.isNaN(empty.estimate) && Number.isNaN(empty.lo) && Number.isNaN(empty.hi));
});

test('paired ratio geomean: per-function ratios, not a ratio of sums', () => {
  const a = [10, 50, 30, 8];
  const b = [20, 100, 15, 16];
  const result = pairedRatioGeomean(a, b, { seed: 3 });
  close(result.estimate, Math.pow(0.5 * 0.5 * 2 * 0.5, 1 / 4));
  assert.equal(result.n, 4);
  assert.ok(result.lo <= result.estimate && result.estimate <= result.hi);
  assert.deepEqual(pairedRatioGeomean(a, b, { seed: 3 }), result);
  // a pair with a zero is skipped, not turned into NaN or infinity
  const skipped = pairedRatioGeomean([4, 0, 9], [2, 5, 3], { seed: 3 });
  assert.equal(skipped.n, 2);
  close(skipped.estimate, Math.sqrt(2 * 3));
  assert.throws(() => pairedRatioGeomean([1], [1, 2]));
  // identical lanes: ratio exactly 1 with a degenerate interval
  const same = pairedRatioGeomean([3, 5, 9], [3, 5, 9], { seed: 3 });
  assert.deepEqual([same.estimate, same.lo, same.hi], [1, 1, 1]);
});

test('sign test: exact two-sided binomial p', () => {
  assert.equal(signTest(0, 0), 1);
  assert.equal(signTest(5, 5), 1);
  close(signTest(10, 0), 2 / 1024);
  close(signTest(0, 10), 2 / 1024);
  close(signTest(9, 1), (2 * 11) / 1024);
  close(signTest(7, 3), (2 * (1 + 10 + 45 + 120)) / 1024);
  close(signTest(1, 0), 1);
  close(signTest(8, 2), signTest(2, 8));
  close(signTest(60, 40), 0.0569, 0.0005);
});

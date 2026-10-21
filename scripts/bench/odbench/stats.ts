/** Small statistics kit for the report: summaries, seeded bootstrap, paired ratios, exact sign test. */

export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Linear-interpolation quantile (type 7); `q` in [0, 1]. */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.min(1, Math.max(0, q)) * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const lower = sorted[low] ?? Number.NaN;
  const upper = sorted[high] ?? Number.NaN;
  return lower + (upper - lower) * (position - low);
}

export function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

/** Geometric mean; NaN when empty or when any value is not positive. */
export function geomean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  let logSum = 0;
  for (const value of values) {
    if (!(value > 0)) return Number.NaN;
    logSum += Math.log(value);
  }
  return Math.exp(logSum / values.length);
}

/** mulberry32: 32-bit seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Interval {
  readonly estimate: number;
  readonly lo: number;
  readonly hi: number;
}

export interface BootstrapOptions {
  /** Resamples; default 2000. */
  readonly iterations?: number;
  /** PRNG seed; default 20261021. */
  readonly seed?: number;
  /** Coverage of the percentile interval; default 0.95. */
  readonly level?: number;
}

export const DEFAULT_SEED = 20261021;

/**
 * Percentile bootstrap over items: resamples `values` with replacement and takes the
 * (1-level)/2 and (1+level)/2 quantiles of `statistic`. Deterministic for a seed. Empty input
 * gives NaN everywhere; the interval is widened to include the point estimate.
 */
export function bootstrapCi(
  values: readonly number[],
  statistic: (sample: readonly number[]) => number,
  options: BootstrapOptions = {},
): Interval {
  const estimate = statistic(values);
  if (values.length === 0) return { estimate, lo: Number.NaN, hi: Number.NaN };
  const iterations = options.iterations ?? 2000;
  const level = options.level ?? 0.95;
  const random = mulberry32(options.seed ?? DEFAULT_SEED);
  const sample = new Array<number>(values.length);
  const draws: number[] = [];
  for (let round = 0; round < iterations; round++) {
    for (let index = 0; index < values.length; index++)
      sample[index] = values[Math.floor(random() * values.length)] ?? 0;
    const value = statistic(sample);
    if (!Number.isNaN(value)) draws.push(value);
  }
  if (draws.length === 0) return { estimate, lo: Number.NaN, hi: Number.NaN };
  const lo = quantile(draws, (1 - level) / 2);
  const hi = quantile(draws, (1 + level) / 2);
  return { estimate, lo: Math.min(lo, estimate), hi: Math.max(hi, estimate) };
}

export interface PairedRatio extends Interval {
  /** Pairs used: both values positive. */
  readonly n: number;
}

/**
 * Geometric mean of per-pair ratios `a[i] / b[i]` with a bootstrap CI over pairs. Pairs where either
 * value is not positive are skipped (their ratio is undefined); `n` counts the pairs used.
 */
export function pairedRatioGeomean(
  a: readonly number[],
  b: readonly number[],
  options: BootstrapOptions = {},
): PairedRatio {
  if (a.length !== b.length)
    throw new Error(`pairedRatioGeomean: ${a.length} values against ${b.length}`);
  const ratios: number[] = [];
  for (const [index, value] of a.entries()) {
    const other = b[index] ?? 0;
    if (value > 0 && other > 0) ratios.push(value / other);
  }
  return { ...bootstrapCi(ratios, geomean, options), n: ratios.length };
}

/** Exact two-sided binomial (sign) test of `wins` against `losses` under p = 1/2; ties are excluded by the caller. */
export function signTest(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const logFactorial = new Array<number>(n + 1).fill(0);
  for (let k = 2; k <= n; k++) logFactorial[k] = (logFactorial[k - 1] ?? 0) + Math.log(k);
  const logProbability = (k: number): number =>
    (logFactorial[n] ?? 0) - (logFactorial[k] ?? 0) - (logFactorial[n - k] ?? 0) - n * Math.LN2;
  const extreme = Math.min(wins, losses);
  let tail = 0;
  for (let k = 0; k <= extreme; k++) tail += Math.exp(logProbability(k));
  return Math.min(1, 2 * tail);
}

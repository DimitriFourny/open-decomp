/**
 * Speed rows of the report (roadmap 4, decision D8): after open, the decompile time of a binary's
 * corpus functions must stay within 1.25× of Ghidra's whole run on the same binary (`cold_ms` of the
 * Ghidra lane: JVM start, import, analysis and decompiles), per binary and in total, and the first
 * 10 functions on SQLite within 5 s. Open time and peak RSS are reported, not targeted. Lanes
 * recorded before these fields existed give nulls, which render as n/a.
 */
import type { BinaryTiming, LaneRun, ProcessRss } from './types.js';

/** D8: Open Decomp decompile time after open ÷ the reference's cold time must not exceed this. */
export const D8_RATIO = 1.25;
/** D8: the first 10 corpus functions of this binary must be done within this many milliseconds of open. */
export const D8_FIRST10_MS = 5000;
/** Corpus functions (in corpus order) that make up the first-decompiles row. */
export const FIRST_FUNCTIONS = 10;
export const D8_FIRST10_BINARY = 'sqlite3-arm64';

/** One row of the D8 comparison: a binary, or the total over the binaries both lanes timed. */
export interface D8Row {
  readonly lane: string;
  /** Null for the total row. */
  readonly binary: string | null;
  /** The lane's `decompile_ms_total` (after open). */
  readonly decompile_ms: number;
  /** The reference lane's `cold_ms`. */
  readonly reference_ms: number;
  readonly ratio: number;
  readonly threshold: number;
  readonly within: boolean;
}

/** Per-lane figures behind the scorecard's speed rows; every field is null for lanes lacking it. */
export interface LaneSpeedFacts {
  /** Sum of `decompile_ms_total`; null for lanes where it is not a time after open (Ghidra). */
  readonly decompile_ms: number | null;
  /** Total over the binaries both lanes timed ÷ the reference's cold time; null without D8 rows. */
  readonly d8_ratio: number | null;
  readonly open_ms: number | null;
  /** `first10_ms` of `D8_FIRST10_BINARY`. */
  readonly first10_ms: number | null;
  /** Largest peak RSS of any single process of any binary. */
  readonly peak_rss_bytes: number | null;
}

/** The largest process peak of one binary's run, null when none was recorded. */
export function largestRss(peak: readonly ProcessRss[] | undefined): number | null {
  return peak === undefined || peak.length === 0 ? null : Math.max(...peak.map((p) => p.bytes));
}

/** D8 applies to Open Decomp lanes against a Ghidra reference (its `cold_ms` is a whole run). */
function d8Applies(run: LaneRun, reference: LaneRun): boolean {
  return run.kind === 'od' && reference.kind === 'ghidra';
}

/** Per-binary D8 rows (order of `binaries`) and the total row last; empty when D8 does not apply. */
export function d8Rows(
  run: LaneRun,
  reference: LaneRun,
  binaries: readonly string[],
): readonly D8Row[] {
  if (!d8Applies(run, reference)) return [];
  const rows: D8Row[] = [];
  let decompile = 0;
  let cold = 0;
  for (const binary of binaries) {
    const own: BinaryTiming | undefined = run.binaries[binary];
    const other: BinaryTiming | undefined = reference.binaries[binary];
    if (!own || !other) continue;
    decompile += own.decompile_ms_total;
    cold += other.cold_ms;
    rows.push(d8Row(run.lane, binary, own.decompile_ms_total, other.cold_ms));
  }
  if (rows.length > 0) rows.push(d8Row(run.lane, null, decompile, cold));
  return rows;
}

function d8Row(
  lane: string,
  binary: string | null,
  decompile_ms: number,
  reference_ms: number,
): D8Row {
  const ratio = decompile_ms / reference_ms;
  return {
    lane,
    binary,
    decompile_ms,
    reference_ms,
    ratio,
    threshold: D8_RATIO,
    within: ratio <= D8_RATIO,
  };
}

export function laneSpeedFacts(
  run: LaneRun,
  reference: LaneRun,
  binaries: readonly string[],
): LaneSpeedFacts {
  const timings = binaries.flatMap((binary) => {
    const timing = run.binaries[binary];
    return timing ? [timing] : [];
  });
  const opens = timings.flatMap((timing) =>
    typeof timing.open_ms === 'number' ? [timing.open_ms] : [],
  );
  const peaks = timings.flatMap((timing) => {
    const peak = largestRss(timing.peak_rss);
    return peak === null ? [] : [peak];
  });
  const total = d8Rows(run, reference, binaries).find((row) => row.binary === null);
  return {
    decompile_ms:
      run.kind === 'od' && timings.length > 0
        ? timings.reduce((sum, timing) => sum + timing.decompile_ms_total, 0)
        : null,
    d8_ratio: total?.ratio ?? null,
    open_ms: opens.length === 0 ? null : opens.reduce((sum, ms) => sum + ms, 0),
    first10_ms: run.binaries[D8_FIRST10_BINARY]?.first10_ms ?? null,
    peak_rss_bytes: peaks.length === 0 ? null : Math.max(...peaks),
  };
}

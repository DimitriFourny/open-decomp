/** Lane store: `<bench dir>/lanes/<lane>/lane.json` plus `texts/<fnKey>.c`. */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { cpus, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';
import { fnKey, paths, sha256 } from './types.js';
import type { FunctionResult, HostInfo, LaneRun } from './types.js';

export function hostInfo(loadavgStart: readonly number[]): HostInfo {
  return {
    platform: `${process.platform}-${process.arch}`,
    cpu: cpus()[0]?.model ?? 'unknown',
    cores: cpus().length,
    memory_bytes: totalmem(),
    node: process.version,
    loadavg_start: loadavgStart,
    loadavg_end: loadavg(),
  };
}

/** Empties a lane directory before a fresh run (texts of an earlier run never leak into a new one). */
export async function resetLane(lane: string): Promise<void> {
  await rm(paths.lane(lane), { recursive: true, force: true });
  await mkdir(join(paths.lane(lane), 'texts'), { recursive: true });
}

/** Writes one function text; returns the FunctionResult text fields. */
export async function writeText(
  lane: string,
  fn: string,
  text: string,
): Promise<Pick<FunctionResult, 'text_file' | 'sha256' | 'bytes'>> {
  const file = `texts/${fnKey(fn)}.c`;
  await mkdir(join(paths.lane(lane), 'texts'), { recursive: true });
  await writeFile(join(paths.lane(lane), file), text);
  return { text_file: file, sha256: sha256(text), bytes: Buffer.byteLength(text) };
}

export async function writeLane(run: LaneRun): Promise<void> {
  const target = join(paths.lane(run.lane), 'lane.json');
  await mkdir(paths.lane(run.lane), { recursive: true });
  await writeFile(`${target}.tmp`, `${JSON.stringify(run, null, 2)}\n`);
  await rename(`${target}.tmp`, target);
}

/** The lane manifest, or null when the lane was never run. */
export async function readLane(lane: string): Promise<LaneRun | null> {
  try {
    const run = JSON.parse(await readFile(join(paths.lane(lane), 'lane.json'), 'utf8')) as LaneRun;
    if (run.schema !== 'odbench-lane/1')
      throw new Error(`${lane}: unknown lane schema ${String(run.schema)}`);
    return run;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** A function's text from a lane, or null when the lane has none for it. Verifies the recorded hash. */
export async function readText(run: LaneRun, fn: string): Promise<string | null> {
  const result = run.functions[fn];
  if (!result?.text_file) return null;
  const text = await readFile(join(paths.lane(run.lane), result.text_file), 'utf8');
  if (result.sha256 !== null && sha256(text) !== result.sha256)
    throw new Error(`${run.lane}: ${result.text_file} changed after the run (hash mismatch)`);
  return text;
}

/**
 * Peak resident set size of a process tree. The OD API runs its analysis in child processes, so the
 * bench worker's own `maxRSS` says little: the parent samples `ps` for the worker and every
 * descendant and keeps each process's largest sample. A peak shorter than the sampling interval can
 * be missed (the figure is a lower bound); the worker reports its own exact `maxRSS` separately.
 */
import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ProcessRss } from './types.js';

const INTERVAL_MS = 200;

interface PsRow {
  readonly pid: number;
  readonly ppid: number;
  readonly rssKb: number;
}

function snapshot(): Promise<readonly PsRow[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' }, (error, stdout) => {
      if (error) return resolve([]);
      const rows: PsRow[] = [];
      for (const line of stdout.split('\n')) {
        const [pid, ppid, rss] = line.trim().split(/\s+/).map(Number);
        if (pid !== undefined && ppid !== undefined && rss !== undefined)
          if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isFinite(rss))
            rows.push({ pid, ppid, rssKb: rss });
      }
      resolve(rows);
    });
  });
}

/** Pure part of the sampler: folds one `ps` snapshot into per-process peaks (bytes, by pid). */
export function foldSample(
  peaks: Map<number, number>,
  rootPid: number,
  rows: readonly PsRow[],
): void {
  const children = new Map<number, number[]>();
  const rss = new Map<number, number>();
  for (const row of rows) {
    rss.set(row.pid, row.rssKb * 1024);
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  const pending = [rootPid];
  for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
    const bytes = rss.get(pid);
    if (bytes !== undefined) peaks.set(pid, Math.max(peaks.get(pid) ?? 0, bytes));
    pending.push(...(children.get(pid) ?? []));
  }
}

/** Names the peaks: the root is the bench worker, every descendant an analysis worker (pid order = start order). */
export function nameProcesses(
  peaks: ReadonlyMap<number, number>,
  rootPid: number,
): readonly ProcessRss[] {
  return [...peaks]
    .sort(([a], [b]) => (a === rootPid ? -1 : b === rootPid ? 1 : a - b))
    .map(([pid, bytes]) => ({ role: pid === rootPid ? 'bench worker' : 'analysis worker', bytes }));
}

/** Starts sampling `rootPid`'s tree; `stop()` takes a last sample and returns the named peaks. */
export function sampleProcessTree(rootPid: number): { stop(): Promise<readonly ProcessRss[]> } {
  const peaks = new Map<number, number>();
  let running = true;
  const loop = (async (): Promise<void> => {
    while (running) {
      foldSample(peaks, rootPid, await snapshot());
      await sleep(INTERVAL_MS);
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return nameProcesses(peaks, rootPid);
    },
  };
}

/**
 * Navigation benchmark: the requests an interactive client (OpenReverse) makes on a binary,
 * timed through the public API, as a client would see them.
 *
 *   node --import tsx scripts/bench/browse.ts BINARY [--limit N] [--cache DIR] [--source]
 *     [--discovery-instructions N] [--no-cfg] [--no-xrefs]
 *
 * Phases: open (import, or resume with a --cache that holds the project), whole-image
 * discovery to its end under the client's budget (`completeDiscovery`), the function index, then for each
 * function (in address order, at most --limit): its compact disassembly (every page; what
 * an immediate search or a listing reads), its CFG (what a graph view reads; it follows the
 * listing, so it measures the graph cache) and its outgoing references (what a listing
 * annotates). Prints each phase's time, per-function medians, the store size and the peak
 * resident memory of the process tree (Linux). Imports the built `dist/` unless --source.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type * as Api from '../../src/api/index.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    limit: { type: 'string' },
    cache: { type: 'string' },
    source: { type: 'boolean', default: false },
    'discovery-instructions': { type: 'string', default: '1000000' },
    'no-cfg': { type: 'boolean', default: false },
    'no-xrefs': { type: 'boolean', default: false },
  },
});
const input = positionals[0];
if (!input) {
  console.error('Usage: scripts/bench/browse.ts BINARY [--limit N] [--cache DIR] [--source]');
  process.exit(2);
}
// Runtime-selected module: the built output by default, as a client imports it.
const api = (await import(
  new URL(values.source ? '../../src/api/index.js' : '../../dist/src/api/index.js', import.meta.url)
    .href
)) as typeof Api;

/** Resident memory of this process and its descendants (Linux /proc), in bytes. */
function treeRss(): number {
  let total = 0;
  const stack = [process.pid];
  while (stack.length) {
    const pid = stack.pop()!;
    try {
      const rss = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
      total += rss ? Number(rss[1]) * 1024 : 0;
      for (const task of readdirSync(`/proc/${pid}/task`))
        for (const child of readFileSync(`/proc/${pid}/task/${task}/children`, 'utf8').split(' '))
          if (child.trim()) stack.push(Number(child));
    } catch {
      // Not Linux, or the process exited meanwhile.
    }
  }
  return total;
}
let peak = 0;
const sampler = setInterval(() => (peak = Math.max(peak, treeRss())), 250);
sampler.unref();

const ownCache = values.cache === undefined;
const cachePath = values.cache ?? mkdtempSync(join(tmpdir(), 'open-decomp-browse-'));
const ms = (start: number): string => `${((performance.now() - start) / 1000).toFixed(2)} s`;
const quantiles = (times: number[]): string => {
  const sorted = [...times].sort((a, b) => a - b);
  const at = (q: number): string => (sorted[Math.floor(q * (sorted.length - 1))] ?? 0).toFixed(1);
  return `median ${at(0.5)} ms, p90 ${at(0.9)} ms, max ${at(1)} ms`;
};
type Data<T> = T extends { data: infer D } ? D : never;
function data<T extends { state: string }>(result: T, what: string): Data<T> {
  if (!('data' in result) || result.data === null)
    throw new Error(`${what}: ${JSON.stringify(result).slice(0, 600)}`);
  return result.data as Data<T>;
}

let started = performance.now();
const session = await api.openBinary(input, { cachePath });
try {
  console.log(`open (${session.reused ? 'resume' : 'import'}): ${ms(started)}`);
  // The client's discovery budget (OpenReverse): the largest OpenDecomp accepts.
  const budget = {
    instructions: Number(values['discovery-instructions']),
    blocks: 100_000,
    ir_nodes: 10_000_000,
    work: 100_000_000,
    deadline_ms: 300_000,
  };
  started = performance.now();
  const before = session.revision;
  try {
    await session.completeDiscovery(budget);
    console.log(`discovery: ${ms(started)}, revision ${before} -> ${session.revision}`);
  } catch (error) {
    console.log(
      `discovery failed after ${ms(started)} (revision ${session.revision}): ${(error instanceof Error ? error.message : String(error)).slice(0, 400)}`,
    );
  }

  started = performance.now();
  type Fn = Data<Awaited<ReturnType<Api.BinarySession['findFunctions']>>>['items'][number];
  const functions: Fn[] = [];
  let cursor: string | undefined;
  do {
    const page = data(
      await session.findFunctions({ page: { limit: 1000, ...(cursor ? { cursor } : {}) } }),
      'functions_find',
    );
    functions.push(...page.items);
    cursor = page.page.next_cursor ?? undefined;
  } while (cursor);
  console.log(`function index: ${functions.length} functions, ${ms(started)}`);

  const selected = functions.slice(
    0,
    values.limit === undefined ? undefined : Number(values.limit),
  );
  const times = { disassembly: [] as number[], cfg: [] as number[], xrefs: [] as number[] };
  let instructions = 0;
  started = performance.now();
  for (const fn of selected) {
    let at = performance.now();
    let page: string | undefined;
    do {
      const result = await session.getFunction(fn.id, {
        view: 'disassembly',
        detail: 'compact',
        page: { limit: 1000, ...(page ? { cursor: page } : {}) },
      });
      if (!('data' in result)) break;
      instructions += (result.data as { items: unknown[] }).items.length;
      page =
        (result.data as { page: { next_cursor: string | null } }).page.next_cursor ?? undefined;
    } while (page);
    times.disassembly.push(performance.now() - at);
    if (!values['no-cfg']) {
      at = performance.now();
      await session.getFunction(fn.id, { view: 'cfg', page: { limit: 1000 } });
      times.cfg.push(performance.now() - at);
    }
    if (!values['no-xrefs']) {
      at = performance.now();
      await session.getReferences({
        target: { kind: 'entity', id: fn.id },
        direction: 'outgoing',
        page: { limit: 1000 },
      } as Parameters<Api.BinarySession['getReferences']>[0]);
      times.xrefs.push(performance.now() - at);
    }
  }
  console.log(`${selected.length} functions (${instructions} instructions): ${ms(started)}`);
  for (const [name, list] of Object.entries(times))
    if (list.length)
      console.log(
        `  ${name}: ${(list.reduce((a, b) => a + b, 0) / 1000).toFixed(2)} s; ${quantiles(list)}`,
      );
  const database = join(session.projectPath, 'project.sqlite');
  console.log(`project database: ${(statSync(database).size / 1e6).toFixed(1)} MB`);
} finally {
  await session.close();
  clearInterval(sampler);
  console.log(`peak resident memory (process tree): ${(peak / 1e6).toFixed(0)} MB`);
  if (ownCache) rmSync(cachePath, { recursive: true, force: true });
}

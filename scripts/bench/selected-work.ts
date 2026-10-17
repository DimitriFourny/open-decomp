import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { observeSelectedWork } from './selected-work-hooks.js';
import type { Budget, FunctionGraph, FunctionRecord, OperationContext } from '../../src/core/index.js';

// Usage: node --import tsx scripts/bench/selected-work.ts --mode diagnose|public
//   --contract /retained/contract.json [--import-instructions 1000000]
//   [--instructions 10000] [--function sqlite3_complete]
// Counts are diagnostic evidence, deliberately not latency/throughput benchmarks.
const flags = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i], value = process.argv[i + 1];
  assert.ok(flag && value && ['--mode', '--contract', '--import-instructions', '--instructions', '--function'].includes(flag), 'Expected a documented flag/value pair');
  flags.set(flag, value);
}
const mode = flags.get('--mode') ?? 'diagnose';
assert.ok(mode === 'diagnose' || mode === 'public');
const contractPath = resolve(flags.get('--contract') ?? '/tmp/open-decomp-ghidra-compare.sfUkLc/contract.json');
const contract = JSON.parse(await readFile(contractPath, 'utf8')) as {
  binaries: { path: string; functions: string[] }[];
};
const target = contract.binaries.find((entry) => entry.path.endsWith('/sqlite3-arm64'));
assert.ok(target, 'Contract must identify the original SQLite binary and selected functions');
const selectedNames = flags.has('--function') ? [flags.get('--function')!] : target.functions;
for (const name of selectedNames) assert.ok(target.functions.includes(name), 'Function must belong to the reviewed selection');
const root = await mkdtemp(join(tmpdir(), 'open-decomp-selected-work-'));
const report = (value: object): void => { console.log(JSON.stringify(value, (_, item: unknown) => typeof item === 'bigint' ? `0x${item.toString(16)}` : item)); };
const fnInfo = (fn: FunctionRecord) => ({ name: fn.original_name, entry: fn.entry.value, ranges: fn.ranges, analysis: fn.analysis, boundary: fn.boundary });
interface Span {
  kind: string;
  details: unknown;
  counts: Record<string, number>;
  work: number;
}
const spans: Span[] = [];
let operation = 'load';
let work = 0;
let events: object[] = [];
const summarizeGraph = (graph: Pick<FunctionGraph, 'function' | 'instructions' | 'blocks' | 'gaps'>) => ({
  ...fnInfo(graph.function), instructions: graph.instructions.length,
  blocks: graph.blocks.length, cfg_edges: graph.blocks.reduce((n, block) => n + block.edges.length, 0),
  budget_gaps: graph.gaps.filter((gap) => gap.reason === 'budget').length,
  gap_reasons: [...new Set(graph.gaps.map((gap) => gap.reason))],
});
const stop = mode === 'diagnose' ? observeSelectedWork((event, value) => {
  if (event.endsWith('_enter')) {
    spans.push({ kind: event.slice(0, -6), details: value, counts: {}, work });
    return;
  }
  if (event.endsWith('_exit')) {
    const span = spans.pop();
    assert.equal(span?.kind, event.slice(0, -5));
    events.push({ ...span, work: work - span!.work });
    return;
  }
  const current = spans.at(-1);
  if (value === undefined && current) {
    current.counts[event] = (current.counts[event] ?? 0) + 1;
    return;
  }
  if (event === 'discovery_result') {
    const result = value as { graphs: FunctionGraph[]; decoded: number; overlaps: unknown[]; boundary_claims: unknown[]; coverage_reasons: string[] };
    events.push({ event, decoded: result.decoded, functions: result.graphs.length,
      owned_instructions: result.graphs.reduce((n, graph) => n + graph.instructions.length, 0),
      blocks: result.graphs.reduce((n, graph) => n + graph.blocks.length, 0),
      cfg_edges: result.graphs.reduce((n, graph) => n + graph.blocks.reduce((m, block) => m + block.edges.length, 0), 0),
      overlaps: result.overlaps.length, boundary_claims: result.boundary_claims.length,
      coverage_reasons: result.coverage_reasons,
      selected: result.graphs.filter((graph) => target.functions.some((name) => graph.function.original_name === `_${name}` || graph.function.original_name === name)).map(summarizeGraph),
    });
  } else if (event === 'selected_result') {
    events.push({ event, ...summarizeGraph(value as FunctionGraph) });
  } else if (event === 'native_target') {
    const item = value as { function: FunctionRecord; call_ids: string[]; remainingInstructions: number; remainingBlocks: number; remainingNodes: number };
    events.push({ event, ...fnInfo(item.function), calls: item.call_ids.length,
      remaining_instructions: item.remainingInstructions, remaining_blocks: item.remainingBlocks, remaining_nodes: item.remainingNodes });
  } else if (event === 'native_graph') {
    const item = value as { function: FunctionRecord };
    events.push({ event, ...value as object, function: fnInfo(item.function) });
  } else events.push({ event, ...value as object });
}) : () => {};
// Delayed imports intentionally exercise module-loading boundaries: observation
// hooks must be registered before any production module is evaluated.
const core = await import('../../src/core/index.js');
const instructionLimit = core.budgetSchema.shape.instructions.parse(Number(flags.get('--instructions') ?? core.DEFAULT_BUDGET.instructions));
const importLimit = core.budgetSchema.shape.instructions.parse(Number(flags.get('--import-instructions') ?? core.DEFAULT_BUDGET.instructions));
// Only discovery ceilings differ in the raised profile; never change production defaults.
// Work/deadline are raised solely for observation so image-wide counters can finish.
const budgetFor = (instructions: number): Budget => core.budgetSchema.parse(mode === 'public'
  ? { instructions }
  : { instructions, blocks: 100_000, work: 100_000_000, deadline_ms: 300_000, ir_nodes: 10_000_000 });
function context(instructions: number): OperationContext {
  const base = core.createOperationContext({ budget: budgetFor(instructions), onProgress(phase, completed, total) {
    events.push({ event: 'progress', phase, completed, total, work });
  } });
  return { ...base, checkpoint(charge) { work += charge; base.checkpoint(charge); } };
}
function flush(extra: object): void {
  report({ schema: 'open-decomp/selected-work/1', mode, operation, work, ...extra, events });
  events = []; work = 0;
}
report({ schema: 'open-decomp/selected-work/1', kind: 'identity', node: process.version, binary: target.path,
  sha256: core.contentHash(await readFile(target.path)), contract: contractPath, selected: selectedNames,
  import_budget: budgetFor(importLimit), query_budget: budgetFor(instructionLimit),
  observation: mode === 'public' ? 'Uninstrumented original QueryService/worker path, fresh isolated project' : 'Trusted fail-closed module hooks and cumulative context checkpoints; counts only, no performance claims' });
try {
  if (mode === 'public') {
    const { QueryService } = await import('../../src/service/queries/index.js');
    const service = await QueryService.create({ authorized_roots: [root, dirname(target.path)], max_workers: 1 });
    try {
      const opened = await service.execute('project_open', {
        source: { kind: 'import', input_path: target.path, project_path: join(root, 'project') }, wait: true,
        budget: budgetFor(importLimit),
      });
      report({ operation: 'project_open', result: opened });
      assert.ok('data' in opened && opened.data.image && opened.project_id && opened.revision);
      const scope = { project_id: opened.project_id, revision: opened.revision, budget: budgetFor(instructionLimit) };
      for (const name of selectedNames) {
        const found = await service.execute('functions_find', { ...scope, image_id: opened.data.image.id, query: { text: name }, page: { limit: 100 } });
        assert.ok('data' in found);
        const fn = found.data.items.find((item) => item.original_name === `_${name}` || item.original_name === name);
        assert.ok(fn, `Missing reviewed function ${name}`);
        const result = await service.execute('function_decompile', { ...scope, function_id: fn.id, wait: true }, {
          onProgress(job) { events.push({ phase: job.progress.phase, state: job.state }); },
        });
        report({ operation: 'function_decompile', name, function: fn, result, progress: events });
        events = [];
      }
    } finally { await service.close(); }
  } else {
    const { MachOLoader } = await import('../../src/loaders/macho/index.js');
    const { SqliteProjectStore } = await import('../../src/project/store/index.js');
    const { prepareQueryImport } = await import('../../src/service/queries/prepare.js');
    const { executeDecompilation } = await import('../../src/service/analysis/index.js');
    const { records } = await import('../../src/service/queries/scope.js');
    const input = await readFile(target.path);
    const bytes = new core.ImmutableBytes(input);
    const sha256 = core.contentHash(input);
    const image = new MachOLoader().load({ bytes, sha256, image_id: core.imageIdentity(sha256), slice_id: null }, context(importLimit));
    flush({ image_id: image.id, symbols: image.symbols.length, hints: image.hints.length });
    const store = SqliteProjectStore.open(join(root, 'project'), 'create');
    try {
      await store.importImage({ bytes: image.bytes, sha256, selected_slice_id: image.selected_slice_id });
      operation = 'prepare_import';
      const prepared = await prepareQueryImport(image, { revision: 2, context: context(importLimit) });
      assert.equal(store.transaction(1, (tx) => { tx.putImage(prepared.image); prepared.publish(tx); }).state, 'committed');
      flush({});
      const functions = records({ store, context: context(importLimit) }, 2, image.id, 'function').items;
      events = []; work = 0;
      for (const name of selectedNames) {
        operation = name;
        const fn = functions.find((item) => item.original_name === `_${name}` || item.original_name === name);
        assert.ok(fn, `Missing reviewed function ${name}`);
        const job_id = core.newIdentity('job');
        store.saveJob({ id: job_id, project_id: store.project_id, input_revision: 2, operation: 'function_decompile', state: 'running', progress: { phase: 'running', completed: 0, total: null }, diagnostics: [], artifacts: [], published_revision: null });
        const args = core.toolSchemas.function_decompile.input.parse({ project_id: store.project_id, revision: 2, function_id: fn.id, wait: true, budget: budgetFor(instructionLimit) });
        try {
          const result = await executeDecompilation(args, { store, job_id, context: context(instructionLimit) });
          flush({ function: fnInfo(fn), result: { state: result.state, diagnostics: result.diagnostics, coverage: result.coverage } });
        } catch (error) {
          flush({
            function: fnInfo(fn),
            error: error instanceof core.OperationError ? error.diagnostic :
              { message: error instanceof Error ? error.message : String(error) },
          });
        }
      }
    } finally { await store.close(); }
  }
} finally { stop(); await rm(root, { recursive: true, force: true }); }

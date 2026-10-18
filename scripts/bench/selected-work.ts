import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadSelectedContract } from './selected-contract.js';
import { observeSelectedWork } from './selected-work-hooks.js';
import type {
  Budget,
  FunctionGraph,
  FunctionRecord,
  OperationContext,
} from '../../src/core/index.js';

// Usage: node --import tsx scripts/bench/selected-work.ts --mode diagnose|public
//   --inputs DIR [--contract selected-contract.json] [--import-instructions 1000000]
//   (DIR holds corpus-arm64 and sqlite3-arm64; $OPEN_DECOMP_BENCH_INPUTS also works)
//   Fetch: node --import tsx scripts/bench/fetch-evidence.ts --only baseline-2026-10-17.tar.gz
//   Extract inputs/ from ${OPEN_DECOMP_EVIDENCE_DIR:-.local/evidence}/scripts/bench/
//   quality-evidence/baseline-2026-10-17.tar.gz (see docs/PERFORMANCE.md).
//   [--instructions 10000] [--function sqlite3_complete] [--binary corpus-arm64]
//   [--work 1000000] (count-only observation ceiling; public defaults stay unchanged)
//   [--work-sites true|all|PHASE] (expensive checkpoint-site census, never timing)
//   [--emitter c-like|python-like] (one dialect per fresh isolated public project)
//   [--view source|checked] (same explicit presentation view in both modes)
// Counts are diagnostic evidence, deliberately not latency/throughput benchmarks.
const flags = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i],
    value = process.argv[i + 1];
  assert.ok(
    flag &&
      value &&
      [
        '--mode',
        '--contract',
        '--inputs',
        '--import-instructions',
        '--instructions',
        '--function',
        '--binary',
        '--work',
        '--work-sites',
        '--emitter',
        '--view',
      ].includes(flag),
    'Expected a documented flag/value pair',
  );
  flags.set(flag, value);
}
const workSitePhase = flags.get('--work-sites') === 'true' ? 'emit' : flags.get('--work-sites');
const mode = flags.get('--mode') ?? 'diagnose';
assert.ok(mode === 'diagnose' || mode === 'public');
const emitter = flags.get('--emitter') ?? 'c-like';
assert.ok(emitter === 'c-like' || emitter === 'python-like');
const view = flags.get('--view') ?? 'source';
assert.ok(view === 'source' || view === 'checked');
const { contractPath, binaries } = await loadSelectedContract(flags);
const selectedBinary = flags.get('--binary') ?? 'sqlite3-arm64';
const target = binaries.find((entry) => entry.name === selectedBinary);
assert.ok(target, 'Contract must identify the reviewed binary and selected functions');
const selectedNames = flags.has('--function') ? [flags.get('--function')!] : target.functions;
for (const name of selectedNames)
  assert.ok(target.functions.includes(name), 'Function must belong to the reviewed selection');
const root = await mkdtemp(join(tmpdir(), 'open-decomp-selected-work-'));
const report = (value: object): void => {
  console.log(
    JSON.stringify(value, (_, item: unknown) =>
      typeof item === 'bigint' ? `0x${item.toString(16)}` : item,
    ),
  );
};
const fnInfo = (fn: FunctionRecord) => ({
  name: fn.original_name,
  entry: fn.entry.value,
  ranges: fn.ranges,
  analysis: fn.analysis,
  boundary: fn.boundary,
});
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
const workSites = new Map<string, number>();
const mappingTotals: Record<string, number> = {
  mappings: 0,
  subjects: 0,
  unique_subjects: 0,
  inputs: 0,
  unique_inputs: 0,
};
const mappingKeys = new Set<string>(),
  mappingSubjectKeys = new Set<string>();
const summarizeGraph = (
  graph: Pick<FunctionGraph, 'function' | 'instructions' | 'blocks' | 'gaps'>,
) => ({
  ...fnInfo(graph.function),
  instructions: graph.instructions.length,
  blocks: graph.blocks.length,
  cfg_edges: graph.blocks.reduce((n, block) => n + block.edges.length, 0),
  budget_gaps: graph.gaps.filter((gap) => gap.reason === 'budget').length,
  gap_reasons: [...new Set(graph.gaps.map((gap) => gap.reason))],
});
const stop =
  mode === 'diagnose'
    ? observeSelectedWork((event, value) => {
        if (event === 'mapping_shape') {
          mappingTotals['mappings'] = (mappingTotals['mappings'] ?? 0) + 1;
          for (const [key, count] of Object.entries(value as Record<string, unknown>))
            if (typeof count === 'number') mappingTotals[key] = (mappingTotals[key] ?? 0) + count;
          const shape = value as { key: string; subjects_key: string };
          mappingKeys.add(shape.key);
          mappingSubjectKeys.add(shape.subjects_key);
          return;
        }
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
        if (
          [
            'ssa_snapshot',
            'binding_reference_array',
            'stack_barrier_scan',
            'stack_escape_scan',
          ].includes(event) &&
          current
        ) {
          const row = value as {
            cells?: number;
            bytes?: number;
            reusable?: boolean;
            repeated?: boolean;
            eligible?: boolean;
          };
          const units = row.cells ?? row.bytes ?? 0,
            unit = row.bytes === undefined ? 'cells' : 'bytes';
          const add = (key: string, count: number): void => {
            current.counts[key] = (current.counts[key] ?? 0) + count;
          };
          add(`${event}_calls`, 1);
          add(`${event}_${unit}`, units);
          if (row.reusable || row.repeated) add(`${event}_repeat_${unit}`, units);
          if (row.eligible) add(`${event}_eligible_${unit}`, units);
          if (row.eligible && row.repeated) add(`${event}_eligible_repeat_${unit}`, units);
          return;
        }
        if ((event === 'stack_transfer_visit' || event === 'stack_node_visit') && current) {
          const visit = value as { block?: string; record: boolean };
          const phase = visit.record ? 'record' : 'solve';
          const counter =
            event === 'stack_node_visit' ? `stack_${phase}_nodes` : `stack_${phase}:${visit.block}`;
          current.counts[counter] = (current.counts[counter] ?? 0) + 1;
          return;
        }
        if (value === undefined && current) {
          current.counts[event] = (current.counts[event] ?? 0) + 1;
          return;
        }
        if (event === 'discovery_result') {
          const result = value as {
            graphs: FunctionGraph[];
            decoded: number;
            overlaps: unknown[];
            boundary_claims: unknown[];
            coverage_reasons: string[];
          };
          events.push({
            event,
            decoded: result.decoded,
            functions: result.graphs.length,
            owned_instructions: result.graphs.reduce(
              (n, graph) => n + graph.instructions.length,
              0,
            ),
            blocks: result.graphs.reduce((n, graph) => n + graph.blocks.length, 0),
            cfg_edges: result.graphs.reduce(
              (n, graph) => n + graph.blocks.reduce((m, block) => m + block.edges.length, 0),
              0,
            ),
            overlaps: result.overlaps.length,
            boundary_claims: result.boundary_claims.length,
            coverage_reasons: result.coverage_reasons,
            selected: result.graphs
              .filter((graph) =>
                target.functions.some(
                  (name) =>
                    graph.function.original_name === `_${name}` ||
                    graph.function.original_name === name,
                ),
              )
              .map(summarizeGraph),
          });
        } else if (event === 'selected_result') {
          events.push({ event, ...summarizeGraph(value as FunctionGraph) });
        } else if (event === 'native_target') {
          const item = value as { function: FunctionRecord; budget: unknown };
          events.push({ event, work, ...fnInfo(item.function), preparation_budget: item.budget });
        } else if (event === 'native_graph') {
          const item = value as { function: FunctionRecord };
          events.push({ event, work, ...(value as object), function: fnInfo(item.function) });
        } else events.push({ event, work, ...(value as object) });
      })
    : () => {};
// Delayed imports intentionally exercise module-loading boundaries: observation
// hooks must be registered before any production module is evaluated.
const core = await import('../../src/core/index.js');
const instructionLimit = core.budgetSchema.shape.instructions.parse(
  Number(flags.get('--instructions') ?? core.DEFAULT_BUDGET.instructions),
);
const importLimit = core.budgetSchema.shape.instructions.parse(
  Number(flags.get('--import-instructions') ?? core.DEFAULT_BUDGET.instructions),
);
// Only discovery ceilings differ in the raised profile; never change production defaults.
// Work/deadline are raised solely for observation so image-wide counters can finish.
const budgetFor = (instructions: number): Budget =>
  core.budgetSchema.parse(
    mode === 'public'
      ? { instructions }
      : {
          instructions,
          blocks: 100_000,
          work: Number(flags.get('--work') ?? 100_000_000),
          deadline_ms: 300_000,
          ir_nodes: 10_000_000,
        },
  );
function context(instructions: number): OperationContext {
  let currentPhase = '';
  const base = core.createOperationContext({
    budget: budgetFor(instructions),
    onProgress(phase, completed, total) {
      currentPhase = phase;
      events.push({ event: 'progress', phase, completed, total, work });
    },
  });
  return {
    ...base,
    checkpoint(charge) {
      work += charge;
      if (charge > 0 && (workSitePhase === 'all' || currentPhase === workSitePhase)) {
        const site = new Error().stack
          ?.split('\n')
          .find(
            (line) =>
              line.includes('/src/') &&
              !line.includes('/service/analysis/index.') &&
              !line.includes('/core/operation.') &&
              !line.includes('/analysis/ssa/budget.') &&
              !line.includes('/service/analysis/passes.') &&
              !line.includes('/ir/budget.') &&
              !line.includes('at Object.checkpoint '),
          );
        if (site) {
          const key =
            workSitePhase === 'all'
              ? `${currentPhase || 'unphased'} | ${site.trim()}`
              : site.trim();
          workSites.set(key, (workSites.get(key) ?? 0) + charge);
        }
      }
      base.checkpoint(charge);
    },
  };
}
function flush(extra: object): void {
  report({
    schema: 'open-decomp/selected-work/1',
    mode,
    operation,
    work,
    ...extra,
    events,
    ...(workSites.size
      ? { emission_work_sites: Object.fromEntries([...workSites].sort((a, b) => b[1] - a[1])) }
      : {}),
  });
  if (mappingTotals['mappings'])
    report({
      schema: 'open-decomp/selected-mappings/1',
      operation,
      ...mappingTotals,
      unique_inputs_keys: mappingKeys.size,
      unique_subject_keys: mappingSubjectKeys.size,
    });
  events = [];
  work = 0;
  workSites.clear();
  for (const key of Object.keys(mappingTotals)) mappingTotals[key] = 0;
  mappingKeys.clear();
  mappingSubjectKeys.clear();
}
report({
  schema: 'open-decomp/selected-work/1',
  kind: 'identity',
  node: process.version,
  binary: target.path,
  sha256: core.contentHash(await readFile(target.path)),
  contract: contractPath,
  selected: selectedNames,
  emitter,
  view,
  import_budget: budgetFor(importLimit),
  query_budget: budgetFor(instructionLimit),
  observation:
    mode === 'public'
      ? 'Uninstrumented original QueryService/worker path, fresh isolated project'
      : 'Trusted fail-closed module hooks and cumulative context checkpoints; counts only, no performance claims',
});
try {
  if (mode === 'public') {
    const { QueryService } = await import('../../src/service/queries/index.js');
    const service = await QueryService.create({
      authorized_roots: [root, dirname(target.path)],
      max_workers: 1,
    });
    try {
      const opened = await service.execute('project_open', {
        source: { kind: 'import', input_path: target.path, project_path: join(root, 'project') },
        wait: true,
        budget: budgetFor(importLimit),
      });
      report({ operation: 'project_open', result: opened });
      assert.ok('data' in opened && opened.data.image && opened.project_id && opened.revision);
      const scope = {
        project_id: opened.project_id,
        revision: opened.revision,
        budget: budgetFor(instructionLimit),
      };
      for (const name of selectedNames) {
        const found = await service.execute('functions_find', {
          ...scope,
          image_id: opened.data.image.id,
          query: { text: name },
          page: { limit: 100 },
        });
        assert.ok('data' in found);
        const fn = found.data.items.find(
          (item) => item.original_name === `_${name}` || item.original_name === name,
        );
        assert.ok(fn, `Missing reviewed function ${name}`);
        const result = await service.execute(
          'function_decompile',
          { ...scope, function_id: fn.id, wait: true, options: { emitter, view } },
          {
            onProgress(job) {
              events.push({ phase: job.progress.phase, state: job.state });
            },
          },
        );
        report({ operation: 'function_decompile', name, function: fn, result, progress: events });
        if ('data' in result && result.data.delivery === 'artifact') {
          const artifact = result.artifacts[0];
          assert.ok(artifact, 'Artifact delivery must expose a readable handle');
          const chunks: Buffer[] = [];
          let offset = '0x0',
            received = 0;
          for (;;) {
            const chunk = await service.readArtifact({
              project_id: scope.project_id,
              revision: scope.revision,
              artifact_id: artifact.id,
              offset,
              length: 65_536,
            });
            const bytes = Buffer.from(chunk.bytes_hex, 'hex');
            received += bytes.length;
            assert.ok(
              received <= 16 * 1024 * 1024,
              'Published analysis artifact exceeds its bound',
            );
            chunks.push(bytes);
            if (chunk.next_offset === null) break;
            offset = chunk.next_offset;
          }
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            result: {
              state: string;
              diagnostics: unknown;
              coverage: unknown;
              data: { emission: { text: string } };
            };
          };
          assert.ok(payload.result.data.emission.text.length > 0);
          report({
            operation: 'analysis_artifact',
            name,
            bytes: received,
            state: payload.result.state,
            emission_characters: payload.result.data.emission.text.length,
            diagnostics: payload.result.diagnostics,
            coverage: payload.result.coverage,
          });
        }
        events = [];
      }
    } finally {
      await service.close();
    }
  } else {
    const { MachOLoader } = await import('../../src/loaders/macho/index.js');
    const { elfLoader } = await import('../../src/loaders/elf/index.js');
    const { peLoader } = await import('../../src/loaders/pe/index.js');
    const { SqliteProjectStore } = await import('../../src/project/store/index.js');
    const { prepareQueryImport } = await import('../../src/service/queries/prepare.js');
    const { executeDecompilation } = await import('../../src/service/analysis/index.js');
    const { records } = await import('../../src/service/queries/scope.js');
    const input = await readFile(target.path);
    const bytes = new core.ImmutableBytes(input);
    const sha256 = core.contentHash(input);
    const loader =
      input[0] === 0x4d && input[1] === 0x5a
        ? peLoader
        : input[0] === 0x7f && input[1] === 0x45 && input[2] === 0x4c && input[3] === 0x46
          ? elfLoader
          : new MachOLoader();
    const image = loader.load(
      { bytes, sha256, image_id: core.imageIdentity(sha256), slice_id: null },
      context(importLimit),
    );
    flush({ image_id: image.id, symbols: image.symbols.length, hints: image.hints.length });
    const store = SqliteProjectStore.open(join(root, 'project'), 'create');
    try {
      await store.importImage({
        bytes: image.bytes,
        sha256,
        selected_slice_id: image.selected_slice_id,
      });
      operation = 'prepare_import';
      const prepared = await prepareQueryImport(image, {
        revision: 2,
        context: context(importLimit),
      });
      assert.equal(
        store.transaction(1, (tx) => {
          tx.putImage(prepared.image);
          prepared.publish(tx);
        }).state,
        'committed',
      );
      flush({});
      const functions = records(
        { store, context: context(importLimit) },
        2,
        image.id,
        'function',
      ).items;
      events = [];
      work = 0;
      for (const name of selectedNames) {
        operation = name;
        const fn = functions.find(
          (item) => item.original_name === `_${name}` || item.original_name === name,
        );
        assert.ok(fn, `Missing reviewed function ${name}`);
        const job_id = core.newIdentity('job');
        store.saveJob({
          id: job_id,
          project_id: store.project_id,
          input_revision: 2,
          operation: 'function_decompile',
          state: 'running',
          progress: { phase: 'running', completed: 0, total: null },
          diagnostics: [],
          artifacts: [],
          published_revision: null,
        });
        const args = core.toolSchemas.function_decompile.input.parse({
          project_id: store.project_id,
          revision: 2,
          function_id: fn.id,
          wait: true,
          options: { emitter, view },
          budget: budgetFor(instructionLimit),
        });
        try {
          const result = await executeDecompilation(args, {
            store,
            job_id,
            context: context(instructionLimit),
          });
          flush({
            function: fnInfo(fn),
            result: {
              state: result.state,
              diagnostics: result.diagnostics,
              coverage: result.coverage,
            },
          });
        } catch (error) {
          flush({
            function: fnInfo(fn),
            error:
              error instanceof core.OperationError
                ? error.diagnostic
                : { message: error instanceof Error ? error.message : String(error) },
          });
        }
      }
    } finally {
      await store.close();
    }
  }
} finally {
  stop();
  await rm(root, { recursive: true, force: true });
}

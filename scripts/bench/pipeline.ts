import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { once } from 'node:events';
import { z } from 'zod';
import {
  budgetSchema,
  DEFAULT_BUDGET,
  type Budget,
  type ToolInput,
  type ToolName,
  type ToolResult,
} from '../../src/core/index.js';
import { QueryService, type QueryCallOptions } from '../../src/service/queries/index.js';
import {
  METRICS_ENV,
  PIPELINE_SCHEMA,
  sampleMemory,
  type WorkerEvidence,
  type WorkerMeasurement,
} from './pipeline-metrics.js';

type WireFunction = Extract<
  ToolResult<'functions_find'>,
  { data: unknown }
>['data']['items'][number];
interface TargetInput {
  readonly name: string;
  readonly path: string;
  readonly size: 'small' | 'large';
  readonly format: 'macho' | 'pe';
  readonly architecture: 'arm64' | 'x86_64';
  readonly arithmetic?: string;
}
interface InputIdentity extends TargetInput {
  readonly sha256: string;
  readonly byte_length: number;
  readonly identity_verification: 'fixture_manifest' | 'explicit_path_and_header';
}
interface Options {
  fixtures: string;
  large_macho?: string;
  large_pe?: string;
  large_instructions: number;
  iterations: number;
  cache_iterations: number;
  functions: number;
}
interface ObservedCall<K extends ToolName> {
  readonly result: ToolResult<K>;
  readonly job_ids: readonly string[];
}
interface BoundExpectation {
  readonly scenario: string;
  readonly job_ids: readonly string[];
  readonly requires_emission: boolean;
}
const raisedBudget: Budget = budgetSchema.parse({
  instructions: 1_000_000,
  blocks: 100_000,
  ir_nodes: 10_000_000,
  work: 100_000_000,
  deadline_ms: 300_000,
  output_bytes: DEFAULT_BUDGET.output_bytes,
});
const runId = randomUUID();
const processors = cpus();
const host = {
  platform: platform(),
  architecture: arch(),
  os_release: release(),
  node: process.version,
  v8: process.versions.v8,
  cpu_model: processors[0]?.model ?? 'unavailable',
  logical_cpus: processors.length,
  physical_memory_bytes: totalmem(),
  host_pid: process.pid,
};

async function report(record: Record<string, unknown>): Promise<void> {
  if (
    !process.stdout.write(
      `${JSON.stringify({ schema: PIPELINE_SCHEMA, run_id: runId, host, ...record })}\n`,
    )
  )
    await once(process.stdout, 'drain');
}
function argumentsFrom(argv: readonly string[]): Options {
  const options: Options = {
    fixtures: resolve('fixtures/bin'),
    large_instructions: raisedBudget.instructions,
    iterations: 1,
    cache_iterations: 3,
    functions: 3,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index],
      value = argv[++index];
    assert.ok(value && !value.startsWith('--'), `Missing value for ${flag}`);
    if (flag === '--fixtures') options.fixtures = resolve(value);
    else if (flag === '--large-macho') options.large_macho = resolve(value);
    else if (flag === '--large-pe') options.large_pe = resolve(value);
    else if (flag === '--large-instructions')
      options.large_instructions = budgetSchema.shape.instructions.parse(Number(value));
    else if (flag === '--iterations' || flag === '--cache-iterations' || flag === '--functions') {
      const count = Number(value),
        maximum = flag === '--iterations' ? 20 : flag === '--functions' ? 8 : 100;
      assert.ok(
        Number.isSafeInteger(count) && count >= 1 && count <= maximum,
        `${flag} must be 1..${maximum}`,
      );
      if (flag === '--iterations') options.iterations = count;
      else if (flag === '--functions') options.functions = count;
      else options.cache_iterations = count;
    } else throw new Error(`Unknown option ${flag}`);
  }
  return options;
}

async function identify(input: TargetInput, fixtures: string): Promise<InputIdentity> {
  const path = await realpath(input.path);
  const file = await open(path, 'r');
  let byteLength: number;
  try {
    const stat = await file.stat();
    assert.ok(
      stat.isFile() && stat.size <= 512 * 1024 * 1024,
      'Input must be a regular file within the public 512 MiB import bound',
    );
    byteLength = stat.size;
    const header = Buffer.alloc(64);
    assert.equal((await file.read(header, 0, header.length, 0)).bytesRead, header.length);
    if (input.format === 'macho') {
      assert.equal(
        header.readUInt32LE(0),
        0xfeedfacf,
        'Expected a thin little-endian Mach-O64 input',
      );
      assert.equal(header.readUInt32LE(4), 0x0100000c, 'Expected arm64 Mach-O');
    } else {
      assert.equal(header.readUInt16LE(0), 0x5a4d, 'Expected PE DOS signature');
      const pe = Buffer.alloc(26);
      assert.equal(
        (await file.read(pe, 0, pe.length, header.readUInt32LE(0x3c))).bytesRead,
        pe.length,
      );
      assert.equal(pe.readUInt32LE(0), 0x4550, 'Expected PE signature');
      assert.equal(pe.readUInt16LE(4), 0x8664, 'Expected x86-64 PE');
      assert.equal(pe.readUInt16LE(24), 0x20b, 'Expected PE32+');
    }
  } finally {
    await file.close();
  }
  const hash = createHash('sha256');
  let hashedBytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    hashedBytes += chunk.length;
  }
  assert.equal(hashedBytes, byteLength, 'Input changed while hashing');
  const sha256 = hash.digest('hex');
  if (input.size === 'small') {
    const manifest = z
      .object({
        images: z.array(z.object({ path: z.string(), size: z.number(), sha256: z.string() })),
      })
      .parse(JSON.parse(await readFile(join(dirname(fixtures), 'manifest.json'), 'utf8')));
    const item = manifest.images.find((image) => image.path === `fixtures/bin/${input.name}`);
    assert.ok(item, `Fixture missing from manifest: ${input.name}`);
    assert.equal(byteLength, item.size);
    assert.equal(sha256, item.sha256);
  }
  return {
    ...input,
    path,
    sha256,
    byte_length: byteLength,
    identity_verification: input.size === 'small' ? 'fixture_manifest' : 'explicit_path_and_header',
  };
}

/** Keep evidence bounded without printing target-controlled source or complete indexes. */
function summarize<K extends ToolName>(result: ToolResult<K>): Record<string, unknown> {
  const common = {
    state: result.state,
    project_id: result.project_id,
    revision: result.revision,
    versions: result.versions,
    budget: result.budget,
    coverage: result.coverage.slice(0, 16),
    coverage_count: result.coverage.length,
    diagnostics: result.diagnostics.slice(0, 32),
    diagnostic_count: result.diagnostics.length,
    artifacts: result.artifacts.slice(0, 16),
    artifact_count: result.artifacts.length,
    ...('reason' in result ? { reason: result.reason } : {}),
    ...('error' in result ? { error: result.error } : {}),
  };
  if (!('data' in result)) return common;
  const data: unknown = result.data;
  if (data === null || typeof data !== 'object') return common;
  const record = data as Record<string, unknown>;
  return {
    ...common,
    ...('cache' in record ? { cache: record['cache'], delivery: record['delivery'] } : {}),
    ...('page' in record
      ? {
          page: record['page'],
          item_count: Array.isArray(record['items']) ? record['items'].length : null,
        }
      : {}),
    ...('image' in record ? { image: record['image'] } : {}),
  };
}
function expectedMeasuredFailure<K extends ToolName>(result: ToolResult<K>): void {
  if ('error' in result)
    assert.ok(
      ['resource_limit', 'unavailable_semantics', 'unsupported_target'].includes(result.error.code),
      `Unexpected product failure: ${JSON.stringify(result.error)}`,
    );
}

async function runScenario(
  input: InputIdentity,
  profile: 'default' | 'raised',
  iteration: number,
  options: Options,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'open-decomp-pipeline-'));
  const metricsDirectory = join(root, 'metrics');
  const projectPath = join(root, 'project');
  const priorEnvironment = process.env[METRICS_ENV];
  let service: QueryService | undefined;
  const context = { input, budget_profile: profile, iteration, iterations: options.iterations };
  const budget =
    profile === 'default'
      ? DEFAULT_BUDGET
      : { ...raisedBudget, instructions: options.large_instructions };
  const labels = new Map<string, string>();
  const bounds: BoundExpectation[] = [];
  const computedJobs = new Set<string>();
  const cacheJobs = new Set<string>();
  let scenarioError: unknown;
  async function call<K extends ToolName>(
    scenario: string,
    operation: K,
    args: ToolInput<K>,
    callOptions: QueryCallOptions = {},
  ): Promise<ObservedCall<K>> {
    assert.ok(service);
    const jobIds = new Set<string>();
    const before = sampleMemory(),
      start = performance.now();
    const result = await service.execute(operation, args, {
      ...callOptions,
      onProgress(job) {
        jobIds.add(job.id);
        labels.set(job.id, scenario);
      },
    });
    const elapsed = performance.now() - start,
      after = sampleMemory();
    await report({
      kind: 'query',
      ...context,
      scenario,
      operation,
      measurement_mode:
        scenario === 'cold_import' ? 'fresh_project_and_worker' : 'same_project_worker',
      elapsed_ms: elapsed,
      host_memory_before: before,
      host_memory_after: after,
      trusted_max_result_bytes: callOptions.max_result_bytes ?? null,
      serialized_result_bytes: Buffer.byteLength(JSON.stringify(result)),
      job_ids: [...jobIds],
      result: summarize(result),
    });
    expectedMeasuredFailure(result);
    return { result, job_ids: [...jobIds] };
  }
  try {
    await mkdir(metricsDirectory);
    process.env[METRICS_ENV] = metricsDirectory;
    service = await QueryService.create({
      authorized_roots: [root, dirname(input.path)],
      max_workers: 1,
      max_queued: 1,
      entry_point: new URL('./worker.js', import.meta.url),
      exec_argv: [],
    });
    const imported = await call('cold_import', 'project_open', {
      source: { kind: 'import', input_path: input.path, project_path: projectPath },
      wait: true,
      budget,
    });
    if (!('data' in imported.result) || imported.result.data.image === null) {
      // QueryService closes a failed import's worker. Reopen the actual durable
      // project to distinguish no image from an unfinished immutable snapshot.
      const persisted = await call('failed_import_reopen', 'project_open', {
        source: { kind: 'resume', project_path: projectPath },
        wait: true,
        budget,
      });
      await report({
        kind: 'scenario_outcome',
        ...context,
        scenario: 'cold_import',
        outcome: 'import_failed',
        persisted_state: summarize(persisted.result),
        function_measurement: 'unavailable_without_published_import',
      });
      assert.equal(input.size, 'large', 'Small hash-verified fixture import must succeed');
      return;
    }
    const image = imported.result.data.image;
    assert.equal(image.sha256, input.sha256, 'Imported bytes differ from benchmark identity');
    assert.equal(BigInt(image.byte_length), BigInt(input.byte_length));
    assert.equal(image.target.format, input.format);
    assert.equal(image.target.architecture, input.architecture);
    assert.ok(imported.result.project_id !== null && imported.result.revision !== null);
    const project_id = imported.result.project_id,
      revision = imported.result.revision;
    const scope = { project_id, revision, budget };
    await call('native_name_index_sample', 'symbols_find', {
      ...scope,
      image_id: image.id,
      page: { limit: 1 },
    });
    await call('string_index_sample', 'strings_find', {
      ...scope,
      image_id: image.id,
      page: { limit: 1 },
    });
    const candidates = new Map<string, { function: WireFunction; reason: string; rank: number }>();
    async function find(
      scenario: string,
      extra: Partial<ToolInput<'functions_find'>>,
      reason: string,
    ): Promise<void> {
      const found = await call(scenario, 'functions_find', {
        ...scope,
        image_id: image.id,
        page: { limit: 256 },
        ...extra,
      });
      if ('data' in found.result)
        for (const fn of found.result.data.items)
          if (!candidates.has(fn.id)) {
            const bytes = fn.ranges.reduce((sum, range) => sum + BigInt(range.size), 0n);
            const rank =
              (fn.analysis === 'complete' ? 16 : 0) +
              (bytes >= 16n && bytes <= 4096n ? 8 : 0) +
              (fn.boundary === 'established' ? 4 : 0) +
              (fn.original_name ? 2 : 0);
            candidates.set(fn.id, { function: fn, reason, rank });
          }
    }
    if (input.arithmetic)
      await find(
        'select_arithmetic',
        { address: { image_id: image.id, space: 'va', value: input.arithmetic } },
        'known_fixture_arithmetic',
      );
    for (const entry of image.entry_points.slice(0, 1))
      await find('select_entry', { address: entry }, 'image_entry_point');
    const preferred = [...candidates.values()].sort(
      (left, right) =>
        Number(right.function.entry.value === input.arithmetic) -
        Number(left.function.entry.value === input.arithmetic),
    );
    if (input.size === 'large') {
      await find(
        'select_complete_graphs',
        { analysis: 'complete' },
        'complete_discovered_graph_in_bounded_page',
      );
      await find(
        'select_named_start',
        { query: { text: 'Start', match: 'contains', case_sensitive: false }, page: { limit: 16 } },
        'native_or_decorated_start_name',
      );
    }
    await find('function_index_page', {}, 'first_address_ordered_index_page');
    const ranked = [...candidates.values()]
      .filter((candidate) => !preferred.includes(candidate))
      .sort(
        (left, right) =>
          right.rank - left.rank ||
          (BigInt(left.function.entry.value) < BigInt(right.function.entry.value)
            ? -1
            : BigInt(left.function.entry.value) > BigInt(right.function.entry.value)
              ? 1
              : left.function.id < right.function.id
                ? -1
                : 1),
      );
    const selected = [...preferred, ...ranked].slice(0, options.functions);
    if (input.size === 'small')
      assert.ok(
        selected.some((item) => item.function.entry.value === input.arithmetic),
        'Arithmetic fixture function must be selected',
      );
    await report({
      kind: 'selection',
      ...context,
      scenario: 'selected_functions',
      candidate_count: candidates.size,
      selection_scope:
        'entry/arithmetic plus bounded complete-graph, name and address queries; not exhaustive',
      functions: selected.map(({ function: fn, reason }) => ({
        id: fn.id,
        entry: fn.entry,
        original_name: fn.original_name?.slice(0, 512),
        display_name: fn.display_name?.slice(0, 512),
        boundary: fn.boundary,
        analysis: fn.analysis,
        range_count: fn.ranges.length,
        total_range_bytes: fn.ranges
          .reduce((sum, range) => sum + BigInt(range.size), 0n)
          .toString(),
        selection_reason: reason,
      })),
    });
    if (selected[0])
      await call('reference_index_sample', 'xrefs_get', {
        ...scope,
        target: { kind: 'entity', id: selected[0].function.id },
        page: { limit: 1 },
      });
    if (!selected.length)
      await report({
        kind: 'scenario_outcome',
        ...context,
        scenario: 'selected_functions',
        outcome: 'no_discovered_function_in_bounded_selection',
      });
    for (const [selectedIndex, selectedFunction] of selected.entries()) {
      const fn = selectedFunction.function;
      const args: ToolInput<'function_decompile'> = { ...scope, function_id: fn.id, wait: true };
      // Both failures run before any successful analysis of the fixture function.
      // Repeat identical requests so an accidental cached publication cannot hide.
      if (input.size === 'small' && selectedIndex === 0) {
        for (const bound of ['work', 'output'] as const)
          for (let repeat = 0; repeat < 2; repeat++) {
            const scenario = `${bound}_bound_${repeat + 1}`;
            const limited = await call(
              scenario,
              'function_decompile',
              bound === 'work' ? { ...args, budget: { ...budget, work: 1 } } : args,
              bound === 'output' ? { max_result_bytes: 1024 } : {},
            );
            assert.ok(
              'error' in limited.result && limited.result.error.code === 'resource_limit',
              `${scenario} must report a typed resource limit`,
            );
            assert.equal(
              limited.result.artifacts.length,
              0,
              'Failed delivery/work must expose no artifact',
            );
            bounds.push({
              scenario,
              job_ids: limited.job_ids,
              requires_emission: bound === 'output',
            });
          }
      }
      const computed = await call(
        `function_${selectedIndex + 1}_uncached`,
        'function_decompile',
        args,
      );
      if (!('data' in computed.result)) {
        if (input.size === 'small' && fn.entry.value === input.arithmetic)
          assert.fail('Arithmetic fixture decompilation must succeed');
        continue;
      }
      assert.equal(
        computed.result.data.cache,
        'computed',
        'First successful analysis must not hit a cache',
      );
      for (const id of computed.job_ids) computedJobs.add(id);
      for (let repeat = 0; repeat < options.cache_iterations; repeat++) {
        const cached = await call(
          `function_${selectedIndex + 1}_cache_${repeat + 1}`,
          'function_decompile',
          args,
        );
        assert.ok(
          'data' in cached.result,
          'Previously successful identical request must return data',
        );
        assert.equal(cached.result.data.cache, 'hit');
        assert.deepEqual(
          cached.result.artifacts,
          computed.result.artifacts,
          'Cache hit must retain the published artifact identity',
        );
        for (const id of cached.job_ids) cacheJobs.add(id);
      }
      // Exercise the legal minimum public output budget as well as the trusted
      // minimum transport delivery ceiling above. A real artifact response is also valid.
      if (input.size === 'small' && selectedIndex === 0) {
        const minimum = await call('public_minimum_output', 'function_decompile', {
          ...args,
          budget: { ...budget, output_bytes: 1024 },
        });
        assert.ok(
          ('error' in minimum.result && minimum.result.error.code === 'resource_limit') ||
            ('data' in minimum.result && minimum.result.data.delivery === 'artifact'),
          'Minimum output must either fail honestly or use bounded artifact delivery',
        );
      }
    }
    await report({
      kind: 'scenario_outcome',
      ...context,
      scenario: 'pipeline',
      outcome: 'measured',
      selected_functions: selected.length,
      computed_function_jobs: computedJobs.size,
      cached_query_jobs: cacheJobs.size,
    });
  } catch (error) {
    scenarioError = error;
  } finally {
    try {
      await service?.close('cancel');
    } catch (error) {
      scenarioError ??= error;
    }
    try {
      const evidence: WorkerEvidence[] = [];
      for (const file of (await readdir(metricsDirectory))
        .filter((name) => /^\d+\.jsonl$/.test(name))
        .sort()) {
        for (const line of (await readFile(join(metricsDirectory, file), 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)) {
          const record = JSON.parse(line) as WorkerEvidence;
          assert.equal(record.schema, PIPELINE_SCHEMA);
          evidence.push(record);
          await report({
            ...record,
            ...context,
            scenario:
              record.kind === 'worker_job'
                ? (labels.get(record.job_id) ?? 'unattributed_worker_job')
                : 'worker_lifetime',
            process_scope: 'single_project_worker',
            ...(record.kind === 'worker_job' ? { stages: groupedStages(record) } : {}),
          });
        }
      }
      const jobs = evidence.filter(
        (record): record is WorkerMeasurement => record.kind === 'worker_job',
      );
      for (const expectation of bounds) {
        const matching = jobs.filter((record) => expectation.job_ids.includes(record.job_id));
        assert.equal(matching.length, 1, `${expectation.scenario}: missing worker evidence`);
        const measured = matching[0]!;
        assert.equal(measured.handler_outcome, 'threw');
        assert.equal(measured.error?.code, 'resource_limit');
        assert.ok(measured.before && measured.after);
        assert.equal(measured.before.more_function_artifacts, false);
        assert.equal(measured.after.more_function_artifacts, false);
        assert.deepEqual(
          measured.after.function_artifact_ids,
          measured.before.function_artifact_ids,
          'Bound failure must not add a cached artifact',
        );
        assert.equal(
          measured.after.job_artifact_ids.length,
          0,
          'Bound failure must not publish a job artifact',
        );
        assert.equal(measured.after.revision, measured.before.revision);
        if (expectation.requires_emission)
          assert.ok(
            measured.marks.some((mark) => mark.phase === 'emit'),
            'Output bound must follow real emission, not an earlier failure',
          );
      }
      for (const id of computedJobs)
        assert.ok(
          jobs.find((job) => job.job_id === id)?.marks.some((mark) => mark.phase === 'decode'),
          'Computed result must traverse actual decode',
        );
      for (const id of cacheJobs) {
        const job = jobs.find((record) => record.job_id === id);
        assert.ok(job, 'Cache query must have worker evidence');
        assert.ok(
          !job.marks.some((mark) => mark.phase === 'decode'),
          'Cache hit must bypass semantic recomputation',
        );
      }
      const started = evidence
        .filter((record) => record.kind === 'worker_start')
        .map((record) => record.pid);
      const exited = new Set(
        evidence.filter((record) => record.kind === 'worker_exit').map((record) => record.pid),
      );
      await report({
        kind: 'instrumentation_status',
        ...context,
        scenario: 'worker_metrics',
        workers_started: started,
        workers_with_exit_sample: [...exited],
        missing_exit_samples: started.filter((pid) => !exited.has(pid)),
        jobs_without_metrics: [...labels.keys()].filter(
          (id) => !jobs.some((job) => job.job_id === id),
        ),
        limitation:
          'Forced worker termination can lose the in-flight buffered record and final high-water sample; missing evidence is not a zero measurement.',
      });
    } catch (error) {
      scenarioError ??= error;
    } finally {
      if (priorEnvironment === undefined) delete process.env[METRICS_ENV];
      else process.env[METRICS_ENV] = priorEnvironment;
      await rm(root, { recursive: true, force: true });
    }
    if (scenarioError) throw scenarioError;
  }
}

function groupedStages(
  record: WorkerMeasurement,
): readonly { stage: string; elapsed_ms: number; end_boundary: string }[] {
  const definitions: readonly [string, string, string][] =
    record.operation === 'project_open'
      ? [
          ['read_hash_load_and_immutable_snapshot', 'running', 'image_snapshot'],
          ['index_preparation_and_publication', 'image_snapshot', 'published'],
          ['index_preparation', 'prepare_import', 'prepare_import_return'],
          ['publication_and_acknowledgement', 'prepare_import_return', 'published'],
        ]
      : [
          ['scope_and_cache_lookup', 'handler_enter', 'decode'],
          ['decode_and_cfg', 'decode', 'lift'],
          ['lift_and_ir_validation', 'lift', 'ssa'],
          ['ssa_shared_simplification_and_validation', 'ssa', 'metadata'],
          ['metadata_and_call_preparation', 'metadata', 'types'],
          ['type_recovery_catalog_and_annotations', 'types', 'structure'],
          ['structure_and_presentation_setup', 'structure', 'emit'],
          [
            'emission_postprocessing_cache_publication_and_result_validation',
            'emit',
            'handler_end',
          ],
          ['handler_total', 'handler_enter', 'handler_end'],
        ];
  return definitions.flatMap(([stage, start, end]) => {
    const from = record.marks.find((mark) => mark.phase === start),
      to = record.marks.find((mark) => mark.phase === end);
    return from && to
      ? [{ stage, elapsed_ms: to.elapsed_ms - from.elapsed_ms, end_boundary: end }]
      : [];
  });
}

async function main(): Promise<void> {
  const options = argumentsFrom(process.argv.slice(2));
  const targets: TargetInput[] = [
    {
      name: 'macho-arm64-symbols',
      path: join(options.fixtures, 'macho-arm64-symbols'),
      size: 'small',
      format: 'macho',
      architecture: 'arm64',
      arithmetic: '0x100000574',
    },
    {
      name: 'corpus-symbols.dll',
      path: join(options.fixtures, 'corpus-symbols.dll'),
      size: 'small',
      format: 'pe',
      architecture: 'x86_64',
      arithmetic: '0x180001030',
    },
    ...(options.large_macho
      ? [
          {
            name: 'external-large-macho',
            path: options.large_macho,
            size: 'large' as const,
            format: 'macho' as const,
            architecture: 'arm64' as const,
          },
        ]
      : []),
    ...(options.large_pe
      ? [
          {
            name: 'external-large-pe',
            path: options.large_pe,
            size: 'large' as const,
            format: 'pe' as const,
            architecture: 'x86_64' as const,
          },
        ]
      : []),
  ];
  await report({
    kind: 'run',
    scenario: 'configuration',
    options,
    argv: process.argv.slice(2),
    complete_release_inputs: Boolean(options.large_macho && options.large_pe),
    omitted_large_inputs: [
      !options.large_macho ? 'Mach-O' : null,
      !options.large_pe ? 'PE' : null,
    ].filter(Boolean),
    budgets: {
      default: DEFAULT_BUDGET,
      raised: { ...raisedBudget, instructions: options.large_instructions },
    },
    definitions: {
      cold: 'Fresh project and worker per input/profile/iteration. Input hashing precedes timing and warms filesystem pages; OS/page cache is neither flushed nor claimed cold.',
      host_latency:
        'QueryService.execute wall time including worker launch for import, IPC, native progress persistence, metric flushing, schema validation and result delivery. Excludes evidence stdout serialization and input hashing.',
      stages:
        'Trusted runtime boundaries and unthrottled context.progress callbacks around the production handler. Compound boundaries are not exclusive CPU samples. Handler total overlaps component spans.',
      memory:
        'All values bytes. rss is a boundary sample; process_lifetime_max_rss_bytes is process.resourceUsage().maxRSS * 1024 when available, otherwise null, not per-stage peak. heap/external/arrayBuffers are boundary samples, not peaks or retained-after-GC measurements. No explicit GC.',
      instrumentation:
        'performance.now plus process.memoryUsage/resourceUsage at each boundary; buffered marks, one synchronous metrics append per completed job and worker start/exit. Handler publication inspection is outside handler_total but inside host latency. No per-stage disk writes. Existing progress/SQLite/IPC behavior is unchanged.',
      failure:
        'Typed resource/unavailable/unsupported results are observations, not successful full analysis. Missing phase ends are not assigned fabricated durations. Large default and raised imports use independent fresh projects.',
      traversal:
        '--large-instructions changes only the raised profile within the public instruction cap. A smaller traversal may publish explicitly partial indexes; it is not full-image coverage or a relaxation of block/work limits.',
      bounds:
        'Small arithmetic: work=1 twice; trusted max_result_bytes=1024 twice with unchanged legal public budget, before first success; public output_bytes=1024 separately. Failed jobs are checked against real store publication state; identical successful requests must compute then hit the same artifact.',
      inputs:
        'Small identities are manifest-verified. Large public workloads are explicit paths with header/ISA, size and SHA256 verification. Archive/source provenance is recorded separately by the coordinator, never inferred from filenames; oversize Node observations are retained alongside SQLite workloads.',
    },
  });
  let failures = 0;
  for (const target of targets) {
    let input: InputIdentity;
    try {
      input = await identify(target, options.fixtures);
      await report({ kind: 'input', scenario: 'identity', input });
    } catch (error) {
      failures++;
      await report({
        kind: 'failure',
        scenario: 'input_prerequisite',
        target,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    for (const profile of input.size === 'large'
      ? (['default', 'raised'] as const)
      : (['default'] as const)) {
      for (let iteration = 1; iteration <= options.iterations; iteration++) {
        try {
          await runScenario(input, profile, iteration, options);
        } catch (error) {
          failures++;
          await report({
            kind: 'failure',
            scenario: 'scenario_assertion',
            input,
            budget_profile: profile,
            iteration,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
  assert.equal(
    failures,
    0,
    'One or more requested benchmark scenarios failed; inspect preceding failure records',
  );
  await report({
    kind: 'complete',
    scenario: 'pipeline_benchmark',
    complete_release_inputs: Boolean(options.large_macho && options.large_pe),
    outcome: 'all_requested_scenarios_recorded',
    host_memory: sampleMemory(),
  });
}

try {
  await main();
} catch (error) {
  process.exitCode = 1;
  await report({
    kind: 'failure',
    scenario: 'harness_assertion_or_prerequisite',
    error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
  });
}

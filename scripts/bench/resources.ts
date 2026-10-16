import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { z } from 'zod';
import {
  DEFAULT_BUDGET, ImmutableBytes, OperationError, createOperationContext, encodeDiagnostic, imageIdentity, toolSchemas,
} from '../../src/core/index.js';
import type { DecodeRequest, Decoder, LoadedImage, ToolInput, ToolName, ToolResult } from '../../src/core/index.js';
import { Arm64Decoder } from '../../src/decoders/arm64/index.js';
import { X86Decoder } from '../../src/decoders/x86_64/index.js';
import { MachOLoader } from '../../src/loaders/macho/index.js';
import { peLoader } from '../../src/loaders/pe/index.js';
import { QueryService } from '../../src/service/queries/index.js';
import { ProjectWorkerPool } from '../../src/workers/index.js';
import type { JobOutcome, ProjectWorker } from '../../src/workers/index.js';
import { FrameDecoder, frame } from '../../src/workers/protocol.js';
import type { ExecuteRequest, WorkerEvent } from '../../src/workers/protocol.js';
import { explicitGc, memoryFacts, workerMemorySchema } from './resources-metrics.js';
import type { MemoryFacts, WorkerMemory } from './resources-metrics.js';

// Compiled invocation: node --expose-gc dist/scripts/bench/resources.js --fixtures fixtures/bin [--iterations N]
// Iterations are independent sustained batches (32 decoder requests / batch), not large-binary throughput.
const fixtureSchema = z.object({ images: z.array(z.object({ path: z.string(), size: z.number().int(), sha256: z.string() })) });
interface Input {
  path: string; sha256: string; byte_length: number; format: 'macho' | 'pe'; architecture: 'arm64' | 'x86_64';
  arithmetic: string; image: LoadedImage;
}
const processors = cpus();
const host = {
  platform: platform(), arch: arch(), os_release: release(), node: process.version, v8: process.versions.v8,
  cpu_model: processors[0]?.model ?? 'unavailable', logical_cpus: processors.length, physical_ram_bytes: totalmem(),
};
const runId = randomUUID();
let failureCount = 0;
let currentScenario = 'initialization';

/** Await writes so report buffering cannot grow with sustained iterations. */
async function report(scenario: string, facts: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ schema: 'open-decomp.resources', schema_version: 1, run_id: runId, scenario, host, ...facts });
  await new Promise<void>((yes, no) => process.stdout.write(`${line}\n`, error => error ? no(error) : yes()));
}
function inputFacts(input: Input): Record<string, unknown> {
  return { path: input.path, sha256: input.sha256, byte_length: input.byte_length, format: input.format, architecture: input.architecture };
}
function errorFacts(error: unknown): Record<string, unknown> {
  return error instanceof OperationError ? { name: error.name, code: error.code, diagnostic: encodeDiagnostic(error.diagnostic) }
    : { name: error instanceof Error ? error.name : 'unknown', message: error instanceof Error ? error.message : String(error) };
}

async function retainedSample(): Promise<{ memory: MemoryFacts; gc_elapsed_ms: number | null }> {
  // Clear the completed batch's stack before optional explicit GC. GC is outside elapsed work timings.
  await nextTurn();
  const start = performance.now();
  explicitGc?.();
  return { memory: memoryFacts(), gc_elapsed_ms: explicitGc ? performance.now() - start : null };
}

async function loadInputs(fixtures: string): Promise<Input[]> {
  const manifestBytes = await readFile(join(dirname(fixtures), 'manifest.json'));
  const manifest = fixtureSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  const inputs: Input[] = [];
  for (const spec of [
    { file: 'macho-arm64-symbols', format: 'macho', architecture: 'arm64', arithmetic: '0x100000574' },
    { file: 'corpus-symbols.dll', format: 'pe', architecture: 'x86_64', arithmetic: '0x180001030' },
  ] as const) {
    const path = await realpath(join(fixtures, spec.file));
    const bytes = await readFile(path);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const identity = manifest.images.find(item => item.path === `fixtures/bin/${spec.file}`);
    assert.ok(identity, `Missing manifest identity for ${spec.file}`);
    assert.equal(bytes.length, identity.size, path); assert.equal(sha256, identity.sha256, path);
    const image = (spec.format === 'macho' ? new MachOLoader() : peLoader).load({
      image_id: imageIdentity(sha256), sha256, bytes: new ImmutableBytes(bytes), slice_id: null,
    }, createOperationContext());
    assert.equal(image.target.architecture, spec.architecture); assert.equal(image.target.format, spec.format);
    const input: Input = { path, sha256, byte_length: bytes.length, format: spec.format, architecture: spec.architecture, arithmetic: spec.arithmetic, image };
    inputs.push(input);
    await report('input', { input: inputFacts(input), manifest_sha256: createHash('sha256').update(manifestBytes).digest('hex'), measurement_mode: 'hash_bound_checked_in_fixture' });
  }
  return inputs;
}

function decodeBatch(adapter: Decoder, request: DecodeRequest, count: number): Record<string, number> {
  let instructions = 0, gaps = 0, invalid = 0, formattedCharacters = 0, bytes = 0;
  for (let index = 0; index < count; index++) {
    const result = adapter.decode(request, createOperationContext());
    assert.ok(result.instructions.length > 0, 'Fixture decoder returned no instructions');
    assert.ok(!result.gaps.some(gap => gap.reason === 'budget'), 'Decoder batch exceeded the default instruction budget');
    instructions += result.instructions.length; gaps += result.gaps.length;
    for (const instruction of result.instructions) {
      bytes += instruction.size;
      if (instruction.validity !== 'valid') invalid++;
      const formatted = adapter.format?.(instruction);
      if (formatted) formattedCharacters += formatted.mnemonic.length + formatted.operands.length;
    }
  }
  return { requests: count, instructions, gaps, invalid_instructions: invalid, formatted_characters: formattedCharacters, decoded_bytes_with_repetition: bytes };
}

async function decoders(inputs: readonly Input[], iterations: number): Promise<void> {
  for (const input of inputs) {
    currentScenario = 'decoder_sustained';
    const regions = input.image.sections.filter(section => section.kind === 'section' && section.permissions.includes('execute') && section.file_range !== null)
      .map(section => section.file_range!);
    assert.ok(regions.length > 0, 'No backed executable sections in the fixture');
    const request: DecodeRequest = { image: input.image, regions, features: input.image.target.features, mode: input.architecture === 'arm64' ? 'a64' : 'long64' };
    const adapter = input.architecture === 'arm64' ? new Arm64Decoder() : new X86Decoder({ formatting: true });
    const baseline = await retainedSample();
    let last = baseline;
    let endpointPeakRss = baseline.memory.rss_bytes;
    try {
      for (let iteration = 0; iteration < iterations; iteration++) {
        const start = performance.now();
        const counts = decodeBatch(adapter, request, 32);
        const elapsed_ms = performance.now() - start;
        const endpoint = memoryFacts();
        last = await retainedSample();
        endpointPeakRss = Math.max(endpointPeakRss, endpoint.rss_bytes, last.memory.rss_bytes);
        await report('decoder_sustained', {
          input: inputFacts(input), measurement_mode: 'persistent_adapter_decode_and_format', iteration, iterations,
          adapter: { name: adapter.name, version: adapter.version }, elapsed_ms, ...counts,
          endpoint_memory: endpoint, retained_sample: last, retained_sample_mode: explicitGc ? 'parent_explicit_gc' : 'natural_gc_uncontrolled',
        });
      }
      // Exercise the real adapter's typed error cleanup, then reuse it successfully.
      let limited: unknown;
      const limitedStart = performance.now();
      try { adapter.decode(request, createOperationContext({ budget: { work: 1 } })); }
      catch (error) { limited = error; }
      await report('decoder_work_limit', { input: inputFacts(input), iteration: 0, elapsed_ms: performance.now() - limitedStart, failure: errorFacts(limited), requested_work: 1 });
      assert.ok(limited instanceof OperationError && limited.code === 'resource_limit', 'Decoder work limit did not fail with resource_limit');
      decodeBatch(adapter, request, 1);
    } finally { adapter.dispose(); }
    // The formatter/adapter is disposed; immutable image inputs deliberately remain alive.
    const disposed = await retainedSample();
    const reopened = input.architecture === 'arm64' ? new Arm64Decoder() : new X86Decoder({ formatting: true });
    try { decodeBatch(reopened, request, 1); } finally { reopened.dispose(); }
    await report('decoder_lifetime_summary', {
      input: inputFacts(input), iterations, requests_per_iteration: 32, measurement_mode: 'boundary_samples_and_process_lifetime_rss_high_water',
      baseline, last_batch_retained: last, after_dispose: disposed, sampled_endpoint_peak_rss_bytes: endpointPeakRss,
      retained_heap_delta_bytes: last.memory.heap_used_bytes - baseline.memory.heap_used_bytes,
      retained_external_delta_bytes: last.memory.external_bytes - baseline.memory.external_bytes,
      interpretation: 'Finite repeated-fixture observation, not a proof of no leak or representative large-binary throughput. External includes WASM and other native allocations; iced-x86 exposes no separate supported WASM-memory metric here. Dispose/recreate reused the real adapter successfully.',
    });
  }
}

async function workerMemory(directory: string, pid: number | undefined, jobId: string | null): Promise<Record<string, unknown>> {
  assert.ok(pid, 'Missing real worker pid');
  const observation = workerMemorySchema.parse(JSON.parse(await readFile(join(directory, `${pid}-${jobId ?? 'opened'}.json`), 'utf8')));
  assert.equal(observation.pid, pid); assert.equal(observation.job_id, jobId);
  return { ...observation, scope: 'one_child_process', gc: 'natural_no_explicit_gc', high_water_scope: 'child_process_lifetime_not_this_job' };
}

async function poolWork(inputs: readonly Input[], root: string, directory: string, iterations: number): Promise<void> {
  currentScenario = 'worker_pool';
  const pool = await ProjectWorkerPool.create({ authorized_roots: [root, ...inputs.map(input => dirname(input.path))], max_workers: 2, max_queued: 1,
    entry_point: new URL('./resources-worker.js', import.meta.url), exec_argv: [] });
  const projects: ProjectWorker[] = [];
  try {
    projects.push(...await Promise.all(inputs.map((_, index) => pool.open({ path: join(root, `pool-${index}`), mode: 'create' }))));
    assert.equal(new Set(projects.map(project => project.pid)).size, 2);
    let capacityFailure: unknown;
    const capacityStart = performance.now();
    try { await pool.open({ path: join(root, 'over-capacity'), mode: 'create' }); } catch (error) { capacityFailure = error; }
    await report('worker_capacity', { configured_max_workers: 2, owned_child_pids: projects.map(project => project.pid), elapsed_ms: performance.now() - capacityStart, failure: errorFacts(capacityFailure) });
    assert.ok(capacityFailure instanceof OperationError && capacityFailure.code === 'resource_limit', 'Third worker was not rejected at the configured capacity');
    let active = 0, observedPeak = 0;
    await Promise.all(projects.map(async (project, index) => {
      const input = inputs[index]!;
      const start = performance.now();
      let running = false;
      try {
        const ticket = await project.submit({ kind: 'import', source_path: input.path, slice_id: null, budget: DEFAULT_BUDGET }, {
          onProgress(job) { if (job.state === 'running' && !running) { running = true; active++; observedPeak = Math.max(observedPeak, active); } },
        });
        const outcome = await ticket.result;
        await report('worker_concurrent_import', { input: inputFacts(input), iteration: 0, elapsed_ms: performance.now() - start,
          measurement_mode: 'submission_to_real_terminal_ack_including_telemetry', job: outcome.job,
          worker_memory: await workerMemory(directory, project.pid, ticket.id), parent_memory: memoryFacts() });
        assert.equal(outcome.job.state, 'completed', JSON.stringify(outcome.job));
        assert.equal(project.snapshot.images[0]?.sha256, input.sha256);
      } finally { if (running) active--; }
    }));
    await report('worker_concurrency', { configured_max_workers: 2, observed_parent_running_notification_peak: observedPeak,
      interpretation: 'Concurrent real imports; notification intervals include observer/report latency, not exact simultaneous CPU execution.' });
    assert.ok(observedPeak <= 2);

    for (const [index, project] of projects.entries()) {
      const input = inputs[index]!;
      const summaryArgs = toolSchemas.binary_info.input.parse({ project_id: project.snapshot.project_id, revision: project.snapshot.revision, view: 'summary' });
      const request: ExecuteRequest = { kind: 'execute', operation: 'binary_info', args: summaryArgs, budget: summaryArgs.budget };
      // submit reserves synchronously before IPC; this burst has no artificial gate or race timer.
      const start = performance.now();
      const admissions = await Promise.allSettled([project.submit(request), project.submit(request), project.submit(request)]);
      const rejected: Record<string, unknown>[] = [];
      const outcomes: JobOutcome[] = [];
      for (const admission of admissions) {
        if (admission.status === 'rejected') rejected.push(errorFacts(admission.reason));
        else outcomes.push(await admission.value.result);
      }
      await report('worker_admission_burst', { input: inputFacts(input), elapsed_ms: performance.now() - start,
        configured_max_queued: 1, submitted: admissions.length, admitted: outcomes.length, rejected,
        terminal_jobs: outcomes.map(outcome => outcome.job), measurement_mode: 'same_turn_real_submit_burst_then_terminal_promises' });
      assert.equal(rejected.length, 1); assert.equal(rejected[0]?.['code'], 'resource_limit');
      assert.equal(outcomes.length, 2); assert.ok(outcomes.every(outcome => outcome.job.state === 'completed'));
      for (let iteration = 0; iteration < iterations; iteration++) {
        const roundtripStart = performance.now();
        const ticket = await project.submit(request);
        const accepted = await ticket.accepted;
        const acceptedMs = performance.now() - roundtripStart;
        const outcome = await ticket.result;
        const elapsed_ms = performance.now() - roundtripStart;
        assert.equal(outcome.job.state, 'completed', JSON.stringify(outcome.job));
        const wire = toolSchemas.binary_info.output.parse(outcome.result);
        await report('worker_roundtrip', { input: inputFacts(input), iteration, iterations, elapsed_ms, durable_admission_ms: acceptedMs,
          measurement_mode: 'real_binary_info_submit_admit_sqlite_query_validation_framing_roundtrip_including_child_telemetry',
          accepted_state: accepted.state, terminal_state: outcome.job.state, wire_state: wire.state, wire_payload_bytes: Buffer.byteLength(JSON.stringify(wire)),
          worker_memory: await workerMemory(directory, project.pid, ticket.id), parent_retained_sample: await retainedSample() });
        assert.ok('data' in wire);
      }
      const saved = project.snapshot;
      const oldPid = project.pid;
      const disposeStart = performance.now();
      await project.dispose();
      const resumed = await pool.open({ path: project.path, mode: 'resume' });
      try {
        assert.deepEqual(resumed.snapshot, saved);
        const ticket = await resumed.submit(request);
        const outcome = await ticket.result;
        await report('worker_dispose_reopen', { input: inputFacts(input), iteration: 0, elapsed_ms: performance.now() - disposeStart,
          previous_pid: oldPid, reopened_pid: resumed.pid, saved_snapshot_equal: true, terminal_state: outcome.job.state,
          worker_memory: await workerMemory(directory, resumed.pid, ticket.id), parent_memory: memoryFacts(),
          interpretation: 'dispose awaits actual child exit (forced termination); resume and a real query check durable metadata and released ownership.' });
        assert.equal(outcome.job.state, 'completed');
      } finally { await resumed.close('wait'); }
    }
  } finally { await pool.close('cancel'); }
}

async function serialize(payload: WorkerEvent, label: string, input: Input, iterations: number): Promise<void> {
  const text = JSON.stringify(payload);
  const bytes = frame(payload);
  for (const mode of ['json_stringify', 'json_parse', 'frame_encode', 'frame_decode'] as const) {
    for (let iteration = 0; iteration < iterations; iteration++) {
      let checksum = 0, received = 0;
      const decoder = new FrameDecoder(value => { assert.ok(value !== null); received++; });
      const start = performance.now();
      for (let repetition = 0; repetition < 64; repetition++) {
        if (mode === 'json_stringify') checksum += JSON.stringify(payload).length;
        else if (mode === 'json_parse') { const value: unknown = JSON.parse(text); if (value !== null) checksum++; }
        else if (mode === 'frame_encode') checksum += frame(payload).length;
        else decoder.push(bytes);
      }
      const elapsed_ms = performance.now() - start;
      decoder.end();
      if (mode === 'frame_decode') assert.equal(received, 64);
      await report('serialization', { input: inputFacts(input), payload: label, payload_sha256: createHash('sha256').update(text).digest('hex'),
        json_utf8_bytes: Buffer.byteLength(text), framed_bytes: bytes.length, measurement_mode: mode, iteration, iterations,
        repetitions: 64, elapsed_ms, checksum, received, endpoint_memory: memoryFacts(),
        interpretation: 'Real worker job envelope/result, retained during this micro-measurement. Frame decode includes allocation, UTF-8 and JSON parse; no schema validation or transport. Never subtract these timings from worker roundtrip to claim exact IPC cost.' });
    }
  }
  let limited: unknown;
  try { frame(payload, Buffer.byteLength(text) - 1); } catch (error) { limited = error; }
  await report('frame_output_limit', { input: inputFacts(input), payload: label, actual_payload_bytes: Buffer.byteLength(text), maximum_bytes: Buffer.byteLength(text) - 1, failure: errorFacts(limited) });
  assert.ok(limited instanceof Error, 'Real payload exceeded the frame ceiling without failing');
}

async function queryWork(inputs: readonly Input[], root: string, iterations: number): Promise<void> {
  currentScenario = 'query_service';
  const service = await QueryService.create({ authorized_roots: [root, ...inputs.map(input => dirname(input.path))], max_workers: 1, max_queued: 1,
    entry_point: new URL('./resources-worker.js', import.meta.url), exec_argv: [] });
  async function call<K extends ToolName>(operation: K, input: ToolInput<K>): Promise<ToolResult<K>> {
    const result = await service.execute(operation, input);
    assert.ok('data' in result, `${operation}: ${JSON.stringify(result)}`);
    return result;
  }
  try {
    for (const [index, input] of inputs.entries()) {
      const path = join(root, `service-${index}`);
      const opened = await call('project_open', { source: { kind: 'import', input_path: input.path, project_path: path }, wait: true });
      assert.ok('data' in opened && opened.data.image);
      const project_id = opened.project_id!;
      const revision = opened.revision!;
      const image_id = opened.data.image.id;
      const functions = await call('functions_find', { project_id, revision, image_id, address: { image_id, space: 'va', value: input.arithmetic } });
      assert.ok('data' in functions);
      const target = functions.data.items.find(item => item.entry.value === input.arithmetic);
      assert.ok(target, 'Known checked-in arithmetic function was not discovered');
      const args = { project_id, revision, function_id: target.id, wait: true };
      for (let iteration = 0; iteration < iterations; iteration++) {
        const start = performance.now();
        const ticket = await service.submit('function_decompile', args);
        const outcome = await ticket.result;
        const elapsed_ms = performance.now() - start;
        assert.equal(outcome.job.state, 'completed', JSON.stringify(outcome.job));
        const wire = toolSchemas.function_decompile.output.parse(outcome.result);
        await report('query_sustained', { input: inputFacts(input), iteration, iterations, elapsed_ms, job_id: outcome.job.id,
          measurement_mode: iteration === 0 ? 'first_function_decompile' : 'repeated_function_decompile',
          terminal_state: outcome.job.state, wire_state: wire.state, cache: 'data' in wire ? wire.data.cache : null,
          wire_payload_bytes: Buffer.byteLength(JSON.stringify(wire)), parent_retained_sample: await retainedSample(),
          interpretation: 'Real QueryService job; warm calls may reuse persisted artifacts. Child boundary samples are reported separately, not inferred from parent memory.' });
        assert.ok('data' in wire);
        if (iteration === 0) await serialize({ kind: 'job', id: outcome.job.id, job: outcome.job, result: wire }, 'function_decompile', input, iterations);
      }
      const disassembly = await service.submit('function_get', { project_id, revision, function_id: target.id, view: 'disassembly' });
      const assemblyOutcome = await disassembly.result;
      assert.equal(assemblyOutcome.job.state, 'completed', JSON.stringify(assemblyOutcome.job));
      const assembly = toolSchemas.function_get.output.parse(assemblyOutcome.result);
      assert.ok('data' in assembly);
      await serialize({ kind: 'job', id: assemblyOutcome.job.id, job: assemblyOutcome.job, result: assembly }, 'function_disassembly', input, iterations);

      const workStart = performance.now();
      const limitedWork = await service.execute('function_get', { project_id, revision, function_id: target.id, view: 'disassembly', budget: { work: 1 } });
      await report('query_work_limit', { input: inputFacts(input), elapsed_ms: performance.now() - workStart, requested_work: 1, actual_result: limitedWork });
      assert.ok(limitedWork.state === 'failed' && limitedWork.error.code === 'resource_limit', 'Real query work limit did not produce resource_limit');
      const outputStart = performance.now();
      const limitedOutput = await service.execute('function_get', { project_id, revision, function_id: target.id, view: 'disassembly' }, { max_result_bytes: 1024 });
      await report('query_output_limit', { input: inputFacts(input), elapsed_ms: performance.now() - outputStart,
        max_result_bytes: 1024, actual_result: limitedOutput, unchanged_requested_output_bytes: DEFAULT_BUDGET.output_bytes });
      assert.ok(limitedOutput.state === 'failed' && limitedOutput.error.code === 'resource_limit' ||
        limitedOutput.state === 'partial' && limitedOutput.reason === 'output_limit', 'Real delivery limit was not exercised');
      await call('function_get', { project_id, revision, function_id: target.id, view: 'metadata' });
      await call('project_close', { project_id, revision, running_jobs: 'wait' });
      const resumed = await call('project_open', { source: { kind: 'resume', project_path: path }, wait: true });
      assert.equal(resumed.project_id, project_id); assert.equal(resumed.revision, revision);
      const warm = await call('function_decompile', args);
      assert.ok('data' in warm && warm.data.cache === 'hit', 'Reopened project did not reuse its real persisted artifact');
      await report('query_close_reopen', { input: inputFacts(input), revision, cache: 'hit', parent_memory: memoryFacts() });
      await call('project_close', { project_id, revision, running_jobs: 'wait' });
    }
  } finally { await service.close('cancel'); }
}

async function reportChildMemory(directory: string): Promise<void> {
  // Consume after all child exit boundaries, even if a scenario reported a defect.
  const summaries = new Map<number, { first: WorkerMemory; last: WorkerMemory; sampled_max: MemoryFacts; observations: number }>();
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.json')) continue;
    const observation = workerMemorySchema.parse(JSON.parse(await readFile(join(directory, name), 'utf8')));
    const existing = summaries.get(observation.pid);
    if (!existing) summaries.set(observation.pid, { first: observation, last: observation, sampled_max: { ...observation.memory }, observations: 1 });
    else {
      existing.observations++;
      if (observation.uptime_ms < existing.first.uptime_ms) existing.first = observation;
      if (observation.uptime_ms > existing.last.uptime_ms) existing.last = observation;
      for (const field of ['rss_bytes', 'heap_total_bytes', 'heap_used_bytes', 'external_bytes', 'array_buffers_bytes'] as const) {
        existing.sampled_max[field] = Math.max(existing.sampled_max[field], observation.memory[field]);
      }
      const highWater = observation.memory.lifetime_max_rss_bytes;
      if (highWater !== null) existing.sampled_max.lifetime_max_rss_bytes = Math.max(existing.sampled_max.lifetime_max_rss_bytes ?? 0, highWater);
    }
    await report('child_memory_boundary', { ...observation, measurement_mode: 'real_worker_boundary_no_explicit_child_gc',
      interpretation: 'RSS high-water is per process lifetime; heap/external/arrayBuffers are endpoint samples, not intra-job peaks. Telemetry file writes are included in host job latency.' });
  }
  for (const [pid, summary] of summaries) {
    await report('child_memory_summary', { pid, observations: summary.observations, first_boundary: summary.first, last_boundary: summary.last,
      sampled_category_maxima: summary.sampled_max,
      boot_to_last_heap_delta_bytes: summary.last.memory.heap_used_bytes - summary.first.memory.heap_used_bytes,
      boot_to_last_external_delta_bytes: summary.last.memory.external_bytes - summary.first.memory.external_bytes,
      measurement_mode: 'finite_natural_gc_child_lifetime',
      interpretation: 'Category maxima are observed endpoint maxima, not intra-job peaks; maxRSS alone is an OS lifetime high-water when available. Boot-to-last deltas include imports, caches, JIT and durable job bookkeeping; they are not GC-isolated leak sizes.' });
  }
}

async function main(): Promise<void> {
  let fixtures = 'fixtures/bin', iterations = 12;
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (option === '--fixtures') { const value = argv[++index]; assert.ok(value, '--fixtures requires a directory'); fixtures = value; }
    else if (option === '--iterations') { const value = argv[++index]; assert.ok(value && /^\d+$/.test(value), '--iterations requires a positive integer'); iterations = Number(value); }
    else throw new Error(`Unknown option ${option}; usage: node --expose-gc dist/scripts/bench/resources.js --fixtures fixtures/bin [--iterations N]`);
  }
  assert.ok(Number.isSafeInteger(iterations) && iterations >= 1 && iterations <= 1000, '--iterations must be in 1..1000');
  fixtures = await realpath(resolve(fixtures));
  await report('methodology', { iterations, decoder_requests_per_iteration: 32, serialization_repetitions_per_iteration: 64,
    invocation: [process.execPath, ...process.execArgv, ...process.argv.slice(1)], parent_gc_available: !!explicitGc,
    measurement_mode: 'compiled_real_adapters_project_workers_and_query_service', initial_parent_memory: memoryFacts(),
    limitations: [
      'Small hash-bound fixtures measure sustained ownership/lifetime and bounded admission, not representative large-binary throughput. Use the separate pipeline harness for genuine large inputs.',
      'Elapsed work excludes parent GC and JSONL report writes; includes assertions and child boundary telemetry writes. Instrumentation, allocation and GC influence subsequent samples.',
      'RSS/maxRSS include native/WASM/SQLite/JIT; heap/external/arrayBuffers overlap and must not be summed. Categories are boundary samples; only supported process maxRSS is a lifetime high-water, null if unavailable.',
      'Parent explicit-GC samples retain image inputs and the active adapter by design. No explicit GC is forced in workers. WASM/native allocator capacity retained after free is not alone evidence of a live-object leak.',
      'No exact IPC timing is inferred by subtraction; real roundtrip includes admission, SQLite, query work, validation, serialization, scheduling and telemetry.',
      'First worker/project is cold ownership only, never a claim of cold OS/filesystem caches. Finite observations do not prove asymptotic resource bounds or establish a numeric SLA.',
    ] });
  const inputs = await loadInputs(fixtures);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-resource-bench-')));
  const directory = join(root, 'telemetry');
  // Allocate telemetry only inside the cleanup scope below.
  const oldDirectory = process.env['OPEN_DECOMP_RESOURCE_BENCH_DIRECTORY'];
  try {
    await mkdir(directory);
    process.env['OPEN_DECOMP_RESOURCE_BENCH_DIRECTORY'] = directory;
    // Keep independent scenarios running after a measured assertion/failure; exit nonzero after cleanup.
    for (const [name, run] of [
      ['decoders', () => decoders(inputs, iterations)],
      ['pool', () => poolWork(inputs, root, directory, iterations)],
      ['query_service', () => queryWork(inputs, root, iterations)],
    ] as const) {
      try { await run(); }
      catch (error) { failureCount++; await report('measured_failure', { scenario_group: name, failed_scenario: currentScenario, failure: errorFacts(error), parent_memory: memoryFacts() }); }
    }
    await reportChildMemory(directory);
  } finally {
    if (oldDirectory === undefined) delete process.env['OPEN_DECOMP_RESOURCE_BENCH_DIRECTORY'];
    else process.env['OPEN_DECOMP_RESOURCE_BENCH_DIRECTORY'] = oldDirectory;
    await rm(root, { recursive: true, force: true });
  }
  await report('complete', { iterations, failures: failureCount, parent_retained_sample: await retainedSample(), temporary_resources_removed: true });
  if (failureCount) process.exitCode = 1;
}

void main().catch(async error => {
  process.exitCode = 1;
  await report('fatal', { failed_scenario: currentScenario, failure: errorFacts(error), parent_memory: memoryFacts() });
});

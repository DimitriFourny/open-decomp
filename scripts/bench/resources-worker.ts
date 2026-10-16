import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { queryWorkerHandler } from '../../src/service/queries/handler.js';
import { runProjectWorker } from '../../src/workers/runtime.js';
import type { WorkerHandler } from '../../src/workers/runtime.js';
import { memoryFacts } from './resources-metrics.js';
import type { WorkerMemory } from './resources-metrics.js';

// This fixed trusted entry only adds boundary observations to the production backend.
// The directory is chosen by the host, never by target bytes or a tool request.
const directory = process.env['OPEN_DECOMP_RESOURCE_BENCH_DIRECTORY'] ?? '';
if (!directory) throw new Error('Resource benchmark telemetry directory is required');
function record(job_id: string | null, phase: string): void {
  const observation: WorkerMemory = { pid: process.pid, job_id, phase, uptime_ms: process.uptime() * 1000, memory: memoryFacts() };
  writeFileSync(join(directory, `${process.pid}-${job_id ?? 'opened'}.json`), JSON.stringify(observation));
}
const handler: WorkerHandler = {
  async execute(operation, args, scope) {
    try { return await queryWorkerHandler.execute(operation, args, scope); }
    finally { record(scope.job_id, 'handler_settled_before_runtime_validation_and_delivery'); }
  },
  prepareImport: queryWorkerHandler.prepareImport!,
};
record(null, 'entry_before_project_open');
runProjectWorker(handler, {
  phase(phase, job) {
    // One initial record also covers loader failures; publication overwrites it.
    // No per-progress disk I/O and no GC in the measured child.
    if (phase === 'running' || phase === 'published') record(job.id, phase);
  },
});

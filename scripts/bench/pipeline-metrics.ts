import type { WireDiagnostic, Job, ToolName } from '../../src/core/index.js';

/** Private evidence format shared only by the maintained pipeline harness/entry. */
export const PIPELINE_SCHEMA = 'open-decomp.pipeline-bench.v1';
export const METRICS_ENV = 'OPEN_DECOMP_PIPELINE_METRICS';
export interface MemorySample {
  readonly rss_bytes: number;
  readonly heap_total_bytes: number;
  readonly heap_used_bytes: number;
  readonly external_bytes: number;
  readonly array_buffers_bytes: number;
  readonly process_lifetime_max_rss_bytes: number | null;
}
export function sampleMemory(): MemorySample {
  const memory = process.memoryUsage();
  const maximum = process.resourceUsage().maxRSS;
  return { rss_bytes: memory.rss, heap_total_bytes: memory.heapTotal, heap_used_bytes: memory.heapUsed,
    external_bytes: memory.external, array_buffers_bytes: memory.arrayBuffers,
    process_lifetime_max_rss_bytes: maximum > 0 ? maximum * 1024 : null };
}
export interface WorkerMark {
  readonly phase: string;
  readonly elapsed_ms: number;
  readonly memory: MemorySample;
}
export interface PublicationSample {
  readonly revision: number;
  readonly job_state: Job['state'] | null;
  readonly job_artifact_ids: readonly string[];
  readonly function_artifact_ids: readonly string[];
  readonly more_function_artifacts: boolean;
}
export interface WorkerMeasurement {
  readonly kind: 'worker_job';
  readonly schema: typeof PIPELINE_SCHEMA;
  readonly pid: number;
  readonly job_id: string;
  readonly operation: ToolName;
  readonly marks: readonly WorkerMark[];
  readonly handler_outcome: 'returned' | 'threw' | null;
  readonly error: WireDiagnostic | null;
  readonly before: PublicationSample | null;
  readonly after: PublicationSample | null;
  readonly flush_boundary: 'handler_return' | 'import_published' | 'next_job' | 'process_exit';
}
export interface WorkerLifetime {
  readonly kind: 'worker_start' | 'worker_exit';
  readonly schema: typeof PIPELINE_SCHEMA;
  readonly pid: number;
  readonly memory: MemorySample;
}
export type WorkerEvidence = WorkerMeasurement | WorkerLifetime;

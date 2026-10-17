import { appendFileSync } from 'node:fs';
import { Arm64Lifter } from '../../src/lifters/arm64/index.js';
import { SqliteProjectStore } from '../../src/project/store/index.js';
import { runProjectWorker } from '../../src/workers/runtime.js';
import { queryWorkerHandler } from '../../src/service/queries/handler.js';

// Trusted benchmark-only observation. Every production operation is delegated
// unchanged; no force-compute flag, candidate bypass or target execution exists here.
interface Counters {
  lifts: number;
  image_reads: number;
  image_validation_ms: number;
}
let current: Counters | undefined;
const metrics = process.env['OPEN_DECOMP_INCREMENTAL_CONTROLLED_METRICS'];
if (!metrics)
  throw new Error('Set OPEN_DECOMP_INCREMENTAL_CONTROLLED_METRICS for this observer worker');
const lift = Arm64Lifter.prototype.lift;
Arm64Lifter.prototype.lift = function (...args) {
  if (current) current.lifts++;
  return lift.apply(this, args);
};
const loadedImage = SqliteProjectStore.prototype.readLoadedImage;
SqliteProjectStore.prototype.readLoadedImage = function (...args) {
  const start = performance.now();
  try {
    return loadedImage.apply(this, args);
  } finally {
    if (current) {
      current.image_reads++;
      current.image_validation_ms += performance.now() - start;
    }
  }
};
const artifactRead = SqliteProjectStore.prototype.readArtifact;
SqliteProjectStore.prototype.readArtifact = async function (...args) {
  const before = process.memoryUsage(),
    start = performance.now();
  const result = await artifactRead.apply(this, args);
  appendFileSync(
    metrics,
    JSON.stringify({
      kind: 'artifact-read',
      pid: process.pid,
      artifact_id: args[0].artifact_id,
      offset: args[0].offset,
      final_chunk: result.next_offset === null,
      before,
      after: process.memoryUsage(),
      execute_ms: performance.now() - start,
      lifetime_max_rss_kib: process.resourceUsage().maxRSS,
    }) + '\n',
  );
  return result;
};
runProjectWorker({
  ...queryWorkerHandler,
  async execute(operation, args, scope) {
    const counters: Counters = { lifts: 0, image_reads: 0, image_validation_ms: 0 };
    current = counters;
    const before = process.memoryUsage(),
      start = performance.now();
    try {
      return await queryWorkerHandler.execute(operation, args, scope);
    } finally {
      appendFileSync(
        metrics,
        JSON.stringify({
          kind: 'operation',
          operation,
          job_id: scope.job_id,
          function_id: 'function_id' in args ? args.function_id : null,
          pid: process.pid,
          ...counters,
          before,
          after: process.memoryUsage(),
          execute_ms: performance.now() - start,
          lifetime_max_rss_kib: process.resourceUsage().maxRSS,
        }) + '\n',
      );
      current = undefined;
    }
  },
});

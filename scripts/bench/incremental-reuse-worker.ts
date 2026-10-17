import { appendFileSync } from 'node:fs';
import { Arm64Lifter } from '../../src/lifters/arm64/index.js';
import { SqliteProjectStore } from '../../src/project/store/index.js';
import { runProjectWorker } from '../../src/workers/runtime.js';
import { queryWorkerHandler } from '../../src/service/queries/handler.js';

// Focused source-runtime oracle only. Delegates every operation unchanged and never
// executes analyzed code. These observed timings are not uninstrumented benchmarks.
interface Counters {
  lifts: number;
  image_reads: number;
  image_validation_ms: number;
}
let current: Counters | undefined;
const lift = Arm64Lifter.prototype.lift;
Arm64Lifter.prototype.lift = function (...args) {
  if (current) current.lifts++;
  return lift.apply(this, args);
};
const readImage = SqliteProjectStore.prototype.readLoadedImage;
SqliteProjectStore.prototype.readLoadedImage = function (...args) {
  const start = performance.now();
  try {
    return readImage.apply(this, args);
  } finally {
    if (current) {
      current.image_reads++;
      current.image_validation_ms += performance.now() - start;
    }
  }
};
const path = process.env['OPEN_DECOMP_INCREMENTAL_METRICS'];
if (!path)
  throw new Error('Set OPEN_DECOMP_INCREMENTAL_METRICS for the focused measurement worker');
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
        path,
        JSON.stringify({
          operation,
          job_id: scope.job_id,
          pid: process.pid,
          ...counters,
          execute_ms: performance.now() - start,
          before,
          after: process.memoryUsage(),
          lifetime_max_rss_kib: process.resourceUsage().maxRSS,
        }) + '\n',
      );
      current = undefined;
    }
  },
});

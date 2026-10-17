import { runProjectWorker } from '../../src/workers/runtime.js';
import { pauseWorker } from './gate.js';
runProjectWorker(undefined, {
  phase(phase, job) {
    if (phase === 'image_snapshot') pauseWorker(job.id);
  },
});

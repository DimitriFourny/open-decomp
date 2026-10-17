import { runProjectWorker } from '../../src/workers/runtime.js';
import { pauseWorker } from './gate.js';
runProjectWorker(undefined, {
  phase(phase, job) {
    if (phase === 'running') pauseWorker(job.id);
  },
});

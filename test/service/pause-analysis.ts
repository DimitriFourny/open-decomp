import { runProjectWorker } from '../../src/workers/runtime.js';
import { queryWorkerHandler } from '../../src/service/queries/handler.js';
import { pauseWorker } from '../workers/gate.js';

runProjectWorker(queryWorkerHandler, {
  phase(phase, job) {
    if (phase === 'running' && job.operation === 'function_decompile') pauseWorker(job.id);
  },
});

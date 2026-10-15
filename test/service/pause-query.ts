import { runProjectWorker } from '../../src/workers/runtime.js';
import { queryWorkerHandler } from '../../src/service/queries/handler.js';
import { pauseWorker } from '../workers/gate.js';

// Static test entry only. Stop after a real durable running acknowledgement; the
// client must inspect/cancel the owner without waiting for its event loop to run.
runProjectWorker(queryWorkerHandler, { phase(phase, job) {
  if (phase === 'running' && job.operation === 'functions_find') pauseWorker(job.id);
} });

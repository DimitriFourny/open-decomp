import { runProjectWorker } from '../../src/workers/runtime.js';
import { queryWorkerHandler } from '../../src/service/queries/handler.js';
import { pauseWorker } from '../workers/gate.js';

// Pause only after the real annotation transaction and terminal job commit,
// before the transient response can reach the client.
runProjectWorker({ ...queryWorkerHandler, async execute(operation, args, scope) {
  const result = await queryWorkerHandler.execute(operation, args, scope);
  if (operation === 'annotations_apply' && result.state === 'complete') pauseWorker(scope.job_id);
  return result;
} });

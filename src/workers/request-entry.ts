import { runRequestWorker } from './request-worker.js';
import { queryWorkerHandler } from '../service/queries/handler.js';

// Request worker of a project owner: analyses jobs over a shared read-only project snapshot.
runRequestWorker(queryWorkerHandler);

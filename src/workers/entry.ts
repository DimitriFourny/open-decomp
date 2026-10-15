import { runProjectWorker } from './runtime.js';
import { queryWorkerHandler } from '../service/queries/handler.js';
runProjectWorker(queryWorkerHandler);

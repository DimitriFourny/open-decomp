import { runProjectWorker } from '../../src/workers/runtime.js';
runProjectWorker(undefined, { phase(phase) { if (phase === 'published') process.kill(process.pid, 'SIGSTOP'); } });

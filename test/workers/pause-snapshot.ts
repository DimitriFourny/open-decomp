import { runProjectWorker } from '../../src/workers/runtime.js';
runProjectWorker(undefined, { phase(phase) { if (phase === 'image_snapshot') process.kill(process.pid, 'SIGSTOP'); } });

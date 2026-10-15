import { runProjectWorker } from '../../src/workers/runtime.js';
// Suspend the real owning process at a durable boundary; no substitute backend or target execution.
runProjectWorker(undefined, { phase(phase) { if (phase === 'running') process.kill(process.pid, 'SIGSTOP'); } });

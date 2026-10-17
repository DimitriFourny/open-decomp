import { runStdio } from '../../src/mcp/cli.js';

// Test-only source entry: the shipped CLI cannot shorten the output-stall deadline.
// The first argument is the deadline in milliseconds; the rest are `mcp start` arguments.
const [stallMs, ...args] = process.argv.slice(2);
await runStdio(args, { outputStallMs: Number(stallMs) });

#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMcpWorkflows } from './mcp-workflow.js';

let serverEntry = fileURLToPath(new URL('../src/cli/entry.js', import.meta.url));
let fixtures = resolve('fixtures/bin');
const seen = new Set<string>();
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index]!;
  if (flag === '--help' && process.argv.length === 3) {
    process.stderr.write(
      'Usage: node dist/scripts/mcp-smoke.js [--server-entry PATH] [--fixtures PATH]\nLaunch the compiled or installed MCP entry with the official SDK client. Fixtures is the bin directory alongside manifest.json; inputs are hash-checked. Reuse all four investigations, including persisted annotations/cache after a real MCP process restart.\n',
    );
    process.exit(0);
  }
  if (flag !== '--server-entry' && flag !== '--fixtures') throw new Error('Unknown smoke argument');
  if (seen.has(flag)) throw new Error(`Duplicate ${flag}`);
  seen.add(flag);
  const value = process.argv[++index];
  if (!value || value.startsWith('--') || value.includes('\0'))
    throw new Error(`Missing or malformed ${flag}`);
  if (flag === '--server-entry') serverEntry = resolve(value);
  else fixtures = resolve(value);
}

for (const summary of await runMcpWorkflows({ serverEntry, fixtures })) {
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

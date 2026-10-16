#!/usr/bin/env node
import { runStdio } from './cli.js';

void runStdio(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unable to start MCP server';
  process.stderr.write(`open-decomp-mcp: ${message.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 512)}\n`);
  process.exitCode = 1;
});

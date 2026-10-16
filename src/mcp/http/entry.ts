#!/usr/bin/env node
import { runHttpCli } from './cli.js';

void runHttpCli(process.argv.slice(2)).catch(() => {
  // Configuration can contain sensitive filesystem names. Never echo credentials or raw SDK requests.
  process.stderr.write('open-decomp-mcp-http: startup or shutdown failed; inspect the private configuration, TLS files and bind permissions\n');
  process.exitCode = 1;
});

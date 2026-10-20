#!/usr/bin/env node
import { runAnalysisCli } from './commands.js';
import { runStdio } from '../mcp/cli.js';
import { runHttpCli } from '../mcp/http/cli.js';

const VERSION = '0.1.0';
const HELP = `Usage: open-decomp <command>

  functions BINARY [--name TEXT] [--json] [--cache PATH] [--slice ID] [--no-analysis-cache]
  decompile BINARY (--function NAME|--id ID|--address SPACE:0x...)
                   [--language c-like|python-like] [--view source|checked] [--json]
                   [--cache PATH] [--slice ID] [--no-analysis-cache]
  export BINARY --out DIR [--language c-like|python-like] [--jobs N] [--name TEXT]
                 [--cache PATH] [--slice ID] [--no-analysis-cache]
                 Write every function as OUT/functions/NAME@0xADDR.c plus index/strings/imports TSVs
                 and OUT/types.h
  types BINARY [--json] [--cache PATH] [--slice ID] [--no-analysis-cache]
  functions --help / decompile --help / export --help / types --help    Show command-specific options

Analysis reuses persistent SQLite projects in INPUT.open-decomp by default;
--cache PATH overrides the cache root. Content and selected slice identify projects.
--no-analysis-cache reads and writes no derived analysis (published results, reuse candidates,
persisted callee summaries); the import and its indexes still persist. Output is identical.

Serve MCP in the foreground:
  mcp start --root PATH [--root PATH ...] [options]
  mcp start --transport http --config ABSOLUTE_JSON_PATH
  mcp start [--transport stdio|http] --help

  --help       Print this help
  --version    Print the version

MCP defaults to stdio; its stdout is reserved for protocol traffic.
`;

async function runMcp(args: readonly string[]): Promise<void> {
  if (args[0] !== 'start') throw new Error('Expected mcp start; use --help for usage');
  let transport: 'stdio' | 'http' = 'stdio';
  let specified = false;
  const transportArgs: string[] = [];
  for (let index = 1; index < args.length; index++) {
    const argument = args[index]!;
    if (argument !== '--transport') {
      transportArgs.push(argument);
      continue;
    }
    if (specified) throw new Error('Duplicate --transport');
    specified = true;
    const value = args[++index];
    if (value !== 'stdio' && value !== 'http')
      throw new Error('Expected --transport stdio or --transport http');
    transport = value;
  }
  if (transport === 'http') {
    try {
      await runHttpCli(transportArgs);
    } catch {
      // Private configuration and TLS errors may contain credentials or paths.
      process.stderr.write(
        'open-decomp mcp start: startup or shutdown failed; inspect the private configuration, TLS files and bind permissions\n',
      );
      process.exitCode = 1;
    }
    return;
  }
  await runStdio(transportArgs);
}

async function main(args: readonly string[]): Promise<void> {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    process.stderr.write(HELP);
    return;
  }
  if (args.length === 1 && args[0] === '--version') {
    process.stderr.write(`${VERSION}\n`);
    return;
  }
  if (args[0] === 'mcp') {
    await runMcp(args.slice(1));
    return;
  }
  if (
    args[0] === 'functions' ||
    args[0] === 'decompile' ||
    args[0] === 'export' ||
    args[0] === 'types'
  ) {
    await runAnalysisCli(args);
    return;
  }
  throw new Error('Unknown command; use --help for usage');
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unable to run command';
  process.stderr.write(
    `open-decomp: ${message.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 512)}\n`,
  );
  process.exitCode = 1;
});

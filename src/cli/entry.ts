#!/usr/bin/env node
import { runAnalysisCli } from './commands.js';
import { runSettingsCli } from './settings.js';
import { runStdio } from '../mcp/cli.js';
import { runHttpCli } from '../mcp/http/cli.js';
import { loadSettings } from '../settings/index.js';

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
  settings [--json] [--settings PATH]
                 Print the resolved settings file, whether it exists, and each effective value
                 with its source (default or file)
  functions --help / decompile --help / export --help / types --help / settings --help
                 Show command-specific options

Analysis reuses persistent SQLite projects in INPUT.open-decomp by default;
--cache PATH overrides the cache root. Content and selected slice identify projects.
--no-analysis-cache reads and writes no derived analysis (published results, reuse candidates,
persisted callee summaries); the import and its indexes still persist. Output is identical.
--analysis-cache forces it on when a settings file turns it off.
At open, the open-time job prepares the callee unit of every indexed function in helper
processes into the project (once per project); --no-open-job skips it.

Settings: optional JSON at $XDG_CONFIG_HOME/open-decomp/settings.json (default
~/.config/open-decomp/settings.json) sets defaults for cache_root, analysis_cache,
decompile.language/view and export.language/jobs. Every command and mcp start accept
--settings PATH for another file (it must exist). Built-in default < settings file < explicit flag.

Serve MCP in the foreground:
  mcp start --root PATH [--root PATH ...] [options] [--settings PATH]
  mcp start --transport http --config ABSOLUTE_JSON_PATH [--settings PATH]
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
  let settingsPath: string | undefined;
  for (let index = 1; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === '--settings') {
      if (settingsPath !== undefined) throw new Error('Duplicate --settings');
      settingsPath = args[++index];
      if (!settingsPath || settingsPath.startsWith('--') || settingsPath.includes('\0'))
        throw new Error('Missing or malformed value for --settings');
      continue;
    }
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
  // Help and version output must not depend on (or fail because of) a user settings file.
  const settings = transportArgs.some(
    (argument) => argument === '--help' || argument === '--version',
  )
    ? undefined
    : await loadSettings(settingsPath);
  if (transport === 'http') {
    try {
      await runHttpCli(transportArgs, settings);
    } catch {
      // Private configuration and TLS errors may contain credentials or paths.
      process.stderr.write(
        'open-decomp mcp start: startup or shutdown failed; inspect the private configuration, TLS files and bind permissions\n',
      );
      process.exitCode = 1;
    }
    return;
  }
  await runStdio(transportArgs, {}, settings);
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
  if (args[0] === 'settings') {
    await runSettingsCli(args.slice(1));
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

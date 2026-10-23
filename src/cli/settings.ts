import { inspectSettings } from '../settings/index.js';
import type { SettingKey, SettingsReport } from '../settings/index.js';
import { terminal } from './commands.js';

export const SETTINGS_USAGE = 'open-decomp settings [--json] [--settings PATH]';
const HELP = `Usage: ${SETTINGS_USAGE}

Print the resolved settings file path, whether it exists, and every effective setting with the
source of its value (default or file). The file is optional JSON:

  {
    "version": 1,
    "cache_root": "/absolute/cache",   same meaning as --cache
    "analysis_cache": true,            false = --no-analysis-cache
    "decompile": { "language": "c-like" | "python-like", "view": "source" | "checked",
                   "inference": "proven" | "likely" },
    "export": { "language": "c-like" | "python-like", "jobs": 1..32 }
  }

Default location: $XDG_CONFIG_HOME/open-decomp/settings.json, else ~/.config/open-decomp/settings.json.
A missing default file means built-in defaults. An explicit --settings file must exist. Invalid
JSON, an unknown key, a wrong type or a wrong version is an error naming the path and key.
Precedence: built-in default < settings file < explicit flag / API option / MCP request argument.

--settings PATH  Read this file instead of the default location.
--json           Write {path,exists,explicit,settings,sources} JSON to stdout.
--help           Show this help.
Exit: 0 settings resolved; 1 usage or settings-file error.
`;

const KEYS: readonly SettingKey[] = [
  'cache_root',
  'analysis_cache',
  'decompile.language',
  'decompile.view',
  'decompile.inference',
  'export.language',
  'export.jobs',
];

function valueOf(report: SettingsReport, key: SettingKey): string | number | boolean | null {
  const { settings } = report;
  switch (key) {
    case 'cache_root':
      return settings.cache_root;
    case 'analysis_cache':
      return settings.analysis_cache;
    case 'decompile.language':
      return settings.decompile.language;
    case 'decompile.view':
      return settings.decompile.view;
    case 'decompile.inference':
      return settings.decompile.inference;
    case 'export.language':
      return settings.export.language;
    case 'export.jobs':
      return settings.export.jobs;
  }
}

/** Per-key meaning of an unset (`null`) value, so the table never shows a bare placeholder. */
const UNSET: Partial<Record<SettingKey, string>> = {
  cache_root: '(unset: BINARY.open-decomp beside each binary)',
  'export.jobs': '(unset: min(4, CPUs/2))',
};

function describe(report: SettingsReport): string {
  const width = Math.max(...KEYS.map((key) => key.length));
  const lines = [
    `file:   ${terminal(report.path, 32768)}`,
    `exists: ${report.exists ? 'yes' : 'no (built-in defaults apply)'}`,
    `origin: ${report.explicit ? '--settings' : 'default location'}`,
    '',
  ];
  for (const key of KEYS) {
    const value = valueOf(report, key);
    lines.push(
      `${key.padEnd(width)}  ${value === null ? (UNSET[key] ?? '(unset)') : terminal(String(value), 32768)}  [${report.sources[key]}]`,
    );
  }
  return `${lines.join('\n')}\n`;
}

class UsageError extends Error {}

/** `open-decomp settings`: introspection only; it never opens or analyzes a binary. */
export async function runSettingsCli(args: readonly string[]): Promise<void> {
  let json = false,
    path: string | undefined,
    help = false;
  try {
    for (let index = 0; index < args.length; index++) {
      const argument = args[index]!;
      if (argument === '--help') help = true;
      else if (argument === '--json') {
        if (json) throw new UsageError('Duplicate option --json');
        json = true;
      } else if (argument === '--settings' || argument.startsWith('--settings=')) {
        if (path !== undefined) throw new UsageError('Duplicate option --settings');
        const value =
          argument === '--settings' ? args[++index] : argument.slice('--settings='.length);
        if (value === undefined || value.length === 0 || value.startsWith('--'))
          throw new UsageError('Missing value for --settings');
        path = value;
      } else throw new UsageError(`Unknown argument ${terminal(argument)}`);
    }
    if (help) {
      process.stdout.write(HELP);
      return;
    }
    const report = await inspectSettings(path);
    process.stdout.write(json ? `${JSON.stringify(report)}\n` : describe(report));
  } catch (error) {
    process.stderr.write(
      `error: ${terminal(error instanceof Error ? error.message : String(error))}\n${error instanceof UsageError ? `Usage: ${SETTINGS_USAGE}\n` : ''}`,
    );
    process.exitCode = 1;
  }
}

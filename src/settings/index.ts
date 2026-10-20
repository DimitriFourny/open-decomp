import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { DEFAULT_ANALYSIS_OPTIONS, analysisOptionsSchema } from '../core/index.js';
import { readBoundedLocalFile } from '../mcp/http/config.js';

/** Optional user settings: defaults for the knobs that already exist as flags and options.
 * Precedence is built-in default < settings file < explicit CLI flag / API option / MCP request
 * argument. The library never reads this file implicitly; entry points call `loadSettings`. */
export const SETTINGS_VERSION = 1;
const MAX_SETTINGS_BYTES = 65_536;

// One definition of each domain: the same enums and bounds the flags and options validate.
export const languageSchema = analysisOptionsSchema.shape.emitter.unwrap();
export const viewSchema = analysisOptionsSchema.shape.view.unwrap();
export const inferenceSchema = analysisOptionsSchema.shape.inference.unwrap();
export const jobsSchema = z.number().int().min(1).max(32);
export type SettingsLanguage = z.infer<typeof languageSchema>;
export type SettingsView = z.infer<typeof viewSchema>;
export type SettingsInference = z.infer<typeof inferenceSchema>;

const cacheRootSchema = z
  .string()
  .min(1)
  .max(32768)
  .refine((value) => isAbsolute(value) && !value.includes('\0'), 'Expected an absolute path');

/** The file as written: every key but `version` is optional. Strict at every level. A new key
 * is one more optional entry here, in `Settings` and in `resolve`. */
export const settingsFileSchema = z.strictObject({
  version: z.literal(SETTINGS_VERSION),
  cache_root: cacheRootSchema.optional(),
  analysis_cache: z.boolean().optional(),
  decompile: z
    .strictObject({
      language: languageSchema.optional(),
      view: viewSchema.optional(),
      inference: inferenceSchema.optional(),
    })
    .optional(),
  export: z
    .strictObject({ language: languageSchema.optional(), jobs: jobsSchema.optional() })
    .optional(),
});
export type SettingsFile = z.infer<typeof settingsFileSchema>;

/** Effective values. `null` means no built-in value: `cache_root` falls back to the per-binary
 * sidecar, `export.jobs` to the exporter's CPU-based default. */
export interface Settings {
  readonly version: typeof SETTINGS_VERSION;
  readonly cache_root: string | null;
  readonly analysis_cache: boolean;
  readonly decompile: {
    readonly language: SettingsLanguage;
    readonly view: SettingsView;
    readonly inference: SettingsInference;
  };
  readonly export: { readonly language: SettingsLanguage; readonly jobs: number | null };
}
export type SettingKey =
  | 'cache_root'
  | 'analysis_cache'
  | 'decompile.language'
  | 'decompile.view'
  | 'decompile.inference'
  | 'export.language'
  | 'export.jobs';
export type SettingSource = 'default' | 'file';

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  version: SETTINGS_VERSION,
  cache_root: null,
  analysis_cache: true,
  decompile: Object.freeze({
    language: DEFAULT_ANALYSIS_OPTIONS.emitter,
    view: DEFAULT_ANALYSIS_OPTIONS.view,
    inference: DEFAULT_ANALYSIS_OPTIONS.inference,
  }),
  export: Object.freeze({ language: DEFAULT_ANALYSIS_OPTIONS.emitter, jobs: null }),
});

/** What `open-decomp settings` prints. */
export interface SettingsReport {
  /** Resolved file path (the explicit one, or the XDG default). */
  readonly path: string;
  readonly exists: boolean;
  /** True when the path was given explicitly rather than derived. */
  readonly explicit: boolean;
  readonly settings: Settings;
  readonly sources: Readonly<Record<SettingKey, SettingSource>>;
}

/** A settings file that is missing (when explicit), unreadable or invalid. Never swallowed. */
export class SettingsError extends Error {
  constructor(
    readonly path: string,
    /** Dotted key of the first offending entry, when the problem is a specific key. */
    readonly key: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'SettingsError';
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

/** `$XDG_CONFIG_HOME/open-decomp/settings.json`, else `~/.config/open-decomp/settings.json`.
 * A relative `XDG_CONFIG_HOME` is ignored, as the XDG specification requires. */
export function defaultSettingsPath(env: Environment = process.env): string {
  const xdg = env['XDG_CONFIG_HOME'];
  const base = xdg && isAbsolute(xdg) ? xdg : join(env['HOME'] || homedir(), '.config');
  return join(base, 'open-decomp', 'settings.json');
}

function failure(path: string, key: string | undefined, detail: string): SettingsError {
  return new SettingsError(
    path,
    key,
    `settings file ${path}: ${key === undefined ? '' : `key "${key}": `}${detail}`,
  );
}

function parseFile(path: string, text: string): SettingsFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw failure(path, undefined, `invalid JSON (${(error as Error).message})`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw failure(path, undefined, 'expected a JSON object');
  const version = (value as Record<string, unknown>)['version'];
  if (version === undefined)
    throw failure(path, 'version', `required; expected ${SETTINGS_VERSION}`);
  if (version !== SETTINGS_VERSION)
    throw failure(
      path,
      'version',
      `unsupported version ${JSON.stringify(version)}; expected ${SETTINGS_VERSION}`,
    );
  const result = settingsFileSchema.safeParse(value);
  if (result.success) return result.data;
  const problems = result.error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => ({
          key: [...issue.path, key].join('.'),
          detail: 'unknown key',
        }))
      : [{ key: issue.path.join('.'), detail: issue.message }],
  );
  const first = problems[0]!;
  throw new SettingsError(
    path,
    first.key || undefined,
    `settings file ${path}: ${problems
      .slice(0, 8)
      .map((problem) => (problem.key ? `key "${problem.key}": ${problem.detail}` : problem.detail))
      .join('; ')}`,
  );
}

function resolveFile(file: SettingsFile | undefined): Pick<SettingsReport, 'settings' | 'sources'> {
  const from = (present: boolean): SettingSource => (present ? 'file' : 'default');
  return {
    settings: {
      version: SETTINGS_VERSION,
      cache_root: file?.cache_root ?? DEFAULT_SETTINGS.cache_root,
      analysis_cache: file?.analysis_cache ?? DEFAULT_SETTINGS.analysis_cache,
      decompile: {
        language: file?.decompile?.language ?? DEFAULT_SETTINGS.decompile.language,
        view: file?.decompile?.view ?? DEFAULT_SETTINGS.decompile.view,
        inference: file?.decompile?.inference ?? DEFAULT_SETTINGS.decompile.inference,
      },
      export: {
        language: file?.export?.language ?? DEFAULT_SETTINGS.export.language,
        jobs: file?.export?.jobs ?? DEFAULT_SETTINGS.export.jobs,
      },
    },
    sources: {
      cache_root: from(file?.cache_root !== undefined),
      analysis_cache: from(file?.analysis_cache !== undefined),
      'decompile.language': from(file?.decompile?.language !== undefined),
      'decompile.view': from(file?.decompile?.view !== undefined),
      'decompile.inference': from(file?.decompile?.inference !== undefined),
      'export.language': from(file?.export?.language !== undefined),
      'export.jobs': from(file?.export?.jobs !== undefined),
    },
  };
}

/** Resolve and validate the settings file. `path` is an explicit file (which must exist); without
 * it the default location is used and a missing file means built-in defaults. Any other problem
 * (unreadable, not a regular file, oversized, invalid JSON, unknown key, wrong type or version)
 * throws a `SettingsError` naming the path and the offending key. */
export async function inspectSettings(
  path?: string,
  env: Environment = process.env,
): Promise<SettingsReport> {
  const explicit = path !== undefined;
  const file = explicit ? resolve(path) : defaultSettingsPath(env);
  let bytes: Buffer;
  try {
    bytes = await readBoundedLocalFile(file, MAX_SETTINGS_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (explicit) throw failure(file, undefined, 'does not exist');
      return { path: file, exists: false, explicit, ...resolveFile(undefined) };
    }
    throw failure(file, undefined, `cannot read (${(error as Error).message})`);
  }
  return {
    path: file,
    exists: true,
    explicit,
    ...resolveFile(parseFile(file, bytes.toString('utf8'))),
  };
}

/** The validated effective settings, or the built-in defaults when the default file is missing.
 * `env` is injectable so callers and tests never depend on the real home directory. */
export async function loadSettings(
  path?: string,
  env: Environment = process.env,
): Promise<Settings> {
  return (await inspectSettings(path, env)).settings;
}

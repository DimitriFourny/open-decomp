import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { OperationError } from '../core/index.js';
import type { ToolName } from '../core/index.js';
import { hashInput, projectDirectoryName } from '../service/queries/input-identity.js';
import type { SettingsLanguage, SettingsView } from '../settings/index.js';
import { authorizePath, containsPath } from '../workers/paths.js';

/** Server-wide defaults from the settings file. A per-request argument always wins. */
export interface McpServerDefaults {
  /** Used when a `function_decompile` request omits `options.emitter` / `options.view`. */
  readonly decompile?: { readonly language?: SettingsLanguage; readonly view?: SettingsView };
  /** Lets `project_open` import omit `project_path`: the project is then
   * `<cache_root>/<sha256>.<slice|default>`, the layout the CLI and API use. */
  readonly projects?: { readonly cache_root: string; readonly authorized_roots: readonly string[] };
}
export interface DefaultsProblem {
  readonly path: string;
  readonly hint: string;
}

const jsonObject = z.record(z.string(), z.unknown());
type Json = z.infer<typeof jsonObject>;

/** The request-option defaults, spelled as `function_decompile` `options`. */
function decompileOptions(defaults: NonNullable<McpServerDefaults['decompile']>): Json {
  return {
    ...(defaults.language === undefined ? {} : { emitter: defaults.language }),
    ...(defaults.view === undefined ? {} : { view: defaults.view }),
  };
}

/** Canonical project defaults. `cache_root` must be an existing directory inside an authorized
 * root, or every defaulted `project_open` would fail authorization one request at a time. */
export async function projectDefaults(
  cacheRoot: string,
  authorizedRoots: readonly string[],
): Promise<NonNullable<McpServerDefaults['projects']>> {
  let canonical: string;
  try {
    canonical = await realpath(cacheRoot);
    if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`settings key "cache_root": ${cacheRoot} must be an existing directory`);
  }
  const roots = await Promise.all(authorizedRoots.map((root) => realpath(root)));
  if (!roots.some((root) => containsPath(root, canonical)))
    throw new Error(
      `settings key "cache_root": ${cacheRoot} must be inside an authorized --root directory`,
    );
  return { cache_root: canonical, authorized_roots: roots };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Apply defaults to the raw request before it is prepared and validated. Returns the request,
 * or the problem that makes it unusable. Requests that are not shaped as the defaults expect pass
 * through unchanged for the core schema to reject. */
export async function applyDefaults(
  name: ToolName,
  input: unknown,
  defaults: McpServerDefaults | undefined,
): Promise<{ readonly input: unknown } | DefaultsProblem> {
  const request = jsonObject.safeParse(input).data;
  if (defaults === undefined || request === undefined) return { input };
  if (name === 'function_decompile' && defaults.decompile !== undefined) {
    const given =
      request['options'] === undefined ? {} : jsonObject.safeParse(request['options']).data;
    // A malformed `options` passes through for the core schema to reject.
    return {
      input:
        given === undefined
          ? input
          : { ...request, options: { ...decompileOptions(defaults.decompile), ...given } },
    };
  }
  const projects = defaults.projects;
  if (name !== 'project_open' || projects === undefined) return { input };
  const source = jsonObject.safeParse(request['source']).data;
  if (
    source === undefined ||
    source['kind'] !== 'import' ||
    source['project_path'] !== undefined ||
    typeof source['input_path'] !== 'string' ||
    (source['slice_id'] !== undefined && typeof source['slice_id'] !== 'string')
  )
    return { input };
  const inputPath = source['input_path'];
  if (!isAbsolute(inputPath))
    return { path: 'source.input_path', hint: 'input_path must be an absolute path' };
  let projectPath: string;
  try {
    const sha256 = await hashInput(await authorizePath(projects.authorized_roots, inputPath));
    projectPath = join(projects.cache_root, projectDirectoryName(sha256, source['slice_id']));
  } catch (error) {
    return {
      path: 'source.input_path',
      hint:
        error instanceof OperationError
          ? error.diagnostic.message.slice(0, 240)
          : 'The input cannot be read to derive its default project path',
    };
  }
  try {
    // The same content already has a project: resume it, as the CLI and API do.
    if ((await exists(projectPath)) && source['mode'] !== 'resume')
      return { input: { ...request, source: { kind: 'resume', project_path: projectPath } } };
  } catch {
    return {
      path: 'source.project_path',
      hint: 'The default project location cannot be inspected',
    };
  }
  return { input: { ...request, source: { ...source, project_path: projectPath } } };
}

/** The JSON Schema MCP advertises, adjusted to the server's defaults. */
export function advertiseDefaults(
  name: ToolName,
  schema: Json,
  defaults: McpServerDefaults | undefined,
): Json {
  const properties = jsonObject.safeParse(schema['properties']).data;
  if (defaults === undefined || properties === undefined) return schema;
  const projects = defaults.projects;
  if (name === 'project_open' && projects !== undefined) {
    const source = jsonObject.safeParse(properties['source']).data;
    const variants = z.array(jsonObject).safeParse(source?.['oneOf']).data;
    if (source === undefined || variants === undefined) return schema;
    const patched = variants.map((variant) => {
      const fields = jsonObject.safeParse(variant['properties']).data;
      const kind = jsonObject.safeParse(fields?.['kind']).data?.['const'];
      if (fields === undefined || kind !== 'import') return variant;
      return {
        ...variant,
        required: z
          .array(z.string())
          .parse(variant['required'])
          .filter((key) => key !== 'project_path'),
        properties: {
          ...fields,
          project_path: {
            ...jsonObject.parse(fields['project_path']),
            description: `Optional. Omitted: ${join(projects.cache_root, '<sha256 of input>.<slice_id|default>')}, resumed when it already exists.`,
          },
        },
      };
    });
    return { ...schema, properties: { ...properties, source: { ...source, oneOf: patched } } };
  }
  if (name === 'function_decompile' && defaults.decompile !== undefined) {
    const options = jsonObject.safeParse(properties['options']).data;
    const fields = jsonObject.safeParse(options?.['properties']).data;
    if (options === undefined || fields === undefined) return schema;
    const wanted = decompileOptions(defaults.decompile);
    const patched = { ...fields };
    for (const [key, value] of Object.entries(wanted))
      patched[key] = { ...jsonObject.parse(fields[key]), default: value };
    return {
      ...schema,
      properties: {
        ...properties,
        options: {
          ...options,
          default: { ...jsonObject.parse(options['default']), ...wanted },
          properties: patched,
        },
      },
    };
  }
  return schema;
}

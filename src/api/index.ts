import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { OperationError, sliceIdSchema } from '../core/index.js';
import type { ToolInput, ToolResult, WireJob } from '../core/index.js';
import { QueryService } from '../service/queries/index.js';
import { hashInput, projectDirectoryName } from '../service/queries/input-identity.js';
import type { QueryCallOptions } from '../service/queries/index.js';
import { materializeDecompilation } from '../service/queries/materialize.js';
import { selectFunction } from '../service/queries/selector.js';
export { FunctionSelectionError } from '../service/queries/selector.js';
/** The settings file is never read implicitly: call `loadSettings()` and pass the values you want
 * (`cache_root` as `cachePath`, `analysis_cache` as `analysisCache`, `decompile.*` as decompile
 * options) to `openBinary()` / `decompile()`. */
export { loadSettings, SettingsError } from '../settings/index.js';
export type { Settings } from '../settings/index.js';

export type { ToolInput, ToolResult, WireJob } from '../core/index.js';
export { expandEmission } from '../core/index.js';
export type {
  ExpandedEmission,
  ExpandedInference,
  ExpandedRequirement,
  ExpandedSourceMapping,
} from '../core/index.js';
export type { QueryCallOptions } from '../service/queries/index.js';
export type BinaryImage = NonNullable<
  Extract<ToolResult<'project_open'>, { data: unknown }>['data']['image']
>;
export type BinaryFunction = Extract<
  ToolResult<'functions_find'>,
  { data: unknown }
>['data']['items'][number];
export type FunctionQuery = Omit<
  ToolInput<'functions_find'>,
  'project_id' | 'revision' | 'image_id'
>;
export type SymbolQuery = Omit<ToolInput<'symbols_find'>, 'project_id' | 'revision' | 'image_id'>;
export type StringQuery = Omit<ToolInput<'strings_find'>, 'project_id' | 'revision' | 'image_id'>;
export type ReferenceQuery = Omit<ToolInput<'xrefs_get'>, 'project_id' | 'revision'>;
export type FunctionViewQuery = Omit<
  ToolInput<'function_get'>,
  'project_id' | 'revision' | 'function_id'
>;
export type FunctionSelector =
  | { readonly name: string }
  | { readonly id: string }
  | { readonly address: { readonly space: 'va' | 'rva' | 'file'; readonly value: string } };
export interface OpenBinaryOptions {
  /** Cache root, not a project directory. Defaults to <canonical input>.open-decomp. */
  readonly cachePath?: string;
  readonly sliceId?: string;
  /** `false` disables analysis caching for this session: no derived analysis (published
   * results, reuse candidates, persisted or in-process callee summaries) is read or written.
   * Project import, indexes and annotations still persist. Default `true`. */
  readonly analysisCache?: boolean;
  readonly budget?: ToolInput<'project_open'>['budget'];
  readonly signal?: AbortSignal;
  readonly onProgress?: (job: WireJob) => void;
}
export interface DecompileOptions {
  readonly emitter?: 'c-like' | 'python-like';
  /** `source` (default) applies proof-carrying presentation rewrites; `checked` prints every machine fact. */
  readonly view?: 'source' | 'checked';
  /** `proven` (default) closes only established interfaces. `likely` also applies gated
   * heuristics (marked in the text, recorded as `guess` inferences); its results are cached
   * separately and may be wrong. */
  readonly inference?: 'proven' | 'likely';
  /** `inline` (default) prints structure typedefs and bodies in the text. `external` leaves
   * them out and returns them in `emission.structures` (C-like). */
  readonly structures?: 'inline' | 'external';
  readonly budget?: ToolInput<'function_decompile'>['budget'];
  readonly signal?: AbortSignal;
  readonly onProgress?: (job: WireJob) => void;
}
export class BinaryOpenError extends Error {
  constructor(
    readonly result: ToolResult<'project_open'>,
    readonly projectPath: string,
    readonly reused: boolean,
  ) {
    super(
      result.state === 'failed' || result.state === 'unsupported'
        ? result.error.message
        : 'Project import is unfinished; inspect the saved project with MCP or use a different cache directory. No import was replayed.',
    );
    this.name = 'BinaryOpenError';
  }
}
function invalid(message: string): never {
  throw new OperationError({ code: 'invalid_input', severity: 'error', message, evidence_ids: [] });
}
async function exists(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      invalid('Cached project must be a directory, not a symlink.');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function cacheDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    invalid('Cache directory must be a directory, not a symlink.');
  return realpath(path);
}

const selectorSchema = z.union([
  z.strictObject({ name: z.string().min(1).max(4096) }),
  z.strictObject({ id: z.string().regex(/^entity_[0-9a-f]{64}$/) }),
  z.strictObject({
    address: z.strictObject({
      space: z.enum(['va', 'rva', 'file']),
      value: z.string().regex(/^0x[0-9a-fA-F]{1,16}$/),
    }),
  }),
]);

/** One local project owner. Always close it in finally to release its SQLite lock and child. */
export class BinarySession {
  readonly image: BinaryImage;
  readonly projectId: string;
  readonly revision: number;
  #closing: Promise<void> | undefined;
  private constructor(
    readonly inputPath: string,
    readonly cachePath: string,
    readonly projectPath: string,
    readonly reused: boolean,
    readonly opened: ToolResult<'project_open'>,
    private readonly service: QueryService,
  ) {
    if (
      !('data' in opened) ||
      opened.data.image === null ||
      opened.project_id === null ||
      opened.revision === null
    ) {
      throw new BinaryOpenError(opened, projectPath, reused);
    }
    this.image = opened.data.image;
    this.projectId = opened.project_id;
    this.revision = opened.revision;
  }

  /** Use openBinary() rather than constructing a service/project manually. */
  static async open(input: string, options: OpenBinaryOptions = {}): Promise<BinarySession> {
    const sliceId =
      options.sliceId === undefined ? undefined : sliceIdSchema.parse(options.sliceId);
    const inputPath = await realpath(resolve(input));
    const sha256 = await hashInput(inputPath, options.signal);
    const cachePath = await cacheDirectory(
      resolve(options.cachePath ?? `${inputPath}.open-decomp`),
    );
    const projectPath = join(cachePath, projectDirectoryName(sha256, sliceId));
    const reused = await exists(projectPath);
    const service = await QueryService.create({
      authorized_roots: [dirname(inputPath), cachePath],
      max_workers: 1,
      ...(options.analysisCache === false ? { analysis_cache: false } : {}),
    });
    try {
      options.signal?.throwIfAborted();
      const opened = await service.execute(
        'project_open',
        {
          source: reused
            ? { kind: 'resume', project_path: projectPath }
            : {
                kind: 'import',
                input_path: inputPath,
                project_path: projectPath,
                ...(sliceId === undefined ? {} : { slice_id: sliceId }),
              },
          wait: true,
          ...(options.budget === undefined ? {} : { budget: options.budget }),
        },
        {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
        },
      );
      const session = new BinarySession(inputPath, cachePath, projectPath, reused, opened, service);
      if (
        session.image.sha256 !== sha256 ||
        (sliceId !== undefined && session.image.selected_slice_id !== sliceId)
      ) {
        invalid(
          'Cached/imported image does not match the current binary and selected slice. No cached analysis was returned.',
        );
      }
      options.signal?.throwIfAborted();
      return session;
    } catch (error) {
      await service.close('cancel');
      throw error;
    }
  }

  #requireOpen(): void {
    if (this.#closing) invalid('Binary session is closed.');
  }

  async findFunctions(
    options: FunctionQuery = {},
    call: QueryCallOptions = {},
  ): Promise<ToolResult<'functions_find'>> {
    this.#requireOpen();
    return this.service.execute(
      'functions_find',
      { ...options, project_id: this.projectId, revision: this.revision, image_id: this.image.id },
      call,
    );
  }

  /** Image-wide merged structure types as C declarations (`binary_info` view
   * `types`): `data.text` is a self-contained header; a partial result names
   * the analyzed function count. */
  async types(
    options: { readonly budget?: ToolInput<'binary_info'>['budget'] } = {},
    call: QueryCallOptions = {},
  ): Promise<ToolResult<'binary_info'>> {
    this.#requireOpen();
    return this.service.execute(
      'binary_info',
      {
        project_id: this.projectId,
        revision: this.revision,
        image_id: this.image.id,
        view: 'types',
        ...(options.budget === undefined ? {} : { budget: options.budget }),
      },
      call,
    );
  }

  async findSymbols(
    options: SymbolQuery = {},
    call: QueryCallOptions = {},
  ): Promise<ToolResult<'symbols_find'>> {
    this.#requireOpen();
    return this.service.execute(
      'symbols_find',
      { ...options, project_id: this.projectId, revision: this.revision, image_id: this.image.id },
      call,
    );
  }

  async findStrings(
    options: StringQuery = {},
    call: QueryCallOptions = {},
  ): Promise<ToolResult<'strings_find'>> {
    this.#requireOpen();
    return this.service.execute(
      'strings_find',
      { ...options, project_id: this.projectId, revision: this.revision, image_id: this.image.id },
      call,
    );
  }

  async getReferences(
    options: ReferenceQuery,
    call: QueryCallOptions = {},
  ): Promise<ToolResult<'xrefs_get'>> {
    this.#requireOpen();
    return this.service.execute(
      'xrefs_get',
      { ...options, project_id: this.projectId, revision: this.revision },
      call,
    );
  }

  /** Metadata, disassembly or CFG pages of one function (view defaults to metadata). */
  async getFunction(
    functionId: string,
    options: FunctionViewQuery = {},
    call: QueryCallOptions = {},
  ): Promise<ToolResult<'function_get'>> {
    this.#requireOpen();
    return this.service.execute(
      'function_get',
      {
        ...options,
        project_id: this.projectId,
        revision: this.revision,
        function_id: functionId,
      },
      call,
    );
  }

  /** The C declarations text of `types()`, or null when the request failed. */
  async typeDeclarations(call: QueryCallOptions = {}): Promise<string | null> {
    const result = await this.types({}, call);
    return 'data' in result && result.data.view === 'types' ? result.data.text : null;
  }

  async decompile(
    input: FunctionSelector,
    options: DecompileOptions = {},
  ): Promise<ToolResult<'function_decompile'>> {
    this.#requireOpen();
    const selector = selectorSchema.parse(input);
    const call: QueryCallOptions = {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    };
    options.signal?.throwIfAborted();
    const selected = await selectFunction(
      this.service,
      { project_id: this.projectId, revision: this.revision, image_id: this.image.id },
      selector,
      call,
    );
    return this.decompileFunction(selected.id, options);
  }

  /** Decompile an already identified function (entity ID from findFunctions). */
  async decompileFunction(
    functionId: string,
    options: DecompileOptions = {},
  ): Promise<ToolResult<'function_decompile'>> {
    this.#requireOpen();
    const call: QueryCallOptions = {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    };
    const result = await this.service.execute(
      'function_decompile',
      {
        project_id: this.projectId,
        revision: this.revision,
        function_id: functionId,
        wait: true,
        ...(options.emitter === undefined &&
        options.view === undefined &&
        options.inference === undefined &&
        options.structures === undefined
          ? {}
          : {
              options: {
                ...(options.emitter === undefined ? {} : { emitter: options.emitter }),
                ...(options.view === undefined ? {} : { view: options.view }),
                ...(options.inference === undefined ? {} : { inference: options.inference }),
                ...(options.structures === undefined ? {} : { structures: options.structures }),
              },
            }),
        ...(options.budget === undefined ? {} : { budget: options.budget }),
      },
      call,
    );
    return materializeDecompilation(
      this.service,
      { project_id: this.projectId, revision: this.revision },
      result,
      options.signal,
    );
  }

  close(): Promise<void> {
    this.#closing ??= this.service.close('cancel');
    return this.#closing;
  }
}

/** Open or resume a content-addressed SQLite project in a persistent local sidecar. */
export function openBinary(
  inputPath: string,
  options: OpenBinaryOptions = {},
): Promise<BinarySession> {
  return BinarySession.open(inputPath, options);
}

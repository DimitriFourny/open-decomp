import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { OperationError, sliceIdSchema } from '../core/index.js';
import type { ToolInput, ToolResult, WireJob } from '../core/index.js';
import { QueryService } from '../service/queries/index.js';
import type { QueryCallOptions } from '../service/queries/index.js';
import { materializeDecompilation } from '../service/queries/materialize.js';
import { selectFunction } from '../service/queries/selector.js';
export { FunctionSelectionError } from '../service/queries/selector.js';

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
export type FunctionSelector =
  | { readonly name: string }
  | { readonly id: string }
  | { readonly address: { readonly space: 'va' | 'rva' | 'file'; readonly value: string } };
export interface OpenBinaryOptions {
  /** Cache root, not a project directory. Defaults to <canonical input>.open-decomp. */
  readonly cachePath?: string;
  readonly sliceId?: string;
  readonly budget?: ToolInput<'project_open'>['budget'];
  readonly signal?: AbortSignal;
  readonly onProgress?: (job: WireJob) => void;
}
export interface DecompileOptions {
  readonly emitter?: 'c-like' | 'python-like';
  /** `source` (default) applies proof-carrying presentation rewrites; `checked` prints every machine fact. */
  readonly view?: 'source' | 'checked';
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
/** Hash bounded chunks rather than retaining another complete image in the host. */
async function hashInput(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > 512n * 1024n * 1024n)
      invalid('Input must be a regular file of at most 512 MiB.');
    const hash = createHash('sha256'),
      buffer = Buffer.allocUnsafe(Number(before.size < 1_048_576n ? before.size : 1_048_576n));
    let offset = 0;
    while (offset < Number(before.size)) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, Number(before.size) - offset),
        offset,
      );
      if (!bytesRead) invalid('Input changed while computing its cache identity.');
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      invalid('Input changed while computing its cache identity.');
    }
    signal?.throwIfAborted();
    return hash.digest('hex');
  } finally {
    await file.close();
  }
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
    const projectPath = join(cachePath, `${sha256}.${sliceId ?? 'default'}`);
    const reused = await exists(projectPath);
    const service = await QueryService.create({
      authorized_roots: [dirname(inputPath), cachePath],
      max_workers: 1,
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
    const result = await this.service.execute(
      'function_decompile',
      {
        project_id: this.projectId,
        revision: this.revision,
        function_id: selected.id,
        wait: true,
        ...(options.emitter === undefined && options.view === undefined
          ? {}
          : {
              options: {
                ...(options.emitter === undefined ? {} : { emitter: options.emitter }),
                ...(options.view === undefined ? {} : { view: options.view }),
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

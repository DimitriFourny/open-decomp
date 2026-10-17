import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  OperationError,
  decodeDiagnostic,
  fingerprint,
  functionDecompileResultSchema,
  sliceIdSchema,
} from '../core/index.js';
import type { ToolInput, ToolResult, WireJob } from '../core/index.js';
import {
  ANALYSIS_ARTIFACT_MEDIA_TYPE,
  ANALYSIS_ARTIFACT_VERSION,
  MAX_ANALYSIS_ARTIFACT_BYTES,
} from '../project/cache/model.js';
import { QueryService } from '../service/queries/index.js';
import type { QueryCallOptions } from '../service/queries/index.js';

export type { ToolInput, ToolResult, WireJob } from '../core/index.js';
export { expandEmission } from '../core/index.js';
export type { ExpandedEmission, ExpandedInference, ExpandedRequirement, ExpandedSourceMapping } from '../core/index.js';
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
export class FunctionSelectionError extends Error {
  constructor(
    readonly reason: 'not_found' | 'ambiguous' | 'incomplete',
    readonly candidates: readonly BinaryFunction[],
  ) {
    super(
      reason === 'ambiguous'
        ? 'Function selector is ambiguous; use a function ID or address.'
        : reason === 'incomplete'
          ? 'Function search is incomplete; uniqueness or absence cannot be established.'
          : 'No function matches the selector.',
    );
    this.name = 'FunctionSelectionError';
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
    const found = await this.findFunctions(
      {
        ...('name' in selector
          ? { query: { text: selector.name, match: 'exact', case_sensitive: true } }
          : 'id' in selector
            ? { id: selector.id }
            : { address: { ...selector.address, image_id: this.image.id } }),
        page: { limit: 2 },
      },
      call,
    );
    if (!('data' in found)) {
      if (found.state === 'failed' || found.state === 'unsupported')
        throw new OperationError(decodeDiagnostic(found.error));
      options.signal?.throwIfAborted();
      throw new FunctionSelectionError('incomplete', []);
    }
    const candidates = found.data.items;
    if (candidates.length > 1) throw new FunctionSelectionError('ambiguous', candidates);
    if (found.data.page.next_cursor !== null) {
      throw new FunctionSelectionError('incomplete', candidates);
    }
    let selected: BinaryFunction | undefined = candidates[0];
    if ('name' in selector && found.data.page.index_state !== 'complete')
      selected = await this.#selectByNativeName(selector.name, candidates, call);
    if (!selected)
      throw new FunctionSelectionError(found.state === 'partial' ? 'incomplete' : 'not_found', []);
    const result = await this.service.execute(
      'function_decompile',
      {
        project_id: this.projectId,
        revision: this.revision,
        function_id: selected.id,
        wait: true,
        ...(options.emitter === undefined ? {} : { options: { emitter: options.emitter } }),
        ...(options.budget === undefined ? {} : { budget: options.budget }),
      },
      call,
    );
    return this.#materialize(result, options.signal);
  }

  /** A partial function index cannot prove that a name is unique. The complete native symbol and
   * export tables can: they define the name (Mach-O underscore convention applied by the query
   * layer) at distinct addresses, and the index only supplies the function entity at that address.
   * Anything the authoritative tables cannot settle stays incomplete or ambiguous, never guessed. */
  async #selectByNativeName(
    name: string,
    indexed: readonly BinaryFunction[],
    call: QueryCallOptions,
  ): Promise<BinaryFunction> {
    const unsettled = (page: ToolResult<'symbols_find'> | ToolResult<'functions_find'>): never => {
      if (page.state === 'failed' || page.state === 'unsupported')
        throw new OperationError(decodeDiagnostic(page.error));
      throw new FunctionSelectionError('incomplete', indexed);
    };
    const definitions = new Map<string, BinaryFunction['entry']>();
    let authoritative = true,
      cursor: string | undefined;
    do {
      const page = await this.service.execute(
        'symbols_find',
        {
          project_id: this.projectId,
          revision: this.revision,
          image_id: this.image.id,
          kinds: ['symbol', 'export'],
          query: { text: name, match: 'exact', case_sensitive: true },
          page: { limit: 100, ...(cursor === undefined ? {} : { cursor }) },
        },
        call,
      );
      if (!('data' in page)) return unsettled(page);
      if (page.data.page.index_state !== 'complete') authoritative = false;
      for (const item of page.data.items) {
        const address =
          item.kind === 'symbol'
            ? item.symbol.kind === 'function'
              ? item.symbol.address
              : null
            : item.kind === 'export'
              ? item.export.address
              : null;
        if (address === null) continue;
        if (address.space === 'va') definitions.set(BigInt(address.value).toString(16), address);
        else authoritative = false;
      }
      cursor = page.data.page.next_cursor ?? undefined;
    } while (cursor !== undefined && definitions.size < 2);
    if (!authoritative) throw new FunctionSelectionError('incomplete', indexed);
    const functions = new Map(indexed.map((item) => [item.id, item] as const));
    const defined = new Map<string, number>();
    for (const [key, address] of [...definitions].slice(0, 16)) {
      const page = await this.findFunctions({ address, page: { limit: 3 } }, call);
      if (!('data' in page)) return unsettled(page);
      const entries = page.data.items.filter(
        (item) => item.entry.space === 'va' && BigInt(item.entry.value) === BigInt(address.value),
      );
      for (const item of entries) functions.set(item.id, item);
      defined.set(key, entries.length);
    }
    const candidates = [...functions.values()];
    if (definitions.size > 1 || candidates.length > 1)
      throw new FunctionSelectionError('ambiguous', candidates);
    const [only] = candidates;
    if (only && definitions.size === 1 && [...defined.values()][0] === 1) return only;
    throw new FunctionSelectionError('incomplete', candidates);
  }

  async #materialize(
    result: ToolResult<'function_decompile'>,
    signal?: AbortSignal,
  ): Promise<ToolResult<'function_decompile'>> {
    if (!('data' in result) || result.data.delivery !== 'artifact') return result;
    const artifactId = result.data.artifact_id;
    const artifact = result.artifacts.find((item) => item.id === artifactId);
    if (
      !artifact ||
      artifact.media_type !== ANALYSIS_ARTIFACT_MEDIA_TYPE ||
      BigInt(artifact.size) > BigInt(MAX_ANALYSIS_ARTIFACT_BYTES)
    ) {
      invalid('Invalid decompilation artifact handle.');
    }
    const size = Number(BigInt(artifact.size)),
      bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      signal?.throwIfAborted();
      const page = await this.service.readArtifact({
        project_id: this.projectId,
        revision: this.revision,
        artifact_id: artifact.id,
        offset: `0x${offset.toString(16)}`,
        length: Math.min(524_288, size - offset),
      });
      const chunk = Buffer.from(page.bytes_hex, 'hex');
      if (
        fingerprint(page.artifact) !== fingerprint(artifact) ||
        BigInt(page.offset) !== BigInt(offset) ||
        chunk.length === 0 ||
        chunk.length > Math.min(524_288, size - offset)
      )
        invalid('Inconsistent decompilation artifact page.');
      chunk.copy(bytes, offset);
      offset += chunk.length;
      if (page.next_offset !== (offset === size ? null : `0x${offset.toString(16)}`))
        invalid('Inconsistent decompilation artifact continuation.');
    }
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
      invalid('Decompilation artifact checksum mismatch.');
    signal?.throwIfAborted();
    const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const stored = z
      .object({
        format_version: z.literal(ANALYSIS_ARTIFACT_VERSION),
        result: functionDecompileResultSchema,
      })
      .parse(payload).result;
    if (
      !('data' in stored) ||
      stored.data.delivery !== 'inline' ||
      (stored.state !== 'complete' && stored.state !== 'partial') ||
      (stored.state === 'partial' && stored.reason === 'output_limit') ||
      stored.project_id !== this.projectId ||
      stored.revision !== this.revision ||
      stored.data.function_id !== result.data.function_id ||
      fingerprint(stored.versions) !== fingerprint(result.versions) ||
      fingerprint(stored.options) !== fingerprint(result.options) ||
      fingerprint(stored.budget) !== fingerprint(result.budget)
    )
      invalid('Decompilation artifact does not match its request.');
    return functionDecompileResultSchema.parse({
      ...stored,
      artifacts: result.artifacts,
      data: { ...stored.data, cache: result.data.cache },
    });
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

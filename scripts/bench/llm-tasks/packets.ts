import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { sha256 } from './questions.js';
import type { Question, QuestionSet } from './questions.js';

const run = promisify(execFile);

/**
 * Tool configurations. Each one is exactly the material an LLM would be handed for a function:
 *  mcp-default   `function_decompile` through the real MCP stdio server, default arguments, text blocks as delivered
 *  export-file   `open-decomp export` function file plus its index.tsv row (what an agent reads after grep)
 *  ghidra        archived Ghidra headless decompiler output (only where an archive exists)
 *  disasm        raw `function_get` compact disassembly (the no-decompiler baseline)
 */
export const CONFIGS = ['mcp-default', 'export-file', 'ghidra', 'disasm'] as const;
export type Config = (typeof CONFIGS)[number];

/** Approximate tokens: UTF-8 bytes / 3.6. No tokenizer ships offline in node_modules; the estimator is a constant, not a measurement. */
export const BYTES_PER_TOKEN = 3.6;
export const estimateTokens = (bytes: number): number => Math.ceil(bytes / BYTES_PER_TOKEN);

export interface Material {
  config: Config;
  /** Exactly the delivered text. */
  text: string;
  /** Tool state the material came from (complete/partial/failed/...) or '' when not applicable. */
  state: string;
  /** Provenance for the manifest: calls, files, pages. */
  source: Record<string, unknown>;
}

export interface FunctionKey {
  binary: string;
  address: string;
  function: string;
}
export const functionKey = (item: FunctionKey): string => `${item.binary}:${item.address}`;

export interface RepoInfo {
  repo: string;
  entry: string;
  git_head: string | null;
  git_dirty: boolean | null;
  dist_built: string;
  node: string;
  bun: string | null;
}

async function git(repo: string, ...args: string[]): Promise<string | null> {
  try {
    return (await run('git', ['-C', repo, ...args])).stdout.trim();
  } catch {
    return null;
  }
}

/** Records which checkout produced the packets: `--repo` must hold a built dist/. */
export async function describeRepo(repo: string): Promise<RepoInfo> {
  const entry = join(repo, 'dist', 'src', 'cli', 'entry.js');
  const built = await stat(entry).catch(() => null);
  assert.ok(built !== null, `${entry} is missing: build ${repo} first (bun run build)`);
  const status = await git(repo, 'status', '--porcelain', '--', 'src');
  const bun = await run('bun', ['--version']).then(
    (result) => result.stdout.trim(),
    () => null,
  );
  return {
    repo,
    entry,
    git_head: await git(repo, 'rev-parse', 'HEAD'),
    git_dirty: status === null ? null : status.length > 0,
    dist_built: built.mtime.toISOString(),
    node: process.version,
    bun,
  };
}

type ToolCall = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{
  text: string;
  structured: Record<string, unknown> | undefined;
  isError: boolean;
  blocks: number;
}>;

/** Default text carries `// <state> (<reason>); ...` on its second line; failures are a JSON envelope. */
function decompileState(
  text: string,
  structured: Record<string, unknown> | undefined,
  isError: boolean,
): string {
  const header = /^\/\/ (complete|partial|failed|unsupported|cancelled)\b/m.exec(text);
  if (header !== null) return header[1]!;
  const fromEnvelope = structured?.state ?? /"state":"(\w+)"/.exec(text)?.[1];
  return typeof fromEnvelope === 'string' ? fromEnvelope : isError ? 'error' : 'unknown';
}

/** One MCP stdio server from the given checkout, owned for the whole build. */
export class McpBench {
  readonly #client: Client;
  readonly call: ToolCall;
  readonly #projects = new Map<string, { project_id: string; revision: number; state: string }>();
  readonly #root: string;

  private constructor(client: Client, root: string) {
    this.#client = client;
    this.#root = root;
    this.call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args }, { timeout: 3_600_000 });
      const content = (result.content ?? []) as { type: string; text?: string }[];
      return {
        text: content.map((block) => block.text ?? '').join('\n'),
        structured: result.structuredContent as Record<string, unknown> | undefined,
        isError: result.isError === true,
        blocks: content.length,
      };
    };
  }

  static async start(
    repo: RepoInfo,
    root: string,
    inputRoots: readonly string[],
  ): Promise<McpBench> {
    await mkdir(root, { recursive: true });
    const client = new Client({ name: 'llm-tasks', version: '1' }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        repo.entry,
        'mcp',
        'start',
        '--root',
        root,
        ...inputRoots.flatMap((path) => ['--root', path]),
      ],
      stderr: 'pipe',
      maxBufferSize: 64 * 1024 * 1024,
    });
    await client.connect(transport);
    return new McpBench(client, root);
  }

  async open(binaryId: string, input: string): Promise<{ project_id: string; revision: number }> {
    const known = this.#projects.get(binaryId);
    if (known) return known;
    const opened = await this.call('project_open', {
      source: { kind: 'import', input_path: input, project_path: join(this.#root, binaryId) },
      wait: true,
    });
    const body = opened.structured;
    assert.ok(
      body !== undefined && typeof body.project_id === 'string',
      `project_open ${input}: ${opened.text.slice(0, 300)}`,
    );
    const project = {
      project_id: body.project_id,
      revision: Number(body.revision),
      state: String(body.state),
    };
    this.#projects.set(binaryId, project);
    return project;
  }

  async decompile(binaryId: string, address: string): Promise<Material> {
    const scope = this.#projects.get(binaryId);
    assert.ok(scope, `project ${binaryId} not opened`);
    const result = await this.call('function_decompile', {
      project_id: scope.project_id,
      revision: scope.revision,
      function_id: `va:${address}`,
      wait: true,
    });
    return {
      config: 'mcp-default',
      text: result.text,
      state: decompileState(result.text, result.structured, result.isError),
      source: {
        tool: 'function_decompile',
        arguments: { function_id: `va:${address}`, wait: true },
        content_blocks: result.blocks,
        is_error: result.isError,
      },
    };
  }

  /** Compact disassembly pages exactly as published, following next_cursor until the function is complete. */
  async disassemble(binaryId: string, address: string): Promise<Material> {
    const scope = this.#projects.get(binaryId);
    assert.ok(scope, `project ${binaryId} not opened`);
    const pages: string[] = [];
    let cursor: string | undefined;
    let state = 'complete';
    do {
      const result = await this.call('function_get', {
        project_id: scope.project_id,
        revision: scope.revision,
        function_id: `va:${address}`,
        view: 'disassembly',
        detail: 'compact',
        ...(cursor === undefined ? {} : { page: { cursor } }),
      });
      pages.push(result.text);
      const data = result.structured?.data as
        { page?: { next_cursor?: string | null } } | undefined;
      state = String(result.structured?.state ?? state);
      cursor = data?.page?.next_cursor ?? undefined;
      assert.ok(pages.length <= 200, 'Disassembly pagination did not terminate');
    } while (cursor !== undefined);
    return {
      config: 'disasm',
      text: pages.join('\n'),
      state,
      source: {
        tool: 'function_get',
        arguments: { function_id: `va:${address}`, view: 'disassembly', detail: 'compact' },
        pages: pages.length,
      },
    };
  }

  async close(): Promise<void> {
    await this.#client.close();
  }
}

export interface ExportedFunction {
  /** Function file, verbatim. */
  text: string;
  file: string;
  /** index.tsv header plus the function's row. */
  indexRows: string;
  state: string;
}

/**
 * `open-decomp export BINARY --name NAME` into `out`, then selects the file for `address`.
 * The name filter is a substring match, so neighbouring functions are exported too; only the
 * requested function's file and index row are delivered.
 */
export async function exportFunction(
  repo: RepoInfo,
  binary: string,
  cache: string,
  out: string,
  functionName: string,
  address: string,
): Promise<ExportedFunction> {
  await run(
    process.execPath,
    [
      repo.entry,
      'export',
      binary,
      '--out',
      out,
      '--cache',
      cache,
      '--jobs',
      '1',
      '--name',
      functionName,
    ],
    { maxBuffer: 64 * 1024 * 1024, timeout: 3_600_000 },
  );
  const suffix = `@${address}`;
  const files = (await readdir(join(out, 'functions'))).filter((name) =>
    new RegExp(`${suffix.replace(/[^\w@]/g, '\\$&')}(~\\d+)?\\.(c|py|asm)$`).test(name),
  );
  assert.equal(
    files.length,
    1,
    `export of ${functionName}: expected one file for ${address}, got ${files.join(',')}`,
  );
  const file = files[0]!;
  const index = (await readFile(join(out, 'index.tsv'), 'utf8')).split('\n');
  const row = index.find((line) => line.startsWith(`${address}\t`));
  assert.ok(row !== undefined, `export of ${functionName}: no index.tsv row for ${address}`);
  const columns = row.split('\t');
  return {
    text: await readFile(join(out, 'functions', file), 'utf8'),
    file,
    indexRows: `${index[0]}\n${row}\n`,
    state: columns[3] ?? '',
  };
}

/** Export packet text: the header row of the index, the function's row, then the function file as it sits on disk. */
export function exportMaterial(exported: ExportedFunction): Material {
  return {
    config: 'export-file',
    text: `# index.tsv\n${exported.indexRows}\n# functions/${exported.file}\n${exported.text}`,
    state: exported.state,
    source: { tool: 'open-decomp export', file: `functions/${exported.file}`, index_row: true },
  };
}

/** Archived Ghidra decompiler output, byte-exact file contents. */
export async function ghidraMaterial(
  ghidraDir: string,
  question: Pick<Question, 'function'>,
): Promise<Material | null> {
  const path = join(ghidraDir, `${question.function}.c`);
  const bytes = await readFile(path).catch(() => null);
  if (bytes === null) return null;
  return {
    config: 'ghidra',
    text: bytes.toString('utf8'),
    state: 'archived',
    source: { tool: 'ghidra', file: path, sha256: sha256(bytes) },
  };
}

/** The prompt wrapped around each question. The material is appended verbatim after the divider. */
export function promptFor(set: QuestionSet, question: Question): string {
  const binary = set.binaries[question.binary]!;
  return [
    'You are reverse engineering a compiled native binary. You are given tool output for ONE function and a question about it.',
    '',
    'Rules:',
    '- Answer only from the provided material. Do not use outside knowledge of the program, its source code or its documentation.',
    '- If the material does not let you determine the answer, answer exactly: unknown',
    '- Give a short answer in the requested format. No explanation unless the format asks for one.',
    '',
    `Binary: ${binary.file}`,
    `Function: ${question.function} at ${question.address}`,
    '',
    `Question: ${question.question}`,
    `Answer format: ${question.answer_format}`,
    '',
    '----- BEGIN MATERIAL -----',
  ].join('\n');
}

export const MATERIAL_END = '----- END MATERIAL -----';

export function packetText(set: QuestionSet, question: Question, material: Material): string {
  return `${promptFor(set, question)}\n${material.text.replace(/\n*$/, '\n')}${MATERIAL_END}\n\nAnswer:\n`;
}

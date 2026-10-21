/** Judge model backends (`omp`, `anthropic`, `cmd`), JSON extraction, retries and a bounded pool. */
import { spawn } from 'node:child_process';
import { z } from 'zod';

export const DEFAULT_MODEL = 'anthropic/claude-haiku-5-5';
/** Per-call wall-clock limit. */
export const CALL_TIMEOUT_MS = 180_000;
/** Backoff before the 2nd and the 3rd attempt. */
export const RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000];

export type BackendName = 'omp' | 'anthropic' | 'cmd';

export interface AskRequest {
  readonly system: string;
  readonly user: string;
  /** e.g. `anthropic/claude-haiku-5-5`. */
  readonly model: string;
}

export interface AskReply {
  readonly text: string;
  /** Prompt tokens (cache reads and writes included) and output tokens; null when the backend reports none. */
  readonly usage: { readonly input: number; readonly output: number } | null;
  /** USD; null when the backend reports none. */
  readonly cost: number | null;
  readonly model: string;
}

export interface Backend {
  readonly name: BackendName;
  ask(request: AskRequest): Promise<AskReply>;
  /** Prompt-size measurement without generating (`anthropic` only); the reply has empty text. */
  countInput?(request: AskRequest): Promise<AskReply>;
}

/** `anthropic` iff ANTHROPIC_API_KEY is set, else `omp`. */
export function defaultBackend(): 'omp' | 'anthropic' {
  return process.env['ANTHROPIC_API_KEY'] ? 'anthropic' : 'omp';
}

export function createBackend(name: BackendName, command?: string): Backend {
  switch (name) {
    case 'omp':
      return ompBackend();
    case 'anthropic':
      return anthropicBackend();
    case 'cmd':
      if (!command) throw new Error('judge backend cmd needs a command (--command)');
      return cmdBackend(command);
  }
}

// ---------------------------------------------------------------------------------------------
// shared helpers

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A balanced `{...}` of the reply that parses as JSON (string literals are skipped while matching
 * braces); prose or a code fence around it is ignored. With `accept`, the first candidate it
 * accepts wins (a reply may quote another object before its answer); otherwise, and when no
 * candidate is accepted, the first that parses. Null when none parses. Parsing tolerates what
 * models emit inside strings: invalid escapes such as `'\0'` and raw control characters.
 */
export function extractJson(text: string, accept?: (value: unknown) => boolean): unknown {
  let first: unknown = null;
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = balancedEnd(text, start);
    if (end === -1) continue;
    const value = parseLenient(text.slice(start, end + 1));
    if (value === undefined) continue; // not JSON (e.g. a brace in prose): try the next opening brace
    if (!accept || accept(value)) return value;
    first ??= value;
  }
  return first;
}

function parseLenient(candidate: string): unknown {
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    try {
      return JSON.parse(repairJson(candidate)) as unknown;
    } catch {
      return undefined;
    }
  }
}

/**
 * Repairs the slips models make in long JSON replies. Inside string literals: escapes control
 * characters and doubles backslashes that start no JSON escape (`'\0'`). Outside them: drops a
 * closing bracket that closes nothing open (`"…"]], "coverage": 2}`) and stray parentheses.
 */
function repairJson(text: string): string {
  let out = '';
  let inString = false;
  const open: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!inString) {
      if (ch === '{' || ch === '[') open.push(ch === '{' ? '}' : ']');
      else if (ch === '}' || ch === ']') {
        if (open[open.length - 1] !== ch) continue;
        open.pop();
      } else if (ch === '(' || ch === ')') continue;
      else if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === '\\') {
      const next = text[i + 1] ?? '';
      if (
        '"\\/bfnrt'.includes(next) ||
        (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6)))
      ) {
        out += ch + next;
        i++;
      } else out += '\\\\';
    } else if (ch === '"') {
      inString = false;
      out += ch;
    } else if (ch.charCodeAt(0) < 0x20)
      out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out;
}

function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Runs `attempt` up to `delays.length + 1` times; sleeps `delays[i]` ms before retry i. Throws the last error. */
export async function withRetries<T>(
  attempt: (n: number) => Promise<T>,
  delays: readonly number[] = RETRY_DELAYS_MS,
  onRetry?: (error: unknown, n: number) => void,
): Promise<T> {
  for (let n = 0; ; n++) {
    try {
      return await attempt(n);
    } catch (error) {
      const delay = delays[n];
      if (delay === undefined) throw error;
      onRetry?.(error, n);
      await sleep(delay);
    }
  }
}

/** Runs `worker` over `items` with at most `concurrency` in flight; rejects on the first worker error. */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, lane));
}

interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
}

function runProcess(file: string, args: readonly string[], stdin: string): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${file}: timed out after ${CALL_TIMEOUT_MS / 1000}s`));
    }, CALL_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      };
      if (code === 0) resolve(result);
      else {
        const how = code === null ? `signal ${String(signal)}` : `code ${code}`;
        const tail = (result.stderr.trim() || result.stdout.trim()).slice(-500);
        reject(new Error(`${file} exited with ${how}: ${tail}`));
      }
    });
    child.stdin.on('error', () => {
      // the child may exit before reading stdin; the close handler reports the real failure
    });
    child.stdin.end(stdin);
  });
}

// ---------------------------------------------------------------------------------------------
// omp

const OmpEvent = z.object({ type: z.string(), message: z.unknown().optional() });
const OmpMessage = z.object({
  role: z.string(),
  content: z.array(z.object({ text: z.string().optional() })).default([]),
  model: z.string().default(''),
  stopReason: z.string().optional(),
  errorMessage: z.string().optional(),
  usage: z
    .object({
      input: z.number().default(0),
      output: z.number().default(0),
      cacheRead: z.number().default(0),
      cacheWrite: z.number().default(0),
      cost: z.object({ total: z.number().optional() }).optional(),
    })
    .optional(),
});

/** The last assistant `message_end` of an `omp -p --mode json` JSONL stream. */
export function parseOmpOutput(stdout: string): AskReply {
  let message: z.output<typeof OmpMessage> | null = null;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const event = OmpEvent.safeParse(json);
    if (!event.success || event.data.type !== 'message_end') continue;
    const parsed = OmpMessage.safeParse(event.data.message);
    if (parsed.success && parsed.data.role === 'assistant') message = parsed.data;
  }
  if (!message) throw new Error('omp: no assistant message in the output');
  if (message.stopReason !== 'stop' && message.stopReason !== 'end_turn') {
    const detail = message.errorMessage ? `: ${message.errorMessage}` : '';
    throw new Error(`omp: stopReason ${String(message.stopReason)}${detail}`);
  }
  const { usage } = message;
  return {
    text: message.content.map((part) => part.text ?? '').join(''),
    usage: usage
      ? { input: usage.input + usage.cacheRead + usage.cacheWrite, output: usage.output }
      : null,
    cost: usage?.cost?.total ?? null,
    model: message.model,
  };
}

function ompBackend(): Backend {
  return {
    name: 'omp',
    async ask({ system, user, model }) {
      const args = [
        '-p',
        '--mode',
        'json',
        '--model',
        model,
        '--no-tools',
        '--no-session',
        '--no-skills',
        '--no-rules',
        '--no-extensions',
        '--no-lsp',
        '--no-title',
        '--thinking',
        'off',
        '--system-prompt',
        system,
      ];
      const { stdout } = await runProcess(process.env['OMP_BIN'] || 'omp', args, user);
      return parseOmpOutput(stdout);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// anthropic

const AnthropicMessage = z.object({
  content: z.array(z.object({ text: z.string().optional() })).default([]),
  stop_reason: z.string().nullable().optional(),
  model: z.string().optional(),
  usage: z
    .object({
      input_tokens: z.number().default(0),
      output_tokens: z.number().default(0),
      cache_read_input_tokens: z.number().nullish(),
      cache_creation_input_tokens: z.number().nullish(),
    })
    .optional(),
});
const AnthropicCount = z.object({ input_tokens: z.number() });

function anthropicBackend(): Backend {
  const post = async <T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> => {
    const key = process.env['ANTHROPIC_API_KEY'];
    if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
    const response = await fetch(`https://api.anthropic.com${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const raw = await response.text();
    if (!response.ok)
      throw new Error(`anthropic ${path}: HTTP ${response.status}: ${raw.slice(0, 500)}`);
    return schema.parse(JSON.parse(raw));
  };
  const request = ({ system, user, model }: AskRequest) => ({
    model: model.replace(/^anthropic\//, ''),
    system,
    messages: [{ role: 'user', content: user }],
  });
  return {
    name: 'anthropic',
    async ask(req) {
      const reply = await post(
        '/v1/messages',
        { ...request(req), max_tokens: 1024 },
        AnthropicMessage,
      );
      if (reply.stop_reason !== 'end_turn' && reply.stop_reason !== 'stop_sequence')
        throw new Error(`anthropic: stop_reason ${String(reply.stop_reason)}`);
      const { usage } = reply;
      return {
        text: reply.content.map((part) => part.text ?? '').join(''),
        usage: usage
          ? {
              input:
                usage.input_tokens +
                (usage.cache_read_input_tokens ?? 0) +
                (usage.cache_creation_input_tokens ?? 0),
              output: usage.output_tokens,
            }
          : null,
        cost: null,
        model: reply.model ?? req.model,
      };
    },
    async countInput(req) {
      const reply = await post('/v1/messages/count_tokens', request(req), AnthropicCount);
      return {
        text: '',
        usage: { input: reply.input_tokens, output: 0 },
        cost: null,
        model: req.model,
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// cmd

function cmdBackend(command: string): Backend {
  return {
    name: 'cmd',
    async ask({ system, user, model }) {
      const { stdout } = await runProcess('sh', ['-c', command], `${system}\n\n${user}`);
      return { text: stdout, usage: null, cost: null, model };
    },
  };
}

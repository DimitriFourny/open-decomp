/** Judge call cache: `<bench dir>/judge/cache/<k0k1>/<key>.json`, one file per distinct model call. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths, sha256 } from '../types.js';
import type { TaskName } from '../types.js';

/** Part of every cache key, beside the exact system and user texts: bump it when reply handling changes. */
export const PROMPT_VERSION = 'odbench-prompts/1';

export interface JudgeRecord {
  readonly key: string;
  readonly task: TaskName;
  readonly model: string;
  readonly sample: number;
  readonly system_sha256: string;
  readonly user_sha256: string;
  /** The reply text as the backend returned it. */
  readonly text: string;
  /** The JSON object extracted from the reply; null for tasks whose reply is plain text. */
  readonly parsed: unknown;
  readonly usage: { readonly input: number; readonly output: number } | null;
  readonly cost: number | null;
  /** Model name the backend reported (e.g. `claude-haiku-5-5`). */
  readonly reply_model: string;
  readonly created: string;
}

export function cacheKey(
  task: TaskName,
  model: string,
  system: string,
  user: string,
  sample: number,
): string {
  return sha256(JSON.stringify([PROMPT_VERSION, task, model, system, user, sample]));
}

export function recordPath(key: string): string {
  return join(paths.judgeCache(), key.slice(0, 2), `${key}.json`);
}

/** The cached call, or null on a miss. */
export async function readRecord(key: string): Promise<JudgeRecord | null> {
  let raw: string;
  try {
    raw = await readFile(recordPath(key), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const record = JSON.parse(raw) as JudgeRecord;
  if (record.key !== key)
    throw new Error(`judge cache: ${recordPath(key)} holds key ${record.key}`);
  return record;
}

/** Atomic (temp file + rename), safe against concurrent runs writing the same key. */
export async function writeRecord(record: JudgeRecord): Promise<void> {
  const target = recordPath(record.key);
  await mkdir(join(target, '..'), { recursive: true });
  const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`);
  await rename(temp, target);
}

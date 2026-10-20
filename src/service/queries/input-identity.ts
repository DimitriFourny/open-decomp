import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { OperationError } from '../../core/index.js';

function invalid(message: string): never {
  throw new OperationError({ code: 'invalid_input', severity: 'error', message, evidence_ids: [] });
}

/** Name of one project directory under a cache root: content hash plus the selected slice. The
 * CLI, the API and MCP's `cache_root` default share it, so they open the same projects. */
export function projectDirectoryName(sha256: string, sliceId: string | undefined): string {
  return `${sha256}.${sliceId ?? 'default'}`;
}

/** Hash bounded chunks rather than retaining another complete image in the host. */
export async function hashInput(path: string, signal?: AbortSignal): Promise<string> {
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

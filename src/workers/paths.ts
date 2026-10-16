import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { OperationError, type Diagnostic } from '../core/index.js';

function failure(code: Diagnostic['code'], message: string): OperationError {
  return new OperationError({ code, severity: 'error', message, evidence_ids: [] });
}

/** Canonical paths only. Shared by host configuration and worker admission. */
export function containsPath(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

/** Resolve existing paths, or one new leaf under an existing canonical parent. */
export async function authorizePath(roots: readonly string[], path: string, create = false): Promise<string> {
  const requested = resolve(path);
  let canonical: string;
  try {
    try { canonical = await realpath(requested); }
    catch (error) {
      if (!create || !(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      canonical = resolve(await realpath(dirname(requested)), basename(requested));
    }
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') throw failure('not_found', 'Requested path or its parent does not exist');
    if (code === 'EACCES' || code === 'EPERM') throw failure('permission_denied', 'Requested path is not accessible');
    if (code === 'ENOTDIR' || code === 'ELOOP') throw failure('invalid_input', 'Requested path has an invalid directory or symlink chain');
    throw error;
  }
  if (!roots.some(root => containsPath(root, canonical))) throw failure('permission_denied', 'Path is outside host-authorized roots');
  return canonical;
}

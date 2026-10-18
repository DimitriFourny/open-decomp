import { spawnSync } from 'node:child_process';
import { evidencePath, MissingEvidenceError } from '../../scripts/bench/evidence.js';

/** Absolute compiler path used by every native source oracle (never the target under analysis). */
export const CLANG = '/usr/bin/clang';

const probe = (command: string): boolean => {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 15_000 });
  return result.error === undefined && result.status === 0;
};

let clang: boolean | undefined;
let python: boolean | undefined;

/** True when `/usr/bin/clang` runs (the macOS shim exists even without the Command Line Tools). */
export const hasClang = (): boolean => (clang ??= probe(CLANG));
/** True when `python3` on PATH runs. */
export const hasPython3 = (): boolean => (python ??= probe('python3'));

const nativeHost = process.platform === 'darwin' && process.arch === 'arm64';

/**
 * `node:test` `skip` value for tests that compile and run a trusted source oracle natively.
 * They are mandatory on darwin-arm64 whenever clang is present; otherwise the reason is explicit.
 */
export function nativeOracleSkip(): string | false {
  if (!nativeHost) return 'native source oracles are built and run only on darwin-arm64';
  if (!hasClang())
    return `${CLANG} is unavailable or not runnable (install Xcode Command Line Tools)`;
  return false;
}

/** As `nativeOracleSkip`, additionally requiring `python3` for the python-like dialect evaluator. */
export function nativeAndPythonOracleSkip(): string | false {
  const native = nativeOracleSkip();
  if (native) return native;
  if (!hasPython3()) return 'python3 is unavailable or not runnable';
  return false;
}

/** Optional retained evidence skips only when absent; corrupt evidence remains a failure. */
export function evidenceArchiveSkip(repoRelativePath: string): string | false {
  try {
    evidencePath(repoRelativePath);
    return false;
  } catch (error) {
    if (error instanceof MissingEvidenceError) return error.message;
    throw error;
  }
}

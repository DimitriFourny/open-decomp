import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Default reviewed function selection, committed beside the benchmark drivers. */
export const DEFAULT_CONTRACT = fileURLToPath(new URL('./selected-contract.json', import.meta.url));
/** Environment fallback for `--inputs DIR`. */
export const INPUTS_ENV = 'OPEN_DECOMP_BENCH_INPUTS';

export interface ContractBinary {
  /** Absolute path, resolved against the inputs directory when the contract entry is relative. */
  path: string;
  name: string;
  functions: string[];
}

export interface SelectedContract {
  contractPath: string;
  binaries: ContractBinary[];
}

/**
 * Loads the selected-function contract. `--contract` defaults to the committed
 * `selected-contract.json`; relative binary paths resolve against `--inputs DIR`
 * (or `$OPEN_DECOMP_BENCH_INPUTS`), absolute paths are used as written.
 */
export async function loadSelectedContract(
  flags: ReadonlyMap<string, string>,
): Promise<SelectedContract> {
  const contractPath = resolve(flags.get('--contract') ?? DEFAULT_CONTRACT);
  const raw = JSON.parse(await readFile(contractPath, 'utf8')) as {
    binaries: { path: string; functions: string[] }[];
  };
  const inputs = flags.get('--inputs') ?? process.env[INPUTS_ENV];
  const binaries = raw.binaries.map((entry) => {
    if (!isAbsolute(entry.path))
      assert.ok(
        inputs,
        `Contract binary ${entry.path} is relative: pass --inputs DIR or set ${INPUTS_ENV}`,
      );
    return {
      path: isAbsolute(entry.path) ? entry.path : resolve(inputs!, entry.path),
      name: basename(entry.path),
      functions: entry.functions,
    };
  });
  return { contractPath, binaries };
}

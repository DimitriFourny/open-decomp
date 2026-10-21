/** Frozen corpus (`corpus.json`): loading, tier selection and input paths. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CORPUS_PATH, paths, sha256 } from './types.js';
import type { Corpus, CorpusBinary, CorpusFunction, CorpusSource, Tier } from './types.js';

export async function loadCorpus(path = CORPUS_PATH): Promise<Corpus> {
  const corpus = JSON.parse(await readFile(path, 'utf8')) as Corpus;
  if (corpus.schema !== 'odbench-corpus/1') throw new Error(`${path}: unknown corpus schema`);
  const binaries = new Set(corpus.binaries.map((binary) => binary.id));
  const sources = new Set(corpus.sources.map((source) => source.id));
  const ids = new Set<string>();
  for (const fn of corpus.functions) {
    if (ids.has(fn.id)) throw new Error(`corpus: duplicate function ${fn.id}`);
    ids.add(fn.id);
    if (!binaries.has(fn.binary))
      throw new Error(`corpus: ${fn.id} names unknown binary ${fn.binary}`);
    if (fn.source && !sources.has(fn.source.file))
      throw new Error(`corpus: ${fn.id} names unknown source ${fn.source.file}`);
    if (!fn.tiers.includes('full')) throw new Error(`corpus: ${fn.id} is not in the full tier`);
  }
  return corpus;
}

/** sha256 of corpus.json bytes: lanes record it so mixed-corpus comparisons are refused. */
export async function corpusSha256(path = CORPUS_PATH): Promise<string> {
  return sha256(await readFile(path));
}

export function tierFunctions(corpus: Corpus, tier: Tier): CorpusFunction[] {
  return corpus.functions.filter((fn) => fn.tiers.includes(tier));
}

export function corpusBinary(corpus: Corpus, id: string): CorpusBinary {
  const binary = corpus.binaries.find((candidate) => candidate.id === id);
  if (!binary) throw new Error(`corpus: unknown binary ${id}`);
  return binary;
}

export function binaryPath(binary: CorpusBinary): string {
  return join(paths.inputs(), binary.path);
}

export function sourcePath(source: CorpusSource): string {
  return join(paths.sources(), source.path);
}

export interface InputCheck {
  readonly kind: 'binary' | 'source';
  readonly id: string;
  readonly path: string;
  readonly status: 'ok' | 'missing' | 'mismatch';
  readonly origin: string;
  readonly url?: string;
}

/** Hashes every corpus binary and source file in the data store against the corpus records. */
export async function verifyInputs(corpus: Corpus): Promise<InputCheck[]> {
  const entries = [
    ...corpus.binaries.map((binary) => ({
      kind: 'binary' as const,
      record: binary,
      path: binaryPath(binary),
    })),
    ...corpus.sources.map((source) => ({
      kind: 'source' as const,
      record: source,
      path: sourcePath(source),
    })),
  ];
  return Promise.all(
    entries.map(async ({ kind, record, path }): Promise<InputCheck> => {
      let status: InputCheck['status'];
      try {
        status = sha256(await readFile(path)) === record.sha256 ? 'ok' : 'mismatch';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        status = 'missing';
      }
      const url = 'url' in record ? record.url : undefined;
      return {
        kind,
        id: record.id,
        path,
        status,
        origin: record.origin,
        ...(url === undefined ? {} : { url }),
      };
    }),
  );
}

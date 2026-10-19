import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const QUESTIONS_PATH = fileURLToPath(new URL('./questions.json', import.meta.url));
/** Environment fallback for `--inputs DIR` (shared with the other bench drivers). */
export const INPUTS_ENV = 'OPEN_DECOMP_BENCH_INPUTS';

export type Scoring =
  | { type: 'exact'; accept: string[] }
  | { type: 'numeric'; value: number }
  | { type: 'set'; items: string[]; ordered?: boolean }
  | { type: 'regex'; pattern: string; flags?: string; forbid?: string }
  | {
      type: 'rubric';
      facts: { id: string; pattern: string; flags?: string }[];
      forbid?: string[];
    };

export interface Question {
  id: string;
  binary: string;
  function: string;
  address: string;
  kind: string;
  question: string;
  answer_format: string;
  gold: string;
  gold_note?: string;
  scoring: Scoring;
  source: { file: string; lines: [number, number]; anchor: string };
  ghidra_archived?: boolean;
}

export interface BinarySpec {
  file: string;
  sha256: string;
  description: string;
  source: string;
}
export interface SourceSpec {
  sha256: string;
  origin: string;
  url?: string;
}
export interface QuestionSet {
  schema: 1;
  name: string;
  frozen: string;
  method: string;
  disclosure: string;
  binaries: Record<string, BinarySpec>;
  sources: Record<string, SourceSpec>;
  build_config: Record<string, string>;
  questions: Question[];
}

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Loads and structurally validates the question set (unique ids, compilable rules, known binaries). */
export async function loadQuestions(path = QUESTIONS_PATH): Promise<QuestionSet> {
  const set = JSON.parse(await readFile(path, 'utf8')) as QuestionSet;
  assert.equal(set.schema, 1, 'Unsupported question schema');
  const seen = new Set<string>();
  for (const question of set.questions) {
    assert.ok(!seen.has(question.id), `Duplicate question id ${question.id}`);
    seen.add(question.id);
    assert.ok(set.binaries[question.binary], `${question.id}: unknown binary ${question.binary}`);
    assert.ok(set.sources[question.source.file], `${question.id}: unknown source file`);
    assert.match(
      question.address,
      /^0x[0-9a-f]+$/,
      `${question.id}: address must be lowercase hex`,
    );
    const scoring = question.scoring;
    if (scoring.type === 'regex') {
      new RegExp(scoring.pattern, scoring.flags ?? 'i');
      if (scoring.forbid !== undefined) new RegExp(scoring.forbid, scoring.flags ?? 'i');
    } else if (scoring.type === 'rubric') {
      assert.ok(scoring.facts.length > 0, `${question.id}: rubric needs facts`);
      for (const fact of scoring.facts) new RegExp(fact.pattern, fact.flags ?? 'i');
      for (const pattern of scoring.forbid ?? []) new RegExp(pattern, 'i');
    } else if (scoring.type === 'set') {
      assert.ok(scoring.items.length > 0, `${question.id}: set needs items`);
    } else if (scoring.type === 'exact') {
      assert.ok(scoring.accept.length > 0, `${question.id}: exact needs accepted answers`);
    }
  }
  return set;
}

export interface InputPaths {
  readonly binaries: Record<string, string>;
  readonly sources: Record<string, string>;
}

/**
 * Resolves each binary (`--inputs DIR` / $OPEN_DECOMP_BENCH_INPUTS, by file name) and each source
 * file (`--sources DIR`, by name), verifying the frozen SHA-256 of every file that exists.
 */
export async function resolveInputs(
  set: QuestionSet,
  inputsDir: string | undefined,
  sourcesDir: string | undefined,
  needed: { binaries: ReadonlySet<string>; sources: ReadonlySet<string> },
): Promise<InputPaths> {
  const binaries: Record<string, string> = {};
  for (const id of needed.binaries) {
    const spec = set.binaries[id]!;
    assert.ok(inputsDir, `Binary ${spec.file} needs --inputs DIR or $${INPUTS_ENV}`);
    const path = isAbsolute(spec.file) ? spec.file : resolve(inputsDir, spec.file);
    const digest = sha256(await readFile(path));
    assert.equal(digest, spec.sha256, `${path}: SHA-256 ${digest} differs from the frozen pin`);
    binaries[id] = path;
  }
  const sources: Record<string, string> = {};
  for (const name of needed.sources) {
    assert.ok(sourcesDir, `Source ${name} needs --sources DIR`);
    const path = join(resolve(sourcesDir), name);
    const digest = sha256(await readFile(path));
    assert.equal(digest, set.sources[name]!.sha256, `${path}: SHA-256 ${digest} differs from pin`);
    sources[name] = path;
  }
  return { binaries, sources };
}

/** Source spans must exist and contain their anchor text: a guard against editing the source or the spans. */
export function verifySpans(
  set: QuestionSet,
  sourceText: ReadonlyMap<string, string>,
): { id: string; ok: boolean; reason: string }[] {
  const lines = new Map<string, string[]>();
  for (const [name, text] of sourceText) lines.set(name, text.split('\n'));
  return set.questions.map((question) => {
    const file = lines.get(question.source.file);
    if (file === undefined) return { id: question.id, ok: false, reason: 'source not loaded' };
    const [first, last] = question.source.lines;
    if (first < 1 || last < first || last > file.length)
      return { id: question.id, ok: false, reason: `span ${first}-${last} outside file` };
    const span = file.slice(first - 1, last).join('\n');
    return span.includes(question.source.anchor)
      ? { id: question.id, ok: true, reason: '' }
      : { id: question.id, ok: false, reason: `anchor not in lines ${first}-${last}` };
  });
}

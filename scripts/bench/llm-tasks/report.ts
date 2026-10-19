import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scoreAnswer, summarize } from './score.js';
import type { ConfigSummary, Row } from './score.js';
import type { Question } from './questions.js';

export interface ManifestPacket {
  id: string;
  config: string;
  file: string;
  material_bytes: number;
  material_tokens: number;
  material_sha256: string;
  packet_bytes: number;
  state: string;
}

export interface ScoreReport {
  schema: 1;
  packets_manifest: string;
  answers: string;
  estimator: string;
  configs: ConfigSummary[];
  /** Same metrics restricted to questions every config has a packet for. */
  common: { questions: string[]; configs: ConfigSummary[] };
  rows: (Omit<Row, 'verdict'> & { outcome: string; detail: string; facts_hit?: string[] })[];
}

/** Reads `DIR/<config>/<id>.json` ({"answer": "..."}) or `.txt` (the whole file is the answer). */
export async function readAnswer(
  dir: string,
  config: string,
  id: string,
): Promise<string | undefined> {
  const json = await readFile(join(dir, config, `${id}.json`), 'utf8').catch(() => null);
  if (json !== null) {
    const parsed = JSON.parse(json) as { answer?: unknown };
    if (typeof parsed.answer !== 'string')
      throw new Error(`${config}/${id}.json has no string "answer"`);
    return parsed.answer;
  }
  return readFile(join(dir, config, `${id}.txt`), 'utf8').catch(() => undefined);
}

export function buildScoreReport(
  questions: readonly Question[],
  packets: readonly ManifestPacket[],
  answers: ReadonlyMap<string, string | undefined>,
  meta: Pick<ScoreReport, 'packets_manifest' | 'answers' | 'estimator'>,
): { report: ScoreReport; rows: Row[] } {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const rows: Row[] = packets.map((packet) => ({
    id: packet.id,
    config: packet.config,
    answer: answers.get(`${packet.config}/${packet.id}`),
    verdict: scoreAnswer(byId.get(packet.id)!, answers.get(`${packet.config}/${packet.id}`)),
    material_tokens: packet.material_tokens,
    material_bytes: packet.material_bytes,
  }));
  const configs = [...new Set(rows.map((row) => row.config))];
  const summaries = (subset: readonly Row[]): ConfigSummary[] =>
    configs.map((config) =>
      summarize(
        config,
        subset.filter((row) => row.config === config),
      ),
    );
  const ids = [...new Set(rows.map((row) => row.id))];
  const common = ids.filter((id) =>
    configs.every((config) => rows.some((row) => row.id === id && row.config === config)),
  );
  const commonRows = rows.filter((row) => common.includes(row.id));
  return {
    rows,
    report: {
      schema: 1,
      ...meta,
      configs: summaries(rows),
      common: { questions: common, configs: summaries(commonRows) },
      rows: rows.map(({ verdict, ...rest }) => ({
        ...rest,
        outcome: verdict.outcome,
        detail: verdict.detail,
        ...(verdict.facts === undefined ? {} : { facts_hit: verdict.facts.hit }),
      })),
    },
  };
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const cell = (value: string): string => value.replaceAll('|', '\\|').replace(/\s+/g, ' ');

function summaryTable(summaries: readonly ConfigSummary[]): string[] {
  return [
    '| config | questions | correct | unknown | wrong | missing | accuracy | unknown rate | wrong rate | material tokens | tokens / correct |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...summaries.map(
      (item) =>
        `| ${item.config} | ${item.questions} | ${item.correct} | ${item.unknown} | ${item.wrong} | ${item.missing} | ${pct(item.accuracy)} | ${pct(item.unknown_rate)} | ${pct(item.wrong_rate)} | ${item.material_tokens} | ${item.tokens_per_correct === null ? 'n/a' : item.tokens_per_correct.toFixed(0)} |`,
    ),
  ];
}

export function markdownReport(
  report: ScoreReport,
  rows: readonly Row[],
  questions: readonly Question[],
): string {
  const configs = report.configs.map((item) => item.config);
  const byId = new Map(questions.map((question) => [question.id, question]));
  const ids = [...new Set(rows.map((row) => row.id))];
  const lines = [
    '# LLM task success per token',
    '',
    `Packets: \`${report.packets_manifest}\`; answers: \`${report.answers}\`. Tokens: ${report.estimator}.`,
    '',
    "`wrong` counts confident wrong answers; `unknown` abstentions are reported separately and are not wrong. `missing` = no answer collected. Rates are over the config's own question count.",
    '',
    '## All questions with a packet, per config',
    '',
    ...summaryTable(report.configs),
    '',
    `## Common subset (${report.common.questions.length} questions every config has a packet for)`,
    '',
    ...summaryTable(report.common.configs),
    '',
    '## Per question',
    '',
    `| question | kind | gold | ${configs.map((config) => `${config} (outcome, tokens)`).join(' | ')} |`,
    `| --- | --- | --- | ${configs.map(() => '---').join(' | ')} |`,
  ];
  for (const id of ids) {
    const question = byId.get(id)!;
    const cells = configs.map((config) => {
      const row = rows.find((item) => item.id === id && item.config === config);
      return row === undefined ? '—' : `${row.verdict.outcome}, ${row.material_tokens}`;
    });
    lines.push(`| ${id} | ${question.kind} | ${cell(question.gold)} | ${cells.join(' | ')} |`);
  }
  const wrong = rows.filter((row) => row.verdict.outcome === 'wrong');
  lines.push('', '## Confidently wrong answers', '');
  if (wrong.length === 0) lines.push('None.');
  else
    for (const row of wrong)
      lines.push(
        `- \`${row.config}\` / \`${row.id}\`: answered "${cell(row.answer ?? '')}" (${cell(row.verdict.detail)}); gold: ${cell(byId.get(row.id)!.gold)}`,
      );
  return `${lines.join('\n')}\n`;
}

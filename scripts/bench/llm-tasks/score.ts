import type { Question, Scoring } from './questions.js';

export type Outcome = 'correct' | 'unknown' | 'wrong' | 'missing';

export interface Verdict {
  outcome: Outcome;
  /** Rubric facts matched / total, when the rule is a rubric. */
  facts?: { hit: string[]; missed: string[] };
  detail: string;
}

/** `unknown` (alone, possibly with punctuation or a short trailing reason) is an abstention, not an answer. */
const UNKNOWN = /^\W*(unknown|cannot be determined|not determinable|can't determine)\b/i;
export const isUnknown = (answer: string): boolean => UNKNOWN.test(answer.trim());

const NUMBER = /-?(?:0x[0-9a-f]+|\d[\d,]*(?:\.\d+)?)/i;

function toNumber(token: string): number {
  const negative = token.startsWith('-');
  const body = negative ? token.slice(1) : token;
  const value = /^0x/i.test(body) ? Number.parseInt(body, 16) : Number(body.replaceAll(',', ''));
  return negative ? -value : value;
}

/** First number in the answer (decimal, 0x hex, optional sign, thousands commas). */
export function firstNumber(answer: string): number | null {
  const match = NUMBER.exec(answer);
  return match === null ? null : toNumber(match[0]);
}

const STOPWORDS = new Set([
  'and',
  'or',
  'then',
  'the',
  'a',
  'in',
  'order',
  'calls',
  'call',
  'argv',
]);

/** Parenthesised remarks are commentary; whatever remains is split into canonical items. */
export function setItems(answer: string, numeric: boolean): string[] {
  const bare = answer.replace(/\([^)]*\)/g, ' ');
  if (numeric)
    return [...bare.matchAll(/-?0x[0-9a-f]+|-?\d+/gi)].map((match) => String(toNumber(match[0])));
  return [...bare.matchAll(/[A-Za-z_][A-Za-z0-9_]*|\d+/g)]
    .map((match) => match[0].toLowerCase())
    .filter((word) => !STOPWORDS.has(word));
}

const normalizeText = (value: string): string =>
  value
    .trim()
    .replace(/^["'`]+|["'`.]+$/g, '')
    .toLowerCase();

function scoreSet(answer: string, rule: Extract<Scoring, { type: 'set' }>): Verdict {
  const numeric = rule.items.every((item) => /^-?\d+$/.test(item));
  const gold = rule.items.map((item) => (numeric ? String(Number(item)) : item.toLowerCase()));
  const given = setItems(answer, numeric);
  const unique = [...new Set(given)];
  const sameSet = unique.length === gold.length && gold.every((item) => unique.includes(item));
  const sameOrder =
    given.length === gold.length && gold.every((item, index) => given[index] === item);
  const ok = rule.ordered === true ? sameOrder : sameSet;
  return {
    outcome: ok ? 'correct' : 'wrong',
    detail: `items ${JSON.stringify(given)} vs ${JSON.stringify(gold)}${rule.ordered ? ' (ordered)' : ''}`,
  };
}

function scoreRubric(answer: string, rule: Extract<Scoring, { type: 'rubric' }>): Verdict {
  const hit: string[] = [];
  const missed: string[] = [];
  for (const fact of rule.facts)
    (new RegExp(fact.pattern, fact.flags ?? 'i').test(answer) ? hit : missed).push(fact.id);
  const forbidden = (rule.forbid ?? []).filter((pattern) => new RegExp(pattern, 'i').test(answer));
  const ok = missed.length === 0 && forbidden.length === 0;
  return {
    outcome: ok ? 'correct' : 'wrong',
    facts: { hit, missed },
    detail: `facts hit ${hit.length}/${rule.facts.length}${forbidden.length ? `; forbidden ${forbidden.join(',')}` : ''}`,
  };
}

/** Scores one answer against its question's rule. `undefined` means no answer was collected. */
export function scoreAnswer(
  question: Pick<Question, 'scoring'>,
  answer: string | undefined,
): Verdict {
  if (answer === undefined) return { outcome: 'missing', detail: 'no answer collected' };
  if (answer.trim() === '' || isUnknown(answer)) return { outcome: 'unknown', detail: 'abstained' };
  const rule = question.scoring;
  switch (rule.type) {
    case 'numeric': {
      const value = firstNumber(answer);
      return {
        outcome: value === rule.value ? 'correct' : 'wrong',
        detail: `first number ${value} vs ${rule.value}`,
      };
    }
    case 'exact': {
      const normalized = normalizeText(answer);
      const ok = rule.accept.some((item) => normalizeText(item) === normalized);
      return { outcome: ok ? 'correct' : 'wrong', detail: `"${normalized}"` };
    }
    case 'set':
      return scoreSet(answer, rule);
    case 'regex': {
      const flags = rule.flags ?? 'i';
      const ok =
        new RegExp(rule.pattern, flags).test(answer) &&
        (rule.forbid === undefined || !new RegExp(rule.forbid, flags).test(answer));
      return { outcome: ok ? 'correct' : 'wrong', detail: `/${rule.pattern}/${flags}` };
    }
    case 'rubric':
      return scoreRubric(answer, rule);
  }
}

export interface Row {
  id: string;
  config: string;
  answer: string | undefined;
  verdict: Verdict;
  material_tokens: number;
  material_bytes: number;
}

export interface ConfigSummary {
  config: string;
  questions: number;
  correct: number;
  unknown: number;
  wrong: number;
  missing: number;
  accuracy: number;
  unknown_rate: number;
  wrong_rate: number;
  material_bytes: number;
  material_tokens: number;
  /** Total material tokens over correct answers; null when nothing was correct. */
  tokens_per_correct: number | null;
}

const ratio = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);

export function summarize(config: string, rows: readonly Row[]): ConfigSummary {
  const count = (outcome: Outcome): number =>
    rows.filter((row) => row.verdict.outcome === outcome).length;
  const correct = count('correct');
  const tokens = rows.reduce((sum, row) => sum + row.material_tokens, 0);
  return {
    config,
    questions: rows.length,
    correct,
    unknown: count('unknown'),
    wrong: count('wrong'),
    missing: count('missing'),
    accuracy: ratio(correct, rows.length),
    unknown_rate: ratio(count('unknown'), rows.length),
    wrong_rate: ratio(count('wrong'), rows.length),
    material_bytes: rows.reduce((sum, row) => sum + row.material_bytes, 0),
    material_tokens: tokens,
    tokens_per_correct: correct === 0 ? null : tokens / correct,
  };
}

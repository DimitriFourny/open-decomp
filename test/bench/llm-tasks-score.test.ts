import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadQuestions } from '../../scripts/bench/llm-tasks/questions.js';
import {
  firstNumber,
  scoreAnswer,
  setItems,
  summarize,
} from '../../scripts/bench/llm-tasks/score.js';
import type { Row } from '../../scripts/bench/llm-tasks/score.js';

const outcome = (
  scoring: Parameters<typeof scoreAnswer>[0]['scoring'],
  answer: string | undefined,
) => scoreAnswer({ scoring }, answer).outcome;

test('every frozen gold answer satisfies its own scoring rule, and unknown never does', async () => {
  const set = await loadQuestions();
  assert.ok(set.questions.length >= 40);
  for (const question of set.questions) {
    assert.equal(scoreAnswer(question, question.gold).outcome, 'correct', question.id);
    assert.equal(scoreAnswer(question, 'unknown').outcome, 'unknown', question.id);
    assert.equal(scoreAnswer(question, 'zzz qqq').outcome, 'wrong', question.id);
  }
});

test('numeric: decimal, hex, sign and commas; only the first number counts', () => {
  assert.equal(firstNumber('0x1A01'), 6657);
  assert.equal(firstNumber('-22: d - z'), -22);
  assert.equal(firstNumber('3,054,000'), 3054000);
  const rule = { type: 'numeric', value: 6657 } as const;
  assert.equal(outcome(rule, '0x1a01 = 6657'), 'correct');
  assert.equal(outcome(rule, '5 or 6657'), 'wrong');
});

test('sets ignore commentary, order unless asked, and reject extras or omissions', () => {
  assert.deepEqual(setItems('5, 7 and 8 (iCol, bQuote, bTemp)', true), ['5', '7', '8']);
  assert.deepEqual(setItems('0x1c0 and 376', true), ['448', '376']);
  const unordered = { type: 'set', items: ['5', '7', '8'] } as const;
  assert.equal(outcome(unordered, '8, 5, 7'), 'correct');
  assert.equal(outcome(unordered, '5, 7'), 'wrong');
  assert.equal(outcome(unordered, '5, 7, 8, 9'), 'wrong');
  const ordered = {
    type: 'set',
    ordered: true,
    items: ['fopen', 'fseek', 'ftell', 'fclose'],
  } as const;
  assert.equal(outcome(ordered, 'fopen(), fseek, ftell, then fclose'), 'correct');
  assert.equal(outcome(ordered, 'fopen, ftell, fseek, fclose'), 'wrong');
});

test('rubric needs every fact; regex honours forbid; exact normalises quotes', () => {
  const rubric = {
    type: 'rubric',
    facts: [
      { id: 'zero', pattern: '\\b0\\b' },
      { id: 'code', pattern: '\\b21\\b' },
    ],
  } as const;
  assert.equal(outcome(rubric, 'returns 0; logs 21'), 'correct');
  assert.equal(outcome(rubric, 'returns 0x15'), 'wrong');
  assert.equal(
    outcome({ type: 'regex', pattern: 'suffix', forbid: 'overflow' }, 'suffix overflow'),
    'wrong',
  );
  assert.equal(outcome({ type: 'exact', accept: ['FileSize'] }, '`filesize`.'), 'correct');
});

test('abstention and missing answers are separate from wrong; summary rates', () => {
  const rule = { type: 'numeric', value: 1 } as const;
  assert.equal(outcome(rule, 'Unknown - not in the material'), 'unknown');
  assert.equal(outcome(rule, undefined), 'missing');
  const row = (answer: string | undefined, tokens: number): Row => ({
    id: 'q',
    config: 'c',
    answer,
    verdict: scoreAnswer({ scoring: rule }, answer),
    material_tokens: tokens,
    material_bytes: tokens * 4,
  });
  const summary = summarize('c', [row('1', 100), row('2', 50), row('unknown', 30), row('1', 20)]);
  assert.equal(summary.correct, 2);
  assert.equal(summary.wrong, 1);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.accuracy, 0.5);
  assert.equal(summary.tokens_per_correct, 100);
  assert.equal(summarize('c', [row('2', 5)]).tokens_per_correct, null);
});

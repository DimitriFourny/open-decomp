import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadQuestions } from '../../scripts/bench/llm-tasks/questions.js';
import { packetText } from '../../scripts/bench/llm-tasks/packets.js';
import type { Material } from '../../scripts/bench/llm-tasks/packets.js';
import { extractJson, parseOmpOutput } from '../../scripts/bench/odbench/judge/backend.js';
import {
  PROMPT_VERSION,
  cacheKey,
  readRecord,
  writeRecord,
} from '../../scripts/bench/odbench/judge/cache.js';
import type { JudgeRecord } from '../../scripts/bench/odbench/judge/cache.js';
import {
  QA_SYSTEM,
  READABILITY_SYSTEM,
  normalizeForJudge,
  qaUser,
  readabilityUser,
} from '../../scripts/bench/odbench/judge/prompts.js';
import {
  laneReason,
  mapOrderVerdicts,
  readabilitySchema,
  scoreOrders,
} from '../../scripts/bench/odbench/judge/tasks.js';
import { DIMENSIONS } from '../../scripts/bench/odbench/types.js';
import type { Dimension, OrderVerdicts } from '../../scripts/bench/odbench/types.js';

type Reply = Readonly<Record<Dimension, '1' | '2' | 'tie'>>;
const reply = (overall: '1' | '2' | 'tie', others: '1' | '2' | 'tie' = overall): Reply => ({
  control_flow: others,
  data: others,
  expressions: others,
  noise: others,
  overall,
});
const uniform = (verdict: 'a' | 'b' | 'tie'): OrderVerdicts => ({
  control_flow: verdict,
  data: verdict,
  expressions: verdict,
  noise: verdict,
  overall: verdict,
});

test('order 0 shows lane a first, order 1 shows lane b first: "1"/"2" map back to lanes', () => {
  assert.deepEqual(mapOrderVerdicts(0, reply('1')), uniform('a'));
  assert.deepEqual(mapOrderVerdicts(0, reply('2')), uniform('b'));
  assert.deepEqual(mapOrderVerdicts(1, reply('1')), uniform('b'));
  assert.deepEqual(mapOrderVerdicts(1, reply('2')), uniform('a'));
  assert.deepEqual(mapOrderVerdicts(0, reply('tie')), uniform('tie'));
  assert.deepEqual(mapOrderVerdicts(1, reply('tie')), uniform('tie'));
});

test('a verdict is mapped per dimension', () => {
  const mapped = mapOrderVerdicts(1, {
    control_flow: '1',
    data: '2',
    expressions: 'tie',
    noise: '1',
    overall: '2',
  });
  assert.deepEqual(mapped, {
    control_flow: 'b',
    data: 'a',
    expressions: 'tie',
    noise: 'b',
    overall: 'a',
  });
});

test('a judge that always prefers the first listing is position bias: score 0.5, inconsistent', () => {
  const orders = [mapOrderVerdicts(0, reply('1')), mapOrderVerdicts(1, reply('1'))] as const;
  const { score, consistent } = scoreOrders(orders);
  for (const dimension of DIMENSIONS) {
    assert.equal(score[dimension], 0.5);
    assert.equal(consistent[dimension], false);
  }
});

test('both orders naming the same lane: score 1 or 0, consistent', () => {
  const aWins = [mapOrderVerdicts(0, reply('1')), mapOrderVerdicts(1, reply('2'))] as const;
  assert.deepEqual(scoreOrders(aWins).score, {
    control_flow: 1,
    data: 1,
    expressions: 1,
    noise: 1,
    overall: 1,
  });
  assert.ok(DIMENSIONS.every((d) => scoreOrders(aWins).consistent[d]));
  const bWins = [mapOrderVerdicts(0, reply('2')), mapOrderVerdicts(1, reply('1'))] as const;
  assert.deepEqual(scoreOrders(bWins).score, {
    control_flow: 0,
    data: 0,
    expressions: 0,
    noise: 0,
    overall: 0,
  });
  assert.ok(DIMENSIONS.every((d) => scoreOrders(bWins).consistent[d]));
});

test('ties: both orders tie is consistent 0.5; one tie one win is inconsistent 0.75 or 0.25', () => {
  const bothTie = scoreOrders([uniform('tie'), uniform('tie')]);
  assert.equal(bothTie.score.overall, 0.5);
  assert.equal(bothTie.consistent.overall, true);
  const tieThenWin = scoreOrders([uniform('tie'), uniform('a')]);
  assert.equal(tieThenWin.score.overall, 0.75);
  assert.equal(tieThenWin.consistent.overall, false);
  const loseThenTie = scoreOrders([uniform('b'), uniform('tie')]);
  assert.equal(loseThenTie.score.overall, 0.25);
  assert.equal(loseThenTie.consistent.overall, false);
});

test('dimensions are scored independently', () => {
  const orders: [OrderVerdicts, OrderVerdicts] = [
    { control_flow: 'a', data: 'a', expressions: 'tie', noise: 'b', overall: 'a' },
    { control_flow: 'a', data: 'b', expressions: 'tie', noise: 'b', overall: 'a' },
  ];
  const { score, consistent } = scoreOrders(orders);
  assert.deepEqual(score, { control_flow: 1, data: 0.5, expressions: 0.5, noise: 0, overall: 1 });
  assert.deepEqual(consistent, {
    control_flow: true,
    data: false,
    expressions: true,
    noise: true,
    overall: true,
  });
});

test('reasons name lanes instead of listing numbers, per presentation order', () => {
  assert.equal(
    laneReason('Listing 1 has fewer gotos than listing 2.', 0, 'od-x', 'ghidra'),
    'od-x has fewer gotos than ghidra.',
  );
  assert.equal(
    laneReason('Listing 1 has fewer gotos than listing 2.', 1, 'od-x', 'ghidra'),
    'ghidra has fewer gotos than od-x.',
  );
});

test('readability replies accept numbers and case, and default a missing reason', () => {
  const parsed = readabilitySchema.parse({
    control_flow: 1,
    data: 'TIE',
    expressions: '2',
    noise: ' 1 ',
    overall: 'tie',
  });
  assert.deepEqual(parsed, {
    control_flow: '1',
    data: 'tie',
    expressions: '2',
    noise: '1',
    overall: 'tie',
    reason: '',
  });
  assert.throws(() => readabilitySchema.parse({ ...parsed, overall: 'both' }));
});

test('JSON is extracted from replies with prose or fences around it', () => {
  assert.deepEqual(extractJson('{"a": 1}'), { a: 1 });
  assert.deepEqual(
    extractJson('Sure! Here is the JSON:\n```json\n{"a": [1, {"b": 2}]}\n```\nHope it helps.'),
    {
      a: [1, { b: 2 }],
    },
  );
  assert.deepEqual(
    extractJson('Listing {1} is better. {"overall": "2", "reason": "uses } and { in text"} done'),
    {
      overall: '2',
      reason: 'uses } and { in text',
    },
  );
  assert.deepEqual(extractJson('{"q": "say \\"}\\" now"}'), { q: 'say "}" now' });
  assert.deepEqual(extractJson('first {"a": 1} then {"b": 2}'), { a: 1 });
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson('{"unterminated": 1'), null);
});

test('JSON replies survive C escapes in strings and a quoted object before the answer', () => {
  // Models write C character literals verbatim: `'\0'` is not a JSON escape.
  assert.deepEqual(extractJson(String.raw`{"details": ["stops at '\0' or '\x2f'"], "n": 1}`), {
    details: [String.raw`stops at '\0' or '\x2f'`],
    n: 1,
  });
  assert.deepEqual(extractJson('{"a": "line one\nline two"}'), { a: 'line one\nline two' });
  // Haiku closes a long array twice or with a parenthesis before the last key.
  assert.deepEqual(extractJson('{"wrong_claims": ["a", "b"]], "coverage": 2}'), {
    wrong_claims: ['a', 'b'],
    coverage: 2,
  });
  assert.deepEqual(extractJson('{"wrong_claims": ["a (see x)"]), "coverage": 3}'), {
    wrong_claims: ['a (see x)'],
    coverage: 3,
  });
  // A grader quoting the explanation before its grade: the schema picks the grade.
  const reply = 'Explanation: {"purpose": "x"}\nGrade: {"coverage": 3, "wrong": 0}';
  const isGrade = (value: unknown): boolean =>
    typeof value === 'object' && value !== null && 'coverage' in value;
  assert.deepEqual(extractJson(reply, isGrade), { coverage: 3, wrong: 0 });
  assert.deepEqual(extractJson(reply), { purpose: 'x' });
});

test('cache key changes with prompt text, model, task and sample', () => {
  const key = cacheKey('readability', 'anthropic/claude-haiku-5-5', 'system', 'user', 0);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(key, cacheKey('readability', 'anthropic/claude-haiku-5-5', 'system', 'user', 0));
  const variants = [
    cacheKey('readability', 'anthropic/claude-haiku-5-5', 'system', 'user ', 0),
    cacheKey('readability', 'anthropic/claude-haiku-5-5', 'system.', 'user', 0),
    cacheKey('readability', 'anthropic/claude-sonnet-5-5', 'system', 'user', 0),
    cacheKey('readability', 'anthropic/claude-haiku-5-5', 'system', 'user', 1),
    cacheKey('qa', 'anthropic/claude-haiku-5-5', 'system', 'user', 0),
    cacheKey('readability', 'anthropic/claude-haiku-5-5', 'syste', 'musers', 0),
  ];
  assert.equal(new Set([key, ...variants]).size, variants.length + 1);
  assert.match(PROMPT_VERSION, /^odbench-prompts\/\d+$/);
});

test('the prompts embed the listings in the requested order and the QA prompt is the llm-tasks packet', async () => {
  const user = readabilityUser('int first(void) {}', 'int second(void) {}');
  assert.ok(user.indexOf('int first') < user.indexOf('int second'));
  assert.ok(
    user.includes(
      'Listing 1:\n<<<\nint first(void) {}\n>>>\n\nListing 2:\n<<<\nint second(void) {}\n>>>',
    ),
  );
  assert.ok(READABILITY_SYSTEM.endsWith('Reply with JSON only.'));
  const set = await loadQuestions();
  const question = set.questions[0]!;
  const material = 'int f(void) {\n  return 1;\n}\n\n';
  const packet = packetText(set, question, { text: material } as Material);
  assert.equal(qaUser(set, question, material), packet);
  assert.equal(QA_SYSTEM, 'Answer the question from the material only.');
});

test('normalizeForJudge drops the C-like banner, trailing whitespace and trailing blank lines', () => {
  assert.equal(
    normalizeForJudge('/* C-like */\nint f() {  \n\treturn 0;\t\n}\n\n\n'),
    'int f() {\n\treturn 0;\n}',
  );
  assert.equal(normalizeForJudge('/* C-like */ int f();\n'), '/* C-like */ int f();');
  assert.equal(normalizeForJudge('int f();\r\n/* C-like */\r\n'), 'int f();\n/* C-like */');
  assert.equal(normalizeForJudge(''), '');
});

test('omp JSON output: the last assistant message_end gives text, usage (cache included), cost, model', () => {
  const message = {
    role: 'assistant',
    content: [
      { type: 'text', text: 'O' },
      { type: 'text', text: 'K' },
    ],
    model: 'claude-haiku-5-5',
    usage: { input: 284, output: 4, cacheRead: 10, cacheWrite: 6, cost: { total: 0.0000304 } },
    stopReason: 'stop',
  };
  const stdout = [
    { type: 'session', version: 3 },
    { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'message_end', message },
    { type: 'turn_end', message },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
  assert.deepEqual(parseOmpOutput(stdout), {
    text: 'OK',
    usage: { input: 300, output: 4 },
    cost: 0.0000304,
    model: 'claude-haiku-5-5',
  });
  const failed = JSON.stringify({
    type: 'message_end',
    message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'overloaded' },
  });
  assert.throws(() => parseOmpOutput(failed), /stopReason error: overloaded/);
  assert.throws(() => parseOmpOutput('{"type":"agent_start"}'), /no assistant message/);
});

test('cache records round-trip through the bench dir and a missing key is a miss', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'odbench-judge-test-'));
  const previous = process.env['OPEN_DECOMP_BENCH_DIR'];
  process.env['OPEN_DECOMP_BENCH_DIR'] = dir;
  try {
    const key = cacheKey('qa', 'm', 's', 'u', 2);
    assert.equal(await readRecord(key), null);
    const record: JudgeRecord = {
      key,
      task: 'qa',
      model: 'm',
      sample: 2,
      system_sha256: 'a',
      user_sha256: 'b',
      text: '42',
      parsed: null,
      usage: { input: 10, output: 1 },
      cost: null,
      reply_model: 'm',
      created: '2026-10-21T00:00:00.000Z',
    };
    await writeRecord(record);
    assert.deepEqual(await readRecord(key), record);
  } finally {
    if (previous === undefined) delete process.env['OPEN_DECOMP_BENCH_DIR'];
    else process.env['OPEN_DECOMP_BENCH_DIR'] = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

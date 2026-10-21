/**
 * Judge prompt texts and the text normalization applied before any prompt.
 * The system and user texts are part of every cache key, so editing a prompt re-asks exactly the
 * calls that use it; bump PROMPT_VERSION in `cache.ts` only when reply handling changes.
 */
import { MATERIAL_END, promptFor } from '../../llm-tasks/packets.js';
import type { Question, QuestionSet } from '../../llm-tasks/questions.js';

/** Drops the `/* C-like *\/` banner line, strips trailing whitespace per line, trims trailing blank lines. */
export function normalizeForJudge(text: string): string {
  const lines = text.split('\n').map((line) => line.trimEnd());
  if (lines[0] === '/* C-like */') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/** tokens: the reply is irrelevant, only the prompt size (usage.input) is read. */
export const TOKENS_SYSTEM = 'Reply with the single word OK.';
/** tokens baseline user prompt: its usage.input is subtracted from every measurement. */
export const TOKENS_BASELINE_USER = '.';

export const READABILITY_SYSTEM =
  'You are an expert reverse engineer comparing two decompiler outputs. Reply with JSON only.';

export function readabilityUser(first: string, second: string): string {
  return `Two decompilers turned the same compiled function into the C-like listings below. Decide which listing lets a reverse engineer understand what the function does faster and with less risk of misunderstanding.

Criteria:
- control_flow: structured code with natural loops and conditions; few gotos, flag variables and needless nesting.
- data: meaningful types and variables, recovered structures, strings and constants; no needless casts.
- expressions: simple idiomatic expressions instead of machine-level arithmetic.
- noise: no decompiler artifacts, redundant declarations or boilerplate that carries no information.
- overall: the listing you would rather read to understand this function.

Do not prefer a listing for being longer or shorter as such. Information present in only one listing counts only if it helps understanding. Answer "tie" when neither is clearly better.

Listing 1:
<<<
${first}
>>>

Listing 2:
<<<
${second}
>>>

Reply with exactly this JSON: {"control_flow": "1"|"2"|"tie", "data": "1"|"2"|"tie", "expressions": "1"|"2"|"tie", "noise": "1"|"2"|"tie", "overall": "1"|"2"|"tie", "reason": "<at most 30 words>"}`;
}

export const EXPLAIN_SYSTEM = 'You are a reverse engineer. Reply with JSON only.';

export function explainUser(text: string): string {
  return `Read the function below. It is decompiler output or source code and may contain inlined code. Explain what it does for someone who must reimplement or audit it. Be concrete: name the conditions, constants, called functions and what the return value means. Do not speculate beyond what the code shows; write "unclear" where it is.

<<<
${text}
>>>

Reply with exactly this JSON: {"purpose": "<one sentence>", "inputs": "<parameters and how they are used>", "output": "<return value and results>", "effects": "<side effects: calls, writes, allocations>", "details": ["<up to 6 concrete facts: conditions, constants, loop bounds, error paths>"]}`;
}

export const GRADE_SYSTEM =
  'You grade explanations of a C function against its source code. Reply with JSON only.';

export function gradeUser(source: string, explanation: string): string {
  return `Source code of the function (ground truth):
<<<
${source}
>>>

An explanation written by someone who saw only a decompiled version of the compiled function (the compiled code may include inlined callees and constants folded by the compiler):
<<<
${explanation}
>>>

Check every factual claim of the explanation against the source. A claim about code called or inlined by this function is "unverifiable" unless the source contradicts it. A claim that names a variable differently but describes the same behavior is correct. Compiled code shows facts the source does not: struct field offsets, addresses, register or stack details, numeric values of macros and constants. A claim stated in such terms is correct when the behavior it describes matches the source (e.g. "returns early when the flag at offset 0x20 is set" for \`if (ctx->test_integrity) return\`), unverifiable when the source cannot confirm it, and wrong only when the behavior it describes contradicts the source. Code under #if/#ifdef may be present or absent in the compiled function: never count a claim wrong only for describing or omitting it. Then rate coverage of the function's essential behavior: 0 = nothing right or wrong purpose, 1 = purpose only, 2 = purpose and main path, 3 = also the main conditions and results, 4 = complete and precise.

Reply with exactly this JSON, coverage first; wrong_claims lists only the claims you counted as wrong: {"coverage": <0-4>, "correct": <integer>, "wrong": <integer>, "unverifiable": <integer>, "wrong_claims": ["<short description of each wrong claim>"]}`;
}

export const QA_SYSTEM = 'Answer the question from the material only.';

/** Exactly what `packetText` (llm-tasks/packets.ts) builds, with the normalized lane text as material. */
export function qaUser(set: QuestionSet, question: Question, material: string): string {
  return `${promptFor(set, question)}\n${material.replace(/\n*$/, '\n')}${MATERIAL_END}\n\nAnswer:\n`;
}

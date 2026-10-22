/**
 * Per-function diagnostics as `lane.json` records them: severity, code and the first sentence of the
 * message, each distinct triple once in first-seen order. Subjects, evidence and counts are dropped:
 * this is a census row ("which functions carry this diagnostic"), not the full envelope. Diagnostics
 * are never part of text identity.
 */
import type { FunctionDiagnostic } from './types.js';

const MAX_SENTENCE = 160;

/** The message up to its first sentence end (`.`, `!` or `?` before a space or the end), capped. */
export function firstSentence(message: string): string {
  const end = /[.!?](\s|$)/.exec(message);
  const sentence = (end ? message.slice(0, end.index) : message).trim();
  return sentence.length > MAX_SENTENCE ? `${sentence.slice(0, MAX_SENTENCE)}…` : sentence;
}

/** The envelope's diagnostics reduced to distinct (severity, code, first sentence) records. */
export function digestDiagnostics(
  diagnostics: readonly {
    readonly code: string;
    readonly severity: string;
    readonly message: string;
  }[],
): FunctionDiagnostic[] {
  const distinct = new Map<string, FunctionDiagnostic>();
  for (const { code, severity, message } of diagnostics) {
    const record = { code, severity, text: firstSentence(message) };
    const key = JSON.stringify([record.severity, record.code, record.text]);
    if (!distinct.has(key)) distinct.set(key, record);
  }
  return [...distinct.values()];
}

import type { WireDiagnostic } from './primitives.js';

export interface DistinctDiagnostic {
  readonly diagnostic: WireDiagnostic;
  readonly count: number;
}

/** Each distinct (severity, code, message, details) once, in first-seen order, with its
 * occurrence count. Equal diagnostics that differ only in subject or evidence collapse. */
export function distinctDiagnostics(diagnostics: readonly WireDiagnostic[]): DistinctDiagnostic[] {
  const distinct = new Map<string, { diagnostic: WireDiagnostic; count: number }>();
  for (const diagnostic of diagnostics) {
    const key = JSON.stringify([
      diagnostic.severity,
      diagnostic.code,
      diagnostic.message,
      diagnostic.details ?? null,
    ]);
    const seen = distinct.get(key);
    if (seen) seen.count++;
    else distinct.set(key, { diagnostic, count: 1 });
  }
  return [...distinct.values()];
}

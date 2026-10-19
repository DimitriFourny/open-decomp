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

/** One reader-relevant line of a diagnostic digest. */
export interface Caveat {
  readonly severity: 'warning' | 'error';
  readonly code: WireDiagnostic['code'];
  readonly text: string;
}

const MAX_NAMES = 6;
const MAX_SENTENCE = 160;
const severityOrder = { error: 0, warning: 1 } as const;

function names(items: readonly string[]): string {
  return items.length > MAX_NAMES
    ? `${items.slice(0, MAX_NAMES).join(', ')}, +${items.length - MAX_NAMES}`
    : items.join(', ');
}
function firstSentence(message: string): string {
  const end = /[.!?](\s|$)/.exec(message);
  const sentence = end ? message.slice(0, end.index) : message;
  return sentence.length > MAX_SENTENCE ? `${sentence.slice(0, MAX_SENTENCE)}…` : sentence;
}

/** The warnings and errors of a result as the few distinct caveats a reader acts on, most severe
 * first. Info diagnostics are bookkeeping and stay in the full envelope. Equal diagnostics
 * collapse with a count; per-call interface warnings become one count; partial callee summaries
 * become one name list per cause (budget cut vs unresolved) instead of each callee's internal
 * reasons; return-storage warnings become the union of the registers involved. An ungrouped
 * warning keeps its first sentence; an error keeps its whole message. */
export function caveats(diagnostics: readonly WireDiagnostic[]): Caveat[] {
  // Lines are built after the scan so each group's text sees all of its members.
  const lines: Array<() => Caveat> = [];
  let calls = 0;
  const registers = new Set<string>();
  const cut: string[] = [];
  const partial: string[] = [];
  for (const { diagnostic, count } of distinctDiagnostics(diagnostics)) {
    const { code, details, severity } = diagnostic;
    if (severity === 'info') continue;
    if (severity === 'warning' && details?.kind === 'call_interface') {
      if (calls === 0)
        lines.push(() => ({
          severity,
          code,
          text: `${calls} call${calls === 1 ? '' : 's'} with unresolved interface`,
        }));
      calls += count;
    } else if (severity === 'warning' && details?.kind === 'return_storage') {
      if (registers.size === 0)
        lines.push(() => ({
          severity,
          code,
          text: `return list unresolved (possible result storage: ${names([...registers])})`,
        }));
      for (const slice of details.storage) {
        const root = slice.replace(/\[.*$/, '');
        registers.add(root.slice(root.lastIndexOf(':') + 1));
      }
    } else if (severity === 'warning' && details?.kind === 'callee_partial') {
      const budget = code === 'resource_limit';
      const group = budget ? cut : partial;
      if (group.length === 0)
        lines.push(() => ({
          severity,
          code,
          text: `callee summaries ${budget ? 'cut by budget' : 'partial'}: ${names(group)}`,
        }));
      group.push(details.callee);
    } else {
      const text = severity === 'error' ? diagnostic.message : firstSentence(diagnostic.message);
      lines.push(() => ({ severity, code, text: `${text}${count > 1 ? ` ×${count}` : ''}` }));
    }
  }
  return lines
    .map((make) => make())
    .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
}

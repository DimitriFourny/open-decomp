/**
 * Pure parts of the likely-inference precision harness (`likely-precision.ts`): source-derived
 * ground truth from a DWARF dump of a compiler's own output for the analyzed sources, and the
 * scoring of the decompiler's `guess` provenance records against it. No decompiler, no I/O.
 *
 * Dimensions. `arity`: the printed argument count of a closed call against the declared
 * parameter count of its target. `parameter_type` / `result_type`: the guessed pointer-ness of
 * a formal or of the result against the declared kind (pointer vs integer/float). The truth
 * carries each parameter's kind (`int`/`float`/`pointer`) and width and the result kind. The
 * population of a type dimension (coverage) is every declared pointer formal or result that
 * the proven rules do not already print as a pointer.
 */

import {
  LIKELY_PRECISION_GATE,
  likelyHeuristicSchema,
  type LikelyHeuristic,
} from '../../src/core/inference.js';

export type TypeKind = 'int' | 'float' | 'pointer';
export interface TypeFact {
  readonly kind: TypeKind;
  readonly bits: number;
}
export interface FunctionTruth {
  /** Declared parameters in order; absent entries are never `void`. */
  readonly params: readonly TypeFact[];
  /** Null: the function returns void. */
  readonly result: TypeFact | null;
  /** C-variadic: no fixed argument count exists, so any closure of its list is wrong. */
  readonly variadic: boolean;
  /** A by-value aggregate or a >64-bit scalar changes register use: not scored. */
  readonly complex: boolean;
}
export type Truth = Readonly<Record<string, FunctionTruth>>;

// ---------------------------------------------------------------------------------------- DWARF

interface Die {
  readonly offset: number;
  readonly tag: string;
  readonly indent: number;
  readonly attributes: Map<string, string>;
}

const HEADER = /^0x([0-9a-f]+):\s+(DW_TAG_\w+)/;
const ATTRIBUTE = /^\s+DW_AT_(\w+)\s+\((.*)\)\s*$/;

function reference(value: string | undefined): number | undefined {
  const match = value === undefined ? null : /^0x([0-9a-f]+)/.exec(value);
  return match ? parseInt(match[1]!, 16) : undefined;
}
function quoted(value: string | undefined): string | undefined {
  const match = value === undefined ? null : /^"(.*)"$/.exec(value);
  return match ? match[1]! : undefined;
}

/** Incremental reader of `dwarfdump --debug-info` text, so a large dump (SQLite's) is never one
 * string: `feed` every line, then `truth()`. Every named subprogram counts, definitions and
 * call-site declarations alike (an -O1 compile records the declaration of each called external
 * function); inlined concrete instances carry no name and are skipped. The first signature of
 * a name wins. */
export class DwarfReader {
  readonly #dies = new Map<number, Die>();
  readonly #subprograms: { die: Die; params: Die[]; variadic: boolean }[] = [];
  #current: Die | undefined;
  #open: { die: Die; params: Die[]; variadic: boolean } | undefined;

  feed(line: string): void {
    const header = HEADER.exec(line);
    if (header) {
      const tag = header[2]!;
      const indent = line.indexOf('DW_TAG_') - 12;
      const die: Die = { offset: parseInt(header[1]!, 16), tag, indent, attributes: new Map() };
      this.#current = die;
      this.#dies.set(die.offset, die);
      if (this.#open && indent <= this.#open.die.indent) this.#open = undefined;
      if (tag === 'DW_TAG_subprogram') {
        this.#open = { die, params: [], variadic: false };
        this.#subprograms.push(this.#open);
      } else if (this.#open && indent === this.#open.die.indent + 2) {
        if (tag === 'DW_TAG_formal_parameter') this.#open.params.push(die);
        else if (tag === 'DW_TAG_unspecified_parameters') this.#open.variadic = true;
      }
      return;
    }
    const attribute = ATTRIBUTE.exec(line);
    if (attribute && this.#current) this.#current.attributes.set(attribute[1]!, attribute[2]!);
  }

  #resolve(value: string | undefined): TypeFact | 'void' | 'aggregate' {
    let offset = reference(value);
    for (let depth = 0; depth < 32; depth++) {
      if (offset === undefined) return 'void';
      const die = this.#dies.get(offset);
      if (!die) return 'aggregate';
      switch (die.tag) {
        case 'DW_TAG_pointer_type':
        case 'DW_TAG_reference_type':
          return { kind: 'pointer', bits: 64 };
        case 'DW_TAG_base_type': {
          const bits = Number(die.attributes.get('byte_size') ?? 0) * 8;
          const encoding = die.attributes.get('encoding') ?? '';
          return { kind: /float/.test(encoding) ? 'float' : 'int', bits };
        }
        case 'DW_TAG_enumeration_type': {
          const size = die.attributes.get('byte_size');
          if (size !== undefined) return { kind: 'int', bits: Number(size) * 8 };
          offset = reference(die.attributes.get('type'));
          continue;
        }
        case 'DW_TAG_typedef':
        case 'DW_TAG_const_type':
        case 'DW_TAG_volatile_type':
        case 'DW_TAG_restrict_type':
        case 'DW_TAG_atomic_type':
          offset = reference(die.attributes.get('type'));
          continue;
        default:
          return 'aggregate';
      }
    }
    return 'aggregate';
  }

  truth(): Truth {
    const truth: Record<string, FunctionTruth> = {};
    for (const { die, params, variadic } of this.#subprograms) {
      const name = quoted(die.attributes.get('name'));
      if (name === undefined || truth[name]) continue;
      const result = this.#resolve(die.attributes.get('type'));
      const parameters = params.map((param) => this.#resolve(param.attributes.get('type')));
      const facts = parameters.filter((fact): fact is TypeFact => typeof fact === 'object');
      const scalars = [...facts, ...(typeof result === 'object' ? [result] : [])];
      truth[name] = {
        params: facts,
        result: typeof result === 'object' ? result : null,
        variadic,
        complex:
          parameters.some((fact) => fact === 'aggregate') ||
          result === 'aggregate' ||
          scalars.some((fact) => fact.bits > 64),
      };
    }
    return truth;
  }
}

export function parseDwarf(text: string): Truth {
  const reader = new DwarfReader();
  for (const line of text.split('\n')) reader.feed(line);
  return reader.truth();
}

// --------------------------------------------------------------------------------------- scoring

export type Heuristic = LikelyHeuristic;
export const HEURISTICS: readonly Heuristic[] = likelyHeuristicSchema.options;
/** What each heuristic guesses; the dimension decides how its guesses are scored. */
export const HEURISTIC_DIMENSION: Readonly<
  Record<Heuristic, 'argument_list' | 'parameter_type' | 'result_type'>
> = {
  callee_reads: 'argument_list',
  caller_consensus: 'argument_list',
  caller_argument_pointer: 'parameter_type',
  caller_result_pointer: 'result_type',
  indirect_call_target: 'parameter_type',
  opaque_word_formal: 'parameter_type',
  carried_word_formal: 'parameter_type',
};
/** Gate of TODO.md R5: a heuristic prints in `likely` mode only at this precision or better. */
export const PRECISION_GATE = LIKELY_PRECISION_GATE;

/** An `argument_list` `guess` record joined with its call site. */
export interface ArityGuessRow {
  readonly subject: 'argument_list';
  readonly caller: string;
  readonly call_id: string;
  readonly target_address: string;
  /** C name of the target in the analyzed image, when it has one. */
  readonly target_name: string | null;
  readonly heuristics: readonly Heuristic[];
  readonly applied: boolean;
  readonly arity: number;
  readonly sites: number | null;
}
/** A `parameter_type` / `result_type` `guess` record of the decompiled function `caller`. */
export interface TypeGuessRow {
  readonly subject: 'parameter_type' | 'result_type';
  /** C name of the decompiled function the guess is about. */
  readonly caller: string;
  /** Position among the printed formals; null for the result. */
  readonly ordinal: number | null;
  /** Printed formals of that function, to tell whether ordinals line up with the source. */
  readonly printed_params: number;
  readonly heuristics: readonly Heuristic[];
  readonly applied: boolean;
  readonly sites: number | null;
}
export type GuessRow = ArityGuessRow | TypeGuessRow;
/** One call record of a decompiled function (guessed or not). */
export interface CallRow {
  readonly caller: string;
  readonly call_id: string;
  readonly target_address: string | null;
  readonly target_name: string | null;
  readonly arity_complete: boolean;
}

export type Outcome = 'correct' | 'wrong' | 'over' | 'under' | 'variadic' | 'complex' | 'unscored';
export interface Verdict {
  readonly outcome: Outcome;
  readonly truth_arity: number | null;
}

/** The arity dimension: a guess is correct when the printed argument count is exactly the
 * declared parameter count of the function the call targets. `over`/`under`: more/fewer
 * arguments than declared. A variadic target has no fixed count, so a closure is wrong. */
export function scoreArity(row: ArityGuessRow, truth: Truth): Verdict {
  const fact = row.target_name === null ? undefined : truth[row.target_name];
  if (!fact) return { outcome: 'unscored', truth_arity: null };
  if (fact.variadic) return { outcome: 'variadic', truth_arity: fact.params.length };
  if (fact.complex) return { outcome: 'complex', truth_arity: null };
  const expected = fact.params.length;
  return {
    outcome: row.arity === expected ? 'correct' : row.arity > expected ? 'over' : 'under',
    truth_arity: expected,
  };
}
/** The type dimensions: a guessed pointer is correct when the declared formal (or result) is a
 * pointer. Formals are compared by position, which is the source order only when the printed
 * and declared counts agree and no declared formal is a float (the float bank is numbered
 * apart); any other function is unscored rather than guessed at. */
export function scoreType(row: TypeGuessRow, truth: Truth): Verdict {
  const fact = truth[row.caller];
  if (!fact) return { outcome: 'unscored', truth_arity: null };
  if (fact.complex) return { outcome: 'complex', truth_arity: null };
  let declared: TypeFact | null | undefined;
  if (row.subject === 'result_type') declared = fact.result;
  else if (
    row.ordinal === null ||
    row.printed_params !== fact.params.length ||
    fact.params.some((param) => param.kind === 'float')
  )
    return { outcome: 'unscored', truth_arity: null };
  else declared = fact.params[row.ordinal];
  return { outcome: declared?.kind === 'pointer' ? 'correct' : 'wrong', truth_arity: null };
}
export function scoreGuess(row: GuessRow, truth: Truth): Verdict {
  return row.subject === 'argument_list' ? scoreArity(row, truth) : scoreType(row, truth);
}
/** What a guess is about: scored callee-wise (arity) or per formal/result (types). */
export function guessSubject(row: GuessRow): string | null {
  return row.subject === 'argument_list'
    ? row.target_name
    : `${row.caller}:${row.subject}:${row.ordinal ?? ''}`;
}

export interface Tally {
  /** Scored guesses (site level). */
  sites: number;
  correct: number;
  /** Type guesses whose declared formal or result is not a pointer. */
  wrong: number;
  over: number;
  under: number;
  variadic: number;
  /** Guesses with no source truth (target not in the sources) or a complex signature. */
  unscored: number;
  /** Distinct scored subjects (callees for arity, formals/results for types); a subject is
   * correct only when every guess about it is. */
  callees: number;
  callees_correct: number;
  precision_sites: number | null;
  precision_callees: number | null;
}

const ratio = (part: number, whole: number): number | null => (whole ? part / whole : null);

/** Per-heuristic tallies of one set of guesses. A site where several heuristics fired counts
 * for each of them, so each heuristic is judged on everything it claims. */
export function tally(
  guesses: readonly GuessRow[],
  truth: Truth,
): Record<Heuristic | 'any', Tally> {
  const out = {} as Record<Heuristic | 'any', Tally>;
  for (const name of [...HEURISTICS, 'any'] as const) {
    const rows = guesses.filter((row) => name === 'any' || row.heuristics.includes(name));
    const t: Tally = {
      sites: 0,
      correct: 0,
      wrong: 0,
      over: 0,
      under: 0,
      variadic: 0,
      unscored: 0,
      callees: 0,
      callees_correct: 0,
      precision_sites: null,
      precision_callees: null,
    };
    const callee = new Map<string, boolean>();
    for (const row of rows) {
      const { outcome } = scoreGuess(row, truth);
      if (outcome === 'unscored' || outcome === 'complex') {
        t.unscored++;
        continue;
      }
      t.sites++;
      if (outcome === 'correct') t.correct++;
      else t[outcome]++;
      const subject = guessSubject(row)!;
      callee.set(subject, (callee.get(subject) ?? true) && outcome === 'correct');
    }
    t.callees = callee.size;
    t.callees_correct = [...callee.values()].filter(Boolean).length;
    t.precision_sites = ratio(t.correct, t.sites);
    t.precision_callees = ratio(t.callees_correct, t.callees);
    out[name] = t;
  }
  return out;
}

/** Open direct call sites whose target has a fixed, scorable source arity: the guessable
 * population. A heuristic's coverage is its scored guesses over this count. */
export function guessableSites(calls: readonly CallRow[], truth: Truth): number {
  let count = 0;
  for (const call of calls) {
    const fact = call.target_name === null ? undefined : truth[call.target_name];
    if (
      !call.arity_complete &&
      call.target_address !== null &&
      fact &&
      !fact.variadic &&
      !fact.complex
    )
      count++;
  }
  return count;
}

// ------------------------------------------------------------------- printed declarations

/** Pointer-ness of what one decompiled function declares, read from the span of its printed
 * declaration (`emission.declaration_span`): a `*` or `pointer[` in a spelling. A wrapped
 * (`likely_type(...)`) spelling counts as printed, which is what the reader sees. */
export interface PrintedDeclaration {
  readonly result_pointer: boolean;
  /** One entry per printed formal, `...` excluded. */
  readonly params: readonly boolean[];
}
const isPointerSpelling = (text: string): boolean =>
  text.includes('*') || text.includes('pointer[');

export function parseDeclaration(text: string): PrintedDeclaration | null {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const params: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text.slice(open + 1, close)) {
    if (char === '(' || char === '[') depth++;
    if (char === ')' || char === ']') depth--;
    if (char === ',' && depth === 0) {
      params.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim()) params.push(current.trim());
  return {
    result_pointer: isPointerSpelling(text.slice(0, open)),
    params: params.filter((param) => param !== 'void' && param !== '...').map(isPointerSpelling),
  };
}

export interface FunctionObservation extends PrintedDeclaration {
  readonly name: string;
}
export interface TypePopulation {
  /** Declared pointer formals the proven rules print as pointers. */
  readonly proven_params: number;
  /** Declared pointer formals still integer without a guess: what a heuristic can reach. */
  readonly open_params: number;
  readonly proven_results: number;
  readonly open_results: number;
}
/** Declared pointer formals and results of the observed functions, split by whether proven
 * analysis already prints them as pointers. A pointer printed because an applied guess made it
 * one was open before the guess. Only functions whose printed formals line up with the source
 * (see `scoreType`) take part in the formal counts. */
export function typePopulation(
  observations: readonly FunctionObservation[],
  truth: Truth,
  guesses: readonly GuessRow[],
): TypePopulation {
  const applied = new Set<string>();
  for (const row of guesses)
    if (row.subject !== 'argument_list' && row.applied)
      applied.add(`${row.caller}:${row.subject}:${row.ordinal ?? ''}`);
  const population = { proven_params: 0, open_params: 0, proven_results: 0, open_results: 0 };
  for (const observation of observations) {
    const fact = truth[observation.name];
    if (!fact || fact.complex) continue;
    if (fact.result?.kind === 'pointer') {
      if (observation.result_pointer && !applied.has(`${observation.name}:result_type:`))
        population.proven_results++;
      else population.open_results++;
    }
    if (
      observation.params.length !== fact.params.length ||
      fact.params.some((param) => param.kind === 'float')
    )
      continue;
    fact.params.forEach((param, index) => {
      if (param.kind !== 'pointer') return;
      if (observation.params[index] && !applied.has(`${observation.name}:parameter_type:${index}`))
        population.proven_params++;
      else population.open_params++;
    });
  }
  return population;
}

export interface GateVerdict {
  readonly heuristic: Heuristic;
  readonly sites: number;
  readonly precision_sites: number | null;
  readonly precision_callees: number | null;
  /** Both precisions at or above the gate, on at least `MIN_SITES` scored guesses. */
  readonly passes: boolean;
}
/** Fewer scored guesses than this cannot show a 95% precision. */
export const MIN_SITES = 20;

export function gate(tallies: Record<Heuristic | 'any', Tally>): GateVerdict[] {
  return HEURISTICS.map((heuristic) => {
    const t = tallies[heuristic];
    return {
      heuristic,
      sites: t.sites,
      precision_sites: t.precision_sites,
      precision_callees: t.precision_callees,
      passes:
        t.sites >= MIN_SITES &&
        (t.precision_sites ?? 0) >= PRECISION_GATE &&
        (t.precision_callees ?? 0) >= PRECISION_GATE,
    };
  });
}

/** Strip the loader's C-symbol decoration (Mach-O leading underscore). */
export function cName(native: string): string {
  return native.startsWith('_') ? native.slice(1) : native;
}

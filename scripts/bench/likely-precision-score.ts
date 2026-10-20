/**
 * Pure parts of the likely-inference precision harness (`likely-precision.ts`): source-derived
 * ground truth from a DWARF dump of a compiler's own output for the analyzed sources, and the
 * scoring of the decompiler's `guess` provenance records against it. No decompiler, no I/O.
 *
 * Dimensions. Only `arity` is scored today because it is the only construct a heuristic guesses.
 * The truth already carries each parameter's kind (`int`/`float`/`pointer`) and width and the
 * result kind, so pointer-ness and result-type heuristics (TODO.md R5, the R4-dependent bullet)
 * add a scorer to `SCORERS` without touching the truth format or the report shape.
 */

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

export type Heuristic = 'callee_reads' | 'caller_consensus';
export const HEURISTICS: readonly Heuristic[] = ['callee_reads', 'caller_consensus'];
/** Gate of TODO.md R5: a heuristic prints in `likely` mode only at this precision or better. */
export const PRECISION_GATE = 0.95;

/** One `guess` record joined with its call site. */
export interface GuessRow {
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
/** One call record of a decompiled function (guessed or not). */
export interface CallRow {
  readonly caller: string;
  readonly call_id: string;
  readonly target_address: string | null;
  readonly target_name: string | null;
  readonly arity_complete: boolean;
}

export type Outcome = 'correct' | 'over' | 'under' | 'variadic' | 'complex' | 'unscored';
export interface Verdict {
  readonly outcome: Outcome;
  readonly truth_arity: number | null;
}

/** The arity dimension: a guess is correct when the printed argument count is exactly the
 * declared parameter count of the function the call targets. `over`/`under`: more/fewer
 * arguments than declared. A variadic target has no fixed count, so a closure is wrong. */
export function scoreArity(row: GuessRow, truth: Truth): Verdict {
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
/** Dimensions a guess can be scored on; the key is the report section. */
export const SCORERS = { arity: scoreArity } as const;

export interface Tally {
  /** Scored guesses (site level). */
  sites: number;
  correct: number;
  over: number;
  under: number;
  variadic: number;
  /** Guesses with no source truth (target not in the sources) or a complex signature. */
  unscored: number;
  /** Distinct scored callees; a callee is correct only when every guess about it is. */
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
      const { outcome } = scoreArity(row, truth);
      if (outcome === 'unscored' || outcome === 'complex') {
        t.unscored++;
        continue;
      }
      t.sites++;
      if (outcome === 'correct') t.correct++;
      else t[outcome]++;
      callee.set(row.target_name!, (callee.get(row.target_name!) ?? true) && outcome === 'correct');
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
    if (!call.arity_complete && call.target_address !== null && fact && !fact.variadic && !fact.complex)
      count++;
  }
  return count;
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

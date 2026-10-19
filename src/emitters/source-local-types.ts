import { appendFileSync } from 'node:fs';
import type { OperationContext } from '../core/index.js';
import { bitWidth, type Expression, type Value } from '../ir/index.js';
import type { BoundaryProjection, Reconstruction } from '../reconstruction/model.js';
import { controlArms } from './source-control.js';
import type { InlineCallSite, InlineSite } from './source-inlining.js';

/** A declared pointer type: its type record and its spelling in the dialect. */
export interface PointerFact {
  /** Absent for a header-declared pointer type that has no type record. */
  readonly type_id?: string;
  readonly spelling: string;
}

/** What one definition or use of a value says about its source type. */
export type Fact = PointerFact | 'scalar';

export interface LocalTypeHost {
  readonly program: Reconstruction;
  readonly context: OperationContext;
  readonly language: 'c-like' | 'python-like';
  readonly pointer_bits: number;
  readonly inline: ReadonlySet<string>;
  readonly inlined: ReadonlyMap<string, InlineSite>;
  readonly inlined_calls: ReadonlyMap<string, InlineCallSite>;
  readonly formals: ReadonlySet<string>;
  /** Constant value of a value printed as a literal. */
  constant(value: Value): bigint | undefined;
  /** Declared source type of a value that already has one; `undefined` when it
   * is printed with its machine width only. */
  known(value: Value): Fact | undefined;
  /** Declared type of a call's parameter, `undefined` past a prototype's fixed
   * parameters or without a prototype. */
  parameter(projection: BoundaryProjection, index: number): Fact | undefined;
  /** Pointer type a load reads through a declared typed global/slot/member. */
  load(id: string): PointerFact | undefined;
  /** The value is the address of an immutable string literal. */
  literal(value: Value): boolean;
  /** Declared result type of the function. */
  readonly result: Fact | undefined;
  /** A value printed as a variable whose type this pass may choose. */
  variable(value: Value): boolean;
}

/** The chosen declared type of every member of one connected set of values. */
export interface LocalTypeChoice {
  readonly fact: PointerFact;
  readonly members: readonly string[];
  /** Why: counts of the evidence the choice rests on. */
  readonly typed_uses: number;
  readonly typed_definitions: number;
}

type Use =
  | { readonly kind: 'pointer'; readonly fact: PointerFact }
  | { readonly kind: 'identity'; readonly other: Value }
  | { readonly kind: 'free' }
  | { readonly kind: 'cast' }
  | { readonly kind: 'block' }
  | { readonly kind: 'deref' };
type Definition =
  | { readonly kind: 'pointer'; readonly fact: PointerFact }
  | { readonly kind: 'zero' }
  | { readonly kind: 'literal' }
  | { readonly kind: 'other' };

interface Evidence {
  readonly facts: Fact[];
  readonly uses: Use[];
  readonly definitions: Definition[];
}

/** Choose a pointer type for sets of integer locals connected by phi copies,
 * from every definition AND every use of the set's members: typed call
 * parameters, typed globals and results, identity tests, dereferences. Sets
 * whose uses need integer arithmetic, conflict, or would cost more conversions
 * than they save keep their integer declaration. Only the choice is made here;
 * every conversion a typed local needs is still printed exactly at its uses
 * and definitions (a pointer read as an integer is `(uintptr_t)p`), so a
 * choice never changes semantics, only how many conversions are printed. */
export function planLocalTypes(host: LocalTypeHost): Map<string, LocalTypeChoice> {
  const program = host.program,
    context = host.context;
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    // Path compression keeps the walks short.
    let walk = id;
    while (walk !== root) {
      const next = parent.get(walk)!;
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };
  const events = new Map<string, Evidence>();
  const ensure = (id: string): Evidence => {
    let row = events.get(id);
    if (!row) {
      row = { facts: [], uses: [], definitions: [] };
      events.set(id, row);
      parent.set(id, id);
    }
    return row;
  };
  const union = (a: string, b: string): void => {
    ensure(a);
    ensure(b);
    const left = find(a),
      right = find(b);
    if (left !== right) parent.set(left, right);
  };
  const values = new Map<string, Value>();
  const operandsOf = (value: Value): Value | undefined => {
    // The printed variable a chain of same-width reinterpretations re-presents.
    for (let step = 0; step < 16; step++) {
      if (host.inlined_calls.has(value.id)) return undefined;
      if (host.variable(value)) return value;
      if (!host.inline.has(value.id)) return undefined;
      const expression = program.expressions.get(value.id);
      const source = identity(expression, value);
      if (!source) return undefined;
      value = source;
    }
    return undefined;
  };
  const identity = (expression: Expression | undefined, value: Value): Value | undefined => {
    if (!expression || value.type.kind !== 'integer') return undefined;
    if (
      (expression.kind === 'cast' &&
        (expression.op === 'bitcast' || expression.op === 'zero_extend')) ||
      (expression.kind === 'extract' && expression.offset === 0)
    )
      return expression.value.type.kind === 'integer' &&
        bitWidth(expression.value.type) === bitWidth(value.type)
        ? expression.value
        : undefined;
    return undefined;
  };
  const record = (value: Value, use: Use): void => {
    values.set(value.id, value);
    ensure(value.id).uses.push(use);
  };
  let work = 0;
  const visit = (value: Value, use: Use, depth = 0): void => {
    context.checkpoint(1);
    if (++work > 1 << 20 || depth > 64) return;
    if (host.inlined_calls.has(value.id)) return;
    const site = host.inlined.get(value.id);
    if (site) {
      if (site.node.kind === 'load') visit(site.node.address, { kind: 'deref' }, depth + 1);
      else expression(program.expressions.get(value.id) ?? site.node.expression, use, depth + 1);
      return;
    }
    if (host.inline.has(value.id)) {
      const body = program.expressions.get(value.id);
      if (body) expression(body, use, depth + 1, value);
      return;
    }
    if (host.variable(value)) record(value, use);
  };
  const expression = (body: Expression, use: Use, depth: number, value?: Value): void => {
    const through = value && identity(body, value);
    if (through) return visit(through, use, depth);
    switch (body.kind) {
      case 'constant':
      case 'address':
      case 'indeterminate':
        return;
      case 'compare': {
        if (body.op === 'eq' || body.op === 'ne') {
          visit(body.left, { kind: 'identity', other: body.right }, depth);
          visit(body.right, { kind: 'identity', other: body.left }, depth);
        } else {
          visit(body.left, { kind: 'cast' }, depth);
          visit(body.right, { kind: 'cast' }, depth);
        }
        return;
      }
      case 'integer':
      case 'integer_unary':
        // Arithmetic on an address: pointer scaling is not the integer's.
        for (const operand of operandsFor(body)) visit(operand, { kind: 'block' }, depth);
        return;
      case 'select':
        visit(body.condition, { kind: 'cast' }, depth);
        visit(body.when_true, { kind: 'cast' }, depth);
        visit(body.when_false, { kind: 'cast' }, depth);
        return;
      default:
        for (const operand of operandsFor(body)) visit(operand, { kind: 'cast' }, depth);
    }
  };
  const operandsFor = (body: Expression): readonly Value[] => {
    switch (body.kind) {
      case 'integer':
        return [body.left, body.right];
      case 'integer_unary':
      case 'cast':
      case 'extract':
        return [body.value];
      case 'float':
      case 'float_compare':
      case 'vector_integer':
      case 'vector_float':
        return [body.left, body.right];
      case 'insert':
        return [body.base, body.value];
      case 'concat':
        return body.values;
      case 'flag':
        return [body.left, body.right, body.carry];
      case 'vector':
        return body.lanes;
      case 'vector_lane':
        return [body.vector];
      case 'vector_insert':
        return [body.vector, body.value];
      case 'float_unary':
        return [body.value];
      default:
        return [];
    }
  };
  /** What defining `result` from `source` says about the result. */
  const define = (result: Value, source: Value): void => {
    const row = ensure(result.id);
    values.set(result.id, result);
    const variable = operandsOf(source);
    if (variable) {
      union(result.id, variable.id);
      values.set(variable.id, variable);
      return;
    }
    if (host.inlined_calls.has(source.id)) {
      const known = host.known(source);
      row.definitions.push(
        known && known !== 'scalar' ? { kind: 'pointer', fact: known } : { kind: 'other' },
      );
      return;
    }
    const site = host.inlined.get(source.id);
    if (site) {
      if (site.node.kind === 'load') {
        const typed = host.load(site.node.id);
        row.definitions.push(typed ? { kind: 'pointer', fact: typed } : { kind: 'other' });
        visit(site.node.address, { kind: 'deref' });
      } else {
        row.definitions.push({ kind: 'other' });
        expression(program.expressions.get(source.id) ?? site.node.expression, { kind: 'cast' }, 1);
      }
      return;
    }
    const body = host.inline.has(source.id) ? program.expressions.get(source.id) : undefined;
    if (body) {
      if (body.kind === 'constant' && host.constant(source) === 0n)
        row.definitions.push({ kind: 'zero' });
      else if (host.literal(source)) row.definitions.push({ kind: 'literal' });
      else {
        row.definitions.push({ kind: 'other' });
        expression(body, { kind: 'cast' }, 1);
      }
      return;
    }
    // Not printed as a variable (a formal, a stack address): an untyped source.
    row.definitions.push({ kind: 'other' });
  };

  const statements = (): void => {
    for (const block of program.blocks.values()) {
      context.checkpoint(1);
      const definitions = (anchor: string): void => {
        for (const definition of program.source?.definitions?.get(anchor) ?? []) {
          if (host.inlined.has(definition.result.id)) continue;
          assign(definition.result, program.expressions.get(definition.result.id) ?? definition.expression);
        }
      };
      const assign = (result: Value, body: Expression): void => {
        if (!host.variable(result)) {
          expression(body, { kind: 'cast' }, 0);
          return;
        }
        const through = identity(body, result);
        if (through) return define(result, through);
        const row = ensure(result.id);
        values.set(result.id, result);
        if (body.kind === 'constant' && host.constant(result) === 0n)
          row.definitions.push({ kind: 'zero' });
        else if (body.kind !== 'integer' && body.kind !== 'integer_unary' && host.literal(result))
          row.definitions.push({ kind: 'literal' });
        else row.definitions.push({ kind: 'other' });
        expression(body, { kind: 'cast' }, 0);
      };
      definitions(block.id);
      for (const node of block.statements) {
        context.checkpoint(1);
        if (program.retained.has(node.id)) {
          switch (node.kind) {
            case 'assign':
              if (!host.inlined.has(node.result.id))
                assign(node.result, program.expressions.get(node.result.id) ?? node.expression);
              break;
            case 'load':
              if (!host.inlined.has(node.result.id)) {
                if (!program.source?.locals.has(node.id)) visit(node.address, { kind: 'deref' });
                if (host.variable(node.result)) {
                  const typed = host.load(node.id);
                  values.set(node.result.id, node.result);
                  ensure(node.result.id).definitions.push(
                    typed ? { kind: 'pointer', fact: typed } : { kind: 'other' },
                  );
                }
              }
              break;
            case 'store':
              if (!program.source?.locals.has(node.id)) visit(node.address, { kind: 'deref' });
              visit(node.value, { kind: 'cast' });
              break;
            case 'write_register':
              visit(node.value, { kind: 'cast' });
              break;
            case 'call': {
              const projection = program.calls.get(node.id);
              (projection?.arguments ?? node.arguments).forEach((value, index) => {
                const declared = projection ? host.parameter(projection, index) : undefined;
                visit(
                  value,
                  declared === undefined
                    ? { kind: 'free' }
                    : declared === 'scalar'
                      ? { kind: 'cast' }
                      : { kind: 'pointer', fact: declared },
                );
              });
              for (const binding of projection?.inputs ?? node.register_inputs)
                visit(binding.value, { kind: 'cast' });
              if (node.target.kind === 'indirect') visit(node.target.value, { kind: 'cast' });
              for (const result of projection?.results ?? node.results)
                if (host.variable(result)) {
                  const known = host.known(result);
                  values.set(result.id, result);
                  const row = ensure(result.id);
                  row.definitions.push(
                    known && known !== 'scalar' ? { kind: 'pointer', fact: known } : { kind: 'other' },
                  );
                }
              break;
            }
            default:
          }
        }
        definitions(node.id);
      }
      definitions(block.control.id);
      const control = block.control;
      if (control.kind === 'if') visit(control.condition, { kind: 'cast' });
      else if (control.kind === 'switch') visit(control.value, { kind: 'cast' });
      else if (control.kind === 'indirect') visit(control.target, { kind: 'cast' });
      else if (control.kind === 'return') {
        const projection = program.returns.get(control.id);
        for (const value of projection?.results ?? control.values)
          visit(
            value,
            host.result && host.result !== 'scalar'
              ? { kind: 'pointer', fact: host.result }
              : { kind: 'cast' },
          );
        for (const binding of projection?.outputs ?? block.register_exit)
          visit(binding.value, { kind: 'cast' });
      }
      for (const binding of program.physical_exits.get(control.id) ?? [])
        visit(binding.value, { kind: 'cast' });
      if (!['return', 'jump', 'if'].includes(control.kind))
        for (const binding of block.register_exit) visit(binding.value, { kind: 'cast' });
      for (const value of program.tails.get(control.id)?.boundary.arguments ?? [])
        visit(value, { kind: 'free' });
      const transfers =
        control.kind === 'jump' ? [control.transfer] : controlArms(control).map((arm) => arm.transfer);
      for (const transfer of transfers)
        for (const copy of program.transfers.get(transfer) ?? []) {
          context.checkpoint(1);
          if (host.variable(copy.destination)) define(copy.destination, copy.source);
          else visit(copy.source, { kind: 'cast' });
        }
    }
  };
  statements();
  for (const [id, value] of values) {
    const known = host.known(value);
    if (known) ensure(id).facts.push(known);
  }

  // Aggregate by connected set.
  const groups = new Map<string, string[]>();
  for (const id of events.keys()) {
    context.checkpoint(1);
    const root = find(id);
    const group = groups.get(root) ?? [];
    group.push(id);
    groups.set(root, group);
  }
  const python = host.language === 'python-like';
  const bare = (spelling: string): string => (python ? spelling : spelling.replace(/^const /, ''));
  const constant = (spelling: string): boolean => !python && spelling.startsWith('const ');
  const isVoid = (spelling: string): boolean =>
    python ? spelling === 'pointer[void]' : bare(spelling) === 'void*';
  const isChar = (spelling: string): boolean =>
    python ? spelling === 'pointer[char]' : bare(spelling) === 'char*';
  const isByte = (spelling: string): boolean =>
    python
      ? /^pointer\[u?int8_t\]$/.test(spelling)
      : /^(?:const )?u?int8_t\*$/.test(spelling);
  const chosen = new Map<string, LocalTypeChoice>();
  for (const members of groups.values()) {
    context.checkpoint(members.length);
    const facts: Fact[] = [],
      uses: Use[] = [],
      definitions: Definition[] = [];
    for (const id of members) {
      const row = events.get(id)!;
      facts.push(...row.facts);
      uses.push(...row.uses);
      definitions.push(...row.definitions);
    }
    if (process.env['OD_DEBUG_TYPES'])
      appendFileSync('/tmp/od-printer/types.log', ['SET', members.join(','), JSON.stringify({facts, uses: uses.map((u) => u.kind + (u.kind === 'pointer' ? ':' + u.fact.spelling : '')), defs: definitions.map((d) => d.kind + (d.kind === 'pointer' ? ':' + d.fact.spelling : ''))})].join(' ') + '\n');
    // A member that already has a scalar declaration keeps the set integer.
    if (facts.includes('scalar')) continue;
    const known = facts.filter((fact): fact is PointerFact => fact !== 'scalar');
    const knownTypes = new Set(known.map((fact) => fact.type_id));
    const knownSpellings = new Set(known.map((fact) => fact.spelling));
    if (knownTypes.size > 1 && knownSpellings.size > 1) continue;
    const typedUses = uses.filter((use): use is Extract<Use, { kind: 'pointer' }> => use.kind === 'pointer');
    const typedDefinitions = definitions.filter(
      (definition): definition is Extract<Definition, { kind: 'pointer' }> =>
        definition.kind === 'pointer',
    );
    const evidence = [
      ...known,
      ...typedUses.map((use) => use.fact),
      ...typedDefinitions.map((definition) => definition.fact),
    ];
    if (!evidence.length) continue;
    const dereferenced = uses.some((use) => use.kind === 'deref');
    // A set is an integer until its uses prove otherwise: arithmetic on it keeps
    // every member as declared, and so does a dereference through an untyped one.
    if (uses.some((use) => use.kind === 'block') || (!known.length && dereferenced)) continue;
    // One pointer type: every spelling names the same pointee, ignoring `void *`
    // (which every object pointer converts to). A byte pointer that is only ever
    // passed on (no dereference) is the library's `char` where one use says so;
    // its generic byte spelling then carries no qualifier of its own.
    const generic = new Set<PointerFact>();
    let types = evidence.filter((fact) => !isVoid(fact.spelling));
    if (!dereferenced && types.some((fact) => isChar(fact.spelling)))
      types = types.map((fact) => {
        if (!isByte(fact.spelling)) return fact;
        const spelled = {
          ...fact,
          spelling: python ? 'pointer[char]' : `${constant(fact.spelling) ? 'const ' : ''}char*`,
        };
        generic.add(spelled);
        return spelled;
      });
    const bases = new Set(types.map((fact) => bare(fact.spelling)));
    if (bases.size > 1) continue;
    const owner = types[0] ?? evidence[0]!;
    // `const` survives only when every evidence item that declares one carries it.
    const declared = [...types, ...evidence.filter((fact) => isVoid(fact.spelling))].filter(
      (fact) => !generic.has(fact),
    );
    const qualified = declared.length > 0 && declared.every((fact) => constant(fact.spelling));
    const spelling = python
      ? owner.spelling
      : `${qualified ? 'const ' : ''}${bare(owner.spelling)}`;
    // The type record of a member that has one, else of the evidence that spells it.
    const typeId =
      known[0]?.type_id ??
      types.find((fact) => fact.type_id !== undefined && bare(fact.spelling) === bare(owner.spelling))
        ?.type_id ??
      evidence.find((fact) => fact.type_id !== undefined)?.type_id;
    if (typeId === undefined) continue;
    // Cost model, in printed conversions: each typed use, identity test and typed
    // definition saves one; each integer use and untyped definition costs one.
    let score = 0;
    for (const use of uses)
      if (use.kind === 'pointer') score++;
      else if (use.kind === 'identity') {
        const zero = host.constant(use.other) === 0n || host.variable(use.other);
        score += zero ? 1 : -1;
      } else if (use.kind === 'cast') score--;
    for (const definition of definitions)
      if (definition.kind === 'pointer') score++;
      else if (definition.kind === 'other') score--;
    if (score < 0) continue;
    chosen.set(members[0]!, {
      fact: { type_id: typeId, spelling },
      members,
      typed_uses: typedUses.length,
      typed_definitions: typedDefinitions.length,
    });
  }
  return chosen;
}

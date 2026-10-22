import type { OperationContext } from '../core/index.js';
import { bitWidth, expressionOperands, type Expression, type Value } from '../ir/index.js';
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
  /** A printed variable whose type this pass may choose. */
  variable(value: Value): boolean;
  /** A formal whose printed spelling (not type) this pass may choose: it has a
   * projected source type and no inferred formal spelling of its own. */
  respell_formal?(id: string): boolean;
}

/** The chosen pointer type of one connected set of locals (formals excluded). */
export interface LocalTypeChoice {
  readonly fact: PointerFact;
  readonly members: readonly string[];
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
 * parameters, typed globals, slots and results, identity tests, dereferences.
 * Sets with conflicting pointee types, a scalar-typed member, or whose integer
 * uses and untyped definitions cost more printed conversions than the typed ones
 * save keep their integer declaration. Only the choice is made here; every
 * conversion a typed local needs is still printed exactly at its uses and
 * definitions (a pointer read as an integer is `(uintptr_t)p`), so a choice never
 * changes semantics, only how many conversions are printed. */
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
  /** Phi copies between two printed variables (destination, source). */
  const copies: [string, string][] = [];
  const operandsOf = (value: Value): Value | undefined => {
    // The printed variable a chain of same-width reinterpretations re-presents.
    for (let step = 0; step < 16; step++) {
      if (host.inlined_calls.has(value.id)) return undefined;
      if (host.variable(value) || host.formals.has(value.id)) return value;
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
    if (host.variable(value) || host.formals.has(value.id)) record(value, use);
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
      copies.push([result.id, variable.id]);
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
          assign(
            definition.result,
            program.expressions.get(definition.result.id) ?? definition.expression,
          );
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
                    known && known !== 'scalar'
                      ? { kind: 'pointer', fact: known }
                      : { kind: 'other' },
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
        control.kind === 'jump'
          ? [control.transfer]
          : controlArms(control).map((arm) => arm.transfer);
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
    python ? /^pointer\[u?int8_t\]$/.test(spelling) : /^(?:const )?u?int8_t\*$/.test(spelling);
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
    // A member that already has a scalar declaration keeps the set integer.
    if (facts.includes('scalar')) continue;
    const typedUses = uses.filter(
      (use): use is Extract<Use, { kind: 'pointer' }> => use.kind === 'pointer',
    );
    const typedDefinitions = definitions.filter(
      (definition): definition is Extract<Definition, { kind: 'pointer' }> =>
        definition.kind === 'pointer',
    );
    // A use or definition that declares the very type record a member already has
    // spells it as its declaration does (a library `const char *` rather than
    // the record's generic `int8_t *`): same type, declared spelling.
    const declaredSpelling = new Map<string, string>();
    for (const fact of [
      ...typedUses.map((use) => use.fact),
      ...typedDefinitions.map((definition) => definition.fact),
    ])
      if (fact.type_id !== undefined && !declaredSpelling.has(fact.type_id))
        declaredSpelling.set(fact.type_id, fact.spelling);
    const known = facts
      .filter((fact): fact is PointerFact => fact !== 'scalar')
      .map((fact) => {
        const spelling =
          fact.type_id === undefined ? undefined : declaredSpelling.get(fact.type_id);
        return spelling === undefined ? fact : { ...fact, spelling };
      });
    const knownTypes = new Set(known.map((fact) => fact.type_id));
    const knownSpellings = new Set(known.map((fact) => fact.spelling));
    if (knownTypes.size > 1 && knownSpellings.size > 1) continue;
    const evidence = [
      ...known,
      ...typedUses.map((use) => use.fact),
      ...typedDefinitions.map((definition) => definition.fact),
    ];
    if (!evidence.length) continue;
    const dereferenced = uses.some((use) => use.kind === 'deref');
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
      types.find(
        (fact) => fact.type_id !== undefined && bare(fact.spelling) === bare(owner.spelling),
      )?.type_id ??
      evidence.find((fact) => fact.type_id !== undefined)?.type_id;
    // Cost model, in printed conversions, over the members that are not already
    // pointers. A pointer local read in integer context prints `(uintptr_t)p` and
    // an integer expression assigned to it `(T*)expr`: every typed use and
    // definition, pointer identity test and copy from a pointer variable saves one
    // conversion; every integer use (arithmetic, comparison, raw dereference,
    // store) and untyped definition adds one. A set of integers becomes pointers
    // only for a saving; members next to an existing pointer, on a tie.
    const pointerMember = (id: string): boolean =>
      events.get(id)!.facts.some((fact) => fact !== 'scalar');
    let score = 0;
    for (const id of members) {
      if (pointerMember(id)) continue;
      const row = events.get(id)!;
      for (const use of row.uses)
        if (use.kind === 'pointer') score++;
        else if (use.kind === 'identity') {
          const pointerLike = host.constant(use.other) === 0n || host.variable(use.other);
          score += pointerLike ? 1 : -1;
        } else score--;
      for (const definition of row.definitions)
        if (definition.kind === 'pointer' || definition.kind === 'literal') score++;
        else if (definition.kind === 'other') score--;
    }
    const memberSet = new Set(members);
    for (const [to, from] of copies)
      if (memberSet.has(to) && pointerMember(to) !== pointerMember(from)) score++;
    if (score < (known.length ? 0 : 1)) continue;
    // A formal joins only to take its own type's declared spelling: the source
    // type it already has stays, so no value or conversion changes.
    const assignable = members.filter(
      (id) =>
        !host.formals.has(id) ||
        (typeId !== undefined &&
          host.respell_formal?.(id) === true &&
          events.get(id)!.facts.length > 0 &&
          events.get(id)!.facts.every((fact) => fact !== 'scalar' && fact.type_id === typeId)),
    );
    if (!assignable.length) continue;
    chosen.set(assignable[0]!, {
      fact: { ...(typeId === undefined ? {} : { type_id: typeId }), spelling },
      members: assignable,
    });
  }
  return chosen;
}

/** What the integer spelling planner needs from the renderer. */
export interface IntegerSpellingHost {
  readonly program: Reconstruction;
  readonly context: OperationContext;
  /** Values printed inside the expression that reads them. */
  readonly inline: ReadonlySet<string>;
  /** A printed integer local declared with its machine spelling (`uintN_t`)
   * whose declared type this pass may choose. */
  variable(value: Value): boolean;
  /** Constant value of a value printed as a literal. */
  constant(value: Value): bigint | undefined;
}

/** The C integer type chosen for one connected set of integer locals. */
export interface IntegerSpelling {
  readonly bits: 8 | 16 | 32;
  readonly signed: boolean;
  /** Present for a 64-bit set whose every read is a low-slice read. */
  readonly narrow: boolean;
  readonly members: readonly string[];
  /** Printed conversions of the machine spelling, and of the chosen one. */
  readonly before: number;
  readonly after: number;
}

interface IntegerCost {
  /** Conversions printed by the unsigned spelling of the set's width. */
  unsigned: number;
  /** Conversions printed by the signed spelling of the same width. */
  signed: number;
  /** A read whose cost the model does not capture: keep the machine spelling. */
  veto: boolean;
}

/** C only: choose `intN_t` for a set of 8/16/32-bit integer locals connected by
 * copies when it prints strictly fewer conversions than `uintN_t`, and declare a
 * 64-bit set whose every read is a low-slice read (a truncation, or an extract
 * inside the low 32 bits) at that narrow width (signed when that is strictly
 * cheaper still). Costs count the conversions each read prints:
 * - cheap when signed: signed comparison, sign extension, arithmetic shift and
 *   signed division/remainder by a constant (the unsigned spelling prints
 *   `(intN_t)x` there);
 * - every other read of a signed local prints `(uintN_t)x`, so addition,
 *   subtraction, multiplication and shifts stay in unsigned arithmetic (no
 *   signed overflow) and unsigned comparisons, zero extension, logical shifts
 *   and unsigned division keep their exact operand; equality of at least `int`
 *   width and truncation print none either way.
 * C assignment converts every definition to the declared type, exactly as the
 * cast the unsigned spelling would print at the read (the modular conversion of
 * the same bits), so definitions cost nothing. Presentation only: each read
 * still prints its exact conversion, so values, widths and evaluation order are
 * unchanged. */
export function planIntegerSpellings(host: IntegerSpellingHost): Map<string, IntegerSpelling> {
  const program = host.program,
    context = host.context;
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let walk = id;
    while (walk !== root) {
      const next = parent.get(walk)!;
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };
  const values = new Map<string, Value>();
  const admit = (value: Value): boolean => {
    if (!values.has(value.id)) {
      if (!host.variable(value)) return false;
      values.set(value.id, value);
      parent.set(value.id, value.id);
    }
    return true;
  };
  /** The value a chain of inline same-width reinterpretations re-presents. */
  const identity = (value: Value): Value | undefined => {
    if (!host.inline.has(value.id) || value.type.kind !== 'integer') return undefined;
    const expression = program.expressions.get(value.id);
    if (
      !expression ||
      !(
        (expression.kind === 'cast' &&
          (expression.op === 'bitcast' || expression.op === 'zero_extend')) ||
        (expression.kind === 'extract' && expression.offset === 0)
      )
    )
      return undefined;
    return expression.value.type.kind === 'integer' &&
      bitWidth(expression.value.type) === bitWidth(value.type)
      ? expression.value
      : undefined;
  };
  const resolve = (value: Value): Value => {
    for (let step = 0; step < 16; step++) {
      const inner = identity(value);
      if (!inner) return value;
      value = inner;
    }
    return value;
  };
  // Users of each value among the live printed expressions, and the copies
  // between printed variables (edge copies and pure same-width assignments).
  const users = new Map<string, { readonly value: Value; readonly expression: Expression }[]>();
  const occurrences = new Map<string, number>();
  for (const [id, expression] of program.expressions) {
    context.checkpoint(1);
    const value = program.values.get(id);
    if (!value || !program.live.has(id)) continue;
    for (const operand of expressionOperands(expression)) {
      occurrences.set(operand.id, (occurrences.get(operand.id) ?? 0) + 1);
      const row = users.get(operand.id) ?? [];
      row.push({ value, expression });
      users.set(operand.id, row);
    }
  }
  /** Copies whose source is a value, by destination: they read it once each. */
  const copies = new Map<string, Value[]>();
  const copySources = new Set<string>();
  /** Members whose partition the renderer would join with a variable outside
   * the set: a copy from or to another printed variable (a formal, a typed
   * local), or a zero extension into shared unsigned storage. */
  const fixed = new Set<string>();
  const widened = (value: Value): boolean => {
    const expression = host.inline.has(value.id) ? program.expressions.get(value.id) : undefined;
    return (
      expression?.kind === 'cast' &&
      expression.op === 'zero_extend' &&
      !host.inline.has(expression.value.id)
    );
  };
  const join = (destination: Value, source: Value): void => {
    const left = admit(destination),
      right = admit(source);
    if (left && right) {
      const a = find(destination.id),
        b = find(source.id);
      if (a !== b) parent.set(a, b);
    } else if (left && !host.inline.has(source.id)) fixed.add(destination.id);
    else if (right && !host.inline.has(destination.id)) fixed.add(source.id);
  };
  for (const row of program.transfers.values())
    for (const copy of row) {
      context.checkpoint(1);
      copySources.add(copy.source.id);
      const list = copies.get(copy.source.id) ?? [];
      list.push(copy.destination);
      copies.set(copy.source.id, list);
      if (widened(copy.source) && admit(copy.destination)) fixed.add(copy.destination.id);
      join(copy.destination, resolve(copy.source));
    }
  for (const block of program.blocks.values())
    for (const node of block.statements) {
      context.checkpoint(1);
      if (node.kind !== 'assign' || !program.retained.has(node.id)) continue;
      const expression = program.expressions.get(node.result.id) ?? node.expression;
      if (expression.kind !== 'cast') continue;
      if (
        expression.op === 'zero_extend' &&
        !host.inline.has(expression.value.id) &&
        admit(node.result)
      )
        fixed.add(node.result.id);
      if (expression.op !== 'bitcast') continue;
      const source = resolve(expression.value);
      if (bitWidth(source.type) === bitWidth(node.result.type)) join(node.result, source);
    }
  for (const id of program.live) {
    const value = program.values.get(id);
    if (value) admit(value);
  }
  const groups = new Map<string, string[]>();
  for (const id of values.keys()) {
    const root = find(id);
    const group = groups.get(root) ?? [];
    group.push(id);
    groups.set(root, group);
  }
  const weight = (value: Value): number =>
    host.inline.has(value.id) ? Math.max(1, program.use_counts.get(value.id) ?? 1) : 1;
  /** Reads of `value` that are neither a live printed expression nor a copy
   * into the set: statements, call arguments, returns, other copies. */
  const others = (value: Value, members: ReadonlySet<string>): number => {
    const inside = (copies.get(value.id) ?? []).filter((destination) =>
      members.has(destination.id),
    ).length;
    return Math.max(
      0,
      (program.use_counts.get(value.id) ?? 0) - (occurrences.get(value.id) ?? 0) - inside,
    );
  };
  /** Conversions each spelling of an N-bit value prints at the reads of `value`. */
  const score = (
    value: Value,
    scale: number,
    bits: number,
    members: ReadonlySet<string>,
    cost: IntegerCost,
    depth = 0,
  ): void => {
    context.checkpoint(1);
    if (depth > 16) {
      cost.veto = true;
      return;
    }
    cost.signed += others(value, members) * scale;
    for (const { value: user, expression } of users.get(value.id) ?? []) {
      const times = scale * weight(user);
      if (identity(user)?.id === value.id) {
        score(user, times, bits, members, cost, depth + 1);
        continue;
      }
      switch (expression.kind) {
        case 'compare':
          if (expression.op.startsWith('s')) cost.unsigned += times;
          else if (expression.op.startsWith('u') || bits < 32) cost.signed += times;
          break;
        case 'cast':
          if (expression.op === 'sign_extend' || expression.op === 'signed_to_float')
            cost.unsigned += times;
          else if (expression.op === 'zero_extend') {
            // A zero extension into a variable may share its storage only
            // while the narrow local keeps its plain unsigned spelling.
            if (!host.inline.has(user.id) || copySources.has(user.id)) cost.veto = true;
            cost.signed += times;
          } else if (expression.op !== 'truncate') cost.signed += times;
          break;
        case 'extract':
          if (expression.offset !== 0) cost.signed += times;
          break;
        case 'integer': {
          const divisor = host.constant(expression.right);
          if (
            expression.left.id === value.id &&
            expression.right.id !== value.id &&
            divisor !== undefined &&
            (expression.op === 'ashr' ||
              ((expression.op === 'sdiv' || expression.op === 'srem') &&
                divisor !== 0n &&
                BigInt.asIntN(bits, divisor) !== -1n))
          )
            cost.unsigned += times;
          else cost.signed += times;
          break;
        }
        default:
          cost.signed += times;
      }
    }
  };
  const chosen = new Map<string, IntegerSpelling>();
  for (const members of groups.values()) {
    context.checkpoint(members.length);
    if (members.some((id) => fixed.has(id))) continue;
    const set = new Set(members);
    const widths = new Set(members.map((id) => bitWidth(values.get(id)!.type)));
    if (widths.size !== 1) continue;
    const [width] = widths;
    if (width === 8 || width === 16 || width === 32) {
      const cost: IntegerCost = { unsigned: 0, signed: 0, veto: false };
      for (const id of members) score(values.get(id)!, 1, width, set, cost);
      if (!cost.veto && cost.signed < cost.unsigned)
        chosen.set(members[0]!, {
          bits: width,
          signed: true,
          narrow: false,
          members,
          before: cost.unsigned,
          after: cost.signed,
        });
      continue;
    }
    if (width !== 64) continue;
    // Every read, through same-width reinterpretations, is a low-slice read.
    const slices: { readonly value: Value; readonly bits: number; readonly scale: number }[] = [];
    let valid = true,
      low = 0;
    const reads = (value: Value, scale: number, depth = 0): void => {
      context.checkpoint(1);
      if (depth > 16 || others(value, set) > 0) {
        valid = false;
        return;
      }
      for (const { value: user, expression } of users.get(value.id) ?? []) {
        if (!valid) return;
        const times = scale * weight(user);
        if (identity(user)?.id === value.id) reads(user, times, depth + 1);
        else if (
          (expression.kind === 'cast' && expression.op === 'truncate') ||
          (expression.kind === 'extract' && expression.offset + bitWidth(user.type) <= 32)
        ) {
          const offset = expression.kind === 'extract' ? expression.offset : 0;
          low = Math.max(low, offset + bitWidth(user.type));
          if (low > 32) valid = false;
          else if (offset === 0)
            slices.push({ value: user, bits: bitWidth(user.type), scale: times });
        } else valid = false;
      }
    };
    for (const id of members) reads(values.get(id)!, 1);
    if (!valid || low === 0) continue;
    const bits = low <= 8 ? 8 : low <= 16 ? 16 : 32;
    // Each read of the presented width prints `(uintN_t)x` today and the
    // narrow variable itself once declared narrow; its readers then price the
    // signed spelling like those of an N-bit local.
    const exact = slices.filter((slice) => slice.bits === bits);
    const cost: IntegerCost = { unsigned: 0, signed: 0, veto: false };
    const saved = exact.reduce((sum, slice) => sum + slice.scale, 0);
    for (const slice of exact)
      if (host.inline.has(slice.value.id)) score(slice.value, slice.scale, bits, new Set(), cost);
    if (saved === 0) continue;
    const signed = !cost.veto && cost.signed < cost.unsigned;
    chosen.set(members[0]!, {
      bits,
      signed,
      narrow: true,
      members,
      before: saved + cost.unsigned,
      after: signed ? cost.signed : cost.unsigned,
    });
  }
  return chosen;
}

import {
  entityIdentity,
  fingerprint,
  type DataLayout,
  type Evidence,
  type OperationContext,
  type RecoveredType,
} from '../../core/index.js';
import { bitWidth, successors, type Expression, type SSAForm, type Value } from '../../ir/index.js';
import { AnalysisBudget } from '../ssa/budget.js';
import { SourceLayouts, typeKey } from './layout.js';
import {
  createAffineResolver,
  memoryAddressSources,
  memoryLoopParameters,
} from './memory-shapes.js';
import type { SuppliedTypeRecord, TypeAssociation, TypeRecoveryResult } from './model.js';

/** A constant displacement beyond this bound is an object address added to an
 * index (`table + i`), not a small offset from a pointer held in the base. */
const MAX_POINTER_DISPLACEMENT = 0x10000n;

export type PointerRule =
  | 'dereferenced address'
  | 'declared or observed pointer'
  | 'pointer arithmetic'
  | 'joined pointer values'
  | 'compared with a pointer';

export interface PointerEvidenceOptions {
  readonly slice_id: string;
  readonly revision: number;
  readonly layout: DataLayout;
  readonly max_work?: number;
}

/** Image-wide pointer-ness of whole machine-width SSA values. A value holds an
 * address when it is dereferenced (as the address or its small-offset base),
 * already carries a declared/observed pointer association (prototype
 * parameters, allocator and other library results, callee summaries and image
 * flows are associations by now), is `pointer ± integer` (but not
 * `pointer - pointer`), joins only through exact copies or phi/select from a
 * pointer, or is compared with a pointer. Two integers compared, an integer
 * merely used in arithmetic, or a constant never become pointers. Every member
 * gets one analysis-candidate `void *` association with the rule that proved
 * it; stronger declared or layout pointer types remain separate alternatives
 * that projection prefers. Stack addresses are excluded (frame storage). */
export function recoverPointerEvidence(
  input: SSAForm,
  types: TypeRecoveryResult,
  context: OperationContext,
  options: PointerEvidenceOptions,
): TypeRecoveryResult {
  if (types.state !== 'complete') return types;
  const budget = new AnalysisBudget({
    max_work: options.max_work ?? context.remainingWork?.() ?? context.budget.work,
    checkpoint: (work) => context.checkpoint(work),
  });
  const bits = 64;
  const stack = types.calls?.stack;
  const definitions = new Map<string, Expression>();
  const values = new Map<string, Value>();
  const remember = (value: Value): void => {
    cells.set(value.id, value);
    if (value.type.kind === 'integer' && value.type.bits === bits) values.set(value.id, value);
  };
  /** Values that receive another value's exact bits: phi arguments, selects
   * and same-width copies. */
  const joins = new Map<string, string[]>();
  const join = (from: Value, to: Value): void => {
    if (bitWidth(from.type) !== bitWidth(to.type)) return;
    const list = joins.get(from.id) ?? [];
    list.push(to.id);
    joins.set(from.id, list);
  };
  /** Exact same-width copies, joined both ways: one value under two IDs. */
  const copies = new Set<string>();
  const copy = (a: Value, b: Value): void => {
    if (bitWidth(a.type) !== bitWidth(b.type)) return;
    join(a, b);
    join(b, a);
    copies.add(`${a.id}>${b.id}`).add(`${b.id}>${a.id}`);
  };
  /** Exact physical cells of a whole value (`concat` parts, narrow `extract`s):
   * a pointer split across register cells keeps its fragments. */
  const parts = new Map<string, { part: Value; offset: number }[]>();
  const wholes = new Map<string, { whole: string; offset: number }[]>();
  const slices = new Map<string, { part: Value; offset: number }[]>();
  /** Whole values each narrow `extract` slices. */
  const sliceOwners = new Map<string, string[]>();
  const identities: {
    result: Value;
    expression: Extract<Expression, { kind: 'integer' }>;
  }[] = [];
  const cells = new Map<string, Value>();
  const users = new Map<string, { result: Value; expression: Expression; node: string }[]>();
  const use = (operand: Value, result: Value, expression: Expression, node: string): void => {
    const list = users.get(operand.id) ?? [];
    list.push({ result, expression, node });
    users.set(operand.id, list);
  };
  const addresses: { address: Value; node: string; evidence: readonly string[] }[] = [];
  const stackNodes = new Set(stack?.accesses.map((access) => access.node_id) ?? []);
  const blocks = new Map(input.blocks.map((block) => [block.id, block]));
  for (const block of input.blocks) {
    budget.charge();
    for (const value of block.parameters) remember(value);
    for (const node of block.instructions) {
      budget.charge();
      if ('result' in node) remember(node.result);
      if (node.kind === 'call') for (const value of node.results) remember(value);
      if ('register_outputs' in node)
        for (const binding of node.register_outputs) remember(binding.value);
      if ((node.kind === 'load' || node.kind === 'store') && !stackNodes.has(node.id))
        addresses.push({
          address: node.address,
          node: node.id,
          evidence: node.provenance.evidence_ids,
        });
      if (node.kind !== 'assign') continue;
      const e = node.expression;
      definitions.set(node.result.id, e);
      if (e.kind === 'concat' && bitWidth(node.result.type) === bits) {
        let offset = 0;
        const list: { part: Value; offset: number }[] = [];
        for (const part of e.values) {
          budget.charge();
          list.push({ part, offset });
          const owners = wholes.get(part.id) ?? [];
          owners.push({ whole: node.result.id, offset });
          wholes.set(part.id, owners);
          offset += bitWidth(part.type);
        }
        parts.set(node.result.id, list);
      } else if (
        e.kind === 'extract' &&
        bitWidth(e.value.type) === bits &&
        (e.offset !== 0 || bitWidth(node.result.type) !== bits)
      ) {
        const list = slices.get(e.value.id) ?? [];
        list.push({ part: node.result, offset: e.offset });
        slices.set(e.value.id, list);
        const owners = sliceOwners.get(node.result.id) ?? [];
        owners.push(e.value.id);
        sliceOwners.set(node.result.id, owners);
      }
      if (e.kind === 'select') {
        join(e.when_true, node.result);
        join(e.when_false, node.result);
      } else if (
        (e.kind === 'cast' && e.op === 'bitcast') ||
        (e.kind === 'extract' && e.offset === 0)
      ) {
        // A same-width copy is the same value: pointer-ness holds both ways
        // (an argument register's copy of a local is that local).
        copy(e.value, node.result);
      } else if (e.kind === 'integer' && (e.op === 'add' || e.op === 'sub')) {
        use(e.left, node.result, e, node.id);
        use(e.right, node.result, e, node.id);
        identities.push({ result: node.result, expression: e });
      } else if (e.kind === 'integer' && (e.op === 'or' || e.op === 'xor' || e.op === 'and')) {
        identities.push({ result: node.result, expression: e });
      } else if (e.kind === 'compare') {
        use(e.left, node.result, e, node.id);
        use(e.right, node.result, e, node.id);
      }
    }
    for (const edge of successors(block.terminator)) {
      const target = blocks.get(edge.target);
      if (target)
        edge.arguments.forEach((value, index) => {
          const parameter = target.parameters[index];
          if (parameter) join(value, parameter);
        });
    }
  }
  const constant = (id: string): bigint | undefined => {
    const fact = stack?.values.get(id)?.value;
    if (fact?.kind === 'constant') return fact.bits;
    const expression = definitions.get(id);
    return expression?.kind === 'constant' ? expression.bits : undefined;
  };
  // `x | 0`, `x ^ 0`, `x + 0`, `x - 0` and `x & ~0` are exact copies of `x`
  // (AArch64 `mov xd, xn` is `orr xd, xzr, xn`): pointer-ness holds both ways.
  for (const { result, expression } of identities) {
    budget.charge();
    const width = bitWidth(result.type);
    const ones = (1n << BigInt(width)) - 1n;
    const neutral = (value: Value): boolean => {
      const bits = constant(value.id);
      return (
        bits !== undefined && BigInt.asUintN(width, bits) === (expression.op === 'and' ? ones : 0n)
      );
    };
    const source =
      neutral(expression.right) && expression.left.id !== result.id
        ? expression.left
        : expression.op !== 'sub' && neutral(expression.left)
          ? expression.right
          : undefined;
    if (!source) continue;
    copy(source, result);
  }
  const eligible = (id: string): boolean =>
    values.has(id) && constant(id) === undefined && stack?.values.get(id)?.value.kind !== 'stack';
  const affine = createAffineResolver(
    definitions,
    constant,
    budget,
    memoryAddressSources(input, budget),
    memoryLoopParameters(input, budget),
  );
  const records = new Map<string, SuppliedTypeRecord[]>();
  for (const record of types.types) {
    budget.charge();
    const list = records.get(record.id) ?? [];
    list.push(record);
    records.set(record.id, list);
  }
  const layouts = new SourceLayouts(records, budget, options.layout);
  const evidence: Evidence[] = [];
  const seen = new Set(types.evidence.map((item) => item.id));
  const reason = (rule: PointerRule, subject: string, parents: readonly string[]): string => {
    budget.charge(parents.length + 1);
    const derived_from = [...new Set(parents)].sort();
    const id = `evidence_${fingerprint([options.slice_id, input.id, 'pointer-evidence', rule, subject, derived_from])}`;
    if (!seen.has(id)) {
      seen.add(id);
      evidence.push({
        id,
        origin: { kind: 'analysis', analyzer: 'pointer-evidence', version: '1', rule },
        claim: `${rule}: the value holds a machine address; its pointee type is not implied`,
        derived_from,
        conflicts_with: [],
        revision: options.revision,
      });
    }
    return id;
  };
  const proofs = new Map<string, string>();
  const pending: string[] = [];
  let cursor = 0;
  /** How each derived member was reached: from which member, with which byte
   * displacement (null: a variable integer addend), or as a join/comparison. */
  const derivations = new Map<string, { from: string; displacement: bigint | null | 'same' }[]>();
  const add = (
    id: string,
    rule: PointerRule,
    parents: readonly string[],
    from?: { from: string; displacement: bigint | null | 'same' },
  ): void => {
    if (from && eligible(id)) {
      const list = derivations.get(id) ?? [];
      list.push(from);
      derivations.set(id, list);
    }
    if (proofs.has(id) || !eligible(id)) return;
    proofs.set(id, reason(rule, id, parents));
    pending.push(id);
  };
  const seeds = new Map<string, string[]>();
  /** Register cells of members: bit offset within the pointer they carry, and
   * the declared pointer type when one association seeded the fragment. */
  const fragments = new Map<string, { offset: number; proof: string; type?: string }>();
  const fragmentQueue: string[] = [];
  let fragmentCursor = 0;
  const addFragment = (part: Value, offset: number, proof: string, type?: string): void => {
    if (fragments.has(part.id) || constant(part.id) !== undefined) return;
    fragments.set(part.id, { offset, proof, ...(type === undefined ? {} : { type }) });
    fragmentQueue.push(part.id);
  };
  /** Wholes rebuilt from fragments that all carry one declared pointer type. */
  const reassembled = new Map<string, string>();
  /** `whole` is the pointer when these cells, each holding the pointer's bits at
   * its own position, cover every bit of it. */
  const reassemble = (whole: string, cellsOf: readonly { part: Value; offset: number }[]): void => {
    const placed = cellsOf
      .filter((cell) => fragments.get(cell.part.id)?.offset === cell.offset)
      .sort((a, b) => a.offset - b.offset);
    let covered = 0;
    for (const cell of placed)
      if (cell.offset <= covered)
        covered = Math.max(covered, cell.offset + bitWidth(cell.part.type));
    if (covered < bits) return;
    const used = placed.map((cell) => fragments.get(cell.part.id)!);
    const type = used[0]!.type;
    if (type !== undefined && used.every((item) => item.type === type) && !reassembled.has(whole))
      reassembled.set(whole, type);
    add(
      whole,
      'joined pointer values',
      used.map((item) => item.proof),
    );
  };
  for (const access of addresses) {
    budget.charge();
    add(access.address.id, 'dereferenced address', access.evidence);
    const resolved = affine(access.address);
    if (
      resolved.base !== access.address.id &&
      resolved.offset >= -MAX_POINTER_DISPLACEMENT &&
      resolved.offset <= MAX_POINTER_DISPLACEMENT
    )
      add(resolved.base, 'dereferenced address', access.evidence);
  }
  // Seeds: existing whole-value pointer associations, in deterministic order.
  for (const association of [...types.associations].sort((a, b) => a.id.localeCompare(b.id))) {
    budget.charge();
    if (
      association.status === 'conflicting' ||
      association.status === 'hypothesis' ||
      association.machine_offset_bits !== 0 ||
      association.width_bits === null ||
      layouts.definition(association.type_id)?.kind !== 'pointer'
    )
      continue;
    const cell = cells.get(association.subject_id);
    if (
      cell &&
      association.width_bits === bitWidth(cell.type) &&
      association.width_bits < bits &&
      association.value_offset_bits + association.width_bits <= bits
    ) {
      addFragment(
        cell,
        association.value_offset_bits,
        reason('declared or observed pointer', cell.id, association.evidence_ids),
        association.type_id,
      );
      continue;
    }
    if (association.value_offset_bits !== 0 || association.width_bits !== bits) continue;
    const list = seeds.get(association.subject_id) ?? [];
    list.push(association.type_id);
    seeds.set(association.subject_id, list);
    add(association.subject_id, 'declared or observed pointer', association.evidence_ids);
  }
  // `pointer - x` derives a pointer only when `x` is not itself a pointer; that
  // is decided after every other rule reached its fixpoint.
  const differences: { result: Value; right: Value; node: string; left: string }[] = [];
  const drain = (): void => {
    while (cursor < pending.length || fragmentCursor < fragmentQueue.length) {
      for (; fragmentCursor < fragmentQueue.length; fragmentCursor++) {
        const id = fragmentQueue[fragmentCursor]!,
          fragment = fragments.get(id)!;
        for (const target of joins.get(id) ?? []) {
          budget.charge();
          addFragment(cells.get(target)!, fragment.offset, fragment.proof, fragment.type);
        }
        // Every cell of a reassembly (`concat` parts, or narrow `extract`s of
        // one whole) in its own position: the whole pointer.
        for (const { whole, offset } of wholes.get(id) ?? []) {
          budget.charge();
          if (offset === fragment.offset) reassemble(whole, parts.get(whole)!);
        }
        for (const whole of sliceOwners.get(id) ?? []) {
          budget.charge(slices.get(whole)!.length);
          reassemble(whole, slices.get(whole)!);
        }
      }
      if (cursor < pending.length) step(pending[cursor++]!);
    }
  };
  const step = (id: string): void => {
    const proof = [proofs.get(id)!];
    for (const { part, offset } of [...(parts.get(id) ?? []), ...(slices.get(id) ?? [])]) {
      budget.charge();
      addFragment(part, offset, proof[0]!);
    }
    for (const target of joins.get(id) ?? []) {
      budget.charge();
      add(target, 'joined pointer values', proof, { from: id, displacement: 'same' });
    }
    for (const { result, expression, node } of users.get(id) ?? []) {
      budget.charge();
      if (expression.kind === 'integer') {
        const other = expression.left.id === id ? expression.right : expression.left;
        const addend = constant(other.id);
        const displacement =
          addend === undefined
            ? null
            : BigInt.asIntN(bits, addend) * (expression.op === 'sub' ? -1n : 1n);
        if (expression.op === 'add')
          add(result.id, 'pointer arithmetic', proof, { from: id, displacement });
        else if (expression.left.id === id && expression.right.id !== id) {
          if (addend !== undefined)
            add(result.id, 'pointer arithmetic', proof, { from: id, displacement });
          else differences.push({ result, right: expression.right, node, left: id });
        }
      } else if (expression.kind === 'compare') {
        const other = expression.left.id === id ? expression.right : expression.left;
        if (other.id !== id)
          add(other.id, 'compared with a pointer', proof, { from: id, displacement: 'same' });
      }
    }
  };
  drain();
  for (let index = 0; index < differences.length; index++) {
    const item = differences[index]!;
    budget.charge();
    if (!proofs.has(item.right.id))
      add(item.result.id, 'pointer arithmetic', [proofs.get(item.left)!], {
        from: item.left,
        displacement: null,
      });
    drain();
  }
  if (!proofs.size && !fragments.size) return types;
  // C typing of `p ± k` and of a copy/join of `p`: a member derived only from
  // pointers to one scalar element type (a scalar, or an observed view whose
  // members are all that scalar at element-aligned offsets) by whole-element
  // steps points to that element too. Anything else stays `void *`.
  interface Element {
    readonly key: string;
    readonly type_id: string;
    readonly size: bigint;
  }
  const scalar = (type_id: string): Element | null => {
    const type = layouts.definition(type_id);
    return (type?.kind === 'integer' || type?.kind === 'float') && type.bits % 8 === 0
      ? { key: typeKey(type), type_id, size: BigInt(type.bits / 8) }
      : null;
  };
  const elementOf = (pointer: string): Element | null => {
    const type = layouts.definition(pointer);
    if (type?.kind !== 'pointer') return null;
    const pointee = layouts.definition(type.to);
    if (pointee?.kind !== 'structure') return scalar(type.to);
    let element: Element | null = null;
    for (const field of pointee.fields) {
      budget.charge();
      const member = layouts.definition(field.type_id);
      const item = scalar(member?.kind === 'array' ? member.element : field.type_id);
      if (!item || (element && element.key !== item.key) || field.offset % item.size !== 0n)
        return null;
      element ??= item;
    }
    return element;
  };
  const elements = new Map<string, Element | null>();
  const queue: string[] = [];
  for (const [id, list] of seeds) {
    budget.charge(list.length);
    const found = list.map(elementOf);
    const first = found[0] ?? null;
    elements.set(id, first && found.every((item) => item?.key === first.key) ? first : null);
    queue.push(id);
  }
  const dependents = new Map<string, string[]>();
  for (const [id, list] of derivations)
    for (const { from } of list) {
      budget.charge();
      const users = dependents.get(from) ?? [];
      users.push(id);
      dependents.set(from, users);
    }
  const derived = (id: string): Element | null | undefined => {
    let result: Element | null | undefined;
    for (const { from, displacement } of derivations.get(id) ?? []) {
      budget.charge();
      if (!elements.has(from)) continue;
      const source = elements.get(from)!;
      const kept =
        source &&
        (displacement === 'same' ||
          (displacement === null ? source.size === 1n : displacement % source.size === 0n))
          ? source
          : null;
      if (result === undefined) result = kept;
      else if (result && kept?.key !== result.key) result = null;
      if (result === null) break;
    }
    return result;
  };
  for (let index = 0; index < queue.length; index++) {
    for (const id of dependents.get(queue[index]!) ?? []) {
      if (seeds.has(id)) continue;
      const next = derived(id);
      const previous = elements.get(id);
      if (
        next === undefined ||
        (elements.has(id) && (previous?.key ?? null) === (next?.key ?? null))
      )
        continue;
      elements.set(id, next);
      queue.push(id);
    }
  }
  // An exact copy, phi or select all of whose sources hold one object pointer
  // type (or are the null constant) holds that type too: a declared or observed
  // `T *` survives register moves and control-flow joins instead of decaying to
  // `void *`. Comparisons and arithmetic never carry a pointee type here.
  const objectTypes = new Map<string, { key: string; type_id: string }>();
  for (const [id, list] of seeds) {
    budget.charge(list.length);
    const objects = new Map<string, string>();
    for (const type_id of list) {
      const type = layouts.definition(type_id);
      if (type?.kind === 'pointer' && layouts.definition(type.to)?.kind !== 'void')
        objects.set(typeKey(type), type_id);
    }
    if (objects.size === 1) {
      const [key, type_id] = [...objects][0]!;
      objectTypes.set(id, { key, type_id });
    }
  }
  // A whole rebuilt from cells that all carry one declared pointer type is that
  // pointer: a prototype's `const char *` bound to two 32-bit register cells.
  for (const [id, type_id] of [...reassembled].sort(([a], [b]) => a.localeCompare(b))) {
    budget.charge();
    const type = layouts.definition(type_id);
    if (
      !seeds.has(id) &&
      !objectTypes.has(id) &&
      type?.kind === 'pointer' &&
      layouts.definition(type.to)?.kind !== 'void'
    )
      objectTypes.set(id, { key: typeKey(type), type_id });
  }
  const joinSources = new Map<string, string[]>();
  for (const [from, targets] of joins)
    for (const to of targets) {
      budget.charge();
      const list = joinSources.get(to) ?? [];
      list.push(from);
      joinSources.set(to, list);
    }
  const objectQueue = [...objectTypes.keys()].sort();
  for (let index = 0; index < objectQueue.length; index++)
    for (const to of joins.get(objectQueue[index]!) ?? []) {
      budget.charge();
      if (seeds.has(to) || objectTypes.has(to) || !proofs.has(to)) continue;
      let found: { key: string; type_id: string } | undefined;
      let exact = true;
      for (const from of joinSources.get(to) ?? []) {
        budget.charge();
        const source = objectTypes.get(from);
        // An untyped exact copy is the same value, not another incoming one.
        if (!source && copies.has(`${from}>${to}`)) continue;
        if (source && (!found || found.key === source.key)) found = source;
        else if (source || constant(from) !== 0n) exact = false;
      }
      if (!exact || !found) continue;
      objectTypes.set(to, found);
      objectQueue.push(to);
    }
  const voidId = entityIdentity(options.slice_id, 'pointer-evidence-type', [input.id, 'void']);
  const pointerId = entityIdentity(options.slice_id, 'pointer-evidence-type', [
    input.id,
    'pointer',
  ]);
  const allProofs = [...new Set(proofs.values())].sort();
  const definition: RecoveredType = { kind: 'pointer', bits, to: voidId };
  const added: SuppliedTypeRecord[] = [
    {
      id: voidId,
      definition: { kind: 'void' },
      source: 'analysis',
      status: 'candidate',
      evidence_ids: allProofs,
    },
    { id: pointerId, definition, source: 'analysis', status: 'candidate', evidence_ids: allProofs },
  ];
  const associations: TypeAssociation[] = [];
  const elementPointers = new Map<string, string>();
  const associate = (
    subject_id: string,
    type_id: string,
    proof: string,
    kind: string,
    offset = 0,
  ): void => {
    const machine_type = cells.get(subject_id)!.type;
    associations.push({
      id: entityIdentity(options.slice_id, 'pointer-evidence-association', [
        input.id,
        subject_id,
        kind,
      ]),
      subject_id,
      type_id,
      source: 'analysis',
      status: 'candidate',
      evidence_ids: [proof],
      machine_type,
      value_offset_bits: offset,
      machine_offset_bits: 0,
      width_bits: bitWidth(machine_type),
    });
  };
  /** The object pointer type of the wholes a cell holds its own bits of. */
  const fragmentObject = (id: string, offset: number): { key: string; type_id: string } | null => {
    const found = new Map<string, string>();
    const owners = [
      ...(wholes.get(id) ?? []),
      ...(sliceOwners.get(id) ?? []).flatMap((whole) =>
        slices
          .get(whole)!
          .filter((slice) => slice.part.id === id)
          .map((slice) => ({ whole, offset: slice.offset })),
      ),
    ];
    for (const owner of owners) {
      budget.charge();
      const object = owner.offset === offset ? objectTypes.get(owner.whole) : undefined;
      if (object) found.set(object.key, object.type_id);
    }
    if (found.size !== 1) return null;
    const [key, type_id] = [...found][0]!;
    return { key, type_id };
  };
  for (const [subject_id, fragment] of [...fragments].sort(([a], [b]) => a.localeCompare(b))) {
    budget.charge();
    if (proofs.has(subject_id)) continue;
    associate(subject_id, pointerId, fragment.proof, 'fragment', fragment.offset);
    // A source formal built from these cells reads the whole's declared type.
    const object = fragmentObject(subject_id, fragment.offset);
    if (object)
      associate(subject_id, object.type_id, fragment.proof, 'fragment object', fragment.offset);
  }
  for (const [subject_id, proof] of [...proofs].sort(([a], [b]) => a.localeCompare(b))) {
    budget.charge();
    associate(subject_id, pointerId, proof, 'address');
    const object = seeds.has(subject_id) ? undefined : objectTypes.get(subject_id);
    if (object) associate(subject_id, object.type_id, proof, 'joined object');
    const element = seeds.has(subject_id) ? null : elements.get(subject_id);
    if (!element) continue;
    let type_id = elementPointers.get(element.key);
    if (!type_id) {
      type_id = entityIdentity(options.slice_id, 'pointer-evidence-type', [input.id, element.key]);
      elementPointers.set(element.key, type_id);
      added.push({
        id: type_id,
        definition: { kind: 'pointer', bits, to: element.type_id },
        source: 'analysis',
        status: 'candidate',
        evidence_ids: allProofs,
      });
    }
    associate(subject_id, type_id, proof, 'element');
  }
  return {
    ...types,
    work: types.work + budget.work,
    subjects: [...new Set([...types.subjects, ...added.map((record) => record.id)])].sort(),
    types: [...types.types, ...added],
    associations: [...types.associations, ...associations].sort((a, b) => a.id.localeCompare(b.id)),
    evidence: [...types.evidence, ...evidence].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

import {
  entityIdentity,
  fingerprint,
  OperationError,
  type AbiProfile,
  type CanonicalValue,
  type Diagnostic,
  type Evidence,
  type FunctionRecord,
  type OperationContext,
  type RecoveredType,
  type RegisterDescriptor,
} from '../../core/index.js';
import {
  bitWidth,
  type Expression,
  type RegisterBinding,
  type SSAForm,
  type Value,
} from '../../ir/index.js';
import { AnalysisBudget } from '../../analysis/ssa/budget.js';
import { typeKey } from '../../analysis/types/layout.js';
import {
  createAffineResolver,
  memoryAddressSources,
  memoryLoopParameters,
} from '../../analysis/types/memory-shapes.js';
import {
  compareImageFields,
  imageAnchorKey,
  localImageAnchor,
  solveImageTypes,
  type ImageTypeAnchor,
  type ImageTypeClass,
  type ImageTypeField,
  type ImageTypeFunction,
  type ImageTypeObject,
  type ImageTypeSolution,
} from '../../analysis/types/image-types.js';
import type {
  ImageTypeBinding,
  SuppliedTypeRecord,
  TypeAssociation,
  TypeRecoveryResult,
} from '../../analysis/types/index.js';
import { cSourceName } from '../../metadata/symbols/c-names.js';
import { typeDeclarations } from '../../project/annotations/type-library.js';
import { nativeCallIndex } from './calls.js';
import {
  imageTypeBindings,
  type ImageTypeBindings,
  type ImageTypeBindingSource,
  type ImageTypeUserBinding,
} from './image-type-bindings.js';
import { nativeArgumentIndex, nativeArgumentValues } from './native-arguments.js';
import { parameterRegisters } from './native-abi.js';
import {
  nativeDependencies,
  type NativePreparationInput,
  type PreparedNativeUnit,
} from './native-prepare.js';
import { renderImageTypeDeclarations, type ImageTypeUserView } from '../../emitters/image-types.js';
import type { NativeDependency } from './native-worklist.js';
import {
  nativeLibraryContracts,
  nativeUnitLoader,
  optionalWorkPool,
  preparedUnitCache,
  type SourceFactsInput,
} from './source-facts.js';

/** Bounded neighborhood: at most this many other function bodies per request. */
const MAX_NEIGHBOR_FUNCTIONS = 12;
/** Callers visited per callee flow before the flow counts as unexplored. */
const MAX_CALLERS_PER_FLOW = 4;
/** Pointee hops followed from the requested function's own objects. */
const MAX_POINTEE_DEPTH = 2;

interface FunctionFacts {
  readonly objects: readonly ImageTypeObject[];
}

/** The shared prepared-unit loader under `context`: a reuse charges exactly the
 * work and reads its preparation did, so results and budgets never depend on
 * what earlier requests in this process prepared. */
function unitLoader(input: NativePreparationInput, context: OperationContext) {
  const load = nativeUnitLoader(
    input,
    preparedUnitCache(input),
    nativeLibraryContracts(input),
    (work, root) =>
      work <= (context.remainingWork?.() ?? 0) &&
      work + root <= (input.scope.context.remainingWork?.() ?? 0),
  );
  return (fn: FunctionRecord) => load(fn, context);
}

/** The whole 64-bit value of one register among boundary bindings: one exact
 * binding, or the existing concatenation of its exact cells. */
function registerValue(
  bindings: readonly RegisterBinding[],
  register: RegisterDescriptor,
  concatenations: ReadonlyMap<string, Value>,
): Value | undefined {
  const cells = bindings
    .filter(
      (binding) =>
        binding.register.root === register.root &&
        binding.register.offset_bits >= register.offset_bits &&
        binding.register.offset_bits < register.offset_bits + register.width_bits,
    )
    .sort((a, b) => a.register.offset_bits - b.register.offset_bits);
  if (
    cells.length === 1 &&
    cells[0]!.register.offset_bits === register.offset_bits &&
    bitWidth(cells[0]!.value.type) === register.width_bits
  )
    return cells[0]!.value;
  return cells.length > 1
    ? concatenations.get(cells.map((cell) => cell.value.id).join(','))
    : undefined;
}

/** Local object views and exact pointer flows of one analyzed body. */
export function functionTypeObjects(
  fn: FunctionRecord,
  ir: SSAForm,
  types: TypeRecoveryResult,
  dependencies: readonly NativeDependency[],
  abi: AbiProfile,
  context: OperationContext,
): readonly ImageTypeObject[] {
  const budget = new AnalysisBudget({
    max_work: context.remainingWork?.() ?? context.budget.work,
    checkpoint: (work) => context.checkpoint(work),
  });
  const definitions = new Map<string, Expression>();
  const concatenations = new Map<string, Value>();
  for (const block of ir.blocks)
    for (const node of block.instructions) {
      budget.charge();
      if (node.kind !== 'assign') continue;
      definitions.set(node.result.id, node.expression);
      if (node.expression.kind === 'concat')
        concatenations.set(node.expression.values.map((value) => value.id).join(','), node.result);
    }
  const stack = types.calls?.stack;
  const affine = createAffineResolver(
    definitions,
    (id) => {
      const fact = stack?.values.get(id)?.value;
      if (fact?.kind === 'constant') return fact.bits;
      const expression = definitions.get(id);
      return expression?.kind === 'constant' ? expression.bits : undefined;
    },
    budget,
    memoryAddressSources(ir, budget),
    memoryLoopParameters(ir, budget),
  );
  const records = new Map<string, SuppliedTypeRecord>();
  for (const record of types.types) {
    budget.charge();
    if (record.source === 'analysis') records.set(record.id, record);
  }
  const kindOf = (type_id: string): ImageTypeField['kind'] => {
    let definition = records.get(type_id)?.definition;
    if (definition?.kind === 'array') definition = records.get(definition.element)?.definition;
    return definition?.kind === 'pointer'
      ? 'pointer'
      : definition?.kind === 'float'
        ? 'float'
        : 'integer';
  };
  const objects = new Map<
    string,
    {
      fields: ImageTypeField[];
      anchors: Map<string, { anchor: ImageTypeAnchor; own: boolean }>;
      pointees: { offset: bigint; stride: bigint | null; object: string }[];
    }
  >();
  const objectKey = (base: string, offset: bigint): string => `${fn.id}|${base}|${offset}`;
  const shapeObjects = new Set<string>();
  for (const shape of types.shapes) {
    budget.charge(1 + shape.fields.length);
    if (shape.base.kind !== 'value' || shape.base_offset !== 0n) continue;
    shapeObjects.add(shape.base.value_id);
  }
  for (const shape of types.shapes) {
    if (shape.base.kind !== 'value' || shape.base_offset !== 0n) continue;
    const definition = records.get(shape.type_id)?.definition;
    const declared = new Map(
      definition?.kind === 'structure'
        ? definition.fields.map((field) => [field.id, field.type_id])
        : [],
    );
    const fields: ImageTypeField[] = [],
      pointees: { offset: bigint; stride: bigint | null; object: string }[] = [];
    for (const field of shape.fields) {
      budget.charge(1 + field.value_ids.length);
      // An access that lost an overlap is not a layout member of this view.
      if (
        field.dynamic ||
        field.offset < 0n ||
        (definition?.kind === 'structure' && !declared.has(field.id))
      )
        continue;
      const type_id = declared.get(field.id);
      fields.push({
        offset: field.offset,
        width_bits: field.width_bits,
        stride: field.stride,
        kind: type_id ? kindOf(type_id) : 'integer',
      });
      if (field.width_bits !== 64) continue;
      for (const value_id of field.value_ids) {
        const address = affine({ id: value_id, type: { kind: 'integer', bits: 64 } });
        if (address.offset === 0n && address.stride === null && shapeObjects.has(address.base))
          pointees.push({
            offset: field.offset,
            stride: field.stride,
            object: objectKey(address.base, 0n),
          });
      }
    }
    // A constant-size allocation names its object by allocation site and size.
    const anchors = new Map<string, { anchor: ImageTypeAnchor; own: boolean }>();
    if (shape.allocation) {
      const anchor: ImageTypeAnchor = {
        kind: 'allocation',
        function_id: fn.id,
        call_id: shape.allocation.call_id,
        size: shape.allocation.size,
      };
      anchors.set(imageAnchorKey(anchor), { anchor, own: true });
    }
    objects.set(objectKey(shape.base.value_id, 0n), {
      fields,
      anchors,
      pointees,
    });
  }
  const anchor = (value: Value, flow: ImageTypeAnchor, own: boolean): void => {
    budget.charge();
    if (bitWidth(value.type) !== 64) return;
    const fact = stack?.values.get(value.id)?.value;
    let key: string;
    let local: ImageTypeAnchor | undefined;
    if (fact?.kind === 'stack') {
      key = `${fn.id}|stack|${fact.offset}`;
      local = { kind: 'stack', function_id: fn.id, offset: fact.offset };
    } else {
      const address = affine(value);
      if (address.stride !== null) return;
      key = objectKey(address.base, address.offset);
    }
    let object = objects.get(key);
    if (!object) {
      object = { fields: [], anchors: new Map(), pointees: [] };
      objects.set(key, object);
    }
    if (local) object.anchors.set(imageAnchorKey(local), { anchor: local, own: true });
    object.anchors.set(imageAnchorKey(flow), { anchor: flow, own });
  };
  const registers = parameterRegisters(abi).filter((register) => register.bank === 'integer');
  const observed = {
    parameters: registers,
    returns: [],
    parameter_state: 'ambiguous' as const,
    argument_list_complete: false,
  };
  const indexed = nativeArgumentIndex(ir, context);
  for (const [index, value] of nativeArgumentValues(indexed, types.calls, ir.id, observed, context))
    anchor(value, { kind: 'argument', function_id: fn.id, index }, true);
  // A hidden-result pointer register outside the argument registers (AAPCS64
  // x8) read at entry and stored through is the incoming result location: its
  // object is this function's result, named by that role.
  const hidden = abi.classifyCall({
    returns: {
      kind: 'aggregate',
      size: 32n,
      alignment: 8,
      fields: [0n, 8n, 16n, 24n].map((offset) => ({
        offset,
        type: { kind: 'integer' as const, bits: 64, signed: false },
      })),
    },
    parameters: [],
    variadic: false,
    fixed_parameter_count: 0,
  }).hidden_result;
  if (
    hidden?.kind === 'indirect' &&
    'root' in hidden.pointer &&
    !registers.some((register) => 'root' in hidden.pointer && register.root === hidden.pointer.root)
  ) {
    const entry = ir.register_states.find((row) => row.block === ir.entry)?.entry ?? [];
    const value = registerValue(
      entry,
      { ...hidden.pointer, offset_bits: 0, width_bits: 64 },
      concatenations,
    );
    if (
      value &&
      types.shapes.some(
        (shape) =>
          shape.base.kind === 'value' &&
          shape.base.value_id === value.id &&
          shape.fields.some((field) => field.access.includes('write')),
      )
    )
      anchor(value, { kind: 'return', function_id: fn.id }, true);
  }
  const location = abi.classifyCall({
    returns: { kind: 'pointer' },
    parameters: [],
    variadic: false,
    fixed_parameter_count: 0,
  }).returns[0];
  const result =
    location?.kind === 'register'
      ? { ...location.register, width_bits: location.width_bits }
      : undefined;
  const callees = new Map(dependencies.map((dependency) => [dependency.call_id, dependency]));
  const states = new Map(ir.register_states.map((state) => [state.block, state]));
  for (const block of ir.blocks) {
    for (const node of block.instructions) {
      budget.charge();
      const callee = node.kind === 'call' ? callees.get(node.id) : undefined;
      if (node.kind !== 'call' || !callee) continue;
      for (const [index, value] of nativeArgumentValues(
        indexed,
        types.calls,
        node.id,
        observed,
        context,
      ))
        anchor(value, { kind: 'argument', function_id: callee.target.id, index }, false);
      const returned = result && registerValue(node.register_outputs, result, concatenations);
      if (returned) anchor(returned, { kind: 'return', function_id: callee.target.id }, false);
    }
    const tail = callees.get(block.terminator.id);
    if (tail)
      for (const [index, value] of nativeArgumentValues(
        indexed,
        types.calls,
        block.terminator.id,
        observed,
        context,
      ))
        anchor(value, { kind: 'argument', function_id: tail.target.id, index }, false);
    if (block.terminator.kind === 'return' && result) {
      const value = registerValue(states.get(block.id)?.exit ?? [], result, concatenations);
      if (value) anchor(value, { kind: 'return', function_id: fn.id }, true);
    }
  }
  // A value passed unchanged where an established declaration (library or debug
  // prototype, assertion) expects a pointer: the object it anchors is an address
  // of that declared type. Integer declarations prove nothing.
  const declaredTypes = new Map<string, RecoveredType>();
  for (const record of types.types) {
    budget.charge();
    if (record.source !== 'analysis') declaredTypes.set(record.id, record.definition);
  }
  const declared = new Map<string, Set<string>>();
  for (const association of types.associations) {
    budget.charge();
    if (
      association.source === 'analysis' ||
      (association.status !== 'established' && association.status !== 'asserted') ||
      association.width_bits !== 64 ||
      association.value_offset_bits !== 0 ||
      association.machine_offset_bits !== 0 ||
      declaredTypes.get(association.type_id)?.kind !== 'pointer' ||
      stack?.values.get(association.subject_id)?.value.kind === 'stack'
    )
      continue;
    const address = affine({ id: association.subject_id, type: { kind: 'integer', bits: 64 } });
    if (address.offset !== 0n || address.stride !== null) continue;
    const key = objectKey(address.base, 0n);
    if (!objects.has(key)) continue;
    (declared.get(key) ?? declared.set(key, new Set()).get(key)!).add(association.type_id);
  }
  const list: ImageTypeObject[] = [];
  for (const [key, object] of objects) {
    budget.charge();
    if (!object.fields.length && !object.anchors.size) continue;
    list.push({
      key,
      function_id: fn.id,
      fields: object.fields.sort(compareImageFields),
      anchors: [...object.anchors.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, item]) => item),
      pointees: object.pointees,
      ...(declared.has(key) ? { declared: [...declared.get(key)!].sort() } : {}),
    });
  }
  return list.sort((a, b) => a.key.localeCompare(b.key));
}

function typeFunctions(
  input: Pick<NativePreparationInput, 'functions' | 'image'>,
  ids: Iterable<string>,
): ReadonlyMap<string, ImageTypeFunction> {
  const byId = new Map(input.functions.map((fn) => [fn.id, fn]));
  const result = new Map<string, ImageTypeFunction>();
  for (const id of ids) {
    const fn = byId.get(id);
    if (!fn) continue;
    const native = fn.display_name ?? fn.original_name;
    const name = native
      ? cSourceName(input.image.target.format, native).replace(/[^A-Za-z0-9_]/g, '_')
      : '';
    result.set(id, {
      name: /^[A-Za-z_]/.test(name) ? name : `sub_${fn.entry.value.toString(16)}`,
      order: fn.entry.value,
    });
  }
  return result;
}

/** Direct callers per callee, from established call/tail-call references. */
function callerIndex(
  input: Pick<NativePreparationInput, 'functions' | 'image' | 'references'>,
  context: OperationContext,
): Map<string, string[]> {
  const index = nativeCallIndex(input.image, input.functions, input.references, context);
  const callers = new Map<string, Set<string>>();
  for (const reference of input.references) {
    context.checkpoint(1);
    if ((reference.kind !== 'call' && reference.kind !== 'tail_call') || !reference.from_function)
      continue;
    const targets = reference.to
      ? (index.functions_by_address.get(
          `${reference.to.image_id}:${reference.to.space}:${reference.to.value}`,
        ) ?? [])
      : [];
    for (const target of targets)
      (callers.get(target.id) ?? callers.set(target.id, new Set()).get(target.id)!).add(
        reference.from_function,
      );
  }
  const byId = new Map(input.functions.map((fn) => [fn.id, fn.entry.value]));
  return new Map(
    [...callers].map(([id, set]) => [
      id,
      [...set].sort((a, b) => {
        const x = byId.get(a) ?? 0n,
          y = byId.get(b) ?? 0n;
        return x < y ? -1 : x > y ? 1 : a.localeCompare(b);
      }),
    ]),
  );
}

/** Facts of one body from its (prepared or reused) native unit. Null when the
 * body has no complete local recovery. */
function loadFacts(
  input: NativePreparationInput,
  fn: FunctionRecord,
  load: (fn: FunctionRecord) => PreparedNativeUnit,
  context: OperationContext,
): FunctionFacts | null {
  const unit = load(fn);
  if (!unit.ir || !unit.types || unit.types.state !== 'complete' || unit.budget_truncated)
    return null;
  return {
    objects: functionTypeObjects(
      fn,
      unit.ir,
      unit.types,
      unit.dependencies,
      input.components.abi,
      context,
    ),
  };
}

/** Bounded, deterministic exploration of the pointer flows reachable from the
 * selected function's objects, then one unification. Callee bodies confirm
 * argument/result flows; callers contribute their own views of the same flow.
 * Exhaustion keeps what was explored and marks unexplored flows open. */
export function exploreImageTypes(
  input: SourceFactsInput,
  rootObjects: readonly ImageTypeObject[],
  context: OperationContext,
  limits: { readonly max_functions: number } = { max_functions: MAX_NEIGHBOR_FUNCTIONS },
): ImageTypeSolution {
  const load = unitLoader(input, context);
  const byId = new Map(input.functions.map((fn) => [fn.id, fn]));
  const callers = callerIndex(input, context);
  const root = input.ir.id;
  const facts = new Map<string, FunctionFacts | null>([[root, { objects: rootObjects }]]);
  const loadOne = (id: string): FunctionFacts | null => {
    if (facts.has(id)) return facts.get(id)!;
    const fn = byId.get(id);
    let loaded: FunctionFacts | null = null;
    if (fn)
      try {
        loaded = loadFacts(input, fn, load, context);
      } catch (error) {
        const details = error instanceof OperationError ? error.diagnostic.details : undefined;
        if (
          !(error instanceof OperationError) ||
          error.code !== 'resource_limit' ||
          details?.kind !== 'limit' ||
          details.resource !== 'work'
        )
          throw error;
        // A neighbor whose own preparation is too large stays unexplored.
        context.checkpoint(0);
      }
    facts.set(id, loaded);
    return loaded;
  };
  const open = new Set<string>();
  const expanded = new Set<string>();
  const interesting = new Map<string, number>();
  const pending: { key: string; depth: number }[] = [];
  const mark = (object: ImageTypeObject, depth: number): void => {
    const previous = interesting.get(object.key);
    if (previous !== undefined && previous <= depth) return;
    interesting.set(object.key, depth);
    for (const { anchor } of object.anchors)
      if (!localImageAnchor(anchor)) pending.push({ key: imageAnchorKey(anchor), depth });
  };
  const objectsOf = (id: string) => facts.get(id)?.objects ?? [];
  const byObject = new Map<string, ImageTypeObject>();
  const index = (id: string): void => {
    for (const object of objectsOf(id)) byObject.set(object.key, object);
  };
  index(root);
  for (const object of rootObjects) mark(object, 0);
  let loads = 0;
  // Pointee views held by marked objects carry the layout further; their own
  // flows are followed to a small depth.
  const markPointees = (object: ImageTypeObject, depth: number): void => {
    if (depth >= MAX_POINTEE_DEPTH) return;
    for (const pointee of object.pointees) {
      const target = byObject.get(pointee.object);
      if (target) mark(target, depth + 1);
    }
  };
  for (const object of rootObjects) markPointees(object, 0);
  const visit = (id: string, key: string, depth: number): boolean => {
    if (!facts.has(id)) {
      if (loads >= limits.max_functions) return false;
      loads++;
      loadOne(id);
      index(id);
    }
    for (const object of objectsOf(id))
      if (object.anchors.some(({ anchor }) => imageAnchorKey(anchor) === key)) {
        mark(object, depth);
        markPointees(object, depth);
      }
    return facts.get(id) !== null;
  };
  while (pending.length) {
    context.checkpoint(pending.length);
    // Breadth-first by depth, then canonical key: a deterministic frontier.
    let next = 0;
    for (let index = 1; index < pending.length; index++) {
      const a = pending[index]!,
        b = pending[next]!;
      if (a.depth < b.depth || (a.depth === b.depth && a.key < b.key)) next = index;
    }
    const { key, depth } = pending.splice(next, 1)[0]!;
    if (expanded.has(key)) continue;
    expanded.add(key);
    const [kind, callee] = key.split(':') as [string, string];
    if (kind !== 'argument' && kind !== 'return') continue;
    if (!byId.has(callee)) continue;
    let complete = visit(callee, key, depth);
    const list = callers.get(callee) ?? [];
    if (list.length > MAX_CALLERS_PER_FLOW) complete = false;
    for (const caller of list.slice(0, MAX_CALLERS_PER_FLOW))
      if (!visit(caller, key, depth)) complete = false;
    if (!complete) open.add(key);
  }
  const objects = [...facts.values()].flatMap((item) => item?.objects ?? []);
  const unloaded = new Set<string>();
  for (const object of objects)
    for (const { anchor } of object.anchors)
      if (
        !localImageAnchor(anchor) &&
        byId.has(anchor.function_id) &&
        !facts.get(anchor.function_id)
      )
        unloaded.add(anchor.function_id);
  // Flows of loaded objects that were never expanded are unexplored as well,
  // and every flow is when the image's reference index is incomplete: callers
  // absent from it may hold further views of the same object.
  const references = input.scope.store.queryRecords({
    kind: 'reference',
    image_id: input.image.id,
    revision: input.revision,
    limit: 1,
  }).index_state;
  for (const object of objects)
    for (const { anchor } of object.anchors) {
      const key = imageAnchorKey(anchor);
      if (!localImageAnchor(anchor) && (!expanded.has(key) || references !== 'complete'))
        open.add(key);
    }
  const budget = new AnalysisBudget({
    max_work: context.remainingWork?.() ?? context.budget.work,
    checkpoint: (work) => context.checkpoint(work),
  });
  return solveImageTypes(
    objects,
    {
      functions: typeFunctions(
        input,
        new Set(
          objects.flatMap((object) => [
            object.function_id,
            ...object.anchors.map(({ anchor }) => anchor.function_id),
          ]),
        ),
      ),
      unloaded,
      open,
    },
    budget,
  );
}

/** Image type records for the classes reachable from the selected function's
 * views. Local recovered members keep their IDs and types; merged members from
 * other functions are added only where they do not overlap a local member. A class
 * bound to a user-declared structure (`user`) is that structure here: this
 * body's values in it take the declared pointer type (unless this body declares
 * their type itself) and members pointing to it point to the declaration. */
export function applyImageTypes(
  input: SourceFactsInput,
  solution: ImageTypeSolution,
  types: TypeRecoveryResult,
  context: OperationContext,
  user: ImageTypeBindings,
): TypeRecoveryResult {
  const slice = input.image.selected_slice_id;
  const classes = new Map(solution.classes.map((item) => [item.id, item]));
  const records = [...types.types];
  const byId = new Map<string, SuppliedTypeRecord>();
  for (const record of records) byId.set(record.id, record);
  // A declaration this body already has in scope takes precedence over the binding's.
  const own = new Set(byId.keys());
  for (const record of user.records)
    if (!own.has(record.id)) {
      records.push(record);
      byId.set(record.id, record);
    }
  const evidence: Evidence[] = [];
  const proofs = new Map<string, string>();
  const proof = (item: ImageTypeClass): string => {
    let id = proofs.get(item.id);
    if (id) return id;
    const names = typeFunctions(input, item.functions);
    id = `evidence_${fingerprint([input.image.id, input.revision, 'image-type', item.id, item.fields.length])}`;
    evidence.push({
      id,
      origin: {
        kind: 'analysis',
        analyzer: 'image-types',
        version: '1',
        rule: 'compatible observed layouts joined through exact pointer flows',
      },
      claim:
        `Layout ${item.label} (first seen: ${item.name}) joins ${item.members.length} observed view(s) in ` +
        `${item.functions.map((fn) => names.get(fn)?.name ?? fn).join(', ')} through argument, result ` +
        `and stack-address flows${item.state === 'bounded' ? ' (exploration bounded)' : ''}; ` +
        'members are observed accesses only, not an object size or complete layout',
      derived_from: [],
      conflicts_with: [],
      revision: input.revision,
    });
    proofs.set(item.id, id);
    return id;
  };
  /** The asserted signature roles a bound class's type comes from. */
  const bindingProof = (item: ImageTypeClass, binding: ImageTypeUserBinding): string => {
    const id = `evidence_${fingerprint([input.image.id, input.revision, 'image-type-binding', item.id, binding.type_id])}`;
    if (proofs.has(id)) return id;
    evidence.push({
      id,
      origin: {
        kind: 'analysis',
        analyzer: 'image-types',
        version: '1',
        rule: 'an asserted signature role of a member function declares the class type',
      },
      claim: `Layout ${item.label} is ${binding.spelling}: declared by the asserted signature of ${bindingRoles(input, binding.sources)}`,
      derived_from: [
        proof(item),
        ...new Set(binding.sources.flatMap((source) => source.annotation.evidence_ids)),
      ].sort(),
      conflicts_with: [],
      revision: input.revision,
    });
    proofs.set(id, id);
    return id;
  };
  const generated = (definition: RecoveredType, evidence_ids: readonly string[]): string => {
    const id = entityIdentity(slice, 'image-type-member', [
      fingerprint(definition as unknown as CanonicalValue),
    ]);
    if (!byId.has(id)) {
      const record: SuppliedTypeRecord = {
        id,
        definition,
        source: 'analysis',
        status: 'candidate',
        evidence_ids,
      };
      records.push(record);
      byId.set(id, record);
    }
    return id;
  };
  // Local shape types per class: their records receive the merged layout.
  const localTypes = new Map<string, string[]>();
  for (const shape of types.shapes) {
    context.checkpoint(1);
    if (shape.base.kind !== 'value' || shape.base_offset !== 0n) continue;
    const class_id = solution.class_of.get(`${input.ir.id}|${shape.base.value_id}|0`);
    if (class_id)
      (localTypes.get(class_id) ?? localTypes.set(class_id, []).get(class_id)!).push(shape.type_id);
  }
  // Pointer members to a class refer to its first local view, if any.
  const typeIds = new Map<string, string>(
    [...localTypes].map(([class_id, list]) => [class_id, list[0]!]),
  );
  const bindings: ImageTypeBinding[] = [];
  const pendingClasses: string[] = [];
  /** Pointer members name their pointee class; a class without a view in this
   * function is declared by name only (its layout is in the image types). */
  const typeOf = (class_id: string): string => {
    const existing = user.bound.get(class_id)?.type_id ?? typeIds.get(class_id);
    if (existing) return existing;
    const id = entityIdentity(slice, 'image-type', [class_id]);
    typeIds.set(class_id, id);
    pendingClasses.push(class_id);
    return id;
  };
  const memberType = (
    item: ImageTypeClass,
    field: ImageTypeField,
    proofIds: readonly string[],
    tailArray: boolean,
  ): string => {
    let element: string;
    if (field.kind === 'pointer') {
      const pointee = item.pointees.find(
        (candidate) => candidate.offset === field.offset && candidate.stride === field.stride,
      );
      const target = pointee
        ? typeOf(pointee.class_id)
        : generated({ kind: 'unknown', size: null }, proofIds);
      element = generated({ kind: 'pointer', bits: 64, to: target }, proofIds);
    } else
      element = generated(
        field.kind === 'float' && (field.width_bits === 32 || field.width_bits === 64)
          ? { kind: 'float', bits: field.width_bits }
          : { kind: 'integer', bits: field.width_bits, signed: false },
        proofIds,
      );
    return tailArray && field.width_bits % 8 === 0 && field.stride === BigInt(field.width_bits / 8)
      ? generated({ kind: 'array', element, count: null }, proofIds)
      : element;
  };
  const layout = (
    item: ImageTypeClass,
    base: Extract<RecoveredType, { kind: 'structure' }>,
    proofIds: readonly string[],
  ): Extract<RecoveredType, { kind: 'structure' }> => {
    // A local integer member another view proves to hold an object pointer
    // takes that pointer type, so every function declares the same member.
    const fields = base.fields.map((field) => {
      const definition = byId.get(field.type_id)?.definition;
      const merged = item.fields.find(
        (candidate) =>
          candidate.offset === field.offset &&
          candidate.width_bits === 64 &&
          candidate.stride === null &&
          candidate.kind === 'pointer',
      );
      return merged && definition?.kind === 'integer' && definition.bits === 64
        ? { ...field, type_id: memberType(item, merged, proofIds, false) }
        : field;
    });
    const occupied = fields.map((field) => {
      const definition = byId.get(field.type_id)?.definition;
      const array = definition?.kind === 'array';
      const element = array ? byId.get(definition.element)?.definition : definition;
      const bits =
        element?.kind === 'integer' || element?.kind === 'float'
          ? element.bits
          : element?.kind === 'pointer'
            ? 64
            : 8;
      return {
        start: field.offset,
        end: field.offset + BigInt(Math.ceil(bits / 8)),
        float: element?.kind === 'float',
        array,
      };
    });
    const added: { field: ImageTypeField; overlay: boolean }[] = [];
    for (const field of item.fields) {
      context.checkpoint(1);
      const end = field.offset + BigInt(Math.ceil(field.width_bits / 8)),
        float = field.kind === 'float';
      const overlapping = occupied.filter((range) => field.offset < range.end && range.start < end);
      // The same bytes read as the other scalar kind are one more member of an
      // anonymous union (a scalar member, never an array element view).
      const overlay =
        overlapping.length > 0 &&
        overlapping.every(
          (range) =>
            range.start === field.offset &&
            range.end === end &&
            !range.array &&
            range.float !== float,
        );
      if (overlapping.length && !overlay) continue;
      occupied.push({ start: field.offset, end, float, array: false });
      added.push({ field, overlay });
    }
    const last = occupied.reduce((max, range) => (range.start > max ? range.start : max), 0n);
    // C declares an unknown element count only as the last member: an earlier
    // indexed member keeps its first element (indexed accesses stay explicit).
    for (const [index, field] of fields.entries()) {
      const definition = byId.get(field.type_id)?.definition;
      if (definition?.kind === 'array' && definition.count === null && field.offset !== last)
        fields[index] = { ...field, type_id: definition.element };
    }
    for (const { field, overlay } of added)
      fields.push({
        id: entityIdentity(slice, 'image-type-field', [
          item.id,
          field.offset,
          field.width_bits,
          field.stride,
          ...(field.kind === 'float' ? ['float'] : []),
        ]),
        name: `field_${field.offset.toString(16)}${overlay && field.kind === 'float' ? '_f' : ''}`,
        offset: field.offset,
        type_id: memberType(item, field, proofIds, !overlay && field.offset === last && last > 0n),
      });
    fields.sort((a, b) => (a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0));
    // A known allocation size stays only while every merged member fits in it.
    const size =
      base.size !== null && occupied.every((range) => range.end <= base.size!) ? base.size : null;
    return { kind: 'structure', size, alignment: null, fields };
  };
  const declared: [string, string][] = [];
  for (const [class_id, list] of localTypes)
    for (const type_id of list) {
      declared.push([class_id, type_id]);
      const item = classes.get(class_id)!;
      const at = records.findIndex(
        (record) => record.id === type_id && record.source === 'analysis',
      );
      if (at < 0 || item.members.length < 2) continue;
      const record = records[at]!;
      const proofIds = [...new Set([...record.evidence_ids, proof(item)])].sort();
      const definition =
        record.definition.kind === 'structure'
          ? layout(item, record.definition, proofIds)
          : record.definition;
      records[at] = { ...record, definition, evidence_ids: proofIds };
      byId.set(type_id, records[at]!);
    }
  // A value of this body that flows (as an argument or result, at displacement
  // zero) into a class some view dereferences holds that object's address,
  // even where no local access or callee-summary transfer typed it.
  const shapeBases = new Set(
    types.shapes.flatMap((shape) => (shape.base.kind === 'value' ? [shape.base.value_id] : [])),
  );
  const prefix = `${input.ir.id}|`;
  // A class without observed members but passed where declarations expect one
  // pointer type (a parameter forwarded unchanged to `strrchr`) is that type.
  const declaredType = (item: ImageTypeClass | undefined): string | undefined => {
    if (!item || item.fields.length || !item.declared.length) return undefined;
    const keys = new Set(
      item.declared.map((id) => {
        const definition = byId.get(id)?.definition;
        return definition?.kind === 'pointer' ? typeKey(definition) : '';
      }),
    );
    return keys.size === 1 && !keys.has('') ? item.declared[0] : undefined;
  };
  // This body's own declarations (its signature, call prototypes, type annotations)
  // of a value take precedence over a class binding.
  const declaredValues = new Set(
    types.associations.flatMap((association) =>
      association.source !== 'analysis' &&
      (association.status === 'established' || association.status === 'asserted')
        ? [association.subject_id]
        : [],
    ),
  );
  const flows: { value_id: string; class_id: string }[] = [];
  for (const [key, class_id] of solution.class_of) {
    context.checkpoint(1);
    if (!key.startsWith(prefix) || !key.endsWith('|0')) continue;
    const value_id = key.slice(prefix.length, -2);
    const item = classes.get(class_id);
    if (
      value_id === 'stack' ||
      shapeBases.has(value_id) ||
      (user.bound.has(class_id)
        ? declaredValues.has(value_id)
        : !item?.fields.length && declaredType(item) === undefined)
    )
      continue;
    flows.push({ value_id, class_id });
  }
  const associations: TypeAssociation[] = [];
  if (flows.length) {
    const values = new Map<string, Value>();
    const constants = new Set<string>();
    for (const block of input.ir.blocks) {
      for (const value of block.parameters) values.set(value.id, value);
      for (const node of block.instructions) {
        context.checkpoint(1);
        if ('result' in node) values.set(node.result.id, node.result);
        if (node.kind === 'call') for (const value of node.results) values.set(value.id, value);
        if ('register_outputs' in node)
          for (const binding of node.register_outputs) values.set(binding.value.id, binding.value);
        if (node.kind === 'assign' && node.expression.kind === 'constant')
          constants.add(node.result.id);
      }
    }
    for (const state of input.ir.register_states)
      for (const binding of [...state.entry, ...state.exit])
        values.set(binding.value.id, binding.value);
    for (const { value_id, class_id } of flows.sort((a, b) =>
      a.value_id.localeCompare(b.value_id),
    )) {
      context.checkpoint(1);
      const value = values.get(value_id);
      if (
        value?.type.kind !== 'integer' ||
        value.type.bits !== 64 ||
        constants.has(value_id) ||
        types.calls?.stack.values.get(value_id)?.value.kind === 'constant'
      )
        continue;
      const item = classes.get(class_id)!,
        binding = user.bound.get(class_id);
      // A bound class's values hold the declared structure's address, as the
      // asserted signature role states (a declaration, so it wins over observed views).
      const proofIds = [binding ? bindingProof(item, binding) : proof(item)];
      associations.push({
        id: entityIdentity(slice, 'image-type-association', [input.ir.id, value_id, class_id]),
        subject_id: value_id,
        type_id: binding
          ? binding.pointer_id
          : (declaredType(item) ??
            generated({ kind: 'pointer', bits: 64, to: typeOf(class_id) }, proofIds)),
        source: binding ? binding.sources[0]!.annotation.origin : 'analysis',
        status: binding ? 'asserted' : 'candidate',
        evidence_ids: proofIds,
        machine_type: value.type,
        value_offset_bits: 0,
        machine_offset_bits: 0,
        width_bits: 64,
      });
    }
  }
  // Every value this body types as a pointer to its own view of a bound class (the
  // view's base, register fragments of it, values it reaches) holds the declared
  // structure's address instead.
  const boundViews = new Map<string, string>();
  for (const [class_id, list] of localTypes)
    if (user.bound.has(class_id)) for (const type_id of list) boundViews.set(type_id, class_id);
  if (boundViews.size) {
    const pointers = new Map<string, string>();
    for (const record of types.types) {
      context.checkpoint(1);
      if (
        record.source === 'analysis' &&
        record.definition.kind === 'pointer' &&
        boundViews.has(record.definition.to)
      )
        pointers.set(record.id, boundViews.get(record.definition.to)!);
    }
    for (const association of types.associations) {
      context.checkpoint(1);
      const class_id = pointers.get(association.type_id);
      if (!class_id || declaredValues.has(association.subject_id)) continue;
      const binding = user.bound.get(class_id)!;
      associations.push({
        ...association,
        id: entityIdentity(slice, 'image-type-association', [
          input.ir.id,
          association.id,
          class_id,
        ]),
        type_id: binding.pointer_id,
        source: binding.sources[0]!.annotation.origin,
        status: 'asserted',
        evidence_ids: [bindingProof(classes.get(class_id)!, binding)],
      });
    }
  }
  for (const class_id of pendingClasses) {
    const item = classes.get(class_id)!,
      proofIds = [proof(item)];
    // One scalar member at offset zero stays a scalar pointee (`uint8_t*`).
    const only = item.fields.length === 1 ? item.fields[0]! : undefined;
    const scalar =
      only?.offset === 0n &&
      only.kind !== 'pointer' &&
      (only.stride === null || only.stride === BigInt(only.width_bits / 8));
    const record: SuppliedTypeRecord = {
      id: typeIds.get(class_id)!,
      definition: {
        kind: 'structure',
        size: null,
        alignment: null,
        fields: scalar
          ? [
              {
                id: entityIdentity(slice, 'image-type-field', [item.id, 0n, only.width_bits, null]),
                name: 'field_0',
                offset: 0n,
                type_id: memberType(item, { ...only, stride: null }, proofIds, false),
              },
            ]
          : [],
      },
      source: 'analysis',
      status: 'candidate',
      evidence_ids: proofIds,
    };
    records.push(record);
    byId.set(record.id, record);
    declared.push([class_id, record.id]);
  }
  for (const [class_id, type_id] of declared) {
    const item = classes.get(class_id)!;
    // A private single view keeps its layout-digest name, shared by equal layouts.
    if (item.local) continue;
    bindings.push({
      type_id,
      name: item.label,
      first_seen: item.name,
      state: item.state,
      functions: item.functions.length,
      conflicts: item.conflicts.map((id) => classes.get(id)?.label ?? id),
    });
  }
  return {
    ...types,
    types: records,
    associations: associations.length
      ? [...types.associations, ...associations].sort((a, b) => a.id.localeCompare(b.id))
      : types.associations,
    subjects: [
      ...new Set([
        ...types.subjects,
        ...records.map((record) => record.id),
        ...associations.map((association) => association.subject_id),
      ]),
    ].sort(),
    evidence: [...types.evidence, ...evidence].sort((a, b) => a.id.localeCompare(b.id)),
    image_types: bindings.sort((a, b) => a.type_id.localeCompare(b.type_id)),
  };
}

/** `rec_id parameter 0 (rec), make_rec result`: the asserted signature roles of sources. */
function bindingRoles(
  input: Pick<NativePreparationInput, 'functions' | 'image'>,
  sources: readonly ImageTypeBindingSource[],
): string {
  const names = typeFunctions(
    input,
    sources.map((source) => source.function_id),
  );
  return sources
    .map((source) => {
      const fn = names.get(source.function_id)?.name ?? source.function_id;
      if (source.parameter === null) return `${fn} result`;
      const { value } = source.annotation;
      const name =
        value.kind === 'signature' ? value.value.parameters[source.parameter]?.name : null;
      return `${fn} parameter ${source.parameter}${name ? ` (${name})` : ''}`;
    })
    .join(', ');
}

/** `+0x18 (32 bits), +0x20 (64 bits)`: observed members a bound declaration lacks. */
function outsideMembers(fields: readonly ImageTypeField[]): string {
  return `${fields
    .slice(0, 16)
    .map((field) => `+0x${field.offset.toString(16)} (${field.width_bits} bits)`)
    .join(', ')}${fields.length > 16 ? ', …' : ''}`;
}

/** Binding outcomes of the classes the selected body has views in: a binding whose
 * declaration does not cover every observed member (applied anyway: the assertion
 * wins) warns; competing declared structures leave the class unbound (info). */
function bindingDiagnostics(
  input: SourceFactsInput,
  solution: ImageTypeSolution,
  user: ImageTypeBindings,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const evidenceOf = (sources: readonly ImageTypeBindingSource[]) =>
    [...new Set(sources.flatMap((source) => source.annotation.evidence_ids))].sort().slice(0, 1000);
  for (const item of solution.classes) {
    if (!item.functions.includes(input.ir.id)) continue;
    const binding = user.bound.get(item.id),
      conflict = user.conflicts.get(item.id);
    if (binding?.outside.length)
      diagnostics.push({
        code: 'conflicting_evidence',
        severity: 'warning',
        message:
          `Image type ${item.label} is bound to ${binding.spelling} by the asserted signature of ` +
          `${bindingRoles(input, binding.sources)}, but its observed members at ` +
          `${outsideMembers(binding.outside)} are no member of that declaration; the declaration ` +
          'is applied and those accesses print without a member name',
        evidence_ids: evidenceOf(binding.sources),
      });
    else if (conflict)
      diagnostics.push({
        code: 'conflicting_evidence',
        severity: 'info',
        message:
          `Image type ${item.label} stays unbound: asserted signatures declare it as different structures (` +
          `${conflict.map((entry) => `${entry.spelling}: ${bindingRoles(input, entry.sources)}`).join('; ')})`,
        evidence_ids: evidenceOf(conflict.flatMap((entry) => entry.sources)),
      });
  }
  return diagnostics;
}

/** Merge the selected function's observed layouts with every compatible view
 * reachable through exact pointer flows, under its own work sub-budget. */
export function recoverImageTypes(
  input: SourceFactsInput,
  local: TypeRecoveryResult,
  types: TypeRecoveryResult,
): { readonly types: TypeRecoveryResult; readonly diagnostics: readonly Diagnostic[] } {
  const { context } = input.scope;
  if (local.state !== 'complete' || types.state !== 'complete') return { types, diagnostics: [] };
  // Optional merging never takes the work rendering needs: it keeps at least a
  // quarter of what remains and as much as the selected function used so far,
  // and never the selected body's tail reserve (`optionalWorkPool`).
  const remaining = context.remainingWork?.() ?? context.budget.work;
  const limit = optionalWorkPool(
    input.ir,
    remaining,
    Math.max(0, remaining - Math.max(Math.ceil(remaining / 4), context.budget.work - remaining)),
  );
  let used = 0;
  const bounded: OperationContext = {
    ...context,
    budget: { ...context.budget, work: limit },
    remainingWork: () => Math.max(0, limit - used),
    checkpoint(work) {
      context.checkpoint(0);
      if (used + work > limit)
        throw new OperationError({
          code: 'resource_limit',
          severity: 'warning',
          message: 'Image type merging work limit exceeded',
          evidence_ids: [],
          details: { kind: 'limit', resource: 'work', limit, consumed: used + work },
        });
      context.checkpoint(work);
      used += work;
    },
  };
  try {
    const selected = input.functions.find((fn) => fn.id === input.ir.id);
    if (!selected) return { types, diagnostics: [] };
    const dependencies = nativeDependencies(input, input.ir, bounded, undefined, false);
    const rootObjects = functionTypeObjects(
      selected,
      input.ir,
      local,
      dependencies,
      input.components.abi,
      bounded,
    );
    if (!rootObjects.length) return { types, diagnostics: [] };
    const solution = exploreImageTypes(input, rootObjects, bounded);
    const user = imageTypeBindings(
      input.scope,
      input.revision,
      input.components.abi,
      solution.classes,
      bounded,
    );
    return {
      types: applyImageTypes(input, solution, types, bounded, user),
      diagnostics: bindingDiagnostics(input, solution, user),
    };
  } catch (error) {
    const details = error instanceof OperationError ? error.diagnostic.details : undefined;
    if (
      !(error instanceof OperationError) ||
      error.code !== 'resource_limit' ||
      details?.kind !== 'limit' ||
      details.resource !== 'work' ||
      details.limit !== limit
    )
      throw error;
    context.checkpoint(0);
    return {
      types,
      diagnostics: [
        {
          code: 'resource_limit',
          severity: 'info',
          message: `Image type merging stopped at its work sub-budget (${limit}); structure layouts are this function's own observations`,
          evidence_ids: [],
          details,
        },
      ],
    };
  }
}

export interface ImageTypeDump {
  /** C declarations of every merged type with observed members. */
  readonly text: string;
  /** Partial: not every function body was analyzed, or the text was cut. */
  readonly state: 'complete' | 'partial';
  readonly analyzed: number;
  readonly total: number;
  readonly types: number;
}

/** Whole-image type recovery: every function body in entry order (as far as
 * the work budget allows), one unification, C declarations of every type that
 * spans functions or flows. Names follow the per-function rules; a class is
 * bounded when the image's reference index or this pass is incomplete. */
export function imageTypeDump(
  input: NativePreparationInput,
  context: OperationContext,
  max_bytes: number,
): ImageTypeDump {
  const limit = Math.floor(((context.remainingWork?.() ?? context.budget.work) * 3) / 4);
  let used = 0;
  const bounded: OperationContext = {
    ...context,
    budget: { ...context.budget, work: limit },
    remainingWork: () => Math.max(0, limit - used),
    checkpoint(work) {
      context.checkpoint(0);
      if (used + work > limit)
        throw new OperationError({
          code: 'resource_limit',
          severity: 'warning',
          message: 'Image type recovery work limit exceeded',
          evidence_ids: [],
          details: { kind: 'limit', resource: 'work', limit, consumed: used + work },
        });
      context.checkpoint(work);
      used += work;
    },
  };
  const load = unitLoader(input, bounded);
  const ordered = [...input.functions].sort((a, b) =>
    a.entry.value < b.entry.value
      ? -1
      : a.entry.value > b.entry.value
        ? 1
        : a.id.localeCompare(b.id),
  );
  const objects: ImageTypeObject[] = [];
  const analyzed = new Set<string>();
  let complete = true;
  for (const [index, fn] of ordered.entries()) {
    context.progress('image_types', index, ordered.length);
    try {
      const facts = loadFacts(input, fn, load, bounded);
      if (facts) objects.push(...facts.objects);
      analyzed.add(fn.id);
    } catch (error) {
      const details = error instanceof OperationError ? error.diagnostic.details : undefined;
      if (
        !(error instanceof OperationError) ||
        error.code !== 'resource_limit' ||
        details?.kind !== 'limit' ||
        details.resource !== 'work'
      )
        throw error;
      context.checkpoint(0);
      // The shared pass limit ends the walk; one oversized body is skipped.
      if (details.limit === limit || bounded.remainingWork!() === 0) {
        complete = false;
        break;
      }
    }
  }
  const references = input.scope.store.queryRecords({
    kind: 'reference',
    image_id: input.image.id,
    revision: input.revision,
    limit: 1,
  }).index_state;
  const open = new Set<string>();
  for (const object of objects)
    for (const { anchor } of object.anchors)
      if (!localImageAnchor(anchor) && (!complete || references !== 'complete'))
        open.add(imageAnchorKey(anchor));
  const unloaded = new Set(input.functions.filter((fn) => !analyzed.has(fn.id)).map((fn) => fn.id));
  const solution = solveImageTypes(
    objects,
    {
      functions: typeFunctions(
        input,
        new Set(
          objects.flatMap((object) => [
            object.function_id,
            ...object.anchors.map(({ anchor }) => anchor.function_id),
          ]),
        ),
      ),
      unloaded,
      open,
    },
    new AnalysisBudget({
      max_work: context.remainingWork?.() ?? context.budget.work,
      checkpoint: (work) => context.checkpoint(work),
    }),
  );
  const names = typeFunctions(
    input,
    input.functions.map((fn) => fn.id),
  );
  const declared = [...solution.classes]
    .filter((item) => !item.local && item.fields.length)
    .sort((a, b) => a.name.localeCompare(b.name));
  // Bound classes print as their declaration; competing declarations are noted.
  const user = imageTypeBindings(
    input.scope,
    input.revision,
    input.components.abi,
    declared,
    context,
  );
  const declarations = user.records.map((record) => ({
    name: record.spelling ?? null,
    type_id: record.id,
    definition: record.definition,
  }));
  const views = new Map<string, ImageTypeUserView>();
  for (const [class_id, binding] of user.bound)
    views.set(class_id, {
      bound: {
        spelling: binding.spelling,
        declarations: typeDeclarations(declarations, [binding.type_id], context),
      },
      note:
        `declared by the asserted signature of ${bindingRoles(input, binding.sources)}` +
        (binding.outside.length
          ? `; observed members outside the declaration: ${outsideMembers(binding.outside)}`
          : ''),
    });
  for (const [class_id, conflict] of user.conflicts)
    views.set(class_id, {
      note: `unbound: asserted signatures declare ${conflict
        .map((entry) => `${entry.spelling} (${bindingRoles(input, entry.sources)})`)
        .join(', ')}`,
    });
  let shown = declared.length,
    text = '';
  for (;;) {
    context.checkpoint(shown + 1);
    text = renderImageTypeDeclarations(
      declared.slice(0, shown),
      (id) => names.get(id)?.name ?? id,
      views,
    );
    if (Buffer.byteLength(text) <= max_bytes || shown === 0) break;
    shown = Math.floor(shown / 2);
  }
  return {
    text,
    state: complete && shown === declared.length ? 'complete' : 'partial',
    analyzed: analyzed.size,
    total: input.functions.length,
    types: shown,
  };
}

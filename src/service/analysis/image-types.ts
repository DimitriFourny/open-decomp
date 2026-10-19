import {
  entityIdentity,
  fingerprint,
  OperationError,
  type AbiProfile,
  type CanonicalValue,
  type Diagnostic,
  type Evidence,
  type FunctionRecord,
  type LoadedImage,
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
import {
  createAffineResolver,
  memoryAddressSources,
  memoryLoopParameters,
} from '../../analysis/types/memory-shapes.js';
import {
  compareImageFields,
  imageAnchorKey,
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
  TypeRecoveryResult,
} from '../../analysis/types/index.js';
import { cSourceName } from '../../metadata/symbols/c-names.js';
import type { AnalysisReadset } from '../../project/cache/dependencies.js';
import { nativeCallIndex } from './calls.js';
import { nativeArgumentValues } from './native-arguments.js';
import { parameterRegisters } from './native-abi.js';
import {
  nativeDependencies,
  type NativePreparationInput,
  type PreparedNativeUnit,
} from './native-prepare.js';
import { renderImageTypeDeclarations } from '../../emitters/image-types.js';
import type { NativeDependency } from './native-worklist.js';
import {
  loadNativeUnit,
  nativeCapacity,
  nativeLibraryContracts,
  nativeUnitCache,
  type SourceFactsInput,
} from './source-facts.js';
import { pipelineVersions } from './versions.js';

/** Bounded neighborhood: at most this many other function bodies per request. */
const MAX_NEIGHBOR_FUNCTIONS = 12;
/** Callers visited per callee flow before the flow counts as unexplored. */
const MAX_CALLERS_PER_FLOW = 4;
/** Pointee hops followed from the requested function's own objects. */
const MAX_POINTEE_DEPTH = 2;

interface FunctionFacts {
  readonly objects: readonly ImageTypeObject[];
  readonly readset?: AnalysisReadset;
}

/** Per-image function facts for one exact revision/component identity. Facts
 * derive only from one body's local SSA/type recovery, so any request with
 * the same identity reuses them; incomplete preparations are never cached. */
const factCaches = new WeakMap<
  LoadedImage,
  { readonly identity: string; readonly facts: Map<string, FunctionFacts> }
>();

function factCache(input: NativePreparationInput): Map<string, FunctionFacts> {
  const { image, components, revision } = input;
  const identity = fingerprint({
    revision,
    image: image.sha256,
    slice: image.selected_slice_id,
    target: image.target,
    versions: pipelineVersions(image.target, 'c-like'),
    lifter: `${components.lifter.name}/${components.lifter.version}`,
    abi: `${components.abi.id}/${components.abi.version}`,
    native_types: input.native_types,
  } as unknown as CanonicalValue);
  let cached = factCaches.get(image);
  if (!cached || cached.identity !== identity) {
    cached = { identity, facts: new Map() };
    factCaches.set(image, cached);
  }
  return cached.facts;
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
      if (field.dynamic || field.offset < 0n) continue;
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
    objects.set(objectKey(shape.base.value_id, 0n), {
      fields,
      anchors: new Map(),
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
  for (const [index, value] of nativeArgumentValues(ir, types.calls, ir.id, observed, context))
    anchor(value, { kind: 'argument', function_id: fn.id, index }, true);
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
        ir,
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
        ir,
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

/** Load facts for one body: cached facts (replaying their reads) or a bounded
 * native preparation. Null when the body has no complete local recovery. */
function loadFacts(
  input: NativePreparationInput,
  fn: FunctionRecord,
  load: (fn: FunctionRecord) => PreparedNativeUnit,
  cache: Map<string, FunctionFacts>,
  context: OperationContext,
): FunctionFacts | null {
  const cached = cache.get(fn.id);
  if (cached && (!input.scope.dependencies || cached.readset)) {
    context.checkpoint(1 + cached.objects.length);
    if (cached.readset) input.scope.dependencies?.replay(cached.readset);
    return cached;
  }
  const unit = load(fn);
  if (!unit.ir || !unit.types || unit.types.state !== 'complete' || unit.budget_truncated)
    return null;
  const facts: FunctionFacts = {
    objects: functionTypeObjects(
      fn,
      unit.ir,
      unit.types,
      unit.dependencies,
      input.components.abi,
      context,
    ),
    ...(unit.dependency_readset ? { readset: unit.dependency_readset } : {}),
  };
  if (cache.size < 4096) cache.set(fn.id, facts);
  return facts;
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
  const capacity = nativeCapacity(input, context);
  const units = nativeUnitCache(input, capacity, context);
  const contracts = nativeLibraryContracts(input);
  const cache = factCache(input);
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
        loaded = loadFacts(
          input,
          fn,
          (target) => loadNativeUnit(input, units, target, context, contracts),
          cache,
          context,
        );
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
      if (anchor.kind !== 'stack') pending.push({ key: imageAnchorKey(anchor), depth });
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
      if (anchor.kind !== 'stack' && byId.has(anchor.function_id) && !facts.get(anchor.function_id))
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
      if (anchor.kind !== 'stack' && (!expanded.has(key) || references !== 'complete'))
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
 * other functions are added only where they do not overlap a local member. */
export function applyImageTypes(
  input: SourceFactsInput,
  solution: ImageTypeSolution,
  types: TypeRecoveryResult,
  context: OperationContext,
): TypeRecoveryResult {
  const slice = input.image.selected_slice_id;
  const classes = new Map(solution.classes.map((item) => [item.id, item]));
  const records = [...types.types];
  const byId = new Map<string, SuppliedTypeRecord>();
  for (const record of records) byId.set(record.id, record);
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
        `Layout ${item.name} joins ${item.members.length} observed view(s) in ` +
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
    const existing = typeIds.get(class_id);
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
      const element =
        definition?.kind === 'array' ? byId.get(definition.element)?.definition : definition;
      const bits =
        element?.kind === 'integer' || element?.kind === 'float'
          ? element.bits
          : element?.kind === 'pointer'
            ? 64
            : 8;
      return { start: field.offset, end: field.offset + BigInt(Math.ceil(bits / 8)) };
    });
    const added: ImageTypeField[] = [];
    for (const field of item.fields) {
      context.checkpoint(1);
      const end = field.offset + BigInt(Math.ceil(field.width_bits / 8));
      if (occupied.some((range) => field.offset < range.end && range.start < end)) continue;
      occupied.push({ start: field.offset, end });
      added.push(field);
    }
    const last = occupied.reduce((max, range) => (range.start > max ? range.start : max), 0n);
    // C declares an unknown element count only as the last member: an earlier
    // indexed member keeps its first element (indexed accesses stay explicit).
    for (const [index, field] of fields.entries()) {
      const definition = byId.get(field.type_id)?.definition;
      if (definition?.kind === 'array' && definition.count === null && field.offset !== last)
        fields[index] = { ...field, type_id: definition.element };
    }
    for (const field of added)
      fields.push({
        id: entityIdentity(slice, 'image-type-field', [
          item.id,
          field.offset,
          field.width_bits,
          field.stride,
        ]),
        name: `field_${field.offset.toString(16)}`,
        offset: field.offset,
        type_id: memberType(item, field, proofIds, field.offset === last && last > 0n),
      });
    fields.sort((a, b) => (a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0));
    return { kind: 'structure', size: null, alignment: null, fields };
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
  for (const class_id of pendingClasses) {
    const record: SuppliedTypeRecord = {
      id: typeIds.get(class_id)!,
      definition: { kind: 'structure', size: null, alignment: null, fields: [] },
      source: 'analysis',
      status: 'candidate',
      evidence_ids: [proof(classes.get(class_id)!)],
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
      name: item.name,
      state: item.state,
      functions: item.functions.length,
      conflicts: item.conflicts.map((id) => classes.get(id)?.name ?? id),
    });
  }
  return {
    ...types,
    types: records,
    subjects: [...new Set([...types.subjects, ...records.map((record) => record.id)])].sort(),
    evidence: [...types.evidence, ...evidence].sort((a, b) => a.id.localeCompare(b.id)),
    image_types: bindings.sort((a, b) => a.type_id.localeCompare(b.type_id)),
  };
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
  // quarter of what remains and as much as the selected function used so far.
  const remaining = context.remainingWork?.() ?? context.budget.work;
  const limit = Math.max(
    0,
    remaining - Math.max(Math.ceil(remaining / 4), context.budget.work - remaining),
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
    return { types: applyImageTypes(input, solution, types, bounded), diagnostics: [] };
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
  const capacity = {
    instructions: context.budget.instructions,
    blocks: context.budget.blocks,
    nodes: context.budget.ir_nodes,
  };
  const units = nativeUnitCache(input, capacity, context);
  const contracts = nativeLibraryContracts(input);
  const cache = factCache(input);
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
      const facts = loadFacts(
        input,
        fn,
        (target) => loadNativeUnit(input, units, target, bounded, contracts),
        cache,
        bounded,
      );
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
      if (anchor.kind !== 'stack' && (!complete || references !== 'complete'))
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
  let shown = declared.length,
    text = '';
  for (;;) {
    context.checkpoint(shown + 1);
    text = renderImageTypeDeclarations(declared.slice(0, shown), (id) => names.get(id)?.name ?? id);
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

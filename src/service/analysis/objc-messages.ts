import type {
  AbiProfile,
  AbiSignature,
  AbiType,
  Evidence,
  FunctionRecord,
  LoadedImage,
  OperationContext,
  ReferenceRecord,
  RegisterDescriptor,
} from '../../core/index.js';
import {
  bitWidth,
  type DataType,
  type Expression,
  type Instruction,
  type RegisterBinding,
  type SSAForm,
} from '../../ir/index.js';
import { preparedCallArguments } from '../../analysis/calls/argument-preparation.js';
import { objcImageIndex, type ObjCFact } from '../../metadata/runtime/objc-index.js';
import {
  parseObjCMethodType,
  selectorArity,
  variadicSelectors,
} from '../../metadata/runtime/objc-types.js';
import type {
  InferredCallee,
  ObjCMessage,
  ObjCSourceFacts,
  SourceAddress,
} from '../../reconstruction/source-model.js';
import { sourceConstantValues } from '../../reconstruction/source-data.js';
import { nativeCallIndex } from './calls.js';
import { printfArgumentTypes } from './source-variadic.js';

type CallNode = Extract<Instruction, { kind: 'call' }>;

/** libobjc entry points that are, by their objc4 definitions, exactly a message
 * send to their first argument; their remaining arguments are keyword arguments. */
const RUNTIME_MESSAGES: Readonly<Record<string, { selector: string; inner?: string }>> = {
  _objc_alloc: { selector: 'alloc' },
  _objc_alloc_init: { selector: 'init', inner: 'alloc' },
  _objc_opt_new: { selector: 'new' },
  _objc_opt_class: { selector: 'class' },
  _objc_opt_self: { selector: 'self' },
  _objc_opt_isKindOfClass: { selector: 'isKindOfClass:' },
  _objc_opt_respondsToSelector: { selector: 'respondsToSelector:' },
};
/** Dispatchers taking (receiver-or-objc_super, SEL, arguments...). */
const DISPATCHERS: Readonly<Record<string, 'send' | 'super'>> = {
  _objc_msgSend: 'send',
  _objc_msgSendSuper: 'super',
  _objc_msgSendSuper2: 'super',
};

export interface ObjCSourceResult {
  /** Source-view call interfaces closed by a resolved selector. */
  readonly callees: readonly InferredCallee[];
  readonly addresses: readonly SourceAddress[];
  readonly facts?: ObjCSourceFacts;
  readonly evidence: readonly Evidence[];
}

/** Resolve Objective-C message sends from static metadata: `__objc_stubs`
 * entries name their selector; `objc_msgSend`/`objc_msgSendSuper2` take it from
 * an exact 64-bit load of an `__objc_selrefs` slot in the selector register.
 * Keyword arity is the selector's colon count; argument classes come from the
 * image's unique method type encoding for that selector, otherwise integer/
 * pointer class. A list closes only when the caller prepares no FP/SIMD
 * argument register and no integer argument register beyond that arity; known
 * variadic selectors keep an open tail. Unresolved selectors stay calls. */
export function objcSourceFacts(input: {
  readonly ir: SSAForm;
  readonly image: LoadedImage;
  readonly revision: number;
  readonly functions: readonly FunctionRecord[];
  readonly references: readonly ReferenceRecord[];
  readonly abi: AbiProfile;
  readonly context: OperationContext;
  readonly callees: ReadonlyMap<string, InferredCallee>;
  readonly addresses: readonly SourceAddress[];
}): ObjCSourceResult {
  const { ir, image, abi, context } = input;
  const unchanged: ObjCSourceResult = { callees: [], addresses: input.addresses, evidence: [] };
  if (image.target.format !== 'macho') return unchanged;
  const index = objcImageIndex(image, input.revision, context);
  if (!index) return unchanged;
  const evidence = new Map<string, Evidence>();
  const cite = (fact: ObjCFact): string[] => {
    for (const item of fact.evidence) evidence.set(item.id, item);
    return fact.evidence.slice(0, 1).map((item) => item.id);
  };
  const expressions = new Map<string, Expression>();
  const loads = new Map<string, Extract<Instruction, { kind: 'load' }>>();
  const calls: CallNode[] = [];
  for (const block of ir.blocks)
    for (const node of block.instructions) {
      context.checkpoint(1);
      if (node.kind === 'assign') expressions.set(node.result.id, node.expression);
      else if (node.kind === 'load') loads.set(node.result.id, node);
      else if (node.kind === 'call') calls.push(node);
    }
  const constant = sourceConstantValues(expressions, context, image.id);

  // Exact address identities used by this function.
  const objcAddress = (value: bigint): SourceAddress['objc'] | undefined => {
    const string = index.strings.get(value);
    if (string) return { kind: 'string', text: string.name };
    const selector = index.selector_refs.get(value);
    if (selector) return { kind: 'selector_ref', text: selector.name };
    const cls = index.class_refs.get(value);
    if (cls) return { kind: 'class_ref', text: cls.name };
    return undefined;
  };
  const used = new Map<bigint, NonNullable<SourceAddress['objc']>>();
  const note = (value: bigint | undefined): void => {
    const fact = value === undefined ? undefined : objcAddress(value);
    if (value === undefined || !fact) return;
    used.set(value, fact);
    const source =
      index.strings.get(value) ?? index.selector_refs.get(value) ?? index.class_refs.get(value);
    if (source) cite(source);
  };
  for (const block of ir.blocks)
    for (const node of block.instructions) {
      if (node.kind === 'assign' && node.result.type.kind === 'integer')
        if (node.result.type.bits === image.target.address_bits) note(constant(node.result));
      if (node.kind !== 'call') continue;
      // A call input may be bound as several constant register cells.
      const roots = new Map<string, { bits: bigint; width: number } | null>();
      for (const binding of node.register_inputs) {
        const prior = roots.get(binding.register.root);
        const bits = constant(binding.value);
        if (prior === null) continue;
        roots.set(
          binding.register.root,
          bits === undefined
            ? null
            : {
                bits: (prior?.bits ?? 0n) | (bits << BigInt(binding.register.offset_bits)),
                width: (prior?.width ?? 0) + binding.register.width_bits,
              },
        );
      }
      for (const cell of roots.values())
        if (cell && cell.width === image.target.address_bits) note(cell.bits);
    }
  const annotated = new Set<bigint>();
  const addresses = input.addresses.map((item) => {
    const fact = item.address.space === 'va' ? used.get(item.address.value) : undefined;
    if (!fact) return item;
    annotated.add(item.address.value);
    return { ...item, objc: fact };
  });
  for (const [value, fact] of used)
    if (!annotated.has(value))
      addresses.push({ address: { image_id: image.id, space: 'va', value }, objc: fact });

  const callIndex = nativeCallIndex(image, input.functions, input.references, context);
  const registers = (type: AbiType, count: number): RegisterDescriptor[] =>
    abi
      .classifyCall({
        returns: { kind: 'void' },
        parameters: Array.from({ length: count }, () => type),
        variadic: false,
        fixed_parameter_count: count,
      })
      .parameters.flatMap((parameter) =>
        parameter.locations.flatMap((location) =>
          location.kind === 'register' ? [location.register] : [],
        ),
      );
  const integerArguments = registers({ kind: 'pointer' }, 8),
    floatArguments = registers({ kind: 'float', bits: 64 }, 8);
  const selectorRegister = integerArguments[1],
    receiverRegister = integerArguments[0];
  if (!selectorRegister || !receiverRegister)
    return {
      callees: [],
      addresses,
      evidence: [...evidence.values()],
    };
  const prepared = preparedCallArguments(ir, context);
  const scalar = (type: AbiType): DataType | null =>
    type.kind === 'pointer'
      ? { kind: 'integer', bits: image.target.address_bits }
      : type.kind === 'integer'
        ? { kind: 'integer', bits: type.bits }
        : type.kind === 'float' && (type.bits === 32 || type.bits === 64)
          ? { kind: 'float', bits: type.bits }
          : null;
  /** Register interface for (receiver, SEL, keyword arguments) or null. */
  const layout = (
    types: readonly AbiType[],
    returns: AbiType | null,
  ): {
    parameters: RegisterDescriptor[];
    parameter_types: DataType[];
    returns: RegisterDescriptor[] | null;
    return_types: DataType[] | null;
  } | null => {
    const signature: AbiSignature = {
      returns: returns ?? { kind: 'void' },
      parameters: types,
      variadic: false,
      fixed_parameter_count: types.length,
    };
    const classified = abi.classifyCall(signature);
    if (classified.state !== 'complete' || classified.hidden_result) return null;
    const parameters: RegisterDescriptor[] = [],
      parameter_types: DataType[] = [];
    for (const parameter of classified.parameters) {
      const location = parameter.locations.length === 1 ? parameter.locations[0] : undefined;
      const type = scalar(types[parameter.index]!);
      if (
        location?.kind !== 'register' ||
        !type ||
        location.value_offset_bits !== 0 ||
        location.width_bits !== bitWidth(type)
      )
        return null;
      parameters.push({ ...location.register, width_bits: bitWidth(type) });
      parameter_types.push(type);
    }
    // Darwin does not define the upper bits of a sub-32-bit result register;
    // such results keep their observed storage instead of a narrowed type.
    if (returns === null || (returns.kind === 'integer' && returns.bits < 32))
      return { parameters, parameter_types, returns: null, return_types: null };
    if (returns.kind === 'void')
      return { parameters, parameter_types, returns: [], return_types: [] };
    const type = scalar(returns),
      location = classified.returns.length === 1 ? classified.returns[0] : undefined;
    if (
      !type ||
      location?.kind !== 'register' ||
      location.value_offset_bits !== 0 ||
      location.width_bits !== bitWidth(type)
    )
      return null;
    return {
      parameters,
      parameter_types,
      returns: [{ ...location.register, width_bits: bitWidth(type) }],
      return_types: [type],
    };
  };
  const selectorOf = (inputs: readonly RegisterBinding[]): ObjCFact | undefined => {
    const binding = inputs.find(
      (item) =>
        item.register.root === selectorRegister.root &&
        item.register.offset_bits === 0 &&
        item.register.width_bits === 64,
    );
    const load = binding && loads.get(binding.value.id);
    if (!load || bitWidth(load.result.type) !== 64) return undefined;
    const slot = constant(load.address);
    return slot === undefined ? undefined : index.selector_refs.get(slot);
  };

  const messages = new Map<string, ObjCMessage>();
  const callees: InferredCallee[] = [];
  // Calls and tail transfers with a constant direct target.
  const sites: {
    readonly id: string;
    readonly target: bigint;
    readonly inputs: readonly RegisterBinding[];
    readonly call?: CallNode;
    readonly evidence_ids: readonly string[];
  }[] = [];
  for (const call of calls)
    if (call.target.kind === 'direct' && call.target.address.image_id === image.id)
      sites.push({
        id: call.id,
        target: call.target.address.value,
        inputs: call.register_inputs,
        call,
        evidence_ids: call.provenance.evidence_ids,
      });
  for (const block of ir.blocks) {
    const control = block.terminator;
    if (control.kind !== 'indirect' || !control.tail_call) continue;
    const target = constant(control.target);
    const exit = ir.register_states.find((row) => row.block === block.id)?.exit;
    if (target !== undefined && exit)
      sites.push({
        id: control.id,
        target,
        inputs: exit,
        evidence_ids: control.provenance.evidence_ids,
      });
  }
  for (const site of sites) {
    context.checkpoint(1);
    const target = site.target;
    const imported = callIndex.imports_by_address.get(`${image.id}:va:${target}`) ?? [];
    const name = imported.length === 1 ? imported[0]!.original_name : null;
    const runtime = name ? RUNTIME_MESSAGES[name] : undefined;
    if (runtime) {
      if (site.call) messages.set(site.id, { ...runtime, form: 'runtime', variadic: false });
      continue;
    }
    const stub = index.stubs.get(target);
    const dispatcher = name ? DISPATCHERS[name] : undefined;
    const fact = stub ?? (dispatcher ? selectorOf(site.inputs) : undefined);
    if (!fact) continue;
    const selector = fact.name,
      arity = selectorArity(selector),
      declared = variadicSelectors[selector],
      variadic = declared !== undefined;
    // A known NSString format argument that is an exact constant string fixes
    // the complete actual list: the promoted printf/`%@` actuals occupy Darwin's
    // anonymous-argument stack slots, read as stack parameters of the send.
    let formatted: InferredCallee['stack_parameters'] | undefined;
    if (
      declared?.format !== null &&
      declared !== undefined &&
      site.call &&
      dispatcher !== 'super'
    ) {
      const register = integerArguments[2 + declared.format];
      const cells = register
        ? site.call.register_inputs.filter((binding) => binding.register.root === register.root)
        : [];
      let bits = 0n,
        width = 0;
      for (const cell of cells) {
        const value = constant(cell.value);
        if (value === undefined) {
          width = -1;
          break;
        }
        bits |= value << BigInt(cell.register.offset_bits);
        width += cell.register.width_bits;
      }
      const literal = width === 64 ? index.strings.get(bits) : undefined;
      const actuals = literal ? printfArgumentTypes(literal.name, abi, true) : null;
      const fixed: AbiType[] = Array.from({ length: arity + 2 }, () => ({ kind: 'pointer' }));
      const classified = actuals
        ? abi.classifyCall({
            returns: { kind: 'pointer' },
            parameters: [...fixed, ...actuals],
            variadic: true,
            fixed_parameter_count: fixed.length,
            argument_list_complete: true,
          })
        : null;
      const slots: { offset: bigint; width_bits: number; type: DataType }[] | null =
        classified?.state === 'complete' ? [] : null;
      for (const parameter of classified?.parameters.slice(fixed.length) ?? []) {
        const location = parameter.locations.length === 1 ? parameter.locations[0] : undefined;
        const type = scalar(actuals![parameter.index - fixed.length]!);
        if (!slots || location?.kind !== 'stack' || location.value_offset_bits !== 0 || !type) {
          slots?.splice(0);
          break;
        }
        slots.push({ offset: location.offset, width_bits: bitWidth(type), type });
      }
      if (literal && slots && slots.length === actuals!.length) {
        formatted = slots;
        cite(literal);
      }
    }
    const encoding = index.selector_types.get(selector);
    const parsed = encoding ? parseObjCMethodType(encoding) : null;
    const typed =
      parsed && parsed.parameters.length === arity + 2
        ? layout(
            parsed.parameters.map((item) => item.abi),
            parsed.returns.abi,
          )
        : null;
    // Without a type encoding a tail transfer has no caller preparation to
    // check argument classes against; only a keyword-free selector qualifies.
    if (!site.call && !typed && arity > 0) continue;
    const interface_ =
      typed ??
      layout(
        Array.from({ length: arity + 2 }, () => ({ kind: 'pointer' }) as const),
        null,
      );
    if (!interface_) continue;
    // The stub loads the selector itself; its caller supplies no SEL argument.
    const parameters = stub
      ? interface_.parameters.filter((_, index) => index !== 1)
      : interface_.parameters;
    const parameter_types = stub
      ? interface_.parameter_types.filter((_, index) => index !== 1)
      : interface_.parameter_types;
    const expected = new Set(parameters.map((register) => register.root));
    const call = site.call;
    const extra =
      call !== undefined &&
      call.register_inputs.some(
        (binding) =>
          !expected.has(binding.register.root) &&
          (integerArguments.some((register) => register.root === binding.register.root) ||
            floatArguments.some((register) => register.root === binding.register.root)) &&
          !(stub && binding.register.root === selectorRegister.root) &&
          prepared(call, binding),
      );
    if (extra) continue;
    const observed = input.callees.get(site.id);
    let returns = interface_.returns,
      return_types = interface_.return_types;
    const declaredVoid = (typed && parsed?.returns.role === 'void') || declared?.returns === 'void';
    if (declaredVoid) {
      returns = [];
      return_types = [];
    } else if (returns === null || return_types === null) {
      // Unknown result class: keep observed result storage and the integer
      // result register a message returns its id/integer result in.
      returns = [...(observed?.returns ?? [])];
      return_types = [
        ...(observed?.return_types ??
          returns.map((register) => ({ kind: 'integer', bits: register.width_bits }) as const)),
      ];
      if (!returns.some((register) => register.root === receiverRegister.root)) {
        returns.unshift({ ...receiverRegister, width_bits: 64 });
        return_types.unshift({ kind: 'integer', bits: 64 });
      }
    }
    if (dispatcher !== 'super')
      messages.set(site.id, { selector, form: stub ? 'stub' : 'send', variadic });
    callees.push({
      call_id: site.id,
      target: { image_id: image.id, space: 'va', value: target },
      parameters,
      parameter_types,
      returns,
      return_types,
      ...(declaredVoid ? { returns_void: true as const } : {}),
      parameter_state: 'observed',
      argument_list_complete: false,
      ...(formatted ? { stack_parameters: formatted } : {}),
      // A variadic selector closes only through its proven format actuals.
      ...(variadic && !formatted
        ? { variadic_stack: true as const }
        : { argument_list_closure: 'objc_selector' as const }),
      evidence_ids: [...cite(fact), ...site.evidence_ids],
    });
  }

  let method: ObjCSourceFacts['method'];
  const selected = input.functions.find((fn) => fn.id === ir.id);
  const records = selected ? index.methods.get(selected.entry.value) : undefined;
  const first = records?.[0];
  if (
    first &&
    records.every(
      (item) => item.owner === first.owner && item.name === first.name && item.kind === first.kind,
    )
  ) {
    cite(first);
    method = { owner: first.owner, selector: first.name, kind: first.kind };
  }
  return {
    callees,
    addresses,
    ...(messages.size || method ? { facts: { messages, ...(method ? { method } : {}) } } : {}),
    evidence: [...evidence.values()],
  };
}

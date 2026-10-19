import {
  fingerprint,
  OperationError,
  type AbiLocation,
  type AbiSignature,
  type AbiType,
  type CanonicalValue,
  type OperationContext,
  type PresentationView,
  type RegisterDescriptor,
} from '../core/index.js';
import type { EmissionInput } from '../emitters/model.js';
import {
  bitWidth,
  expressionOperands,
  integer,
  sameType,
  type DataType,
  type Expression,
  type RegisterBinding,
  type Value,
} from '../ir/index.js';
import type { BlockRegion } from '../presentation/index.js';
import type { Assignment, BoundaryProjection, TailProjection } from './model.js';
import type { InferredCallee, SourcePresentation } from './source-model.js';
import { sourceDataValues } from './source-data.js';
import type { SignatureAssociation } from '../analysis/types/model.js';
import {
  registerTypeSlices,
  registerTypes,
  unchangedStorage,
  type StorageCopy,
} from './source-register-types.js';
import { sourceStackArgumentParts } from './source-stack-arguments.js';
import { planSourceRequirements } from './source-requirements.js';
import { possibleAbiReturnStorage } from '../analysis/calls/return-storage.js';
import { LocalValidationSession } from './local-validation.js';
import { selectSourcePrimaryResult, type SourcePrimaryResult } from './source-results.js';

/** Source ABI abstraction: architectural snapshots are retained in the input,
 * not treated as extra source arguments or memory-fault observables. */
export function planSource(
  input: EmissionInput,
  blocks: ReadonlyMap<string, BlockRegion>,
  values: Map<string, Value>,
  expressions: Map<string, Expression>,
  owner: Map<string, string>,
  context: OperationContext,
  view: PresentationView = 'checked',
  validation = new LocalValidationSession(context),
) {
  const evidence = input.source!,
    abi = evidence.abi,
    entry = blocks.get(input.function.entry)!;
  const forcedInline = new Set<string>(),
    calls = new Map<string, BoundaryProjection>(),
    returns = new Map<string, BoundaryProjection>();
  const tails = new Map<string, TailProjection>();
  const callResults = new Map<string, readonly Value[]>(),
    parameterNames = new Map<string, string>();
  const demotedParameters = new Set<string>();
  const parameters: Value[] = [],
    parameterRegisters = new Map<string, RegisterDescriptor>();
  const valueOrigins = new Map<string, readonly string[]>();
  const definitions = new Map<string, Assignment[]>(),
    anchors = new Map<string, Assignment>();
  const originalDefinitions = new Map<string, Assignment>();
  for (const block of blocks.values())
    for (const node of block.statements)
      if (node.kind === 'assign') originalDefinitions.set(node.result.id, node);
  const make = (
    key: string,
    type: DataType,
    block: string,
    expression?: Expression,
    contributors?: readonly Value[],
  ): Value => {
    context.checkpoint(1);
    const value = { id: `entity_${fingerprint(['source-value', input.function.id, key])}`, type };
    const existing = values.get(value.id);
    if (existing) return existing;
    values.set(value.id, value);
    owner.set(value.id, block);
    if (values.size > context.budget.ir_nodes)
      throw new OperationError({
        code: 'resource_limit',
        severity: 'error',
        message: 'Source reconstruction value budget exceeded',
        evidence_ids: [],
      });
    if (expression) {
      expressions.set(value.id, expression);
      forcedInline.add(value.id);
    }
    const anchor =
      expression?.kind === 'extract'
        ? (originalDefinitions.get(expression.value.id) ?? anchors.get(expression.value.id))
        : undefined;
    if (anchor) {
      anchors.set(value.id, anchor);
      owner.set(value.id, owner.get(anchor.result.id)!);
    }
    valueOrigins.set(
      value.id,
      (contributors ?? (expression ? expressionOperands(expression) : [])).flatMap(
        (operand) => valueOrigins.get(operand.id) ?? [operand.id],
      ),
    );
    return value;
  };
  const alias = (value: Value, expression: Expression): void => {
    expressions.set(value.id, expression);
    forcedInline.add(value.id);
  };
  const machineType = (type: AbiType): DataType | null => {
    if (type.kind === 'pointer') return integer(abi.layout.pointer_bits);
    if (type.kind === 'integer') return integer(type.bits);
    if (type.kind === 'float' && (type.bits === 32 || type.bits === 64))
      return { kind: 'float', bits: type.bits };
    if (type.kind === 'vector') {
      const element: Exclude<DataType, { kind: 'vector' }> | null =
        type.element === 'integer'
          ? integer(type.element_bits)
          : type.element_bits === 32 || type.element_bits === 64
            ? { kind: 'float' as const, bits: type.element_bits }
            : null;
      if (element) return { kind: 'vector', element, lanes: type.lanes };
    }
    return null;
  };
  const bind = (
    key: string,
    bindings: readonly RegisterBinding[],
    locations: readonly AbiLocation[],
    type: DataType,
    block: string,
  ): Value | null => {
    const parts: { offset: number; value: Value }[] = [];
    for (const location of locations) {
      context.checkpoint(1);
      if (location.kind !== 'register') return null;
      const start = location.register.offset_bits,
        end = start + location.width_bits;
      let cursor = start;
      const matches = bindings
        .filter(
          (binding) =>
            binding.register.root === location.register.root &&
            binding.register.offset_bits < end &&
            binding.register.offset_bits + binding.register.width_bits > start,
        )
        .sort((a, b) => a.register.offset_bits - b.register.offset_bits);
      for (const binding of matches) {
        context.checkpoint(1);
        const low = Math.max(start, binding.register.offset_bits),
          high = Math.min(end, binding.register.offset_bits + binding.register.width_bits);
        if (low !== cursor) return null;
        const width = high - low;
        const value =
          low === binding.register.offset_bits && width === bitWidth(binding.value.type)
            ? binding.value
            : make(`${key}:part:${parts.length}`, integer(width), block, {
                kind: 'extract',
                value: binding.value,
                offset: low - binding.register.offset_bits,
              });
        parts.push({ offset: location.value_offset_bits + low - start, value });
        cursor = high;
      }
      if (cursor !== end) return null;
    }
    parts.sort((a, b) => a.offset - b.offset);
    let width = 0;
    for (const part of parts) {
      if (part.offset !== width) return null;
      width += bitWidth(part.value.type);
    }
    if (width !== bitWidth(type)) return null;
    if (parts.length === 1 && parts[0]!.value.type.kind === type.kind) return parts[0]!.value;
    return make(
      key,
      type,
      block,
      parts.length === 1
        ? { kind: 'cast', op: 'bitcast', value: parts[0]!.value }
        : { kind: 'concat', values: parts.map((part) => part.value) },
    );
  };
  const result = (
    key: string,
    bindings: readonly RegisterBinding[],
    locations: readonly AbiLocation[],
    type: DataType,
    block: string,
  ): Value | null => {
    // Validate coverage before replacing cells; a partial projection never invents bits.
    const assembled = bind(`${key}:coverage`, bindings, locations, type, block);
    if (!assembled) return null;
    const whole = make(key, type, block);
    valueOrigins.set(
      whole.id,
      bindings
        .filter((binding) =>
          locations.some(
            (location) =>
              location.kind === 'register' && location.register.root === binding.register.root,
          ),
        )
        .map((binding) => binding.value.id),
    );
    for (const location of locations) {
      if (location.kind !== 'register') return null;
      for (const binding of bindings) {
        context.checkpoint(1);
        if (binding.register.root !== location.register.root) continue;
        const low = Math.max(binding.register.offset_bits, location.register.offset_bits),
          high = Math.min(
            binding.register.offset_bits + binding.register.width_bits,
            location.register.offset_bits + location.width_bits,
          );
        if (low >= high) continue;
        const offset = location.value_offset_bits + low - location.register.offset_bits;
        if (low === binding.register.offset_bits && high - low === binding.register.width_bits) {
          alias(
            binding.value,
            bitWidth(binding.value.type) === bitWidth(type) && offset === 0
              ? { kind: 'cast', op: 'bitcast', value: whole }
              : { kind: 'extract', value: whole, offset },
          );
        } else {
          const base = make(`${key}:unmodeled:${binding.value.id}`, binding.value.type, block, {
            kind: 'indeterminate',
            state: 'unknown',
            reason: 'bits outside source ABI result',
          });
          valueOrigins.set(base.id, [binding.value.id]);
          const part =
            offset === 0 && high - low === bitWidth(type)
              ? whole
              : make(`${key}:result-part:${binding.value.id}`, integer(high - low), block, {
                  kind: 'extract',
                  value: whole,
                  offset,
                });
          alias(binding.value, {
            kind: 'insert',
            base,
            value: part,
            offset: low - binding.register.offset_bits,
          });
        }
      }
    }
    return whole;
  };
  const locations = (register: RegisterDescriptor): readonly AbiLocation[] => [
    { kind: 'register', register, value_offset_bits: 0, width_bits: register.width_bits },
  ];
  const stores = new Map<string, Value>();
  for (const block of blocks.values())
    for (const node of block.statements) if (node.kind === 'store') stores.set(node.id, node.value);
  const bindStack = (
    key: string,
    boundary: string,
    offset: bigint,
    type: DataType,
    block: string,
  ): Value | null => {
    const stack = input.types?.calls?.stack;
    if (!stack) return null;
    const parts = sourceStackArgumentParts(
      stack,
      stores,
      boundary,
      offset,
      bitWidth(type),
      context,
    );
    if (!parts) return null;
    const values = parts.map((part, index) =>
      part.value_offset_bits === 0 && part.width_bits === bitWidth(part.value.type)
        ? part.value
        : make(`${key}:part:${index}`, integer(part.width_bits), block, {
            kind: 'extract',
            value: part.value,
            offset: part.value_offset_bits,
          }),
    );
    if (values.length === 1 && sameType(values[0]!.type, type)) return values[0]!;
    return make(
      key,
      type,
      block,
      values.length === 1
        ? { kind: 'cast', op: 'bitcast', value: values[0]! }
        : { kind: 'concat', values },
    );
  };
  const observedArguments = (
    callee: InferredCallee,
    bindings: readonly RegisterBinding[],
    boundary: string,
    block: string,
  ): { readonly arguments: readonly Value[]; readonly missing: boolean } => {
    const arguments_: Value[] = [];
    for (const [index, register] of callee.parameters.entries()) {
      const value = bind(
        `${boundary}:arg:${index}`,
        bindings,
        locations(register),
        callee.parameter_types?.[index] ?? integer(register.width_bits),
        block,
      );
      if (!value) return { arguments: arguments_, missing: true };
      arguments_.push(value);
    }
    for (const [index, parameter] of (callee.stack_parameters ?? []).entries()) {
      const value = bindStack(
        `${boundary}:stack-arg:${index}`,
        boundary,
        parameter.offset,
        parameter.type,
        block,
      );
      if (!value) return { arguments: arguments_, missing: true };
      arguments_.push(value);
    }
    return { arguments: arguments_, missing: false };
  };
  const inferred = new Map(evidence.callees.map((callee) => [callee.call_id, callee]));
  if (view === 'source')
    for (const callee of evidence.source_callees ?? []) inferred.set(callee.call_id, callee);
  const facts = new Map(input.types?.calls?.calls.map((fact) => [fact.node_id, fact]) ?? []);
  const conflicts = new Set(input.types?.conflicts.map((conflict) => conflict.subject_id) ?? []);
  const signatureFor = (subject: string) => {
    const signatures =
      input.types?.state === 'complete'
        ? input.types.signatures.filter((signature) => signature.subject_id === subject)
        : [];
    if (conflicts.has(subject) || signatures.length !== 1) return null;
    const signature = signatures[0]!;
    if (
      (signature.status !== 'established' && signature.status !== 'asserted') ||
      signature.signature.abi !== abi.id
    )
      return null;
    const resolve = (id: string): AbiType | null => {
      if (conflicts.has(id)) return null;
      const type = input.types!.types.find((type) => type.id === id)?.definition;
      if (type?.kind === 'void' || type?.kind === 'integer' || type?.kind === 'float') return type;
      if (type?.kind === 'pointer') return { kind: 'pointer' };
      if (type?.kind === 'vector') {
        const element = resolve(type.element);
        if (element?.kind === 'integer' || element?.kind === 'float')
          return {
            kind: 'vector',
            element: element.kind,
            element_bits: element.bits,
            lanes: type.lanes,
          };
      }
      return null;
    };
    const returned = resolve(signature.signature.return_type),
      types = signature.signature.parameters.map((parameter) => resolve(parameter.type_id));
    if (!returned || types.some((type) => type === null)) return null;
    const declaration: AbiSignature = {
      returns: returned,
      parameters: types as AbiType[],
      variadic: signature.signature.variadic,
      fixed_parameter_count: types.length,
    };
    return { signature, declaration };
  };
  for (const block of blocks.values())
    for (const node of block.statements) {
      context.checkpoint(1);
      if (node.kind !== 'call') continue;
      let projection: BoundaryProjection | null = null;
      const fact = facts.get(node.id);
      const declared = signatureFor(node.id);
      const contracts =
        fact?.status === 'established'
          ? fact.contracts.filter((contract) => contract.status === 'established')
          : [];
      const repeatedContract =
        view === 'source' &&
        contracts.length > 1 &&
        contracts.every(
          (contract) =>
            fingerprint(contract.contract.signature as unknown as CanonicalValue) ===
            fingerprint(contracts[0]!.contract.signature as unknown as CanonicalValue),
        );
      const formatSignature =
        view === 'source' ? evidence.call_argument_signatures?.get(node.id) : undefined;
      const declaration =
        formatSignature ??
        (contracts.length === 1 || repeatedContract
          ? contracts[0]!.contract.signature
          : declared?.declaration);
      if (declaration && fact?.status !== 'conflicting' && node.results.length === 0) {
        const countOverride = evidence.call_argument_counts?.get(node.id);
        const layout = abi.classifyCall({
          ...declaration,
          ...(countOverride === declaration.parameters?.length
            ? { argument_list_complete: true }
            : {}),
        });
        const count = countOverride ?? layout.argument_count;
        if (
          layout.state === 'complete' &&
          !layout.hidden_result &&
          count !== null &&
          count === declaration.parameters?.length
        ) {
          const args: Value[] = [];
          let valid = true;
          for (const parameter of layout.parameters) {
            const type = machineType(declaration.parameters![parameter.index]!);
            const location = parameter.locations.length === 1 ? parameter.locations[0] : undefined;
            const value =
              type &&
              (formatSignature && location?.kind === 'stack' && location.value_offset_bits === 0
                ? bindStack(
                    `${node.id}:arg:${parameter.index}`,
                    node.id,
                    location.offset,
                    type,
                    block.id,
                  )
                : bind(
                    `${node.id}:arg:${parameter.index}`,
                    node.register_inputs,
                    parameter.locations,
                    type,
                    block.id,
                  ));
            if (!value) {
              valid = false;
              break;
            }
            args.push(value);
          }
          if (node.arguments.some((value) => !args.some((argument) => argument.id === value.id)))
            valid = false;
          if (valid && (formatSignature || repeatedContract))
            valid = validation.presentation(
              'arity_closure',
              node.id,
              formatSignature
                ? 'library_format: established printf-family contract and exact immutable terminated format literal determine every promoted actual type; each ABI location is bound to original caller storage'
                : 'library_contract: all established callable-entry/import observations agree on the complete ABI signature; each actual is bound to original caller storage',
              [node.id],
            );
          const type = machineType(declaration.returns),
            returned =
              !valid || declaration.returns.kind === 'void'
                ? []
                : type
                  ? [
                      result(
                        `${node.id}:result`,
                        node.register_outputs,
                        layout.returns,
                        type,
                        block.id,
                      ),
                    ].filter((value): value is Value => value !== null)
                  : [];
          if (declaration.returns.kind !== 'void' && returned.length !== 1) valid = false;
          if (valid && (formatSignature || repeatedContract))
            validation.requireAbi(
              'arity_closure',
              [node.id],
              'Library closure assumes the established contract and ABI-conforming arguments, including variadic default promotions when format-derived. Conflicting contracts, unsupported formats and unavailable argument storage remain explicit.',
            );
          if (valid) {
            const signatures =
              input.types?.signatures.filter(
                (signature) =>
                  signature.subject_id === node.id &&
                  (signature.status === 'established' || signature.status === 'asserted'),
              ) ?? [];
            projection = {
              kind: 'source',
              signature: signatures.length === 1 ? signatures[0]! : null,
              arguments: args,
              results: returned,
              inputs: [],
              outputs: node.register_outputs,
            };
          }
        }
      }
      const callee = inferred.get(node.id);
      if (!projection && callee && node.arguments.length === 0 && node.results.length === 0) {
        const { arguments: args, missing } = observedArguments(
          callee,
          node.register_inputs,
          node.id,
          block.id,
        );
        const returned = callee.returns
          .map((register, index) =>
            result(
              `${node.id}:result:${index}`,
              node.register_outputs,
              locations(register),
              callee.return_types?.[index] ?? integer(register.width_bits),
              block.id,
            ),
          )
          .filter((value): value is Value => value !== null);
        // Source view: a complete-callee-reads basis closes the observed list;
        // planSourceStack validates it before classifying caller-private storage.
        const closed =
          view === 'source' &&
          !missing &&
          callee.parameter_state !== 'ambiguous' &&
          callee.argument_list_closure !== undefined &&
          !callee.variadic_stack;
        projection = {
          kind: callee.parameter_state === 'ambiguous' || missing ? 'physical' : 'inferred',
          signature: null,
          arguments: args,
          ...(closed
            ? { argument_list_complete: true }
            : callee.argument_list_complete === false || missing
              ? { argument_list_complete: false }
              : {}),
          results: returned,
          inputs: [],
          outputs: node.register_outputs,
        };
      }
      projection ??= {
        kind: 'physical',
        signature: null,
        arguments: node.arguments,
        results: node.results,
        inputs: [],
        outputs: node.register_outputs,
      };
      calls.set(node.id, projection);
      callResults.set(node.id, projection.results);
    }
  for (const block of blocks.values()) {
    const control = block.control,
      callee = inferred.get(control.id);
    if (control.kind !== 'indirect' || !control.tail_call || !callee?.target) continue;
    const args = observedArguments(callee, block.register_exit, control.id, block.id);
    tails.set(control.id, {
      target: callee.target,
      result_types:
        callee.return_types ?? callee.returns.map((register) => integer(register.width_bits)),
      boundary: {
        kind: callee.parameter_state === 'ambiguous' || args.missing ? 'physical' : 'inferred',
        signature: null,
        arguments: args.arguments,
        // A closed callee reads no stack, so no forwarded or newly written
        // stack bytes can be further arguments of this tail transfer.
        argument_list_complete:
          view === 'source' &&
          !args.missing &&
          callee.parameter_state !== 'ambiguous' &&
          callee.argument_list_closure !== undefined &&
          !callee.variadic_stack,
        results: [],
        inputs: [],
        outputs: [],
      },
    });
  }
  const storageCopies: StorageCopy[] = [];
  const storageSources = new Map<string, Value[]>();
  for (const block of blocks.values()) {
    const control = block.control;
    const transfers =
      control.kind === 'jump'
        ? [control.transfer]
        : control.kind === 'if'
          ? [control.when_true.transfer, control.when_false.transfer]
          : control.kind === 'switch'
            ? [...control.cases.map((item) => item.arm.transfer), control.otherwise.transfer]
            : [];
    for (const transfer of transfers)
      for (const copy of transfer.copies) {
        storageCopies.push(copy);
        const sources = storageSources.get(copy.destination.id) ?? [];
        sources.push(copy.source);
        storageSources.set(copy.destination.id, sources);
      }
  }
  const typedSlices = registerTypeSlices(
    values,
    expressions,
    storageCopies,
    callResults.values(),
    context,
  );
  // Candidate registers come from the target ABI classifier, never spelling or
  // the host platform. Only candidates demanded after source DCE become formals.
  const word: AbiType = { kind: 'integer', bits: abi.layout.pointer_bits, signed: false };
  const layout = abi.classifyCall({
    returns: word,
    parameters: Array.from({ length: 16 }, () => word),
    variadic: false,
    fixed_parameter_count: 16,
  });
  const candidates: RegisterDescriptor[] = [];
  for (const parameter of layout.parameters)
    for (const location of parameter.locations)
      if (
        location.kind === 'register' &&
        !candidates.some((register) => register.root === location.register.root)
      )
        candidates.push(location.register);
  const floatLayout = abi.classifyCall({
    returns: { kind: 'float', bits: 64 },
    parameters: Array.from({ length: 16 }, () => ({ kind: 'float' as const, bits: 64 as const })),
    variadic: false,
    fixed_parameter_count: 16,
  });
  for (const parameter of floatLayout.parameters)
    for (const location of parameter.locations)
      if (
        location.kind === 'register' &&
        !candidates.some((register) => register.root === location.register.root)
      )
        candidates.push({ ...location.register, width_bits: location.width_bits });
  // A hidden-result pointer register outside the argument registers (AAPCS64
  // x8) that is read at entry and addresses stores is the incoming indirect
  // result location: a formal, not an unknown entry value. Such a function
  // returns its aggregate through memory and no result register.
  const hidden = abi.classifyCall({
    returns: {
      kind: 'aggregate',
      size: 32n,
      alignment: 8,
      fields: [0n, 8n, 16n, 24n].map((offset) => ({ offset, type: word })),
    },
    parameters: [],
    variadic: false,
    fixed_parameter_count: 0,
  }).hidden_result;
  let indirectResult = false;
  if (
    view === 'source' &&
    hidden?.kind === 'indirect' &&
    'root' in hidden.pointer &&
    !candidates.some(
      (register) => 'root' in hidden.pointer && register.root === hidden.pointer.root,
    )
  ) {
    const pointer = hidden.pointer;
    const cells = new Set(
      entry.register_entry
        .filter((binding) => binding.register.root === pointer.root)
        .map((binding) => binding.value.id),
    );
    const derived = (value: Value, depth: number): boolean => {
      if (cells.has(value.id)) return true;
      const expression = depth < 8 ? expressions.get(value.id) : undefined;
      return (
        expression !== undefined &&
        expressionOperands(expression).some((operand) => derived(operand, depth + 1))
      );
    };
    const stores: string[] = [];
    for (const block of blocks.values())
      for (const node of block.statements) {
        context.checkpoint(1);
        if (node.kind === 'store' && derived(node.address, 0)) stores.push(node.id);
      }
    if (
      stores.length &&
      validation.presentation(
        'indirect_result',
        input.function.id,
        `${pointer.root} is the target ABI's hidden-result pointer register, outside its argument registers; it is read at entry and addresses stores, so it is presented as the incoming indirect result location formal, and the function as void-like: such a function returns through that memory and no result register`,
        stores.slice(0, 64),
      )
    ) {
      validation.requireAbi(
        'indirect_result',
        [input.function.id],
        `Presenting ${pointer.root} as a formal and every exit register slice as scratch assumes ABI conformance: a register read before any write is an input only in its ABI role, here the caller-provided indirect result location, and callers of such a function read the result from that memory, not from registers. Exact exit slices remain in the exit metadata and checked view.`,
      );
      candidates.push(pointer);
      indirectResult = true;
    }
  }
  for (const register of candidates) {
    const cells = entry.register_entry.filter(
      (binding) =>
        binding.register.root === register.root &&
        binding.register.offset_bits >= register.offset_bits &&
        binding.register.offset_bits < register.offset_bits + register.width_bits,
    );
    if (!cells.length) continue;
    const typed =
      register.bank === 'float' || register.bank === 'vector'
        ? registerTypes(
            entry.register_entry,
            register.root,
            register.offset_bits,
            typedSlices,
            context,
          )[0]
        : undefined;
    const width = typed
      ? bitWidth(typed)
      : Math.max(...cells.map((cell) => cell.register.offset_bits + cell.register.width_bits)) -
        register.offset_bits;
    const descriptor = {
      ...register,
      width_bits: width,
      ...(typed?.kind === 'vector' ? { bank: 'vector' as const } : {}),
    };
    const value = result(
      `parameter:${register.root}`,
      entry.register_entry,
      locations(descriptor),
      typed ?? (cells.length === 1 ? cells[0]!.value.type : integer(width)),
      entry.id,
    );
    if (value) {
      parameters.push(value);
      parameterRegisters.set(value.id, descriptor);
    }
  }
  const physicalEntry = new Set(entry.register_entry.map((binding) => binding.value.id));
  parameters.push(...entry.parameters.filter((value) => !physicalEntry.has(value.id)));
  const declaredFunction = signatureFor(input.function.id);
  const declaredLayout = declaredFunction ? abi.classifyCall(declaredFunction.declaration) : null;
  let functionSignature: { signature: SignatureAssociation; declaration: AbiSignature } | null =
    null;
  if (
    declaredFunction &&
    declaredLayout?.state === 'complete' &&
    !declaredLayout.hidden_result &&
    !declaredFunction.declaration.variadic
  ) {
    const parameterTypes = declaredFunction.declaration.parameters!.map(machineType);
    const resultType = machineType(declaredFunction.declaration.returns);
    const valid =
      parameterTypes.every(
        (type, index) =>
          type &&
          bind(
            `function:check:${index}`,
            entry.register_entry,
            declaredLayout.parameters[index]!.locations,
            type,
            entry.id,
          ),
      ) &&
      (declaredFunction.declaration.returns.kind === 'void' ||
        (resultType &&
          [...blocks.values()]
            .filter((block) => block.control.kind === 'return')
            .every((block) =>
              bind(
                `function:check:return:${block.id}`,
                block.register_exit,
                declaredLayout.returns,
                resultType,
                block.id,
              ),
            )));
    if (valid) {
      parameters.length = 0;
      for (const parameter of declaredLayout.parameters) {
        const value = result(
          `function:parameter:${parameter.index}`,
          entry.register_entry,
          parameter.locations,
          parameterTypes[parameter.index]!,
          entry.id,
        )!;
        parameters.push(value);
        parameterNames.set(
          value.id,
          declaredFunction.signature.signature.parameters[parameter.index]!.name ??
            `arg${parameter.index + 1}`,
        );
      }
      functionSignature = declaredFunction;
    }
  }
  for (const binding of entry.register_entry) {
    if (binding.register.root !== abi.stack_pointer.root && !expressions.has(binding.value.id))
      alias(binding.value, {
        kind: 'indeterminate',
        state: 'unknown',
        reason:
          binding.register.root === 'arm64:fpcr'
            ? 'FPCR environment'
            : binding.register.root === 'x86_64:mxcsr'
              ? 'MXCSR environment'
              : 'non-argument entry register',
      });
  }
  const integerReturn = layout.returns[0],
    floatingReturn = floatLayout.returns[0];
  let primaryResult: SourcePrimaryResult | null =
    indirectResult && !functionSignature
      ? {
          kind: 'none',
          written: true,
          reason: 'returns through the incoming indirect result location',
          void_like: 'indirect_result',
        }
      : view === 'source' &&
          !functionSignature &&
          integerReturn?.kind === 'register' &&
          floatingReturn?.kind === 'register' &&
          [...blocks.values()].every(
            (block) => block.control.kind !== 'return' || block.control.values.length === 0,
          )
        ? selectSourcePrimaryResult({
            blocks,
            entry,
            expressions,
            sources: storageSources,
            typed: typedSlices,
            parameters: parameterRegisters,
            callResults,
            stack: input.types?.calls?.stack,
            integer: integerReturn,
            floating: floatingReturn,
            argumentRoots: new Set(candidates.map((register) => register.root)),
            demands: evidence.function_return_demands ?? [],
            observed: evidence.function_returns?.registers ?? [],
            context,
          })
        : null;
  const exitIds = [...blocks.values()].flatMap((block) =>
    block.control.kind === 'return' ? [block.control.id] : [],
  );
  const primaryScope =
    'primary result register defined on every exit path: unknown entry values, unprojected call clobbers and returning-frame addresses disqualify; FP needs typed IEEE writes (literal bits or a typed argument may join); when both qualify: caller demand, then the register written last on every exit path, then a native written-result interface naming exactly one';
  if (
    primaryResult?.kind === 'float' ||
    (primaryResult?.kind === 'integer' && primaryResult.reason)
  ) {
    const floating = primaryResult.kind === 'float';
    if (
      validation.presentation(
        'primary_result',
        input.function.id,
        primaryScope,
        exitIds,
        primaryResult.kind === 'float'
          ? `${primaryResult.location.register.root} ${primaryResult.type.kind}${bitWidth(primaryResult.type)} selected; ${primaryResult.rejected}`
          : `integer result register selected; ${primaryResult.reason}`,
      )
    )
      validation.requireAbi(
        'primary_result',
        exitIds,
        `Present the ABI ${floating ? 'floating-point' : 'integer'} return register as the single result; callers read no ${floating ? 'integer' : 'floating-point'} result register. The rejected register keeps its exact exit value in the exit metadata and checked view.`,
      );
    else primaryResult = { kind: 'explicit', written: true, reason: 'presentation record bound' };
  } else if (primaryResult?.kind === 'none' && primaryResult.void_like === 'incidental_result') {
    if (
      validation.presentation(
        'incidental_result',
        input.function.id,
        'void-like source interface: the integer result register qualifies on every exit, but no caller demands it, the FP result register is unchanged or undefined on every exit, no tail transfer exists, and no exit path establishes it deliberately (moved back after a call/unknown-effect clobber on some path, another argument copied in, a projected call result that is the final action, or a constant/load/computation consumed by nothing but function exits and stores); call results left in place before later effects, untouched arguments and values that also address memory or feed calls or branches stay in exit metadata',
        exitIds,
        primaryResult.reason,
      )
    )
      validation.requireAbi(
        'incidental_result',
        exitIds,
        'Presenting a void-like interface assumes callers read no result register; no caller was scanned and no result-use evidence exists. The integer result register keeps its exact exit value in the exit metadata and checked view.',
      );
    else primaryResult = { kind: 'integer' };
  } else if (
    (primaryResult?.kind === 'explicit' || primaryResult?.kind === 'none') &&
    primaryResult.written &&
    !primaryResult.void_like
  )
    validation.presentation(
      'primary_result',
      input.function.id,
      primaryScope,
      exitIds,
      primaryResult.reason,
    );
  // Native written-result storage is not result evidence once this rule
  // rejects it: it records which registers were written, not which one is read.
  const floatingRoot =
    floatingReturn?.kind === 'register' ? floatingReturn.register.root : undefined;
  const voidLike = primaryResult?.kind === 'none' ? primaryResult.void_like : undefined;
  const observedRejected =
    primaryResult?.kind === 'explicit' ||
    voidLike !== undefined ||
    (evidence.function_returns?.registers ?? []).some((register) =>
      primaryResult?.kind === 'float'
        ? register.root !== floatingRoot
        : primaryResult?.kind === 'integer' &&
          primaryResult.reason !== undefined &&
          register.root === floatingRoot,
    );
  let returnType: DataType | null = null;
  const possibleReturnStorage = possibleAbiReturnStorage(abi);
  for (const block of blocks.values())
    if (block.control.kind === 'return') {
      const control = block.control;
      let returned = [...control.values];
      if (functionSignature) {
        const type = machineType(functionSignature.declaration.returns);
        returned = type
          ? [
              bind(
                `${control.id}:declared-result`,
                block.register_exit,
                declaredLayout!.returns,
                type,
                block.id,
              )!,
            ]
          : [];
      }
      if (
        !functionSignature &&
        !returned.length &&
        !observedRejected &&
        evidence.function_returns?.registers.length
      ) {
        const observed = evidence.function_returns;
        const results = observed.registers.map((register, index) =>
          bind(
            `${control.id}:observed-result:${index}`,
            block.register_exit,
            locations(register),
            observed.types[index] ?? integer(register.width_bits),
            block.id,
          ),
        );
        if (results.every((value) => value !== null)) returned = results as Value[];
      }
      if (!functionSignature && !returned.length && primaryResult?.kind === 'float') {
        const value = bind(
          `${control.id}:fp-result`,
          block.register_exit,
          [primaryResult.location],
          primaryResult.type,
          block.id,
        );
        if (value) returned = [value];
      } else if (!functionSignature && !returned.length && !primaryResult) {
        const floating = floatLayout.returns.flatMap((location) => {
          if (location.kind !== 'register') return [];
          const type = registerTypes(
            block.register_exit,
            location.register.root,
            location.register.offset_bits,
            typedSlices,
            context,
            true,
          ).find((candidate) =>
            [...blocks.values()]
              .filter((exit) => exit.control.kind === 'return')
              .every((exit) =>
                registerTypes(
                  exit.register_exit,
                  location.register.root,
                  location.register.offset_bits,
                  typedSlices,
                  context,
                  true,
                ).some((other) => sameType(candidate, other)),
              ),
          );
          if (!type) return [];
          const value = bind(
            `${control.id}:fp-result`,
            block.register_exit,
            [{ ...location, width_bits: bitWidth(type) }],
            type,
            block.id,
          );
          return value ? [value] : [];
        });
        if (floating.length === 1) returned = floating;
      }
      if (
        !functionSignature &&
        !returned.length &&
        layout.returns.length &&
        (!primaryResult || primaryResult.kind === 'integer')
      ) {
        const location = layout.returns[0]!;
        if (location.kind === 'register') {
          const cells = block.register_exit.filter(
            (binding) => binding.register.root === location.register.root,
          );
          const changed = cells.some(
            (binding) =>
              !unchangedStorage(
                binding.value,
                entry.register_entry.find((initial) => initial.register.id === binding.register.id)
                  ?.value.id,
                expressions,
                storageSources,
                context,
              ),
          );
          if (changed) {
            // An observed narrow ABI result is not padded with unrelated high bits.
            const low = cells.find(
              (binding) => binding.register.offset_bits === location.register.offset_bits,
            );
            const wide = cells.some((binding) => {
              if (
                binding.register.offset_bits <= location.register.offset_bits ||
                entry.register_entry.some((initial) => initial.value.id === binding.value.id)
              )
                return false;
              const expression = expressions.get(binding.value.id);
              return (
                expression !== undefined &&
                expression.kind !== 'indeterminate' &&
                !(expression.kind === 'constant' && expression.bits === 0n)
              );
            });
            const type = wide
              ? integer(location.width_bits)
              : (low?.value.type ?? integer(location.width_bits));
            const value = bind(
              `${control.id}:result`,
              cells,
              [{ ...location, width_bits: bitWidth(type) }],
              type,
              block.id,
            );
            if (value) returned = [value];
          }
        }
      }
      if (returned.length === 1) returnType = returned[0]!.type;
      // Without a supplied prototype, an unclassified changed ABI return cell
      // is still observable machine storage. Preserve it as an uncertain entry
      // overlay, not as another inferred source/aggregate result.
      const knownReturnStorage = observedRejected
        ? []
        : [...(evidence.function_returns?.registers ?? [])];
      for (const value of returned) {
        const primary =
          value.type.kind === 'float' || value.type.kind === 'vector' ? floatLayout : layout;
        for (const location of primary.returns)
          if (location.kind === 'register')
            knownReturnStorage.push({
              ...location.register,
              width_bits: bitWidth(value.type),
            });
      }
      const uncertainOutputs: RegisterBinding[] = [];
      if (!functionSignature)
        for (const binding of block.register_exit) {
          context.checkpoint(1);
          const capability = possibleReturnStorage.find(
            (register) => register.root === binding.register.root,
          );
          if (
            !capability ||
            unchangedStorage(
              binding.value,
              entry.register_entry.find((initial) => initial.register.id === binding.register.id)
                ?.value.id,
              expressions,
              storageSources,
              context,
            )
          )
            continue;
          let uncovered = [
            {
              low: Math.max(binding.register.offset_bits, capability.offset_bits),
              high: Math.min(
                binding.register.offset_bits + binding.register.width_bits,
                capability.offset_bits + capability.width_bits,
              ),
            },
          ];
          for (const known of knownReturnStorage) {
            if (known.root !== binding.register.root) continue;
            const low = known.offset_bits,
              high = low + known.width_bits;
            uncovered = uncovered.flatMap((range) => [
              ...(range.low < low ? [{ low: range.low, high: Math.min(range.high, low) }] : []),
              ...(range.high > high ? [{ low: Math.max(range.low, high), high: range.high }] : []),
            ]);
          }
          for (const { low, high } of uncovered) {
            if (low >= high) continue;
            const width = high - low;
            const value =
              low === binding.register.offset_bits && width === binding.register.width_bits
                ? binding.value
                : make(
                    `${control.id}:uncertain-return:${binding.value.id}:${low}:${width}`,
                    integer(width),
                    block.id,
                    {
                      kind: 'extract',
                      value: binding.value,
                      offset: low - binding.register.offset_bits,
                    },
                  );
            uncertainOutputs.push({
              value,
              register: { ...binding.register, offset_bits: low, width_bits: width },
            });
          }
        }
      returns.set(control.id, {
        kind: functionSignature ? 'source' : 'inferred',
        signature: functionSignature?.signature ?? null,
        arguments: [],
        results: returned,
        inputs: [],
        outputs: uncertainOutputs,
      });
    }
  if (
    !functionSignature &&
    returns.size &&
    [...returns.values()].every(
      (boundary) => boundary.results.length === 1 && boundary.results[0]!.type.kind === 'integer',
    )
  ) {
    const width = Math.max(
      ...[...returns.values()].map((boundary) => bitWidth(boundary.results[0]!.type)),
    );
    returnType = integer(width);
    for (const [id, boundary] of returns) {
      const value = boundary.results[0]!;
      if (bitWidth(value.type) !== width)
        returns.set(id, {
          ...boundary,
          results: [
            make(`${id}:return-width`, returnType, owner.get(value.id)!, {
              kind: 'cast',
              op: 'zero_extend',
              value,
            }),
          ],
        });
    }
  }
  if (!functionSignature && tails.size) {
    const types = [...tails.values()].map((tail) =>
      tail.result_types.length === 1 ? tail.result_types[0]! : null,
    );
    const first = types[0];
    if (
      first &&
      types.every((type) => type !== null && sameType(type, first)) &&
      (!returnType || sameType(returnType, first))
    )
      returnType = first;
    else returnType = null;
  }
  const addressValue = sourceDataValues(expressions, evidence.addresses, context);
  const returnedData = [...returns.values()].map((boundary) =>
    boundary.results.length === 1 &&
    boundary.results[0]!.type.kind === 'integer' &&
    bitWidth(boundary.results[0]!.type) === abi.layout.pointer_bits
      ? addressValue(boundary.results[0]!)
      : undefined,
  );
  const returnPointer =
    (!functionSignature || functionSignature.declaration.returns.kind === 'pointer') &&
    returnedData.length &&
    returnedData.every((item) => item?.object !== undefined || item?.string !== undefined)
      ? returnedData.every((item) => item!.string !== undefined)
        ? ('char' as const)
        : ('byte' as const)
      : undefined;
  const resultTypes = [...returns.values()].map((boundary) =>
    boundary.results.map((value) => value.type),
  );
  const tuple = resultTypes[0];
  const returnTypes =
    tuple &&
    tuple.length > 1 &&
    resultTypes.every(
      (types) =>
        types.length === tuple.length &&
        types.every((type, index) => sameType(type, tuple[index]!)),
    )
      ? tuple
      : undefined;
  const presentation: SourcePresentation = {
    inferred: !functionSignature,
    parameter_names: parameterNames,
    return_type: returnType,
    ...(returnTypes ? { return_types: returnTypes } : {}),
    ...(returnPointer === undefined ? {} : { return_pointer: returnPointer }),
    ...(observedRejected ? { observed_result_rejected: true as const } : {}),
    ...(voidLike ? { void_like_result: voidLike } : {}),
    requirements: planSourceRequirements(
      input,
      blocks,
      expressions,
      originalDefinitions,
      calls,
      returns,
      context,
    ),
    locals: new Map(),
    stack: null,
    stack_addresses: new Map(),
    addresses: evidence.addresses,
    call_results: callResults,
    value_origins: valueOrigins,
    definitions,
  };
  const incomingParameters = new Map<bigint, Value>();
  let entryParameter: Value | null = null;
  return {
    calls,
    returns,
    tails,
    parameters,
    parameterRegisters,
    signature: functionSignature?.signature ?? null,
    presentation,
    forcedInline,
    alias,
    make,
    entryStack(): Value {
      if (!entryParameter) {
        entryParameter = make(
          'parameter:entry-sp',
          integer(abi.layout.pointer_bits),
          entry.id,
          undefined,
          entry.register_entry
            .filter((binding) => binding.register.root === abi.stack_pointer.root)
            .map((binding) => binding.value),
        );
        parameterNames.set(entryParameter.id, 'entry_sp');
        parameterRegisters.set(entryParameter.id, abi.stack_pointer);
      }
      return entryParameter;
    },
    incomingStack(offset: bigint, type: DataType, contributors: readonly Value[]): Value | null {
      // Without a declaration, infer only a whole scalar word in an actual ABI
      // parameter slot. Entry return addresses, home space and alignment padding
      // are not source inputs merely because their offsets are nonnegative.
      if (functionSignature || type.kind !== 'integer' || type.bits !== abi.layout.pointer_bits)
        return null;
      const slot = layout.parameters.find(
        (parameter) =>
          parameter.locations.length === 1 &&
          parameter.locations[0]!.kind === 'stack' &&
          parameter.locations[0]!.offset === offset &&
          parameter.locations[0]!.size * 8n === BigInt(type.bits),
      );
      if (!slot) return null;
      let value = incomingParameters.get(offset);
      if (!value) {
        value = make(`parameter:entry-stack:${offset}`, type, entry.id, undefined, contributors);
        incomingParameters.set(offset, value);
      }
      return value;
    },
    materialize(live: ReadonlySet<string>, inline: Set<string>): void {
      for (const [id, anchor] of anchors) {
        context.checkpoint(1);
        const expression = expressions.get(id)!;
        if (!live.has(id) || expression.kind !== 'integer') continue;
        inline.delete(id);
        const definition: Assignment = {
          kind: 'assign',
          id: `entity_${fingerprint(['source-definition', id])}`,
          result: values.get(id)!,
          expression,
          provenance: anchor.provenance,
        };
        valueOrigins.set(definition.id, [anchor.id]);
        const list = definitions.get(anchor.id) ?? [];
        list.push(definition);
        definitions.set(anchor.id, list);
      }
    },
    demoteOverlayInputs(live: ReadonlySet<string>, demanded: ReadonlySet<string>): void {
      for (const value of parameters) {
        context.checkpoint(1);
        if (!live.has(value.id) || demanded.has(value.id) || !parameterRegisters.has(value.id))
          continue;
        alias(value, {
          kind: 'indeterminate',
          state: 'unknown',
          reason: 'non-argument entry register',
        });
        parameterRegisters.delete(value.id);
        demotedParameters.add(value.id);
      }
    },
    finalize(live: ReadonlySet<string>): readonly Value[] {
      const incoming = [...incomingParameters]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([, value]) => value);
      const demanded = functionSignature
        ? parameters
        : [...parameters, ...incoming].filter(
            (value) => live.has(value.id) && !demotedParameters.has(value.id),
          );
      demanded.forEach((value, index) => {
        if (!parameterNames.has(value.id)) parameterNames.set(value.id, `arg${index}`);
      });
      return entryParameter && live.has(entryParameter.id)
        ? [...demanded, entryParameter]
        : demanded;
    },
  };
}

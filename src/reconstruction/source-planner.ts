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
  type Instruction,
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
import { createStackArgumentJoins, sourceStackArgumentParts } from './source-stack-arguments.js';
import { planSourceRequirements } from './source-requirements.js';
import { possibleAbiReturnStorage } from '../analysis/calls/return-storage.js';
import { LocalValidationSession } from './local-validation.js';
import { selectSourcePrimaryResult, type SourcePrimaryResult } from './source-results.js';
import { createVariadicCallBinder } from './source-variadic.js';

/** Source ABI abstraction: architectural snapshots are retained in the input,
 * not treated as extra source arguments or memory-fault observables.
 * `extended` (source view, S9): a declared signature may also carry stack,
 * variadic or hidden-result parameters; the stack plan must confirm them
 * (`declaredExtension`), otherwise the caller plans again without it. */
export function planSource(
  input: EmissionInput,
  blocks: ReadonlyMap<string, BlockRegion>,
  values: Map<string, Value>,
  expressions: Map<string, Expression>,
  owner: Map<string, string>,
  context: OperationContext,
  view: PresentationView = 'checked',
  validation = new LocalValidationSession(context),
  extended = false,
) {
  const evidence = input.source!,
    abi = evidence.abi,
    entry = blocks.get(input.function.entry)!;
  const forcedInline = new Set<string>(),
    calls = new Map<string, BoundaryProjection>(),
    returns = new Map<string, BoundaryProjection>();
  const tails = new Map<string, TailProjection>();
  /** Tails whose observed callee writes no FP result register (caller consensus). */
  const floatingInertTails = new Set<string>();
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
    // Source view: bit slices of an IEEE result are taken from its whole-bit
    // integer view; extracting a lane from a float value has no C spelling.
    let bits: Value | undefined;
    const sliced = (): Value =>
      view === 'source' && type.kind === 'float'
        ? (bits ??= make(`${key}:bits`, integer(bitWidth(type)), block, {
            kind: 'cast',
            op: 'bitcast',
            value: whole,
          }))
        : whole;
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
              : { kind: 'extract', value: sliced(), offset },
          );
        } else {
          const base = make(`${key}:unmodeled:${binding.value.id}`, binding.value.type, block, {
            kind: 'indeterminate',
            state: 'unknown',
            reason: 'bits outside source ABI result',
          });
          valueOrigins.set(base.id, [binding.value.id]);
          // The inserted part is integer bits (the whole IEEE result's integer
          // view in the source view), so the insert prints as a mask-and-or.
          const part =
            offset === 0 && high - low === bitWidth(type)
              ? sliced()
              : make(`${key}:result-part:${binding.value.id}`, integer(high - low), block, {
                  kind: 'extract',
                  value: sliced(),
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
  const stackJoins = createStackArgumentJoins(blocks, input.function.entry);
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
      stackJoins,
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
  // Source view (S8): a callee with a published `va_start` footprint binds its
  // named prefix exactly and the anonymous arguments this body provably sets up
  // under the ABI's variadic convention (`createVariadicCallBinder`).
  const variadicBinder =
    view === 'source' && evidence.callees.some((callee) => callee.variadic)
      ? createVariadicCallBinder(abi, blocks, expressions, input.function.entry, context)
      : null;
  const variadicArguments = (
    callee: InferredCallee,
    bindings: readonly RegisterBinding[],
    boundary: string,
    block: string,
  ): { readonly arguments: readonly Value[]; readonly missing: false } | null => {
    if (!variadicBinder || !callee.variadic) return null;
    const bound = variadicBinder(
      callee,
      bindings,
      (key, register, type) =>
        bind(`${boundary}:variadic:${key}`, bindings, locations(register), type, block),
      (key, offset, type) =>
        bindStack(`${boundary}:variadic:${key}`, boundary, offset, type, block),
    );
    if (
      !bound ||
      !validation.presentation(
        'variadic_call_arguments',
        boundary,
        `call to a callee with a published va_start footprint: its ${callee.variadic.named.length} named register and ${callee.variadic.named_stack_bytes} named stack bytes bind exactly; the ${bound.anonymous} anonymous argument(s) are the locations after them that this body provably sets up for this transfer under the ${abi.id} variadic convention, in ABI order; the list stays open`,
        [boundary],
      )
    )
      return null;
    validation.requireAbi(
      'variadic_call_convention',
      [boundary],
      abi.id === 'sysv-amd64'
        ? 'Presenting the arguments of a variadic callee assumes the SysV AMD64 variadic convention: the callee reads exactly its named argument registers as named, its anonymous integer arguments from the integer argument registers after them, and at most al vector registers (each anonymous one a double, by default argument promotion); integer and vector classes are assigned independently, so the printed order across classes is one valid order. Only argument registers this body writes, or the al-counted vector registers, print; a forwarded entry value may still be an argument (open list).'
        : abi.id === 'windows-x64'
          ? 'Presenting the arguments of a variadic callee assumes the Win64 variadic convention: positions after the named ones are anonymous, an anonymous floating-point argument is passed in both its FP and its integer register (printed as the double when both hold the same bits). Only positions whose integer register this body writes print; a forwarded entry value may still be an argument (open list).'
          : 'Presenting the arguments of a variadic callee assumes the Darwin arm64 variadic convention: the named registers bind as named, and every anonymous argument is in consecutive 8-byte outgoing stack slots after the named stack bytes.',
    );
    return { arguments: bound.arguments, missing: false };
  };
  const inferred = new Map(evidence.callees.map((callee) => [callee.call_id, callee]));
  if (view === 'source')
    for (const callee of evidence.source_callees ?? []) inferred.set(callee.call_id, callee);
  const facts = new Map(input.types?.calls?.calls.map((fact) => [fact.node_id, fact]) ?? []);
  const conflicts = new Set(input.types?.conflicts.map((conflict) => conflict.subject_id) ?? []);
  /** `aggregates` (S9, the function's own declaration): a structure of known
   * size and alignment resolves to its ABI aggregate (sret results, by-value
   * parameters); call declarations keep scalar types only. */
  const signatureFor = (subject: string, aggregates = false) => {
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
    const resolve = (id: string, depth = 0): AbiType | null => {
      if (conflicts.has(id)) return null;
      const type = input.types!.types.find((type) => type.id === id)?.definition;
      if (type?.kind === 'void' || type?.kind === 'integer' || type?.kind === 'float') return type;
      if (type?.kind === 'pointer') return { kind: 'pointer' };
      if (type?.kind === 'vector') {
        const element = resolve(type.element, depth + 1);
        if (element?.kind === 'integer' || element?.kind === 'float')
          return {
            kind: 'vector',
            element: element.kind,
            element_bits: element.bits,
            lanes: type.lanes,
          };
      }
      if (
        aggregates &&
        type?.kind === 'structure' &&
        type.size !== null &&
        type.alignment !== null &&
        depth < 8
      ) {
        const fields: { offset: bigint; type: AbiType }[] = [];
        for (const field of type.fields) {
          const resolved = resolve(field.type_id, depth + 1);
          const size = !resolved
            ? null
            : resolved.kind === 'integer' || resolved.kind === 'float'
              ? resolved.bits % 8 === 0 && resolved.bits !== 80
                ? BigInt(resolved.bits / 8)
                : null
              : resolved.kind === 'pointer'
                ? BigInt(abi.layout.pointer_bits / 8)
                : resolved.kind === 'vector'
                  ? BigInt((resolved.element_bits * resolved.lanes) / 8)
                  : resolved.kind === 'aggregate'
                    ? resolved.size
                    : null;
          if (!resolved || size === null || field.offset + size > type.size) return null;
          fields.push({ offset: field.offset, type: resolved });
        }
        return { kind: 'aggregate', size: type.size, alignment: type.alignment, fields };
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
                ? 'library_variadic_rule: established variadic library contract and its rule over every possible rule-argument value (an exact immutable terminated printf-family format literal, or Darwin open flags all setting O_CREAT) determine every promoted actual type; each ABI location is bound to original caller storage'
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
              'Library closure assumes the established contract and ABI-conforming arguments, including variadic default promotions when rule-derived. Conflicting contracts, unsupported formats, undecided open flags and unavailable argument storage remain explicit.',
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
      // An established variadic library contract that no rule closed: the fixed
      // parameters are exactly the ABI classification of the established
      // signature, so they bind at their register locations; the anonymous
      // tail is never claimed and the list stays open. The declared result is
      // left unbound: nothing here reads it, and binding it would make a void
      // caller's exit register an established integer result.
      const fixedContract =
        view === 'source' &&
        !projection &&
        fact?.status === 'established' &&
        (contracts.length === 1 || repeatedContract)
          ? contracts[0]!.contract.signature
          : undefined;
      if (fixedContract?.variadic && node.results.length === 0) {
        const layout = abi.classifyCall({ ...fixedContract, argument_list_complete: false });
        if (
          layout.state !== 'unsupported' &&
          !layout.hidden_result &&
          fixedContract.parameters &&
          fixedContract.fixed_parameter_count === fixedContract.parameters.length &&
          layout.parameters.length === fixedContract.parameters.length
        ) {
          const args: Value[] = [];
          let valid = true;
          for (const parameter of layout.parameters) {
            const type = machineType(fixedContract.parameters[parameter.index]!);
            const value =
              type &&
              bind(
                `${node.id}:arg:${parameter.index}`,
                node.register_inputs,
                parameter.locations,
                type,
                block.id,
              );
            if (!value) {
              valid = false;
              break;
            }
            args.push(value);
          }
          if (node.arguments.some((value) => !args.some((argument) => argument.id === value.id)))
            valid = false;
          if (
            valid &&
            validation.presentation(
              'library_fixed_prefix',
              node.id,
              `library_variadic_prefix: the established, non-conflicting variadic library contract fixes its ${args.length} leading parameter(s) at their ${abi.id} register locations, each bound to the caller's value there; the anonymous arguments are not claimed and the argument list stays open`,
              [node.id],
            )
          ) {
            validation.requireAbi(
              'library_fixed_prefix',
              [node.id],
              'Printing the fixed prefix of a variadic library call assumes the established contract and the ABI classification of its fixed parameters; the anonymous arguments stay unresolved.',
            );
            projection = {
              kind: 'inferred',
              signature: null,
              arguments: args,
              argument_list_complete: false,
              results: [],
              inputs: [],
              outputs: node.register_outputs,
            };
          }
        }
      }
      const callee = inferred.get(node.id);
      if (!projection && callee && node.arguments.length === 0 && node.results.length === 0) {
        const variadic = variadicArguments(callee, node.register_inputs, node.id, block.id);
        const { arguments: args, missing } =
          variadic ?? observedArguments(callee, node.register_inputs, node.id, block.id);
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
          !variadic &&
          !missing &&
          callee.parameter_state !== 'ambiguous' &&
          callee.argument_list_closure !== undefined &&
          !callee.variadic_stack;
        const guess =
          view === 'source' && !closed && !missing && !variadic
            ? evidence.likely_arity?.get(node.id)
            : undefined;
        projection = {
          kind:
            !variadic && (callee.parameter_state === 'ambiguous' || missing)
              ? 'physical'
              : 'inferred',
          signature: null,
          arguments: args,
          ...(closed
            ? { argument_list_complete: true }
            : variadic || callee.argument_list_complete === false || missing
              ? { argument_list_complete: false }
              : {}),
          ...(guess ? { likely: { ...guess, arity: args.length } } : {}),
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
    const variadic = variadicArguments(callee, block.register_exit, control.id, block.id);
    const args = variadic ?? observedArguments(callee, block.register_exit, control.id, block.id);
    const guess =
      view === 'source' && !args.missing && !variadic && callee.argument_list_closure === undefined
        ? evidence.likely_arity?.get(control.id)
        : undefined;
    // An observed callee interface whose result storage holds no FP register leaves
    // the FP carrier unchanged or clobbered: it forwards no FP result.
    if (
      callee.parameter_state === 'observed' &&
      callee.returns.every((register) => register.bank === 'integer') &&
      (callee.return_types ?? []).every((type) => type.kind === 'integer')
    )
      floatingInertTails.add(control.id);
    tails.set(control.id, {
      target: callee.target,
      result_types:
        callee.return_types ?? callee.returns.map((register) => integer(register.width_bits)),
      // Proven void (a library or method contract), or void-like under the
      // transitive `incidental_result` premise (`result_incidental`).
      ...(view === 'source' &&
      ((callee.returns_void && !callee.returns.length) || callee.result_incidental) &&
      callee.parameter_state !== 'ambiguous'
        ? { result_void: true as const }
        : {}),
      boundary: {
        kind:
          !variadic && (callee.parameter_state === 'ambiguous' || args.missing)
            ? 'physical'
            : 'inferred',
        signature: null,
        arguments: args.arguments,
        // A closed callee reads no stack, so no forwarded or newly written
        // stack bytes can be further arguments of this tail transfer.
        argument_list_complete:
          view === 'source' &&
          !variadic &&
          !args.missing &&
          callee.parameter_state !== 'ambiguous' &&
          callee.argument_list_closure !== undefined &&
          !callee.variadic_stack,
        ...(guess ? { likely: { ...guess, arity: args.arguments.length } } : {}),
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
    // Every supported C ABI passes a scalar of an FP/SIMD argument register as
    // float/double, never as an integer type: an integer source formal would be
    // classified into an integer register (or another stack slot). Without a
    // typed use, a scalar-width FP-bank formal is still the IEEE value of its
    // lane; integer uses read its bits through the entry cell's bitcast.
    const lane = width === 32 ? 32 : width === 64 ? 64 : undefined;
    const scalar: DataType | undefined =
      !typed &&
      view === 'source' &&
      (register.bank === 'float' || register.bank === 'vector') &&
      lane
        ? { kind: 'float' as const, bits: lane }
        : undefined;
    const descriptor = {
      ...register,
      width_bits: width,
      ...(typed?.kind === 'vector' ? { bank: 'vector' as const } : {}),
    };
    const value = result(
      `parameter:${register.root}`,
      entry.register_entry,
      locations(descriptor),
      typed ?? scalar ?? (cells.length === 1 ? cells[0]!.value.type : integer(width)),
      entry.id,
    );
    if (value) {
      parameters.push(value);
      parameterRegisters.set(value.id, descriptor);
    }
  }
  const physicalEntry = new Set(entry.register_entry.map((binding) => binding.value.id));
  parameters.push(...entry.parameters.filter((value) => !physicalEntry.has(value.id)));
  const plainDeclaration = signatureFor(input.function.id);
  // Source view (S9): the function's own declaration may also place parameters
  // on the stack, return through a hidden result pointer or end with `...`.
  // Its named layout is that of a call passing no anonymous argument.
  const declaredFunction = extended ? signatureFor(input.function.id, true) : plainDeclaration;
  const declaredLayout = declaredFunction
    ? abi.classifyCall(
        extended && declaredFunction.declaration.variadic
          ? { ...declaredFunction.declaration, argument_list_complete: true }
          : declaredFunction.declaration,
      )
    : null;
  let functionSignature: { signature: SignatureAssociation; declaration: AbiSignature } | null =
    null;
  /** Source view (S9): the declared parts only the stack plan can confirm.
   * `stack`: scalar stack formals by entry-SP offset, bound when S1 binds
   * their slot; `aggregate`: the by-value aggregate kept as incoming memory
   * (S4); `variadic`: entry-SP offset of the first anonymous argument and the
   * register of each named register formal; `hidden`: the sret formal. */
  let declaredExtension: {
    readonly stack: ReadonlyMap<bigint, Value>;
    readonly aggregate: {
      readonly value: Value;
      readonly offset: bigint;
      readonly end: bigint;
    } | null;
    readonly variadic: {
      readonly anonymous: bigint;
      readonly registers: ReadonlyMap<string, Value> | null;
    } | null;
    readonly hidden: Value | null;
  } | null = null;
  const declaredHidden = declaredLayout?.hidden_result;
  const hiddenPointer =
    declaredHidden?.kind === 'indirect' && 'root' in declaredHidden.pointer
      ? { ...declaredHidden.pointer, width_bits: abi.layout.pointer_bits }
      : null;
  if (
    declaredFunction &&
    declaredLayout?.state === 'complete' &&
    (extended
      ? !(declaredHidden && (!hiddenPointer || declaredFunction.declaration.variadic))
      : !declaredHidden && !declaredFunction.declaration.variadic)
  ) {
    const declaration = declaredFunction.declaration;
    const parameterTypes = declaration.parameters!.map(machineType);
    // A hidden result returns its pointer where the ABI says (SysV, Win64) or nothing.
    const resultType = declaredHidden
      ? declaredLayout.returns.length
        ? integer(abi.layout.pointer_bits)
        : null
      : machineType(declaration.returns);
    // Stack-located parameters by index: a scalar of its slot's exact size, or
    // (at most one) by-value aggregate, which only S4's incoming object can bind.
    const stackSlots = new Map<number, { offset: bigint; end: bigint; aggregate: boolean }>();
    const valid =
      (!hiddenPointer ||
        bind(
          'function:check:hidden',
          entry.register_entry,
          locations(hiddenPointer),
          integer(abi.layout.pointer_bits),
          entry.id,
        ) !== null) &&
      parameterTypes.every((type, index) => {
        const [slot, ...rest] = declaredLayout.parameters[index]!.locations;
        if (extended && slot?.kind === 'stack' && !rest.length && slot.value_offset_bits === 0) {
          const aggregate = !type && declaration.parameters![index]!.kind === 'aggregate';
          if (
            aggregate
              ? [...stackSlots.values()].some((other) => other.aggregate)
              : !type || slot.size * 8n !== BigInt(bitWidth(type))
          )
            return false;
          stackSlots.set(index, { offset: slot.offset, end: slot.offset + slot.size, aggregate });
          return true;
        }
        return (
          type &&
          bind(
            `function:check:${index}`,
            entry.register_entry,
            declaredLayout.parameters[index]!.locations,
            type,
            entry.id,
          )
        );
      }) &&
      (declaration.returns.kind === 'void' ||
        (declaredHidden && !resultType) ||
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
    // `...` (S9): the named formals are registers or stack slots of their own.
    const namedRegisters = new Map<string, number>();
    let anonymous = abi.stack_return_address_bytes;
    if (valid && declaration.variadic)
      for (const parameter of declaredLayout.parameters) {
        const [location, ...rest] = parameter.locations;
        if (location?.kind === 'register' && !rest.length)
          namedRegisters.set(location.register.root, parameter.index);
        else if (location?.kind === 'stack' && !rest.length) {
          const end = location.offset + location.size;
          anonymous = end > anonymous ? end : anonymous;
        } else namedRegisters.clear();
      }
    if (
      valid &&
      (!declaration.variadic || namedRegisters.size + stackSlots.size === parameterTypes.length)
    ) {
      parameters.length = 0;
      const hiddenFormal = hiddenPointer
        ? result(
            'function:parameter:hidden',
            entry.register_entry,
            locations(hiddenPointer),
            integer(abi.layout.pointer_bits),
            entry.id,
          )!
        : null;
      if (hiddenFormal) {
        parameters.push(hiddenFormal);
        parameterNames.set(hiddenFormal.id, 'result');
      }
      const stack = new Map<bigint, Value>();
      let aggregate: { value: Value; offset: bigint; end: bigint } | null = null;
      for (const parameter of declaredLayout.parameters) {
        const slot = stackSlots.get(parameter.index);
        const key = `function:parameter:${parameter.index}`;
        // The aggregate's pointer-width carrier is the incoming object's
        // formal; the renderer spells its struct.
        const value = slot
          ? make(
              key,
              slot.aggregate ? integer(abi.layout.pointer_bits) : parameterTypes[parameter.index]!,
              entry.id,
            )
          : result(
              key,
              entry.register_entry,
              parameter.locations,
              parameterTypes[parameter.index]!,
              entry.id,
            )!;
        if (slot?.aggregate) aggregate = { value, offset: slot.offset, end: slot.end };
        else if (slot) stack.set(slot.offset, value);
        parameters.push(value);
        parameterNames.set(
          value.id,
          declaredFunction.signature.signature.parameters[parameter.index]!.name ??
            `arg${parameter.index + 1}`,
        );
      }
      functionSignature = declaredFunction;
      if (declaredHidden || stackSlots.size || declaration.variadic) {
        const registers = new Map<string, Value>();
        for (const [root, index] of namedRegisters) registers.set(root, parameters[index]!);
        declaredExtension = {
          stack,
          aggregate,
          variadic: declaration.variadic
            ? {
                // Win64 anonymous arguments follow the named ones in 8-byte
                // positions (home slots first); elsewhere they start in the
                // first 8-byte slot after the named stack arguments.
                anonymous:
                  abi.id === 'windows-x64'
                    ? 8n + 8n * BigInt(parameterTypes.length)
                    : (anonymous + 7n) & ~7n,
                registers: namedRegisters.size ? registers : null,
              }
            : null,
          hidden: hiddenFormal,
        };
      }
    }
  }
  // An established void interface returns nothing on any path: a tail transfer
  // forwards no result even when its callee's interface is unresolved.
  const declaredVoid =
    view === 'source' &&
    (functionSignature ?? plainDeclaration)?.declaration.returns.kind === 'void';
  if (declaredVoid) for (const [id, tail] of tails) tails.set(id, { ...tail, result_void: true });
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
  // Source view: positive caller result use, fetched at most once and only where
  // a void-like premise would otherwise apply or a tail result is unresolved.
  let callerDemand: readonly RegisterDescriptor[] | undefined;
  let callerSites = '';
  const callerDemands = (): readonly RegisterDescriptor[] => {
    if (callerDemand === undefined) {
      const found =
        view === 'source' && !functionSignature
          ? evidence.caller_result_demands?.(context)
          : undefined;
      callerDemand = found?.registers ?? [];
      callerSites = (found?.sites ?? [])
        .map(
          (site) =>
            `call at 0x${site.value.toString(16)} reads ${found!.registers.map((register) => `${register.root}:${register.offset_bits}:${register.width_bits}`).join(', ')}`,
        )
        .join('; ');
    }
    return callerDemand;
  };
  // Calls whose callee is void-like (`result_incidental`) and whose final result the
  // selection treated as incidental: the incidental_result record lists them.
  const incidentalCalls = new Set<string>();
  const selectPrimary = (demands: readonly RegisterDescriptor[]): SourcePrimaryResult | null =>
    view === 'source' &&
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
          demands,
          observed: evidence.function_returns?.registers ?? [],
          context,
          voidTails: new Set([...tails].flatMap(([id, tail]) => (tail.result_void ? [id] : []))),
          incidentalCall: (id) => {
            if (!inferred.get(id)?.result_incidental) return false;
            incidentalCalls.add(id);
            return true;
          },
        })
      : null;
  let primaryResult: SourcePrimaryResult | null =
    indirectResult && !functionSignature
      ? {
          kind: 'none',
          written: true,
          reason: 'returns through the incoming indirect result location',
          void_like: 'indirect_result',
        }
      : selectPrimary(evidence.function_return_demands ?? []);
  const exitIds = [...blocks.values()].flatMap((block) =>
    block.control.kind === 'return' ? [block.control.id] : [],
  );
  // The void-like premise assumes callers read no result register: a caller
  // that provably reads one refutes it, and the selection reruns with that demand.
  if (primaryResult?.kind === 'none' && primaryResult.void_like === 'incidental_result') {
    const demanded = callerDemands();
    if (demanded.length) {
      primaryResult = selectPrimary([...(evidence.function_return_demands ?? []), ...demanded]);
      if (
        !validation.presentation(
          'caller_result_use',
          input.function.id,
          'positive caller result use: a direct call site of this function whose caller reads a result register after the call returns and before writing it (in a bounded lifted window after the return address, or as semantic demand of the prepared caller body) refutes the void-like premise; the primary result is selected again with that register demanded',
          exitIds,
          callerSites,
        )
      )
        primaryResult = { kind: 'explicit', written: true, reason: 'presentation record bound' };
    }
  }
  // Closed-world caller consensus (premise D1): no caller in the image observes a
  // result register, so the function returns nothing on any path, tails included.
  // Asked only where the result may be incidental and the function would otherwise
  // present one: tail transfers only (no return exit to select from), or an integer
  // selection (or no selected register while a tail or the native interface
  // forwards a result) whose every return exit path may hold an incidental value:
  // the entry value, a call output, a value also stored or used otherwise
  // (`incidental_paths`, passed as `candidate` and run by the service after its free
  // checks). A path computing its value only for the exit returns it deliberately:
  // callers are not swept for it (the gate only skips an attempt; it proves nothing).
  const tailIds = [...blocks.values()].flatMap((block) =>
    block.control.kind === 'indirect' && block.control.tail_call ? [block.control.id] : [],
  );
  const tailsOnly =
    primaryResult === null &&
    !exitIds.length &&
    tailIds.length > 0 &&
    integerReturn?.kind === 'register' &&
    floatingReturn?.kind === 'register';
  if (
    view === 'source' &&
    !functionSignature &&
    !indirectResult &&
    !callerDemand?.length &&
    tailIds.every((id) => tails.has(id)) &&
    (tailsOnly ||
      (primaryResult?.kind === 'none' &&
        !primaryResult.void_like &&
        ([...tails.values()].some((tail) => !tail.result_void) ||
          !!evidence.function_returns?.registers.length)) ||
      primaryResult?.kind === 'integer')
  ) {
    // The FP carrier holds no result of this function when it is unchanged or
    // undefined (unknown entry value, unprojected call clobber) on every return exit,
    // or an incidental copy, and every tail callee writes no FP result register:
    // then only the integer result register is followed into callers.
    const floatingInert =
      (tailsOnly ||
        ((primaryResult?.kind === 'integer' || primaryResult?.kind === 'none') &&
          (primaryResult.floating_inert === true ||
            primaryResult.incidental_floating !== undefined))) &&
      [...tails].every(([id, tail]) => tail.result_void || floatingInertTails.has(id));
    const candidate = (): boolean =>
      tailsOnly ||
      ((primaryResult?.kind === 'integer' || primaryResult?.kind === 'none') &&
        primaryResult.incidental_paths?.() === true);
    const consensus = evidence.function_result_use?.(context, !floatingInert, candidate);
    const anchors = [...exitIds, ...tailIds];
    if (
      consensus &&
      validation.presentation(
        'caller_consensus',
        input.function.id,
        'closed-world caller consensus: the function is not exported, no relocation/rebase/bind/chained fixup targets its entry, no instruction materializes it (ADR, ADRP+ADD; RIP-relative references) or reaches it by a conditional branch or fallthrough, every direct call and tail transfer to it is enumerated and lies in a known function, and after each call the integer result register (and the FP one unless it is unchanged or undefined on every exit and no tail callee writes an FP result) is overwritten before any read or reaches only the return of a caller with the same consensus (tail transfers likewise); the function returns nothing on every path and every tail transfer forwards no result',
        anchors,
        `${floatingInert ? 'integer result register' : 'integer and FP result registers'} ignored after ${consensus.sites.map((site) => `0x${site.value.toString(16)}`).join(', ')}`,
      )
    ) {
      validation.requireAbi(
        'caller_consensus',
        anchors,
        'Presenting a void interface assumes a closed world: no code outside the image transfers control to the function (not exported, address never materialized, every direct branch to it enumerated), and callers read results only in the ABI result registers. The result registers keep their exact exit values in the exit metadata and checked view.',
      );
      primaryResult = {
        kind: 'none',
        written: true,
        reason: 'every caller ignores the result registers',
        void_like: 'caller_consensus',
      };
      for (const [id, tail] of tails) tails.set(id, { ...tail, result_void: true });
    }
  }
  const primaryScope =
    'primary result register defined on every exit path: unknown entry values, unprojected call clobbers and returning-frame addresses disqualify; FP needs typed IEEE writes (literal bits or a typed argument may join), or an untyped scalar FP value consumed only by exits (literal-zero upper cells, one 32/64-bit width, literal exits neutral) written after the integer register on every exit path; when both qualify: caller demand, then the register written last on every exit path, then a native written-result interface naming exactly one';
  // The untyped FP carrier holds only a vector copy or fill temporary: the
  // integer register decides alone (an exact result, or void-like below).
  const incidentalFloating =
    primaryResult?.kind === 'integer' || primaryResult?.kind === 'none'
      ? primaryResult.incidental_floating
      : undefined;
  if (incidentalFloating) {
    if (
      validation.presentation(
        'incidental_result',
        input.function.id,
        'incidental FP carrier: no caller demands the FP result register and, on every exit, each slice leaf of every FP-root cell is the datum of a >=128-bit store (through lossless transport), a constant defined by an instruction that also defines such a datum, or a call result left in place before later effects; unchanged and undefined cells are neutral, typed FP cells disqualify; the integer result register decides as if the FP register were undefined',
        exitIds,
        incidentalFloating,
      )
    )
      validation.requireAbi(
        'incidental_result',
        exitIds,
        'Presenting the integer result register alone assumes callers read no floating-point result register; the FP register holds a vector copy or fill temporary, no caller was scanned and no result-use evidence exists. It keeps its exact exit value in the exit metadata and checked view.',
      );
    else primaryResult = { kind: 'explicit', written: true, reason: 'presentation record bound' };
  }
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
        `${
          primaryResult.kind === 'float' && primaryResult.untyped
            ? 'Present the untyped scalar value of the ABI floating-point return register as the single IEEE result (no write types it): a scalar FP-bank result is IEEE; callers read no integer result.'
            : `Present the ABI ${floating ? 'floating-point' : 'integer'} return register as the single result; callers read no ${floating ? 'integer' : 'floating-point'} result register.`
        } The rejected register keeps its exact exit value in the exit metadata and checked view.`,
      );
    else primaryResult = { kind: 'explicit', written: true, reason: 'presentation record bound' };
  } else if (primaryResult?.kind === 'none' && primaryResult.void_like === 'incidental_result') {
    if (
      validation.presentation(
        'incidental_result',
        input.function.id,
        `void-like source interface: the integer result register qualifies on every exit, but no caller demands it, the FP result register is ${incidentalFloating ? 'an incidental vector copy or fill temporary (its own record)' : 'unchanged or undefined on every exit'}, ${tailIds.length ? 'every tail transfer forwards no result' : 'no tail transfer exists'}, and no exit path establishes it deliberately (moved back after a call/unknown-effect clobber on some path, another argument copied in, a projected call result that is the final action, or a constant/load/computation consumed by nothing but function exits and stores); call results left in place before later effects, untouched arguments and values that also address memory or feed calls or branches stay in exit metadata${incidentalCalls.size ? `; the final result of a void-like callee (its own incidental_result premise, applied transitively) establishes nothing; void-like callees: ${[...new Set([...incidentalCalls].map((id) => inferred.get(id)?.target_subject_id ?? id))].join(', ')}` : ''}`,
        exitIds,
        primaryResult.reason,
      )
    )
      validation.requireAbi(
        'incidental_result',
        exitIds,
        'Presenting a void-like interface assumes callers read no result register; no caller was scanned and no result-use evidence exists. The integer result register keeps its exact exit value in the exit metadata and checked view.',
      );
    else
      primaryResult = {
        kind: 'integer',
        ...(incidentalFloating ? { incidental_floating: incidentalFloating } : {}),
      };
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
  // A tail into a void-like callee (`result_incidental`, no void contract) forwards
  // no result under that callee's `incidental_result` premise, applied
  // transitively, and is recorded with the callees it rests on. It does so only
  // where this function presents no result either (only tail transfers, or a
  // void-like or result-free selection): beside a returned value it keeps
  // forwarding the callee's result storage. Caller consensus and a declared void
  // interface already void every tail.
  const incidentalTails =
    declaredVoid ||
    (primaryResult?.kind === 'none' && primaryResult.void_like === 'caller_consensus')
      ? []
      : [...tails].filter(([id, tail]) => {
          const callee = inferred.get(id);
          return (
            tail.result_void &&
            callee?.result_incidental &&
            !(callee.returns_void && !callee.returns.length)
          );
        });
  if (incidentalTails.length) {
    const anchors = incidentalTails.map(([id]) => id);
    const resultFree =
      !functionSignature &&
      (primaryResult === null
        ? !exitIds.length
        : primaryResult.kind === 'none' &&
          (primaryResult.void_like !== undefined || !evidence.function_returns?.registers.length));
    if (
      resultFree &&
      validation.presentation(
        'incidental_result',
        input.function.id,
        `void-like tail callee: the callee of each listed tail transfer has a native summary of its own resolved body (the source-view result selection over its native SSA with only semantic caller demand, through its own tails and final calls, recursion coinductive) whose integer result register is incidental on every exit path or undefined on some exit without proven result storage, and whose FP result register is unchanged or undefined on every exit; this function presents no result either; the transfer forwards no result; void-like callees: ${[...new Set(anchors.map((id) => inferred.get(id)?.target_subject_id ?? id))].join(', ')}`,
        anchors,
      )
    )
      validation.requireAbi(
        'incidental_result',
        anchors,
        'Presenting a tail transfer without a result assumes callers read no result register of the void-like callee, transitively; no caller was scanned and no result-use evidence exists. The result registers keep their exact exit values in the exit metadata and checked view.',
      );
    else
      for (const [id, tail] of incidentalTails) {
        const { result_void: _void, ...forwarding } = tail;
        tails.set(id, forwarding);
      }
  }
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
          (primaryResult.reason !== undefined || primaryResult.incidental_floating !== undefined) &&
          register.root === floatingRoot,
    );
  let returnType: DataType | null = null;
  const possibleReturnStorage = possibleAbiReturnStorage(abi);
  // Exits whose result is the low part of the integer ABI return location.
  const integerExits = new Map<
    string,
    { readonly block: BlockRegion; readonly location: Extract<AbiLocation, { kind: 'register' }> }
  >();
  for (const block of blocks.values())
    if (block.control.kind === 'return') {
      const control = block.control;
      let returned = [...control.values];
      if (functionSignature) {
        // A hidden result (S9) returns its pointer where the ABI places one.
        const type = declaredExtension?.hidden
          ? declaredLayout!.returns.length
            ? integer(abi.layout.pointer_bits)
            : null
          : machineType(functionSignature.declaration.returns);
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
            if (value) {
              returned = [value];
              integerExits.set(control.id, { block, location });
            }
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
    // The function width is decided from every exit before any exit is rebound.
    const width = Math.max(
      ...[...returns.values()].map((boundary) => bitWidth(boundary.results[0]!.type)),
    );
    returnType = integer(width);
    for (const [id, boundary] of returns) {
      const value = boundary.results[0]!;
      const narrow = bitWidth(value.type);
      if (narrow === width) continue;
      // A join of a narrow and a full-width write leaves the bits above the
      // narrow result as this exit's only other changed cells of the return
      // root. When those cells cover exactly [narrow, width), the exit returns
      // the whole register: their concatenation, not a zero extension.
      const exit = view === 'source' ? integerExits.get(id) : undefined;
      if (exit && width <= exit.location.width_bits) {
        const { register } = exit.location;
        const upper = boundary.outputs
          .filter((binding) => binding.register.root === register.root)
          .sort((left, right) => left.register.offset_bits - right.register.offset_bits);
        let cursor = register.offset_bits + narrow;
        for (const binding of upper)
          cursor =
            binding.register.offset_bits === cursor ? cursor + binding.register.width_bits : -1;
        const whole =
          upper.length && cursor === register.offset_bits + width
            ? bind(
                `${id}:result-width`,
                exit.block.register_exit,
                [{ ...exit.location, width_bits: width }],
                returnType,
                exit.block.id,
              )
            : null;
        if (
          whole &&
          validation.presentation(
            'exit_result_width',
            id,
            'an exit whose integer result is narrower than the function result width W, and whose remaining changed cells of the integer return root are exactly the bits from that narrow width up to W, returns the concatenation of all its return-root cells up to W: the exact register value, no bits invented or dropped',
            [id, value.id, ...upper.map((binding) => binding.value.id)],
          )
        ) {
          returns.set(id, {
            ...boundary,
            results: [whole],
            outputs: boundary.outputs.filter((binding) => !upper.includes(binding)),
          });
          continue;
        }
      }
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
  // Tails into proven-void callees contribute no result; the renderer declares
  // the function void only when no return path yields one either.
  if (!functionSignature && tails.size && [...tails.values()].every((tail) => tail.result_void))
    returnType = null;
  else if (!functionSignature && tails.size) {
    // Caller demand on the integer result root types a tail whose callee has no
    // result types: it forwards exactly the callee's whole result register, so
    // the function result is that register at the demanded width (or at the
    // returned paths' wider integer type).
    const unresolved = [...tails].filter(
      ([, tail]) => !tail.result_void && tail.result_types.length === 0,
    );
    const integerRoot =
      integerReturn?.kind === 'register' ? integerReturn.register.root : undefined;
    const demandBits = (demands: readonly RegisterDescriptor[]): number =>
      Math.max(
        0,
        ...demands
          .filter((register) => register.root === integerRoot)
          .map((register) => register.offset_bits + register.width_bits),
      );
    let demanded = 0;
    if (view === 'source' && unresolved.length && integerRoot) {
      demanded = demandBits(evidence.function_return_demands ?? []);
      if (!demanded) demanded = demandBits(callerDemands());
    }
    const demandedType = !demanded
      ? undefined
      : returnType?.kind === 'integer' && bitWidth(returnType) >= demanded
        ? returnType
        : integer(demanded <= 8 ? 8 : demanded <= 16 ? 16 : demanded <= 32 ? 32 : 64);
    const types = [...tails.values()].map((tail) =>
      tail.result_types.length === 1
        ? tail.result_types[0]!
        : demandedType && !tail.result_void && tail.result_types.length === 0
          ? demandedType
          : null,
    );
    const first = types[0];
    if (
      first &&
      types.every((type) => type !== null && sameType(type, first)) &&
      (!returnType || sameType(returnType, first)) &&
      (!demandedType ||
        validation.presentation(
          'tail_result_width',
          input.function.id,
          'a tail transfer whose callee has no result types forwards the whole integer result register of the callee; with caller demand on that register the function result is the register at the demanded width, or at the integer type every other exit already returns when that is wider',
          unresolved.map(([id]) => id),
          `${bitWidth(demandedType)}-bit result; ${callerSites || 'demand from prepared callers'}`,
        ))
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
  const incomingParameters = new Map<bigint, Value>(),
    formalStackOffsets = new Map<string, bigint>();
  const environmentWriters = new Set(
    evidence.callees.flatMap((callee) => (callee.fp_environment_writer ? [callee.call_id] : [])),
  );
  const registerOutputs = new Map<string, readonly RegisterBinding[]>();
  const presentation: SourcePresentation = {
    ...(environmentWriters.size ? { fp_environment_writers: environmentWriters } : {}),
    inferred: !functionSignature,
    parameter_names: parameterNames,
    return_type: returnType,
    ...(returnTypes ? { return_types: returnTypes } : {}),
    ...(returnPointer === undefined ? {} : { return_pointer: returnPointer }),
    ...(observedRejected ? { observed_result_rejected: true as const } : {}),
    ...(callerDemand?.length ? { caller_result_demands: callerDemand } : {}),
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
    register_outputs: registerOutputs,
    formal_stack_offsets: formalStackOffsets,
    ...(declaredExtension?.hidden ? { hidden_result: declaredExtension.hidden } : {}),
  };
  let entryParameter: Value | null = null,
    incomingObjectParameter: Value | null = null,
    // Source view: the named formals before `...`, when they follow ABI
    // argument positions (Win64, SysV); `variadicArea` alone for Darwin.
    variadicNamed: readonly Value[] | null = null,
    variadicArea: Value | null = null;
  return {
    calls,
    returns,
    tails,
    parameters,
    parameterRegisters,
    signature: functionSignature?.signature ?? null,
    /** Source view (S9): the declared parts the stack plan must confirm, or
     * null when the signature (if any) needs no confirmation. */
    declaredExtension,
    presentation,
    forcedInline,
    alias,
    make,
    /** Source view (E3): one whole output replaces the cells of a root that a
     * call or unknown effect writes; a call's projection lists it too. */
    outputs(
      node: Extract<Instruction, { kind: 'call' | 'unknown_effect' }>,
      bindings: readonly RegisterBinding[],
    ): void {
      registerOutputs.set(node.id, bindings);
      const projection = node.kind === 'call' ? calls.get(node.id) : undefined;
      if (!projection) return;
      const replaced = new Set(
        node.register_outputs
          .filter((binding) => !bindings.includes(binding))
          .map(({ value }) => value.id),
      );
      const added = bindings.filter((binding) => !node.register_outputs.includes(binding));
      calls.set(node.id, {
        ...projection,
        outputs: projection.outputs.flatMap((binding) =>
          !replaced.has(binding.value.id)
            ? [binding]
            : binding.register.offset_bits === 0
              ? added.filter(({ register }) => register.root === binding.register.root)
              : [],
        ),
      });
    },
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
      // A declared stack formal (S9) binds the loads of exactly its slot.
      if (functionSignature) {
        const value = declaredExtension?.stack.get(offset);
        if (!value || bitWidth(value.type) !== bitWidth(type)) return null;
        valueOrigins.set(value.id, [
          ...(valueOrigins.get(value.id) ?? []),
          ...contributors.map((contributor) => contributor.id),
        ]);
        return value;
      }
      // Without a declaration, infer only a whole scalar word in an actual ABI
      // parameter slot. Entry return addresses, home space and alignment padding
      // are not source inputs merely because their offsets are nonnegative.
      if (type.kind !== 'integer' || type.bits !== abi.layout.pointer_bits) return null;
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
        formalStackOffsets.set(value.id, offset);
      }
      return value;
    },
    /** Source view (S6/S7): the callee-side variadic interface, inferred from
     * the code `va_start` lowers to. A declared `...` (S9) supplies the named
     * formals instead: the footprint must name exactly their registers and
     * place the first anonymous argument where they end; any other declared
     * signature is never rewritten. */
    variadic: {
      named(registers: readonly RegisterDescriptor[]): readonly Value[] | null {
        if (functionSignature) {
          const declared = declaredExtension?.variadic?.registers;
          if (
            !declared ||
            registers.length !== declared.size ||
            registers.some((register) => !declared.has(register.root))
          )
            return null;
          return parameters.filter((value) =>
            registers.some((register) => declared.get(register.root) === value),
          );
        }
        const named: Value[] = [];
        for (const register of registers) {
          const value = parameters.find(
            (parameter) => parameterRegisters.get(parameter.id)?.root === register.root,
          );
          if (!value) return null;
          named.push(value);
        }
        return named;
      },
      area(offset: bigint, named: readonly Value[] | null): Value | null {
        // Win64 named positions were matched by `named`; Darwin names none.
        if (functionSignature && declaredExtension?.variadic?.anonymous !== offset) return null;
        variadicNamed = named;
        variadicArea ??= make(
          `parameter:va:${offset}`,
          integer(abi.layout.pointer_bits),
          entry.id,
          undefined,
          entry.register_entry
            .filter((binding) => binding.register.root === abi.stack_pointer.root)
            .map((binding) => binding.value),
        );
        return variadicArea;
      },
      list(named: readonly Value[], overflow: bigint): boolean {
        if (functionSignature && declaredExtension?.variadic?.anonymous !== overflow) return false;
        variadicNamed = named;
        return true;
      },
    },
    /** Source view (S4): the struct formal naming the incoming bytes kept as
     * memory, from entry-SP `offset` up to `end`. Inferred interfaces, or (S9)
     * a declared by-value aggregate whose stack slot starts at `offset` and
     * holds every kept byte; any other declared signature states its own
     * parameters. Its pointer-width type is a carrier; the renderer spells
     * the struct. */
    incomingObject(offset: bigint, end: bigint): Value | null {
      if (functionSignature) {
        const aggregate = declaredExtension?.aggregate;
        if (!aggregate || aggregate.offset !== offset || end > aggregate.end) return null;
        incomingObjectParameter = aggregate.value;
        return incomingObjectParameter;
      }
      if (!incomingObjectParameter) {
        incomingObjectParameter = make(
          'parameter:stack-args',
          integer(abi.layout.pointer_bits),
          entry.id,
          undefined,
          entry.register_entry
            .filter((binding) => binding.register.root === abi.stack_pointer.root)
            .map((binding) => binding.value),
        );
        parameterNames.set(incomingObjectParameter.id, 'stack_args');
        formalStackOffsets.set(incomingObjectParameter.id, offset);
      }
      return incomingObjectParameter;
    },
    /** Source view: the projection of an indirect exit that `classifyIndirectTails`
     * accepted. The observed argument-register prefix at the exit, as for an
     * indirect call, with the list open; no target identity and no result
     * interface, which stay the runtime target's. */
    indirectTail(block: BlockRegion): TailProjection | null {
      const control = block.control;
      if (control.kind !== 'indirect') return null;
      const callee = inferred.get(control.id);
      return {
        target: null,
        target_value: control.target,
        result_types: [],
        boundary: {
          kind: 'inferred',
          signature: null,
          arguments: callee
            ? observedArguments(callee, block.register_exit, control.id, block.id).arguments
            : [],
          argument_list_complete: false,
          results: [],
          inputs: [],
          outputs: [],
        },
      };
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
      // Named positions before `...` are formals even when unused: the last
      // one fixes where `va_start` finds the first anonymous argument. A
      // declaration (S9) already lists them in its own order.
      if (variadicNamed && !functionSignature) {
        const named = variadicNamed.filter((value) => !demotedParameters.has(value.id));
        demanded.splice(
          0,
          demanded.length,
          ...named,
          ...demanded.filter((value) => !named.includes(value)),
        );
      }
      demanded.forEach((value, index) => {
        if (!parameterNames.has(value.id)) parameterNames.set(value.id, `arg${index}`);
      });
      // Source-only formals follow the ABI ones: the incoming object (S4), then
      // the entry SP when some address still needs it. A declared aggregate's
      // incoming object (S9) is its own declared formal.
      return [
        ...demanded,
        ...[functionSignature ? null : incomingObjectParameter, entryParameter].filter(
          (value): value is Value => value !== null && live.has(value.id),
        ),
      ];
    },
  };
}

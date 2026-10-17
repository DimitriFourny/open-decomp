import {
  fingerprint,
  OperationError,
  type AbiLocation,
  type AbiSignature,
  type AbiType,
  type OperationContext,
  type RegisterDescriptor,
} from '../core/index.js';
import type { EmissionInput } from '../emitters/model.js';
import {
  bitWidth,
  expressionOperands,
  integer,
  type DataType,
  type Expression,
  type RegisterBinding,
  type Value,
} from '../ir/index.js';
import type { BlockRegion } from '../presentation/index.js';
import type { Assignment, BoundaryProjection } from './model.js';
import type { SourcePresentation } from './source-model.js';
import { sourceDataValues } from './source-data.js';
import type { SignatureAssociation } from '../analysis/types/model.js';

/** Source ABI abstraction: architectural snapshots are retained in the input,
 * not treated as extra source arguments or memory-fault observables. */
export function planSource(
  input: EmissionInput,
  blocks: ReadonlyMap<string, BlockRegion>,
  values: Map<string, Value>,
  expressions: Map<string, Expression>,
  owner: Map<string, string>,
  context: OperationContext,
) {
  const evidence = input.source!,
    abi = evidence.abi,
    entry = blocks.get(input.function.entry)!;
  const forcedInline = new Set<string>(),
    calls = new Map<string, BoundaryProjection>(),
    returns = new Map<string, BoundaryProjection>();
  const callResults = new Map<string, readonly Value[]>(),
    parameterNames = new Map<string, string>();
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
  const machineType = (type: AbiType): DataType | null =>
    type.kind === 'pointer'
      ? integer(abi.layout.pointer_bits)
      : type.kind === 'integer'
        ? integer(type.bits)
        : type.kind === 'float' && (type.bits === 32 || type.bits === 64)
          ? { kind: 'float', bits: type.bits }
          : null;
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
  const inferred = new Map(evidence.callees.map((callee) => [callee.call_id, callee]));
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
      return type?.kind === 'void' || type?.kind === 'integer' || type?.kind === 'float'
        ? type
        : type?.kind === 'pointer'
          ? { kind: 'pointer' }
          : null;
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
      const declaration =
        contracts.length === 1 ? contracts[0]!.contract.signature : declared?.declaration;
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
        const args = callee.parameters.map((register, index) =>
          bind(
            `${node.id}:arg:${index}`,
            node.register_inputs,
            locations(register),
            callee.parameter_types?.[index] ?? integer(register.width_bits),
            block.id,
          ),
        );
        if (args.every((value): value is Value => value !== null)) {
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
          projection = {
            kind: callee.parameter_state === 'ambiguous' ? 'physical' : 'inferred',
            signature: null,
            arguments: args,
            results: returned,
            inputs: [],
            outputs: node.register_outputs,
          };
        }
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
  // Scalar lane typing follows only lossless storage transport. Register bank,
  // root capacity and SSA cell integer types do not determine scalar FP width.
  const scalarWidths = new Map<string, 32 | 64>();
  const scalarLinks = new Map<string, Value[]>();
  const linkScalar = (left: Value, right: Value): void => {
    if (bitWidth(left.type) !== bitWidth(right.type)) return;
    const leftLinks = scalarLinks.get(left.id) ?? [];
    leftLinks.push(right);
    scalarLinks.set(left.id, leftLinks);
    const rightLinks = scalarLinks.get(right.id) ?? [];
    rightLinks.push(left);
    scalarLinks.set(right.id, rightLinks);
  };
  for (const [id, expression] of expressions) {
    const value = values.get(id)!;
    if (expression.kind === 'cast' && expression.op === 'bitcast')
      linkScalar(value, expression.value);
    else if (expression.kind === 'extract' && expression.offset === 0)
      linkScalar(value, expression.value);
  }
  for (const block of blocks.values()) {
    const control = block.control;
    const transfers = control.kind === 'jump'
      ? [control.transfer]
      : control.kind === 'if'
        ? [control.when_true.transfer, control.when_false.transfer]
        : control.kind === 'switch'
          ? [...control.cases.map((item) => item.arm.transfer), control.otherwise.transfer]
          : [];
    for (const transfer of transfers)
      for (const copy of transfer.copies) linkScalar(copy.destination, copy.source);
  }
  const scalarQueue: Value[] = [];
  for (const value of values.values())
    if (value.type.kind === 'float') {
      scalarWidths.set(value.id, value.type.bits);
      scalarQueue.push(value);
    }
  for (let index = 0; index < scalarQueue.length; index++) {
    const value = scalarQueue[index]!, width = scalarWidths.get(value.id)!;
    for (const linked of scalarLinks.get(value.id) ?? []) {
      context.checkpoint(1);
      if (scalarWidths.has(linked.id)) continue;
      scalarWidths.set(linked.id, width);
      scalarQueue.push(linked);
    }
  }
  // Typed reads alone are not evidence that the FP result bank was written.
  // Seed actual FP producers/call results, then follow their storage transport.
  const writtenScalars = new Set<string>();
  const writtenQueue: Value[] = [];
  for (const value of values.values()) {
    if (value.type.kind !== 'float') continue;
    const expression = expressions.get(value.id);
    if (expression && expression.kind !== 'extract' &&
        (expression.kind !== 'cast' || expression.op !== 'bitcast')) {
      writtenScalars.add(value.id);
      writtenQueue.push(value);
    }
  }
  for (const returned of callResults.values())
    for (const value of returned)
      if (value.type.kind === 'float' && !writtenScalars.has(value.id)) {
        writtenScalars.add(value.id);
        writtenQueue.push(value);
      }
  for (let index = 0; index < writtenQueue.length; index++)
    for (const linked of scalarLinks.get(writtenQueue[index]!.id) ?? []) {
      context.checkpoint(1);
      if (writtenScalars.has(linked.id)) continue;
      writtenScalars.add(linked.id);
      writtenQueue.push(linked);
    }
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
  for (const register of candidates) {
    const cells = entry.register_entry.filter(
      (binding) =>
        binding.register.root === register.root &&
        binding.register.offset_bits >= register.offset_bits &&
        binding.register.offset_bits < register.offset_bits + register.width_bits,
    );
    if (!cells.length) continue;
    const scalar = (register.bank === 'float' || register.bank === 'vector')
      ? cells.find((cell) => cell.register.offset_bits === register.offset_bits &&
          scalarWidths.has(cell.value.id))
      : undefined;
    const width = scalar
      ? scalarWidths.get(scalar.value.id)!
      : Math.max(...cells.map((cell) => cell.register.offset_bits + cell.register.width_bits)) -
        register.offset_bits;
    const descriptor = { ...register, width_bits: width };
    const value = result(
      `parameter:${register.root}`,
      entry.register_entry,
      locations(descriptor),
      scalar ? { kind: 'float', bits: scalarWidths.get(scalar.value.id)! }
        : cells.length === 1 ? cells[0]!.value.type : integer(width),
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
        reason: binding.register.root === 'arm64:fpcr' ? 'FPCR environment' : 'non-argument entry register',
      });
  }
  let returnType: DataType | null = null;
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
      if (!functionSignature && !returned.length) {
        // A typed, written low FP lane is a scalar result, not the unrelated
        // integer result bank or the full SIMD root (including cleared high bits).
        const floating = floatLayout.returns.flatMap((location) => {
          if (location.kind !== 'register') return [];
          const low = block.register_exit.find((binding) =>
            binding.register.root === location.register.root &&
            binding.register.offset_bits === location.register.offset_bits);
          const width = low && scalarWidths.get(low.value.id);
          if (!width || !low || !writtenScalars.has(low.value.id) ||
              entry.register_entry.some((binding) => binding.value.id === low.value.id))
            return [];
          const value = bind(`${control.id}:scalar-fp-result`, block.register_exit,
            [{ ...location, width_bits: width }], { kind: 'float', bits: width }, block.id);
          return value ? [value] : [];
        });
        if (floating.length === 1) returned = floating;
      }
      if (!functionSignature && !returned.length && layout.returns.length) {
        const location = layout.returns[0]!;
        if (location.kind === 'register') {
          const cells = block.register_exit.filter(
            (binding) => binding.register.root === location.register.root,
          );
          const changed = cells.some(
            (binding) =>
              !entry.register_entry.some((initial) => initial.value.id === binding.value.id),
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
      returns.set(control.id, {
        kind: functionSignature ? 'source' : 'inferred',
        signature: functionSignature?.signature ?? null,
        arguments: [],
        results: returned,
        inputs: [],
        outputs: [],
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
  const addressValue = sourceDataValues(expressions, evidence.addresses, context);
  const returnedData = [...returns.values()].map((boundary) =>
    boundary.results.length === 1 && boundary.results[0]!.type.kind === 'integer' &&
      bitWidth(boundary.results[0]!.type) === abi.layout.pointer_bits
      ? addressValue(boundary.results[0]!) : undefined);
  const returnPointer = (!functionSignature || functionSignature.declaration.returns.kind === 'pointer') &&
    returnedData.length && returnedData.every((item) =>
      item?.object !== undefined || item?.string !== undefined)
    ? returnedData.every((item) => item!.string !== undefined) ? 'char' as const : 'byte' as const
    : undefined;
  const presentation: SourcePresentation = {
    inferred: !functionSignature,
    parameter_names: parameterNames,
    return_type: returnType,
    ...(returnPointer === undefined ? {} : { return_pointer: returnPointer }),
    ...([...returns.values()].some((boundary) =>
      boundary.results.some((value) => value.type.kind === 'float'))
      ? { assumptions: ['FP arithmetic assumes nearest-even rounding, gradual underflow and disabled exception traps; FPCR/FPSR status and exceptional environments are not modeled.'] }
      : {}),
    locals: new Map(),
    stack: null,
    stack_addresses: new Map(),
    addresses: evidence.addresses,
    call_results: callResults,
    value_origins: valueOrigins,
    definitions,
  };
  const incomingParameters = new Map<bigint, Value>();
  return {
    calls,
    returns,
    parameters,
    parameterRegisters,
    signature: functionSignature?.signature ?? null,
    presentation,
    forcedInline,
    alias,
    make,
    incomingStack(offset: bigint, type: DataType, contributors: readonly Value[]): Value | null {
      // Without a declaration, infer only a whole scalar word in an actual ABI
      // parameter slot. Entry return addresses, home space and alignment padding
      // are not source inputs merely because their offsets are nonnegative.
      if (functionSignature || type.kind !== 'integer' || type.bits !== abi.layout.pointer_bits)
        return null;
      const slot = layout.parameters.find((parameter) =>
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
    finalize(live: ReadonlySet<string>): readonly Value[] {
      const incoming = [...incomingParameters]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([, value]) => value);
      const demanded = functionSignature
        ? parameters
        : [...parameters, ...incoming].filter((value) => live.has(value.id));
      demanded.forEach((value, index) => {
        if (!parameterNames.has(value.id)) parameterNames.set(value.id, `arg${index}`);
      });
      return demanded;
    },
  };
}

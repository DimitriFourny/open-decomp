import type { OperationContext } from '../core/index.js';
import type { EmissionInput } from '../emitters/model.js';
import { bitWidth, expressionOperands, type Value } from '../ir/index.js';
import type { BoundaryProjection, Reconstruction } from './model.js';
import type { SourceFormalType, SourcePresentation } from './source-model.js';
import { validateBitvectorCandidate } from './local-validation.js';

/** Infer a presentation interface from observed uses, retaining every machine
 * value. Narrow carriers are interpreted only under the native C ABI. */
export function projectSourceSignature(
  program: Reconstruction,
  input: EmissionInput,
  context: OperationContext,
): Pick<SourcePresentation, 'formal_types' | 'return_scalar'> & {
  readonly returns?: ReadonlyMap<string, BoundaryProjection>;
} {
  const formalTypes = new Map<string, SourceFormalType>();
  const validation = program.local_validation_session;
  if (
    program.view !== 'source' ||
    !program.source ||
    !input.source ||
    !validation ||
    program.signature
  )
    return {};
  const expressions = program.expressions;
  const incoming = new Map<string, Value[]>();
  for (const copies of program.transfers.values())
    for (const copy of copies) {
      const row = incoming.get(copy.destination.id) ?? [];
      row.push(copy.source);
      incoming.set(copy.destination.id, row);
    }
  const conflicts = new Set(input.types?.conflicts.map((item) => item.subject_id));
  const conflicting = (value: Value): boolean =>
    [value.id, ...(program.source?.value_origins?.get(value.id) ?? [])].some((id) =>
      conflicts.has(id),
    );
  const constant = (value: Value): bigint | undefined => {
    const expression = expressions.get(value.id);
    return expression?.kind === 'constant' ? expression.bits : undefined;
  };
  const transport = (value: Value): readonly Value[] => {
    const expression = expressions.get(value.id);
    if (expression?.kind === 'cast' && expression.op === 'bitcast') return [expression.value];
    return incoming.get(value.id) ?? [];
  };
  // Pointer lineage follows only unchanged whole bits, constant byte steps and
  // edge copies. A load through a scalar derived by masking/multiplication does
  // not establish a pointer formal.
  const pointerParents = (value: Value): readonly Value[] => {
    const expression = expressions.get(value.id);
    if (expression?.kind === 'integer' && ['add', 'sub'].includes(expression.op)) {
      if (constant(expression.right) !== undefined) return [expression.left];
      if (expression.op === 'add' && constant(expression.left) !== undefined)
        return [expression.right];
    }
    return transport(value);
  };
  const parameterRoots = (value: Value, wholePointers = true): Set<string> => {
    const roots = new Set<string>(),
      seen = new Set<string>(),
      pending = [value];
    while (pending.length) {
      context.checkpoint(1);
      const current = pending.pop()!;
      if (seen.has(current.id)) continue;
      seen.add(current.id);
      if (program.parameters.some((parameter) => parameter.id === current.id))
        roots.add(current.id);
      else {
        const expression = expressions.get(current.id);
        pending.push(
          ...(wholePointers
            ? pointerParents(current)
            : expression
              ? expressionOperands(expression)
              : (incoming.get(current.id) ?? [])),
        );
      }
    }
    return roots;
  };
  const accesses = new Map<string, Set<number>>();
  const written = new Set<string>(),
    escaped = new Set<string>();
  let writingCall = false;
  let mayWrite = false;
  for (const block of program.blocks.values())
    for (const node of block.statements) {
      context.checkpoint(1);
      if (node.kind === 'unknown_effect') mayWrite = true;
      if (node.kind === 'store') {
        for (const root of parameterRoots(node.address, false)) written.add(root);
        for (const root of parameterRoots(node.value, false)) escaped.add(root);
      }
      if (node.kind === 'call' && node.clobbers.memory === 'unknown_read_write') {
        writingCall = true;
        const boundary = program.calls.get(node.id);
        const arguments_ = boundary
          ? [...boundary.arguments, ...boundary.inputs.map((binding) => binding.value)]
          : [...node.arguments, ...node.register_inputs.map((binding) => binding.value)];
        if (boundary?.argument_list_complete === false)
          arguments_.push(...node.register_inputs.map((binding) => binding.value));
        for (const argument of arguments_)
          for (const root of parameterRoots(argument, false)) written.add(root);
      }
      if (node.kind !== 'load' && node.kind !== 'store') continue;
      const value = node.kind === 'load' ? node.result : node.value;
      for (const root of parameterRoots(node.address)) {
        const widths = accesses.get(root) ?? new Set<number>();
        widths.add(value.type.kind === 'integer' ? bitWidth(value.type) : 0);
        accesses.set(root, widths);
      }
    }
  if (writingCall) for (const root of escaped) written.add(root);
  const users = new Map<string, Value[]>();
  for (const [id, expression] of expressions) {
    if (!program.live.has(id)) continue;
    const value = program.values.get(id);
    if (!value) continue;
    for (const operand of expressionOperands(expression)) {
      const row = users.get(operand.id) ?? [];
      row.push(value);
      users.set(operand.id, row);
    }
  }
  const direct = new Set<string>();
  for (const copies of program.transfers.values())
    for (const copy of copies) direct.add(copy.source.id);
  for (const boundary of [...program.calls.values(), ...program.returns.values()]) {
    for (const value of [...boundary.arguments, ...boundary.results]) direct.add(value.id);
    for (const binding of [...boundary.inputs, ...boundary.outputs]) direct.add(binding.value.id);
  }
  for (const block of program.blocks.values()) {
    if (block.control.kind === 'if') direct.add(block.control.condition.id);
    if (block.control.kind === 'switch') direct.add(block.control.value.id);
    if (block.control.kind === 'indirect') {
      direct.add(block.control.target.id);
      mayWrite = true;
    }
    if (block.control.kind === 'unknown') mayWrite = true;
    for (const node of block.statements) {
      if (node.kind === 'load' || node.kind === 'store') direct.add(node.address.id);
      if (node.kind === 'store' || node.kind === 'write_register') direct.add(node.value.id);
      if (node.kind === 'unknown_effect')
        for (const binding of node.register_inputs) direct.add(binding.value.id);
    }
  }
  for (const parameter of program.parameters) {
    context.checkpoint(1);
    if (parameter.type.kind !== 'integer' || conflicting(parameter)) continue;
    // Independent supplied declarations and projected pointer layouts win.
    const projected = program.source.value_types?.get(parameter.id);
    if (
      projected &&
      input.types?.associations.some(
        (association) =>
          projected.association_ids.includes(association.id) && association.source !== 'analysis',
      )
    )
      continue;
    const widths = accesses.get(parameter.id);
    const pointee = widths?.size === 1 ? widths.values().next().value : undefined;
    if (
      (pointee === 8 || pointee === 16 || pointee === 32 || pointee === 64) &&
      bitWidth(parameter.type) === input.source.abi.layout.pointer_bits
    ) {
      const readOnly = !mayWrite && !written.has(parameter.id);
      if (
        validation.presentation(
          'formal_pointer',
          parameter.id,
          `whole-value pointer lineage reaches only ${pointee}-bit integer accesses; ${readOnly ? 'read-only formal: no writes through it or escape to a potentially writing call, and no unknown effects' : 'write-capable formal: write, call escape or unknown effects prevent const qualification'}`,
          program.source.value_origins?.get(parameter.id),
        )
      ) {
        formalTypes.set(parameter.id, {
          kind: 'pointer',
          bits: bitWidth(parameter.type),
          pointee_bits: pointee,
          const: readOnly,
        });
        validation.requireAbi(
          'formal_pointer',
          [program.function.id],
          'Present an observed scalar-address argument as a native C pointer with unchanged target address bits.',
        );
      }
      continue;
    }
    // All live uses of a full carrier must first discard its upper bits. Signed
    // consumers of the unchanged low word establish its interpretation, not
    // arbitrary signed operations elsewhere in the function.
    const pending = [parameter],
      seen = new Set<string>();
    let valid = true,
      signed = false,
      width = 0;
    while (pending.length && valid) {
      const value = pending.pop()!;
      if (seen.has(value.id)) continue;
      seen.add(value.id);
      if (direct.has(value.id)) {
        valid = false;
        break;
      }
      for (const user of users.get(value.id) ?? []) {
        context.checkpoint(1);
        const expression = expressions.get(user.id)!;
        if (expression.kind === 'cast' && expression.op === 'bitcast') pending.push(user);
        else if (
          (expression.kind === 'extract' && expression.offset === 0) ||
          (expression.kind === 'cast' && expression.op === 'truncate')
        ) {
          const bits = bitWidth(user.type);
          width = Math.max(width, bits);
          signed ||= (users.get(user.id) ?? []).some((consumer) => {
            const operation = expressions.get(consumer.id);
            return (
              (operation?.kind === 'compare' && operation.op.startsWith('s')) ||
              (operation?.kind === 'cast' && operation.op === 'sign_extend') ||
              (operation?.kind === 'integer' &&
                ['sdiv', 'srem', 'ashr'].includes(operation.op) &&
                (operation.op !== 'ashr' || operation.left.id === user.id))
            );
          });
        } else {
          valid = false;
          break;
        }
      }
    }
    if (
      valid &&
      signed &&
      width === 32 &&
      bitWidth(parameter.type) > width &&
      validation.presentation(
        'formal_low_word',
        parameter.id,
        'every live use first extracts the low 32 bits; an unchanged low word has a signed comparison, extension, division, remainder or arithmetic shift',
        program.source.value_origins?.get(parameter.id),
      )
    ) {
      formalTypes.set(parameter.id, { kind: 'integer', bits: width, signed: true });
      validation.requireAbi(
        'formal_low_word',
        [program.function.id],
        'Only the low argument word is consumed; native C ABI upper argument carrier bits are not part of the presented int32_t parameter.',
      );
    }
  }
  const result = { formal_types: formalTypes };
  const suppliedReturn = input.types?.types.some(
    (record) =>
      record.id === program.source?.return_source_type &&
      (record.source !== 'analysis' || record.definition.kind !== 'integer'),
  );
  if (
    suppliedReturn ||
    program.source.return_pointer ||
    program.tails.size ||
    !program.returns.size ||
    (program.source.return_type && bitWidth(program.source.return_type) < 32)
  )
    return result;
  if (
    input.source.function_return_demands?.some(
      (register) => register.offset_bits + register.width_bits > 32,
    )
  )
    return result;
  const returned = [...program.returns.values()];
  const zeroExtension = (value: Value): boolean => {
    const literal = constant(value);
    if (literal !== undefined) return literal === 0n;
    const expression = expressions.get(value.id);
    return (
      expression !== undefined &&
      validation.check(
        'bitvector',
        value.id,
        'high result slice is exactly the zero extension of a low word',
        () =>
          validateBitvectorCandidate(
            value,
            expression,
            { kind: 'constant', bits: 0n },
            expressions,
            validation.allowance,
          ),
      ).status === 'verified'
    );
  };
  const hasHighOutputs = returned.some((boundary) => boundary.outputs.length > 0);
  const primary = hasHighOutputs
    ? input.source.abi.classifyCall({
        returns: { kind: 'integer', bits: 32, signed: false },
        parameters: [],
        variadic: false,
        fixed_parameter_count: 0,
      }).returns[0]
    : undefined;
  const extensionOutput = (boundary: BoundaryProjection): boolean =>
    primary?.kind === 'register' &&
    bitWidth(boundary.results[0]!.type) === 32 &&
    boundary.outputs.every(
      ({ register, value }) =>
        register.root === primary.register.root &&
        register.offset_bits >= primary.register.offset_bits + 32 &&
        register.offset_bits + register.width_bits <= primary.register.root_width_bits &&
        zeroExtension(value),
    );
  if (
    returned.some(
      (boundary) =>
        boundary.results.length !== 1 ||
        boundary.results[0]!.type.kind !== 'integer' ||
        conflicting(boundary.results[0]!) ||
        (boundary.outputs.length > 0 && !extensionOutput(boundary)),
    )
  )
    return result;
  // Width proof: every nonconstant leaf is already a word or is an explicit
  // extension of one. Constants may join that width but cannot establish it.
  const narrow = (value: Value, active = new Set<string>()): number | null => {
    context.checkpoint(1);
    if (active.has(value.id) || active.size >= 64) return null;
    active.add(value.id);
    const expression = expressions.get(value.id);
    let width: number | null;
    if (bitWidth(value.type) <= 32) width = 32;
    else if (expression?.kind === 'constant')
      width = expression.bits >= 0n && expression.bits <= 0xffffffffn ? 0 : null;
    else if (
      expression?.kind === 'cast' &&
      ['zero_extend', 'sign_extend', 'bitcast'].includes(expression.op)
    )
      width = narrow(expression.value, active);
    else {
      const sources =
        expression?.kind === 'select'
          ? [expression.when_true, expression.when_false]
          : transport(value);
      const widths = sources.map((source) => narrow(source, active));
      width =
        widths.length && widths.every((bits) => bits !== null)
          ? Math.max(...(widths as number[]))
          : null;
    }
    active.delete(value.id);
    return width;
  };
  const widths = returned.map((boundary) => narrow(boundary.results[0]!));
  if (widths.some((width) => width === null) || !widths.includes(32)) return result;
  // Byte subtraction is signed evidence because both operands are proved in
  // [0,255], making the mathematical difference fit in signed 32 bits.
  const byte = (value: Value, active = new Set<string>()): boolean => {
    context.checkpoint(1);
    if (active.has(value.id) || active.size >= 64) return false;
    if (bitWidth(value.type) <= 8) return true;
    const literal = constant(value);
    if (literal !== undefined) return literal >= 0n && literal <= 255n;
    active.add(value.id);
    const expression = expressions.get(value.id);
    const sources =
      expression?.kind === 'cast' && ['zero_extend', 'bitcast'].includes(expression.op)
        ? [expression.value]
        : transport(value);
    const valid = sources.length > 0 && sources.every((source) => byte(source, active));
    active.delete(value.id);
    return valid;
  };
  let signedEvidence = false;
  const signedResult = (value: Value, active = new Set<string>()): boolean => {
    context.checkpoint(1);
    if (active.has(value.id) || active.size >= 64) return false;
    active.add(value.id);
    const expression = expressions.get(value.id);
    const comparison =
      expression?.kind === 'select' ? expressions.get(expression.condition.id) : undefined;
    const signedSelection =
      expression?.kind === 'select' &&
      comparison?.kind === 'compare' &&
      comparison.op.startsWith('s') &&
      ((expression.when_true.id === comparison.left.id &&
        expression.when_false.id === comparison.right.id) ||
        (expression.when_true.id === comparison.right.id &&
          expression.when_false.id === comparison.left.id));
    let valid = false;
    if (expression?.kind === 'constant') valid = true;
    else if (byte(value)) valid = true;
    else if (
      (bitWidth(value.type) === 32 && signedSelection) ||
      (expression?.kind === 'integer' &&
        ['sdiv', 'srem', 'ashr'].includes(expression.op) &&
        (bitWidth(value.type) === 32 ||
          [expression.left, ...(expression.op === 'ashr' ? [] : [expression.right])].every(
            (operand) => {
              const extended = expressions.get(operand.id);
              return (
                extended?.kind === 'cast' &&
                extended.op === 'sign_extend' &&
                bitWidth(extended.value.type) === 32
              );
            },
          )))
    ) {
      signedEvidence = true;
      valid = true;
    } else if (
      expression?.kind === 'cast' &&
      expression.op === 'sign_extend' &&
      bitWidth(expression.value.type) === 32
    ) {
      signedEvidence = true;
      valid = true;
    } else if (
      expression?.kind === 'integer' &&
      expression.op === 'sub' &&
      byte(expression.left) &&
      byte(expression.right)
    ) {
      signedEvidence = true;
      valid = true;
    } else {
      const sources =
        (expression?.kind === 'cast' &&
          ['zero_extend', 'sign_extend', 'bitcast', 'truncate'].includes(expression.op)) ||
        (expression?.kind === 'extract' && expression.offset === 0)
          ? [expression.value]
          : expression?.kind === 'select'
            ? [expression.when_true, expression.when_false]
            : transport(value);
      valid = sources.length > 0 && sources.every((source) => signedResult(source, active));
    }
    active.delete(value.id);
    return valid;
  };
  const signed = returned.every((boundary) => signedResult(boundary.results[0]!)) && signedEvidence;
  const anchors = [...program.returns.keys()];
  if (
    !validation.presentation(
      'return_low_word',
      program.function.id,
      `every return is an explicit low-word value or extension; no observed caller demands high bits; ${signed ? 'explicit signed operations or byte differences with compatible constants/bytes' : 'unsigned interpretation retained'}`,
      anchors,
    )
  )
    return result;
  validation.requireAbi(
    'return_low_word',
    anchors,
    'Present the low 32-bit C ABI result; upper result-register bits of a narrow return are unspecified to ABI-conforming callers.',
  );
  return {
    ...result,
    return_scalar: { bits: 32, signed },
    ...(hasHighOutputs
      ? {
          returns: new Map(
            [...program.returns].map(([id, boundary]) => [
              id,
              boundary.outputs.length ? { ...boundary, outputs: [] } : boundary,
            ]),
          ),
        }
      : {}),
  };
}

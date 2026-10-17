import type { AbiProfile, AbiType, OperationContext, RecoveredType } from '../core/index.js';
import { darwinArm64Abi } from '../abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../abi/sysv-amd64/index.js';
import { windowsX64Abi } from '../abi/windows-x64/index.js';
import type { SignatureAssociation, TypeRecoveryResult } from '../analysis/types/index.js';
import { bitWidth, type RegisterBinding, type Value } from '../ir/index.js';
import type { BoundaryProjection } from './model.js';

const profiles: Record<SignatureAssociation['signature']['abi'], AbiProfile> = {
  'darwin-arm64': darwinArm64Abi,
  'sysv-amd64': sysvAMD64Abi,
  'windows-x64': windowsX64Abi,
};
/** Source types and ABI classification must agree independently of display names.
 * Split, indirect, variadic and stack-passed objects remain physical: a type
 * association on a fragment does not establish a complete source value. */
export function boundaryProjector(
  types: TypeRecoveryResult | undefined,
  context: OperationContext,
): (
  subject: string,
  inputs: readonly RegisterBinding[],
  outputs: readonly RegisterBinding[],
  arguments_: readonly Value[],
  results: readonly Value[],
  sourceReturn?: boolean,
) => BoundaryProjection {
  const definitions = new Map<string, RecoveredType>();
  const conflicts = new Set<string>();
  const signatures = new Map<string, SignatureAssociation[]>();
  if (types?.state === 'complete') {
    for (const conflict of types.conflicts) {
      context.checkpoint(1);
      conflicts.add(conflict.subject_id);
    }
    for (const type of types.types) {
      context.checkpoint(1);
      // Analysis interns structural scalar definitions as candidates even when
      // an independently established ABI signature references that exact type.
      // The signature gate below, not a structural record alone, proves use.
      if (
        type.status === 'established' ||
        type.status === 'asserted' ||
        (type.source === 'analysis' && type.status === 'candidate')
      )
        definitions.set(type.id, type.definition);
    }
    for (const signature of types.signatures) {
      context.checkpoint(1);
      const group = signatures.get(signature.subject_id) ?? [];
      group.push(signature);
      signatures.set(signature.subject_id, group);
    }
  }
  const abiType = (id: string): AbiType | null => {
    if (conflicts.has(id)) return null;
    const type = definitions.get(id);
    if (!type) return null;
    if (type.kind === 'void' || type.kind === 'integer' || type.kind === 'float') return type;
    if (type.kind === 'pointer') return { kind: 'pointer' };
    return null;
  };
  return (subject, inputs, outputs, arguments_, results, sourceReturn = false) => {
    context.checkpoint(1);
    const physical: BoundaryProjection = {
      kind: 'physical',
      signature: null,
      arguments: arguments_,
      results,
      inputs,
      outputs,
    };
    const candidates = signatures.get(subject) ?? [];
    if (conflicts.has(subject) || candidates.some((item) => item.status === 'conflicting'))
      return physical;
    const eligible = candidates.filter(
      (item) =>
        (item.status === 'established' || item.status === 'asserted') &&
        item.abi_state === 'complete' &&
        !item.signature.variadic,
    );
    // Distinct declarations are not resolved by input order, even if names agree.
    if (eligible.length !== 1) return physical;
    const signature = eligible[0]!,
      declaration = signature.signature;
    const returns = abiType(declaration.return_type),
      parameters = declaration.parameters.map((item) => abiType(item.type_id));
    context.checkpoint(parameters.length + inputs.length + outputs.length);
    if (!returns || parameters.some((item) => item === null)) return physical;
    const layout = profiles[declaration.abi].classifyCall({
      returns,
      parameters: parameters as AbiType[],
      variadic: false,
      fixed_parameter_count: parameters.length,
      argument_list_complete: true,
    });
    if (
      layout.state !== 'complete' ||
      layout.hidden_result ||
      layout.argument_count !== parameters.length
    )
      return physical;
    const bind = (
      location: (typeof layout.returns)[number],
      bindings: readonly RegisterBinding[],
    ): Value | null => {
      context.checkpoint(bindings.length + 1);
      if (location.kind !== 'register' || location.value_offset_bits !== 0) return null;
      const matches = bindings.filter(
        (item) =>
          item.register.root === location.register.root &&
          item.register.offset_bits === location.register.offset_bits &&
          bitWidth(item.value.type) === location.width_bits &&
          item.register.width_bits === location.width_bits,
      );
      return matches.length === 1 ? matches[0]!.value : null;
    };
    const args: Value[] = [],
      returned: Value[] = [];
    for (const parameter of layout.parameters) {
      if (parameter.locations.length !== 1 || parameter.index !== args.length) return physical;
      const value = bind(parameter.locations[0]!, inputs);
      if (!value) return physical;
      const type = parameters[parameter.index]!;
      if (
        type.kind === 'float'
          ? value.type.kind !== 'float' || value.type.bits !== type.bits
          : value.type.kind !== 'integer'
      )
        return physical;
      args.push(value);
    }
    for (const location of layout.returns) {
      const value = bind(location, outputs);
      if (!value) return physical;
      if (
        returns.kind === 'float'
          ? value.type.kind !== 'float' || value.type.bits !== returns.bits
          : value.type.kind !== 'integer'
      )
        return physical;
      returned.push(value);
    }
    // Explicit IR arguments/results are semantics, not optional ABI hints.
    if (
      arguments_.some((value) => !args.some((arg) => arg.id === value.id)) ||
      results.some((value) => !returned.some((result) => result.id === value.id))
    )
      return physical;
    const implicit = inputs.filter((binding) =>
      layout.implicit_register_inputs.some(
        (requirement) => requirement.register.root === binding.register.root,
      ),
    );
    // An established source ABI does not promise caller-saved scratch bits on
    // return. Calls still define all clobbers, which may be used afterward.
    const clobbers = [...layout.clobbers.registers, ...layout.clobbers.flags];
    const visibleOutputs = sourceReturn
      ? outputs.filter((binding) => {
          context.checkpoint(clobbers.length + 1);
          return !clobbers.some(
            (register) =>
              register.root === binding.register.root &&
              register.offset_bits <= binding.register.offset_bits &&
              register.offset_bits + register.width_bits >=
                binding.register.offset_bits + binding.register.width_bits,
          );
        })
      : outputs;
    return {
      kind: 'source',
      signature,
      arguments: args,
      results: returned,
      inputs: implicit,
      outputs: visibleOutputs,
    };
  };
}

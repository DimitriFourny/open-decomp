import type {
  AbiProfile,
  AbiType,
  FunctionRecord,
  LoadedImage,
  OperationContext,
  ReferenceRecord,
} from '../../core/index.js';
import { bitWidth, type DataType, type SSAForm } from '../../ir/index.js';
import type { LibraryContracts } from '../../metadata/library-contracts/index.js';
import type { InferredCallee } from '../../reconstruction/source-model.js';
import { sourceConstantValues } from '../../reconstruction/source-data.js';
import { nativeCallIndex } from './calls.js';

/** Established callable stubs and import-slot references only; an arbitrary
 * indirect target never inherits a contract by name or by its surrounding image. */
export function nativeLibraryTails(
  ir: SSAForm,
  image: LoadedImage,
  functions: readonly FunctionRecord[],
  references: readonly ReferenceRecord[],
  library: LibraryContracts,
  abi: AbiProfile,
  context: OperationContext,
): readonly InferredCallee[] {
  const tails = ir.blocks.filter(
    (block) => block.terminator.kind === 'indirect' && block.terminator.tail_call,
  );
  if (!tails.length) return [];
  const index = nativeCallIndex(image, functions, references, context);
  const definitions = new Map(
    ir.blocks.flatMap((block) =>
      block.instructions.flatMap((node) =>
        node.kind === 'assign' ? [[node.result.id, node.expression] as const] : [],
      ),
    ),
  );
  const constant = sourceConstantValues(definitions, context, image.id);
  const scalar = (type: AbiType): DataType | null => {
    if (type.kind === 'pointer') return { kind: 'integer', bits: image.target.address_bits };
    if (type.kind === 'integer') return { kind: 'integer', bits: type.bits };
    if (type.kind === 'float' && (type.bits === 32 || type.bits === 64))
      return { kind: 'float', bits: type.bits };
    return null;
  };
  const result: InferredCallee[] = [];
  for (const block of tails) {
    context.checkpoint(1);
    const control = block.terminator;
    if (control.kind !== 'indirect') continue;
    const address = constant(control.target);
    const imports = new Map(
      (address === undefined
        ? []
        : (index.imports_by_address.get(`${image.id}:va:${address}`) ?? [])
      ).map((item) => [item.id, item]),
    );
    const established: ReferenceRecord[] = [];
    for (const instruction of control.provenance.instruction_ids)
      for (const reference of index.references_by_function.get(ir.id)?.get(instruction) ?? []) {
        context.checkpoint(1);
        if (reference.status !== 'established') continue;
        established.push(reference);
        const imported = reference.to_entity
          ? index.imports_by_id.get(reference.to_entity)
          : undefined;
        if (imported) imports.set(imported.id, imported);
      }
    if (imports.size !== 1) continue;
    const imported = [...imports.values()][0]!;
    if (
      !imported.callable_entry ||
      (address !== undefined && address !== imported.callable_entry.value) ||
      established.some(
        (reference) =>
          reference.to_entity !== imported.id &&
          !(
            reference.to?.image_id === image.id &&
            reference.to.space === 'va' &&
            reference.to.value === imported.callable_entry!.value &&
            (reference.target_role === 'code' || reference.target_role === 'callable_stub')
          ),
      )
    )
      continue;
    const contracts = library.contracts.filter((item) => item.import_id === imported.id);
    if (contracts.length !== 1) continue;
    const contract = contracts[0]!,
      signature = contract.abi_signature;
    if (
      contract.abi_state !== 'supported' ||
      contract.conflicts_with.length ||
      signature.variadic ||
      !signature.parameters
    )
      continue;
    const layout = abi.classifyCall(signature);
    if (layout.state !== 'complete' || layout.argument_count === null || layout.hidden_result)
      continue;
    const parameters = [],
      parameter_types: DataType[] = [];
    let valid = true;
    for (const parameter of layout.parameters) {
      const location = parameter.locations.length === 1 ? parameter.locations[0] : undefined;
      const type = scalar(signature.parameters[parameter.index]!);
      if (
        location?.kind !== 'register' ||
        !type ||
        location.value_offset_bits !== 0 ||
        location.width_bits !== bitWidth(type)
      ) {
        valid = false;
        break;
      }
      parameters.push({ ...location.register, width_bits: bitWidth(type) });
      parameter_types.push(type);
    }
    const returned = signature.returns.kind === 'void' ? null : scalar(signature.returns);
    const location = layout.returns.length === 1 ? layout.returns[0] : undefined;
    if (
      !valid ||
      (signature.returns.kind !== 'void' &&
        (!returned ||
          location?.kind !== 'register' ||
          location.value_offset_bits !== 0 ||
          location.width_bits !== bitWidth(returned)))
    )
      continue;
    result.push({
      call_id: control.id,
      target: imported.callable_entry,
      target_subject_id: imported.id,
      parameters,
      parameter_types,
      returns:
        returned && location?.kind === 'register'
          ? [{ ...location.register, width_bits: bitWidth(returned) }]
          : [],
      return_types: returned ? [returned] : [],
      ...(signature.returns.kind === 'void' ? { returns_void: true as const } : {}),
      parameter_state: 'observed',
      argument_list_complete: false,
      argument_list_closure: 'library_contract',
      evidence_ids: [
        ...new Set([
          ...contract.evidence_ids,
          ...imported.evidence_ids,
          ...control.provenance.evidence_ids,
        ]),
      ],
    });
  }
  return result;
}

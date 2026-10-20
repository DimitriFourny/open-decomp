import {
  entityIdentity,
  fingerprint,
  type Annotation,
  type Address,
  type DataLayout,
  type Evidence,
  type FunctionRecord,
  type LoadedImage,
  type OperationContext,
  type ReferenceRecord,
} from '../../core/index.js';
import type { SSAForm } from '../../ir/index.js';
import type {
  ContractTarget,
  SuppliedCallContract,
  SuppliedCallResolution,
} from '../../analysis/calls/index.js';
import { AnalysisBudget } from '../../analysis/ssa/budget.js';
import { SourceLayouts } from '../../analysis/types/layout.js';
import type { SuppliedSignature, SuppliedTypeRecord } from '../../analysis/types/index.js';
import type { DebugRecovery } from '../../metadata/debug/index.js';

export interface CallScope {
  readonly resolutions: readonly SuppliedCallResolution[];
  readonly subjects: readonly string[];
  readonly calls_by_subject: ReadonlyMap<
    string,
    readonly {
      readonly call_id: string;
      readonly target: ContractTarget;
      readonly evidence_ids: readonly string[];
    }[]
  >;
}

interface NativeCallIndex {
  readonly functions: readonly FunctionRecord[];
  readonly references: readonly ReferenceRecord[];
  readonly functions_by_id: ReadonlyMap<string, FunctionRecord>;
  readonly functions_by_address: ReadonlyMap<string, readonly FunctionRecord[]>;
  readonly exports_by_address: ReadonlyMap<string, LoadedImage['exports']>;
  readonly imports_by_address: ReadonlyMap<string, LoadedImage['imports']>;
  readonly imports_by_id: ReadonlyMap<string, LoadedImage['imports'][number]>;
  readonly references_by_function: ReadonlyMap<
    string,
    ReadonlyMap<string, readonly ReferenceRecord[]>
  >;
  /** Call and tail-call references by exact target address key. */
  readonly callers_by_target: ReadonlyMap<string, readonly ReferenceRecord[]>;
}
const nativeIndexes = new WeakMap<LoadedImage, NativeCallIndex>();
const nativeAddressKey = (address: Address): string =>
  `${address.image_id}:${address.space}:${address.value}`;

/** Index immutable native facts once; callers/callee summaries only visit their
 * own call nodes and reference lists. Array identities bind the exact snapshot. */
export function nativeCallIndex(
  image: LoadedImage,
  functions: readonly FunctionRecord[],
  references: readonly ReferenceRecord[],
  context: OperationContext,
): NativeCallIndex {
  const cached = nativeIndexes.get(image);
  if (cached?.functions === functions && cached.references === references) return cached;
  const functionsById = new Map<string, FunctionRecord>();
  const functionsByAddress = new Map<string, FunctionRecord[]>();
  for (const fn of functions) {
    context.checkpoint(1);
    functionsById.set(fn.id, fn);
    const key = nativeAddressKey(fn.entry),
      list = functionsByAddress.get(key) ?? [];
    list.push(fn);
    functionsByAddress.set(key, list);
  }
  const exportsByAddress = new Map<string, LoadedImage['exports'][number][]>();
  for (const item of image.exports) {
    context.checkpoint(1);
    if (!item.address) continue;
    const key = nativeAddressKey(item.address),
      list = exportsByAddress.get(key) ?? [];
    list.push(item);
    exportsByAddress.set(key, list);
  }
  const importsByAddress = new Map<string, LoadedImage['imports'][number][]>();
  const importsById = new Map<string, LoadedImage['imports'][number]>();
  for (const item of image.imports) {
    context.checkpoint(1);
    importsById.set(item.id, item);
    if (!item.callable_entry) continue;
    const key = nativeAddressKey(item.callable_entry),
      list = importsByAddress.get(key) ?? [];
    list.push(item);
    importsByAddress.set(key, list);
  }
  const referencesByFunction = new Map<string, Map<string, ReferenceRecord[]>>();
  const callersByTarget = new Map<string, ReferenceRecord[]>();
  for (const reference of references) {
    context.checkpoint(1);
    if (reference.kind === 'call' || reference.kind === 'tail_call') {
      if (reference.to) {
        const key = nativeAddressKey(reference.to),
          callers = callersByTarget.get(key) ?? [];
        callers.push(reference);
        callersByTarget.set(key, callers);
      }
    }
    if (
      reference.from_function === null ||
      reference.from_instruction === null ||
      (reference.kind !== 'call' && reference.kind !== 'tail_call')
    )
      continue;
    const byInstruction =
      referencesByFunction.get(reference.from_function) ?? new Map<string, ReferenceRecord[]>();
    const list = byInstruction.get(reference.from_instruction) ?? [];
    list.push(reference);
    byInstruction.set(reference.from_instruction, list);
    referencesByFunction.set(reference.from_function, byInstruction);
  }
  const indexed: NativeCallIndex = {
    functions,
    references,
    functions_by_id: functionsById,
    functions_by_address: functionsByAddress,
    exports_by_address: exportsByAddress,
    imports_by_address: importsByAddress,
    imports_by_id: importsById,
    references_by_function: referencesByFunction,
    callers_by_target: callersByTarget,
  };
  nativeIndexes.set(image, indexed);
  return indexed;
}

/** Bind persisted discovery/target proofs to actual lifted call nodes. An import
 * slot identifies an imported callee, never a direct code address. */
export function resolveCalls(
  ir: SSAForm,
  image: LoadedImage,
  functions: readonly FunctionRecord[],
  references: readonly ReferenceRecord[],
  indirect: boolean,
  context: OperationContext,
): CallScope {
  const indexed = nativeCallIndex(image, functions, references, context);
  const imports = indexed.imports_by_id;
  const resolutions: SuppliedCallResolution[] = [];
  const subjects = new Set<string>();
  const callsBySubject = new Map<
    string,
    { call_id: string; target: ContractTarget; evidence_ids: readonly string[] }[]
  >();
  const byInstruction = indexed.references_by_function.get(ir.id);
  const addSubject = (
    subject: string,
    call_id: string,
    target: ContractTarget,
    evidence_ids: readonly string[],
  ): void => {
    subjects.add(subject);
    const list = callsBySubject.get(subject) ?? [];
    const index = list.findIndex((item) => item.call_id === call_id);
    if (index < 0) list.push({ call_id, target, evidence_ids });
    else
      list[index] = {
        ...list[index]!,
        evidence_ids: [...new Set([...list[index]!.evidence_ids, ...evidence_ids])],
      };
    callsBySubject.set(subject, list);
  };
  for (const block of ir.blocks)
    for (const node of block.instructions) {
      context.checkpoint(1);
      if (node.kind !== 'call') continue;
      if (node.target.kind === 'direct') {
        const address = node.target.address,
          target: ContractTarget = { kind: 'address', address };
        const key = nativeAddressKey(address);
        for (const fn of indexed.functions_by_address.get(key) ?? []) {
          context.checkpoint(1);
          addSubject(fn.id, node.id, target, node.provenance.evidence_ids);
        }
        for (const exported of indexed.exports_by_address.get(key) ?? []) {
          context.checkpoint(1);
          addSubject(exported.id, node.id, target, [
            ...node.provenance.evidence_ids,
            ...exported.evidence_ids,
          ]);
        }
        for (const imported of indexed.imports_by_address.get(key) ?? []) {
          context.checkpoint(1);
          const proof = [...new Set([...node.provenance.evidence_ids, ...imported.evidence_ids])];
          const target: ContractTarget = {
            kind: 'import',
            image_id: image.id,
            import_id: imported.id,
          };
          resolutions.push({
            call_id: node.id,
            target,
            status: 'established',
            evidence_ids: proof,
          });
          addSubject(imported.id, node.id, target, proof);
        }
      }
      if (node.target.kind === 'indirect' && !indirect) continue;
      for (const instruction of node.provenance.instruction_ids)
        for (const reference of byInstruction?.get(instruction) ?? []) {
          context.checkpoint(1);
          if (reference.status === 'unresolved') continue;
          let target: ContractTarget | undefined;
          if (reference.to_entity && imports.has(reference.to_entity))
            target = { kind: 'import', image_id: image.id, import_id: reference.to_entity };
          else if (
            reference.to &&
            (reference.target_role === 'code' || reference.target_role === 'callable_stub')
          )
            target = { kind: 'address', address: reference.to };
          if (!target) continue;
          resolutions.push({
            call_id: node.id,
            target,
            status: reference.status,
            evidence_ids: reference.evidence_ids,
            ...(reference.target_role === 'import_slot' && reference.to
              ? { pointer_storage: reference.to }
              : {}),
          });
          if (reference.to_entity && reference.status === 'established')
            addSubject(reference.to_entity, node.id, target, reference.evidence_ids);
        }
    }
  return { resolutions, subjects: [...subjects], calls_by_subject: callsBySubject };
}

/** Use the existing source-layout resolver and typed ABI contracts, retaining
 * exact call IDs and explicit provenance for each source declaration's use. */
export function callDeclarations(
  ir: SSAForm,
  image: LoadedImage,
  revision: number,
  scope: CallScope,
  debug: DebugRecovery,
  annotations: readonly Annotation[],
  types: readonly SuppliedTypeRecord[],
  context: OperationContext,
  layout: DataLayout,
): {
  contracts: SuppliedCallContract[];
  signatures: SuppliedSignature[];
  evidence: Evidence[];
} {
  const records = new Map<string, SuppliedTypeRecord[]>();
  for (const record of types) {
    context.checkpoint(1);
    const list = records.get(record.id) ?? [];
    list.push(record);
    records.set(record.id, list);
  }
  const budget = new AnalysisBudget({
    max_work: context.budget.work,
    checkpoint: (work) => context.checkpoint(work),
  });
  const layouts = new SourceLayouts(records, budget, layout);
  const contracts: SuppliedCallContract[] = [],
    signatures: SuppliedSignature[] = [],
    evidence: Evidence[] = [];
  const add = (
    declaration: SuppliedSignature,
    uses: readonly { call_id: string; target: ContractTarget; evidence_ids: readonly string[] }[],
  ): void => {
    if (!uses.length) return;
    const id = entityIdentity(image.selected_slice_id, 'pipeline-call-contract', [
      ir.id,
      declaration.id,
    ]);
    const parents = [
      ...new Set([
        ...declaration.evidence_ids,
        ...declaration.signature.evidence_ids,
        ...uses.flatMap((use) => use.evidence_ids),
      ]),
    ].sort();
    const proof = `evidence_${fingerprint([image.selected_slice_id, ir.id, id, parents, revision])}`;
    context.checkpoint(1 + parents.length);
    evidence.push({
      id: proof,
      origin: {
        kind: 'analysis',
        analyzer: 'pipeline-call-contracts',
        version: '2',
        rule: 'exact grounded call-site source declaration',
      },
      claim: 'Source declaration applied only to calls with a grounded target identity',
      derived_from: parents,
      conflicts_with: [],
      revision,
    });
    if (
      declaration.status === 'asserted' ||
      declaration.status === 'established' ||
      declaration.status === 'conflicting'
    )
      contracts.push({
        id,
        target: uses[0]!.target,
        signature: {
          returns: layouts.abi(declaration.signature.return_type),
          parameters: declaration.signature.parameters.map((parameter) =>
            layouts.abi(parameter.type_id),
          ),
          variadic: declaration.signature.variadic,
          fixed_parameter_count: declaration.signature.parameters.length,
          argument_list_complete: !declaration.signature.variadic,
        },
        noreturn: declaration.signature.noreturn,
        evidence_ids: [proof],
      });
    for (const use of uses)
      signatures.push({ ...declaration, id, subject_id: use.call_id, evidence_ids: [proof] });
  };
  for (const annotation of annotations) {
    context.checkpoint(1);
    if (annotation.status === 'retracted' || annotation.value.kind !== 'signature') continue;
    const uses = scope.calls_by_subject.get(annotation.entity_id);
    if (uses)
      add(
        {
          id: annotation.id,
          subject_id: annotation.entity_id,
          signature: annotation.value.value,
          source: annotation.origin,
          status: annotation.status,
          evidence_ids: annotation.evidence_ids,
        },
        uses,
      );
  }
  for (const fn of debug.functions) {
    context.checkpoint(1);
    if (!fn.signature) continue;
    const uses: { call_id: string; target: ContractTarget; evidence_ids: readonly string[] }[] = [];
    for (const block of ir.blocks)
      for (const node of block.instructions) {
        context.checkpoint(1);
        if (
          node.kind === 'call' &&
          node.target.kind === 'direct' &&
          node.target.address.image_id === image.id &&
          node.target.address.space === 'va' &&
          node.target.address.value === fn.dwarf.address
        )
          uses.push({
            call_id: node.id,
            target: { kind: 'address', address: node.target.address },
            evidence_ids: node.provenance.evidence_ids,
          });
      }
    add(
      {
        id: fn.id,
        subject_id: fn.id,
        signature: fn.signature,
        source: 'debug',
        status: fn.conflicting ? 'conflicting' : 'established',
        evidence_ids: fn.evidence_ids,
      },
      uses,
    );
  }
  return { contracts, signatures, evidence };
}

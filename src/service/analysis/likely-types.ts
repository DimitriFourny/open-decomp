import {
  entityIdentity,
  type Address,
  type Diagnostic,
  type LikelyHeuristic,
  type OperationContext,
} from '../../core/index.js';
import { recoverPointerEvidence } from '../../analysis/types/index.js';
import { bitWidth, type Expression, type SSAForm, type Value } from '../../ir/index.js';
import type { SuppliedTypeRecord } from '../../analysis/types/index.js';
import type { LikelyTypeEvidence, LikelyTypes } from '../../reconstruction/source-model.js';
import {
  ConsensusLimit,
  boundedShare,
  directCallers,
  type CallerUnit,
  type LikelyArityEnv,
} from './likely-arity.js';
import { parameterRegisters } from './native-abi.js';
import type { PreparedNativeUnit } from './native-prepare.js';

/** Votes of the discovered direct callers on one formal or on the result. */
interface Votes {
  /** Sites that pass (or consume) a value proven to hold an address. */
  pointer: number;
  /** Sites with no pointer evidence for the value. The null constant abstains. */
  other: number;
}

/** A guess needs at least one pointer site and no site that contradicts it. */
const unanimous = (votes: Votes | undefined): votes is Votes =>
  votes !== undefined && votes.pointer > 0 && votes.other === 0;

/** The `void` and `void *` records a likely type guess prints through; the ids depend only
 * on the slice and the body, so the evidence and the type records agree on them. */
export function likelyPointerTypes(
  sliceId: string,
  functionId: string,
): { readonly pointer_type_id: string; readonly records: readonly SuppliedTypeRecord[] } {
  const voidId = entityIdentity(sliceId, 'likely-pointer-type', [functionId, 'void']);
  const pointerId = entityIdentity(sliceId, 'likely-pointer-type', [functionId, 'pointer']);
  return {
    pointer_type_id: pointerId,
    records: [
      {
        id: voidId,
        definition: { kind: 'void' },
        source: 'analysis',
        status: 'candidate',
        evidence_ids: [],
      },
      {
        id: pointerId,
        definition: { kind: 'pointer', bits: 64, to: voidId },
        source: 'analysis',
        status: 'candidate',
        evidence_ids: [],
      },
    ],
  };
}

/** Values of one caller unit that its proven analysis, local types plus pointer evidence,
 * holds as a whole machine address. Unanalyzable units have none. */
function addressValues(
  env: LikelyArityEnv,
  unit: PreparedNativeUnit,
  context: OperationContext,
): ReadonlySet<string> {
  const { input } = env;
  const result = new Set<string>();
  if (!unit.ir || !unit.types || unit.types.state !== 'complete') return result;
  const evidence = recoverPointerEvidence(unit.ir, unit.types, context, {
    slice_id: input.image.selected_slice_id,
    revision: input.revision,
    layout: input.components.abi.layout,
  });
  const definitions = new Map<string, boolean>();
  for (const record of evidence.types)
    definitions.set(
      record.id,
      definitions.has(record.id) ? false : record.definition.kind === 'pointer',
    );
  for (const association of evidence.associations) {
    context.checkpoint(1);
    if (
      association.status === 'conflicting' ||
      association.status === 'hypothesis' ||
      association.value_offset_bits !== 0 ||
      association.machine_offset_bits !== 0 ||
      association.width_bits !== input.components.abi.layout.pointer_bits ||
      definitions.get(association.type_id) !== true
    )
      continue;
    result.add(association.subject_id);
  }
  return result;
}

/** A value and the same-width copies it is made of: an address held in a copy is held by
 * the value. */
function holdsAddress(
  value: Value,
  addresses: ReadonlySet<string>,
  definitions: ReadonlyMap<string, Expression>,
  context: OperationContext,
): boolean {
  let current: Value | undefined = value;
  for (let depth = 0; current && depth < 8; depth++) {
    context.checkpoint(1);
    if (addresses.has(current.id)) return true;
    const expression = definitions.get(current.id);
    if (
      expression?.kind === 'cast' &&
      expression.op === 'bitcast' &&
      bitWidth(expression.value.type) === bitWidth(current.type)
    )
      current = expression.value;
    else if (
      expression?.kind === 'extract' &&
      expression.offset === 0 &&
      bitWidth(expression.value.type) === bitWidth(current.type)
    )
      current = expression.value;
    else current = undefined;
  }
  return false;
}

/** Likely mode only. Pointer types of the selected function's integer formals and result, from
 * what its discovered direct callers do with them (`caller_argument_pointer`: every caller
 * that prepares the formal passes a value its own proven analysis holds as an address;
 * `caller_result_pointer`: every caller that consumes the result treats it as one). Null
 * constants abstain. Sound only if the discovered callers are the callers, which is why the
 * mode is opt-in and marks each use. Gate and marking are the caller's business. */
export function likelyTypes(env: LikelyArityEnv): {
  readonly types: LikelyTypes;
  readonly diagnostics: Diagnostic[];
} {
  const { input } = env;
  const diagnostics: Diagnostic[] = [];
  const none: LikelyTypes = {
    parameters: new Map(),
    pointer_type_id: likelyPointerTypes(input.image.selected_slice_id, input.ir.id).pointer_type_id,
  };
  const self = input.functions.find((fn) => fn.id === input.ir.id);
  if (!self) return { types: none, diagnostics };
  const share = boundedShare(env);
  const context = share.context;
  const abi = input.components.abi;
  const formalRoots = new Set(
    parameterRegisters(abi)
      .filter((register) => register.width_bits === abi.layout.pointer_bits)
      .map((register) => register.root),
  );
  const parameters = new Map<string, Votes>();
  let result: Votes | undefined;
  try {
    const callers: readonly CallerUnit[] | undefined = directCallers(
      env,
      self.entry as Address,
      input.ir,
      context,
    );
    if (!callers) return { types: none, diagnostics };
    for (const { unit, calls } of callers) {
      const addresses = addressValues(env, unit, context);
      const definitions = new Map<string, Expression>();
      for (const block of unit.ir!.blocks)
        for (const node of block.instructions)
          if (node.kind === 'assign') definitions.set(node.result.id, node.expression);
      const nodes = new Map<
        string,
        Extract<SSAForm['blocks'][number]['instructions'][number], { kind: 'call' }>
      >();
      for (const block of unit.ir!.blocks)
        for (const node of block.instructions) if (node.kind === 'call') nodes.set(node.id, node);
      for (const id of calls) {
        const node = nodes.get(id)!;
        const observed = unit.observed_calls.find((call) => call.call_id === id);
        if (!observed) return { types: none, diagnostics };
        for (const binding of node.register_inputs) {
          const root = binding.register.root;
          if (
            !formalRoots.has(root) ||
            binding.register.offset_bits !== 0 ||
            binding.register.width_bits !== abi.layout.pointer_bits ||
            bitWidth(binding.value.type) !== abi.layout.pointer_bits
          )
            continue;
          const constant = definitions.get(binding.value.id);
          if (constant?.kind === 'constant' && constant.bits === 0n) continue;
          const votes = parameters.get(root) ?? { pointer: 0, other: 0 };
          const isPointer = holdsAddress(binding.value, addresses, definitions, context);
          if (isPointer) votes.pointer++;
          else votes.other++;
          parameters.set(root, votes);
        }
        const consumed = observed.returns.find(
          (register) =>
            register.offset_bits === 0 && register.width_bits === abi.layout.pointer_bits,
        );
        const output = consumed
          ? node.register_outputs.find(
              (binding) =>
                binding.register.root === consumed.root &&
                binding.register.offset_bits === 0 &&
                bitWidth(binding.value.type) === abi.layout.pointer_bits,
            )
          : undefined;
        if (output) {
          result ??= { pointer: 0, other: 0 };
          if (holdsAddress(output.value, addresses, definitions, context)) result.pointer++;
          else result.other++;
        }
      }
    }
  } catch (error) {
    if (!(error instanceof ConsensusLimit)) throw error;
    share.limited = true;
  }
  if (share.limited) diagnostics.push(share.diagnostic());
  const guess = (heuristic: LikelyHeuristic, votes: Votes): LikelyTypeEvidence => ({
    heuristics: [heuristic],
    sites: votes.pointer,
  });
  const guessed = new Map<string, LikelyTypeEvidence>();
  for (const [root, votes] of parameters)
    if (unanimous(votes)) guessed.set(root, guess('caller_argument_pointer', votes));
  return {
    types: {
      ...none,
      parameters: guessed,
      ...(unanimous(result) ? { result: guess('caller_result_pointer', result) } : {}),
    },
    diagnostics,
  };
}

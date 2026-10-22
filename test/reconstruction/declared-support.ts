import {
  createOperationContext,
  type AbiProfile,
  type RecoveredType,
} from '../../src/core/index.js';
import { entityIdentity } from '../../src/core/identity.js';
import { recoverTypes } from '../../src/analysis/types/index.js';
import type { TypeRecoveryResult } from '../../src/analysis/types/model.js';
import type { SSAForm } from '../../src/ir/index.js';
import { image, slice } from '../ir/support.js';

/** Stable id of the declared source type `name`. */
export const typeId = (name: string): string => entityIdentity(slice, 'source-type', name);

/** Type recovery for `ir` with a DWARF-like declaration of the function itself:
 * named source types (structure fields reference `typeId(name)`), the result
 * type and the named parameters, `...` when `variadic`. `status` 'hypothesis'
 * gives the same declaration without the standing the planner requires. */
export function declaredTypes(
  ir: SSAForm,
  abi: AbiProfile,
  declaration: {
    readonly types: Readonly<Record<string, RecoveredType>>;
    readonly returns: string;
    readonly parameters: readonly (readonly [name: string, type: string])[];
    readonly variadic?: boolean;
    readonly status?: 'asserted' | 'hypothesis';
  },
): TypeRecoveryResult {
  return recoverTypes(ir, abi, createOperationContext(), {
    image_id: image,
    slice_id: slice,
    revision: 0,
    types: Object.entries(declaration.types).map(([name, definition]) => ({
      id: typeId(name),
      definition,
      source: 'debug' as const,
      status: 'asserted' as const,
      evidence_ids: [],
    })),
    signatures: [
      {
        id: entityIdentity(slice, 'source-signature', ir.id),
        subject_id: ir.id,
        source: 'debug',
        status: declaration.status ?? 'asserted',
        evidence_ids: [],
        signature: {
          abi: abi.id,
          return_type: typeId(declaration.returns),
          parameters: declaration.parameters.map(([name, type]) => ({
            id: entityIdentity(slice, 'source-parameter', `${ir.id}:${name}`),
            name,
            type_id: typeId(type),
          })),
          variadic: declaration.variadic ?? false,
          noreturn: false,
          evidence_ids: [],
        },
      },
    ],
  });
}

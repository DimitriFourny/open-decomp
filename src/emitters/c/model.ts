import type { Annotation, Diagnostic, Emission } from '../../core/index.js';
import type { TypeRecoveryResult } from '../../analysis/types/index.js';
import type { StructuredFunction } from '../../presentation/index.js';

/** Facts must belong to the same analyzed function/revision. Names are display data,
 * never identities, expressions, type constraints, or call contracts. Conflicting
 * names are retained in diagnostics rather than selected by input order. */
export interface CEmissionInput {
  readonly function: StructuredFunction;
  readonly types?: TypeRecoveryResult;
  readonly names?: readonly { readonly entity_id: string; readonly name: string }[];
  /** Only active note annotations are rendered here; type recovery consumes type
   * assertions separately. The coordinator resolves active names into names. */
  readonly annotations?: readonly Annotation[];
}
export interface CEmissionResult {
  readonly emission: Emission;
  readonly diagnostics: readonly Diagnostic[];
  readonly coverage: {
    readonly statements: number;
    readonly controls: number;
    readonly mapped_statements: number;
    readonly mapped_controls: number;
  };
  readonly identifiers: readonly {
    readonly entity_id: string;
    readonly identifier: string;
    readonly original_name: string | null;
  }[];
}

import type { Emitter, OperationContext } from '../../core/index.js';
import type { EmissionInput, EmissionResult } from '../model.js';
import { renderSource } from '../renderer.js';

export const PYTHON_LIKE_EMITTER_VERSION = 'reconstructed-python-like-57';
type Options = Parameters<Emitter<EmissionInput>['emit']>[1];

/** Python-shaped high-level pseudocode, never ordinary executable Python.
 * Reconstruction, source projections and evidence are shared with C-like output. */
export class PythonLikeEmitter implements Emitter<EmissionInput> {
  readonly id = 'python-like';
  readonly name = 'reconstructed-python-like';
  readonly version = PYTHON_LIKE_EMITTER_VERSION;
  readonly language = 'python-like' as const;
  emit(
    input: EmissionInput,
    options: Options,
    context: OperationContext,
  ): EmissionResult['emission'] {
    return emitPythonLike(input, options, context).emission;
  }
}

/** Produces final-dialect UTF-16 spans alongside reconstructed provenance. */
export function emitPythonLike(
  input: EmissionInput,
  options: Options,
  context: OperationContext,
): EmissionResult {
  return renderSource(input, options, context, 'python-like', PYTHON_LIKE_EMITTER_VERSION);
}

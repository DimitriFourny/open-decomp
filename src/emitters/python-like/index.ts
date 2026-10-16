import type { Emitter, OperationContext } from '../../core/index.js';
import type { EmissionInput, EmissionResult } from '../model.js';
import { Renderer } from '../renderer.js';

export const PYTHON_LIKE_EMITTER_VERSION = 'typed-machine-python-like-2';
type Options = Parameters<Emitter<EmissionInput>['emit']>[1];

/** Python-shaped machine pseudocode, never ordinary executable Python. Decoding,
 * lifting, analysis and evidence are shared with the C-like presentation. */
export class PythonLikeEmitter implements Emitter<EmissionInput> {
  readonly id = 'python-like';
  readonly name = 'typed-machine-python-like';
  readonly version = PYTHON_LIKE_EMITTER_VERSION;
  readonly language = 'python-like' as const;
  emit(input: EmissionInput, options: Options, context: OperationContext): EmissionResult['emission'] {
    return emitPythonLike(input, options, context).emission;
  }
}

/** Produces final-dialect UTF-16 spans alongside machine/evidence metadata. */
export function emitPythonLike(input: EmissionInput, options: Options, context: OperationContext): EmissionResult {
  return new Renderer(input, options, context, 'python-like', PYTHON_LIKE_EMITTER_VERSION).render();
}

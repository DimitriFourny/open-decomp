import type { Emitter, OperationContext } from '../../core/index.js';
import type { EmissionInput, EmissionResult } from '../model.js';
import { Renderer } from '../renderer.js';

export const C_EMITTER_VERSION = 'reconstructed-c-32';
type Options = Parameters<Emitter<EmissionInput>['emit']>[1];

/** C-like high-level pseudocode, not a compilable source translation.
 * The shared reconstruction owns propagation, liveness and proven source views;
 * this entrypoint selects syntax while preserving evidence and resource limits. */
export class CEmitter implements Emitter<EmissionInput> {
  readonly id = 'c-like';
  readonly name = 'reconstructed-c';
  readonly version = C_EMITTER_VERSION;
  readonly language = 'c-like' as const;
  emit(
    input: EmissionInput,
    options: Options,
    context: OperationContext,
  ): EmissionResult['emission'] {
    return emitC(input, options, context).emission;
  }
}

/** One render produces both the core artifact and richer reconstruction metadata.
 * Exhausted/cancelled operations throw OperationError and publish no partial text. */
export function emitC(
  input: EmissionInput,
  options: Options,
  context: OperationContext,
): EmissionResult {
  return new Renderer(input, options, context, 'c-like', C_EMITTER_VERSION).render();
}

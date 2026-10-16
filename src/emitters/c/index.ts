import type { Emitter, OperationContext } from '../../core/index.js';
import type { EmissionInput, EmissionResult } from '../model.js';
import { Renderer } from '../renderer.js';

export const C_EMITTER_VERSION = 'typed-machine-c-2';
type Options = Parameters<Emitter<EmissionInput>['emit']>[1];

/** C-like reconstruction, NOT recovered source or a compilable C translation.
 * This emitter consumes verified structured IR; it does not recover signatures,
 * simplify expressions, delete effects, or reinterpret annotation assertions. */
export class CEmitter implements Emitter<EmissionInput> {
  readonly id = 'c-like';
  readonly name = 'typed-machine-c';
  readonly version = C_EMITTER_VERSION;
  readonly language = 'c-like' as const;
  emit(input: EmissionInput, options: Options, context: OperationContext): EmissionResult['emission'] {
    return emitC(input, options, context).emission;
  }
}

/** One render produces both the core artifact and richer reconstruction metadata.
 * Exhausted/cancelled operations throw OperationError and publish no partial text. */
export function emitC(input: EmissionInput, options: Options, context: OperationContext): EmissionResult {
  return new Renderer(input, options, context, 'c-like', C_EMITTER_VERSION).render();
}


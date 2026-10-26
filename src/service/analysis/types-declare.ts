import {
  typeLibraryIdentity,
  type Diagnostic,
  type ToolArgs,
  type ToolResult,
} from '../../core/index.js';
import { parseCDeclarations } from '../../metadata/c-declarations/index.js';
import { typeLibraryEdits } from '../../project/annotations/type-library.js';
import { runAnnotationJob } from './annotations.js';
import type { AnalysisScope } from './index.js';

const rejected = (message: string): { readonly rejected: readonly Diagnostic[] } => ({
  rejected: [{ code: 'invalid_input', severity: 'error', message, evidence_ids: [] }],
});

/** Parses C declarations for the image's ABI and commits them as one batch of type
 * library annotations (one revision). Any parse diagnostic rejects the whole batch. */
export async function executeTypesDeclare(
  args: ToolArgs<'types_declare'>,
  scope: AnalysisScope,
): Promise<ToolResult<'types_declare'>> {
  const { store, context } = scope;
  return runAnnotationJob('types_declare', args, scope, async () => {
    const image = store.snapshot().images.find((item) => item.image_id === args.image_id);
    if (!image) return rejected('Image is absent from the current project snapshot');
    const loaded = store.readLoadedImage(image.image_id, image.selected_slice_id);
    context.checkpoint(Math.ceil(args.source.length / 1024));
    const parsed = parseCDeclarations(args.source, { abi: loaded.target.abi });
    if (parsed.diagnostics.length)
      return {
        rejected: parsed.diagnostics.slice(0, 100).map((diagnostic) => ({
          code: 'invalid_input' as const,
          severity: 'error' as const,
          message: `C declarations line ${diagnostic.line}, column ${diagnostic.column}: ${diagnostic.message}`,
          evidence_ids: [],
        })),
      };
    if (!parsed.types.length) return rejected('The C source declares no types');
    const library = typeLibraryIdentity(image.selected_slice_id);
    const { edits, types } = typeLibraryEdits(
      parsed,
      image.selected_slice_id,
      store.readAnnotations(library, store.snapshot().revision),
      args.status,
      context,
    );
    if (!edits.length)
      return rejected('The C source only forward-declares types the library already defines');
    return {
      edits,
      data: (result) => ({
        previous_revision: result.previous_revision,
        revision: result.revision,
        library_id: library,
        types: [...types],
        diagnostics: [],
      }),
    };
  });
}

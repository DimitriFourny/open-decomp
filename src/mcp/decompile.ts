import { REVIEWED_SOURCE_NOTICE, caveats } from '../core/index.js';
import type { ToolResult, WireArtifact } from '../core/index.js';
import { shortIds } from './listing.js';

/** The function a decompilation belongs to, as far as the function index could say. */
export interface FunctionLabel {
  readonly id: string;
  readonly name: string | null;
  readonly entry: { readonly space: string; readonly value: string } | null;
}

type Decompilation = ToolResult<'function_decompile'>;

/** Text-first delivery of a finished decompilation: one line naming the function with its
 * semantic state and reason and a short artifact handle, one line of distinct reader-relevant
 * caveats (see `caveats`), then the pseudocode. Cache state, entity ID, dialect (the code shows
 * it), info diagnostics and everything else (mappings, evidence, inferences, coverage,
 * per-diagnostic messages) stay in the artifact and the `detail:"full"` envelope. */
export function decompileText(
  result: Decompilation,
  label: FunctionLabel,
  artifact: WireArtifact | undefined,
  options: { readonly maxTextBytes: number },
): string | undefined {
  if (!('data' in result)) return undefined;
  const data = result.data;
  const dialect = data.delivery === 'inline' ? data.emission.language : result.options.emitter;
  const comment = dialect === 'python-like' ? '#' : '//';
  const inlineText = data.delivery === 'inline' ? data.emission.text : undefined;
  const tooLarge = inlineText !== undefined && Buffer.byteLength(inlineText) > options.maxTextBytes;
  const withheld =
    data.delivery === 'artifact'
      ? data.delivery_reason
      : tooLarge
        ? ('output_limit' as const)
        : undefined;
  const pseudocode = withheld === undefined ? inlineText : undefined;
  const state = result.state === 'complete' ? 'complete' : 'partial';
  // For an artifact-delivered result, output_limit names the delivery wrapper (stated below),
  // not the analysis; for inline pseudocode it is a real provenance bound.
  const reason =
    result.state === 'partial' && (result.reason !== 'output_limit' || inlineText !== undefined)
      ? result.reason
      : undefined;
  const omitted =
    data.delivery === 'inline' && data.emission.omitted?.length ? data.emission.omitted : undefined;
  const entry = label.entry === null ? null : `${label.entry.space}:${label.entry.value}`;
  const name = label.name ?? shortIds([label.id]).get(label.id)!;
  const notes = [
    ...(omitted === undefined
      ? []
      : [
          `provenance bounded out (${[...new Set(omitted.map((item) => item.reason))].join(', ')}): ${omitted.map((item) => item.kind).join(', ')}; pseudocode is complete`,
        ]),
    ...caveats(result.diagnostics).map((item) => item.text),
  ];
  const reviewed = data.reviewed_source;
  // Reviewed source requested but not delivered: say so beside the decompiler's own caveats.
  if (reviewed === null)
    notes.push(
      result.diagnostics
        .find((item) => item.message.startsWith(REVIEWED_SOURCE_NOTICE))
        ?.message.slice(REVIEWED_SOURCE_NOTICE.length) ??
        'no reviewed source saved for this function',
    );
  const head = [
    `${comment} ${name}${entry === null ? '' : ` @ ${entry}`} | ${state}${reason === undefined ? '' : `(${reason})`}`,
    ...(withheld === undefined || reviewed
      ? []
      : [
          `pseudocode not inlined (${withheld === 'requested' ? 'delivery:artifact requested' : 'exceeds the MCP delivery bound'})`,
        ]),
    ...(artifact ? [shortArtifactId(artifact.id)] : []),
  ].join(' | ');
  const lines = [head];
  if (reviewed) {
    // The reviewed text replaces the pseudocode; the decompiler's caveats describe the latter.
    const marker = reviewed.language === 'python-like' ? '#' : '//';
    lines.push(
      `${marker} reviewed: ${reviewed.author} (${reviewed.origin}) | ${reviewed.stale ? `stale vs ${shortArtifactId(reviewed.base_artifact_id)}` : 'current'}`,
      reviewed.text,
    );
    return lines.join('\n');
  }
  if (notes.length) lines.push(`${comment} caveats: ${notes.join('; ')}`);
  if (pseudocode !== undefined) lines.push(pseudocode);
  return lines.join('\n');
}

/** `artifact_` plus the first 12 hex digits: what `function_get` accepts as `artifact_id`. */
export function shortArtifactId(id: string): string {
  return id.slice(0, id.indexOf('_') + 13);
}

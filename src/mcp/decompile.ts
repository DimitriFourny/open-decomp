import type { ToolResult, WireArtifact } from '../core/index.js';
import { bySeverity, diagnosticLine, shortIds } from './listing.js';

/** The function a decompilation belongs to, as far as the function index could say. */
export interface FunctionLabel {
  readonly id: string;
  readonly name: string | null;
  readonly entry: { readonly space: string; readonly value: string } | null;
}

type Decompilation = ToolResult<'function_decompile'>;

/** Text-first delivery of a finished decompilation: a few comment lines (function, semantic state
 * and reason, each distinct diagnostic once with its count, artifact handle) followed by the
 * pseudocode. Everything else (mappings, evidence, inferences, coverage) stays in the artifact. */
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
  const diagnostics = bySeverity(result.diagnostics);
  const state = result.state === 'complete' ? 'complete' : 'partial';
  // For an artifact-delivered result, output_limit names the delivery wrapper (stated below),
  // not the analysis; for inline pseudocode it is a real provenance bound.
  const reason =
    result.state === 'partial' && (result.reason !== 'output_limit' || inlineText !== undefined)
      ? result.reason
      : undefined;
  const omitted =
    data.delivery === 'inline' && data.emission.omitted?.length
      ? data.emission.omitted.map((item) => item.kind).join(', ')
      : undefined;
  const entry = label.entry === null ? null : `${label.entry.space}:${label.entry.value}`;
  const id = shortIds([label.id]).get(label.id)!;
  const lines = [
    `${comment} ${label.name ?? '(unnamed)'}${entry === null ? '' : ` @ ${entry}`}  ${id}  ${dialect}`,
    `${comment} ${state}${reason === undefined ? '' : ` (${reason})`}; cache ${data.cache}${withheld === undefined ? '' : `; pseudocode not inlined (${withheld === 'requested' ? 'delivery:artifact requested' : 'exceeds the MCP delivery bound'})`}`,
    ...(omitted === undefined
      ? []
      : [`${comment} provenance bounded out (output_limit): ${omitted}; pseudocode is complete`]),
    ...diagnostics.map((item) => `${comment} ! ${diagnosticLine(item)}`),
  ];
  if (artifact)
    lines.push(
      `${comment} artifact_id ${artifact.id} (function_get view:"investigation" with it for per-statement evidence)`,
    );
  if (pseudocode !== undefined) lines.push(pseudocode);
  return lines.join('\n');
}

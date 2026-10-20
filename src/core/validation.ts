import { z } from 'zod';
import { toolSchemas, type ToolName, type ToolArgs, type ToolResult } from './tools.js';
import {
  revisionSchema,
  diagnosticSchema,
  evidenceSchema,
  type Diagnostic,
  type WireDiagnostic,
  type Evidence,
  type WireEvidence,
  versionsSchema,
  targetSchema,
  analysisOptionsSchema,
  budgetSchema,
  digestSchema,
  sliceIdSchema,
  entityIdSchema,
} from './primitives.js';
import { encodeAddress, decodeAddress, encodeRange, decodeRange } from './addresses.js';
import { fingerprint, type CanonicalValue } from './identity.js';

export class RevisionConflict extends Error {
  readonly code = 'stale_revision' as const;
  constructor(
    readonly expected_revision: number,
    readonly current_revision: number,
  ) {
    super(`Expected revision ${expected_revision}, current revision is ${current_revision}`);
    this.name = 'RevisionConflict';
  }
}
export function assertRevision(expected: number, current: number): void {
  revisionSchema.parse(expected);
  revisionSchema.parse(current);
  if (expected !== current) throw new RevisionConflict(expected, current);
}
export function nextRevision(current: number): number {
  revisionSchema.parse(current);
  return revisionSchema.parse(current + 1);
}
/** Parse untrusted input, then enforce snapshot preconditions before work or mutation. */
export function validateToolRequest<K extends ToolName>(
  operation: K,
  input: unknown,
  currentRevision?: number,
): ToolArgs<K> {
  const args = toolSchemas[operation].input.parse(input) as ToolArgs<K>;
  if (currentRevision !== undefined) {
    if ('revision' in args) assertRevision(args.revision, currentRevision);
    if ('expected_revision' in args) assertRevision(args.expected_revision, currentRevision);
  }
  if ('image_id' in args) {
    if ('address' in args && args.address !== undefined && args.address.image_id !== args.image_id)
      throw new TypeError('Address belongs to another image');
    if ('range' in args && args.range !== undefined && args.range.start.image_id !== args.image_id)
      throw new TypeError('Range belongs to another image');
  }
  return args;
}
// Results parsed against their tool output schema by the code that produced them, or built
// only from values so parsed. The same trust domain need not repeat a full-result parse.
const schemaValidated = new WeakSet<object>();
export function markSchemaValidated<T extends object>(value: T): T {
  schemaValidated.add(value);
  return value;
}
export function isSchemaValidated(value: unknown): boolean {
  return typeof value === 'object' && value !== null && schemaValidated.has(value);
}
/** Apply after worker/service completion, before returning data through any transport. */
export function validateToolResponse<K extends ToolName>(
  operation: K,
  output: unknown,
  args: ToolArgs<K>,
): ToolResult<K> {
  const result = toolSchemas[operation].output.parse(output) as ToolResult<K>;
  if ('project_id' in args && result.project_id !== args.project_id)
    throw new TypeError('Result belongs to another project');
  if ('revision' in args && result.revision !== args.revision) {
    const reconciledClose =
      operation === 'project_close' &&
      'running_jobs' in args &&
      args.running_jobs !== 'reject' &&
      result.state === 'complete' &&
      result.revision !== null &&
      result.revision >= args.revision;
    if (!reconciledClose) throw new TypeError('Result belongs to another revision');
  }
  if ('expected_revision' in args && result.state === 'complete') {
    if (result.revision !== nextRevision(args.expected_revision))
      throw new TypeError('Mutation must advance exactly one revision');
  }
  if ('job' in result && result.job.operation !== operation)
    throw new TypeError('Queued job belongs to another operation');
  if (
    'job_id' in args &&
    'data' in result &&
    result.data !== null &&
    typeof result.data === 'object'
  ) {
    const data = result.data as Record<string, unknown>;
    const job = data['job'];
    if (
      job !== null &&
      typeof job === 'object' &&
      'id' in job &&
      'project_id' in job &&
      (job.id !== args.job_id || job.project_id !== args.project_id)
    )
      throw new TypeError('Job result belongs to another job or project');
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > args.budget.output_bytes)
    throw new RangeError(
      'Result exceeds output byte budget; return a bounded continuation or artifact',
    );
  return result;
}
export function encodeDiagnostic(value: Diagnostic): WireDiagnostic {
  const { address, ...rest } = value;
  return diagnosticSchema.parse(
    address === undefined ? rest : { ...rest, address: encodeAddress(address) },
  );
}
export function decodeDiagnostic(value: WireDiagnostic): Diagnostic {
  const { address, ...rest } = diagnosticSchema.parse(value);
  return address === undefined ? rest : { ...rest, address: decodeAddress(address) };
}
export function encodeEvidence(value: Evidence): WireEvidence {
  return evidenceSchema.parse(
    value.origin.kind === 'binary'
      ? { ...value, origin: { ...value.origin, range: encodeRange(value.origin.range) } }
      : value,
  );
}
export function decodeEvidence(value: WireEvidence): Evidence {
  const parsed = evidenceSchema.parse(value);
  return parsed.origin.kind === 'binary'
    ? { ...parsed, origin: { ...parsed.origin, range: decodeRange(parsed.origin.range) } }
    : { ...parsed, origin: parsed.origin };
}
export const cacheIdentitySchema = z.strictObject({
  image_sha256: digestSchema,
  slice_id: sliceIdSchema,
  target: targetSchema,
  versions: versionsSchema,
  evidence_revision: revisionSchema,
  annotation_revision: revisionSchema,
  options: analysisOptionsSchema,
  budget: budgetSchema,
  function_id: entityIdSchema,
});
export function cacheIdentityKey(identity: z.input<typeof cacheIdentitySchema>): string {
  return fingerprint(cacheIdentitySchema.parse(identity) as CanonicalValue);
}

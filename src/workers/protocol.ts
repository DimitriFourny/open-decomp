import { z } from 'zod';
import { artifactReadArgsSchema, artifactReadResultSchema, budgetSchema, diagnosticSchema, imageIdSchema, jobIdSchema, jobSchema, projectIdSchema, revisionSchema, sliceIdSchema, toolNameSchema, toolSchemas, type ToolArgs } from '../core/index.js';

export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGES = 256;
const pathSchema = z.string().min(1).max(32768);
export const importRequestSchema = z.strictObject({ kind: z.literal('import'), source_path: pathSchema, slice_id: sliceIdSchema.nullable().default(null), budget: budgetSchema });
const workerOperationSchema = toolNameSchema.exclude(['project_open', 'project_close', 'analysis_cancel', 'analysis_status']);
export type WorkerOperation = z.output<typeof workerOperationSchema>;
const executeSchema = z.strictObject({ kind: z.literal('execute'), operation: workerOperationSchema, args: z.unknown(), budget: budgetSchema }).superRefine((request, ctx) => {
  const parsed = toolSchemas[request.operation].input.safeParse(request.args);
  if (!parsed.success) ctx.addIssue({ code: 'custom', message: 'Invalid operation arguments' });
  else if (JSON.stringify(parsed.data.budget) !== JSON.stringify(request.budget)) ctx.addIssue({ code: 'custom', message: 'Operation and worker budgets must agree' });
});
export const requestSchema = z.union([importRequestSchema, executeSchema]);
export type ImportRequest = z.output<typeof importRequestSchema>;
export type ExecuteRequest = { [K in WorkerOperation]: { kind: 'execute'; operation: K; args: ToolArgs<K>; budget: z.output<typeof budgetSchema> } }[WorkerOperation];
export type WorkRequest = ImportRequest | ExecuteRequest;
export const snapshotSchema = z.strictObject({ project_id: projectIdSchema, revision: revisionSchema, schema_version: revisionSchema, images: z.array(z.strictObject({ image_id: imageIdSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/), selected_slice_id: sliceIdSchema, state: z.enum(['loaded', 'snapshot_without_metadata']) })).max(MAX_IMAGES) });
export type WorkerSnapshot = z.output<typeof snapshotSchema>;
export type ArtifactReadInput = z.input<typeof artifactReadArgsSchema>;
export type ArtifactReadArgs = z.output<typeof artifactReadArgsSchema>;
export type ArtifactReadResult = z.output<typeof artifactReadResultSchema>;
export const commandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('open'), id: jobIdSchema, path: pathSchema, mode: z.enum(['create', 'resume']), max_queued: z.number().int().min(0).max(1024), interrupted: z.strictObject({ id: jobIdSchema, reason: z.enum(['cancelled', 'deadline']) }).optional() }),
  z.strictObject({ kind: z.literal('admit'), id: jobIdSchema, request: requestSchema, deadline: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal('run'), id: jobIdSchema }),
  z.strictObject({ kind: z.literal('cancel'), id: jobIdSchema }),
  z.strictObject({ kind: z.literal('status'), id: jobIdSchema, job_id: jobIdSchema }),
  z.strictObject({ kind: z.literal('snapshot'), id: jobIdSchema }),
  z.strictObject({ kind: z.literal('artifact_read'), id: jobIdSchema, args: artifactReadArgsSchema }),
  z.strictObject({ kind: z.literal('close'), id: jobIdSchema }),
]);
export type Command = z.output<typeof commandSchema>;
export const eventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('opened'), id: jobIdSchema, snapshot: snapshotSchema }),
  z.strictObject({ kind: z.literal('job'), id: jobIdSchema, job: jobSchema, result: z.unknown().optional() }),
  z.strictObject({ kind: z.literal('progress'), id: jobIdSchema, job: jobSchema }),
  z.strictObject({ kind: z.literal('closed'), id: jobIdSchema }),
  z.strictObject({ kind: z.literal('artifact'), id: jobIdSchema, result: artifactReadResultSchema }),
  z.strictObject({ kind: z.literal('error'), id: jobIdSchema, diagnostic: diagnosticSchema }),
]);
export type WorkerEvent = z.output<typeof eventSchema>;

/** Length is checked before allocating or parsing JSON. No Node IPC deserialization. */
export class FrameDecoder {
  readonly #header = Buffer.alloc(4);
  #headerUsed = 0;
  #body: Buffer | undefined;
  #used = 0;
  constructor(readonly receive: (value: unknown) => void) {}
  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.#body) {
        const count = Math.min(4 - this.#headerUsed, chunk.length - offset);
        chunk.copy(this.#header, this.#headerUsed, offset, offset + count);
        this.#headerUsed += count; offset += count;
        if (this.#headerUsed < 4) continue;
        const size = this.#header.readUInt32BE();
        if (size < 2 || size > MAX_FRAME_BYTES) throw new Error('Invalid worker frame length');
        this.#body = Buffer.allocUnsafe(size); this.#used = 0;
      }
      const count = Math.min(this.#body.length - this.#used, chunk.length - offset);
      chunk.copy(this.#body, this.#used, offset, offset + count);
      this.#used += count; offset += count;
      if (this.#used === this.#body.length) {
        const text = this.#body.toString('utf8');
        this.#body = undefined; this.#headerUsed = 0;
        this.receive(JSON.parse(text) as unknown);
      }
    }
  }
  end(): void { if (this.#headerUsed || this.#body) throw new Error('Truncated worker frame'); }
}
export function frame(value: unknown, maximum = MAX_FRAME_BYTES): Buffer {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('Worker messages must be JSON values');
  const length = Buffer.byteLength(text);
  if (length > maximum || length > MAX_FRAME_BYTES) throw new Error('Worker output exceeds byte limit; return a bounded page or artifact handle');
  const result = Buffer.allocUnsafe(length + 4);
  result.writeUInt32BE(length); result.write(text, 4);
  return result;
}

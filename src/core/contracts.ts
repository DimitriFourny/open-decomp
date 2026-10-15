import type { z } from 'zod';
import type { Address, AddressRange, ImmutableBytes } from './addresses.js';
import type { Budget, Target, Diagnostic, Evidence, Artifact, artifactReadArgsSchema, artifactReadResultSchema, capabilitySchema, coverageSchema, versionsSchema, analysisOptionsSchema } from './primitives.js';
import type { LoadedImage, ImageSlice, Signature, Annotation, AnnotationEdit, RecoveredType, FunctionRecord, StringRecord, ReferenceRecord, SymbolRecord, ImportRecord, ExportRecord, lineageSchema } from './model.js';
import type { DecodedInstruction, DecodeGap, Arm64Payload, X86Payload, RegisterDescriptor, CFGBlock } from './decoder.js';
import type { ToolName, ToolArgs, ToolResult, Job, Emission } from './tools.js';

export interface OperationContext {
  readonly signal: AbortSignal;
  readonly budget: Budget;
  /** Implementations must charge actual work and throw a typed resource-limit/cancel error. */
  checkpoint(work: number): void;
  progress(phase: string, completed: number, total: number | null): void;
}
export interface ComponentIdentity { readonly name: string; readonly version: string }
export interface Loader extends ComponentIdentity {
  readonly format: Target['format'];
  inspect(bytes: ImmutableBytes, imageId: string, context: OperationContext): { readonly slices: readonly ImageSlice[]; readonly diagnostics: readonly Diagnostic[] };
  /** A missing selection is valid only if exactly one supported slice exists. */
  load(input: { readonly image_id: string; readonly sha256: string; readonly bytes: ImmutableBytes; readonly slice_id: string | null }, context: OperationContext): LoadedImage;
}
export interface DecodeRequest {
  readonly image: LoadedImage; readonly regions: readonly AddressRange[];
  readonly features: readonly string[]; readonly mode: 'a64' | 'long64';
}
export interface DecodeResult {
  readonly instructions: readonly DecodedInstruction[]; readonly gaps: readonly DecodeGap[];
  readonly coverage: z.infer<typeof coverageSchema>; readonly diagnostics: readonly Diagnostic[];
}
export interface Decoder extends ComponentIdentity {
  readonly architecture: Target['architecture'];
  decode(request: DecodeRequest, context: OperationContext): DecodeResult;
  format?(instruction: DecodedInstruction): { readonly mnemonic: string; readonly operands: string };
  dispose(): void;
}
/** Discovery owns block boundaries. Calls are reference edges, not intraprocedural successors. */
export interface FunctionGraph {
  readonly function: FunctionRecord;
  readonly slice_id: string;
  readonly blocks: readonly CFGBlock[];
  readonly instructions: readonly DecodedInstruction[];
  readonly gaps: readonly DecodeGap[];
  readonly coverage: z.infer<typeof coverageSchema>;
  readonly diagnostics: readonly Diagnostic[];
}
/** T04 supplies RegisterIR. Core does not define semantic operations or strings masquerading as IR. */
export interface Lifter<RegisterIR> extends ComponentIdentity {
  readonly architecture: Target['architecture'];
  lift(graph: FunctionGraph, abi: AbiProfile, context: OperationContext): {
    readonly ir: RegisterIR; readonly coverage: z.infer<typeof coverageSchema>; readonly diagnostics: readonly Diagnostic[];
  };
}
export type ArchitecturePayload = { readonly arm64: Arm64Payload; readonly x86_64: X86Payload };

export interface DataLayout {
  readonly endian: 'little'; readonly pointer_bits: 64;
  readonly char_bits: 8; readonly short_bits: 16; readonly int_bits: 32; readonly long_bits: 32 | 64; readonly long_long_bits: 64;
  readonly float_bits: 32; readonly double_bits: 64; readonly long_double_bits: 64 | 128;
  readonly stack_alignment: number; readonly aggregate_max_alignment: number;
}
/** Resolved source layouts for ABI classification, not a second semantic IR type system. */
export type AbiType =
  | { readonly kind: 'void' }
  | { readonly kind: 'integer'; readonly bits: number; readonly signed: boolean }
  | { readonly kind: 'float'; readonly bits: 16 | 32 | 64 | 128 }
  | { readonly kind: 'pointer' }
  | { readonly kind: 'vector'; readonly element: 'integer' | 'float'; readonly element_bits: number; readonly lanes: number }
  | { readonly kind: 'aggregate'; readonly size: bigint; readonly alignment: number; readonly fields: readonly { readonly offset: bigint; readonly type: AbiType }[]; readonly trivial_for_abi?: boolean }
  | { readonly kind: 'unknown'; readonly size: bigint | null };
export type AbiLocation =
  | { readonly kind: 'register'; readonly register: RegisterDescriptor; readonly value_offset_bits: number; readonly width_bits: number }
  | { readonly kind: 'stack'; readonly offset: bigint; readonly size: bigint; readonly alignment: number; readonly value_offset_bits: number }
  | { readonly kind: 'indirect'; readonly pointer: RegisterDescriptor | { readonly stack_offset: bigint }; readonly size: bigint; readonly alignment: number };
export interface CallClobbers {
  readonly registers: readonly RegisterDescriptor[];
  readonly flags: readonly RegisterDescriptor[];
  readonly memory: 'unknown_read_write' | 'read_only' | 'none';
}
export interface AbiCallLayout {
  readonly parameters: readonly { readonly index: number; readonly locations: readonly AbiLocation[] }[];
  readonly returns: readonly AbiLocation[]; readonly hidden_result: AbiLocation | null;
  readonly stack_bytes: bigint; readonly shadow_space: bigint; readonly stack_alignment: number;
  readonly clobbers: CallClobbers; readonly diagnostics: readonly Diagnostic[];
  readonly state: 'complete' | 'partial' | 'unsupported';
}
/** Explicit ABI input. Omitted convention/prototyped flags mean the ordinary prototyped C ABI. */
export interface AbiSignature {
  readonly returns: AbiType;
  /** null preserves an unknown argument count; an empty list is a known zero-argument list. */
  readonly parameters: readonly AbiType[] | null;
  readonly variadic: boolean;
  readonly fixed_parameter_count: number;
  readonly calling_convention?: 'default' | 'vectorcall' | 'member_function' | 'unknown';
  readonly prototyped?: boolean;
}
export interface AbiProfile extends ComponentIdentity {
  readonly id: Target['abi']; readonly architecture: Target['architecture']; readonly layout: DataLayout;
  readonly stack_pointer: RegisterDescriptor; readonly preserved: readonly RegisterDescriptor[];
  readonly unknown_call_clobbers: CallClobbers;
  classifyCall(signature: AbiSignature): AbiCallLayout;
}
export interface Emitter<Presentation> extends ComponentIdentity {
  readonly language: 'c-like';
  emit(presentation: Presentation, options: z.infer<typeof analysisOptionsSchema>, context: OperationContext): Emission;
}

export interface CacheIdentity {
  readonly image_sha256: string; readonly slice_id: string; readonly target: Target;
  readonly versions: z.infer<typeof versionsSchema>; readonly evidence_revision: number; readonly annotation_revision: number;
  readonly options: z.infer<typeof analysisOptionsSchema>; readonly budget: Budget; readonly function_id: string;
}
export interface ProjectSnapshot {
  readonly project_id: string; readonly revision: number; readonly schema_version: number;
  readonly images: readonly { readonly image_id: string; readonly sha256: string; readonly selected_slice_id: string }[];
}
export interface AnnotationBatch {
  readonly expected_revision: number; readonly author: string; readonly origin: 'user' | 'llm'; readonly edits: readonly AnnotationEdit[];
}
export type AnnotationActor = Pick<Annotation, 'author' | 'origin'>;
export interface AnnotationQuery {
  readonly revision: number; readonly ids?: readonly string[]; readonly entity_ids?: readonly string[];
  readonly limit: number; readonly cursor?: string;
}
export interface AnnotationHistoryQuery {
  readonly id: string; readonly revision: number; readonly limit: number; readonly cursor?: string;
}
export interface AnnotationHistoryEntry {
  readonly id: string; readonly entity_id: string; readonly revision: number;
  readonly operation: 'set' | 'retract' | 'remove'; readonly annotation: Annotation | null;
  /** Schema-1 removal actors were not recorded; migration must not invent them. */
  readonly actor: AnnotationActor | null;
}
export type MutationResult =
  | { readonly state: 'committed'; readonly previous_revision: number; readonly revision: number; readonly annotations: readonly Annotation[]; readonly removed: readonly string[]; readonly invalidate_before_revision: number }
  | { readonly state: 'conflict'; readonly expected_revision: number; readonly current_revision: number }
  | { readonly state: 'rejected'; readonly diagnostics: readonly Diagnostic[] };
export interface StoredRecordKinds {
  readonly function: FunctionRecord; readonly string: StringRecord; readonly reference: ReferenceRecord;
  readonly symbol: SymbolRecord; readonly import: ImportRecord; readonly export: ExportRecord;
}
export interface RecordQuery<K extends keyof StoredRecordKinds> {
  readonly kind: K; readonly revision: number; readonly image_id: string;
  readonly ids?: readonly string[]; readonly text?: string; readonly address?: Address;
  readonly limit: number; readonly cursor?: string;
}
export interface StoreTransaction {
  /** Immutable facts never become annotations and cannot be overwritten by a rename. */
  putImage(image: LoadedImage): void;
  putEvidence(evidence: Evidence): void;
  putType(id: string, definition: RecoveredType, evidenceIds: readonly string[]): void;
  putSignature(functionId: string, signature: Signature): void;
  putLineage(change: z.infer<typeof lineageSchema>): void;
  putRecord<K extends keyof StoredRecordKinds>(imageId: string, kind: K, record: StoredRecordKinds[K]): void;
  setIndexState(imageId: string, kind: keyof StoredRecordKinds, state: 'complete' | 'partial' | 'not_started'): void;
  setAnnotation(annotation: Annotation): void;
  removeAnnotation(id: string, actor: AnnotationActor): void;
}
export interface ProjectStore {
  readonly project_id: string;
  snapshot(revision?: number): ProjectSnapshot;
  importImage(input: { readonly bytes: ImmutableBytes; readonly sha256: string; readonly selected_slice_id: string }): Promise<{ readonly image_id: string; readonly existing: boolean }>;
  readImage(imageId: string): ImmutableBytes;
  readLoadedImage(imageId: string, sliceId: string, revision?: number): LoadedImage;
  queryRecords<K extends keyof StoredRecordKinds>(query: RecordQuery<K>): {
    readonly items: readonly StoredRecordKinds[K][]; readonly next_cursor: string | null; readonly index_state: 'complete' | 'partial' | 'not_started';
  };
  /** Roll back on throw; successful mutation advances exactly once. No await inside a transaction. */
  transaction(expectedRevision: number, mutate: (transaction: StoreTransaction) => void): MutationResult;
  applyAnnotations(batch: AnnotationBatch): MutationResult;
  readAnnotations(entityId: string, revision: number): readonly Annotation[];
  /** Latest nonremoved versions at the requested snapshot, including retracted assertions. */
  queryAnnotations(query: AnnotationQuery): { readonly items: readonly Annotation[]; readonly next_cursor: string | null };
  queryAnnotationHistory(query: AnnotationHistoryQuery): { readonly items: readonly AnnotationHistoryEntry[]; readonly next_cursor: string | null };
  readEvidence(ids: readonly string[], revision: number): readonly Evidence[];
  readType(id: string, revision: number): { readonly definition: RecoveredType; readonly evidence_ids: readonly string[] } | null;
  readSignature(functionId: string, revision: number): Signature | null;
  readLineage(entityId: string, revision: number): readonly z.infer<typeof lineageSchema>[];
  findArtifact(identity: CacheIdentity): Artifact | null;
  /** Atomic publication verifies the job is not cancelled and the input revision is still current. */
  publishArtifact(input: { readonly job_id: string; readonly expected_revision: number; readonly media_type: string; readonly bytes: Uint8Array; readonly cache: CacheIdentity }): Promise<{ readonly state: 'published'; readonly artifact: Artifact } | { readonly state: 'stale' | 'cancelled'; readonly current_revision: number }>;
  readArtifact(input: z.infer<typeof artifactReadArgsSchema>): Promise<z.infer<typeof artifactReadResultSchema>>;
  saveJob(job: Job): void;
  readJob(jobId: string): Job | null;
  /** Live job lifecycle view in stable ID order; cursors bind the current project revision. */
  listJobs(query: { readonly limit: number; readonly cursor?: string }): { readonly items: readonly Job[]; readonly next_cursor: string | null };
  close(): Promise<void>;
}
export interface StoreFactory {
  /** Authorized, canonical paths are supplied by the host; newer schemas fail without mutation. */
  open(path: string, mode: 'create' | 'resume'): Promise<ProjectStore>;
}
export interface ServiceContext { readonly signal: AbortSignal; readonly authorized_roots: readonly string[] }
export interface AnalysisService {
  execute<K extends ToolName>(operation: K, args: ToolArgs<K>, context: ServiceContext): Promise<ToolResult<K>>;
  readArtifact(args: z.infer<typeof artifactReadArgsSchema>, context: ServiceContext): Promise<z.infer<typeof artifactReadResultSchema>>;
}
/** Coarse operations only: no per-instruction RPC and no arbitrary SQL/code payload. */
export type WorkerCommand = { [K in ToolName]: { readonly kind: 'execute'; readonly request_id: string; readonly operation: K; readonly args: ToolArgs<K> } }[ToolName]
  | { readonly kind: 'shutdown'; readonly request_id: string; readonly project_id: string; readonly running_jobs: 'wait' | 'cancel' | 'reject' };
export type WorkerEvent = { [K in ToolName]: { readonly kind: 'result'; readonly request_id: string; readonly operation: K; readonly result: ToolResult<K> } }[ToolName]
  | { readonly kind: 'progress'; readonly request_id: string; readonly job: Job }
  | { readonly kind: 'failure'; readonly request_id: string; readonly diagnostic: Diagnostic };
export interface WorkerPool {
  readonly max_workers: number; readonly max_queued: number;
  execute<K extends ToolName>(operation: K, args: ToolArgs<K>, signal: AbortSignal): Promise<ToolResult<K>>;
  close(): Promise<void>;
}
export interface FunctionDiscoverySeed { readonly address: Address; readonly evidence_ids: readonly string[]; readonly source: 'entry' | 'symbol' | 'export' | 'function_hint' | 'unwind' | 'call' | 'assertion' }
export interface ComponentRegistry<RegisterIR, Presentation> {
  readonly loaders: readonly Loader[]; readonly decoders: readonly Decoder[]; readonly lifters: readonly Lifter<RegisterIR>[];
  readonly abis: readonly AbiProfile[]; readonly emitters: readonly Emitter<Presentation>[];
  readonly capabilities: readonly z.infer<typeof capabilitySchema>[];
}

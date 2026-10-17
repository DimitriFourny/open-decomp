import type { CacheIdentity, Evidence, ResultMetadata, ToolResult } from '../../core/index.js';
import type { SuppliedTypeRecord } from '../../analysis/types/index.js';
import type { AnnotationSubject } from '../annotations/index.js';
import type { AnalysisReadset } from './dependencies.js';

export const ANALYSIS_ARTIFACT_VERSION = 1;
export const ANALYSIS_ARTIFACT_MEDIA_TYPE = 'application/vnd.open-decomp.function+json';
export const MAX_ANALYSIS_ARTIFACT_BYTES = 16 * 1024 * 1024;

export type InlineDecompileData = Extract<
  Extract<ToolResult<'function_decompile'>, { data: unknown }>['data'],
  { delivery: 'inline' }
>;
/** Full semantic result. Output-limited delivery is a separate envelope pointing here;
 * neither a shortened emission nor a self-referencing artifact handle is stored here. */
export type StoredDecompilation = ResultMetadata &
  (
    | { readonly state: 'complete'; readonly data: InlineDecompileData }
    | {
        readonly state: 'partial';
        readonly reason: 'budget' | 'incomplete_index' | 'unsupported_subset';
        readonly continuation: null;
        readonly data: InlineDecompileData;
      }
  );

export interface AnalysisCatalogData {
  readonly subjects: readonly AnnotationSubject[];
  readonly types: readonly SuppliedTypeRecord[];
  readonly evidence: readonly Evidence[];
}
export interface AnalysisComputation {
  readonly result: StoredDecompilation;
  readonly catalog: AnalysisCatalogData;
  /** Absent on pre-ledger artifacts; those are exact-revision-only. */
  readonly dependencies?: AnalysisReadset;
}
export interface AnalysisArtifactPayload extends AnalysisComputation {
  readonly format_version: typeof ANALYSIS_ARTIFACT_VERSION;
  readonly identity: CacheIdentity;
}

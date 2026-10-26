import type {
  CacheIdentity,
  Evidence,
  ResultMetadata,
  ReviewedSource,
  ToolResult,
} from '../../core/index.js';
import type { SuppliedTypeRecord } from '../../analysis/types/index.js';
import type { AnnotationSubject } from '../annotations/index.js';
import type { AnalysisReadset } from './dependencies.js';

export const ANALYSIS_ARTIFACT_VERSION = 2;
export const ANALYSIS_ARTIFACT_MEDIA_TYPE = 'application/vnd.open-decomp.function+json';
export const MAX_ANALYSIS_ARTIFACT_BYTES = 16 * 1024 * 1024;

export type InlineDecompileData = Extract<
  Extract<ToolResult<'function_decompile'>, { data: unknown }>['data'],
  { delivery: 'inline' }
>;
/** The reviewed source delivered beside a decompilation (`null`: none applies), with the info
 * diagnostics explaining a null caused by conflicting or unasserted reviewed sources. */
export interface ReviewedSourceLookup {
  readonly reviewed_source: ReviewedSource | null;
  readonly diagnostics: ResultMetadata['diagnostics'];
}
/** Full semantic result. Output-limited delivery is a separate envelope pointing here;
 * neither a shortened emission nor a self-referencing artifact handle is stored here. */
export type StoredDecompilation = ResultMetadata &
  (
    | { readonly state: 'complete'; readonly data: InlineDecompileData }
    | {
        readonly state: 'partial';
        /** `output_limit` here means only provenance metadata was bounded out of the
         * emission (named by `emission.omitted`); the text is whole. */
        readonly reason: 'budget' | 'incomplete_index' | 'unsupported_subset' | 'output_limit';
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

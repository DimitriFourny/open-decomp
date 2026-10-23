import { z } from 'zod';
import {
  fingerprint,
  type AbiProfile,
  type FunctionRecord,
  type OperationContext,
  type ProjectStore,
} from '../../core/index.js';
import { createCallResultDemandIndex } from '../../analysis/calls/result-demands.js';
import type { SSAForm } from '../../ir/index.js';
import { verifyTracedReads, type TracedRead } from '../../project/cache/dependencies.js';
import { createNativeInterfaceIndex } from './native-entry.js';
import type { NativePreparationInput, PreparedNativeUnit } from './native-prepare.js';
import type { NativeDependency } from './native-worklist.js';

/** Bump when the stored shape of a prepared unit changes. */
const NATIVE_SUMMARY_FORMAT = 7;

/** A prepared callee body kept for reuse, with exactly what reusing it must replay. */
export interface PreparedUnitEntry {
  /** Without `dependency_readset`, which is a snapshot of the preparing request. */
  readonly unit: PreparedNativeUnit;
  /** Work the preparation charged to its worklist context. */
  readonly work: number;
  /** Reads the preparation made; absent when it ran without a dependency collector. */
  readonly trace?: readonly TracedRead[];
  /** Smallest worklist allowance under which preparation provably returns this unit. */
  readonly allowance: number;
  readonly size: number;
  /** The allowance of the persisted row this entry equals, when one exists. */
  stored?: number;
}

/** Retained prepared size (instructions + IR nodes + evidence + traced reads). */
export const preparedSize = (unit: PreparedNativeUnit, trace?: readonly TracedRead[]): number =>
  unit.instructions + unit.nodes + unit.evidence.length + (trace?.length ?? 0);

/** The second tier of the prepared-unit cache: the project's persisted summaries. */
export interface NativeUnitPersistence {
  /** A stored unit equal to what preparing `fn` here would return, or undefined. Checking it
   * charges nothing but observes the cancellation and deadline of `context`, the loading
   * request's (never the request that created this tier, whose deadline may have passed). */
  load(fn: FunctionRecord, context: OperationContext): PreparedUnitEntry | undefined;
  /** Queue `entry` for the request's next batched write. */
  save(fn: FunctionRecord, entry: PreparedUnitEntry): void;
  /** Queue a marker row for `fn`: the open-time job prepared it and kept nothing (the unit is
   * not retained), so a later open need not prepare it again. A marker is never a unit (every
   * load misses it) and any saved unit replaces it. */
  skip(fn: FunctionRecord): void;
}

type StoredUnit = Omit<PreparedNativeUnit, 'function' | 'dependencies' | 'analysis'> & {
  readonly analysis: PreparedNativeUnit['analysis'];
};
interface StoredDependency extends Omit<NativeDependency, 'target'> {
  readonly target_id: string;
}
interface StoredSummary {
  readonly format: number;
  readonly scope: string;
  readonly function: string;
  readonly revision: number;
  readonly unit: StoredUnit;
  /** `analysis` is the very object of `types.calls` (stored once). */
  readonly analysis_in_types: boolean;
  readonly dependencies: readonly StoredDependency[];
  readonly trace: unknown;
}

const count = z.number().int().nonnegative();
/** The envelope only: IR, types and evidence were validated when produced and are guarded by the
 * row digest, the identity fields and the re-verified dependency trace. */
const storedSummarySchema = z.object({
  format: z.literal(NATIVE_SUMMARY_FORMAT),
  scope: z.string(),
  function: z.string(),
  revision: count,
  analysis_in_types: z.boolean(),
  dependencies: z.array(z.looseObject({ target_id: z.string() })),
  trace: z.unknown(),
  unit: z.looseObject({
    instructions: count,
    blocks: count,
    nodes: count,
    required_nodes: count,
    evidence: z.array(z.unknown()),
    evidence_ids: z.array(z.string()),
    reasons: z.array(z.string()),
    budget_truncated: z.literal(false),
    limited: z.literal(false),
    observed_calls: z.array(z.unknown()),
    ir: z.looseObject({ form: z.literal('ssa'), id: z.string() }),
    types: z.looseObject({ calls: z.unknown() }),
    analysis: z.unknown(),
  }),
});

/** The persisted rows' scope of one `preparedUnitIdentity`. */
export const nativeSummaryScope = (identity: string): string =>
  fingerprint(['native-summary', NATIVE_SUMMARY_FORMAT, identity]);

/** A marker row's allowance: above every load's, so a stored unit always replaces it. */
export const NATIVE_SUMMARY_MARKER_ALLOWANCE = Number.MAX_SAFE_INTEGER;

/** Reads and writes prepared units of one image revision in the project store. Identity
 * (`scope`) names the revision, image slice, target, component versions, ABI/lifter and the
 * supplied native types, so a stored unit is only ever offered for exactly the state it was
 * prepared in; every dependency read is checked against the store again before use. */
export function createNativeUnitPersistence(
  input: NativePreparationInput,
  identity: string,
): NativeUnitPersistence | undefined {
  const { scope, revision } = input;
  if (scope.analysis_cache === false) return undefined;
  // Reads go to the project itself, never through the request's dependency recorder.
  const store: ProjectStore = scope.dependencies?.source ?? scope.store;
  if (
    typeof store.readNativeSummary !== 'function' ||
    typeof store.queueNativeSummary !== 'function'
  )
    return undefined;
  const key = nativeSummaryScope(identity);
  const abi: AbiProfile = input.components.abi;
  const missing = new Set<string>();
  let byId: ReadonlyMap<string, FunctionRecord> | undefined;
  const quiet = (context: OperationContext): OperationContext => ({
    ...context,
    checkpoint: () => context.checkpoint(0),
  });

  const load = (fn: FunctionRecord, context: OperationContext): PreparedUnitEntry | undefined => {
    if (missing.has(fn.id)) return undefined;
    const row = store.readNativeSummary(key, fn.id);
    const entry = row
      ? rebuild(row.value, row.revision, row.allowance, row.work, fn, quiet(context))
      : undefined;
    if (!entry) missing.add(fn.id);
    return entry;
  };

  const rebuild = (
    value: unknown,
    rowRevision: number,
    allowance: number,
    work: number,
    fn: FunctionRecord,
    context: OperationContext,
  ): PreparedUnitEntry | undefined => {
    if (
      rowRevision !== revision ||
      !count.safeParse(allowance).success ||
      !count.safeParse(work).success ||
      !storedSummarySchema.safeParse(value).success
    )
      return undefined;
    const stored = value as StoredSummary;
    if (stored.scope !== key || stored.function !== fn.id || stored.revision !== revision)
      return undefined;
    const unit = stored.unit;
    const ir = unit.ir as SSAForm;
    if (ir.id !== fn.id) return undefined;
    const types = unit.types as PreparedNativeUnit['types'];
    const callAnalysis = (
      stored.analysis_in_types ? types?.calls : unit.analysis
    ) as PreparedNativeUnit['analysis'];
    if (callAnalysis?.state !== 'complete') return undefined;
    byId ??= new Map(input.functions.map((record) => [record.id, record]));
    const dependencies: NativeDependency[] = [];
    for (const dependency of stored.dependencies) {
      const target = byId.get(dependency.target_id);
      if (!target) return undefined;
      const { target_id: _id, ...rest } = dependency;
      dependencies.push({ ...rest, target });
    }
    if (!verifyTracedReads(store, revision, stored.trace, context)) return undefined;
    const trace = stored.trace as readonly TracedRead[];
    const prepared: PreparedNativeUnit = {
      ...(unit as Omit<PreparedNativeUnit, 'function' | 'dependencies' | 'analysis'>),
      function: fn,
      dependencies,
      analysis: callAnalysis,
      demand_index: createCallResultDemandIndex(ir, abi, context),
      interface_index: createNativeInterfaceIndex(ir, abi, context),
    };
    return {
      unit: prepared,
      work,
      trace,
      allowance,
      size: preparedSize(prepared, trace),
      stored: allowance,
    };
  };

  const save = (fn: FunctionRecord, entry: PreparedUnitEntry): void => {
    if (!entry.trace) return;
    const {
      function: _function,
      dependencies,
      analysis,
      demand_index: _demand,
      interface_index: _interface,
      dependency_readset: _readset,
      ...rest
    } = entry.unit;
    const analysisInTypes = analysis !== null && analysis === rest.types?.calls;
    const summary: StoredSummary = {
      format: NATIVE_SUMMARY_FORMAT,
      scope: key,
      function: fn.id,
      revision,
      unit: { ...rest, analysis: analysisInTypes ? null : analysis },
      analysis_in_types: analysisInTypes,
      dependencies: dependencies.map(({ target, ...others }) => ({
        ...others,
        target_id: target.id,
      })),
      trace: entry.trace,
    };
    if (
      store.queueNativeSummary({
        scope: key,
        function_id: fn.id,
        revision,
        allowance: entry.allowance,
        work: entry.work,
        value: summary,
        weight: entry.size,
      })
    ) {
      entry.stored = entry.allowance;
      missing.delete(fn.id);
    }
  };

  const skip = (fn: FunctionRecord): void => {
    store.queueNativeSummary({
      scope: key,
      function_id: fn.id,
      revision,
      allowance: NATIVE_SUMMARY_MARKER_ALLOWANCE,
      work: 0,
      value: { format: NATIVE_SUMMARY_FORMAT, scope: key, function: fn.id, marker: true },
    });
  };

  return { load, save, skip };
}

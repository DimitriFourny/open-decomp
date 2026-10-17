import {
  OperationError,
  SCHEMA_VERSION,
  encodeDiagnostic,
  encodeEmission,
  encodeEvidence,
  fingerprint,
  signatureSchema,
  toolSchemas,
  type CacheIdentity,
  type CanonicalValue,
  type Diagnostic,
  type OperationContext,
  type ProjectStore,
  type ResultMetadata,
  type Signature,
  type ToolArgs,
  type ToolResult,
} from '../../core/index.js';
import { constructSSA } from '../../analysis/ssa/index.js';
import { simplifySSA } from '../../analysis/values/index.js';
import {
  recoverTypes,
  type SuppliedSignature,
  type SuppliedTypeRecord,
} from '../../analysis/types/index.js';
import { recoverDebugInfo } from '../../metadata/debug/index.js';
import { recoverLibraryContracts } from '../../metadata/library-contracts/index.js';
import { structureControlFlow } from '../../presentation/index.js';
import { emitC } from '../../emitters/c/index.js';
import { emitPythonLike } from '../../emitters/python-like/index.js';
import {
  AnnotationService,
  createTrustedSemanticCatalog,
} from '../../project/annotations/index.js';
import { typeReferences } from '../../project/annotations/subjects.js';
import {
  MAX_ANALYSIS_ARTIFACT_BYTES,
  runCachedDecompilation,
  type AnalysisComputation,
  type StoredDecompilation,
} from '../../project/cache/index.js';
import { loadFunctionGraph, loadFunctionScope, records } from '../queries/scope.js';
import { MAX_FRAME_BYTES } from '../../workers/protocol.js';
import { callDeclarations, resolveCalls } from './calls.js';
import { closeEvidence, evidenceReferences, semanticCatalog } from './catalog.js';
import { pipelineComponents, pipelineVersions } from './versions.js';
import { boundIR, requirePass } from './passes.js';
import { recoverSourceEvidence } from './source-facts.js';
export { executeAnnotations } from './annotations.js';

export interface AnalysisScope {
  readonly store: ProjectStore;
  readonly context: OperationContext;
  readonly job_id: string;
  readonly max_result_bytes?: number;
}

export async function executeDecompilation(
  args: ToolArgs<'function_decompile'>,
  scope: AnalysisScope,
): Promise<ToolResult<'function_decompile'>> {
  const { store, context } = scope;
  if (args.project_id !== store.project_id)
    throw new OperationError({
      code: 'permission_denied',
      severity: 'error',
      message: 'Decompilation request belongs to another project',
      evidence_ids: [],
    });
  context.checkpoint(0);
  const loaded = loadFunctionScope(scope, args.revision, args.function_id),
    image = loaded.image;
  const components = pipelineComponents(image.target);
  const identity: CacheIdentity = {
    image_sha256: image.sha256,
    slice_id: image.selected_slice_id,
    target: image.target,
    versions: pipelineVersions(image.target, args.options.emitter),
    evidence_revision: args.revision,
    annotation_revision: args.revision,
    function_id: args.function_id,
    options: args.options,
    // The worker context has a reduced remaining deadline. It is NOT the request.
    budget: args.budget,
  };
  return runCachedDecompilation(
    {
      ...scope,
      identity,
      inline_limit: Math.min(
        args.budget.output_bytes,
        scope.max_result_bytes ?? Infinity,
        MAX_FRAME_BYTES - 16384,
      ),
    },
    (): AnalysisComputation => {
      // Only output capacity changes. All stages charge the same cumulative clock,
      // work counter, cancellation signal, node/block limits and progress channel.
      const fullContext: OperationContext = {
        ...context,
        budget: { ...context.budget, output_bytes: MAX_ANALYSIS_ARTIFACT_BYTES },
        checkpoint: (work) => context.checkpoint(work),
        progress: (phase, completed, total) => context.progress(phase, completed, total),
      };
      context.progress('decode', 0, 7);
      const graph = loadFunctionGraph(scope, args.revision, loaded);
      if (graph.gaps.some((gap) => gap.reason === 'budget'))
        throw new OperationError({
          code: 'resource_limit',
          severity: 'error',
          message:
            'Instruction budget ended before the function graph was complete; no analysis was published',
          evidence_ids: [],
        });
      context.progress('lift', 1, 7);
      const lifted = components.lifter.lift(graph, components.abi, context);
      let requiredNodes = boundIR(lifted.ir, context);
      const passOptions = {
        max_work: context.budget.work,
        max_ir_nodes: context.budget.ir_nodes,
        max_blocks: context.budget.blocks,
        checkpoint: (work: number) => context.checkpoint(work),
      };
      context.progress('ssa', 2, 7);
      const constructed = constructSSA(lifted.ir, passOptions);
      requirePass(constructed.state, constructed.diagnostics, context);
      if (constructed.value.form !== 'ssa')
        throw new OperationError({
          code: 'internal_error',
          severity: 'error',
          message: 'SSA conversion returned register form',
          evidence_ids: [],
        });
      requiredNodes = Math.max(requiredNodes, boundIR(constructed.value, context));
      const simplified = simplifySSA(constructed.value, passOptions);
      requirePass(simplified.state, simplified.diagnostics, context);
      const ir = simplified.value;
      requiredNodes = Math.max(requiredNodes, boundIR(ir, context));
      context.progress('metadata', 3, 7);
      const debug = recoverDebugInfo(image, fullContext);
      const library = recoverLibraryContracts(
        { image, abi: components.abi, revision: args.revision },
        fullContext,
      );
      const functions = records(scope, args.revision, image.id, 'function').items;
      const references = records(scope, args.revision, image.id, 'reference').items;
      const calls = resolveCalls(
        ir,
        image,
        functions,
        references,
        args.options.indirect_targets === 'bounded',
        context,
      );
      const nativeTypes: SuppliedTypeRecord[] = [
        ...debug.types.map((type) => ({
          ...type,
          source: 'debug' as const,
          status: 'established' as const,
        })),
        ...library.types.map((type) => ({
          ...type,
          source: 'library' as const,
          status: 'established' as const,
        })),
      ];
      const nativeSignatures: SuppliedSignature[] = [];
      const durableSignature = store.readSignature(ir.id, args.revision);
      if (durableSignature) {
        nativeSignatures.push({
          id: ir.id,
          subject_id: ir.id,
          signature: durableSignature,
          source: 'analysis',
          status: 'established',
          evidence_ids: durableSignature.evidence_ids,
        });
        const pending = [
            durableSignature.return_type,
            ...durableSignature.parameters.map((parameter) => parameter.type_id),
          ],
          seen = new Set(nativeTypes.map((type) => type.id));
        for (let offset = 0; offset < pending.length; offset++) {
          context.checkpoint(1);
          const id = pending[offset]!;
          if (seen.has(id)) continue;
          seen.add(id);
          const type = store.readType(id, args.revision);
          if (!type)
            throw new OperationError({
              code: 'internal_error',
              severity: 'error',
              message: 'Durable signature references a missing source type',
              evidence_ids: [],
            });
          nativeTypes.push({ id, ...type, source: 'analysis', status: 'established' });
          pending.push(...typeReferences(type.definition));
        }
      }
      const nativeCalls = callDeclarations(
        ir,
        image,
        args.revision,
        calls,
        debug,
        [],
        nativeTypes,
        context,
        components.abi.layout,
      );
      const options = {
        image_id: image.id,
        slice_id: image.selected_slice_id,
        revision: args.revision,
        entry_address: loaded.function.entry,
        debug,
        library,
        max_work: context.budget.work,
        resolutions: calls.resolutions,
      };
      context.progress('types', 4, 7);
      const baseline = recoverTypes(ir, components.abi, fullContext, {
        ...options,
        types: nativeTypes,
        signatures: [...nativeSignatures, ...nativeCalls.signatures],
        contracts: nativeCalls.contracts,
      });
      const baselineFailure = baseline.diagnostics.find(
        (item) => item.code === 'cancelled' || item.code === 'resource_limit',
      );
      if (baselineFailure) throw new OperationError(baselineFailure);
      const baselineCatalog = semanticCatalog(image, ir, baseline, context);
      const trusted = createTrustedSemanticCatalog(
        store,
        args.revision,
        { ...baselineCatalog, evidence: [...baseline.evidence, ...nativeCalls.evidence] },
        fullContext,
      );
      const selected = new Set([
        ...baselineCatalog.subjects.map((subject) => subject.id),
        ...calls.subjects,
      ]);
      const annotationService = new AnnotationService(store);
      let active = annotationService.active(args.revision, fullContext, {
        catalog: trusted,
        entity_ids: [...selected],
      });
      let expanded = false;
      for (const type of active.types) {
        if (!selected.has(type.id)) {
          selected.add(type.id);
          expanded = true;
        }
        if (type.definition.kind === 'structure')
          for (const field of type.definition.fields)
            if (!selected.has(field.id)) {
              selected.add(field.id);
              expanded = true;
            }
      }
      if (expanded)
        active = annotationService.active(args.revision, fullContext, {
          catalog: trusted,
          entity_ids: [...selected],
        });
      const asserted = active.annotations.some(
        (annotation) => annotation.value.kind === 'type' || annotation.value.kind === 'signature',
      );
      const suppliedCalls = asserted
        ? callDeclarations(
            ir,
            image,
            args.revision,
            calls,
            debug,
            active.annotations,
            [...nativeTypes, ...active.types],
            context,
            components.abi.layout,
          )
        : nativeCalls;
      const externalSubjects = new Set(calls.subjects.filter((id) => id !== ir.id));
      const localSubjects = new Set([...selected].filter((id) => !externalSubjects.has(id)));
      const types = asserted
        ? recoverTypes(ir, components.abi, fullContext, {
            ...options,
            types: [...nativeTypes, ...active.types],
            annotations: active.annotations.filter((annotation) =>
              localSubjects.has(annotation.entity_id),
            ),
            signatures: [...nativeSignatures, ...suppliedCalls.signatures],
            contracts: suppliedCalls.contracts,
          })
        : baseline;
      const typeFailure = types.diagnostics.find(
        (item) => item.code === 'cancelled' || item.code === 'resource_limit',
      );
      if (typeFailure) throw new OperationError(typeFailure);
      context.progress('structure', 5, 7);
      const structured = structureControlFlow(ir, context, { max_work: context.budget.work });
      requirePass(structured.state, structured.diagnostics, context);
      if (!structured.value)
        throw new OperationError({
          code: 'internal_error',
          severity: 'error',
          message: 'Structuring omitted the presentation',
          evidence_ids: [],
        });
      const names: { entity_id: string; name: string }[] = [];
      const nameDiagnostics: Diagnostic[] = [];
      const named = new Map<string, (typeof active.annotations)[number][]>();
      for (const annotation of active.annotations)
        if (annotation.value.kind === 'name') {
          const list = named.get(annotation.entity_id) ?? [];
          list.push(annotation);
          named.set(annotation.entity_id, list);
        }
      if (!named.has(ir.id) && (loaded.function.display_name ?? loaded.function.original_name))
        names.push({
          entity_id: ir.id,
          name: (loaded.function.display_name ?? loaded.function.original_name)!,
        });
      for (const [entity_id, annotations] of named) {
        const assertedNames = new Set(
          annotations.flatMap((annotation) =>
            annotation.status === 'asserted' && annotation.value.kind === 'name'
              ? [annotation.value.value]
              : [],
          ),
        );
        if (assertedNames.size === 1) names.push({ entity_id, name: [...assertedNames][0]! });
        else if (
          entity_id === ir.id &&
          (loaded.function.display_name ?? loaded.function.original_name)
        )
          names.push({
            entity_id,
            name: (loaded.function.display_name ?? loaded.function.original_name)!,
          });
        if (
          assertedNames.size !== 1 ||
          annotations.some((annotation) => annotation.status === 'hypothesis')
        )
          nameDiagnostics.push({
            code: 'conflicting_evidence',
            severity: 'info',
            message:
              'Name hypotheses or ambiguous assertions remain unresolved; only a unique asserted name overrides native presentation',
            entity_id,
            evidence_ids: [
              ...new Set(annotations.flatMap((annotation) => annotation.evidence_ids)),
            ],
          });
      }
      // Names decorate grounded callee identities; they never establish a prototype.
      const nativeNames = new Map<string, string>();
      for (const subject of [...functions, ...image.imports, ...image.exports]) {
        context.checkpoint(1);
        const name = subject.display_name ?? subject.original_name;
        if (name) nativeNames.set(subject.id, name);
      }
      const resolvedNames = new Map(names.map((item) => [item.entity_id, item.name]));
      for (const [subject, uses] of calls.calls_by_subject) {
        context.checkpoint(1 + uses.length);
        // Ambiguous/hypothetical annotations must not silently select a native alias.
        const name =
          resolvedNames.get(subject) ?? (named.has(subject) ? undefined : nativeNames.get(subject));
        if (!name) continue;
        if (!resolvedNames.has(subject)) names.push({ entity_id: subject, name });
        for (const use of uses)
          if (!named.has(use.call_id)) names.push({ entity_id: use.call_id, name });
      }
      const source = recoverSourceEvidence({
        scope,
        revision: args.revision,
        image,
        ir,
        instruction_count: graph.instructions.length,
        coverage_reasons: graph.coverage.reasons,
        required_nodes: requiredNodes,
        functions,
        references,
        calls,
        types,
        library,
        debug,
        native_types: nativeTypes,
        components,
      });
      context.progress('emit', 6, 7);
      const emit = args.options.emitter === 'python-like' ? emitPythonLike : emitC;
      const emitted = emit(
        { function: structured.value, types, names, annotations: active.annotations, source },
        args.options,
        fullContext,
      );
      const decodeReasons = new Set<string>(),
        decodeDiagnostics: Diagnostic[] = [...graph.diagnostics];
      let decoded = 0;
      for (const instruction of graph.instructions) {
        context.checkpoint(1 + instruction.diagnostics.length);
        if (instruction.validity === 'valid') decoded++;
        else decodeReasons.add(instruction.validity);
        decodeDiagnostics.push(...instruction.diagnostics);
      }
      for (const gap of graph.gaps) {
        context.checkpoint(1 + gap.diagnostics.length);
        // Unreachable data islands inside function extents are not failed decoding.
        if (gap.reason !== 'data' || graph.coverage.reasons.includes('data'))
          decodeReasons.add(gap.reason);
        decodeDiagnostics.push(...gap.diagnostics);
      }
      const diagnostics = [
        ...decodeDiagnostics,
        ...lifted.diagnostics,
        ...constructed.diagnostics,
        ...simplified.diagnostics,
        ...types.diagnostics,
        ...structured.diagnostics,
        ...nameDiagnostics,
        ...emitted.diagnostics,
      ];
      const uniqueDiagnostics = [
        ...new Map(
          diagnostics.map((diagnostic) => [
            fingerprint(encodeDiagnostic(diagnostic) as unknown as CanonicalValue),
            diagnostic,
          ]),
        ).values(),
      ];
      const reconstructionReasons = [
        ...new Set(
          emitted.diagnostics
            .filter((diagnostic) => diagnostic.code === 'unavailable_semantics')
            .map((diagnostic) => diagnostic.message),
        ),
      ];
      for (const call of types.calls?.calls ?? []) {
        const source = types.signatures.some(
          (signature) =>
            signature.subject_id === call.node_id &&
            signature.abi_state === 'complete' &&
            (signature.status === 'established' || signature.status === 'asserted'),
        );
        if (
          !source &&
          !reconstructionReasons.includes(
            'Calls without an established source contract retain conservative effects',
          )
        )
          reconstructionReasons.push(
            'Calls without an established source contract retain conservative effects',
          );
      }
      const abiPartial = types.signatures.some((signature) => signature.abi_state !== 'complete');
      const analysisReasons = [
        ...new Set([
          ...graph.coverage.reasons,
          ...(types.state === 'partial' ? ['Source metadata or type recovery is incomplete'] : []),
        ]),
      ];
      const coverage: ResultMetadata['coverage'] = [
        {
          layer: 'decode',
          state: decodeReasons.size ? 'partial' : 'complete',
          completed_units: decoded,
          ...(decodeReasons.size ? {} : { total_units: graph.instructions.length }),
          reasons: [...decodeReasons],
        },
        lifted.coverage,
        {
          layer: 'abi',
          state: abiPartial ? 'partial' : 'complete',
          completed_units: abiPartial ? 0 : 1,
          total_units: 1,
          reasons: abiPartial
            ? ['One or more supplied source contracts have unsupported ABI layouts']
            : [],
        },
        {
          layer: 'analysis',
          state:
            graph.coverage.state === 'complete' && types.state === 'complete'
              ? 'complete'
              : 'partial',
          completed_units: analysisReasons.length ? 0 : 1,
          total_units: 1,
          reasons: analysisReasons,
        },
        {
          layer: 'reconstruction',
          state: reconstructionReasons.length ? 'partial' : 'complete',
          completed_units: emitted.coverage.mapped_statements + emitted.coverage.mapped_controls,
          total_units: emitted.coverage.statements + emitted.coverage.controls,
          reasons: reconstructionReasons,
        },
      ];
      let signature: Signature | null = null;
      const signatures = types.signatures.filter(
        (item) =>
          item.subject_id === ir.id &&
          item.abi_state === 'complete' &&
          (item.status === 'established' || item.status === 'asserted'),
      );
      if (!types.conflicts.some((conflict) => conflict.subject_id === ir.id) && signatures.length) {
        const keys = new Set(
          signatures.map((item) =>
            fingerprint([
              item.signature.abi,
              item.signature.return_type,
              item.signature.parameters.map((parameter) => parameter.type_id),
              item.signature.variadic,
              item.signature.noreturn,
            ]),
          ),
        );
        if (keys.size === 1) signature = signatures[0]!.signature;
      }
      const catalog = semanticCatalog(image, ir, types, context);
      const proofIds = evidenceReferences(
        [
          catalog.types,
          types.associations,
          types.signatures,
          types.shapes,
          emitted.emission,
          uniqueDiagnostics,
          active.annotations,
          signature,
        ],
        context,
      );
      const evidence = closeEvidence(
        store,
        args.revision,
        proofIds,
        [
          ...image.evidence,
          ...debug.evidence,
          ...library.evidence,
          ...baseline.evidence,
          ...nativeCalls.evidence,
          ...types.evidence,
          ...suppliedCalls.evidence,
        ],
        context,
      );
      const metadata: ResultMetadata = {
        schema_version: SCHEMA_VERSION,
        project_id: store.project_id,
        revision: args.revision,
        versions: identity.versions,
        options: args.options,
        budget: args.budget,
        coverage,
        diagnostics: uniqueDiagnostics.map(encodeDiagnostic),
        evidence: args.options.include_evidence ? evidence.map(encodeEvidence) : [],
        artifacts: [],
      };
      const data = {
        delivery: 'inline' as const,
        function_id: ir.id,
        signature: signature ? signatureSchema.parse(signature) : null,
        emission: encodeEmission(emitted.emission),
        capabilities: [
          ...image.capabilities,
          ...coverage
            .filter((item) => item.layer !== 'decode')
            .map((item) => ({
              layer: item.layer,
              feature:
                item.layer === 'lift'
                  ? components.lifter.name
                  : item.layer === 'abi'
                    ? components.abi.name
                    : item.layer === 'analysis'
                      ? 'SSA, value/effect, stack/call and source-type analysis'
                      : `${args.options.emitter === 'python-like' ? 'Python-like' : 'C-like'} pseudocode and instruction mappings`,
              status: item.state === 'complete' ? ('supported' as const) : ('partial' as const),
              limitations: item.reasons,
            })),
        ],
        cache: 'computed' as const,
      };
      const partial = coverage.some((item) => item.state !== 'complete');
      const result: StoredDecompilation = partial
        ? {
            ...metadata,
            state: 'partial',
            reason: graph.coverage.state !== 'complete' ? 'incomplete_index' : 'unsupported_subset',
            continuation: null,
            data,
          }
        : { ...metadata, state: 'complete', data };
      toolSchemas.function_decompile.output.parse(result);
      context.checkpoint(0);
      return { result, catalog: { ...catalog, evidence } };
    },
  );
}

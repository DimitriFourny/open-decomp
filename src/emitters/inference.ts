import type { Address, Emission, OperationContext, RecoveredType } from '../core/index.js';
import type { Inference, InferenceStatus } from '../core/inference.js';
import type { MemoryShape, ObservedField, TypeStatus } from '../analysis/types/model.js';
import { bitWidth, expressionOperands, type Origin, type Value } from '../ir/index.js';
import type { Region } from '../presentation/index.js';
import type { BoundaryProjection, Reconstruction } from '../reconstruction/model.js';
import type { LocalValidationRecord } from '../reconstruction/local-validation.js';
import { sourceConstantValues, sourceDataValues } from '../reconstruction/source-data.js';
import { stackEntry, type SourceAddress } from '../reconstruction/source-model.js';
import type { EmissionInput } from './model.js';
import {
  MetadataLimitError,
  ReferenceUnions,
  type ReferenceEncoding,
  type Writer,
} from './writer.js';

type Mapping = Emission['mappings'][number];
type Details = Inference['details'];
const confidence = (status: TypeStatus): InferenceStatus =>
  status === 'candidate' ? 'inferred' : status;
const identity = (address: Address) => ({
  image_id: address.image_id,
  space: address.space,
  address: String(address.value),
});

export interface InferenceCollection {
  readonly records: readonly Inference[];
  /** Records bounded out of `records`; null when a global metadata bound stopped the
   * collection before the remaining records could be counted. */
  readonly omitted: number | null;
}

/** Collect from semantic models and the writer's finalized mappings, never
 * emitted text. Records cite the writer's interned tables directly. The indexes
 * are local to one render; no inference performs an all-IR/mapping scan.
 * Inference records are provenance metadata: a record that exceeds a wire bound is
 * skipped and counted, and a global metadata bound ends collection with the records
 * gathered so far. Neither discards or changes any record that is delivered. */
export function collectInferences(
  input: EmissionInput,
  program: Reconstruction,
  localValidation: readonly LocalValidationRecord[],
  writer: Writer,
  context: OperationContext,
  sites?: ReadonlyMap<string, { readonly start: number; readonly end: number }>,
  resolveData?: (value: Value) => SourceAddress | undefined,
): InferenceCollection {
  const records: Inference[] = [];
  const tally = { skipped: 0 };
  try {
    gatherInferences(
      input,
      program,
      localValidation,
      writer,
      context,
      records,
      tally,
      sites,
      resolveData,
    );
  } catch (error) {
    if (!(error instanceof MetadataLimitError)) throw error;
    return { records, omitted: null };
  }
  return { records, omitted: tally.skipped };
}

const likelyExplanation = (applied: boolean): string =>
  applied
    ? 'Likely-mode guess, not an established fact: the open argument list of this call was closed after its observed prefix by the named heuristics, which passed their precision gate on the benchmark harness. The call record keeps arity_complete false.'
    : 'Likely-mode guess recorded only: the named heuristics are below their precision gate, so the printed argument list stays open.';
const likelyTypeExplanation = (
  applied: boolean,
  subject: 'parameter_type' | 'result_type',
): string =>
  `${
    applied
      ? 'Likely-mode guess, not an established fact'
      : 'Likely-mode guess recorded only: the named heuristics are below their precision gate, so the declaration stays as proven analysis leaves it'
  }: ${subject === 'parameter_type' ? 'this formal' : 'the function result'} was taken to be an address (void *) because every discovered direct caller that ${subject === 'parameter_type' ? 'prepares it passes a value its own proven analysis holds as an address' : 'consumes the result treats it as an address'}. Proven analysis leaves it an integer, and the caller scan is not proof that these are all the callers.`;
function likelyDetails(
  call: string,
  target: Extract<Details, { readonly subject: 'argument_list' }>['target'],
  likely: NonNullable<BoundaryProjection['likely']>,
): Extract<Details, { readonly subject: 'argument_list' }> {
  return {
    kind: 'guess',
    subject: 'argument_list',
    call_id: call,
    target,
    heuristics: [...likely.heuristics],
    applied: likely.applied,
    arity: likely.arity,
    sites: likely.sites ?? null,
  };
}
function gatherInferences(
  input: EmissionInput,
  program: Reconstruction,
  localValidation: readonly LocalValidationRecord[],
  writer: Writer,
  context: OperationContext,
  result: Inference[],
  tally: { skipped: number },
  sites?: ReadonlyMap<string, { readonly start: number; readonly end: number }>,
  resolveData?: (value: Value) => SourceAddress | undefined,
): void {
  const mappings = writer.mappings;
  const original = new Map<string, Origin>();
  const loadResults = new Map<string, string>();
  const catalog = new Set(input.types?.subjects ?? []);
  const nativeCallees = new Map(
    input.source?.callees.map((callee) => [callee.call_id, callee]) ?? [],
  );
  for (const callee of nativeCallees.values()) {
    context.checkpoint(1);
    if (callee.target_subject_id) catalog.add(callee.target_subject_id);
  }
  const addOrigin = (origin: Origin, valueIds: readonly string[] = []): void => {
    context.checkpoint(1 + valueIds.length);
    original.set(origin.id, origin);
    catalog.add(origin.id);
    for (const id of valueIds) {
      original.set(id, origin);
      catalog.add(id);
    }
  };
  addOrigin(input.function);
  const pending: Region[] = [input.function.body];
  while (pending.length) {
    context.checkpoint(1);
    const region = pending.pop()!;
    if (region.kind === 'sequence') {
      for (const child of region.regions) pending.push(child);
      continue;
    }
    if (region.kind === 'loop') {
      pending.push(region.body);
      continue;
    }
    addOrigin(
      region,
      region.parameters.map((value) => value.id),
    );
    for (const node of region.statements) {
      const values: string[] = [];
      if (node.kind === 'load') loadResults.set(node.result.id, node.id);
      if ('result' in node) values.push(node.result.id);
      if (node.kind === 'call') for (const value of node.results) values.push(value.id);
      if (node.kind === 'call' || node.kind === 'unknown_effect')
        for (const binding of node.register_outputs) values.push(binding.value.id);
      addOrigin(node, values);
    }
    addOrigin(region.control);
    const arm = (item: { readonly body?: Region }): void => {
      if (item.body) pending.push(item.body);
    };
    if (region.control.kind === 'if') {
      arm(region.control.when_true);
      arm(region.control.when_false);
    }
    if (region.control.kind === 'switch') {
      for (const item of region.control.cases) arm(item.arm);
      arm(region.control.otherwise);
    }
  }
  const resolved = new Map<string, readonly string[]>();
  const originals = (id: string, active = new Set<string>()): readonly string[] => {
    context.checkpoint(1);
    const cached = resolved.get(id);
    if (cached) return cached;
    if (active.has(id) || active.size >= 128)
      writer.limitMetadata('Inference origin graph limit exceeded');
    active.add(id);
    const origins = program.source?.value_origins?.get(id);
    const result = new Set<string>();
    if (origins?.length) {
      for (const origin of origins) {
        if (origin === id) {
          if (catalog.has(id)) result.add(id);
        } else for (const subject of originals(origin, active)) result.add(subject);
      }
    } else if (catalog.has(id)) result.add(id);
    active.delete(id);
    const subjects = [...result];
    resolved.set(id, subjects);
    return subjects;
  };
  const bySubject = new Map<number, Set<Mapping>>();
  const byInstruction = new Map<number, Set<Mapping>>();
  const bySpan = new Map<string, Set<Mapping>>();
  const siteStarts = sites && new Set([...sites.values()].map((site) => site.start));
  const index = <K>(table: Map<K, Set<Mapping>>, key: K, mapping: Mapping): void => {
    const group = table.get(key) ?? new Set<Mapping>();
    group.add(mapping);
    table.set(key, group);
  };
  const functionRef = writer.findId(input.function.id);
  for (const mapping of mappings) {
    context.checkpoint(1);
    const statement = mapping.semantic_refs[0]!;
    // Zero-output contributor coverage is mapped to the header by the renderer.
    // It is provenance, not another visible declaration or value-use site.
    if (siteStarts && !siteStarts.has(mapping.start) && statement !== functionRef) continue;
    index(bySubject, statement, mapping);
    index(bySpan, `${mapping.start}:${mapping.end}`, mapping);
    if (statement === functionRef) continue;
    for (const instruction of mapping.instruction_refs) {
      context.checkpoint(1);
      index(byInstruction, instruction, mapping);
    }
  }
  const aliases = new Map<string, Set<string>>();
  const alias = (subject: string, site: string): void => {
    const group = aliases.get(subject) ?? new Set<string>();
    group.add(site);
    aliases.set(subject, group);
  };
  for (const parameter of program.parameters) {
    for (const subject of originals(parameter.id)) alias(subject, parameter.id);
  }
  for (const [value, view] of program.source?.value_types ?? []) {
    if (!program.live.has(value)) continue;
    for (const subject of view.subject_ids ?? []) alias(subject, value);
  }
  for (const [node, view] of program.memory)
    for (const subject of [view.field.id, ...(view.field.origin_ids ?? [])]) alias(subject, node);
  // Index transported field uses before any linksFor memoization.
  const transferredFields: {
    readonly shape: MemoryShape;
    readonly field: ObservedField;
    readonly call: string;
  }[] = [];
  const transferredSites = new Map<string, Set<string>>();
  for (const transfer of input.source?.memory_transfers ?? [])
    for (const field of transfer.parameter_shape.fields) {
      context.checkpoint(1);
      const calls = transferredSites.get(field.id) ?? new Set<string>();
      calls.add(transfer.call_id);
      transferredSites.set(field.id, calls);
    }
  for (const shape of input.types?.shapes ?? [])
    for (const field of shape.fields) {
      context.checkpoint(1);
      const calls = new Set(
        (field.origin_ids ?? []).flatMap((id) => [...(transferredSites.get(id) ?? [])]),
      );
      for (const call of calls) {
        alias(field.id, call);
        alias(shape.id, call);
        transferredFields.push({ shape, field, call });
      }
    }
  const linked = new Map<string, readonly Mapping[]>();
  const linksFor = (id: string): readonly Mapping[] => {
    const previous = linked.get(id);
    if (previous) return previous;
    context.checkpoint(1);
    const group = new Set<Mapping>();
    const candidates = new Set([id, ...originals(id), ...(aliases.get(id) ?? [])]);
    for (const subject of candidates) {
      const ref = writer.findId(subject);
      if (ref !== undefined) for (const mapping of bySubject.get(ref) ?? []) group.add(mapping);
      const site = sites?.get(subject);
      if (site)
        for (const mapping of bySpan.get(`${site.start}:${site.end}`) ?? []) group.add(mapping);
      const origin = original.get(subject);
      for (const instruction of origin?.provenance.instruction_ids ?? []) {
        const instructionRef = writer.findId(instruction);
        if (instructionRef !== undefined)
          for (const mapping of byInstruction.get(instructionRef) ?? []) group.add(mapping);
      }
    }
    const rows = [...group];
    linked.set(id, rows);
    return rows;
  };
  const references = new ReferenceUnions(context);
  /** The output spans and reference unions of one mapping list. Records of one
   * subject (and every half of a split type cohort) reuse it instead of
   * revisiting each mapping. */
  interface LinkSummary {
    readonly spans: ReadonlyMap<string, { readonly start: number; readonly end: number }>;
    readonly instructions: ReferenceEncoding;
    readonly proofs: ReferenceEncoding;
    readonly ranges: ReferenceEncoding;
  }
  const linkSummaries = new WeakMap<readonly Mapping[], LinkSummary>();
  const summarize = (links: readonly Mapping[]): LinkSummary => {
    const previous = linkSummaries.get(links);
    if (previous) return previous;
    const spans = new Map<string, { start: number; end: number }>();
    const instructions = references.begin(),
      proofs = references.begin(),
      ranges = references.begin();
    for (const mapping of links) {
      context.checkpoint(1);
      spans.set(`${mapping.start}:${mapping.end}`, { start: mapping.start, end: mapping.end });
      instructions.add(mapping.instruction_refs);
      if (writer.evidence) proofs.add(mapping.evidence_refs);
      ranges.add(mapping.range_refs);
    }
    const summary: LinkSummary = {
      spans,
      instructions: instructions.encoding(),
      proofs: proofs.encoding(),
      ranges: ranges.encoding(),
    };
    linkSummaries.set(links, summary);
    return summary;
  };
  interface Member {
    readonly subjects: readonly string[];
    /** Proof lists by identity; each is interned once however many records cite it. */
    readonly evidence: readonly (readonly string[] | undefined)[];
    readonly affectedSubjects: readonly string[];
  }
  const add = (
    subjects: readonly string[],
    status: InferenceStatus,
    explanation: string,
    details: Details,
    evidence: readonly (readonly string[] | undefined)[] = [],
    affectedSubjects: readonly string[] = subjects,
    members: readonly Member[] = [{ subjects, evidence, affectedSubjects }],
  ): void => {
    context.checkpoint(1);
    const subjectIds = new Set<string>();
    const instructionUnion = references.begin(),
      proofUnion = references.begin(),
      rangeUnion = references.begin();
    const spans = new Map<string, { start: number; end: number }>();
    for (const member of members) {
      const memberSubjects = new Set<string>();
      for (const id of member.subjects)
        for (const subject of originals(id)) memberSubjects.add(subject);
      // One memoized summary per affected subject: their union is the summary of
      // the subjects' combined mappings (spans keep first-occurrence order).
      const linked = member.affectedSubjects.map(linksFor).filter((links) => links.length);
      if (!linked.length || !memberSubjects.size) continue;
      if (writer.evidence)
        for (const proofs of member.evidence) if (proofs) proofUnion.add(writer.proofRefs(proofs));
      let hasInstructions = false,
        hasRanges = false,
        hasSites = false;
      const provenance = (origin: Origin): void => {
        hasInstructions ||= origin.provenance.instruction_ids.length > 0;
        hasRanges ||= origin.provenance.ranges.length > 0;
        instructionUnion.add(writer.idRefs(origin.provenance.instruction_ids));
        if (writer.evidence) proofUnion.add(writer.proofRefs(origin.provenance.evidence_ids));
        rangeUnion.add(writer.rangeRefs(origin.provenance.ranges));
      };
      for (const id of memberSubjects) {
        context.checkpoint(1);
        subjectIds.add(id);
        const origin = original.get(id);
        if (origin) provenance(origin);
        for (const contributor of program.origins.get(id) ?? []) provenance(contributor);
      }
      for (const subject of member.affectedSubjects) {
        const site = sites?.get(subject);
        if (site && site.end > site.start) {
          hasSites = true;
          spans.set(`${site.start}:${site.end}`, site);
        }
      }
      // Fallback is per member, not per group: a field without an IR origin
      // keeps its mapping provenance even beside a value with its own origin.
      for (const summary of linked.map(summarize)) {
        if (!hasSites)
          for (const [key, span] of summary.spans) {
            context.checkpoint(1);
            spans.set(key, { start: span.start, end: span.end });
          }
        if (!hasInstructions) instructionUnion.merge(summary.instructions);
        if (writer.evidence) proofUnion.merge(summary.proofs);
        if (!hasRanges) rangeUnion.merge(summary.ranges);
      }
    }
    if (!subjectIds.size) return;
    if (result.length >= 10000) {
      tally.skipped++;
      return;
    }
    // Bounds are checked on union sizes: an oversized union is never materialized.
    if (
      subjectIds.size > 10000 ||
      spans.size > 1000 ||
      proofUnion.size() > 1000 ||
      instructionUnion.size() > 10000 ||
      rangeUnion.size() > 10000
    ) {
      // Partition a large type cohort without weakening any wire bound. Every
      // attempted union above is charged, including when its cohort must split.
      if (details.kind === 'type' && members.length > 1) {
        const middle = Math.floor(members.length / 2);
        for (const [start, end] of [
          [0, middle],
          [middle, members.length],
        ] as const)
          add(
            [],
            status,
            explanation,
            { ...details, association_ids: details.association_ids.slice(start, end) },
            [],
            [],
            members.slice(start, end),
          );
        return;
      }
      // One record beyond the wire bounds is dropped and counted, never the render.
      tally.skipped++;
      return;
    }
    // Reference unions charge their word visits and materialize each immutable
    // result once. Only the subject list is newly copied for every record.
    context.checkpoint(subjectIds.size);
    const instructions = instructionUnion.finish(),
      proofs = proofUnion.finish(),
      ranges = rangeUnion.finish();
    const record: Inference = {
      id: `inference:${result.length}`,
      status,
      explanation,
      subject_refs: [...subjectIds].map((id) => writer.id(id)),
      evidence_refs: proofs,
      instruction_refs: instructions,
      range_refs: ranges,
      output_spans: [...spans.values()],
      details,
    };
    // Charge strings and structure once without serializing/copying the record;
    // index lists have a known serialized bound.
    writer.charge({
      id: record.id,
      status,
      explanation,
      output_spans: record.output_spans,
      details,
    });
    writer.chargeRefs(
      record.subject_refs,
      record.evidence_refs,
      record.instruction_refs,
      record.range_refs,
    );
    result.push(record);
  };
  const originalValues = (value: Value): readonly string[] => originals(value.id);
  const constantValue =
    program.calls.size || program.tails.size
      ? sourceConstantValues(program.expressions, context)
      : undefined;
  const argumentDetails = (value: Value, ordinal: number) => {
    const expression = program.expressions.get(value.id);
    const bits =
      expression?.kind === 'constant'
        ? BigInt.asUintN(bitWidth(value.type), expression.bits)
        : constantValue?.(value);
    return {
      ordinal,
      value_ids: originalValues(value),
      width_bits: bitWidth(value.type),
      constant_bits: bits === undefined ? null : String(bits),
    };
  };
  const incomingOffsets = new Map<string, bigint | null>();
  if (input.types?.calls?.stack.state === 'complete')
    for (const access of input.types.calls.stack.accesses) {
      context.checkpoint(1);
      if (
        access.kind !== 'read' ||
        access.region !== 'incoming_candidate' ||
        access.offset === null
      )
        continue;
      const previous = incomingOffsets.get(access.node_id);
      incomingOffsets.set(
        access.node_id,
        previous === undefined || previous === access.offset ? access.offset : null,
      );
    }
  for (let ordinal = 0; ordinal < program.parameters.length; ordinal++) {
    const value = program.parameters[ordinal]!;
    const register = program.parameter_registers.get(value.id);
    const offsets = new Set<bigint>();
    for (const id of originalValues(value)) {
      const load = loadResults.get(id),
        offset = load && incomingOffsets.get(load);
      if (typeof offset === 'bigint') offsets.add(offset);
    }
    const incoming = program.source?.incoming_object;
    // The incoming object's struct formal (S4) designates the bytes from its start.
    const stack =
      offsets.size === 1
        ? offsets.values().next().value
        : incoming?.formal.id === value.id
          ? incoming.minimum_offset
          : undefined;
    const parameter = program.signature?.signature.parameters[ordinal];
    const role =
      register?.role === 'stack_pointer' || stackEntry(program.source?.stack)?.id === value.id
        ? 'entry_storage'
        : program.source
          ? 'observed_input'
          : 'physical_register';
    add(
      [value.id],
      program.signature ? confidence(program.signature.status) : 'inferred',
      role === 'entry_storage'
        ? 'Entry-backed storage environment, not an authored source argument; ordinal is its presentation position only.'
        : program.signature
          ? 'Parameter follows the supplied source signature and its original machine storage.'
          : 'Recovered incoming machine value used by the emitted body; this does not prove a complete source prototype.',
      {
        kind: 'parameter',
        ordinal,
        role,
        value_ids: originalValues(value),
        machine_width_bits: bitWidth(value.type),
        location: register
          ? {
              kind: 'register',
              root: register.root,
              offset_bits: register.offset_bits,
              width_bits: register.width_bits,
            }
          : stack !== undefined
            ? { kind: 'stack', offset: String(stack) }
            : { kind: 'unknown' },
        source_type_id:
          parameter?.type_id ?? program.source?.value_types?.get(value.id)?.type_id ?? null,
      },
      [program.signature?.evidence_ids],
    );
  }
  const likelyTypes = program.source?.likely_types;
  for (let ordinal = 0; ordinal < program.parameters.length; ordinal++) {
    const value = program.parameters[ordinal]!;
    const guess = likelyTypes?.parameters.get(value.id);
    if (!guess) continue;
    add([value.id], 'hypothesis', likelyTypeExplanation(guess.applied, 'parameter_type'), {
      kind: 'guess',
      subject: 'parameter_type',
      ordinal,
      value_ids: originalValues(value),
      guessed_type: 'pointer',
      heuristics: [...guess.heuristics],
      applied: guess.applied,
      sites: guess.sites ?? null,
    });
  }
  if (likelyTypes?.result)
    add(
      [program.function.id],
      'hypothesis',
      likelyTypeExplanation(likelyTypes.result.applied, 'result_type'),
      {
        kind: 'guess',
        subject: 'result_type',
        ordinal: null,
        value_ids: [],
        guessed_type: 'pointer',
        heuristics: [...likelyTypes.result.heuristics],
        applied: likelyTypes.result.applied,
        sites: likelyTypes.result.sites ?? null,
      },
    );
  const displayedAssociations = new Set<string>();
  for (const view of program.source?.value_types?.values() ?? [])
    for (const id of view.association_ids) displayedAssociations.add(id);
  const definitions = new Map<string, RecoveredType | null>();
  for (const record of input.types?.types ?? []) {
    context.checkpoint(1);
    definitions.set(record.id, definitions.has(record.id) ? null : record.definition);
  }
  // A type assertion applies independently to each subject. The schema already
  // carries all association identities; batch only identical assertion details,
  // retaining each member's provenance and visible sites in the union.
  interface TypeGroup {
    readonly details: Extract<Details, { kind: 'type' }>;
    readonly associationIds: string[];
    readonly members: Member[];
  }
  const typeGroups: TypeGroup[] = [],
    activeTypeGroups = new Map<string, TypeGroup>();
  for (const association of input.types?.associations ?? []) {
    context.checkpoint(1);
    if (!originals(association.subject_id).length || !linksFor(association.subject_id).length)
      continue;
    const definition = definitions.get(association.type_id);
    const associationIds: string[] = [];
    const details: Extract<Details, { kind: 'type' }> = {
      kind: 'type',
      association_ids: associationIds,
      type_id: association.type_id,
      type_status: association.status,
      source: association.source,
      value_offset_bits: association.value_offset_bits,
      type_kind: definition?.kind ?? null,
      signed: definition?.kind === 'integer' ? definition.signed : null,
      pointee_id: definition?.kind === 'pointer' ? definition.to : null,
      machine_offset_bits: association.machine_offset_bits,
      width_bits: association.width_bits,
      displayed: displayedAssociations.has(association.id),
    };
    const key = JSON.stringify(details);
    let group = activeTypeGroups.get(key);
    if (!group || group.members.length === 10000) {
      // Keep finite cohorts; a group that reaches reference bounds is split by
      // add(), never truncated or widened into a different assertion.
      group = { details, associationIds, members: [] };
      typeGroups.push(group);
      activeTypeGroups.set(key, group);
    }
    group.associationIds.push(association.id);
    group.members.push({
      subjects: [association.subject_id],
      evidence: [association.evidence_ids],
      affectedSubjects: [association.subject_id],
    });
  }
  for (const group of typeGroups) {
    const details = group.details;
    add(
      [],
      confidence(details.type_status),
      `Source type association from ${details.source}; ${details.type_status === 'hypothesis' ? 'an alternative, not an established fact' : 'confidence is retained independently of display'}.`,
      details,
      [],
      [],
      group.members,
    );
  }
  for (const [node, view] of program.memory) {
    context.checkpoint(1);
    const field = view.field;
    add(
      [
        node,
        field.id,
        ...(field.origin_ids ?? []),
        ...field.value_ids,
        ...(view.shape.base.kind === 'value' ? [view.shape.base.value_id] : []),
      ],
      'inferred',
      'Observed partial memory field; displacement and access width are known, object and index bounds are not.',
      {
        kind: 'field',
        shape_id: view.shape.id,
        field_ids: field.origin_ids ?? [field.id],
        type_id: view.shape.type_id,
        offset: String(field.offset),
        width_bits: field.width_bits,
        stride: field.stride === null ? null : String(field.stride),
        dynamic: field.dynamic ?? field.stride !== null,
        bounds: 'unknown',
        call_target_ids: field.call_target_ids ?? [],
      },
      [view.shape.evidence_ids, field.evidence_ids],
      [node],
    );
  }
  // A transported field is observed through the original caller boundary, not
  // a fabricated local load. Reuse the portable shape's existing origin IDs.
  for (const { shape, field, call } of transferredFields)
    add(
      [
        call,
        field.id,
        shape.id,
        ...(field.origin_ids ?? []),
        ...(shape.base.kind === 'value' ? [shape.base.value_id] : []),
      ],
      'inferred',
      'Callee-observed partial memory field transported through this exact caller argument; no local load, source field name, object size, or index bound is asserted.',
      {
        kind: 'field',
        shape_id: shape.id,
        field_ids: field.origin_ids ?? [field.id],
        type_id: shape.type_id,
        offset: String(field.offset),
        width_bits: field.width_bits,
        stride: field.stride === null ? null : String(field.stride),
        dynamic: field.dynamic ?? field.stride !== null,
        bounds: 'unknown',
        call_target_ids: field.call_target_ids ?? [],
      },
      [shape.evidence_ids, field.evidence_ids],
      [call],
    );
  const dataValue =
    resolveData ?? sourceDataValues(program.expressions, program.source?.addresses ?? [], context);
  for (const id of program.live) {
    context.checkpoint(1);
    if (!linksFor(id).length) continue;
    const value = program.values.get(id);
    if (!value) continue;
    const expression = program.expressions.get(id);
    let operation: Extract<Details, { readonly kind: 'interpretation' }>['operation'] | null = null;
    if (
      expression?.kind === 'integer' &&
      (expression.op === 'sdiv' || expression.op === 'srem' || expression.op === 'ashr')
    )
      operation = expression.op;
    else if (
      expression?.kind === 'compare' &&
      (expression.op === 'slt' ||
        expression.op === 'sle' ||
        expression.op === 'sgt' ||
        expression.op === 'sge')
    )
      operation = expression.op;
    else if (
      expression?.kind === 'cast' &&
      (expression.op === 'sign_extend' ||
        expression.op === 'signed_to_float' ||
        expression.op === 'float_to_signed')
    )
      operation = expression.op;
    if (operation !== null && expression) {
      const operands = expressionOperands(expression);
      add(
        [id],
        'established',
        'Signed interpretation of this reconstructed bit-vector operation; widths describe reconstructed IR storage, not decoded instruction operand widths or a signed source declaration.',
        {
          kind: 'interpretation',
          width_domain: 'reconstructed_ir',
          operation,
          signed: true,
          operand_value_ids: operands.map(originalValues),
          operand_width_bits: operands.map((operand) => bitWidth(operand.type)),
          result_width_bits: bitWidth(value.type),
        },
      );
    }
    const item = dataValue(value);
    if (!item) continue;
    add(
      [value.id],
      'established',
      'Exact symbolic/data address identity; literal bytes are shown only for immutable terminated strings. Unknown storage extents remain unknown.',
      {
        kind: 'identity',
        value_ids: originalValues(value),
        identity: identity(item.address),
        name: item.name ?? null,
        literal: item.string ?? null,
        encoding: item.string_encoding ?? null,
        byte_length: item.string_byte_length === undefined ? null : String(item.string_byte_length),
        mutable: item.object?.mutable ?? null,
        object_address: item.object ? String(item.object.address.value) : null,
        object_offset: item.object ? String(item.object.offset) : null,
        object_byte_length:
          item.object?.byte_length === undefined || item.object.byte_length === null
            ? null
            : String(item.object.byte_length),
      },
      [item.object?.evidence_ids],
    );
  }
  for (const block of program.blocks.values())
    for (const node of block.statements) {
      context.checkpoint(1);
      if (node.kind !== 'call') continue;
      const projection = program.calls.get(node.id);
      if (!projection) continue;
      const native = nativeCallees.get(node.id);
      const assumptions = native?.context_assumptions;
      const contextAssumptions = assumptions
        ? {
            constants: assumptions.constants.map(({ register, bits }) => ({
              register: {
                root: register.root,
                offset_bits: register.offset_bits,
                width_bits: register.width_bits,
              },
              bits: String(bits),
            })),
            aliases: assumptions.aliases.map((group) =>
              group.map((register) => ({
                root: register.root,
                offset_bits: register.offset_bits,
                width_bits: register.width_bits,
              })),
            ),
            type_evidence_scope: assumptions.type_evidence_scope,
          }
        : undefined;
      add(
        [
          node.id,
          ...(native?.target_subject_id ? [native.target_subject_id] : []),
          ...(node.target.kind === 'indirect' ? [node.target.value.id] : []),
        ],
        projection.signature
          ? confidence(projection.signature.status)
          : projection.kind === 'physical'
            ? 'unresolved'
            : 'inferred',
        'Ordered known call arguments and exact target identity; incomplete arity does not mean zero trailing arguments. Local source projection does not prove callee behavior.',
        {
          kind: 'call',
          call_id: node.id,
          target:
            node.target.kind === 'direct'
              ? { kind: 'direct', identity: identity(node.target.address) }
              : { kind: 'indirect', value_ids: originalValues(node.target.value) },
          ordered_arguments: projection.arguments.map(argumentDetails),
          result_width_bits: projection.results.map((value) => bitWidth(value.type)),
          arity_complete:
            projection.kind !== 'physical' &&
            projection.argument_list_complete !== false &&
            (projection.argument_list_complete === true ||
              (projection.kind === 'source' && projection.signature?.signature.variadic === false)),
          signature_id: projection.signature?.id ?? null,
          ...(contextAssumptions ? { context_assumptions: contextAssumptions } : {}),
        },
        [node.contract_evidence, projection.signature?.evidence_ids, native?.evidence_ids],
        [node.id],
      );
      if (projection.likely)
        add(
          [node.id, ...(native?.target_subject_id ? [native.target_subject_id] : [])],
          'hypothesis',
          likelyExplanation(projection.likely.applied),
          likelyDetails(
            node.id,
            node.target.kind === 'direct'
              ? { kind: 'direct', identity: identity(node.target.address) }
              : { kind: 'indirect', value_ids: originalValues(node.target.value) },
            projection.likely,
          ),
          [native?.evidence_ids],
          [node.id],
        );
    }
  for (const [control, tail] of program.tails) {
    context.checkpoint(1);
    const projection = tail.boundary;
    const native = nativeCallees.get(control);
    const target: Extract<Details, { readonly kind: 'call' }>['target'] =
      tail.target === null
        ? { kind: 'indirect', value_ids: originalValues(tail.target_value) }
        : { kind: 'direct', identity: identity(tail.target) };
    const assumptions = native?.context_assumptions;
    const contextAssumptions = assumptions
      ? {
          constants: assumptions.constants.map(({ register, bits }) => ({
            register: {
              root: register.root,
              offset_bits: register.offset_bits,
              width_bits: register.width_bits,
            },
            bits: String(bits),
          })),
          aliases: assumptions.aliases.map((group) =>
            group.map((register) => ({
              root: register.root,
              offset_bits: register.offset_bits,
              width_bits: register.width_bits,
            })),
          ),
          type_evidence_scope: assumptions.type_evidence_scope,
        }
      : undefined;
    add(
      [
        control,
        ...(native?.target_subject_id ? [native.target_subject_id] : []),
        ...(tail.target === null ? [tail.target_value.id] : []),
      ],
      projection.signature ? confidence(projection.signature.status) : 'inferred',
      'Terminal call target and observed ordered inputs. Result widths belong to the callee, not invented caller SSA results; unknown trailing arity remains open.',
      {
        kind: 'call',
        call_id: control,
        target,
        ordered_arguments: projection.arguments.map(argumentDetails),
        result_width_bits: tail.result_types.map(bitWidth),
        arity_complete:
          projection.kind !== 'physical' &&
          projection.argument_list_complete !== false &&
          (projection.argument_list_complete === true ||
            (projection.kind === 'source' && projection.signature?.signature.variadic === false)),
        signature_id: projection.signature?.id ?? null,
        ...(contextAssumptions ? { context_assumptions: contextAssumptions } : {}),
      },
      [projection.signature?.evidence_ids, native?.evidence_ids],
      [control],
    );
    if (projection.likely)
      add(
        [control, ...(native?.target_subject_id ? [native.target_subject_id] : [])],
        'hypothesis',
        likelyExplanation(projection.likely.applied),
        likelyDetails(control, target, projection.likely),
        [native?.evidence_ids],
        [control],
      );
  }
  for (const record of localValidation) {
    context.checkpoint(1);
    add(
      record.subject_ids ?? [record.subject],
      record.status === 'verified'
        ? 'established'
        : record.status === 'rejected'
          ? 'conflicting'
          : 'unresolved',
      record.kind === 'presentation'
        ? 'Source-view presentation rewrite: its stated side conditions were checked on the reconstruction; the elided or restated facts remain in this metadata, the requirements and the checked view.'
        : 'Local translation validation only: the stated fragment/scope is not whole-function equivalence, semantic coverage, or evidence of a source declaration.',
      {
        kind: 'rewrite',
        validation_kind: record.kind,
        ...(record.rule ? { rule: record.rule } : {}),
        validation_subject: record.subject,
        validation_status: record.status,
        scope: record.scope,
        reason: record.reason ?? null,
        ...(record.counterexample ? { counterexample: record.counterexample } : {}),
      },
    );
  }
  for (const conflict of input.types?.conflicts ?? []) {
    add(
      [conflict.subject_id],
      'conflicting',
      'Incompatible alternatives remain visible; no alternative is promoted to an established fact.',
      { kind: 'conflict', alternatives: conflict.alternatives, reason: conflict.reason },
      [conflict.evidence_ids],
    );
  }
  for (const annotation of input.annotations ?? []) {
    add(
      [annotation.entity_id],
      annotation.status === 'retracted' ? 'unresolved' : annotation.status,
      annotation.status === 'retracted'
        ? 'This annotation was retracted and supplies no active fact.'
        : 'Annotation confidence is retained; an assertion or hypothesis is not an analysis proof.',
      {
        kind: 'annotation',
        annotation_id: annotation.id,
        annotation_status: annotation.status,
        annotation_kind: annotation.value.kind,
      },
      [annotation.evidence_ids],
    );
  }
}

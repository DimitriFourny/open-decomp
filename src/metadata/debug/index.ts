import {
  artifactIdSchema,
  contentHash,
  entityIdentity,
  fingerprint,
  OperationError,
  type Diagnostic,
  type Evidence,
  type LoadedImage,
  type OperationContext,
  type RecoveredType,
  type Signature,
} from '../../core/index.js';
import {
  boundDebugOutput,
  dwarfDiagnostic,
  parseDwarfSections,
  type DebugFunction,
  type DebugSignatureType,
  type DebugType,
  type DwarfData,
} from '../dwarf/index.js';
import { selectDebugSections, type ImageHeaders } from './macho.js';
export { selectDebugSections } from './macho.js';
export { debugContextAt, variableLocationsAt } from './queries.js';

/** The host authorizes and stores this artifact before calling recovery. No path is accepted. */
export interface ExternalDebugInput {
  readonly bytes: Uint8Array;
  readonly artifact_id: string;
  readonly expectedSha256?: string;
}
export interface DebugTypeRecord {
  readonly id: string;
  /** Raw DIE link, or null for synthesized void/unknown/array-dimension nodes. */
  readonly dwarf_id: string | null;
  readonly display_name: string;
  readonly definition: RecoveredType;
  readonly evidence_ids: readonly string[];
}
export interface DebugFunctionRecord {
  readonly id: string;
  readonly dwarf: DebugFunction;
  readonly signature: Signature | null;
  readonly evidence_ids: readonly string[];
  readonly conflicting: boolean;
}
export interface DebugRecovery {
  readonly status: 'absent' | 'complete' | 'partial';
  readonly uuid: string | null;
  readonly content_sha256: string;
  readonly data: DwarfData | null;
  readonly types: readonly DebugTypeRecord[];
  readonly functions: readonly DebugFunctionRecord[];
  readonly evidence: readonly Evidence[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Recover only supplied/embedded bytes. External UUID and exact CPU/subtype must match;
 * an optional host content pin must also match. Missing debug info is explicit absence.
 * No filesystem traversal, source-file access, symbol servers or target execution.
 * Returned raw DIE IDs are local to data; core entity IDs include slice/content identity.
 * Display declarations never drive structural types or ABI contracts. Structures
 * retain known size/member offsets with null alignment when DW_AT_alignment is absent;
 * ABI consumers must not replace that missing fact with guessed natural alignment.
 * Bitfields/unions and subroutine types retain raw evidence with explicit diagnostics.
 * Overlapping concrete definitions have null core signatures and linked conflicts. */
export function recoverDebugInfo(
  image: LoadedImage,
  context: OperationContext,
  external?: ExternalDebugInput,
): DebugRecovery {
  context.checkpoint(0);
  if (image.target.format === 'elf') {
    // Without embedded DWARF sections there is no debug data to recover (as for
    // a Mach-O image without __debug_info); only present DWARF stays unread.
    if (
      !external &&
      !image.sections.some(
        (section) => section.kind === 'section' && /^\.z?debug_/.test(section.name),
      )
    )
      return {
        status: 'absent',
        uuid: null,
        content_sha256: image.sha256,
        data: null,
        types: [],
        functions: [],
        evidence: [],
        diagnostics: [],
      };
    const diagnostic: Diagnostic = {
      code: 'unavailable_semantics',
      severity: 'warning',
      message:
        'ELF DWARF recovery is unavailable; native symbols remain usable, but debug types, signatures and source locations are not recovered.',
      evidence_ids: [],
    };
    if (external)
      throw new OperationError({ ...diagnostic, code: 'unsupported_target', severity: 'error' });
    return {
      status: 'partial',
      uuid: null,
      content_sha256: image.sha256,
      data: null,
      types: [],
      functions: [],
      evidence: [],
      diagnostics: [diagnostic],
    };
  }
  if (image.target.format !== 'macho') {
    if (external)
      throw new OperationError({
        code: 'unsupported_target',
        severity: 'error',
        message: 'External DWARF recovery requires a Mach-O image; PDB parsing is not implemented',
        evidence_ids: [],
      });
    return {
      status: 'absent',
      uuid: null,
      content_sha256: image.sha256,
      data: null,
      types: [],
      functions: [],
      evidence: [],
      diagnostics: [],
    };
  }
  const slice = image.slices.find((candidate) => candidate.id === image.selected_slice_id);
  if (!slice)
    throw new OperationError({
      code: 'invalid_input',
      severity: 'error',
      message: 'Selected image slice is missing',
      evidence_ids: [],
    });
  if (slice.size > 128n * 1024n * 1024n || (external?.bytes.length ?? 0) > 128 * 1024 * 1024)
    throw new OperationError({
      code: 'resource_limit',
      severity: 'error',
      message: 'Debug input exceeds 128 MiB',
      evidence_ids: [],
    });
  if (external && !artifactIdSchema.safeParse(external.artifact_id).success)
    throw new OperationError({
      code: 'invalid_input',
      severity: 'error',
      message: 'External debug input requires a host-owned artifact identity',
      evidence_ids: [],
    });
  const hash = external ? contentHash(external.bytes) : image.sha256;
  if (external?.expectedSha256 !== undefined && external.expectedSha256 !== hash)
    throw new OperationError({
      code: 'conflicting_evidence',
      severity: 'error',
      message: 'External debug content SHA256 does not match the authorized identity',
      evidence_ids: [],
    });
  const targetBytes = image.bytes.read(slice.offset, Number(slice.size));
  let header: ImageHeaders;
  try {
    header = selectDebugSections(targetBytes, context, external?.bytes);
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw new OperationError({ ...dwarfDiagnostic(String(error)), severity: 'error' });
  }
  const diagnostics = header.diagnostics.map(dwarfDiagnostic);
  if (!header.sections.get('__debug_info')?.length) {
    return {
      status: diagnostics.length ? 'partial' : 'absent',
      uuid: header.uuid || null,
      content_sha256: hash,
      data: null,
      types: [],
      functions: [],
      evidence: [],
      diagnostics,
    };
  }
  const parsed = parseDwarfSections(header.sections, context, { littleEndian: header.little });
  diagnostics.push(...parsed.diagnostics);
  const data = parsed.data;
  if (!data)
    return {
      status: parsed.status,
      uuid: header.uuid || null,
      content_sha256: hash,
      data,
      types: [],
      functions: [],
      evidence: [],
      diagnostics,
    };
  const ids = (record: string) => entityIdentity(image.selected_slice_id, 'dwarf', [hash, record]);
  const evidence: Evidence[] = [];
  const evidenceByRecord = new Map<string, string>();
  const evidenceIndex = new Map<string, number>();
  const evidenceFor = (record: string, claim: string): string => {
    const existing = evidenceByRecord.get(record);
    if (existing) return existing;
    const id = `evidence_${fingerprint([image.selected_slice_id, hash, record])}`;
    context.checkpoint(1);
    evidenceIndex.set(id, evidence.length);
    evidence.push({
      id,
      origin: external
        ? { kind: 'debug', artifact_id: external.artifact_id, record, identity_verified: true }
        : {
            kind: 'binary',
            range: {
              start: { image_id: image.id, space: 'file', value: slice.offset },
              size: slice.size,
            },
            description: `Embedded DWARF ${record}`,
          },
      claim,
      derived_from: [],
      conflicts_with: [],
      revision: 0,
    });
    evidenceByRecord.set(record, id);
    return id;
  };
  const raw = new Map(data.types.map((type) => [type.id, type]));
  const definitions = new Map<string, RecoveredType>();
  const types: DebugTypeRecord[] = [];
  const voidId = ids('void'),
    unknownId = ids('missing-type');
  types.push(
    {
      id: voidId,
      dwarf_id: null,
      display_name: 'void',
      definition: { kind: 'void' },
      evidence_ids: [],
    },
    {
      id: unknownId,
      dwarf_id: null,
      display_name: '<missing type>',
      definition: { kind: 'unknown', size: null },
      evidence_ids: [],
    },
  );
  const diagnostic = (record: string, message: string) => {
    if (diagnostics.length < 1000)
      diagnostics.push({
        code: 'unavailable_semantics',
        severity: 'warning',
        message,
        entity_id: ids(record),
        evidence_ids: [evidenceFor(record, 'DWARF record has an unsupported structural contract')],
      });
  };
  function definition(type: DebugType, active = new Set<string>()): RecoveredType {
    context.checkpoint(1);
    const cached = definitions.get(type.id);
    if (cached) return cached;
    const unknown: RecoveredType = {
      kind: 'unknown',
      size: type.byteSize === undefined ? null : BigInt(type.byteSize),
    };
    if (active.has(type.id) || active.size >= 128) {
      diagnostic(type.id, 'Cyclic or excessive DWARF by-value type reference');
      return unknown;
    }
    active.add(type.id);
    let result: RecoveredType = unknown;
    const target = type.targetTypeId ? raw.get(type.targetTypeId) : undefined;
    if (['typedef', 'const', 'volatile', 'restrict', 'atomic'].includes(type.kind) && target)
      result = definition(target, active);
    else if (type.kind === 'base') {
      const bits = (type.byteSize ?? 0) * 8;
      if ([2, 5, 6, 7, 8].includes(type.encoding ?? 0) && bits > 0 && bits <= 512)
        result = { kind: 'integer', bits, signed: type.encoding === 5 || type.encoding === 6 };
      else if (
        type.encoding === 4 &&
        (bits === 16 || bits === 32 || bits === 64 || bits === 80 || bits === 128)
      )
        result = { kind: 'float', bits };
    } else if (type.kind === 'pointer' && type.byteSize === 8)
      result = { kind: 'pointer', bits: 64, to: target ? ids(target.id) : voidId };
    else if (type.kind === 'array' && target) {
      const dimensions = type.dimensions?.length ? type.dimensions : [null];
      let element = ids(target.id);
      for (let dimension = dimensions.length - 1; dimension >= 0; dimension--) {
        context.checkpoint(1);
        result = { kind: 'array', element, count: dimensions[dimension] ?? null };
        if (dimension > 0) {
          const nestedId = ids(`${type.id}:dimension:${dimension}`);
          types.push({
            id: nestedId,
            dwarf_id: null,
            display_name: '',
            definition: result,
            evidence_ids: [evidenceFor(type.id, 'Array dimensions recorded by DWARF')],
          });
          element = nestedId;
        }
      }
    } else if (
      (type.kind === 'struct' || type.kind === 'class') &&
      (type.alignment === undefined ||
        (Number.isInteger(type.alignment) && type.alignment > 0 && type.alignment <= 65536))
    ) {
      const members = type.members ?? [];
      if (
        members.length <= 10000 &&
        members.every(
          (member) =>
            member.typeId !== undefined &&
            raw.has(member.typeId) &&
            member.byteOffset !== undefined &&
            member.bitSize === undefined &&
            member.bitOffset === undefined &&
            member.name.length <= 1024 &&
            (type.byteSize === undefined || member.byteOffset <= type.byteSize),
        )
      ) {
        result = {
          kind: 'structure',
          size: unknown.size,
          alignment: type.alignment ?? null,
          fields: members.map((member, index) => ({
            id: ids(`${type.id}:field:${index}`),
            name: member.name,
            offset: BigInt(member.byteOffset!),
            type_id: ids(member.typeId!),
          })),
        };
      }
    }
    if (result.kind === 'unknown')
      diagnostic(
        type.id,
        `Unsupported or incomplete structural DWARF ${type.kind} type; raw size/fields retained without inference from its name`,
      );
    definitions.set(type.id, result);
    return result;
  }
  for (const type of data.types)
    types.push({
      id: ids(type.id),
      dwarf_id: type.id,
      display_name: type.name,
      definition: definition(type),
      evidence_ids: [evidenceFor(type.id, 'Structural type recorded by DWARF')],
    });
  const signatureTypeId = (type: DebugSignatureType): string =>
    type.typeId && raw.has(type.typeId)
      ? ids(type.typeId)
      : type.kind === 'void'
        ? voidId
        : unknownId;
  const functions: DebugFunctionRecord[] = [];
  for (const fn of data.functions) {
    context.checkpoint(1);
    const evidenceId = evidenceFor(fn.id, 'Function ranges and source signature recorded by DWARF');
    const contract = fn.signature;
    let signature: Signature | null = null;
    // C-family concrete empty definitions establish zero arguments even when the
    // declaration syntax is old-style. Unspecified declarations/languages do not.
    const knownParameters =
      contract &&
      (contract.prototyped ||
        (contract.definition === true &&
          !contract.variadic &&
          contract.parameters.length === 0 &&
          [1, 2, 0xc, 0x1d, 0x2c].includes(contract.language ?? -1)));
    if (
      contract &&
      knownParameters &&
      (contract.callingConvention === undefined || contract.callingConvention === 1) &&
      contract.parameters.length <= 1000 &&
      contract.parameters.every((parameter) => (parameter.name?.length ?? 0) <= 1024)
    ) {
      signature = {
        abi: image.target.abi,
        return_type: signatureTypeId(contract.returnType),
        parameters: contract.parameters.map((parameter, index) => ({
          id: ids(`${fn.id}:parameter:${index}`),
          name: parameter.name ?? null,
          type_id: signatureTypeId(parameter.type),
        })),
        variadic: contract.variadic,
        noreturn: contract.nonReturning === true,
        evidence_ids: [evidenceId],
      };
    } else
      diagnostic(
        fn.id,
        'DWARF function has an unspecified or unsupported calling contract; no core signature was inferred',
      );
    for (const range of fn.ranges ?? []) {
      context.checkpoint(image.mappings.length + 1);
      if (
        image.address_map
          .spans({ image_id: image.id, space: 'va', value: range.start }, range.end - range.start)
          .some((span) => span.kind !== 'mapped')
      ) {
        signature = null;
        if (diagnostics.length < 1000)
          diagnostics.push({
            code: 'invalid_address',
            severity: 'warning',
            message: 'DWARF function range is not fully file-backed in the selected image',
            address: { image_id: image.id, space: 'va', value: range.start },
            evidence_ids: [evidenceId],
          });
      }
    }
    functions.push({
      id: ids(fn.id),
      dwarf: fn,
      signature,
      evidence_ids: [evidenceId],
      conflicting: false,
    });
  }
  // Keep independent claims; never silently choose one overlapping concrete definition.
  const ranges = functions
    .flatMap((fn, index) => (fn.dwarf.ranges ?? []).map((range) => ({ ...range, index })))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const conflicts = new Set<string>();
  for (let i = 0; i < ranges.length; i++) {
    const left = ranges[i]!;
    for (let j = i + 1; j < ranges.length && ranges[j]!.start < left.end; j++) {
      context.checkpoint(1);
      const right = ranges[j]!;
      if (left.index === right.index) continue;
      const a = functions[left.index]!,
        b = functions[right.index]!;
      const pair = [a.id, b.id].sort().join(':');
      if (conflicts.has(pair)) continue;
      conflicts.add(pair);
      functions[left.index] = { ...a, signature: null, conflicting: true };
      functions[right.index] = { ...b, signature: null, conflicting: true };
      const aEvidence = a.evidence_ids[0]!,
        bEvidence = b.evidence_ids[0]!;
      for (const [id, other] of [
        [aEvidence, bEvidence],
        [bEvidence, aEvidence],
      ] as const) {
        const index = evidenceIndex.get(id)!;
        const record = evidence[index]!;
        if (record.conflicts_with.length >= 1000)
          throw new OperationError({
            code: 'resource_limit',
            severity: 'error',
            message: 'DWARF conflict evidence exceeds 1000 references',
            evidence_ids: [],
          });
        evidence[index] = { ...record, conflicts_with: [...record.conflicts_with, other] };
      }
      if (diagnostics.length < 1000)
        diagnostics.push({
          code: 'conflicting_evidence',
          severity: 'warning',
          message:
            'Distinct DWARF function definitions claim overlapping machine code; both claims are retained',
          evidence_ids: [aEvidence, bEvidence],
        });
    }
  }
  for (const variable of data.variables ?? [])
    evidenceFor(variable.id, 'Scoped symbolic variable location recorded by DWARF');
  for (const scope of data.inlineScopes ?? [])
    evidenceFor(scope.id, 'Inline call scope recorded by DWARF');
  if (data.lines.length)
    evidenceFor('line-tables', 'Half-open source address intervals recorded by DWARF');
  const result: DebugRecovery = {
    status: diagnostics.length ? 'partial' : 'complete',
    uuid: header.uuid || null,
    content_sha256: hash,
    data,
    types,
    functions,
    evidence,
    diagnostics,
  };
  boundDebugOutput(result, context);
  return result;
}

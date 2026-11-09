import type { z } from 'zod';
import {
  artifactIdSchema,
  buildOnce,
  contentHash,
  entityIdentity,
  fingerprint,
  OperationError,
  type debugSummarySchema,
  type Diagnostic,
  type Evidence,
  type LoadedImage,
  type OperationContext,
  type RecoveredType,
  type Signature,
  type SymbolRecord,
  useBuilt,
} from '../../core/index.js';
import {
  boundDebugOutput,
  dwarfDiagnostic,
  parseDwarfSections,
  type DebugFunction,
  type DebugSignatureType,
  type DebugType,
  type DwarfData,
  type DwarfSections,
} from '../dwarf/index.js';
import { parsePdb, type PdbResult } from '../pdb/index.js';
import { selectElfDebugSections } from './elf.js';
import { selectDebugSections } from './macho.js';
import { matchPdb, unwindFrames } from './pe.js';
export { debuglinkCrc, selectElfDebugSections } from './elf.js';
export { selectDebugSections } from './macho.js';
export { debugContextAt, frameVariableNames, variableLocationsAt } from './queries.js';

/** The host authorizes and stores this artifact before calling recovery. No path is accepted.
 * Mach-O: the DWARF file of a dSYM (thin or universal). ELF: a separate debug file such as
 * `objcopy --only-keep-debug` output. */
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
  /** Declared tag or typedef name of a structure, or `union tag` / typedef name of a
   * union (an `unknown` definition): printed names only, never structural keys. */
  readonly spelling?: string;
  /** Structure field names are the declared member names. */
  readonly member_names?: true;
}

/** Source names a declaration gives its type: a struct's tag (or the typedef naming it,
 * as the source spelled it at that use) with its member names; a union's tag. A
 * qualifier (`const struct shape`) spells as what it qualifies. */
function declaredSpelling(
  type: DebugType,
  recovered: RecoveredType,
  raw: ReadonlyMap<string, DebugType>,
): Pick<DebugTypeRecord, 'spelling' | 'member_names'> {
  for (
    let depth = 0;
    depth < 16 && ['const', 'volatile', 'restrict', 'atomic'].includes(type.kind);
    depth++
  ) {
    const target = type.targetTypeId === undefined ? undefined : raw.get(type.targetTypeId);
    if (!target) return {};
    type = target;
  }
  if (!/^[A-Za-z_]\w{0,254}$/.test(type.name)) return {};
  if (recovered.kind === 'structure' && (type.kind === 'struct' || type.kind === 'class'))
    return { spelling: type.name, member_names: true };
  if (recovered.kind === 'structure' && type.kind === 'typedef')
    return { spelling: type.name, member_names: true };
  if (recovered.kind === 'unknown' && type.kind === 'union')
    return { spelling: `union ${type.name}` };
  return {};
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
  /** Debug data exists in the image or supplied artifact that this recovery did not
   * decode (an unreadable unit, an unsupported compression, a malformed section table).
   * Its declarations are unknown, so local type inference cannot be checked against them.
   * Records that were decoded but have no structural representation (a union, a
   * function type) are `unknown` types with diagnostics: status `partial`, not undecoded. */
  readonly undecoded: boolean;
  /** Mach-O LC_UUID of the image (or matched dSYM). */
  readonly uuid: string | null;
  /** ELF GNU build ID (lowercase hex) of the image or matched debug file. */
  readonly build_id: string | null;
  /** How a supplied debug artifact was matched; null for embedded debug data. A PDB
   * matches by the GUID and age of the image's CodeView (RSDS) record. */
  readonly matched_by: 'uuid' | 'build-id' | 'debuglink' | 'guid-age' | null;
  /** The matched PDB's identity. */
  readonly pdb: { readonly guid: string; readonly age: number } | null;
  readonly content_sha256: string;
  readonly data: DwarfData | null;
  readonly types: readonly DebugTypeRecord[];
  readonly functions: readonly DebugFunctionRecord[];
  readonly evidence: readonly Evidence[];
  readonly diagnostics: readonly Diagnostic[];
}
interface DebugHeaders {
  readonly little: boolean;
  readonly sections: DwarfSections;
  readonly diagnostics: readonly string[];
  readonly uuid: string | null;
  readonly build_id: string | null;
  readonly matched_by: DebugRecovery['matched_by'];
}

function emptyRecovery(
  hash: string,
  identity: Pick<DebugRecovery, 'uuid' | 'build_id' | 'matched_by' | 'pdb'>,
  diagnostics: Diagnostic[],
  undecoded: boolean,
): DebugRecovery {
  return {
    status: diagnostics.length ? 'partial' : 'absent',
    undecoded,
    ...identity,
    content_sha256: hash,
    data: null,
    types: [],
    functions: [],
    evidence: [],
    diagnostics,
  };
}

/** Recover only supplied/embedded bytes. External identity must match exactly (Mach-O:
 * UUID and CPU/subtype; ELF: GNU build ID, else the `.gnu_debuglink` CRC-32); an optional
 * host content pin must also match. Missing debug info is explicit absence.
 * No filesystem traversal, source-file access, symbol servers or target execution.
 * Returned raw DIE IDs are local to data; core entity IDs include slice/content identity.
 * Display declarations never drive structural types or ABI contracts. Structures
 * retain known size/member offsets with null alignment when DW_AT_alignment is absent;
 * ABI consumers must not replace that missing fact with guessed natural alignment.
 * Bitfields/unions and subroutine types retain raw evidence with explicit diagnostics.
 * Overlapping concrete definitions have null core signatures and linked conflicts.
 * The image's own recovery (embedded DWARF or its imported companion) is built once per
 * loaded image (`buildOnce`): every operation pays its recorded cost, cached or not. */
export function recoverDebugInfo(
  image: LoadedImage,
  context: OperationContext,
  external?: ExternalDebugInput,
): DebugRecovery {
  if (external) return computeDebugInfo(image, recoveryContext(context), external);
  const cached = recoveries.get(image);
  const result = cached
    ? useBuilt(context, cached)
    : buildOnce(context, 'debug-recovery', (quiet) =>
        computeDebugInfo(image, recoveryContext(quiet)),
      );
  recoveries.set(image, result);
  return result;
}
/** Conservative wire-size bound (`boundDebugOutput`) of one debug recovery. */
export const DEBUG_RECOVERY_BYTES = 256 * 1024 * 1024;
/** A recovery is a per-image structure every request shares, not one request's output: its
 * size is bounded by DEBUG_RECOVERY_BYTES (with the readers' own count and text limits),
 * never by the caller's output budget, so one cached recovery serves every caller alike.
 * Work, deadline and cancellation remain the caller's. */
function recoveryContext(context: OperationContext): OperationContext {
  return { ...context, budget: { ...context.budget, output_bytes: DEBUG_RECOVERY_BYTES } };
}
const recoveries = new WeakMap<LoadedImage, DebugRecovery>();

function computeDebugInfo(
  image: LoadedImage,
  context: OperationContext,
  external?: ExternalDebugInput,
): DebugRecovery {
  context.checkpoint(0);
  // A companion imported with the image is the supplied artifact unless the caller passes one.
  const companion = image.companion;
  if (!external && companion)
    external = {
      bytes: companion.bytes.read(0n, companion.bytes.length),
      artifact_id: `artifact_${companion.sha256}`,
      expectedSha256: companion.sha256,
    };
  // A PE image's debug information is a PDB; embedded (MinGW) DWARF is not read.
  if (image.target.format === 'pe' && !external)
    return emptyRecovery(
      image.sha256,
      { uuid: null, build_id: null, matched_by: null, pdb: null },
      [],
      false,
    );
  if (!['macho', 'elf', 'pe'].includes(image.target.format))
    throw new OperationError({
      code: 'unsupported_target',
      severity: 'error',
      message: 'Debug recovery requires a Mach-O, ELF or PE image',
      evidence_ids: [],
    });
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
  const records =
    image.target.format === 'pe'
      ? pdbRecords(image, context, external!.bytes)
      : dwarfRecords(image, context, slice, hash, external);
  // A recovery here: no debug data, or none that could be decoded.
  if ('status' in records) return records;
  const { identity, diagnostics, data, unread } = records;
  const source = image.target.format === 'pe' ? 'PDB' : 'DWARF';
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
            description: `Embedded ${source} ${record}`,
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
        evidence_ids: [
          evidenceFor(record, `${source} record has an unsupported structural contract`),
        ],
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
      diagnostic(type.id, `Cyclic or excessive ${source} by-value type reference`);
      return unknown;
    }
    active.add(type.id);
    let result: RecoveredType = unknown;
    const target = type.targetTypeId ? raw.get(type.targetTypeId) : undefined;
    if (['typedef', 'const', 'volatile', 'restrict', 'atomic'].includes(type.kind)) {
      // A qualifier or typedef without DW_AT_type qualifies void (`const void`).
      if (target) result = definition(target, active);
      else if (type.targetTypeId === undefined) result = { kind: 'void' };
    } else if (type.kind === 'enum' && target) {
      // An enumeration is stored as its underlying integer type (DW_AT_type, DWARF 3+).
      const underlying = definition(target, active);
      if (underlying.kind === 'integer') result = underlying;
    } else if (type.kind === 'base') {
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
            evidence_ids: [evidenceFor(type.id, `Array dimensions recorded by ${source}`)],
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
    // A typedef or qualifier of an unknown type repeats its target's diagnostic.
    if (result.kind === 'unknown' && !(target && definitions.get(target.id)?.kind === 'unknown'))
      diagnostic(
        type.id,
        `Unsupported or incomplete structural ${source} ${type.kind} type; raw size/fields retained without inference from its name`,
      );
    definitions.set(type.id, result);
    return result;
  }
  for (const type of data.types) {
    const recovered = definition(type);
    types.push({
      id: ids(type.id),
      dwarf_id: type.id,
      display_name: type.name,
      definition: recovered,
      evidence_ids: [evidenceFor(type.id, `Structural type recorded by ${source}`)],
      ...declaredSpelling(type, recovered, raw),
    });
  }
  const signatureTypeId = (type: DebugSignatureType): string =>
    type.typeId && raw.has(type.typeId)
      ? ids(type.typeId)
      : type.kind === 'void'
        ? voidId
        : unknownId;
  const functions: DebugFunctionRecord[] = [];
  for (const fn of data.functions) {
    context.checkpoint(1);
    const evidenceId = evidenceFor(
      fn.id,
      `Function ranges and source signature recorded by ${source}`,
    );
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
        `${source} function has an unspecified or unsupported calling contract; no core signature was inferred`,
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
            message: `${source} function range is not fully file-backed in the selected image`,
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
            message: `${source} conflict evidence exceeds 1000 references`,
            evidence_ids: [],
          });
        evidence[index] = { ...record, conflicts_with: [...record.conflicts_with, other] };
      }
      if (diagnostics.length < 1000)
        diagnostics.push({
          code: 'conflicting_evidence',
          severity: 'warning',
          message: `Distinct ${source} function definitions claim overlapping machine code; both claims are retained`,
          evidence_ids: [aEvidence, bEvidence],
        });
    }
  }
  for (const variable of data.variables ?? [])
    evidenceFor(variable.id, `Scoped symbolic variable location recorded by ${source}`);
  for (const scope of data.inlineScopes ?? [])
    evidenceFor(scope.id, `Inline call scope recorded by ${source}`);
  for (const symbol of data.publics ?? [])
    evidenceFor(symbol.id, 'Public symbol name and address recorded by the PDB');
  if (data.lines.length)
    evidenceFor('line-tables', `Half-open source address intervals recorded by ${source}`);
  const result: DebugRecovery = {
    status: diagnostics.length ? 'partial' : 'complete',
    // Sections left unread (compression, relocations) or skipped units/DIEs hide
    // declarations; unrepresentable types and functions without a supported contract
    // are diagnosed records (see recoverTypes for the per-function consequence).
    undecoded: unread || data.undecoded === true,
    ...identity,
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

/** Decoded debug records before their structural interpretation. */
interface DebugRecords {
  readonly identity: Pick<DebugRecovery, 'uuid' | 'build_id' | 'matched_by' | 'pdb'>;
  readonly diagnostics: Diagnostic[];
  readonly data: DwarfData;
  /** Debug data that may hold declarations was not read. */
  readonly unread: boolean;
}

/** The PDB of a PE image, matched by the GUID and age of its CodeView (RSDS) record; frame
 * variables placed through the image's unwind data. */
function pdbRecords(
  image: LoadedImage,
  context: OperationContext,
  bytes: Uint8Array,
): DebugRecords {
  const match = matchPdb(image, bytes, context);
  let parsed: PdbResult;
  try {
    parsed = parsePdb(bytes, context, {
      sections: image.sections.map((section) => section.virtual_range.start.value),
      frame: unwindFrames(image),
    });
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw new OperationError({ ...dwarfDiagnostic(`PDB: ${String(error)}`), severity: 'error' });
  }
  boundDebugOutput(parsed.data, context);
  return {
    identity: {
      uuid: null,
      build_id: null,
      matched_by: 'guid-age',
      pdb: { guid: match.guid, age: match.age },
    },
    // Counted limitations ("PDB: 12 procedures have no procedure type") are unsupported
    // records, not malformed ones.
    diagnostics: parsed.data.diagnostics.map((message) => ({
      ...dwarfDiagnostic(message),
      ...(/^PDB: \d/.test(message) ? { code: 'unavailable_semantics' as const } : {}),
    })),
    data: parsed.data,
    unread: false,
  };
}

/** DWARF of a Mach-O or ELF image: embedded, or in its matched companion file. */
function dwarfRecords(
  image: LoadedImage,
  context: OperationContext,
  slice: LoadedImage['slices'][number],
  hash: string,
  external?: ExternalDebugInput,
): DebugRecords | DebugRecovery {
  const none = { uuid: null, build_id: null, matched_by: null, pdb: null } as const;
  const targetBytes = image.bytes.read(slice.offset, Number(slice.size));
  let header: DebugHeaders;
  try {
    if (image.target.format === 'macho') {
      const macho = selectDebugSections(targetBytes, context, external?.bytes);
      header = {
        ...macho,
        uuid: macho.uuid || null,
        build_id: null,
        matched_by: external ? 'uuid' : null,
      };
    } else {
      const elf = selectElfDebugSections(targetBytes, context, external?.bytes);
      header = {
        little: true,
        sections: elf.sections,
        diagnostics: elf.diagnostics,
        uuid: null,
        build_id: elf.buildId,
        matched_by: elf.matched_by,
      };
      if (!external && !elf.present)
        return emptyRecovery(
          hash,
          { ...none, build_id: elf.buildId, matched_by: elf.matched_by },
          [],
          false,
        );
    }
  } catch (error) {
    if (error instanceof OperationError) throw error;
    // Embedded ELF debug data is optional evidence: a malformed table hides its
    // declarations but never fails an image the loader accepted.
    if (image.target.format === 'elf' && !external)
      return emptyRecovery(hash, none, [dwarfDiagnostic(`ELF debug data: ${String(error)}`)], true);
    throw new OperationError({ ...dwarfDiagnostic(String(error)), severity: 'error' });
  }
  const identity = {
    uuid: header.uuid,
    build_id: header.build_id,
    matched_by: header.matched_by,
    pdb: null,
  };
  const diagnostics = header.diagnostics.map(dwarfDiagnostic);
  if (!header.sections.get('__debug_info')?.length)
    return emptyRecovery(hash, identity, diagnostics, diagnostics.length > 0);
  const parsed = parseDwarfSections(header.sections, context, { littleEndian: header.little });
  diagnostics.push(...parsed.diagnostics);
  const data = parsed.data;
  if (!data)
    return {
      status: parsed.status,
      undecoded: parsed.status === 'partial',
      ...identity,
      content_sha256: hash,
      data,
      types: [],
      functions: [],
      evidence: [],
      diagnostics,
    };
  // Sections left unread (compression, relocations) hide declarations.
  return { identity, diagnostics, data, unread: header.diagnostics.length > 0 };
}

/** Function and global symbols a companion debug file declares where the image has none (a
 * stripped image, a PE image and its PDB): functions at their debug entry, sized by a single
 * contiguous range, globals at their static address (DW_OP_addr, S_GDATA32) and PDB publics. Each carries the debug record's evidence. Seeds and
 * names discovery like any symbol; never replaces an image symbol. */
export function companionSymbols(
  image: LoadedImage,
  recovery: DebugRecovery,
  context: OperationContext,
): { readonly symbols: SymbolRecord[]; readonly evidence: Evidence[] } {
  const taken = new Set<bigint>();
  for (const symbol of image.symbols)
    if (symbol.address?.space === 'va' && (symbol.kind === 'function' || symbol.kind === 'object'))
      taken.add(symbol.address.value);
  const evidence = new Map(recovery.evidence.map((record) => [record.id, record]));
  const symbols: SymbolRecord[] = [],
    used = new Map<string, Evidence>();
  const limit = Math.max(0, 100_000 - image.symbols.length);
  const add = (
    record: string,
    name: string,
    kind: 'function' | 'object',
    address: bigint,
    size: bigint | null,
    proof: readonly string[],
  ) => {
    context.checkpoint(1);
    // Printable ASCII; inner spaces allowed (C++ names: `std::map<int, char>::find`).
    if (
      symbols.length >= limit ||
      taken.has(address) ||
      !/^[\x21-\x7e](?:[\x20-\x7e]{0,4094}[\x21-\x7e])?$/.test(name)
    )
      return;
    const translated = image.address_map.translate(
      { image_id: image.id, space: 'va', value: address },
      'va',
    );
    // Code must be file-backed; a global may live in zero-fill storage (.bss).
    if (translated.kind === 'unmapped' || (kind === 'function' && translated.kind !== 'mapped'))
      return;
    taken.add(address);
    for (const id of proof) {
      const item = evidence.get(id);
      if (item) used.set(id, item);
    }
    symbols.push({
      id: entityIdentity(image.selected_slice_id, 'debug-symbol', [
        recovery.content_sha256,
        record,
      ]),
      original_name: name,
      display_name: null,
      evidence_ids: [...proof],
      kind,
      address: { image_id: image.id, space: 'va', value: address },
      size,
      binding: 'unknown',
    });
  };
  const typesById = new Map(recovery.types.map((record) => [record.id, record.definition]));
  const typesByDwarf = new Map(
    recovery.types.flatMap((record) => (record.dwarf_id ? [[record.dwarf_id, record.id]] : [])),
  );
  // Byte size of a debug type, when every part of it is established.
  const extent = (id: string, depth = 0): bigint | null => {
    const definition = typesById.get(id);
    if (!definition || depth > 32) return null;
    switch (definition.kind) {
      case 'integer':
      case 'float':
      case 'pointer':
        return definition.bits % 8 ? null : BigInt(definition.bits / 8);
      case 'structure':
      case 'unknown':
        return definition.size;
      case 'array': {
        const element = extent(definition.element, depth + 1);
        return element === null || definition.count === null ? null : element * definition.count;
      }
      default:
        return null;
    }
  };
  for (const fn of recovery.functions) {
    if (fn.conflicting) continue;
    const ranges = fn.dwarf.ranges ?? [];
    add(
      fn.dwarf.id,
      fn.dwarf.name,
      'function',
      fn.dwarf.address,
      ranges.length === 1 ? ranges[0]!.end - ranges[0]!.start : null,
      fn.evidence_ids,
    );
  }
  for (const variable of recovery.data?.variables ?? []) {
    const location = variable.locations.length === 1 ? variable.locations[0]!.location : null;
    if (variable.functionAddress !== undefined || location?.kind !== 'address') continue;
    // The evidence id recoverDebugInfo gave this variable's record.
    const proof = `evidence_${fingerprint([image.selected_slice_id, recovery.content_sha256, variable.id])}`;
    const type = variable.typeId === undefined ? undefined : typesByDwarf.get(variable.typeId);
    add(variable.id, variable.name, 'object', location.address, type ? extent(type) : null, [
      proof,
    ]);
  }
  // Linker publics (PDB) name what no debug record declares: code compiled without debug
  // information, imported data. Compiler-generated constants (string literals `??_C@`,
  // floating-point pools `__real@`/`__xmm@`) are left to the data they hold.
  for (const symbol of recovery.data?.publics ?? []) {
    if (/^(\?\?_C@|__real@|__xmm@)/.test(symbol.name)) continue;
    const proof = `evidence_${fingerprint([image.selected_slice_id, recovery.content_sha256, symbol.id])}`;
    add(symbol.id, symbol.name, symbol.code ? 'function' : 'object', symbol.address, null, [proof]);
  }
  return { symbols, evidence: [...used.values()] };
}

/** The `binary_info` summary of the image's debug information. Cancellation and budget
 * limits fail it; any other recovery error is reported as a partial summary. */
export function debugSummary(
  image: LoadedImage,
  context: OperationContext,
): z.infer<typeof debugSummarySchema> {
  const source = image.companion ? 'companion' : 'embedded';
  let recovery: DebugRecovery;
  try {
    recovery = recoverDebugInfo(image, context);
  } catch (error) {
    if (
      !(error instanceof OperationError) ||
      error.code === 'cancelled' ||
      error.code === 'resource_limit'
    )
      throw error;
    return {
      source,
      status: 'partial',
      matched_by: null,
      uuid: null,
      build_id: null,
      pdb: null,
      companion_sha256: image.companion?.sha256 ?? null,
      functions: 0,
      types: 0,
      variables: 0,
      lines: 0,
      diagnostics: [error.diagnostic.message.slice(0, 1024)],
    };
  }
  return {
    source: recovery.status === 'absent' && !image.companion ? 'none' : source,
    status: recovery.status,
    matched_by: recovery.matched_by,
    uuid: recovery.uuid,
    build_id: recovery.build_id,
    pdb: recovery.pdb,
    companion_sha256: image.companion?.sha256 ?? null,
    functions: recovery.functions.length,
    types: recovery.data?.types.length ?? 0,
    variables: recovery.data?.variables?.length ?? 0,
    lines: recovery.data?.lines.length ?? 0,
    diagnostics: recovery.diagnostics
      .slice(0, 16)
      .map((diagnostic) => diagnostic.message.slice(0, 1024)),
  };
}

import {
  entityIdentity,
  fingerprint,
  type AddressRange,
  type Diagnostic,
  type Evidence,
  type LoadedImage,
  type OperationContext,
} from '../../core/index.js';

export type PdbIdentity =
  | { readonly kind: 'rsds'; readonly guid: string; readonly age: bigint }
  | { readonly kind: 'nb10'; readonly timestamp: bigint; readonly age: bigint };
export interface CodeViewReference {
  readonly id: string;
  readonly record: AddressRange;
  readonly raw_data: AddressRange | null;
  readonly signature: bigint;
  readonly identity: PdbIdentity | null;
  /** Untrusted embedded text. Never resolved, opened, fetched or used as authorization. */
  readonly path: string | null;
  readonly status: 'identity' | 'conflicting' | 'unsupported';
  readonly evidence_ids: readonly string[];
}
export interface CodeViewReferences {
  readonly state: 'absent' | 'complete' | 'partial';
  readonly references: readonly CodeViewReference[];
  readonly evidence: readonly Evidence[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Exposes loader-validated RSDS/NB10 identity references, not PDB type recovery.
 * The GUID's first three fields are little-endian; its final eight bytes are not.
 * Multiple different identities remain conflicting facts, never last-writer-wins.
 * Paths are inert even when they resemble local files, UNC shares or URLs.
 */
export function recoverCodeViewReferences(
  input: { readonly image: LoadedImage; readonly revision: number; readonly max_records?: number },
  context: OperationContext,
): CodeViewReferences {
  const { image, revision } = input,
    limit = input.max_records ?? 256;
  if (
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    limit > 1000
  )
    throw new RangeError('Invalid CodeView recovery bounds');
  context.checkpoint(0);
  const references: CodeViewReference[] = [],
    evidence: Evidence[] = [],
    diagnostics: Diagnostic[] = [],
    keys: (string | null)[] = [];
  let partial = false;
  for (const header of image.headers) {
    context.checkpoint(1);
    if (header.kind !== 'debug_record') continue;
    const fields = new Map(header.fields.map((field) => [field.name, field]));
    const signature = fields.get('CodeViewSignature');
    if (signature?.kind !== 'integer') continue;
    if (references.length >= limit) {
      partial = true;
      diagnostics.push({
        code: 'resource_limit',
        severity: 'warning',
        message: 'CodeView reference bound reached',
        evidence_ids: [],
      });
      break;
    }
    const age = fields.get('PdbAge'),
      path = fields.get('PdbPath'),
      guid = fields.get('PdbGuidBytes'),
      timestamp = fields.get('PdbTimeDateStamp'),
      offset = fields.get('PdbOffset'),
      raw = fields.get('RawData');
    let identity: PdbIdentity | null = null,
      key: string | null = null;
    if (
      age?.kind === 'integer' &&
      age.value >= 0n &&
      age.value <= 0xffffffffn &&
      path?.kind === 'text'
    ) {
      if (
        signature.value === 0x53445352n &&
        guid?.kind === 'text' &&
        /^[0-9a-fA-F]{32}$/.test(guid.value)
      ) {
        const bytes = Buffer.from(guid.value, 'hex');
        const canonical = `${bytes.readUInt32LE(0).toString(16).padStart(8, '0')}-${bytes.readUInt16LE(4).toString(16).padStart(4, '0')}-${bytes.readUInt16LE(6).toString(16).padStart(4, '0')}-${bytes.subarray(8, 10).toString('hex')}-${bytes.subarray(10).toString('hex')}`;
        identity = { kind: 'rsds', guid: canonical, age: age.value };
        key = `rsds:${canonical}:${age.value}`;
      } else if (
        signature.value === 0x3031424en &&
        timestamp?.kind === 'integer' &&
        offset?.kind === 'integer' &&
        timestamp.value >= 0n &&
        timestamp.value <= 0xffffffffn &&
        offset.value >= 0n &&
        offset.value <= 0xffffffffn
      ) {
        identity = { kind: 'nb10', timestamp: timestamp.value, age: age.value };
        // The NB10 offset is a location, not part of the timestamp/age identity.
        key = `nb10:${timestamp.value}:${age.value}`;
      }
    }
    const id = entityIdentity(image.selected_slice_id, 'codeview-reference', [
      header.range.start.space,
      header.range.start.value,
    ]);
    const proof = `evidence_${fingerprint([id, revision, 'codeview-identity-v1'])}`;
    references.push({
      id,
      record: header.range,
      raw_data: raw?.kind === 'bytes' ? raw.range : null,
      signature: signature.value,
      identity,
      path: path?.kind === 'text' ? path.value : null,
      status: identity ? 'identity' : 'unsupported',
      evidence_ids: [proof],
    });
    keys.push(key);
    evidence.push({
      id: proof,
      origin: {
        kind: 'binary',
        range: raw?.kind === 'bytes' ? raw.range : header.range,
        description: 'PE CodeView reference bytes',
      },
      claim: identity
        ? 'Embedded PDB identity reference; no PDB was opened or fetched'
        : 'CodeView bytes without a supported complete PDB identity',
      derived_from: [...header.evidence_ids],
      conflicts_with: [],
      revision,
    });
    if (!identity) {
      partial = true;
      if (diagnostics.length < 256)
        diagnostics.push({
          code: 'unavailable_semantics',
          severity: 'info',
          message: 'CodeView record has no supported complete RSDS/NB10 identity',
          entity_id: id,
          evidence_ids: [proof],
        });
    }
  }
  const distinct = new Set(keys.filter((key): key is string => key !== null));
  if (distinct.size > 1) {
    partial = true;
    for (let i = 0; i < references.length; i++) {
      context.checkpoint(references.length);
      if (keys[i] === null) continue;
      references[i] = { ...references[i]!, status: 'conflicting' };
      evidence[i] = {
        ...evidence[i]!,
        conflicts_with: evidence
          .filter((_, j) => keys[j] !== null && keys[j] !== keys[i])
          .map((item) => item.id),
      };
    }
    diagnostics.push({
      code: 'conflicting_evidence',
      severity: 'warning',
      message: 'The image contains different PDB identities; none was selected',
      evidence_ids: evidence.filter((_, i) => keys[i] !== null).map((item) => item.id),
    });
  }
  return {
    state: partial ? 'partial' : references.length ? 'complete' : 'absent',
    references,
    evidence,
    diagnostics,
  };
}

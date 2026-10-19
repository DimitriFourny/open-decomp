import {
  entityIdentity,
  fingerprint,
  type CanonicalValue,
  type Evidence,
  type FunctionRecord,
  type LoadedImage,
  type OperationContext,
  type RecoveredType,
} from '../../core/index.js';
import type { SuppliedSignature, SuppliedTypeRecord } from '../../analysis/types/index.js';
import { objcImageIndex, type ObjCIvarFact } from '../../metadata/runtime/objc-index.js';
import {
  parseObjCMethodType,
  parseObjCType,
  selectorArity,
  type ObjCEncodedType,
} from '../../metadata/runtime/objc-types.js';

/** C spellings of Objective-C reference roles; plain C pointers keep `T*`. */
const ROLE_SPELLING: Readonly<Record<string, string>> = {
  object: 'id',
  class: 'Class',
  selector: 'SEL',
};

/** The selected function's declared interface from its unique Objective-C method
 * record: the compiler's type encoding gives every formal and the result (a
 * method cannot be variadic in this encoding); `self` of an instance method is a
 * pointer to the class instance layout declared by its ivars (the class's own and
 * its in-image superclasses', at their static offsets). Unparseable encodings,
 * conflicting records and aggregates yield no signature. */
export function objcMethodSignature(
  image: LoadedImage,
  revision: number,
  fn: FunctionRecord,
  abi: SuppliedSignature['signature']['abi'],
  context: OperationContext,
): {
  readonly signature: SuppliedSignature;
  readonly types: readonly SuppliedTypeRecord[];
  readonly evidence: readonly Evidence[];
} | null {
  if (image.target.format !== 'macho' || fn.entry.space !== 'va') return null;
  const index = objcImageIndex(image, revision, context);
  const records = index?.methods.get(fn.entry.value);
  const method = records?.[0];
  if (
    !index ||
    !method ||
    !method.type ||
    !records.every(
      (item) =>
        item.owner === method.owner &&
        item.name === method.name &&
        item.kind === method.kind &&
        item.type === method.type,
    )
  )
    return null;
  const parsed = parseObjCMethodType(method.type);
  if (!parsed || parsed.parameters.length !== selectorArity(method.name) + 2) return null;
  const slice = image.selected_slice_id;
  const evidence = new Map<string, Evidence>();
  for (const item of method.evidence) evidence.set(item.id, item);
  const proof = method.evidence.slice(0, 1).map((item) => item.id);
  const types = new Map<string, SuppliedTypeRecord>();
  const record = (
    definition: RecoveredType,
    extra: Pick<SuppliedTypeRecord, 'spelling' | 'member_names'> = {},
    evidence_ids: readonly string[] = proof,
  ): string => {
    const id = entityIdentity(slice, 'objc-type', [
      fingerprint(definition as unknown as CanonicalValue),
      extra.spelling ?? null,
    ]);
    if (!types.has(id))
      types.set(id, {
        id,
        definition,
        source: 'runtime',
        status: 'established',
        evidence_ids,
        ...extra,
      });
    return id;
  };
  const unknown = record({ kind: 'unknown', size: null });
  const encoded = (type: ObjCEncodedType): string => {
    const abiType = type.abi;
    if (abiType.kind === 'void') return record({ kind: 'void' });
    if (abiType.kind === 'integer')
      return record({ kind: 'integer', bits: abiType.bits, signed: abiType.signed });
    if (abiType.kind === 'float' && (abiType.bits === 32 || abiType.bits === 64))
      return record({ kind: 'float', bits: abiType.bits });
    if (type.role === 'string')
      return record(
        { kind: 'pointer', bits: 64, to: record({ kind: 'integer', bits: 8, signed: true }) },
        { spelling: 'char*' },
      );
    const spelling = ROLE_SPELLING[type.role];
    return record(
      { kind: 'pointer', bits: 64, to: unknown },
      spelling === undefined ? {} : { spelling },
    );
  };
  // Category methods belong to their class: `Class(Category)` -> `Class`.
  const owner = method.owner.replace(/\(.*\)$/, '');
  let self: string | undefined;
  if (method.kind === 'instance' && /^[A-Za-z_$][\w$]*$/.test(owner)) {
    const ivars: ObjCIvarFact[] = [];
    const seen = new Set<string>();
    for (let name: string | undefined = owner; name && !seen.has(name) && seen.size < 64;) {
      context.checkpoint(1);
      seen.add(name);
      ivars.push(...(index.ivars.get(name) ?? []));
      name = index.superclasses.get(name);
    }
    const fields: Extract<RecoveredType, { kind: 'structure' }>['fields'][number][] = [];
    const occupied: { start: bigint; end: bigint }[] = [];
    for (const ivar of ivars.sort((a, b) => (a.offset < b.offset ? -1 : 1))) {
      context.checkpoint(1);
      const type = ivar.type === null ? null : parseObjCType(ivar.type);
      const bytes =
        type?.abi.kind === 'pointer'
          ? 8n
          : type?.abi.kind === 'integer' || type?.abi.kind === 'float'
            ? BigInt(type.abi.bits / 8)
            : null;
      const end = ivar.offset + (bytes ?? 0n);
      // Only representable members of their declared size; overlaps are not declared.
      if (
        !type ||
        bytes === null ||
        bytes !== ivar.size ||
        !/^[A-Za-z_$][\w$]*$/.test(ivar.name) ||
        occupied.some((range) => ivar.offset < range.end && range.start < end)
      )
        continue;
      occupied.push({ start: ivar.offset, end });
      for (const item of ivar.evidence) evidence.set(item.id, item);
      fields.push({
        id: entityIdentity(slice, 'objc-ivar', [owner, ivar.name, ivar.offset]),
        name: ivar.name,
        offset: ivar.offset,
        type_id: encoded(type),
      });
    }
    const layout = record(
      { kind: 'structure', size: null, alignment: null, fields },
      { spelling: owner, member_names: true },
      [
        ...new Set([
          ...proof,
          ...ivars.flatMap((ivar) => ivar.evidence.slice(0, 1).map((e) => e.id)),
        ]),
      ],
    );
    self = record({ kind: 'pointer', bits: 64, to: layout });
  }
  const names = ['self', '_cmd'];
  const signature: SuppliedSignature['signature'] = {
    abi,
    return_type: encoded(parsed.returns),
    parameters: parsed.parameters.map((parameter, position) => ({
      id: entityIdentity(slice, 'objc-parameter', [fn.id, position]),
      name: names[position] ?? null,
      type_id: position === 0 && self ? self : encoded(parameter),
    })),
    variadic: false,
    noreturn: false,
    evidence_ids: proof,
  };
  return {
    signature: {
      id: entityIdentity(slice, 'objc-signature', [fn.id, method.type]),
      subject_id: fn.id,
      signature,
      source: 'runtime',
      status: 'established',
      evidence_ids: proof,
    },
    types: [...types.values()],
    evidence: [...evidence.values()],
  };
}

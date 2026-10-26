import {
  encodeTypeDefinition,
  fingerprint,
  type Address,
  type Annotation,
  type CanonicalValue,
  type LoadedImage,
  type RecoveredType,
} from '../../core/index.js';
import type { SuppliedTypeRecord } from '../../analysis/types/index.js';
import { AnnotationService } from '../../project/annotations/index.js';
import type { SourceAddress } from '../../reconstruction/source-model.js';
import type { AnalysisScope } from './index.js';

/** Bytes past its base a declared global type can cover: data entities based further below an
 * address are not looked up for it (one bounded, ledger-recorded window per address). */
export const MAX_DECLARED_EXTENT = 0x10000n;

/** What a subject's live annotations assert about a global: one asserted name (verbatim), one
 * asserted type id. `named`: some live name annotation exists, resolved or not. */
export interface AssertedFacts {
  readonly name?: string;
  readonly named: boolean;
  readonly type_id?: string;
}

export function assertedFacts(annotations: readonly Annotation[]): AssertedFacts {
  const names = new Set<string>(),
    types = new Set<string>();
  let named = false;
  for (const annotation of annotations) {
    if (annotation.status === 'retracted') continue;
    if (annotation.value.kind === 'name') {
      named = true;
      if (annotation.status === 'asserted') names.add(annotation.value.value);
    } else if (annotation.value.kind === 'type' && annotation.status === 'asserted')
      types.add(annotation.value.type_id);
  }
  return {
    named,
    ...(names.size === 1 ? { name: [...names][0]! } : {}),
    ...(types.size === 1 ? { type_id: [...types][0]! } : {}),
  };
}

/** A data entity whose live annotations assert a name or a type. */
interface AnnotatedEntity extends AssertedFacts {
  readonly id: string;
  readonly base: bigint;
}

/** Declared type of a global: the type's records (one per reachable id) and its byte extent. */
export interface GlobalTypes {
  readonly records: readonly SuppliedTypeRecord[];
  /** Byte size of a resolved type id; null when a record is missing, ambiguous or unsized. */
  extent(id: string): bigint | null;
}

/** Records of every type the `roots` (subject id -> asserted type id) reach, through the same
 * scoped `type` annotation view decompilation uses (local declarations first, then shared
 * ones), with every subject and type read recorded by the dependency ledger. A type id with
 * conflicting definitions has no record; structures declared by users print their field names. */
export function resolveGlobalTypes(
  scope: AnalysisScope,
  revision: number,
  roots: ReadonlyMap<string, string>,
): GlobalTypes {
  if (!roots.size) return { records: [], extent: () => null };
  const read = () =>
    new AnnotationService(scope.store).active(revision, scope.context, {
      entity_ids: [...roots.keys()],
      ...(scope.dependencies ? { on_dependencies: scope.dependencies.recordAnnotationScope } : {}),
    });
  const view = scope.dependencies ? scope.dependencies.annotationView(read) : read();
  const grouped = new Map<string, SuppliedTypeRecord[]>();
  for (const record of view.types) {
    scope.context.checkpoint(1);
    const group = grouped.get(record.id) ?? [];
    group.push(record);
    grouped.set(record.id, group);
  }
  const rank = (record: SuppliedTypeRecord): number =>
    record.status === 'asserted' ? 0 : record.status === 'established' ? 1 : 2;
  const resolved = new Map<string, SuppliedTypeRecord>();
  for (const [id, group] of grouped) {
    const definitions = new Set(
      group.map((record) =>
        fingerprint(encodeTypeDefinition(record.definition) as unknown as CanonicalValue),
      ),
    );
    if (definitions.size !== 1) continue;
    const record = [...group].sort((a, b) => rank(a) - rank(b))[0]!;
    resolved.set(
      id,
      record.definition.kind === 'structure' &&
        (record.source === 'user' || record.source === 'llm')
        ? { ...record, member_names: true }
        : record,
    );
  }
  const sizes = new Map<string, bigint | null>();
  const extent = (id: string, active = new Set<string>()): bigint | null => {
    const known = sizes.get(id);
    if (known !== undefined) return known;
    const definition: RecoveredType | undefined = resolved.get(id)?.definition;
    if (!definition || active.has(id) || active.size >= 32) return null;
    scope.context.checkpoint(1);
    active.add(id);
    let size: bigint | null = null;
    switch (definition.kind) {
      case 'integer':
      case 'float':
      case 'pointer':
        size = definition.bits % 8 === 0 ? BigInt(definition.bits / 8) : null;
        break;
      case 'array': {
        const element = extent(definition.element, active);
        size = element !== null && definition.count !== null ? element * definition.count : null;
        break;
      }
      case 'vector': {
        const element = extent(definition.element, active);
        size = element === null ? null : element * BigInt(definition.lanes);
        break;
      }
      case 'structure': {
        size = definition.size;
        if (size === null) {
          let end = 0n;
          for (const field of definition.fields) {
            const member = extent(field.type_id, active);
            if (member === null) {
              end = -1n;
              break;
            }
            if (field.offset + member > end) end = field.offset + member;
          }
          size = end > 0n ? end : null;
        }
        break;
      }
      case 'unknown':
        size = definition.size;
        break;
      case 'void':
        size = null;
    }
    active.delete(id);
    const bounded = size !== null && size > 0n && size <= MAX_DECLARED_EXTENT ? size : null;
    sizes.set(id, bounded);
    return bounded;
  };
  return { records: [...resolved.values()], extent: (id) => extent(id) };
}

/** Annotated data entities of `image` whose storage may hold one of `points` (VAs): those
 * based at most `MAX_DECLARED_EXTENT - 1` bytes below a point, or exactly at one of `bases`.
 * Windows and each entity's annotations are read through the scope's store, so the
 * dependency ledger records them (an entity registered or annotated later invalidates). */
export function annotatedDataEntities(
  scope: AnalysisScope,
  revision: number,
  image: LoadedImage,
  points: Iterable<bigint>,
  bases: Iterable<bigint>,
): ReadonlyMap<bigint, AnnotatedEntity> {
  const windows: { start: bigint; end: bigint }[] = [];
  for (const point of points)
    windows.push({
      start: point >= MAX_DECLARED_EXTENT ? point - MAX_DECLARED_EXTENT + 1n : 0n,
      end: point + 1n,
    });
  for (const base of bases) windows.push({ start: base, end: base + 1n });
  windows.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const merged: { start: bigint; end: bigint }[] = [];
  for (const window of windows) {
    scope.context.checkpoint(1);
    const last = merged.at(-1);
    if (last && window.start <= last.end) {
      if (window.end > last.end) last.end = window.end;
    } else merged.push({ ...window });
  }
  const entities = new Map<bigint, AnnotatedEntity>();
  for (const window of merged)
    for (const entity of scope.store.readDataEntities({
      image_id: image.id,
      revision,
      start: window.start,
      end: window.end,
    })) {
      scope.context.checkpoint(1);
      if (entity.slice_id !== image.selected_slice_id) continue;
      const facts = assertedFacts(scope.store.readAnnotations(entity.id, revision));
      if (facts.name !== undefined || facts.type_id !== undefined)
        entities.set(entity.address.value, { id: entity.id, base: entity.address.value, ...facts });
    }
  return entities;
}

/** `recovered` (the storage of `address` by image facts) under the data entities annotated
 * there. The entity is the one whose declared type covers the address (when exactly one
 * does), else the one based exactly at the address, else the one at the recovered object's
 * base. Its asserted name replaces any symbol or loader name; its type, or else the type
 * asserted on the covering symbol (`symbolType`), is the object's declared type and extent.
 * A named or typed global is an object of its own: its loads never fold to image constants. */
export function annotatedDataAddress(
  address: Address,
  recovered: SourceAddress,
  entities: ReadonlyMap<bigint, AnnotatedEntity>,
  types: GlobalTypes,
  symbolType: string | undefined,
): SourceAddress {
  const object = recovered.object;
  if (!object || address.space !== 'va') return recovered;
  const covering: AnnotatedEntity[] = [];
  for (const entity of entities.values()) {
    if (entity.type_id === undefined || entity.base > address.value) continue;
    const extent = types.extent(entity.type_id);
    if (extent !== null && address.value < entity.base + extent) covering.push(entity);
  }
  const entity =
    covering.length === 1
      ? covering[0]!
      : (entities.get(address.value) ?? entities.get(object.address.value));
  const typeId =
    entity?.type_id !== undefined && types.extent(entity.type_id) !== null
      ? entity.type_id
      : symbolType !== undefined &&
          types.extent(symbolType) !== null &&
          (!entity || entity.base === object.address.value)
        ? symbolType
        : undefined;
  if (!entity && typeId === undefined) return recovered;
  const base = entity?.base ?? object.address.value;
  const extent = typeId === undefined ? null : types.extent(typeId);
  const same = base === object.address.value;
  const {
    constant_bytes: _constant,
    name: recoveredName,
    source_name: recoveredSpelling,
    ...plain
  } = recovered;
  // String and relative-name facts describe the recovered object, not a new base.
  const {
    string: _string,
    string_byte_length: _length,
    string_encoding: _encoding,
    string_start: _start,
    symbol_relative: _relative,
    ...moved
  } = plain;
  const name = entity?.name ?? (same ? recoveredName : undefined);
  const spelling = entity?.name ?? (same ? recoveredSpelling : undefined);
  return {
    ...(same ? plain : moved),
    ...(name === undefined ? {} : { name }),
    ...(spelling === undefined ? {} : { source_name: spelling }),
    object: same
      ? {
          ...object,
          ...(extent === null ? {} : { byte_length: extent }),
          ...(typeId === undefined ? {} : { type_id: typeId }),
        }
      : {
          address: { image_id: object.address.image_id, space: 'va', value: base },
          entity_id: entity!.id,
          byte_length: extent,
          offset: address.value - base,
          mutable: object.mutable,
          kind: 'bytes',
          evidence_ids: object.evidence_ids,
          ...(typeId === undefined ? {} : { type_id: typeId }),
        },
  };
}

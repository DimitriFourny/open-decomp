import {
  encodeTypeDefinition,
  entityIdentity,
  newIdentity,
  typeLibraryIdentity,
  userTypeFieldIdentity,
  userTypeIdentity,
  type Annotation,
  type AnnotationEdit,
  type OperationContext,
  type ProjectStore,
  type RecoveredType,
} from '../../core/index.js';
import type { CParseResult, CTypeDefinition } from '../../metadata/c-declarations/index.js';

interface LibraryType {
  readonly name: string | null;
  readonly type_id: string;
  readonly annotation_id: string;
  readonly status: 'asserted' | 'hypothesis';
  readonly definition: RecoveredType;
}

/** One live declaration of a slice's type library and its C rendering. */
export interface LibraryListing extends Omit<LibraryType, 'definition'> {
  readonly declaration: string;
}

/** A declared type reported by `types_declare` (typedef aliases of a tag share its entry). */
export interface DeclaredLibraryType {
  readonly name: string | null;
  readonly key: string;
  readonly type_id: string;
  readonly annotation_id: string;
}

/** Live (non-retracted) type declarations anchored on the slice's type library, named
 * types first by name, then by type ID. */
export function libraryListing(
  store: ProjectStore,
  sliceId: string,
  revision: number,
  context: OperationContext,
): readonly LibraryListing[] {
  const types: LibraryType[] = [];
  for (const annotation of store.readAnnotations(typeLibraryIdentity(sliceId), revision)) {
    context.checkpoint(1);
    if (
      annotation.status === 'retracted' ||
      annotation.value.kind !== 'type' ||
      !annotation.value.definition
    )
      continue;
    types.push({
      name: annotation.value.name ?? null,
      type_id: annotation.value.type_id,
      annotation_id: annotation.id,
      status: annotation.status,
      definition: annotation.value.definition,
    });
  }
  types.sort((a, b) =>
    a.name !== b.name
      ? a.name === null
        ? 1
        : b.name === null || a.name < b.name
          ? -1
          : 1
      : a.type_id < b.type_id
        ? -1
        : 1,
  );
  const declarations = renderLibraryTypes(types, context);
  return types.map(({ definition: _definition, ...type }, index) => ({
    ...type,
    declaration: declarations[index]!,
  }));
}

/** Maps parsed C declarations to one `type` annotation per parsed type on the slice's
 * library anchor. Named types (and builtins/anonymous helpers, by parser key) get
 * deterministic IDs, so a redeclaration names the same type; it reuses the existing
 * library annotation of that name or type ID, replacing the previous declaration. A
 * forward declaration (`struct Node;`, or a tag only mentioned) never replaces a live
 * definition, and declarations already in the library unchanged are not rewritten
 * (unless nothing changed at all), so functions using them keep their cached results. */
export function typeLibraryEdits(
  parsed: CParseResult,
  sliceId: string,
  existing: readonly Annotation[],
  status: 'asserted' | 'hypothesis',
  context: OperationContext,
): { readonly edits: readonly AnnotationEdit[]; readonly types: readonly DeclaredLibraryType[] } {
  const anchor = typeLibraryIdentity(sliceId);
  const ids = new Map<string, string>();
  for (const type of parsed.types) {
    context.checkpoint(1);
    ids.set(
      type.key,
      type.name === null
        ? entityIdentity(sliceId, 'user-type', [type.key])
        : userTypeIdentity(sliceId, type.name),
    );
  }
  const idOf = (key: string): string => {
    const id = ids.get(key);
    if (id === undefined) throw new Error(`C declaration parser left type key ${key} undefined`);
    return id;
  };
  // A live declaration is preferred over a retracted one of the same name or type.
  const byName = new Map<string, Annotation>(),
    byType = new Map<string, Annotation>();
  for (const annotation of [...existing].sort(
    (a, b) => Number(a.status !== 'retracted') - Number(b.status !== 'retracted'),
  )) {
    if (annotation.entity_id !== anchor || annotation.value.kind !== 'type') continue;
    if (annotation.value.name !== undefined) byName.set(annotation.value.name, annotation);
    byType.set(annotation.value.type_id, annotation);
  }
  const edits: AnnotationEdit[] = [],
    unchanged: AnnotationEdit[] = [],
    types: DeclaredLibraryType[] = [],
    annotations = new Map<string, string>();
  for (const type of parsed.types) {
    context.checkpoint(1);
    const typeId = idOf(type.key);
    const prior = (type.name === null ? undefined : byName.get(type.name)) ?? byType.get(typeId);
    const id = prior?.id ?? newIdentity('annotation');
    annotations.set(type.key, id);
    types.push({ name: type.name, key: type.key, type_id: typeId, annotation_id: id });
    const forward =
      type.definition.kind === 'structure' &&
      type.definition.size === null &&
      type.definition.fields.length === 0;
    if (forward && prior?.status !== 'retracted' && prior?.value.kind === 'type') continue;
    const value = {
      kind: 'type' as const,
      type_id: typeId,
      definition: libraryDefinition(type.definition, type.name ?? type.key, sliceId, idOf),
      ...(type.name === null ? {} : { name: type.name }),
    };
    const edit: AnnotationEdit = {
      operation: 'set',
      id,
      entity_id: anchor,
      value,
      status,
      evidence_ids: [],
    };
    const same =
      prior?.status === status &&
      prior.value.kind === 'type' &&
      prior.value.type_id === typeId &&
      (prior.value.name ?? null) === type.name &&
      prior.value.definition !== undefined &&
      JSON.stringify(encodeTypeDefinition(prior.value.definition)) ===
        JSON.stringify(encodeTypeDefinition(value.definition));
    (same ? unchanged : edits).push(edit);
  }
  for (const [name, key] of parsed.named) {
    context.checkpoint(1);
    const own = parsed.types.find((type) => type.key === key);
    if (own?.name === name) continue;
    types.push({ name, key, type_id: idOf(key), annotation_id: annotations.get(key)! });
  }
  return { edits: edits.length ? edits : unchanged, types };
}

function libraryDefinition(
  definition: CTypeDefinition,
  owner: string,
  sliceId: string,
  idOf: (key: string) => string,
): RecoveredType {
  switch (definition.kind) {
    case 'pointer':
      return { kind: 'pointer', to: idOf(definition.to), bits: 64 };
    case 'array':
      return { kind: 'array', element: idOf(definition.element), count: definition.count };
    case 'vector':
      return { kind: 'vector', element: idOf(definition.element), lanes: definition.lanes };
    case 'structure':
      return {
        kind: 'structure',
        size: definition.size,
        alignment: definition.alignment,
        fields: definition.fields.map((field) => ({
          id: userTypeFieldIdentity(sliceId, owner, field.id),
          name: field.name,
          offset: field.offset,
          type_id: idOf(field.type_id),
        })),
      };
    default:
      return definition;
  }
}

/** C declarations of a type library: a named type's declaration (`struct Node { ... };`,
 * `typedef int32_t myint;`), an anonymous helper type's spelling (`struct Node *`). A
 * structure whose members all start at offset 0 renders as the union it was declared as. */
function renderLibraryTypes(
  types: readonly LibraryType[],
  context: OperationContext,
): readonly string[] {
  const records = new Map(types.map((type) => [type.type_id, type]));
  /** Type specifier; a named aggregate prints its body only when `body` is set. */
  const specifier = (
    definition: RecoveredType,
    name: string | null,
    body: boolean,
    depth: number,
  ): string => {
    switch (definition.kind) {
      case 'integer':
        return (
          name ??
          (definition.bits === 1 && !definition.signed
            ? 'bool'
            : `${definition.signed ? 'int' : 'uint'}${definition.bits}_t`)
        );
      case 'float':
        return (
          name ??
          { 16: '_Float16', 32: 'float', 64: 'double', 80: 'long double', 128: 'long double' }[
            definition.bits
          ]
        );
      case 'unknown':
        return (
          name ?? (definition.size === null ? 'void' : `uint8_t /* ${definition.size} bytes */`)
        );
      case 'vector':
        return (
          name ?? `vector<${declarator(definition.element, '', depth + 1)}, ${definition.lanes}>`
        );
      case 'structure': {
        const union =
          definition.fields.length > 1 && definition.fields.every((field) => field.offset === 0n);
        const tag = `${union ? 'union' : 'struct'}${name === null ? '' : ` ${name}`}`;
        if (!body || (definition.size === null && definition.fields.length === 0)) return tag;
        if (depth > 8) return `${tag} { /* ... */ }`;
        const members = definition.fields.map(
          (field) => `${declarator(field.type_id, field.name, depth + 1)};`,
        );
        return `${tag} { ${members.join(' ')} }`;
      }
      default:
        return name ?? 'void';
    }
  };
  /** Declares `inner` (a name, `*name`, `name[4]` or empty) of the given definition. */
  const declare = (definition: RecoveredType, inner: string, depth: number): string => {
    context.checkpoint(1);
    if (depth <= 32 && definition.kind === 'pointer')
      return declarator(definition.to, `*${inner}`, depth + 1);
    if (depth <= 32 && definition.kind === 'array')
      return declarator(
        definition.element,
        `${inner.startsWith('*') ? `(${inner})` : inner}[${definition.count ?? ''}]`,
        depth + 1,
      );
    const type = specifier(definition, null, true, depth);
    return inner ? `${type} ${inner}` : type;
  };
  const declarator = (id: string, inner: string, depth: number): string => {
    const type = records.get(id);
    if (!type) return `/* ${id} */ void${inner ? ` ${inner}` : ''}`;
    if (type.name === null) return declare(type.definition, inner, depth);
    const spelled = specifier(type.definition, type.name, false, depth);
    return inner ? `${spelled} ${inner}` : spelled;
  };
  return types.map((type) =>
    type.name === null
      ? declare(type.definition, '', 0)
      : type.definition.kind === 'structure'
        ? `${specifier(type.definition, type.name, true, 0)};`
        : `typedef ${declare(type.definition, type.name, 0)};`,
  );
}

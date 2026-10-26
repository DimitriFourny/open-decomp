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

/** A declared type reported by `types_declare`: typedef aliases of a tag share its entry,
 * and each name `N` also reports its library pointer type under key `N*` (name null). */
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
 * library anchor, plus a pointer type to every named type (`Name*`). Named types (and
 * builtins/anonymous helpers, by parser key) get deterministic IDs, so a redeclaration
 * names the same type; it reuses the existing library annotation of that name or type
 * ID, replacing the previous declaration. An anonymous pointer to a named type is that
 * name's pointer type `userTypeIdentity(slice, 'Name*')`, declared once. A forward
 * declaration (`struct Node;`, or a tag only mentioned) never replaces a live
 * definition, and declarations already in the library unchanged are not rewritten
 * (unless no parsed type changed at all), so functions using them keep their cached
 * results. */
export function typeLibraryEdits(
  parsed: CParseResult,
  sliceId: string,
  existing: readonly Annotation[],
  status: 'asserted' | 'hypothesis',
  context: OperationContext,
): { readonly edits: readonly AnnotationEdit[]; readonly types: readonly DeclaredLibraryType[] } {
  const anchor = typeLibraryIdentity(sliceId);
  const names = new Map<string, string>();
  for (const type of parsed.types) if (type.name !== null) names.set(type.key, type.name);
  /** The pointer type of the named type with parser key `key`. */
  const pointerId = (key: string): string => {
    const name = names.get(key);
    if (name === undefined) throw new Error(`C declaration parser left type key ${key} unnamed`);
    return userTypeIdentity(sliceId, `${name}*`);
  };
  const ids = new Map<string, string>();
  for (const type of parsed.types) {
    context.checkpoint(1);
    ids.set(
      type.key,
      type.name !== null
        ? userTypeIdentity(sliceId, type.name)
        : type.definition.kind === 'pointer' && names.has(type.definition.to)
          ? pointerId(type.definition.to)
          : entityIdentity(sliceId, 'user-type', [type.key]),
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
    /** The library annotation declaring each type ID of this batch. */
    annotations = new Map<string, string>();
  /** The edit declaring `typeId` (reusing its prior library annotation), and whether the
   * library already holds exactly that declaration. */
  const declare = (
    typeId: string,
    name: string | null,
    definition: RecoveredType,
    prior: Annotation | undefined,
  ): { readonly edit: AnnotationEdit; readonly same: boolean } => {
    const id = prior?.id ?? newIdentity('annotation');
    annotations.set(typeId, id);
    const value = {
      kind: 'type' as const,
      type_id: typeId,
      definition,
      ...(name === null ? {} : { name }),
    };
    return {
      edit: { operation: 'set', id, entity_id: anchor, value, status, evidence_ids: [] },
      same:
        prior?.status === status &&
        prior.value.kind === 'type' &&
        prior.value.type_id === typeId &&
        (prior.value.name ?? null) === name &&
        prior.value.definition !== undefined &&
        JSON.stringify(encodeTypeDefinition(prior.value.definition)) ===
          JSON.stringify(encodeTypeDefinition(definition)),
    };
  };
  for (const type of parsed.types) {
    context.checkpoint(1);
    const typeId = idOf(type.key);
    const declared = annotations.get(typeId);
    if (declared !== undefined) {
      // Another anonymous pointer to the same named type: one declaration serves both.
      types.push({ name: null, key: type.key, type_id: typeId, annotation_id: declared });
      continue;
    }
    const prior = (type.name === null ? undefined : byName.get(type.name)) ?? byType.get(typeId);
    const forward =
      type.definition.kind === 'structure' &&
      type.definition.size === null &&
      type.definition.fields.length === 0;
    if (forward && prior?.status !== 'retracted' && prior?.value.kind === 'type') {
      annotations.set(typeId, prior.id);
      types.push({ name: type.name, key: type.key, type_id: typeId, annotation_id: prior.id });
      continue;
    }
    const { edit, same } = declare(
      typeId,
      type.name,
      libraryDefinition(type.definition, type.name ?? type.key, sliceId, idOf),
      prior,
    );
    types.push({ name: type.name, key: type.key, type_id: typeId, annotation_id: edit.id });
    (same ? unchanged : edits).push(edit);
  }
  for (const [name, key] of parsed.named) {
    context.checkpoint(1);
    if (names.get(key) === name) continue;
    const typeId = idOf(key);
    types.push({ name, key, type_id: typeId, annotation_id: annotations.get(typeId)! });
  }
  // The pointer type of every name (an alias's is its tag's). Only a new or changed pointer
  // declaration is written, so a batch changing nothing else (a forward declaration of a
  // defined tag) is still rejected as empty.
  for (const [name, key] of parsed.named) {
    context.checkpoint(1);
    const typeId = pointerId(key);
    if (!annotations.has(typeId)) {
      const { edit, same } = declare(
        typeId,
        null,
        { kind: 'pointer', to: idOf(key), bits: 64 },
        byType.get(typeId),
      );
      if (!same) edits.push(edit);
    }
    types.push({
      name: null,
      key: `${name}*`,
      type_id: typeId,
      annotation_id: annotations.get(typeId)!,
    });
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

type DeclaredType = Pick<LibraryType, 'name' | 'type_id' | 'definition'>;

/** C declarations of the named types `roots` (each a `struct Name { ... };` or `typedef`),
 * preceded by the named types their declarations need, dependencies first, each once:
 * a by-value member, array element or typedef target in full, a typedef name behind a
 * pointer too; a pointer to a named structure needs only its tag. `types` resolves every
 * reference; an unknown one renders as a commented `void`. */
export function typeDeclarations(
  types: readonly DeclaredType[],
  roots: readonly string[],
  context: OperationContext,
): readonly { readonly type_id: string; readonly declaration: string }[] {
  const records = new Map<string, DeclaredType>();
  for (const type of types) if (!records.has(type.type_id)) records.set(type.type_id, type);
  const ordered: DeclaredType[] = [];
  const visited = new Set<string>();
  const need = (id: string, complete: boolean, depth: number): void => {
    context.checkpoint(1);
    const type = records.get(id);
    if (!type || depth > 64) return;
    const named = type.name !== null;
    if (named && (visited.has(id) || (!complete && type.definition.kind === 'structure'))) return;
    if (named) visited.add(id);
    const definition = type.definition;
    if (definition.kind === 'pointer') need(definition.to, false, depth + 1);
    else if (definition.kind === 'array') need(definition.element, complete, depth + 1);
    else if (definition.kind === 'vector') need(definition.element, true, depth + 1);
    else if (definition.kind === 'structure')
      for (const field of definition.fields) need(field.type_id, true, depth + 1);
    if (named) ordered.push(type);
  };
  for (const id of roots) need(id, true, 0);
  const declarations = renderLibraryTypes(types, context, ordered);
  return ordered.map((type, index) => ({
    type_id: type.type_id,
    declaration: declarations[index]!,
  }));
}

/** C declarations of a type library: a named type's declaration (`struct Node { ... };`,
 * `typedef int32_t myint;`), an anonymous helper type's spelling (`struct Node *`). A
 * structure whose members all start at offset 0 renders as the union it was declared as.
 * `types` resolves references; `declared` (default: all of them) are rendered. */
function renderLibraryTypes(
  types: readonly DeclaredType[],
  context: OperationContext,
  declared: readonly DeclaredType[] = types,
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
  return declared.map((type) =>
    type.name === null
      ? declare(type.definition, '', 0)
      : type.definition.kind === 'structure'
        ? `${specifier(type.definition, type.name, true, 0)};`
        : `typedef ${declare(type.definition, type.name, 0)};`,
  );
}

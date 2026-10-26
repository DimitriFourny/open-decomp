import type { ImageTypeClass, ImageTypeField } from '../analysis/types/image-types.js';
import { memberName, overlayMemberName, paddingName } from './source-structs.js';

function scalar(field: ImageTypeField): string | null {
  if (field.kind === 'float' && (field.width_bits === 32 || field.width_bits === 64))
    return field.width_bits === 32 ? 'float' : 'double';
  if ([8, 16, 32, 64].includes(field.width_bits)) return `uint${field.width_bits}_t`;
  return field.width_bits === 128 ? '__uint128_t' : null;
}

/** A user declaration's effect on one class in the dump. */
export interface ImageTypeUserView {
  /** Bound: the declared structure's C spelling (`struct Rec`) and the declarations
   * defining it, dependencies first (each type declared once per dump). */
  readonly bound?: {
    readonly spelling: string;
    readonly declarations: readonly { readonly type_id: string; readonly declaration: string }[];
  };
  /** What binds the class, or why it stays unbound. */
  readonly note: string;
}

/** C declarations for merged image types: observed members only, explicit byte
 * gaps, no size; a member proven to hold another declared type's pointer is
 * declared as that pointer. A floating and an integer access of the same bytes
 * are the two members of one anonymous union. Members otherwise overlapping an
 * earlier member, or of a width without a C scalar, stay inside the surrounding
 * gap. A class bound to a user-declared structure (`user`) is that declaration. */
export function renderImageTypeDeclarations(
  classes: readonly ImageTypeClass[],
  functionName: (id: string) => string,
  user: ReadonlyMap<string, ImageTypeUserView> = new Map(),
): string {
  // One member at offset zero is a plain scalar pointee (`uint8_t*`), as in
  // function output; it is not declared as a structure.
  const scalars = new Map<string, string>();
  for (const item of classes) {
    const field = item.fields[0];
    if (!field || user.get(item.id)?.bound) continue;
    const type = scalar(field);
    if (
      item.fields.length === 1 &&
      field.offset === 0n &&
      field.kind !== 'pointer' &&
      (field.stride === null || field.stride === BigInt(field.width_bits / 8)) &&
      type
    )
      scalars.set(item.id, type);
  }
  const declared = classes.filter((item) => item.fields.length > 0 && !scalars.has(item.id));
  const classNames = new Map(classes.map((item) => [item.id, item.label]));
  const names = new Map<string, string>(scalars);
  for (const item of declared) names.set(item.id, user.get(item.id)?.bound?.spelling ?? item.label);
  const lines = [
    '/* Open Decomp recovered image types: observed members only; sizes and complete layouts are unknown. */',
    '#include <stdint.h>',
  ];
  for (const item of declared)
    if (!user.get(item.id)?.bound) lines.push(`typedef struct ${item.label} ${item.label};`);
  const printed = new Set<string>();
  for (const item of declared) {
    const view = user.get(item.id);
    if (view?.bound) {
      lines.push(
        `/* ${item.label} is ${view.bound.spelling}: ${view.note}; first seen: ${item.name}; ${seen(item, functionName)} */`,
      );
      for (const { type_id, declaration } of view.bound.declarations)
        if (!printed.has(type_id)) {
          printed.add(type_id);
          lines.push(declaration);
        }
      continue;
    }
    const parts: string[] = [];
    let end = 0n,
      packed = false;
    const last = item.fields.at(-1)?.offset;
    for (let index = 0; index < item.fields.length; index++) {
      const field = item.fields[index]!;
      const type = scalar(field);
      if (!type || field.offset < end) continue;
      const next = item.fields[index + 1];
      const overlay =
        next !== undefined &&
        next.offset === field.offset &&
        next.width_bits === field.width_bits &&
        field.kind !== 'float' &&
        next.kind === 'float'
          ? next
          : undefined;
      if (overlay) index++;
      if (field.offset > end) parts.push(`uint8_t ${paddingName(end)}[${field.offset - end}];`);
      const pointee =
        field.kind === 'pointer'
          ? item.pointees.find(
              (candidate) => candidate.offset === field.offset && candidate.stride === field.stride,
            )
          : undefined;
      const target = pointee && names.get(pointee.class_id);
      const spelling =
        field.kind === 'pointer' && field.width_bits === 64 ? `${target ?? 'void'}*` : type;
      const array =
        !overlay &&
        field.offset === last &&
        field.offset > 0n &&
        field.stride === BigInt(field.width_bits / 8);
      const text = `${spelling} ${memberName(field.offset)}${array ? '[]' : ''};`;
      parts.push(
        overlay
          ? `union { ${text} ${scalar(overlay)} ${overlayMemberName(field.offset)}; };`
          : text,
      );
      packed ||= field.offset % BigInt(field.width_bits / 8) !== 0n;
      end = field.offset + BigInt(field.width_bits / 8);
    }
    const notes = [
      `first seen: ${item.name}`,
      seen(item, functionName),
      ...(item.state === 'bounded' ? ['flows partly explored'] : []),
      ...(view ? [view.note] : []),
      ...(item.conflicts.length
        ? [`conflicts with ${item.conflicts.map((id) => classNames.get(id) ?? id).join(', ')}`]
        : []),
      ...[
        ...new Set(
          item.fields.flatMap((field) =>
            field.stride !== null && field.stride !== BigInt(field.width_bits / 8)
              ? [field.stride]
              : [],
          ),
        ),
      ].map((stride) => `observed element stride ${stride}; not an allocation extent`),
    ];
    lines.push(`/* ${notes.join('; ')} */`);
    lines.push(
      `struct ${item.label} { ${parts.join(' ')} }${packed ? ' __attribute__((packed))' : ''};`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function seen(item: ImageTypeClass, functionName: (id: string) => string): string {
  return `${item.functions.length === 1 ? 'seen in' : `merged from ${item.functions.length} functions:`} ${item.functions
    .slice(0, 6)
    .map(functionName)
    .join(', ')}${item.functions.length > 6 ? ', …' : ''}`;
}

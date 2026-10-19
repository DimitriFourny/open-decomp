import type { ImageTypeClass, ImageTypeField } from '../analysis/types/image-types.js';

function scalar(field: ImageTypeField): string | null {
  if (field.kind === 'float' && (field.width_bits === 32 || field.width_bits === 64))
    return field.width_bits === 32 ? 'float' : 'double';
  if ([8, 16, 32, 64].includes(field.width_bits)) return `uint${field.width_bits}_t`;
  return field.width_bits === 128 ? '__uint128_t' : null;
}

/** C declarations for merged image types: observed members only, explicit byte
 * gaps, no size; a member proven to hold another declared type's pointer is
 * declared as that pointer. Members overlapping an earlier member, or of a
 * width without a C scalar, stay inside the surrounding gap. */
export function renderImageTypeDeclarations(
  classes: readonly ImageTypeClass[],
  functionName: (id: string) => string,
): string {
  // One member at offset zero is a plain scalar pointee (`uint8_t*`), as in
  // function output; it is not declared as a structure.
  const scalars = new Map<string, string>();
  for (const item of classes) {
    const field = item.fields[0];
    if (!field) continue;
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
  const classNames = new Map(classes.map((item) => [item.id, item.name]));
  const names = new Map<string, string>(scalars);
  for (const item of declared) names.set(item.id, item.name);
  const lines = [
    '/* Open Decomp recovered image types: observed members only; sizes and complete layouts are unknown. */',
    '#include <stdint.h>',
  ];
  for (const item of declared) lines.push(`typedef struct ${item.name} ${item.name};`);
  for (const item of declared) {
    const parts: string[] = [];
    let end = 0n,
      packed = false;
    const last = item.fields.at(-1)?.offset;
    for (const field of item.fields) {
      const type = scalar(field);
      if (!type || field.offset < end) continue;
      if (field.offset > end) parts.push(`uint8_t gap_${end.toString(16)}[${field.offset - end}];`);
      const pointee =
        field.kind === 'pointer'
          ? item.pointees.find(
              (candidate) => candidate.offset === field.offset && candidate.stride === field.stride,
            )
          : undefined;
      const target = pointee && names.get(pointee.class_id);
      const spelling = field.kind === 'pointer' && field.width_bits === 64 ? `${target ?? 'void'}*` : type;
      const array =
        field.offset === last &&
        field.offset > 0n &&
        field.stride === BigInt(field.width_bits / 8);
      parts.push(`${spelling} f_${field.offset.toString(16)}${array ? '[]' : ''};`);
      packed ||= field.offset % BigInt(field.width_bits / 8) !== 0n;
      end = field.offset + BigInt(field.width_bits / 8);
    }
    const notes = [
      `${item.functions.length === 1 ? 'seen in' : `merged from ${item.functions.length} functions:`} ${item.functions
        .slice(0, 6)
        .map(functionName)
        .join(', ')}${item.functions.length > 6 ? ', …' : ''}`,
      ...(item.state === 'bounded' ? ['flows partly explored'] : []),
      ...(item.conflicts.length
        ? [`conflicts with ${item.conflicts.map((id) => classNames.get(id) ?? id).join(', ')}`]
        : []),
      ...[...new Set(item.fields.flatMap((field) => (field.stride !== null && field.stride !== BigInt(field.width_bits / 8) ? [field.stride] : [])))].map(
        (stride) => `observed element stride ${stride}; not an allocation extent`,
      ),
    ];
    lines.push(`/* ${notes.join('; ')} */`);
    lines.push(`struct ${item.name} { ${parts.join(' ')} }${packed ? ' __attribute__((packed))' : ''};`);
  }
  return `${lines.join('\n')}\n`;
}

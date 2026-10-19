import type { OperationContext } from '../core/index.js';
import { bitWidth, type Expression, type Instruction, type Value } from '../ir/index.js';
import type { Reconstruction } from '../reconstruction/model.js';

/** Facts the renderer supplies from its supplied-type records; this analysis
 * never guesses a type from a callee name. */
export interface CharacterEvidenceSource {
  /** The type id is a pointer whose pointee is an 8-bit integer (`char`, `uint8_t`). */
  readonly bytePointer: (typeId: string) => boolean;
}

export interface CharacterEvidence {
  /** Values holding one character code: an 8-bit load through a pointer to
   * bytes, widened or narrowed without changing the code. */
  readonly values: ReadonlySet<string>;
}

/** The operand a value is a lossless view of (extension, reinterpretation or
 * the lowest slice at full width). */
const passes = (expression: Expression): Value | undefined => {
  if (
    expression.kind === 'cast' &&
    (expression.op === 'zero_extend' ||
      expression.op === 'sign_extend' ||
      expression.op === 'bitcast')
  )
    return expression.value;
  if (expression.kind === 'extract' && expression.offset === 0) return expression.value;
  return undefined;
};

/** Which values are character codes, derived only from pointer evidence the
 * program already carries: inferred byte-pointer formals and value types,
 * library `char *` parameters and results, and offsets of those pointers. A byte
 * loaded through such a pointer is a character code; arbitrary byte-sized
 * integers never are. */
export function characterEvidence(
  program: Reconstruction,
  context: OperationContext,
  evidence: CharacterEvidenceSource,
): CharacterEvidence {
  const source = program.source;
  const characters = new Set<string>();
  if (!source) return { values: characters };
  const pointers = new Set<string>();
  for (const [id, view] of source.value_types ?? []) {
    context.checkpoint(1);
    if (evidence.bytePointer(view.type_id)) pointers.add(id);
  }
  for (const [id, formal] of source.formal_types ?? []) {
    context.checkpoint(1);
    if (formal.kind === 'pointer' && formal.pointee === 'integer' && formal.pointee_bits === 8)
      pointers.add(id);
  }
  const loads: Extract<Instruction, { kind: 'load' }>[] = [];
  for (const block of program.blocks.values())
    for (const node of block.statements) {
      context.checkpoint(1);
      if (node.kind === 'load') loads.push(node);
    }
  for (const projection of program.calls.values()) {
    context.checkpoint(1);
    const signature = projection.signature?.signature;
    if (!signature) continue;
    projection.arguments.forEach((value, index) => {
      const parameter = signature.parameters[index];
      if (parameter && evidence.bytePointer(parameter.type_id)) pointers.add(value.id);
    });
    if (projection.results.length === 1 && evidence.bytePointer(signature.return_type))
      pointers.add(projection.results[0]!.id);
  }
  // A copy along an edge delivers each of its sources to the destination.
  const incoming = new Map<string, Value[]>();
  for (const copies of program.transfers.values())
    for (const copy of copies) {
      context.checkpoint(1);
      const sources = incoming.get(copy.destination.id) ?? [];
      sources.push(copy.source);
      incoming.set(copy.destination.id, sources);
    }
  const known = (value: Value): boolean => pointers.has(value.id);
  for (let changed = true; changed;) {
    changed = false;
    const add = (id: string): void => {
      if (pointers.has(id)) return;
      pointers.add(id);
      changed = true;
    };
    for (const [id, expression] of program.expressions) {
      context.checkpoint(1);
      const alias = passes(expression);
      const width = program.values.get(id)?.type;
      const same = alias && (!width || bitWidth(alias.type) === bitWidth(width));
      if (pointers.has(id)) {
        // A same-width reinterpretation and both arms of a select carry the same pointer.
        if (same && expression.kind === 'cast' && expression.op === 'bitcast') add(alias.id);
        else if (expression.kind === 'select') {
          add(expression.when_true.id);
          add(expression.when_false.id);
        }
      } else if (alias && same && known(alias)) add(id);
      else if (expression.kind === 'integer' && expression.op === 'add') {
        if (known(expression.left) !== known(expression.right)) add(id);
      } else if (expression.kind === 'integer' && expression.op === 'sub') {
        if (known(expression.left) && !known(expression.right)) add(id);
      } else if (
        expression.kind === 'select' &&
        known(expression.when_true) &&
        known(expression.when_false)
      )
        add(id);
    }
    for (const [id, sources] of incoming) {
      context.checkpoint(1);
      if (!pointers.has(id) && sources.every(known)) add(id);
    }
  }
  for (const load of loads) {
    context.checkpoint(1);
    if (
      load.result.type.kind === 'integer' &&
      load.result.type.bits === 8 &&
      pointers.has(load.address.id)
    )
      characters.add(load.result.id);
  }
  // A code widened (or joined with zero bytes) is still that code.
  for (let changed = true; changed;) {
    changed = false;
    for (const [id, expression] of program.expressions) {
      context.checkpoint(1);
      if (characters.has(id)) continue;
      const alias = passes(expression);
      const joined =
        expression.kind === 'concat' &&
        expression.values.length > 1 &&
        characters.has(expression.values[0]!.id) &&
        expression.values.slice(1).every((value) => {
          const definition = program.expressions.get(value.id);
          return definition?.kind === 'constant' && definition.bits === 0n;
        });
      if (joined || (alias && characters.has(alias.id))) {
        characters.add(id);
        changed = true;
      }
    }
  }
  return { values: characters };
}

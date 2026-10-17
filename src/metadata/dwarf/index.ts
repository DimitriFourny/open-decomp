import { OperationError, type Diagnostic, type OperationContext } from '../../core/index.js';
import { parseDwarf } from './parser.js';
import type { DebugSymbols } from './model.js';
import type { DwarfSections } from './reader.js';

export type * from './model.js';
export type { DwarfSections } from './reader.js';
export type DwarfData = Omit<DebugSymbols, 'uuid'>;
export interface DwarfResult {
  readonly status: 'absent' | 'complete' | 'partial';
  readonly data: DwarfData | null;
  readonly diagnostics: readonly Diagnostic[];
}

/** Error isolation applies only to malformed contributions, never cancellation/deadlines.
 * Supported: DWARF2–5 compile/partial units, DWARF32/64 offsets, v2–5 lines,
 * ranges, v2–4 loc and v5 loclists, structural DIE types and symbolic locations.
 * Split/supplementary types, compressed sections and general location evaluation
 * are unsupported. Section names use Mach-O __debug_* spelling. No I/O occurs.
 */
export function parseDwarfSections(
  sections: DwarfSections,
  context: OperationContext,
  options: { littleEndian?: boolean } = {},
): DwarfResult {
  context.checkpoint(0);
  let size = 0;
  for (const bytes of sections.values()) {
    context.checkpoint(1);
    size += bytes.length;
    if (size > 128 * 1024 * 1024)
      throw new OperationError({
        code: 'resource_limit',
        severity: 'error',
        message: 'DWARF sections exceed 128 MiB',
        evidence_ids: [],
      });
  }
  const info = sections.get('__debug_info');
  if (!info?.length && !sections.has('__debug_abbrev'))
    return { status: 'absent', data: null, diagnostics: [] };
  try {
    if (!info?.length || !sections.has('__debug_abbrev'))
      throw new Error('Incomplete DWARF debug_info/debug_abbrev section pair');
    const data = parseDwarf(sections, options.littleEndian ?? true, context);
    boundDebugOutput(data, context);
    const diagnostics = data.diagnostics.map(dwarfDiagnostic);
    return { status: diagnostics.length ? 'partial' : 'complete', data, diagnostics };
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw new OperationError({ ...dwarfDiagnostic(String(error)), severity: 'error' });
  }
}

export function dwarfDiagnostic(message: string): Diagnostic {
  return {
    code: /limit|budget|exceeds safe/i.test(message)
      ? 'resource_limit'
      : /unsupported|unknown .*opcode/i.test(message)
        ? 'unavailable_semantics'
        : 'malformed_image',
    severity: 'warning',
    message: message.slice(0, 8192),
    evidence_ids: [],
  };
}

/** Conservative wire-size accounting without allocating a serialized copy. */
export function boundDebugOutput(value: unknown, context: OperationContext): void {
  let size = 0;
  function visit(item: unknown, depth: number): void {
    context.checkpoint(1);
    if (depth > 256)
      throw new OperationError({
        code: 'resource_limit',
        severity: 'error',
        message: 'Debug output nesting exceeds 256',
        evidence_ids: [],
      });
    size += typeof item === 'string' ? 6 * item.length + 2 : 32;
    if (size > context.budget.output_bytes)
      throw new OperationError({
        code: 'resource_limit',
        severity: 'error',
        message: 'Debug output exceeds output_bytes budget',
        evidence_ids: [],
        details: {
          kind: 'limit',
          resource: 'output_bytes',
          limit: context.budget.output_bytes,
          consumed: size,
        },
      });
    if (Array.isArray(item)) for (const child of item) visit(child, depth + 1);
    else if (item !== null && typeof item === 'object')
      for (const [key, child] of Object.entries(item)) {
        visit(key, depth + 1);
        visit(child, depth + 1);
      }
  }
  visit(value, 0);
}

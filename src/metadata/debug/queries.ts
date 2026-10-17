import { checkedU64, type Diagnostic, type OperationContext } from '../../core/index.js';
import type {
  DebugInlineScope,
  DebugLine,
  DebugLocation,
  DebugVariable,
  DwarfData,
} from '../dwarf/index.js';

export interface DebugAddressContext {
  readonly sources: readonly DebugLine[];
  readonly inline_scopes: readonly DebugInlineScope[];
  readonly conflicting: boolean;
}
/** Half-open membership, including discontiguous scopes. Retain overlapping source
 * claims instead of choosing a CU by incidental sort order. Paths are labels only. */
export function debugContextAt(
  data: DwarfData | null,
  address: bigint,
  context: OperationContext,
): DebugAddressContext {
  checkedU64(address);
  context.checkpoint(0);
  if (!data) return { sources: [], inline_scopes: [], conflicting: false };
  const sources: DebugLine[] = [],
    scopes: DebugInlineScope[] = [];
  for (const row of data.lines) {
    context.checkpoint(1);
    if (
      !row.endSequence &&
      row.endAddress !== undefined &&
      row.address <= address &&
      address < row.endAddress
    )
      sources.push(row);
  }
  for (const scope of data.inlineScopes ?? []) {
    for (const range of scope.ranges) {
      context.checkpoint(1);
      if (range.start <= address && address < range.end) {
        scopes.push(scope);
        break;
      }
    }
  }
  const byId = new Map(scopes.map((scope) => [scope.id, scope]));
  const depths = new Map<string, number>();
  for (const scope of scopes) {
    const seen = new Set<string>();
    let parent = scope.parentId;
    while (parent !== undefined && !seen.has(parent)) {
      context.checkpoint(1);
      seen.add(parent);
      parent = byId.get(parent)?.parentId;
    }
    depths.set(scope.id, seen.size);
  }
  scopes.sort((a, b) => depths.get(a.id)! - depths.get(b.id)! || a.id.localeCompare(b.id));
  return {
    sources,
    inline_scopes: scopes,
    conflicting: sources.some(
      (row) =>
        row.file !== sources[0]?.file ||
        row.line !== sources[0]?.line ||
        row.column !== sources[0]?.column,
    ),
  };
}

export interface ScopedVariableLocations {
  readonly variable: DebugVariable | null;
  readonly locations: readonly DebugLocation[];
  readonly conflicting: boolean;
  readonly diagnostics: readonly Diagnostic[];
}
/** Resolve fbreg only through this concrete function's frame-base entries at PC.
 * Register numbers remain DWARF numbers for the ABI adapter, not guessed decoder IDs.
 * No target register/memory state is read. Unresolved frame offsets remain symbolic. */
export function variableLocationsAt(
  data: DwarfData | null,
  variableId: string,
  address: bigint,
  context: OperationContext,
): ScopedVariableLocations {
  checkedU64(address);
  context.checkpoint(0);
  let variable: DebugVariable | undefined;
  for (const candidate of data?.variables ?? []) {
    context.checkpoint(1);
    if (candidate.id === variableId) {
      variable = candidate;
      break;
    }
  }
  if (!variable || !data)
    return { variable: null, locations: [], conflicting: false, diagnostics: [] };
  const locations: DebugLocation[] = [],
    diagnostics: Diagnostic[] = [];
  for (const entry of variable.locations) {
    context.checkpoint(1);
    const inScope = entry.ranges.length
      ? entry.ranges.some((range) => {
          context.checkpoint(1);
          return range.start <= address && address < range.end;
        })
      : variable.functionAddress === undefined;
    if (!inScope) continue;
    if (entry.location.kind !== 'frame-offset') {
      locations.push(entry.location);
      continue;
    }
    const displacement = entry.location.offset;
    let resolved = false;
    for (const fn of data.functions) {
      context.checkpoint(1);
      if (fn.address !== variable.functionAddress) continue;
      for (const base of fn.frameBase ?? []) {
        context.checkpoint(1);
        if (
          !base.ranges.some((range) => {
            context.checkpoint(1);
            return range.start <= address && address < range.end;
          })
        )
          continue;
        const location = base.location;
        if (location.kind === 'register') {
          locations.push({
            kind: 'register-offset',
            register: location.register,
            offset: displacement,
          });
          resolved = true;
        } else if (location.kind === 'register-offset') {
          const offset = location.offset + displacement;
          if (offset >= -(1n << 63n) && offset < 1n << 63n) {
            locations.push({ ...location, offset });
            resolved = true;
          }
        } else if (location.kind === 'address') {
          const value = location.address + displacement;
          if (value >= 0n && value < 1n << 64n) {
            locations.push({ kind: 'address', address: value });
            resolved = true;
          }
        }
      }
    }
    if (!resolved) {
      locations.push(entry.location);
      diagnostics.push({
        code: 'unavailable_semantics',
        severity: 'warning',
        message: 'DWARF frame-relative storage lacks a supported frame base at this address',
        evidence_ids: [],
      });
    }
  }
  const conflicting = locations.length > 1;
  if (conflicting)
    diagnostics.push({
      code: 'conflicting_evidence',
      severity: 'warning',
      message: 'Multiple scoped DWARF storage claims apply at this address',
      evidence_ids: [],
    });
  return { variable, locations, conflicting, diagnostics };
}

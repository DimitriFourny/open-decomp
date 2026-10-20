import { bitWidth, type Expression, type Value } from '../ir/index.js';
import type { BlockRegion, ParallelTransfer } from '../presentation/index.js';
import { type LocalValidationRecord, ValidationAllowance } from './local-validation.js';

export type StorageEvent =
  | {
      readonly kind: 'store';
      readonly offset: bigint | null;
      readonly bytes: number;
      readonly value: string;
      readonly promoted: boolean;
      readonly endian?: 'little' | 'big';
    }
  | {
      readonly kind: 'load';
      readonly offset: bigint;
      readonly bytes: number;
      /** `local`: the promoted scalar's bytes. Otherwise the proposed byte
       * identities (`value:significance`), least significant load byte first:
       * a forwarded value, a narrower part of one, or adjacent stored parts. */
      readonly candidate: 'local' | readonly string[];
      readonly endian?: 'little' | 'big';
    }
  | { readonly kind: 'barrier'; readonly subject: string };

/** Byte-addressed original memory and a distinct promoted scalar state. A read
 * from an uninitialized byte is not silently modeled as zero or a fresh scalar. */
export function validateStorageTrace(
  subject: string,
  events: readonly StorageEvent[],
  allowance: ValidationAllowance,
): LocalValidationRecord {
  const record = {
    kind: 'stack-promotion' as const,
    subject,
    scope: 'bounded ordered private-stack byte accesses and scalar replacement',
  };
  const bytes = new Map<bigint, string>(),
    written = new Map<bigint, number>();
  let local: string | undefined,
    epoch = 0;
  let alias: { epoch: number; value: string } | undefined;
  for (const event of events) {
    allowance.charge();
    epoch++;
    if (event.kind === 'barrier')
      return { ...record, status: 'unverified', reason: `alias/effect barrier ${event.subject}` };
    if (event.kind === 'store') {
      if (event.offset === null) {
        alias = { epoch, value: event.value };
        continue;
      }
      for (let i = 0; i < event.bytes; i++) {
        allowance.charge();
        bytes.set(
          event.offset + BigInt(i),
          `${event.value}:${event.endian === 'big' ? event.bytes - 1 - i : i}`,
        );
        written.set(event.offset + BigInt(i), epoch);
      }
      if (event.promoted) local = event.value;
      continue;
    }
    const candidates =
      event.candidate === 'local'
        ? local === undefined
          ? []
          : [local]
        : [...new Set(event.candidate.map((source) => source.slice(0, source.lastIndexOf(':'))))];
    for (let i = 0; i < event.bytes; i++) {
      allowance.charge();
      const address = event.offset + BigInt(i),
        expected = bytes.get(address),
        significance = event.endian === 'big' ? event.bytes - 1 - i : i,
        candidate =
          event.candidate === 'local'
            ? local === undefined
              ? undefined
              : `${local}:${significance}`
            : event.candidate[significance];
      if (alias && alias.epoch > (written.get(address) ?? -1)) {
        if (!candidates.length || candidates.includes(alias.value))
          return {
            ...record,
            status: 'unverified',
            reason: 'unresolved alias relation to promoted scalar',
          };
        return {
          ...record,
          status: 'rejected',
          counterexample: {
            alias_address: String(address),
            ...Object.fromEntries(candidates.map((value) => [value, '0xffffffffffffffff'])),
            [alias.value]: '0x0',
            original_byte_after_alias: '0x00',
            promoted_byte: '0xff',
          },
        };
      }
      if (expected === undefined || candidate === undefined || expected !== candidate)
        return {
          ...record,
          status: 'rejected',
          counterexample: {
            byte: String(address),
            original: expected ?? 'uninitialized',
            promoted: candidate ?? 'uninitialized scalar',
          },
        };
    }
  }
  return { ...record, status: 'verified' };
}

export interface ForwardedByte {
  readonly value: Value;
  readonly index: number;
}
/** Enumerate small acyclic paths independently of the planner's reaching-value
 * fixed point. Loops/large CFGs are explicitly outside this proof scope. */
export function validateStackPromotion(
  subject: string,
  entry: string,
  blocks: ReadonlyMap<string, BlockRegion>,
  transfers: readonly { transfer: ParallelTransfer; block: BlockRegion }[],
  addresses: ReadonlyMap<string, bigint>,
  group: ReadonlySet<string>,
  /** Proposed bytes of each forwarded load, least significant first: a byte
   * (`index` = significance) of the value a store wrote. */
  forwarded: ReadonlyMap<string, readonly ForwardedByte[]> | null,
  expressions: ReadonlyMap<string, Expression>,
  allowance: ValidationAllowance,
  disjointStores?: ReadonlySet<string>,
): LocalValidationRecord {
  const base = {
    kind: 'stack-promotion' as const,
    subject,
    scope:
      'all bounded acyclic CFG paths; ordered original bytes versus proposed scalar/forwarding' +
      (disjointStores?.size
        ? '; external stores disjoint under activation-private ABI storage'
        : ''),
  };
  if (blocks.size > 32)
    return { ...base, status: 'unverified', reason: 'stack CFG block bound exceeded' };
  const successors = new Map<string, string[]>();
  for (const { transfer, block } of transfers) {
    allowance.charge();
    const row = successors.get(block.id) ?? [];
    if (!row.includes(transfer.target)) row.push(transfer.target);
    successors.set(block.id, row);
  }
  const pending = [{ id: entry, path: [] as string[], events: [] as StorageEvent[] }];
  let paths = 0,
    nodes = 0;
  const identity = (value: Value): string => {
    const seen = new Set<string>();
    while (!seen.has(value.id)) {
      allowance.charge();
      seen.add(value.id);
      const expression = expressions.get(value.id);
      if (expression?.kind !== 'cast' || expression.op !== 'bitcast') break;
      value = expression.value;
    }
    return value.id;
  };
  while (pending.length) {
    allowance.charge();
    const current = pending.pop()!;
    if (current.path.includes(current.id))
      return {
        ...base,
        status: 'unverified',
        reason: 'cyclic stack path is outside bounded proof',
      };
    if (++nodes > 256 || pending.length > 64)
      return { ...base, status: 'unverified', reason: 'stack path enumeration bound exceeded' };
    const events = [...current.events],
      path = [...current.path, current.id];
    for (const node of blocks.get(current.id)!.statements) {
      allowance.charge();
      if (node.kind === 'call' || node.kind === 'unknown_effect')
        events.push({ kind: 'barrier', subject: node.id });
      if (node.kind === 'load' && !addresses.has(node.address.id))
        events.push({ kind: 'barrier', subject: `unknown-address load ${node.id}` });
      if (node.kind === 'store' && !disjointStores?.has(node.id))
        events.push({
          kind: 'store',
          offset: addresses.get(node.address.id) ?? null,
          bytes: Math.ceil(bitWidth(node.value.type) / 8),
          endian: node.access.endian,
          value: identity(node.value),
          promoted: group.has(node.id),
        });
      if (node.kind === 'load' && group.has(node.id))
        events.push({
          kind: 'load',
          offset: addresses.get(node.address.id)!,
          bytes: Math.ceil(bitWidth(node.result.type) / 8),
          endian: node.access.endian,
          candidate: forwarded
            ? forwarded.get(node.id)!.map((source) => `${identity(source.value)}:${source.index}`)
            : 'local',
        });
    }
    const next = successors.get(current.id) ?? [];
    if (!next.length) {
      if (++paths > 64)
        return { ...base, status: 'unverified', reason: 'stack completed-path bound exceeded' };
      const result = validateStorageTrace(subject, events, allowance);
      if (result.status !== 'verified')
        return {
          ...result,
          scope: base.scope,
          ...(result.counterexample
            ? { counterexample: { ...result.counterexample, path: path.join(' -> ') } }
            : {}),
        };
    } else for (const id of next) pending.push({ id, path, events });
  }
  return { ...base, status: 'verified' };
}

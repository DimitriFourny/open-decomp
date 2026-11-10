import type { OperationContext } from '../../core/index.js';
import type { StackRecoveryResult } from '../../analysis/stack/index.js';
import {
  bitWidth,
  computeDominance,
  type Dominance,
  type Instruction,
  type SSAForm,
  type Value,
} from '../../ir/index.js';
import {
  preservedCallOutputs,
  writesRegister,
  type RegisterSlice,
} from '../../analysis/calls/preserved.js';
import { fpEnvironmentGuard } from '../../lifters/arm64/semantics.js';
import { x86FpEnvironmentGuard } from '../../lifters/x86_64/semantics.js';
import { createNativeInterfaceIndex, type NativeInterfaceIndex } from './native-entry.js';
import type { NativeInterface } from './native-worklist.js';

const fpGuardArms = new Set<string>([
  x86FpEnvironmentGuard.unsupported_exit,
  fpEnvironmentGuard.unsupported_exit,
]);
const fpGuardEffect = fpEnvironmentGuard.unsupported_effect;

const mask = (offset: number, width: number): bigint =>
  ((1n << BigInt(width)) - 1n) << BigInt(offset);

/**
 * The register bits a prepared native body may leave different from their entry
 * value on some returning path, closed over its callees (`written_registers`).
 *
 * A bit is unwritten only when every return exit (and every tail exit, for bits
 * its tail target leaves unwritten) holds exactly the entry bits there, through
 * edge copies, same-width bitcasts, extracts, concatenations and call outputs of
 * cells the called function's own summary proves unwritten. Every other cell is
 * written, unless it is restored: reloaded from a frame slot that only its save
 * writes (push/pop of a caller-saved register, as Win64 stack probes do). Calls without such a summary (imports, indirect or unresolved calls, a
 * callee the worklist cut) write their whole clobber set, which also covers the
 * roots this body tracks no cell for. Flags are left out: callers never refine them.
 *
 * Undefined (no set; callers keep the ABI clobbers) for a body that is not
 * complete: an unknown effect, an unknown exit (other than an FP-environment guard
 * arm) or an unresolved non-tail indirect transfer, or a tail transfer whose target
 * has no written-register set.
 *
 * Sound for recursion at any pre-fixpoint: if the sets assumed for the calls of a
 * group are supersets of what this computes from them, every returning execution
 * (a finite call tree, by induction on its height) writes only those bits. The
 * worklist seeds recursive members with no callee summaries (the whole clobber set)
 * and its iterations only shrink the sets from there.
 */
export function nativeWrittenRegisters(
  ir: SSAForm,
  interfaces: ReadonlyMap<string, NativeInterface>,
  context: OperationContext,
  index?: NativeInterfaceIndex,
  stack?: StackRecoveryResult,
): readonly RegisterSlice[] | undefined {
  for (const block of ir.blocks) {
    context.checkpoint(1 + block.instructions.length);
    const control = block.terminator;
    // The lifter's FP-environment guard arm stands for the same instruction under
    // another FP control state: it writes the same registers and continues on paths
    // this body already has (or traps), so it adds nothing to the set.
    if (control.kind === 'unknown' && fpGuardArms.has(control.reason)) {
      if (
        block.instructions.some(
          (node) => node.kind === 'unknown_effect' && node.reason !== fpGuardEffect,
        )
      )
        return undefined;
      continue;
    }
    if (control.kind === 'unknown' || (control.kind === 'indirect' && !control.tail_call))
      return undefined;
    if (block.instructions.some((node) => node.kind === 'unknown_effect')) return undefined;
  }
  const prepared = (index ?? createNativeInterfaceIndex(ir, undefined, context)).preparation(
    ir,
    context,
  );
  const written = new Map<string, bigint>(),
    represented = new Map<string, bigint>();
  const add = (
    into: Map<string, bigint>,
    register: RegisterSlice,
  ): void => {
    into.set(
      register.root,
      (into.get(register.root) ?? 0n) | mask(register.offset_bits, register.width_bits),
    );
  };
  for (const binding of prepared.entry) add(represented, binding.register);
  // Calls write what their callee's set (else their clobber set) names; for the cells
  // this body tracks, the exits below decide, so only untracked bits are added here.
  for (const call of prepared.calls) {
    context.checkpoint(1);
    const callee = interfaces.get(call.id)?.written_registers ?? call.clobbers.registers;
    for (const slice of callee) {
      context.checkpoint(1);
      const bits =
        mask(slice.offset_bits, slice.width_bits) & ~(represented.get(slice.root) ?? 0n);
      if (bits) written.set(slice.root, (written.get(slice.root) ?? 0n) | bits);
    }
  }
  const tails = new Map<string, readonly RegisterSlice[]>();
  for (const block of prepared.tails) {
    const target = interfaces.get(block.terminator.id)?.written_registers;
    if (!target) return undefined;
    tails.set(block.id, target);
    for (const slice of target) add(written, slice);
  }
  // Call outputs the callee's own set proves unchanged, to the value before the call.
  const through = new Map<string, Value>();
  for (const call of prepared.calls) {
    const callee = interfaces.get(call.id)?.written_registers;
    if (callee)
      for (const [output, input] of preservedCallOutputs(call, callee))
        through.set(output.id, input);
  }
  // A restore: a little-endian load of an exact frame slot that exactly one store of
  // the body writes (same offset and width, no other store touching its bytes), that
  // store dominating the load, whose bytes the stack recovery still holds from that
  // store at the load, in order, with no alias barrier (call, unknown or dynamic
  // store) on any path before it, reads that store's value.
  const slotStore = new Map<bigint, string | null>(),
    stores = new Map<string, Extract<Instruction, { kind: 'store' }>>(),
    sites = new Map<string, { readonly block: string; readonly index: number }>();
  if (stack?.state === 'complete')
    for (const block of ir.blocks)
      for (const [index, node] of block.instructions.entries()) {
        if (node.kind !== 'store' && node.kind !== 'load') continue;
        context.checkpoint(1);
        sites.set(node.id, { block: block.id, index });
        if (node.kind !== 'store') continue;
        stores.set(node.id, node);
        const address = stack.values.get(node.address.id)?.value;
        if (address?.kind !== 'stack') continue;
        const size = BigInt(Math.ceil(bitWidth(node.value.type) / 8));
        for (let byte = 0n; byte < size; byte++) {
          const at = address.offset + byte;
          slotStore.set(at, slotStore.has(at) ? null : node.id);
        }
      }
  let dominance: Dominance | undefined;
  const before = (store: string, load: string): boolean => {
    const from = sites.get(store)!,
      to = sites.get(load)!;
    if (from.block === to.block) return from.index < to.index;
    dominance ??= computeDominance(ir, (work) => context.checkpoint(work));
    return dominance.dominates(from.block, to.block);
  };
  const restored = (value: Value): Value | undefined => {
    const id = prepared.load_nodes.get(value.id);
    const load = id === undefined ? undefined : prepared.loads.get(id);
    const address = load && stack?.values.get(load.address.id)?.value;
    const snapshot = load && stack?.snapshots.get(load.id);
    if (!load || address?.kind !== 'stack' || !snapshot || snapshot.aliased) return undefined;
    const size = BigInt(Math.ceil(bitWidth(value.type) / 8));
    const store = stores.get(slotStore.get(address.offset) ?? '');
    const stored = store && stack?.values.get(store.address.id)?.value;
    if (
      !store ||
      stored?.kind !== 'stack' ||
      stored.offset !== address.offset ||
      bitWidth(store.value.type) !== bitWidth(value.type) ||
      store.access.endian !== 'little' ||
      load.access.endian !== 'little' ||
      !before(store.id, load.id)
    )
      return undefined;
    for (let byte = 0n; byte < size; byte++) {
      const held = snapshot.memory.get(address.offset + byte);
      if (
        slotStore.get(address.offset + byte) !== store.id ||
        !held?.fact.value_ids.includes(store.value.id) ||
        held.value_offset_bits !== Number(byte) * 8
      )
        return undefined;
    }
    return store.value;
  };
  // `value` holds exactly the entry bits of `root` from `offset` up (its width).
  // Coinductive over edge copies (a loop carrying the value unchanged keeps it);
  // positive answers are cached: every pair a successful query visited holds.
  const holding = new Set<string>();
  const holds = (start: Value, root: string, offset: number): boolean => {
    const pending: [Value, number][] = [[start, offset]],
      visited = new Set<string>();
    while (pending.length) {
      context.checkpoint(1);
      const [value, at] = pending.pop()!;
      const key = `${root}:${value.id}:${at}`;
      if (holding.has(key) || visited.has(key)) continue;
      visited.add(key);
      if (visited.size > 256 || at < 0) return false;
      const width = bitWidth(value.type);
      const entry = prepared.entry_registers.get(value.id);
      if (entry) {
        if (entry.root !== root || entry.offset_bits !== at || entry.width_bits !== width)
          return false;
        // A loop back into the entry block merges other values into its bindings.
        for (const source of prepared.sources.get(value.id) ?? []) pending.push([source, at]);
        continue;
      }
      const incoming = prepared.sources.get(value.id);
      if (incoming) {
        for (const source of incoming) pending.push([source, at]);
        continue;
      }
      const input = through.get(value.id) ?? restored(value);
      if (input) {
        pending.push([input, at]);
        continue;
      }
      const expression = prepared.expressions.get(value.id);
      if (
        expression?.kind === 'cast' &&
        expression.op === 'bitcast' &&
        bitWidth(expression.value.type) === width
      )
        pending.push([expression.value, at]);
      else if (expression?.kind === 'extract') pending.push([expression.value, at - expression.offset]);
      else if (expression?.kind === 'concat') {
        let part = at;
        for (const item of expression.values) {
          pending.push([item, part]);
          part += bitWidth(item.type);
        }
      } else return false;
    }
    for (const key of visited) holding.add(key);
    return true;
  };
  for (const block of [...prepared.exits, ...prepared.tails]) {
    const tail = tails.get(block.id);
    for (const { register, value } of prepared.states.get(block.id)?.exit ?? []) {
      context.checkpoint(1);
      if (register.bank === 'flags' || (tail && writesRegister(tail, register))) continue;
      if (!holds(value, register.root, register.offset_bits)) add(written, register);
    }
  }
  const slices: RegisterSlice[] = [];
  for (const [root, bits] of [...written].sort(([left], [right]) => (left < right ? -1 : 1))) {
    let rest = bits,
      offset = 0;
    while (rest) {
      context.checkpoint(1);
      if (!(rest & 1n)) {
        const skip = (rest & -rest).toString(2).length - 1;
        rest >>= BigInt(skip);
        offset += skip;
        continue;
      }
      const run = (~rest & (rest + 1n)).toString(2).length - 1;
      slices.push({ root, offset_bits: offset, width_bits: run });
      rest >>= BigInt(run);
      offset += run;
    }
  }
  return slices;
}

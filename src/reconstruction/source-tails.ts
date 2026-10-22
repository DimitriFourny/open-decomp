import type { OperationContext } from '../core/index.js';
import type { EmissionInput } from '../emitters/model.js';
import { bitWidth, expressionOperands, type Expression, type Value } from '../ir/index.js';
import type { BlockRegion } from '../presentation/index.js';
import type { LocalValidationSession } from './local-validation.js';
import type { FrameAccess, FrameSave, FrameSaveQualifier } from './source-stack.js';

/** Values of a target's expression cone examined for code addresses; a larger
 * cone is not classified. */
const TARGET_CONE_NODES = 128;

/** Source view: unresolved indirect exits (`indirect` without `tail_call`) that
 * transfer exactly like a call of their runtime target by this function's
 * caller. An exit qualifies when
 * - its SP is the entry SP;
 * - the target is a runtime value: some leaf of its expression cone (at most
 *   128 values; loads, call results and entry values are leaves) is not a
 *   constant, and no value of the cone is a code address of the image, which
 *   would make the branch switch-like (a known destination, a table base);
 * - its return location holds the entry return address: on a link-register ABI
 *   the link register is its unmodified entry value, or a reload of a slot
 *   that qualifies as a frame save with this exit included (recorded under an
 *   `abi_conformance` requirement); on an ABI whose call pushes the return
 *   address, no store overlaps those bytes at the entry SP and no store has an
 *   unknown address;
 * - no frame address escapes: the frame is released before the transfer, so no
 *   pointer into it may outlive it.
 * Each accepted exit writes an `indirect_tail_call` presentation record. */
export function classifyIndirectTails(facts: {
  readonly input: EmissionInput;
  readonly blocks: ReadonlyMap<string, BlockRegion>;
  readonly expressions: ReadonlyMap<string, Expression>;
  /** Phi sources by destination value. */
  readonly incoming: ReadonlyMap<string, readonly Value[]>;
  /** Entry-SP offset of a stack address, when known. */
  readonly stackOffset: (value: Value) => bigint | undefined;
  /** Some frame address may escape or an unknown effect may reach the frame. */
  readonly frameEscapes: boolean;
  /** Stores at known entry-SP offsets. */
  readonly stores: readonly FrameAccess[];
  /** Some store has an address that is not a known entry-SP offset. */
  readonly unknownStores: boolean;
  /** Return and tail-call exits. */
  readonly exits: readonly BlockRegion[];
  readonly frameSaves: FrameSaveQualifier;
  readonly validation: LocalValidationSession;
  readonly context: OperationContext;
}): ReadonlySet<string> {
  const { blocks, expressions, incoming, context } = facts;
  const accepted = new Set<string>();
  const source = facts.input.source;
  if (!source || facts.frameEscapes) return accepted;
  const abi = source.abi,
    executable = source.executable_ranges;
  // Without the image's executable ranges every constant may be a code address.
  const code = (bits: bigint): boolean =>
    executable === undefined || executable.some((range) => bits >= range.start && bits < range.end);
  const switchLike = (target: Value): boolean => {
    const seen = new Set<string>(),
      pending = [target];
    let runtime = false;
    while (pending.length) {
      context.checkpoint(1);
      const value = pending.pop()!;
      if (seen.has(value.id)) continue;
      if (seen.size === TARGET_CONE_NODES) return true;
      seen.add(value.id);
      const expression = expressions.get(value.id);
      if (expression?.kind === 'constant') {
        if (code(BigInt.asUintN(bitWidth(value.type), expression.bits))) return true;
      } else if (expression?.kind === 'address') {
        if (expression.address.space !== 'va' || code(expression.address.value)) return true;
      } else if (expression?.kind === 'indeterminate') runtime = true;
      else if (expression) pending.push(...expressionOperands(expression));
      else {
        const sources = incoming.get(value.id);
        if (sources?.length) pending.push(...sources);
        else runtime = true;
      }
    }
    // A cone of constants only is a known destination, not a runtime target.
    return !runtime;
  };
  const sp = abi.stack_pointer,
    link = abi.link_register;
  const atEntrySp = (block: BlockRegion): boolean => {
    const bindings = block.register_exit.filter((binding) => binding.register.root === sp.root);
    return (
      bindings.length === 1 &&
      bindings[0]!.register.offset_bits === sp.offset_bits &&
      bindings[0]!.register.width_bits === sp.width_bits &&
      facts.stackOffset(bindings[0]!.value) === 0n
    );
  };
  for (const block of blocks.values()) {
    const control = block.control;
    if (control.kind !== 'indirect' || control.tail_call) continue;
    context.checkpoint(1);
    if (!atEntrySp(block) || switchLike(control.target)) continue;
    let route: string | undefined, save: FrameSave | undefined;
    if (abi.stack_return_address_bytes > 0n) {
      const bytes = abi.stack_return_address_bytes;
      if (
        !facts.unknownStores &&
        !facts.stores.some((store) => store.offset < bytes && store.end > 0n)
      )
        route = `no store reaches the ${bytes}-byte return address at the entry SP: every store has a known entry-SP offset outside it`;
    } else if (link) {
      const bits = { root: link.root, low: link.offset_bits, width: link.width_bits };
      if (facts.frameSaves.restores(block, bits, new Set()))
        route = `${link.root} holds its entry value`;
      else {
        save = facts.frameSaves
          .qualify([...facts.exits, block])
          .find(
            (candidate) =>
              candidate.bits.root === link.root &&
              candidate.bits.low <= link.offset_bits &&
              candidate.bits.low + candidate.bits.width >= link.offset_bits + link.width_bits,
          );
        if (save)
          route = `${link.root} is reloaded from its frame save at entry SP ${save.save.offset}, which qualifies with this exit included`;
      }
    }
    if (
      route === undefined ||
      !facts.validation.presentation(
        'indirect_tail_call',
        control.id,
        `indirect branch at the entry SP whose return location holds the entry return address (${route}); no frame address escapes and the target cone holds no code address: the caller observes a call of the runtime target. Arguments are the observed argument-register prefix with the list open; results and target effects stay unknown`,
        [
          control.id,
          control.target.id,
          ...(save ? [save.save.node.id, ...save.loads.map((load) => load.node.id)] : []),
        ].slice(0, 64),
      )
    )
      continue;
    if (save)
      facts.validation.requireAbi(
        'indirect_tail_call',
        [control.id, save.save.node.id],
        'Presenting an indirect branch after a frame restore as a tail call assumes ABI conformance: callees never write the saved return-address slot, so its reload is the entry return address. The branch, the save and its reload remain in the checked view and the original mappings.',
      );
    accepted.add(control.id);
  }
  return accepted;
}

import type { OperationContext } from '../../core/index.js';
import {
  callerSiteIndex,
  callerSiteIndexWork,
  callerSites,
  classifyResultUse,
  type CallerSite,
  type ResultUse,
} from '../../analysis/calls/caller-sites.js';
import { Arm64Decoder } from '../../decoders/arm64/index.js';
import { X86Decoder } from '../../decoders/x86_64/index.js';
import type { CallerResultDemand } from '../../reconstruction/source-model.js';
import type { PreparedNativeUnit } from './native-prepare.js';
import type { SourceFactsInput } from './source-facts.js';

/** Most call sites one request classifies for positive result use. */
export const MAX_RESULT_USE_SITES = 32;

/** Marks the end of this scan's own share of the request's work. */
class ShareSpent extends Error {}

/** Positive caller result-use evidence for the selected function: the result registers
 * read after the first direct call site (smallest callers first, at most
 * `MAX_RESULT_USE_SITES`) whose caller provably consumes them. A caller unit this
 * request already prepared answers from its semantic demand; any other site lifts a
 * bounded window after its return address. The index and every window are charged to
 * the request inside a quarter of its remaining work; an exhausted share, or no
 * semantic site, abstains (`undefined`). Absence is never evidence that callers
 * ignore the result. */
export function callerResultDemands(
  input: SourceFactsInput,
  units: Iterable<PreparedNativeUnit>,
  context: OperationContext,
): CallerResultDemand | undefined {
  const share = Math.floor((context.remainingWork?.() ?? 0) / 4);
  const indexWork = callerSiteIndexWork(input.image, input.functions, input.references);
  if (indexWork > share) return undefined;
  const index = callerSiteIndex(input.image, input.functions, input.references, false, context);
  const fn = index.functions_by_id.get(input.ir.id);
  if (!fn) return undefined;
  const candidates = callerSites(index, fn.entry, context)
    .sites.filter((site) => site.kind === 'call' && site.caller !== null)
    .map((site) => ({
      site,
      size:
        site.caller_extent ?? site.caller!.ranges.reduce((total, range) => total + range.size, 0n),
    }))
    .sort((a, b) =>
      a.size !== b.size
        ? a.size < b.size
          ? -1
          : 1
        : a.site.address.value < b.site.address.value
          ? -1
          : a.site.address.value > b.site.address.value
            ? 1
            : 0,
    )
    .slice(0, MAX_RESULT_USE_SITES);
  if (!candidates.length) return undefined;
  const byCaller = new Map<string, PreparedNativeUnit[]>();
  for (const unit of units) {
    context.checkpoint(1);
    if (!unit.ir) continue;
    const list = byCaller.get(unit.function.id);
    if (list) list.push(unit);
    else byCaller.set(unit.function.id, [unit]);
  }
  const allowance = share - indexWork;
  let used = 0;
  const local: OperationContext = {
    ...context,
    remainingWork: () => Math.max(0, Math.min(allowance - used, context.remainingWork?.() ?? 0)),
    checkpoint(work) {
      if (used + work > allowance) throw new ShareSpent();
      context.checkpoint(work);
      used += work;
    },
  };
  // Semantic demand of an already prepared caller body at this exact call node.
  const prepared = (site: CallerSite, instruction: string): ResultUse | undefined => {
    for (const unit of byCaller.get(site.caller!.id) ?? [])
      for (const dependency of unit.dependencies) {
        local.checkpoint(1);
        if (dependency.target.id !== fn.id || !dependency.return_demand_semantic?.length) continue;
        for (const block of unit.ir!.blocks) {
          local.checkpoint(1 + block.instructions.length);
          const node = block.instructions.find((item) => item.id === dependency.call_id);
          if (node?.provenance.instruction_ids.includes(instruction))
            return { kind: 'semantic', registers: dependency.return_demand_semantic };
        }
      }
    return undefined;
  };
  const decoder =
    input.image.target.architecture === 'arm64'
      ? new Arm64Decoder()
      : new X86Decoder({ formatting: false });
  try {
    for (const { site } of candidates) {
      const use = classifyResultUse(
        {
          index,
          decoder,
          lifter: input.components.lifter,
          abi: input.components.abi,
          prepared,
        },
        site,
        local,
      );
      if (use.kind === 'semantic') return { registers: use.registers, sites: [site.address] };
    }
  } catch (error) {
    if (error instanceof ShareSpent) return undefined;
    throw error;
  } finally {
    decoder.dispose();
  }
  return undefined;
}

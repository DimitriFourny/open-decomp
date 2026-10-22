import type { Address, FunctionRecord, LoadedImage, OperationContext } from '../../core/index.js';
import {
  callerSiteIndex,
  callerSiteIndexWork,
  callerSites,
  classifyResultUse,
  resultRoots,
  type CallerSite,
  type CallerSiteIndex,
  type ResultUse,
} from '../../analysis/calls/caller-sites.js';
import { Arm64Decoder } from '../../decoders/arm64/index.js';
import { X86Decoder } from '../../decoders/x86_64/index.js';
import type {
  CallerResultDemand,
  FunctionResultUse,
} from '../../reconstruction/source-model.js';
import type { PreparedNativeUnit } from './native-prepare.js';
import type { SourceFactsInput } from './source-facts.js';

/** Most call sites one request classifies for positive result use. */
export const MAX_RESULT_USE_SITES = 32;
/** Caller consensus bounds: direct sites of one function, sites across the whole
 * recursion through forwarding callers, and the recursion depth. */
export const MAX_CONSENSUS_SITES = 64;
export const MAX_CONSENSUS_TOTAL_SITES = 128;
export const MAX_CONSENSUS_DEPTH = 6;

/** Marks the end of this scan's own share of the request's work. */
class ShareSpent extends Error {}

/** A context that charges `context` but throws `ShareSpent` past `allowance`. */
function shareContext(context: OperationContext, allowance: number): OperationContext {
  let used = 0;
  return {
    ...context,
    remainingWork: () => Math.max(0, Math.min(allowance - used, context.remainingWork?.() ?? 0)),
    checkpoint(work) {
      if (used + work > allowance) throw new ShareSpent();
      context.checkpoint(work);
      used += work;
    },
  };
}

/** Whether the discovered reference index is complete (x86-64 site completeness rests
 * on it; the ARM64 sweep does not read it). */
function referencesComplete(input: SourceFactsInput, context: OperationContext): boolean {
  if (input.image.target.architecture === 'arm64') return false;
  context.checkpoint(1);
  return (
    input.scope.store.queryRecords({
      kind: 'reference',
      image_id: input.image.id,
      revision: input.revision,
      limit: 1,
    }).index_state === 'complete'
  );
}

/** Every absolute pointer in the image carries a loader fixup: a position-independent
 * Mach-O executable or any Mach-O dylib/bundle, an ELF `ET_DYN`, a PE with a dynamic
 * base. Elsewhere an unrelocated constant may hold a function address. */
function relocatable(image: LoadedImage, context: OperationContext): boolean {
  context.checkpoint(image.headers.length);
  const field = (name: string): bigint | undefined => {
    for (const header of image.headers)
      for (const item of header.fields)
        if (item.kind === 'integer' && item.name === name) return item.value;
    return undefined;
  };
  switch (image.target.format) {
    case 'macho': {
      const type = field('filetype'),
        flags = field('flags');
      return type !== undefined && flags !== undefined && (type !== 2n || (flags & 0x200000n) !== 0n);
    }
    case 'elf':
      return field('e_type') === 3n;
    case 'pe':
      return ((field('DllCharacteristics') ?? 0n) & 0x40n) !== 0n;
    default:
      return false;
  }
}

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
  const index = callerSiteIndex(
    input.image,
    input.functions,
    input.references,
    referencesComplete(input, context),
    context,
  );
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
  const local = shareContext(context, share - indexWork);
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

/** Closed-world caller consensus for the selected function (premise D1,
 * `caller_consensus`): no caller in the image observes its result registers. Proven
 * for a function F, recursively, when
 * (a) no export, global or weak symbol names F's entry;
 * (b) no relocation, rebase, bind or chained fixup targets it and no instruction
 *     materializes it or reaches it other than by an enumerated direct transfer
 *     (`CallerSiteIndex.escaped`), in an image whose format metadata loaded
 *     completely and whose absolute pointers all carry fixups;
 * (c) its direct site set is complete and every site lies in exactly one known
 *     function (`next_entry` attribution only with complete function starts);
 * (d) after every call site the integer result register (and the FP one when
 *     `floating`; the planner omits it when it holds no result of F) is overwritten before any read
 *     (`dead`), or reach only the caller's own return (`forwarded`) and that caller
 *     satisfies (a)-(d); a tail site requires the same of its caller. Callers being
 *     proven are assumed coinductively (recursion), depth at most
 *     `MAX_CONSENSUS_DEPTH`. A semantic read, an unknown window, a result forwarded
 *     into another tail transfer (its callee may read it as an argument), more than
 *     `MAX_CONSENSUS_SITES` sites of one function or `MAX_CONSENSUS_TOTAL_SITES` in
 *     all abstain. The index and windows are charged to the request inside a quarter
 *     of its remaining work; an exhausted share abstains. */
export function callerResultConsensus(
  input: SourceFactsInput,
  context: OperationContext,
  floating: boolean,
): FunctionResultUse | undefined {
  const { image } = input;
  const roots = resultRoots(input.components.abi);
  const tracked = floating ? roots : roots.slice(0, 1);
  const share = Math.floor((context.remainingWork?.() ?? 0) / 4);
  const indexWork = callerSiteIndexWork(image, input.functions, input.references);
  if (indexWork > share) return undefined;
  // Export, symbol and fixup tables must have loaded completely: any loader warning
  // other than undecoded semantics (DWARF CFI) may hide an export or a fixup.
  context.checkpoint(image.diagnostics.length);
  if (
    image.diagnostics.some(
      (diagnostic) => diagnostic.severity !== 'info' && diagnostic.code !== 'unavailable_semantics',
    ) ||
    !relocatable(image, context)
  )
    return undefined;
  const index = callerSiteIndex(
    image,
    input.functions,
    input.references,
    referencesComplete(input, context),
    context,
  );
  const fn = index.functions_by_id.get(input.ir.id);
  if (!fn) return undefined;
  const local = shareContext(context, share - indexWork);
  const decoder =
    image.target.architecture === 'arm64'
      ? new Arm64Decoder()
      : new X86Decoder({ formatting: false });
  try {
    // Entries a loader record makes reachable from outside the enumerated sites: exports,
    // global and weak symbols, fixup targets, image entry points and unwind handlers.
    // Objective-C relative method lists and Swift metadata hold code addresses as
    // relative offsets without fixups: such images abstain.
    local.checkpoint(
      image.exports.length +
        image.symbols.length +
        image.relocations.length +
        image.entry_points.length +
        image.hints.length +
        image.sections.length,
    );
    if (
      image.sections.some(
        (section) => section.name === '__objc_methlist' || section.name.startsWith('__swift5'),
      )
    )
      return undefined;
    const named = new Set<bigint>();
    for (const item of image.exports)
      if (item.address?.space === 'va') named.add(item.address.value);
    for (const symbol of image.symbols)
      if (symbol.binding !== 'local' && symbol.address?.space === 'va')
        named.add(symbol.address.value);
    for (const relocation of image.relocations)
      if (relocation.target?.space === 'va') named.add(relocation.target.value);
    for (const entry of image.entry_points) if (entry.space === 'va') named.add(entry.value);
    for (const hint of image.hints)
      if (hint.kind === 'unwind' && hint.handler?.space === 'va') named.add(hint.handler.value);
    const sites: Address[] = [];
    const visiting = new Set<string>();
    let total = 0;
    const ignored = (callee: FunctionRecord, depth: number): boolean => {
      if (visiting.has(callee.id)) return true;
      if (
        depth > MAX_CONSENSUS_DEPTH ||
        callee.entry.space !== 'va' ||
        callee.signature !== null ||
        callee.kind === 'import_stub' ||
        named.has(callee.entry.value) ||
        index.escaped.has(callee.entry.value)
      )
        return false;
      visiting.add(callee.id);
      const found = callerSites(index, callee.entry, local);
      total += found.sites.length;
      // A function no listed site reaches is reached only from outside the enumerated
      // world (or never): no caller consensus.
      if (
        !found.complete ||
        !found.sites.length ||
        found.sites.length > MAX_CONSENSUS_SITES ||
        total > MAX_CONSENSUS_TOTAL_SITES
      )
        return false;
      for (const site of found.sites) {
        if (!site.caller) return false;
        if (depth === 0) sites.push(site.address);
        const use = classifyResultUse(
          {
            index,
            decoder,
            lifter: input.components.lifter,
            abi: input.components.abi,
            roots: tracked,
          },
          site,
          local,
        );
        if (use.kind === 'dead') continue;
        if (
          use.kind !== 'forwarded' ||
          (site.kind === 'call' && use.tails.length) ||
          // The site's caller is its containing function: discovery owns the site,
          // or every loader function start is an entry, so the nearest entry below
          // the site starts its function.
          !(
            site.attribution === 'ranges' ||
            (site.attribution === 'next_entry' && index.starts_complete)
          ) ||
          !ignored(site.caller, depth + 1)
        )
          return false;
      }
      return true;
    };
    return ignored(fn, 0) ? { consensus: 'ignored', sites } : undefined;
  } catch (error) {
    if (error instanceof ShareSpent) return undefined;
    throw error;
  } finally {
    decoder.dispose();
  }
}

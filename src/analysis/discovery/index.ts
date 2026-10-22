import {
  checkedEnd,
  checkedU64,
  entityIdentity,
  fingerprint,
  OperationError,
  type Address,
  type AddressRange,
  type DecodeGap,
  type DecodedInstruction,
  type Decoder,
  type Diagnostic,
  type DiscoveryFrontier,
  type DiscoveryRoot,
  type Evidence,
  type FunctionGraph,
  type LoadedImage,
  type OperationContext,
  type ReferenceRecord,
  type FunctionRecord,
  type ResolvedJumpTable,
} from '../../core/index.js';
import { buildCFG, instructionSuccessors } from '../cfg/index.js';
import { jumpTableChain, proveJumpTable, type JumpTableProof } from './jump-tables.js';
import { reconcileGraphs, type DiscoveryLineage } from './lineage.js';
export type { DiscoveryLineage } from './lineage.js';

/** Same entry cap as indirect-table target recovery; larger tables stay unresolved. */
const MAX_JUMP_TABLE_ENTRIES = 256;
const JUMP_TABLE_RULE =
  'indirect branch targets from immutable table entries under a dominating unsigned index bound';
/** Linker-synthesized import trampoline sections (ELF PLT variants, Mach-O stub sections). */
const STUB_SECTION = /(^|[.,])(plt|plt\.sec|plt\.got|iplt)$|__(auth_|objc_)?stubs$|__stub_helper$/;

/** Assertions remain labeled evidence, never binary facts. Ranges are boundary claims, not
 * permission to decode unreachable bytes. Retracted assertions do not seed discovery. */
export interface FunctionAssertion {
  readonly entry: Address;
  readonly ranges?: readonly AddressRange[];
  readonly evidence: Evidence;
}
export interface DiscoveryInput {
  readonly image: LoadedImage;
  /** Caller owns decoder lifetime; architecture must match the loaded image. */
  readonly decoder: Decoder;
  readonly revision: number;
  readonly assertions?: readonly FunctionAssertion[];
  /** Reusable immutable metadata preparation, independent of traversal budgets. */
  readonly index?: DiscoveryIndex;
  /** Decode only this grounded root; calls and other known roots are boundaries. */
  readonly selected_entry?: Address;
  /** Already-published roots remain boundaries even if not loader-named. */
  readonly functions?: readonly FunctionRecord[];
  readonly previous?: readonly FunctionGraph[];
  /** Direct call targets (virtual addresses) declared noreturn by supported,
   * unconflicted library contracts, with the evidence of each declaration. Such a
   * call ends intraprocedural flow: its return address is never followed (it is
   * often the next function's entry, as after a final `bl ___stack_chk_fail`). */
  readonly noreturn_calls?: ReadonlyMap<bigint, readonly string[]>;
  /** Continue an earlier budget-limited image-wide discovery from its frontier. `functions`
   * must be everything it published: roots not pending are final (boundaries whose observed
   * ranges are explained bytes, never split or re-extracted); only the pending roots are
   * traversed, one root at a time, before the sweep resumes. */
  readonly resume?: DiscoveryFrontier;
}
export type { DiscoveryFrontier, DiscoveryRoot } from '../../core/index.js';
export interface JumpTableCandidate {
  readonly instruction_id: string | null;
  readonly address: Address;
  readonly range: AddressRange | null;
  readonly status: 'candidate';
  readonly evidence_ids: readonly string[];
}
export interface DiscoveryOverlap {
  readonly range: AddressRange;
  readonly function_ids: readonly string[];
  readonly instruction_ids: readonly string[];
  readonly kind: 'shared_tail' | 'overlapping_instructions';
}
/** Claimed extents are retained separately from observed reachable ranges. */
export interface DiscoveryBoundaryClaim {
  readonly entry: Address;
  readonly range: AddressRange;
  readonly evidence_ids: readonly string[];
}
export interface DiscoveryResult {
  readonly graphs: readonly FunctionGraph[];
  readonly references: readonly ReferenceRecord[];
  readonly evidence: readonly Evidence[];
  readonly lineage: readonly DiscoveryLineage[];
  readonly jump_tables: readonly JumpTableCandidate[];
  readonly overlaps: readonly DiscoveryOverlap[];
  readonly boundary_claims: readonly DiscoveryBoundaryClaim[];
  readonly coverage: FunctionGraph['coverage'];
  /** Whole-image enumeration (image-wide mode only): complete when every executable byte is
   * explained by a root's instructions, a loader extent, known data, fill or undecodable bytes,
   * so an address no function owns is provably not code any function starts or contains. */
  readonly enumeration: 'complete' | 'partial';
  /** Image-wide mode: where a continuation resumes; null once enumeration is complete or when
   * selected mode never enumerates. */
  readonly frontier: DiscoveryFrontier | null;
  readonly diagnostics: readonly Diagnostic[];
}
interface IndexedSeed {
  readonly entry: Address;
  readonly evidence: ReadonlySet<string>;
  readonly names: ReadonlySet<string>;
  readonly claims: readonly AddressRange[];
  readonly established: boolean;
}
interface Seed extends IndexedSeed {
  readonly evidence: Set<string>;
  readonly names: Set<string>;
  readonly claims: AddressRange[];
  established: boolean;
}
interface DataRegion {
  readonly range: AddressRange;
  readonly evidence_ids: readonly string[];
}
interface ExecutableRange {
  readonly start: bigint;
  end: bigint;
}
/** Half-open VA interval. */
interface Interval {
  readonly start: bigint;
  readonly end: bigint;
}

/** Native roots/data/executable lookup prepared once for an immutable image revision.
 * Lookup operations always charge the current operation, never the preparing clock. */
export interface DiscoveryIndex {
  readonly image_id: string;
  readonly slice_id: string;
  readonly revision: number;
  readonly seeds: ReadonlyMap<bigint, IndexedSeed>;
  readonly ordered_seeds: readonly IndexedSeed[];
  readonly evidence: ReadonlyMap<string, Evidence>;
  readonly data: readonly DataRegion[];
  readonly jump_tables: readonly JumpTableCandidate[];
  readonly boundary_claims: readonly DiscoveryBoundaryClaim[];
  /** File-backed executable VA ranges, sorted and coalesced. */
  readonly executable: readonly Interval[];
  /** Object-symbol addresses: named data, never a function root. */
  readonly objects: ReadonlySet<bigint>;
  data_after(value: bigint, context: OperationContext): number;
  executable_end(value: bigint, context: OperationContext): bigint;
}

function evidenceDeriver(image: LoadedImage, revision: number, evidence: Map<string, Evidence>) {
  return (rule: string, address: Address, parents: readonly string[]): string => {
    const derived_from = [...new Set(parents)].sort();
    const id = `evidence_${fingerprint([image.selected_slice_id, 'discovery/1', rule, address.value, derived_from])}`;
    if (!evidence.has(id))
      evidence.set(id, {
        id,
        origin: { kind: 'analysis', analyzer: 'open-decomp/discovery', version: '1', rule },
        claim: `${rule} at 0x${address.value.toString(16)}`,
        derived_from,
        conflicts_with: [],
        revision,
      });
    return id;
  };
}

/** Discovery is recursive traversal from evidence, never a prologue scan. Image-wide mode then
 * sweeps unexplained executable bytes into candidate roots; `enumeration` is complete only when
 * every executable byte is explained.
 * Unknown indirect flow remains partial. Instruction limits return partial reachable graphs;
 * work, block, deadline and cancellation limits throw OperationError and publish no result.
 * Decoder byte references are opaque (including split-backed VA ranges), not file offsets.
 */
export function discoverFunctions(
  input: DiscoveryInput,
  context: OperationContext,
): DiscoveryResult {
  context.checkpoint(0);
  const { image, decoder, revision } = input;
  if (decoder.architecture !== image.target.architecture)
    throw new OperationError({
      code: 'unsupported_target',
      severity: 'error',
      message: 'Discovery decoder architecture does not match loaded image',
      evidence_ids: [],
    });
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new OperationError({
      code: 'invalid_input',
      severity: 'error',
      message: 'Discovery requires a nonnegative safe revision',
      evidence_ids: [],
    });
  for (const graph of input.previous ?? [])
    if (graph.slice_id !== image.selected_slice_id || graph.function.entry.image_id !== image.id)
      throw new OperationError({
        code: 'invalid_input',
        severity: 'error',
        message: 'Previous discovery belongs to another image slice',
        evidence_ids: [],
      });
  if (input.resume && (input.index || input.selected_entry))
    throw new OperationError({
      code: 'invalid_input',
      severity: 'error',
      message: 'A discovery continuation is image-wide and prepares its own index',
      evidence_ids: [],
    });
  // A continuation roots its pending entries from the frontier's evidence alone, so a pending
  // root's own republished record never wraps that evidence again; the rest are boundaries.
  const pendingEntries = new Set(input.resume?.pending.map((root) => root.entry));
  const index =
    input.index ??
    prepareDiscoveryIndex(
      input.resume
        ? {
            ...input,
            functions: (input.functions ?? []).filter((fn) => !pendingEntries.has(fn.entry.value)),
          }
        : input,
      context,
    );
  if (
    index.image_id !== image.id ||
    index.slice_id !== image.selected_slice_id ||
    index.revision !== revision
  )
    throw new OperationError({
      code: 'invalid_input',
      severity: 'error',
      message: 'Discovery index belongs to another immutable image revision',
      evidence_ids: [],
    });
  const selected = input.selected_entry;
  if (
    selected &&
    (selected.image_id !== image.id || selected.space !== 'va' || !index.seeds.has(selected.value))
  )
    throw new OperationError({
      code: 'invalid_address',
      severity: 'error',
      message: 'Selected discovery requires an indexed virtual function root',
      evidence_ids: [],
    });
  const diagnostics: Diagnostic[] = [];
  const evidence = selected ? new Map<string, Evidence>() : new Map(index.evidence);
  const instructionEvidence = new Map<string, readonly string[]>();
  const seeds = new Map<bigint, Seed>();
  if (!selected)
    for (const [entry, item] of index.seeds)
      seeds.set(entry, {
        ...item,
        evidence: new Set(item.evidence),
        names: new Set(item.names),
        claims: [...item.claims],
      });
  const seedAt = (value: bigint): IndexedSeed | undefined =>
    seeds.get(value) ?? index.seeds.get(value);
  const decoded = new Map<bigint, DecodedInstruction>();
  const gaps = new Map<bigint, DecodeGap>();
  // Decoded control predecessors, including proven table edges, for single-entry proofs. Edges
  // are never removed (a replaced or dropped table keeps its old ones), so every address's
  // predecessor count only grows and chains settle.
  const incoming = new Map<bigint, DecodedInstruction[]>();
  // Provisional proofs by branch address; each graph re-validates them on its final members.
  const tables = new Map<bigint, { readonly proof: JumpTableProof; readonly evidence: string }>();
  // The chain each unconditional indirect branch was last proved on, the branches whose chain
  // contains an address, and the branches whose chain context changed since their last proof.
  const chains = new Map<bigint, readonly DecodedInstruction[]>();
  const watchers = new Map<bigint, Set<bigint>>();
  const stale = new Set<bigint>();
  const touch = (value: bigint): void => {
    for (const branch of watchers.get(value) ?? []) stale.add(branch);
  };
  const addIncoming = (target: bigint, from: DecodedInstruction): void => {
    const list = incoming.get(target);
    if (list) list.push(from);
    else incoming.set(target, [from]);
    touch(target);
  };
  const resume = selected ? undefined : input.resume;
  // A continuation traverses roots one at a time (each its own intraprocedural flow, calls
  // deferred), so every root it finishes is progress however small the instruction limit.
  const deferred: Address[] = [];
  let deferredCursor = 0;
  const traversed = new Set<bigint>();
  const created = new Set<bigint>();
  const pendingRoots = new Map(resume?.pending.map((root) => [root.entry, root]));
  const finalEntries = new Set<bigint>();
  let finals: Interval[] = [];
  if (resume) {
    const ranges: Interval[] = [];
    for (const fn of input.functions ?? []) {
      context.checkpoint(1);
      if (pendingRoots.has(fn.entry.value)) continue;
      finalEntries.add(fn.entry.value);
      for (const range of fn.ranges)
        ranges.push({ start: range.start.value, end: range.start.value + range.size });
    }
    finals = coalesce(ranges, context);
  }
  // Explained extents for the sweep: boundary claims (sized symbols, loader function extents,
  // asserted ranges) and final functions' ranges, built when the sweep starts. Unwind regions
  // do not count: one region may span several functions.
  let claimed: Interval[] = [];
  const queue: Address[] = selected
    ? [selected]
    : resume
      ? []
      : [...seeds.values()].map((item) => item.entry);
  const queued = new Set(queue.map((address) => address.value));
  const data = index.data;
  const dataAfter = (value: bigint): number => index.data_after(value, context);
  const executableEnd = (value: bigint): bigint => index.executable_end(value, context);
  const jumpTables: JumpTableCandidate[] = selected ? [] : [...index.jump_tables];
  const boundaryClaims = selected
    ? seedAt(selected.value)!.claims.map((range) => ({
        entry: selected,
        range,
        evidence_ids: [...seedAt(selected.value)!.evidence],
      }))
    : [...index.boundary_claims];
  const va = (value: bigint): Address => ({ image_id: image.id, space: 'va', value });
  const derive = evidenceDeriver(image, revision, evidence);
  const enqueue = (address: Address): void => {
    if (selected && address.value !== selected.value && seedAt(address.value)) return;
    if (!queued.has(address.value)) {
      queued.add(address.value);
      queue.push(address);
    }
  };
  const seed = (
    address: Address,
    rule: string,
    parents: readonly string[],
    established: boolean,
  ): void => {
    context.checkpoint(1);
    if (executableEnd(address.value) <= address.value) return;
    const id = derive(rule, address, parents);
    let item = seeds.get(address.value);
    if (!item) {
      const original = index.seeds.get(address.value);
      item = {
        entry: address,
        evidence: new Set(original?.evidence),
        names: new Set(original?.names),
        claims: [...(original?.claims ?? [])],
        established: original?.established ?? false,
      };
      seeds.set(address.value, item);
      created.add(address.value);
      // A new root ends every chain through it.
      if (!original) touch(address.value);
      if (resume) deferred.push(address);
      else if (!selected) enqueue(address);
    }
    item.evidence.add(id);
    item.established ||= established;
  };
  for (const root of [...pendingRoots.values()].sort((a, b) =>
    a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0,
  )) {
    let item = seeds.get(root.entry);
    if (!item) {
      item = {
        entry: va(root.entry),
        evidence: new Set(),
        names: new Set(),
        claims: [],
        established: false,
      };
      seeds.set(root.entry, item);
    }
    for (const id of root.evidence_ids) item.evidence.add(id);
    item.established ||= root.established;
    deferred.push(item.entry);
  }
  // The byte window is lookahead for ONE instruction, not permission to decode
  // the rest. Delegate all accounting to the original cumulative operation.
  const decodeContext: OperationContext = {
    signal: context.signal,
    budget: { ...context.budget, instructions: 1 },
    checkpoint: (work) => context.checkpoint(work),
    progress: (phase, completed, total) => context.progress(phase, completed, total),
  };
  // Sort initial roots; discovered successors follow structured flow order, never display names.
  queue.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  let exhausted = false;
  // Set once every seeded root is traversed: the whole-image sweep is rooting gap code.
  let sweeping = false;
  const unit = image.target.architecture === 'arm64' ? 4n : 1n;
  /** The decoded instruction whose bytes contain `value`, if any. */
  const covering = (value: bigint): DecodedInstruction | undefined => {
    for (let back = 0n; back < (unit === 4n ? 1n : 15n) && back <= value; back++) {
      const instruction = decoded.get(value - back);
      if (instruction)
        return instruction.address.value + BigInt(instruction.size) > value
          ? instruction
          : undefined;
    }
    return undefined;
  };
  // One bounded decode window; x86 needs up to 15 bytes, ARM exactly four. Never decode
  // across known data or non-executable backing. Adjacent VA mappings may split file backing.
  // Sweep decodes also stop at already decoded code, so gap bytes never overlap it.
  const decodeAt = (address: Address, backingEnd: bigint, nextData: DataRegion | undefined) => {
    let end = address.value + (unit === 4n ? 4n : 15n);
    if (end > 1n << 64n) end = 1n << 64n;
    if (backingEnd < end) end = backingEnd;
    if (nextData && nextData.range.start.value < end) end = nextData.range.start.value;
    if (sweeping) {
      for (let next = address.value + unit; next < end; next += unit) {
        context.checkpoint(1);
        if (decoded.has(next)) end = next;
      }
      const next = claimed[intervalAt(claimed, address.value, context)];
      if (next && next.start > address.value && next.start < end) end = next.start;
    }
    const length = end - address.value;
    const result = decoder.decode(
      {
        image,
        regions: [{ start: address, size: length }],
        mode: image.target.architecture === 'arm64' ? 'a64' : 'long64',
        features: image.target.features,
      },
      decodeContext,
    );
    return {
      result,
      length,
      instruction: result.instructions.find((item) => item.address.value === address.value),
    };
  };
  let cursor = 0;
  const isEntry = (value: bigint): boolean =>
    value === selected?.value || seedAt(value) !== undefined;
  /** (Re)prove one unconditional indirect branch on its current chain. Unchanged chains keep
   * their result; otherwise the table entry is replaced or dropped and new targets are queued. */
  const prove = (instruction: DecodedInstruction): void => {
    const branch = instruction.address.value;
    const chain = jumpTableChain({ branch: instruction, incoming, is_entry: isEntry }, context);
    const previous = chains.get(branch);
    if (
      previous &&
      previous.length === chain.length &&
      previous.every((member, position) => member === chain[position])
    )
      return;
    chains.set(branch, chain);
    for (const member of chain) {
      const set = watchers.get(member.address.value);
      if (set) set.add(branch);
      else watchers.set(member.address.value, new Set([branch]));
    }
    const proof = proveJumpTable(
      {
        image,
        branch: instruction,
        incoming,
        is_entry: isEntry,
        executable: (value) => executableEnd(value) > value,
        max_entries: MAX_JUMP_TABLE_ENTRIES,
        chain,
      },
      context,
    );
    if (!proof) {
      tables.delete(branch);
      return;
    }
    const evidenceId = derive(
      JUMP_TABLE_RULE,
      instruction.address,
      proof.chain.flatMap((id) => instructionEvidence.get(id) ?? []),
    );
    tables.set(branch, { proof, evidence: evidenceId });
    for (const target of proof.targets) {
      if (!incoming.get(target.value)?.includes(instruction))
        addIncoming(target.value, instruction);
      enqueue(target);
    }
  };
  /** Re-prove, in VA order, every branch whose chain changed since its last proof (a member
   * gained a predecessor or became a root) until none did; true when targets await decoding. */
  const reprove = (): boolean => {
    while (stale.size) {
      const branches = [...stale].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      stale.clear();
      for (const branch of branches) prove(decoded.get(branch)!);
    }
    return cursor < queue.length;
  };
  const drain = (): void => {
    for (;;) {
      // Proofs settle on the decoded predecessors before another root starts.
      do drainQueue();
      while (reprove());
      if (deferredCursor >= deferred.length || exhausted) return;
      const root = deferred[deferredCursor]!;
      if (finalEntries.has(root.value)) {
        deferredCursor++;
        continue;
      }
      // Starting an undecoded root without instruction allowance would only republish it emptier.
      if (!decoded.has(root.value) && decoded.size >= context.budget.instructions) {
        exhausted = true;
        return;
      }
      deferredCursor++;
      traversed.add(root.value);
      enqueue(root);
    }
  };
  const drainQueue = (): void => {
    for (; cursor < queue.length; cursor++) {
      context.checkpoint(1);
      const address = queue[cursor]!;
      if (decoded.has(address.value) || gaps.has(address.value)) continue;
      const nextData = data[dataAfter(address.value)];
      const knownData =
        nextData && nextData.range.start.value <= address.value ? nextData : undefined;
      if (knownData) {
        gaps.set(address.value, {
          range: {
            start: address,
            size: knownData.range.start.value + knownData.range.size - address.value,
          },
          reason: 'data',
          diagnostics: [
            {
              code: 'conflicting_evidence',
              severity: 'warning',
              message: 'Reachable code target lies in known data',
              address,
              evidence_ids: knownData.evidence_ids,
            },
          ],
        });
        continue;
      }
      const backingEnd = executableEnd(address.value);
      if (backingEnd === address.value) {
        gaps.set(address.value, {
          range: { start: address, size: 1n },
          reason: 'unmapped',
          diagnostics: [
            {
              code: 'unmapped',
              severity: 'warning',
              message: 'Reachable target has no executable file backing',
              address,
              evidence_ids: [],
            },
          ],
        });
        continue;
      }
      if (decoded.size >= context.budget.instructions) {
        exhausted = true;
        gaps.set(address.value, {
          range: { start: address, size: image.target.architecture === 'arm64' ? 4n : 1n },
          reason: 'budget',
          diagnostics: [
            {
              code: 'resource_limit',
              severity: 'warning',
              message: 'Discovery instruction limit reached',
              address,
              evidence_ids: [],
            },
          ],
        });
        continue;
      }
      const { result, length, instruction } = decodeAt(address, backingEnd, nextData);
      if (!instruction) {
        const gap = result.gaps.find((item) => item.range.start.value === address.value);
        gaps.set(
          address.value,
          gap ?? {
            range: { start: address, size: length },
            reason: 'truncated',
            diagnostics: result.diagnostics,
          },
        );
        continue;
      }
      decoded.set(address.value, instruction);
      const flowEvidence = derive('decoded control flow', address, instruction.evidence_ids);
      instructionEvidence.set(instruction.id, [flowEvidence]);
      if (instruction.validity !== 'valid') continue;
      if (instruction.flow.kind === 'call' && instruction.flow.target) {
        const target = instruction.flow.target;
        if (!sweeping) {
          const final = finals[intervalAt(finals, target.value, context)];
          // A continuation never splits a final function: a call into its interior roots nothing.
          if (seedAt(target.value) || !final || final.start > target.value)
            seed(target, 'direct call target', [flowEvidence], true);
          if (!selected && !resume) enqueue(target);
        } else if (
          seedAt(target.value) ||
          (!covering(target.value) &&
            explanationEnd(target.value) === null &&
            !index.objects.has(target.value))
        )
          // Code rooted by the sweep is not established, nor are the calls it makes; it never
          // splits code another root already owns.
          seed(target, 'direct call target in swept code', [flowEvidence], false);
      }
      for (const successor of instructionSuccessors(instruction, input.noreturn_calls)) {
        addIncoming(successor.value, instruction);
        enqueue(successor);
      }
      if (instruction.flow.kind === 'indirect_branch' && !instruction.flow.conditional)
        prove(instruction);
      if (
        instruction.flow.kind === 'indirect_branch' &&
        instruction.payload?.architecture === 'x86_64'
      ) {
        for (const operand of instruction.payload.operands)
          if (
            operand.kind === 'memory' &&
            operand.memory.index !== null &&
            operand.memory.scale >= 4
          ) {
            const memory = operand.memory;
            const table =
              memory.rip_relative_target ??
              (memory.base === null && memory.displacement >= 0n ? va(memory.displacement) : null);
            jumpTables.push({
              instruction_id: instruction.id,
              address: table ?? instruction.address,
              range: null,
              status: 'candidate',
              evidence_ids: [
                derive('indexed indirect transfer candidate', instruction.address, [flowEvidence]),
              ],
            });
          }
      }
      if (
        instruction.flow.kind === 'indirect_branch' &&
        instruction.payload?.architecture === 'arm64'
      ) {
        const target = instruction.payload.operands.find((operand) => operand.kind === 'register');
        const previous = decoded.get(instruction.address.value - 4n);
        if (target?.kind === 'register' && previous?.payload?.architecture === 'arm64') {
          const destination = previous.payload.operands[0];
          const indexedLoad = previous.payload.operands.some(
            (operand) =>
              operand.kind === 'memory' && operand.index !== null && operand.access !== 'write',
          );
          if (
            destination?.kind === 'register' &&
            destination.register.root === target.register.root &&
            indexedLoad
          ) {
            jumpTables.push({
              instruction_id: instruction.id,
              address: instruction.address,
              range: null,
              status: 'candidate',
              evidence_ids: [
                derive('indexed load before indirect transfer candidate', instruction.address, [
                  flowEvidence,
                  ...(instructionEvidence.get(previous.id) ?? []),
                ]),
              ],
            });
          }
        }
      }
    }
  };
  /** End of the loader claim or known data region containing `value`, or null. */
  const explanationEnd = (value: bigint): bigint | null => {
    const claim = claimed[intervalAt(claimed, value, context)];
    let end: bigint | null = claim && claim.start <= value ? claim.end : null;
    // The first region whose prefix-maximum end passes `value` contains it iff it starts before.
    const region = data[dataAfter(value)];
    if (region && region.range.start.value <= value) {
      const regionEnd = region.range.start.value + region.range.size;
      if (end === null || regionEnd > end) end = regionEnd;
    }
    return end;
  };
  /** Alignment fill between functions: NOPs, unconditional traps (int3, ud2, brk, udf) and
   * zero bytes. Never executed as a function's first instruction. */
  const fill = (instruction: DecodedInstruction): boolean => {
    context.checkpoint(1);
    if (instruction.flow.kind === 'trap' && !instruction.flow.conditional) return true;
    const payload = instruction.payload;
    if (
      payload?.architecture === 'arm64'
        ? payload.encoding === 'NOP_HI_hints' || payload.behavior === 'nop'
        : payload?.mnemonic === 'nop'
    )
      return true;
    const spans = image.address_map.spans(instruction.address, BigInt(instruction.size));
    return (
      spans.length === 1 &&
      spans[0]!.kind === 'mapped' &&
      image.bytes.read(spans[0]!.file_offset!, instruction.size).every((byte) => byte === 0)
    );
  };
  /** Whole-image enumeration: after the seeded traversal, walk every executable byte in VA order.
   * Bytes decoded by a root, claimed by loader extents or final functions, known data, fill or
   * undecodable are explained; the first valid non-fill instruction of any other byte run roots
   * a candidate function, traversed before the walk continues. True when every executable byte
   * is explained; otherwise `sweepCursor` is the first unexplained byte. */
  let sweepCursor = resume?.sweep ?? 0n;
  const sweep = (): boolean => {
    claimed = coalesce(
      [
        ...index.boundary_claims.map((claim) => ({
          start: claim.range.start.value,
          end: claim.range.start.value + claim.range.size,
        })),
        ...finals,
      ],
      context,
    );
    const align = (value: bigint): bigint => (value + unit - 1n) & -unit;
    // Executable sections when the loader names them (else the executable mappings), minus
    // linker-synthesized import trampolines (PLT, Mach-O stubs): their callable entries are
    // import roots and the remaining bytes (PLT0, lazy-binding tails) are no function.
    const sections = image.sections.filter(
      (section) =>
        section.kind === 'section' &&
        section.permissions.includes('execute') &&
        section.virtual_range.size > 0n,
    );
    const sweepable = sections.length
      ? coalesce(
          sections
            .filter((section) => !STUB_SECTION.test(section.name))
            .map((section) => {
              const start = section.virtual_range.start.value;
              const end = start + section.virtual_range.size;
              const backed = executableEnd(start);
              return { start, end: backed < end ? backed : end };
            }),
          context,
        )
      : index.executable;
    for (const range of sweepable) {
      let address = align(range.start > sweepCursor ? range.start : sweepCursor);
      while (address < range.end) {
        context.checkpoint(1);
        const instruction = covering(address);
        if (instruction) {
          address = align(instruction.address.value + BigInt(instruction.size));
          continue;
        }
        if (gaps.has(address) || index.objects.has(address)) {
          address += unit;
          continue;
        }
        const explainedEnd = explanationEnd(address);
        if (explainedEnd !== null) {
          address = align(explainedEnd);
          continue;
        }
        const at = va(address);
        const decodedAt = decodeAt(at, range.end, data[dataAfter(address)]).instruction;
        if (!decodedAt || decodedAt.validity !== 'valid') {
          address += unit;
          continue;
        }
        if (fill(decodedAt)) {
          address = align(address + BigInt(decodedAt.size));
          continue;
        }
        seed(at, 'first instruction of unexplained executable bytes', [], false);
        drain();
        if (exhausted) {
          sweepCursor = address;
          return false;
        }
        if (!decoded.has(address)) address += unit;
      }
    }
    return true;
  };
  drain();
  let enumerated = false;
  if (!selected && !exhausted) {
    sweeping = true;
    enumerated = sweep();
  }
  const functionEntries = { has: (value: bigint): boolean => seedAt(value) !== undefined };
  const graphs: FunctionGraph[] = [];
  let blockCount = 0;
  const allSeeds = selected
    ? [seedAt(selected.value)!]
    : [...seeds.values()].sort((a, b) => {
        context.checkpoint(1);
        return a.entry.value < b.entry.value ? -1 : a.entry.value > b.entry.value ? 1 : 0;
      });
  // A continuation publishes only the roots it traversed; final functions keep their records and
  // roots it never reached stay pending (with their evidence) for the next continuation.
  const orderedSeeds = resume
    ? allSeeds.filter((item) => traversed.has(item.entry.value))
    : allSeeds;
  const claimBoundaries = selected ? index.ordered_seeds : allSeeds;
  for (const item of orderedSeeds) {
    context.checkpoint(1);
    let members: DecodedInstruction[] = [];
    let localGaps: DecodeGap[] = [];
    let localDiagnostics: Diagnostic[] = [];
    let visited = new Set<bigint>();
    let claimConflict = false;
    for (const claim of item.claims) {
      let low = 0,
        high = claimBoundaries.length;
      while (low < high) {
        context.checkpoint(1);
        const mid = (low + high) >>> 1;
        if (claimBoundaries[mid]!.entry.value < claim.start.value) low = mid + 1;
        else high = mid;
      }
      if (claimBoundaries[low]?.entry.value === item.entry.value) low++;
      const other = claimBoundaries[low];
      if (other && other.entry.value < claim.start.value + claim.size) claimConflict = true;
      if (selected)
        for (const candidate of seeds.values()) {
          context.checkpoint(1);
          if (
            candidate.entry.value !== item.entry.value &&
            candidate.entry.value >= claim.start.value &&
            candidate.entry.value < claim.start.value + claim.size
          )
            claimConflict = true;
        }
    }
    let conflict = claimConflict;
    // A table proof holds for this graph only if its chain stays single-entry and every target
    // decodes inside it. A failed chain is re-proved on the graph's own predecessors; the result
    // replaces it only with a subset of its targets, so validation only removes edges and ends.
    const rejected = new Set<bigint>();
    const reproved = new Map<
      bigint,
      { readonly proof: JumpTableProof; readonly evidence: string }
    >();
    const tableAt = (instruction: DecodedInstruction) =>
      instruction.flow.kind === 'indirect_branch' && !rejected.has(instruction.address.value)
        ? (reproved.get(instruction.address.value) ?? tables.get(instruction.address.value))
        : undefined;
    for (;;) {
      members = [];
      localGaps = [];
      localDiagnostics = [];
      visited = new Set<bigint>();
      conflict = claimConflict;
      const pending = [item.entry];
      for (let cursor = 0; cursor < pending.length; cursor++) {
        context.checkpoint(1);
        const address = pending[cursor]!;
        if (visited.has(address.value)) continue;
        visited.add(address.value);
        const instruction = decoded.get(address.value);
        if (!instruction) {
          const gap = gaps.get(address.value);
          if (gap) {
            localGaps.push(gap);
            localDiagnostics.push(...gap.diagnostics);
            if (gap.reason === 'data') conflict = true;
          }
          continue;
        }
        members.push(instruction);
        localDiagnostics.push(...instruction.diagnostics);
        const table = tableAt(instruction);
        for (const successor of table?.proof.targets ??
          instructionSuccessors(instruction, input.noreturn_calls)) {
          if (successor.value !== item.entry.value && functionEntries.has(successor.value)) {
            // A table reaching another root is rejected below, not a boundary conflict.
            if (!table && (instruction.flow.kind !== 'branch' || instruction.flow.conditional)) {
              conflict = true;
              localDiagnostics.push({
                code: 'conflicting_evidence',
                severity: 'warning',
                message: 'Intraprocedural flow reaches another function entry',
                address: successor,
                evidence_ids: [...item.evidence, ...seedAt(successor.value)!.evidence],
              });
            }
            continue;
          }
          pending.push(successor);
        }
      }
      const byId = new Map<string, DecodedInstruction>();
      const predecessors = new Map<bigint, DecodedInstruction[]>();
      for (const instruction of members) {
        context.checkpoint(1);
        byId.set(instruction.id, instruction);
        for (const successor of tableAt(instruction)?.proof.targets ??
          instructionSuccessors(instruction, input.noreturn_calls)) {
          const list = predecessors.get(successor.value);
          if (list) list.push(instruction);
          else predecessors.set(successor.value, [instruction]);
        }
      }
      const inside = (target: Address): boolean =>
        byId.get(decoded.get(target.value)?.id ?? '') !== undefined &&
        (target.value === item.entry.value || !functionEntries.has(target.value));
      const valid = (proof: JumpTableProof): boolean => {
        context.checkpoint(proof.chain.length + proof.targets.length);
        const chain = proof.chain.map((id) => byId.get(id));
        const selector = proof.chain.indexOf(proof.selector.instruction);
        return (
          selector >= 0 &&
          chain.every((member, position) => {
            if (!member) return false;
            if (position === 0) return true;
            const sources = predecessors.get(member.address.value) ?? [];
            return (
              member.address.value !== item.entry.value &&
              sources.length === 1 &&
              sources[0] === chain[position - 1] &&
              // The selector read and the branch must share one basic block.
              (position <= selector || chain[position - 1]!.flow.kind === 'fallthrough')
            );
          }) &&
          inside(proof.otherwise) &&
          proof.targets.every(inside)
        );
      };
      let changed = false;
      for (const instruction of members) {
        const table = tableAt(instruction);
        if (!table || valid(table.proof)) continue;
        const proof = proveJumpTable(
          {
            image,
            branch: instruction,
            incoming: predecessors,
            is_entry: (value) => value === item.entry.value || functionEntries.has(value),
            executable: (value) => executableEnd(value) > value,
            max_entries: MAX_JUMP_TABLE_ENTRIES,
          },
          context,
        );
        const current = new Set(table.proof.targets.map((target) => target.value));
        const targets = new Set(proof?.targets.map((target) => target.value));
        if (proof && [...targets].every((target) => current.has(target)) && valid(proof)) {
          reproved.set(instruction.address.value, {
            proof,
            evidence: derive(
              JUMP_TABLE_RULE,
              instruction.address,
              proof.chain.flatMap((id) => instructionEvidence.get(id) ?? []),
            ),
          });
          // The same target set leaves the graph's edges as they are.
          if (targets.size < current.size) changed = true;
        } else {
          rejected.add(instruction.address.value);
          changed = true;
        }
      }
      if (!changed) break;
    }
    members.sort((a, b) =>
      a.address.value < b.address.value ? -1 : a.address.value > b.address.value ? 1 : 0,
    );
    const functionRanges: AddressRange[] = [];
    for (const instruction of members) {
      context.checkpoint(1);
      const last = functionRanges.at(-1);
      const end = instruction.address.value + BigInt(instruction.size);
      if (last && instruction.address.value <= last.start.value + last.size)
        functionRanges[functionRanges.length - 1] = {
          start: last.start,
          size:
            (end > last.start.value + last.size ? end : last.start.value + last.size) -
            last.start.value,
        };
      else functionRanges.push({ start: instruction.address, size: BigInt(instruction.size) });
      if (
        item.claims.length &&
        !item.claims.some((claim) => {
          context.checkpoint(1);
          return (
            instruction.address.value >= claim.start.value && end <= claim.start.value + claim.size
          );
        })
      )
        conflict = true;
    }
    const envelopes = [...item.claims];
    if (functionRanges.length) {
      const first = functionRanges[0]!;
      const last = functionRanges.at(-1)!;
      envelopes.push({
        start: first.start,
        size: last.start.value + last.size - first.start.value,
      });
    }
    for (const claim of envelopes) {
      const claimEnd = claim.start.value + claim.size;
      for (let index = dataAfter(claim.start.value); index < data.length; index++) {
        context.checkpoint(1);
        const region = data[index]!;
        if (region.range.start.value >= claimEnd) break;
        const start =
          claim.start.value > region.range.start.value
            ? claim.start.value
            : region.range.start.value;
        const end =
          claimEnd < region.range.start.value + region.range.size
            ? claimEnd
            : region.range.start.value + region.range.size;
        if (
          start < end &&
          !localGaps.some((gap) => gap.reason === 'data' && gap.range.start.value === start)
        )
          localGaps.push({
            range: { start: va(start), size: end - start },
            reason: 'data',
            diagnostics: [],
          });
      }
    }
    if (conflict)
      localDiagnostics.push({
        code: 'conflicting_evidence',
        severity: 'warning',
        message: 'Function boundary claims conflict with reachable code or data',
        address: item.entry,
        evidence_ids: [...item.evidence],
      });
    const id = entityIdentity(image.selected_slice_id, 'function', { entry: item.entry.value });
    const resolved: ResolvedJumpTable[] = [];
    const tableTargets = new Map<bigint, readonly Address[]>();
    const noreturnCalls = new Map<bigint, readonly string[]>();
    for (const instruction of members) {
      const table = tableAt(instruction);
      if (table) {
        resolved.push({ ...table.proof, evidence_ids: [table.evidence] });
        tableTargets.set(instruction.address.value, table.proof.targets);
      }
      const flow = instruction.flow;
      if (instruction.validity !== 'valid' || flow.kind !== 'call' || flow.indirect || !flow.target)
        continue;
      const parents = input.noreturn_calls?.get(flow.target.value);
      if (parents && !noreturnCalls.has(flow.target.value))
        noreturnCalls.set(flow.target.value, [
          derive('direct call target declared noreturn', flow.target, parents),
        ]);
    }
    const blocks = buildCFG(
      {
        slice_id: image.selected_slice_id,
        function_id: id,
        entry: item.entry,
        instructions: members,
        function_entries: functionEntries,
        evidence: instructionEvidence,
        jump_tables: tableTargets,
        noreturn_calls: noreturnCalls,
      },
      context,
    );
    blockCount += blocks.length;
    if (blockCount > context.budget.blocks)
      throw new OperationError({
        code: 'resource_limit',
        severity: 'error',
        message: 'Discovery block limit reached',
        evidence_ids: [],
        details: {
          kind: 'limit',
          resource: 'blocks',
          limit: context.budget.blocks,
          consumed: blockCount,
        },
      });
    const reasons = [
      ...new Set([
        ...localGaps
          .filter((gap) => gap.reason !== 'data' || visited.has(gap.range.start.value))
          .map((gap) => gap.reason),
        ...members
          .filter((instruction) => instruction.validity !== 'valid')
          .map((instruction) => instruction.validity),
        ...members
          .filter(
            (instruction) =>
              instruction.flow.kind === 'unknown' ||
              (instruction.flow.kind === 'indirect_branch' &&
                !tableTargets.has(instruction.address.value)) ||
              (instruction.flow.kind === 'call' && instruction.flow.indirect),
          )
          .map(() => 'unresolved control flow'),
        ...(conflict ? ['conflicting boundaries'] : []),
      ]),
    ];
    const name = [...item.names].sort()[0] ?? null;
    graphs.push({
      function: {
        id,
        entry: item.entry,
        ranges: functionRanges.length ? functionRanges : [{ start: item.entry, size: 0n }],
        original_name: name,
        display_name: name,
        evidence_ids: [...item.evidence].sort(),
        signature: null,
        boundary: conflict
          ? 'conflicting'
          : item.established && members.length > 0
            ? 'established'
            : 'candidate',
        analysis: reasons.length ? 'partial' : 'complete',
      },
      slice_id: image.selected_slice_id,
      blocks,
      instructions: members,
      gaps: localGaps,
      diagnostics: localDiagnostics,
      coverage: {
        layer: 'analysis',
        state: reasons.length ? 'partial' : 'complete',
        completed_units: members.length,
        reasons,
      },
      ...(resolved.length ? { jump_tables: resolved } : {}),
    });
  }
  const reconciled = reconcileGraphs(
    graphs,
    input.previous ?? [],
    revision,
    image.selected_slice_id,
    context,
  );
  const byEntry = new Map(
    reconciled.graphs.map((graph) => [graph.function.entry.value, graph.function.id]),
  );
  const references: ReferenceRecord[] = [];
  const owners = new Map<string, string[]>();
  for (const graph of reconciled.graphs) {
    const resolvedBranches = new Map(graph.jump_tables?.map((table) => [table.branch, table]));
    for (const instruction of graph.instructions) {
      context.checkpoint(1);
      const ownership = owners.get(instruction.id);
      if (ownership) ownership.push(graph.function.id);
      else owners.set(instruction.id, [graph.function.id]);
      const flow = instruction.flow;
      const table = resolvedBranches.get(instruction.id);
      if (table) {
        const seen = new Set<bigint>();
        for (const target of table.targets) {
          context.checkpoint(1);
          if (seen.has(target.value)) continue;
          seen.add(target.value);
          references.push({
            id: entityIdentity(image.selected_slice_id, 'reference', {
              function: graph.function.id,
              instruction: instruction.id,
              kind: 'branch',
              target: target.value,
            }),
            from: instruction.address,
            from_function: graph.function.id,
            from_instruction: instruction.id,
            target_role: 'code',
            to: target,
            to_entity: null,
            kind: 'branch',
            status: 'established',
            evidence_ids: table.evidence_ids,
          });
        }
        continue;
      }
      let kind: ReferenceRecord['kind'] | null = null;
      let target: Address | null = null;
      if (flow.kind === 'call') {
        kind = 'call';
        target = flow.target;
      } else if (flow.kind === 'branch') {
        kind =
          !flow.conditional &&
          flow.target.value !== graph.function.entry.value &&
          functionEntries.has(flow.target.value)
            ? 'tail_call'
            : 'branch';
        target = flow.target;
      } else if (flow.kind === 'indirect_branch' || flow.kind === 'unknown') kind = 'unknown';
      if (kind !== null)
        references.push({
          id: entityIdentity(image.selected_slice_id, 'reference', {
            function: graph.function.id,
            instruction: instruction.id,
            kind,
          }),
          from: instruction.address,
          from_function: graph.function.id,
          from_instruction: instruction.id,
          target_role: target ? 'code' : 'unknown',
          to: target,
          to_entity: target
            ? (byEntry.get(target.value) ??
              (functionEntries.has(target.value)
                ? entityIdentity(image.selected_slice_id, 'function', { entry: target.value })
                : null))
            : null,
          kind,
          status: target ? 'established' : 'unresolved',
          evidence_ids: instructionEvidence.get(instruction.id) ?? [],
        });
    }
  }
  const overlaps: DiscoveryOverlap[] = [];
  const ordered = [...decoded.values()].sort((a, b) =>
    a.address.value < b.address.value ? -1 : a.address.value > b.address.value ? 1 : 0,
  );
  for (let i = 0; i < ordered.length; i++) {
    context.checkpoint(1);
    const instruction = ordered[i]!;
    const functionIds = owners.get(instruction.id) ?? [];
    if (functionIds.length > 1)
      overlaps.push({
        range: { start: instruction.address, size: BigInt(instruction.size) },
        function_ids: functionIds,
        instruction_ids: [instruction.id],
        kind: 'shared_tail',
      });
    for (
      let j = i + 1;
      j < ordered.length &&
      ordered[j]!.address.value < instruction.address.value + BigInt(instruction.size);
      j++
    ) {
      context.checkpoint(1);
      const other = ordered[j]!;
      overlaps.push({
        range: {
          start: other.address,
          size:
            (instruction.address.value + BigInt(instruction.size) <
            other.address.value + BigInt(other.size)
              ? instruction.address.value + BigInt(instruction.size)
              : other.address.value + BigInt(other.size)) - other.address.value,
        },
        function_ids: [...new Set([...functionIds, ...(owners.get(other.id) ?? [])])],
        instruction_ids: [instruction.id, other.id],
        kind: 'overlapping_instructions',
      });
    }
  }
  const conflictingFunctions = new Set(
    overlaps
      .filter((overlap) => overlap.kind === 'overlapping_instructions')
      .flatMap((overlap) => overlap.function_ids),
  );
  const finalGraphs = reconciled.graphs.map((graph) => {
    if (!conflictingFunctions.has(graph.function.id)) return graph;
    const diagnostic: Diagnostic = {
      code: 'conflicting_evidence',
      severity: 'warning',
      message: 'Reachable instruction encodings overlap',
      entity_id: graph.function.id,
      evidence_ids: graph.function.evidence_ids,
    };
    return {
      ...graph,
      function: {
        ...graph.function,
        boundary: 'conflicting' as const,
        analysis: 'partial' as const,
      },
      coverage: {
        ...graph.coverage,
        state: 'partial' as const,
        reasons: [...graph.coverage.reasons, 'overlapping instructions'],
      },
      diagnostics: [...graph.diagnostics, diagnostic],
    };
  });
  for (const graph of finalGraphs) diagnostics.push(...graph.diagnostics);
  const reasons = [
    ...new Set([
      ...finalGraphs.flatMap((graph) => graph.coverage.reasons),
      ...(exhausted ? ['instruction budget'] : []),
      ...(allSeeds.length === 0 ? ['no grounded function seeds'] : []),
    ]),
  ];
  context.progress('discovery', finalGraphs.length, finalGraphs.length);
  if (selected) {
    // Diagnostics may cite other roots' seed proofs (e.g. flow reaching another function
    // entry), so their citations are closure seeds just like function and reference proofs.
    const pending = [
      ...finalGraphs.flatMap((graph) => [
        ...graph.function.evidence_ids,
        ...graph.diagnostics.flatMap((diagnostic) => diagnostic.evidence_ids),
        ...graph.instructions.flatMap((instruction) =>
          instruction.diagnostics.flatMap((diagnostic) => diagnostic.evidence_ids),
        ),
        ...graph.gaps.flatMap((gap) =>
          gap.diagnostics.flatMap((diagnostic) => diagnostic.evidence_ids),
        ),
      ]),
      ...references.flatMap((reference) => reference.evidence_ids),
      ...diagnostics.flatMap((diagnostic) => diagnostic.evidence_ids),
    ];
    const visited = new Set<string>();
    for (let cursor = 0; cursor < pending.length; cursor++) {
      context.checkpoint(1);
      const id = pending[cursor]!;
      if (visited.has(id)) continue;
      visited.add(id);
      const proof = evidence.get(id) ?? index.evidence.get(id);
      if (!proof) continue; // Durable evidence is closed by the publishing caller.
      evidence.set(id, proof);
      pending.push(...proof.derived_from, ...proof.conflicts_with);
    }
  }
  let frontier: DiscoveryFrontier | null = null;
  if (!selected && !enumerated) {
    const root = (item: IndexedSeed): DiscoveryRoot => ({
      entry: item.entry.value,
      established: item.established,
      evidence_ids: [...item.evidence].sort(),
    });
    const pending = finalGraphs
      .filter((graph) => graph.gaps.some((gap) => gap.reason === 'budget'))
      .map((graph) => root(seeds.get(graph.function.entry.value)!));
    for (let position = deferredCursor; position < deferred.length; position++) {
      context.checkpoint(1);
      const entry = deferred[position]!.value;
      if (!finalEntries.has(entry) && !traversed.has(entry)) pending.push(root(seeds.get(entry)!));
    }
    frontier = {
      pending: pending.sort((a, b) => (a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0)),
      sweep: sweepCursor,
    };
  }
  return {
    graphs: finalGraphs,
    references,
    evidence: [...evidence.values()],
    lineage: reconciled.lineage,
    jump_tables: jumpTables,
    overlaps,
    boundary_claims: boundaryClaims,
    enumeration: enumerated ? 'complete' : 'partial',
    frontier,
    diagnostics,
    coverage: {
      layer: 'analysis',
      state: reasons.length ? 'partial' : 'complete',
      completed_units: decoded.size,
      reasons,
    },
  };
}

/** Prepare grounded roots and immutable interval indexes without decoding bodies. */
export function prepareDiscoveryIndex(
  input: Pick<DiscoveryInput, 'image' | 'revision' | 'assertions' | 'functions'>,
  context: OperationContext,
): DiscoveryIndex {
  const { image, revision } = input;
  const evidence = new Map(image.evidence.map((item) => [item.id, item]));
  const seeds = new Map<bigint, Seed>();
  const data: DataRegion[] = [];
  // Prefix maxima retain the first overlapping data claim (and its provenance),
  // including nested claims; a predecessor-only lookup would miss long outer ranges.
  const dataEnds: bigint[] = [];
  const dataAfter = (value: bigint, operation: OperationContext): number => {
    let low = 0,
      high = dataEnds.length;
    while (low < high) {
      operation.checkpoint(1);
      const mid = (low + high) >>> 1;
      if (dataEnds[mid]! <= value) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  const executableRanges: ExecutableRange[] = [];
  for (const mapping of image.mappings) {
    context.checkpoint(1);
    if (mapping.permissions.includes('execute') && mapping.file_size > 0n)
      executableRanges.push({ start: mapping.va, end: mapping.va + mapping.file_size });
  }
  executableRanges.sort((a, b) => {
    context.checkpoint(1);
    return a.start < b.start ? -1 : a.start > b.start ? 1 : 0;
  });
  let rangeCount = 0;
  for (const range of executableRanges) {
    context.checkpoint(1);
    const previous = executableRanges[rangeCount - 1];
    if (previous && range.start <= previous.end) {
      if (range.end > previous.end) previous.end = range.end;
    } else executableRanges[rangeCount++] = range;
  }
  executableRanges.length = rangeCount;
  const executableEnd = (value: bigint, operation: OperationContext): bigint => {
    let low = 0,
      high = executableRanges.length;
    while (low < high) {
      operation.checkpoint(1);
      const mid = (low + high) >>> 1;
      if (executableRanges[mid]!.end <= value) low = mid + 1;
      else high = mid;
    }
    const range = executableRanges[low];
    return range && range.start <= value ? range.end : value;
  };
  const objectAddresses = new Set<bigint>();
  const jumpTables: JumpTableCandidate[] = [];
  const boundaryClaims: DiscoveryBoundaryClaim[] = [];
  const va = (value: bigint): Address => ({ image_id: image.id, space: 'va', value });
  const normalize = (address: Address): Address => {
    if (address.image_id !== image.id)
      throw new OperationError({
        code: 'invalid_address',
        severity: 'error',
        message: 'Discovery address belongs to another image',
        evidence_ids: [],
      });
    checkedU64(address.value);
    if (address.space === 'va') return address;
    if (address.space === 'rva') return va(checkedU64(image.image_base + address.value));
    const translated = image.address_map.translate(address, 'va');
    if (translated.kind !== 'mapped')
      throw new OperationError({
        code: 'invalid_address',
        severity: 'error',
        message: 'Discovery file address has no virtual mapping',
        address,
        evidence_ids: [],
      });
    return translated.address;
  };
  const ranges = (range: AddressRange): AddressRange[] => {
    checkedEnd(range.start.value, range.size);
    if (range.start.space !== 'file') {
      const start = normalize(range.start);
      checkedEnd(start.value, range.size);
      return [{ start, size: range.size }];
    }
    if (range.start.image_id !== image.id) normalize(range.start);
    const end = range.start.value + range.size;
    const result: AddressRange[] = [];
    for (const mapping of image.mappings) {
      context.checkpoint(1);
      const start =
        mapping.file_offset > range.start.value ? mapping.file_offset : range.start.value;
      const stop =
        mapping.file_offset + mapping.file_size < end
          ? mapping.file_offset + mapping.file_size
          : end;
      if (start < stop)
        result.push({ start: va(mapping.va + start - mapping.file_offset), size: stop - start });
    }
    return result;
  };
  const derive = evidenceDeriver(image, revision, evidence);
  const seed = (
    source: Address,
    rule: string,
    parents: readonly string[],
    established: boolean,
    name: string | null = null,
    claims: readonly AddressRange[] = [],
  ): void => {
    context.checkpoint(1);
    const address = normalize(source);
    // Data exports and pointer storage are not callable just because they have names.
    if (
      executableEnd(address.value, context) <= address.value &&
      rule !== 'asserted function' &&
      rule !== 'image entry'
    )
      return;
    if (rule === 'executable export candidate' || rule === 'executable symbol candidate') {
      const region = data[dataAfter(address.value, context)];
      if (
        objectAddresses.has(address.value) ||
        (region && region.range.start.value <= address.value)
      )
        return;
    }
    const id = derive(rule, address, parents);
    let item = seeds.get(address.value);
    if (!item) {
      item = {
        entry: address,
        evidence: new Set(),
        names: new Set(),
        claims: [],
        established: false,
      };
      seeds.set(address.value, item);
    }
    item.evidence.add(id);
    item.established ||= established;
    if (name !== null) item.names.add(name);
    item.claims.push(...claims);
    for (const range of claims) boundaryClaims.push({ entry: address, range, evidence_ids: [id] });
  };
  for (const hint of image.hints) {
    context.checkpoint(1);
    if (hint.kind === 'data')
      for (const range of ranges(hint.range)) {
        if (range.size > 0n) data.push({ range, evidence_ids: hint.evidence_ids });
        if (hint.encoding === 'jump_table')
          jumpTables.push({
            instruction_id: null,
            address: range.start,
            range,
            status: 'candidate',
            evidence_ids: hint.evidence_ids,
          });
      }
  }
  for (const symbol of image.symbols) {
    context.checkpoint(1);
    if (symbol.kind !== 'object' || !symbol.address) continue;
    objectAddresses.add(normalize(symbol.address).value);
    if (symbol.size && symbol.size > 0n)
      for (const range of ranges({ start: symbol.address, size: symbol.size }))
        data.push({ range, evidence_ids: symbol.evidence_ids });
  }
  data.sort((a, b) => {
    context.checkpoint(1);
    return a.range.start.value < b.range.start.value
      ? -1
      : a.range.start.value > b.range.start.value
        ? 1
        : 0;
  });
  for (const region of data) {
    context.checkpoint(1);
    const end = region.range.start.value + region.range.size;
    const previous = dataEnds.at(-1) ?? 0n;
    dataEnds.push(end > previous ? end : previous);
  }
  for (const entry of image.entry_points) seed(entry, 'image entry', [], true);
  for (const symbol of image.symbols) {
    context.checkpoint(1);
    if (symbol.address && (symbol.kind === 'function' || symbol.kind === 'unknown'))
      seed(
        symbol.address,
        symbol.kind === 'function' ? 'function symbol' : 'executable symbol candidate',
        symbol.evidence_ids,
        symbol.kind === 'function',
        symbol.original_name,
        symbol.size && symbol.size > 0n ? ranges({ start: symbol.address, size: symbol.size }) : [],
      );
  }
  for (const item of image.exports)
    if (item.address && item.forwarder === null)
      seed(
        item.address,
        'executable export candidate',
        item.evidence_ids,
        false,
        item.original_name,
      );
  // A loader-established import stub is a callable root even when it is only
  // reached by a tail branch; traversal must not absorb its body into the caller.
  for (const item of image.imports)
    if (item.callable_entry)
      seed(
        item.callable_entry,
        'import callable entry',
        item.evidence_ids,
        true,
        item.original_name,
      );
  for (const hint of image.hints) {
    context.checkpoint(1);
    if (hint.kind === 'function')
      seed(
        hint.address,
        'loader function start',
        hint.evidence_ids,
        true,
        null,
        hint.size && hint.size > 0n ? ranges({ start: hint.address, size: hint.size }) : [],
      );
    // Unwind coverage can coalesce adjacent functions (notably Mach-O compact
    // unwind). Its start is a candidate, not a claim that one function owns the range.
    if (hint.kind === 'unwind')
      seed(hint.range.start, 'unwind region candidate', hint.evidence_ids, false);
  }
  for (const assertion of input.assertions ?? []) {
    context.checkpoint(1);
    if (assertion.evidence.origin.kind !== 'assertion')
      throw new OperationError({
        code: 'invalid_input',
        severity: 'error',
        message: 'Function assertions require assertion-origin evidence',
        evidence_ids: [assertion.evidence.id],
      });
    evidence.set(assertion.evidence.id, assertion.evidence);
    if (assertion.evidence.origin.status !== 'retracted')
      seed(
        assertion.entry,
        'asserted function',
        [assertion.evidence.id],
        false,
        null,
        (assertion.ranges ?? []).flatMap(ranges),
      );
  }
  for (const fn of input.functions ?? [])
    seed(
      fn.entry,
      'published function root',
      fn.evidence_ids,
      fn.boundary === 'established',
      fn.original_name,
    );
  const ordered_seeds = [...seeds.values()].sort((a, b) => {
    context.checkpoint(1);
    return a.entry.value < b.entry.value ? -1 : a.entry.value > b.entry.value ? 1 : 0;
  });
  return {
    image_id: image.id,
    slice_id: image.selected_slice_id,
    revision,
    seeds,
    ordered_seeds,
    evidence,
    data,
    jump_tables: jumpTables,
    boundary_claims: boundaryClaims,
    executable: executableRanges,
    objects: objectAddresses,
    data_after: dataAfter,
    executable_end: executableEnd,
  };
}

/** Index of the first sorted, coalesced interval ending after `value`: it contains `value` iff
 * it starts at or before it; otherwise it is the next interval. */
function intervalAt(
  intervals: readonly Interval[],
  value: bigint,
  context: OperationContext,
): number {
  let low = 0,
    high = intervals.length;
  while (low < high) {
    context.checkpoint(1);
    const mid = (low + high) >>> 1;
    if (intervals[mid]!.end <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Sorted, coalesced copy of nonempty intervals. */
function coalesce(intervals: readonly Interval[], context: OperationContext): Interval[] {
  const sorted = intervals
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => {
      context.checkpoint(1);
      return a.start < b.start ? -1 : a.start > b.start ? 1 : 0;
    });
  const result: Interval[] = [];
  for (const interval of sorted) {
    context.checkpoint(1);
    const last = result.at(-1);
    if (last && interval.start <= last.end) {
      if (interval.end > last.end)
        result[result.length - 1] = { start: last.start, end: interval.end };
    } else result.push(interval);
  }
  return result;
}

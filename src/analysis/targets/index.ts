import {
  entityIdentity,
  fingerprint,
  type Address,
  type DecodedInstruction,
  type Diagnostic,
  type Evidence,
  type LoadedImage,
  type OperationContext,
  type ReferenceRecord,
  type RegisterDescriptor,
  type X86Payload,
} from '../../core/index.js';
import type { DiscoveryResult } from '../discovery/index.js';

export interface TargetRecoveryInput {
  readonly image: LoadedImage;
  readonly discovery: DiscoveryResult;
  readonly revision: number;
  readonly max_instructions?: number;
  readonly max_references?: number;
  readonly max_table_entries?: number;
}
export interface TargetRecoveryResult {
  readonly image_id: string;
  readonly slice_id: string;
  readonly revision: number;
  readonly references: readonly ReferenceRecord[];
  readonly evidence: readonly Evidence[];
  readonly state: 'complete' | 'partial';
  readonly diagnostics: readonly Diagnostic[];
  readonly processed_instructions: number;
}
interface Value {
  readonly value: bigint | null;
  readonly status: 'candidate' | 'established';
  readonly origins: readonly string[];
  readonly entity?: string;
  readonly storage?: bigint;
  readonly table?: bigint;
  readonly page?: boolean;
}
interface Location {
  readonly value: bigint;
  readonly indexed: boolean;
  readonly origins: readonly string[];
  readonly status: Value['status'];
}
export function virtualAddress(image: LoadedImage, address: Address): Address {
  const translated = image.address_map.translate(address, 'va');
  if (translated.kind === 'unmapped') {
    if (address.space === 'va' && address.image_id === image.id) return address;
    if (address.space === 'rva' && address.image_id === image.id)
      return { image_id: image.id, space: 'va', value: image.image_base + address.value };
    throw new RangeError('Address has no virtual mapping');
  }
  return translated.address;
}

/** Scoped, block-local address recovery, not a general constant/alias analysis.
 * PE/x86: RIP/absolute operands, LEA, MOV, ADD/SUB immediate, register calls,
 * IAT calls/jumps, and explicitly bounded absolute-u64 indexed tables.
 * Mach-O/ARM64: ADR/ADRP + ADD, ordinary 64-bit LDR pointer/stub sequences,
 * BR/BLR and explicitly bounded LDR(index,LSL#3) absolute-u64 tables.
 * Values never cross a discovery block, call, unknown instruction or store.
 * Pointer contents and table entries are candidates, never established runtime
 * edges. Writable slots are not frozen by reading initial bytes. Fixups override
 * encoded pointer words; bind slots identify imports, not local code addresses.
 * Unknown indirects are retained even when candidates were found. No immediate
 * constant becomes an address reference without an actual address/flow use.
 */
export function recoverTargets(
  input: TargetRecoveryInput,
  context: OperationContext,
): TargetRecoveryResult {
  context.checkpoint(0);
  const { image, discovery, revision } = input;
  const maxInstructions = input.max_instructions ?? context.budget.instructions;
  const maxReferences = input.max_references ?? 100_000;
  const maxEntries = input.max_table_entries ?? 256;
  for (const value of [revision, maxInstructions, maxReferences, maxEntries])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError('Invalid target recovery bounds');
  const references = new Map<string, ReferenceRecord>();
  const evidence = new Map<string, Evidence>();
  const reasons = new Set<string>();
  const slots = new Map<bigint, LoadedImage['imports'][number]>();
  const stubs = new Map<bigint, LoadedImage['imports'][number]>();
  const functions = new Map(
    discovery.graphs.map((graph) => [graph.function.entry.value, graph.function.id]),
  );
  const fixups = new Map<bigint, LoadedImage['relocations'][number][]>();
  const va = (value: bigint): Address => ({ image_id: image.id, space: 'va', value });
  for (const item of image.imports) {
    context.checkpoint(1);
    if (item.slot) slots.set(virtualAddress(image, item.slot).value, item);
    if (item.callable_entry) stubs.set(virtualAddress(image, item.callable_entry).value, item);
  }
  for (const relocation of image.relocations) {
    context.checkpoint(1);
    const address = virtualAddress(image, relocation.address).value;
    const list = fixups.get(address) ?? [];
    list.push(relocation);
    fixups.set(address, list);
  }
  const executable = (value: bigint): boolean =>
    image.mappings.some(
      (mapping) =>
        value >= mapping.va &&
        value < mapping.va + mapping.file_size &&
        mapping.permissions.includes('execute'),
    );
  const derive = (
    instruction: DecodedInstruction,
    rule: string,
    parents: readonly string[],
  ): string => {
    const derived = [...new Set([...instruction.evidence_ids, ...parents])].sort();
    const id = `evidence_${fingerprint([image.selected_slice_id, 'targets/1', instruction.id, rule, derived])}`;
    evidence.set(id, {
      id,
      origin: { kind: 'analysis', analyzer: 'open-decomp/targets', version: '1', rule },
      claim: rule,
      derived_from: derived,
      conflicts_with: [],
      revision,
    });
    return id;
  };
  const record = (
    instruction: DecodedInstruction,
    owner: string,
    kind: ReferenceRecord['kind'],
    target: bigint | null,
    status: ReferenceRecord['status'],
    rule: string,
    parents: readonly string[] = [],
    entity: string | null = null,
    storage = false,
  ): void => {
    if (references.size >= maxReferences) {
      reasons.add('Reference budget exhausted');
      return;
    }
    const stub = target === null ? undefined : stubs.get(target);
    const slot = target === null ? undefined : slots.get(target);
    const control = kind === 'call' || kind === 'branch' || kind === 'tail_call';
    const role: ReferenceRecord['target_role'] =
      storage && slot
        ? 'import_slot'
        : stub && control
          ? 'callable_stub'
          : control && (target !== null || entity !== null)
            ? 'code'
            : target !== null
              ? 'data'
              : 'unknown';
    const toEntity =
      entity ??
      (control && !storage
        ? (stub?.id ?? (target === null ? null : functions.get(target)) ?? null)
        : storage
          ? (slot?.id ?? null)
          : null);
    const id = entityIdentity(image.selected_slice_id, 'reference', [
      'targets/1',
      owner,
      instruction.id,
      kind,
      target,
      toEntity,
      status,
      role,
    ]);
    references.set(id, {
      id,
      from: instruction.address,
      from_function: owner,
      from_instruction: instruction.id,
      to: target === null ? null : va(target),
      to_entity: toEntity,
      kind,
      status,
      target_role: role,
      evidence_ids: [derive(instruction, rule, parents)],
    });
  };
  const pointer = (address: bigint, origins: readonly string[]): Value | undefined => {
    const entries = fixups.get(address);
    if (entries?.some((entry) => entry.authenticated)) return undefined;
    const imported = slots.get(address);
    if (imported)
      return {
        value: null,
        storage: address,
        entity: imported.id,
        status: imported.weak ? 'candidate' : 'established',
        origins: [...origins, ...imported.evidence_ids],
      };
    if (entries?.length) {
      if (entries.length !== 1 || entries[0]!.authenticated) return undefined;
      const relocation = entries[0]!;
      if (relocation.width_bits !== 64 || !relocation.target) return undefined;
      return {
        value: virtualAddress(image, relocation.target).value,
        storage: address,
        status: 'candidate',
        origins: [...origins, ...relocation.evidence_ids],
      };
    }
    const spans = image.address_map.spans(va(address), 8n);
    if (spans.length !== 1 || spans[0]!.kind !== 'mapped' || spans[0]!.file_offset === null)
      return undefined;
    return {
      value: image.bytes.u64(spans[0]!.file_offset),
      storage: address,
      status: 'candidate',
      origins,
    };
  };
  const table = (
    instruction: DecodedInstruction,
    owner: string,
    address: bigint,
    origins: readonly string[],
  ): void => {
    // Only a discovery range establishes an enumeration boundary. Guessing one
    // from adjacent executable-looking words would invent a switch extent.
    const hints = discovery.jump_tables.filter((item) => {
      context.checkpoint(1);
      return item.range !== null && virtualAddress(image, item.range.start).value === address;
    });
    const hint = hints[0];
    if (!hint?.range || hints.length !== 1 || hint.range.size % 8n !== 0n) {
      reasons.add('Indirect table has no unique bounded absolute-u64 extent');
      return;
    }
    const count = hint.range.size / 8n;
    for (let index = 0; BigInt(index) < count && index < maxEntries; index++) {
      context.checkpoint(1);
      const value = pointer(address + BigInt(index) * 8n, [...origins, ...hint.evidence_ids]);
      if (value?.value !== null && value?.value !== undefined && executable(value.value))
        record(
          instruction,
          owner,
          'branch',
          value.value,
          'candidate',
          'Bounded absolute-u64 jump-table entry; index feasibility not established',
          value.origins,
        );
      else reasons.add('Jump table contains unresolved or noncode entries');
    }
    if (count > BigInt(maxEntries)) reasons.add('Jump-table entry budget exhausted');
  };
  let processed = 0;
  let exhausted = false;
  for (const graph of [...discovery.graphs].sort((a, b) =>
    a.function.entry.value < b.function.entry.value
      ? -1
      : a.function.entry.value > b.function.entry.value
        ? 1
        : a.function.id.localeCompare(b.function.id),
  )) {
    if (graph.slice_id !== image.selected_slice_id || graph.function.entry.image_id !== image.id)
      throw new RangeError('Discovery belongs to another image/slice');
    const byId = new Map(graph.instructions.map((instruction) => [instruction.id, instruction]));
    const proven = new Map(graph.jump_tables?.map((item) => [item.branch, item]));
    for (const block of graph.blocks) {
      const state = new Map<string, Value>();
      const get = (register: RegisterDescriptor): Value | undefined =>
        register.role === 'zero'
          ? { value: 0n, status: 'candidate', origins: [] }
          : register.width_bits === 64 && register.offset_bits === 0
            ? state.get(register.root)
            : undefined;
      const owner = graph.function.id;
      for (const id of block.instructions) {
        context.checkpoint(1);
        if (processed >= maxInstructions || references.size >= maxReferences) {
          exhausted = true;
          break;
        }
        const instruction = byId.get(id);
        if (!instruction) {
          reasons.add('Discovery block has unavailable instruction');
          state.clear();
          continue;
        }
        processed++;
        const payload = instruction.payload;
        if (
          instruction.validity !== 'valid' ||
          !payload ||
          payload.architecture !== image.target.architecture
        ) {
          state.clear();
          reasons.add('Unavailable instruction semantics in address recovery');
          continue;
        }
        let assigned: { register: RegisterDescriptor; value: Value } | undefined;
        let indirect: Value | undefined;
        let hasStore = false;
        const emitMemory = (location: Location | undefined, access: string): void => {
          if (access === 'none') return;
          if (access.includes('write')) hasStore = true;
          const kinds: ReferenceRecord['kind'][] = [];
          if (access.includes('read')) kinds.push('read');
          if (access.includes('write')) kinds.push('write');
          if (!kinds.length) kinds.push('unknown');
          for (const kind of kinds)
            record(
              instruction,
              owner,
              kind,
              location?.value ?? null,
              location ? (location.indexed ? 'candidate' : location.status) : 'unresolved',
              location ? 'Decoded memory effective address' : 'Unresolved decoded memory address',
              location?.origins ?? [],
              null,
              true,
            );
        };
        if (payload.architecture === 'x86_64') {
          const mnemonic = payload.mnemonic.toUpperCase();
          const location = (memory: X86Payload['memory'][number]): Location | undefined => {
            // FS/GS refer to runtime thread bases; no flat-address assertion.
            if (
              memory.address_bits !== 64 ||
              (memory.segment && /:(fs|gs)$/i.test(memory.segment.id))
            )
              return undefined;
            if (memory.rip_relative_target)
              return {
                value: memory.rip_relative_target.value,
                indexed: false,
                origins: instruction.evidence_ids,
                status: 'established',
              };
            const base = memory.base
              ? get(memory.base)
              : { value: 0n, status: 'established' as const, origins: [] };
            if (base?.value === null || base?.value === undefined) return undefined;
            const index = memory.index ? get(memory.index) : undefined;
            const indexed =
              memory.index !== null && (index?.value === null || index?.value === undefined);
            const value = BigInt.asUintN(
              64,
              base.value + memory.displacement + (index?.value ?? 0n) * BigInt(memory.scale),
            );
            return {
              value,
              indexed,
              origins: [...base.origins, ...(index?.origins ?? [])],
              status: base.status,
            };
          };
          const operands = payload.operands;
          const dest = operands[0];
          const source = operands[1];
          for (const operand of operands)
            if (operand.kind === 'memory') {
              const loc = location(operand.memory);
              if (mnemonic === 'LEA') {
                if (loc && !loc.indexed && dest?.kind === 'register') {
                  const ev = derive(instruction, 'x86 LEA address formation', loc.origins);
                  assigned = {
                    register: dest.register,
                    value: { value: loc.value, status: loc.status, origins: [ev] },
                  };
                  record(
                    instruction,
                    owner,
                    'address',
                    loc.value,
                    loc.status,
                    'x86 LEA address formation',
                    [ev],
                  );
                }
              } else emitMemory(loc, operand.memory.access);
            }
          if (mnemonic === 'MOV' && dest?.kind === 'register') {
            if (source?.kind === 'immediate')
              assigned = {
                register: dest.register,
                value: {
                  value: source.value,
                  status: 'candidate',
                  origins: [derive(instruction, 'Immediate value; not an address by itself', [])],
                },
              };
            else if (source?.kind === 'register') {
              const value = get(source.register);
              if (value) assigned = { register: dest.register, value };
            } else if (source?.kind === 'memory' && source.memory.access_bits === 64) {
              const loc = location(source.memory);
              if (loc && !loc.indexed) {
                const value = pointer(loc.value, [
                  derive(instruction, 'x86 pointer load', loc.origins),
                ]);
                if (value) assigned = { register: dest.register, value };
              }
            }
          }
          if (
            (mnemonic === 'ADD' || mnemonic === 'SUB') &&
            dest?.kind === 'register' &&
            source?.kind === 'immediate'
          ) {
            const value = get(dest.register);
            if (value?.value !== null && value?.value !== undefined)
              assigned = {
                register: dest.register,
                value: {
                  value: BigInt.asUintN(
                    64,
                    value.value + (mnemonic === 'ADD' ? source.value : -source.value),
                  ),
                  status: value.status,
                  origins: [derive(instruction, 'x86 address arithmetic', value.origins)],
                },
              };
          }
          if (
            (instruction.flow.kind === 'call' && instruction.flow.indirect) ||
            instruction.flow.kind === 'indirect_branch'
          ) {
            const operand = operands[0];
            if (operand?.kind === 'register') indirect = get(operand.register);
            if (operand?.kind === 'memory') {
              const loc = location(operand.memory);
              if (loc && !loc.indexed && operand.memory.access_bits === 64)
                indirect = pointer(loc.value, [
                  derive(instruction, 'x86 indirect pointer operand', loc.origins),
                ]);
              else if (
                loc?.indexed &&
                operand.memory.scale === 8 &&
                instruction.flow.kind === 'indirect_branch'
              )
                table(instruction, owner, loc.value, loc.origins);
            }
          }
          for (const access of payload.registers)
            if (access.access.includes('write') || access.access === 'unknown')
              state.delete(access.register.root);
        } else {
          const encoding = payload.canonical_encoding;
          const operands = payload.operands;
          const dest = operands[0];
          const source = operands[1];
          const relative = operands.find((operand) => operand.kind === 'relative');
          const memory = operands.find((operand) => operand.kind === 'memory');
          const isAddress = encoding === 'ADR_only_pcreladdr' || encoding === 'ADRP_only_pcreladdr';
          const isAdd = encoding === 'ADD_64_addsub_imm';
          const isLoad = encoding === 'LDR_64_ldst_pos' || encoding === 'LDR_64_ldst_regoff';
          if (isAddress && dest?.kind === 'register' && relative?.kind === 'relative') {
            const page = encoding === 'ADRP_only_pcreladdr';
            assigned = {
              register: dest.register,
              value: {
                value: relative.target.value,
                status: 'established',
                page,
                origins: [
                  derive(
                    instruction,
                    page
                      ? 'ARM64 ADRP page base; not an exact object reference'
                      : 'ARM64 ADR address formation',
                    [],
                  ),
                ],
              },
            };
            if (!page)
              record(
                instruction,
                owner,
                'address',
                relative.target.value,
                'established',
                'ARM64 ADR address formation',
              );
          }
          if (isAdd && dest?.kind === 'register' && source?.kind === 'register') {
            const value = get(source.register);
            const immediate = operands.find((operand) => operand.kind === 'immediate');
            const modifier = operands.find((operand) => operand.kind === 'modifier');
            if (
              value?.value !== null &&
              value?.value !== undefined &&
              immediate?.kind === 'immediate' &&
              (!modifier || modifier.operation === 'lsl')
            ) {
              const result = BigInt.asUintN(
                64,
                value.value + (immediate.value << BigInt(modifier?.amount ?? 0)),
              );
              const origins = [
                derive(instruction, 'ARM64 base plus immediate address', value.origins),
              ];
              assigned = {
                register: dest.register,
                value: { value: result, status: value.status, origins },
              };
              if (image.address_map.translate(va(result), 'va').kind !== 'unmapped')
                record(
                  instruction,
                  owner,
                  'address',
                  result,
                  value.status,
                  'ARM64 base plus immediate address',
                  origins,
                );
            }
          }
          if (memory?.kind === 'memory') {
            const base = get(memory.base);
            const index = memory.index ? get(memory.index) : undefined;
            const supportedIndex =
              memory.extend === 'none' ||
              memory.extend === 'lsl' ||
              memory.extend === 'uxtw' ||
              memory.extend === 'sxtw' ||
              memory.extend === 'sxtx';
            let loc: Location | undefined;
            if (base?.value !== null && base?.value !== undefined && supportedIndex) {
              const ix =
                index?.value === null || index?.value === undefined
                  ? null
                  : memory.extend === 'uxtw'
                    ? BigInt.asUintN(32, index.value)
                    : memory.extend === 'sxtw'
                      ? BigInt.asIntN(32, index.value)
                      : index.value;
              loc = {
                value: BigInt.asUintN(
                  64,
                  base.value +
                    (memory.writeback === 'post' ? 0n : memory.displacement) +
                    ((ix ?? 0n) << BigInt(memory.shift)),
                ),
                indexed: memory.index !== null && ix === null,
                status: base.status,
                origins: [...base.origins, ...(index?.origins ?? [])],
              };
            }
            emitMemory(loc, memory.access);
            if (
              isLoad &&
              memory.access_bits === 64 &&
              memory.writeback === 'none' &&
              dest?.kind === 'register' &&
              loc
            ) {
              const value =
                loc.indexed && memory.shift === 3
                  ? {
                      value: null,
                      table: loc.value,
                      status: 'candidate' as const,
                      origins: [
                        derive(instruction, 'ARM64 indexed absolute-u64 pointer load', loc.origins),
                      ],
                    }
                  : !loc.indexed
                    ? pointer(loc.value, [derive(instruction, 'ARM64 pointer load', loc.origins)])
                    : undefined;
              if (value) assigned = { register: dest.register, value };
            }
          } else if (/^LDR_.*loadlit$/.test(encoding) && relative?.kind === 'relative')
            record(
              instruction,
              owner,
              'read',
              relative.target.value,
              'established',
              'ARM64 literal memory read',
            );
          if (
            ((instruction.flow.kind === 'call' && instruction.flow.indirect) ||
              instruction.flow.kind === 'indirect_branch') &&
            (encoding === 'BR_64_branch_reg' || encoding === 'BLR_64_branch_reg') &&
            dest?.kind === 'register'
          )
            indirect = get(dest.register);
          // ARM operand access is currently unknown. Only these exact address
          // families have local transfer semantics; everything else kills state.
          if (isAddress || isAdd || isLoad) {
            if (dest?.kind === 'register') state.delete(dest.register.root);
          } else if (
            instruction.flow.kind !== 'indirect_branch' &&
            instruction.flow.kind !== 'call' &&
            instruction.flow.kind !== 'branch' &&
            !encoding.startsWith('NOP_')
          )
            state.clear();
          if (memory?.kind === 'memory' && memory.writeback !== 'none')
            state.delete(memory.base.root);
        }
        if (
          assigned &&
          assigned.register.width_bits === 64 &&
          assigned.register.offset_bits === 0 &&
          assigned.register.role !== 'zero'
        )
          state.set(assigned.register.root, assigned.value);
        const resolved = proven.get(instruction.id);
        if (resolved) {
          const seen = new Set<bigint>();
          for (const target of resolved.targets)
            if (!seen.has(target.value)) {
              seen.add(target.value);
              record(
                instruction,
                owner,
                'branch',
                target.value,
                'established',
                'Proven jump-table target: bounded index into immutable table entries',
                resolved.evidence_ids,
              );
            }
        } else if (
          (instruction.flow.kind === 'call' && instruction.flow.indirect) ||
          instruction.flow.kind === 'indirect_branch'
        ) {
          const kind = instruction.flow.kind === 'call' ? 'call' : 'branch';
          if (indirect?.entity)
            record(
              instruction,
              owner,
              kind,
              null,
              indirect.status,
              'Indirect transfer through loader import slot',
              indirect.origins,
              indirect.entity,
            );
          else if (
            indirect?.value !== null &&
            indirect?.value !== undefined &&
            executable(indirect.value)
          )
            record(
              instruction,
              owner,
              kind,
              indirect.value,
              indirect.status,
              'Block-local indirect target value',
              indirect.origins,
            );
          else if (indirect?.table !== undefined)
            table(instruction, owner, indirect.table, indirect.origins);
          const established =
            indirect?.status === 'established' &&
            (indirect.entity !== undefined ||
              (indirect.value !== null && executable(indirect.value)));
          if (!established) {
            record(
              instruction,
              owner,
              kind,
              null,
              'unresolved',
              'Indirect runtime target not established',
            );
            reasons.add('Unresolved indirect targets');
          }
        }
        if (hasStore || instruction.flow.kind === 'call' || instruction.flow.kind === 'unknown')
          state.clear();
      }
      if (exhausted) break;
    }
    if (exhausted) break;
  }
  if (exhausted) reasons.add('Target instruction or reference budget exhausted');
  if (discovery.coverage.state !== 'complete') reasons.add('Discovery coverage is incomplete');
  const ordered = [...references.values()].sort((a, b) =>
    a.from.value < b.from.value ? -1 : a.from.value > b.from.value ? 1 : a.id.localeCompare(b.id),
  );
  return {
    image_id: image.id,
    slice_id: image.selected_slice_id,
    revision,
    references: ordered,
    evidence: [...evidence.values()].sort((a, b) => a.id.localeCompare(b.id)),
    state: reasons.size ? 'partial' : 'complete',
    processed_instructions: processed,
    diagnostics: [...reasons].map((message) => ({
      code: message.includes('budget') ? 'resource_limit' : 'unavailable_semantics',
      severity: 'warning',
      message,
      evidence_ids: [],
    })),
  };
}

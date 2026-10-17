import type { EntityId, OperationContext, RegisterDescriptor } from '../core/index.js';
import { registerSchema } from '../core/index.js';
import { bitWidth } from './model.js';
import type { Edge, FunctionIR, MemoryAccess, Value } from './model.js';
import { assertValidIR } from './verify.js';
import { bits, evaluateExpression } from './semantics.js';
import type { RuntimeValue } from './semantics.js';

export interface MemoryRegion {
  readonly base: bigint;
  readonly bytes: Uint8Array;
  readonly writable: boolean;
}
export class OracleMemoryFault extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OracleMemoryFault';
  }
}
/** Owned, bounded fixture memory. No native pointers, executable mappings or host file access. */
export class OracleMemory {
  readonly #regions: MemoryRegion[];
  constructor(regions: readonly MemoryRegion[] = []) {
    this.#regions = regions
      .map((region) => ({ ...region, bytes: region.bytes.slice() }))
      .sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0));
    let end = 0n;
    for (const region of this.#regions) {
      if (
        region.base < end ||
        region.base < 0n ||
        region.base + BigInt(region.bytes.length) > 1n << 64n
      )
        throw new RangeError('Invalid or overlapping fixture memory regions');
      end = region.base + BigInt(region.bytes.length);
    }
  }

  snapshot(): readonly MemoryRegion[] {
    return this.#regions.map((region) => ({ ...region, bytes: region.bytes.slice() }));
  }

  #locations(
    address: bigint,
    count: number,
    access: MemoryAccess,
    write: boolean,
  ): { bytes: Uint8Array; index: number }[] {
    const alignment = access.alignment;
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > 256 ||
      !Number.isSafeInteger(alignment) ||
      alignment < 1 ||
      alignment > 4096 ||
      (alignment & (alignment - 1)) !== 0 ||
      address < 0n ||
      address + BigInt(count) > 1n << 64n ||
      address % BigInt(alignment) !== 0n
    )
      throw new OracleMemoryFault('Invalid, overflowing or misaligned fixture memory access');
    const locations: { bytes: Uint8Array; index: number }[] = [];
    for (let i = 0; i < count; i++) {
      const cursor = address + BigInt(i);
      const region = this.#regions.find(
        (r) => cursor >= r.base && cursor < r.base + BigInt(r.bytes.length),
      );
      if (!region || (write && !region.writable))
        throw new OracleMemoryFault(
          write ? 'Unmapped or read-only fixture store' : 'Unmapped fixture load',
        );
      locations.push({ bytes: region.bytes, index: Number(cursor - region.base) });
    }
    return locations;
  }

  read(
    address: bigint,
    width: number,
    access: MemoryAccess = { endian: 'little', alignment: 1, volatile: false },
  ): bigint {
    const locations = this.#locations(address, width / 8, access, false);
    let value = 0n;
    for (let i = 0; i < locations.length; i++) {
      const location = locations[i]!;
      const shift = access.endian === 'little' ? i * 8 : (locations.length - i - 1) * 8;
      value |= BigInt(location.bytes[location.index]!) << BigInt(shift);
    }
    return value;
  }

  write(
    address: bigint,
    width: number,
    value: bigint,
    access: MemoryAccess = { endian: 'little', alignment: 1, volatile: false },
  ): void {
    // Validate the whole store first: a fault cannot partially update fixture memory.
    const locations = this.#locations(address, width / 8, access, true);
    for (let i = 0; i < locations.length; i++) {
      const location = locations[i]!;
      const shift = access.endian === 'little' ? i * 8 : (locations.length - i - 1) * 8;
      location.bytes[location.index] = Number((value >> BigInt(shift)) & 255n);
    }
  }
}
export interface RegisterState {
  readonly bits: bigint;
  readonly known: bigint;
  readonly undefined: bigint;
  readonly width: number;
}
export interface TrustedCallInput {
  readonly target: bigint;
  readonly arguments: readonly bigint[];
  readMemory(address: bigint, width: number): bigint;
  /** Physical callee-entry state; does not invent a production source-level signature. */
  readRegister(register: RegisterDescriptor): bigint;
}
export interface TrustedCallOutput {
  readonly results: readonly bigint[];
  readonly writes: readonly {
    readonly address: bigint;
    readonly width: number;
    readonly bits: bigint;
  }[];
  /** Applied after invalidating declared clobbers; writes outside that contract are rejected. */
  readonly register_writes?: readonly {
    readonly register: RegisterDescriptor;
    readonly bits: bigint;
  }[];
}
/** Test-owned semantic functions, keyed by exact call node ID, never resolved by a symbol name. */
export type TrustedCall = (input: TrustedCallInput) => TrustedCallOutput;
export interface EvaluationOptions {
  readonly arguments?: readonly bigint[];
  readonly registers?: ReadonlyMap<string, bigint>;
  readonly memory?: readonly MemoryRegion[];
  readonly calls?: ReadonlyMap<EntityId, TrustedCall>;
  readonly max_steps?: number;
  readonly context?: OperationContext;
}
export interface EvaluationResult {
  readonly status: 'returned' | 'trap' | 'unknown' | 'undefined' | 'memory_fault' | 'step_limit';
  readonly values: readonly RuntimeValue[];
  readonly reason: string | null;
  readonly node: EntityId;
  readonly steps: number;
  readonly registers: ReadonlyMap<string, RegisterState>;
  readonly memory: readonly MemoryRegion[];
  readonly effect_trace: readonly EntityId[];
}
class EvaluationBoundary extends Error {
  constructor(
    readonly status: EvaluationResult['status'],
    message: string,
  ) {
    super(message);
  }
}
/**
 * Semantic oracle for manually constructed trusted fixture IR, not a user binary executor.
 * Unknown effects/calls/indirect transfers stop. Undefined values propagate until observed;
 * select observes only its chosen arm. Memory faults are oracle faults, NOT proven ISA traps.
 */
export function evaluateIR(ir: FunctionIR, options: EvaluationOptions = {}): EvaluationResult {
  assertValidIR(ir);
  const maxSteps = options.max_steps ?? 100_000;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 1_000_000)
    throw new RangeError('Fixture step limit must be 1..1000000');
  const memory = new OracleMemory(options.memory);
  const registers = new Map<string, RegisterState>();
  const rootWidths = new Map<string, number>();
  const states = new Map(
    ir.form === 'ssa' ? ir.register_states.map((state) => [state.block, state] as const) : [],
  );
  for (const state of states.values())
    for (const binding of state.entry)
      rootWidths.set(binding.register.root, binding.register.root_width_bits);
  for (const block of ir.blocks)
    for (const instruction of block.instructions) {
      if (instruction.kind === 'read_register' || instruction.kind === 'write_register')
        rootWidths.set(instruction.register.root, instruction.register.root_width_bits);
      if (instruction.kind === 'call' || instruction.kind === 'unknown_effect')
        for (const register of [...instruction.clobbers.registers, ...instruction.clobbers.flags])
          rootWidths.set(register.root, register.root_width_bits);
    }
  for (const [root, value] of options.registers ?? []) {
    const width = rootWidths.get(root);
    if (!width) throw new TypeError(`Initial register root not used by IR: ${root}`);
    registers.set(root, {
      bits: BigInt.asUintN(width, value),
      known: (1n << BigInt(width)) - 1n,
      undefined: 0n,
      width,
    });
  }
  const readRegister = (register: RegisterDescriptor): RuntimeValue => {
    if (register.role === 'zero') return bits(0n, register.width_bits);
    const root = registers.get(register.root);
    const mask = ((1n << BigInt(register.width_bits)) - 1n) << BigInt(register.offset_bits);
    if (root && (root.known & mask) === mask)
      return bits(root.bits >> BigInt(register.offset_bits), register.width_bits);
    if (root && (root.undefined & mask) !== 0n)
      return { kind: 'undefined', reason: `Undefined register slice ${register.id}` };
    return { kind: 'unknown', reason: `Uninitialized or clobbered register slice ${register.id}` };
  };
  const writeRegister = (register: RegisterDescriptor, value: RuntimeValue): void => {
    if (register.write_rule === 'discard') return;
    const width = register.root_width_bits,
      all = (1n << BigInt(width)) - 1n;
    const mask = ((1n << BigInt(register.width_bits)) - 1n) << BigInt(register.offset_bits);
    const old = registers.get(register.root) ?? { bits: 0n, known: 0n, undefined: 0n, width };
    const preserve = register.write_rule === 'preserve_other_bits' ? all ^ mask : 0n;
    const zeroed = register.write_rule === 'zero_extend_root' ? all ^ mask : 0n;
    registers.set(register.root, {
      bits:
        (old.bits & preserve) |
        (value.kind === 'bits' ? (value.bits << BigInt(register.offset_bits)) & mask : 0n),
      known: (old.known & preserve) | zeroed | (value.kind === 'bits' ? mask : 0n),
      undefined: (old.undefined & preserve) | (value.kind === 'undefined' ? mask : 0n),
      width,
    });
  };
  const blocks = new Map(ir.blocks.map((block) => [block.id, block]));
  let block = blocks.get(ir.entry)!;
  const entryBindings = new Map(
    states.get(block.id)?.entry.map((binding) => [binding.value.id, binding] as const) ?? [],
  );
  const args = options.arguments ?? [];
  let argumentIndex = 0;
  let incoming: readonly RuntimeValue[] = block.parameters.map((parameter) => {
    const binding = entryBindings.get(parameter.id);
    if (binding) return readRegister(binding.register);
    const value = args[argumentIndex++];
    if (value === undefined) throw new TypeError('Entry argument arity mismatch');
    return bits(value, bitWidth(parameter.type));
  });
  if (argumentIndex !== args.length) throw new TypeError('Entry argument arity mismatch');
  let steps = 0,
    node = block.id;
  const trace: string[] = [];
  const finish = (
    status: EvaluationResult['status'],
    reason: string | null,
    values: readonly RuntimeValue[] = [],
  ): EvaluationResult => ({
    status,
    reason,
    values,
    node,
    steps,
    registers: new Map(registers),
    memory: memory.snapshot(),
    effect_trace: [...trace],
  });
  const observe = (value: RuntimeValue): bigint => {
    if (value.kind !== 'bits') throw new EvaluationBoundary(value.kind, value.reason);
    return value.bits;
  };
  const step = (id: EntityId): void => {
    node = id;
    if (steps >= maxSteps)
      throw new EvaluationBoundary('step_limit', 'Trusted fixture evaluation step limit reached');
    steps++;
    options.context?.checkpoint(1);
  };
  try {
    for (;;) {
      const values = new Map<string, RuntimeValue>();
      block.parameters.forEach((parameter, index) => values.set(parameter.id, incoming[index]!));
      const get = (value: Value): RuntimeValue => {
        const found = values.get(value.id);
        if (!found) throw new TypeError('Invalid local value reference after verification');
        return found;
      };
      for (const instruction of block.instructions) {
        if ('register_inputs' in instruction)
          for (const binding of instruction.register_inputs)
            writeRegister(binding.register, get(binding.value));
        step(instruction.id);
        if ('effect_in' in instruction) trace.push(instruction.id);
        switch (instruction.kind) {
          case 'assign':
            values.set(
              instruction.result.id,
              evaluateExpression(instruction.result.type, instruction.expression, get),
            );
            break;
          case 'read_register':
            values.set(instruction.result.id, readRegister(instruction.register));
            break;
          case 'write_register':
            writeRegister(instruction.register, get(instruction.value));
            break;
          case 'load':
            values.set(
              instruction.result.id,
              bits(
                memory.read(
                  observe(get(instruction.address)),
                  bitWidth(instruction.result.type),
                  instruction.access,
                ),
                bitWidth(instruction.result.type),
              ),
            );
            break;
          case 'store':
            memory.write(
              observe(get(instruction.address)),
              bitWidth(instruction.value.type),
              observe(get(instruction.value)),
              instruction.access,
            );
            break;
          case 'unknown_effect':
            throw new EvaluationBoundary('unknown', instruction.reason);
          case 'call': {
            const call = options.calls?.get(instruction.id);
            if (!call)
              throw new EvaluationBoundary(
                'unknown',
                'No explicit trusted fixture oracle for call',
              );
            const target =
              instruction.target.kind === 'direct'
                ? instruction.target.address.value
                : observe(get(instruction.target.value));
            const args = instruction.arguments.map((value) => observe(get(value)));
            const output = call({
              target,
              arguments: args,
              readRegister: (register) => {
                registerSchema.parse(register);
                if (
                  register.role !== 'zero' &&
                  rootWidths.get(register.root) !== register.root_width_bits
                )
                  throw new TypeError('Trusted call read references untracked physical state');
                return observe(readRegister(register));
              },
              readMemory: (address, width) => {
                if (instruction.clobbers.memory === 'none')
                  throw new TypeError('Trusted call read violates memory contract');
                return memory.read(address, width);
              },
            });
            if (output.results.length !== instruction.results.length)
              throw new TypeError('Trusted call result arity mismatch');
            if (output.writes.length > 0 && instruction.clobbers.memory !== 'unknown_read_write')
              throw new TypeError('Trusted call write violates memory contract');
            const allowed = new Map<string, bigint>();
            for (const register of [
              ...instruction.clobbers.registers,
              ...instruction.clobbers.flags,
            ]) {
              const mask =
                ((1n << BigInt(register.width_bits)) - 1n) << BigInt(register.offset_bits);
              allowed.set(register.root, (allowed.get(register.root) ?? 0n) | mask);
            }
            for (const { register } of output.register_writes ?? []) {
              registerSchema.parse(register);
              if (
                rootWidths.get(register.root) !== register.root_width_bits ||
                register.role === 'zero' ||
                register.write_rule === 'discard' ||
                (register.write_rule === 'replace_root' &&
                  (register.offset_bits !== 0 ||
                    register.width_bits !== register.root_width_bits)) ||
                (register.write_rule === 'zero_extend_root' && register.offset_bits !== 0)
              )
                throw new TypeError('Invalid trusted call register write');
              const mask =
                register.write_rule === 'preserve_other_bits'
                  ? ((1n << BigInt(register.width_bits)) - 1n) << BigInt(register.offset_bits)
                  : (1n << BigInt(register.root_width_bits)) - 1n;
              if ((mask & (allowed.get(register.root) ?? 0n)) !== mask)
                throw new TypeError('Trusted call register write violates clobber contract');
            }
            for (const write of output.writes) memory.write(write.address, write.width, write.bits);
            // Clobbers describe overwritten slices, not architectural zero-extending writes.
            for (const register of [
              ...instruction.clobbers.registers,
              ...instruction.clobbers.flags,
            ])
              writeRegister(
                { ...register, write_rule: 'preserve_other_bits' },
                { kind: 'unknown', reason: 'Call clobber' },
              );
            for (const write of output.register_writes ?? [])
              writeRegister(write.register, bits(write.bits, write.register.width_bits));
            for (const binding of instruction.register_outputs)
              values.set(binding.value.id, readRegister(binding.register));
            instruction.results.forEach((result, index) =>
              values.set(result.id, bits(output.results[index]!, bitWidth(result.type))),
            );
            break;
          }
        }
      }
      for (const binding of states.get(block.id)?.exit ?? [])
        writeRegister(binding.register, get(binding.value));
      const terminator = block.terminator;
      step(terminator.id);
      let edge: Edge;
      switch (terminator.kind) {
        case 'return': {
          const results = terminator.values.map(get);
          const uncertain = results.find((value) => value.kind !== 'bits');
          return uncertain
            ? finish(uncertain.kind, uncertain.reason, results)
            : finish('returned', null, results);
        }
        case 'trap':
          return finish('trap', terminator.reason);
        case 'unknown':
        case 'indirect':
          return finish('unknown', terminator.reason);
        case 'jump':
          edge = terminator.edge;
          break;
        case 'branch':
          edge =
            observe(get(terminator.condition)) === 0n
              ? terminator.when_false
              : terminator.when_true;
          break;
        case 'switch': {
          const selector = observe(get(terminator.value));
          edge =
            terminator.cases.find((item) => item.bits === selector)?.edge ?? terminator.otherwise;
          break;
        }
      }
      incoming = edge.arguments.map(get);
      block = blocks.get(edge.target)!;
    }
  } catch (error) {
    if (error instanceof EvaluationBoundary) return finish(error.status, error.message);
    if (error instanceof OracleMemoryFault) return finish('memory_fault', error.message);
    throw error;
  }
}

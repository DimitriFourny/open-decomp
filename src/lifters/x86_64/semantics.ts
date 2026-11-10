import type {
  AbiProfile,
  CallClobbers,
  DecodedInstruction,
  RegisterDescriptor,
  X86Payload,
} from '../../core/index.js';
import {
  BlockBuilder,
  IRBuilder,
  bitWidth,
  floatBits,
  floating,
  instructionProvenance,
  integer,
  vector,
} from '../../ir/index.js';
import type { DataType, IntegerOp, Value } from '../../ir/index.js';

type Operand = X86Payload['operands'][number];
type Memory = Extract<Operand, { kind: 'memory' }>['memory'];
type Flag = 'cf' | 'pf' | 'af' | 'zf' | 'sf' | 'of';
const flagBits = { cf: 0, pf: 2, af: 4, zf: 6, sf: 7, of: 11 } as const;
export function gpr(root: string, width = 64, offset = 0): RegisterDescriptor {
  return {
    id: `x86_64:${root}[${offset}:${offset + width}]`,
    root: `x86_64:${root}`,
    bank: 'integer',
    offset_bits: offset,
    width_bits: width,
    root_width_bits: 64,
    role: root === 'rsp' ? 'stack_pointer' : 'general',
    write_rule:
      width === 64 ? 'replace_root' : width === 32 ? 'zero_extend_root' : 'preserve_other_bits',
  };
}
function flagRegister(name: Flag): RegisterDescriptor {
  return {
    id: `x86_64:${name}`,
    root: 'x86_64:rflags',
    bank: 'flags',
    offset_bits: flagBits[name],
    width_bits: 1,
    root_width_bits: 64,
    role: 'flags',
    write_rule: 'preserve_other_bits',
  };
}
const mxcsr: RegisterDescriptor = {
  id: 'x86_64:mxcsr',
  root: 'x86_64:mxcsr',
  bank: 'control',
  offset_bits: 0,
  width_bits: 32,
  root_width_bits: 32,
  role: 'general',
  write_rule: 'replace_root',
};
export const x86FpEnvironmentGuard = Object.freeze({
  control_root: 'x86_64:mxcsr',
  offset_bits: 6,
  width_bits: 10,
  supported_bits: 0x7en,
  unsupported_exit: 'Unsupported MXCSR environment (rounding, DAZ, FTZ or unmasked exception)',
});
export const unknownClobbers: CallClobbers = {
  registers: [
    ...[
      'rax',
      'rbx',
      'rcx',
      'rdx',
      'rsi',
      'rdi',
      'rbp',
      'rsp',
      ...Array.from({ length: 8 }, (_, i) => `r${i + 8}`),
    ].map((name) => gpr(name)),
    ...Array.from({ length: 32 }, (_, i): RegisterDescriptor => ({
      id: `x86_64:zmm${i}`,
      root: `x86_64:zmm${i}`,
      bank: 'vector',
      offset_bits: 0,
      width_bits: 512,
      root_width_bits: 512,
      role: 'general',
      write_rule: 'replace_root',
    })),
    mxcsr,
  ],
  flags: Object.keys(flagBits).map((name) => flagRegister(name as Flag)),
  memory: 'unknown_read_write',
};
const mxcsrStatus: RegisterDescriptor = {
  ...mxcsr,
  id: 'x86_64:mxcsr[0:6]',
  bank: 'flags',
  role: 'flags',
  width_bits: 6,
  write_rule: 'preserve_other_bits',
};
const writeAccesses = new Set([
  'write',
  'conditional_write',
  'read_write',
  'read_conditional_write',
]);
const readAccesses = new Set(['read', 'conditional_read', 'read_write', 'read_conditional_write']);
// State the decoder's access sets do not describe: FS/GS base and MXCSR control writes.
const wholeStateMnemonics = new Set([
  'wrfsbase',
  'wrgsbase',
  'ldmxcsr',
  'vldmxcsr',
  'fxrstor',
  'fxrstor64',
  'xrstor',
  'xrstor64',
  'xrstors',
  'xrstors64',
]);
/**
 * The bound of an unlifted instruction's effect, from the decoder's access sets: every register
 * root (or preserved slice) it may write, the six modeled flags it may modify, MXCSR exception
 * status for SIMD instructions, and memory `unknown_read_write` if it may write memory. A form that
 * reads a general-purpose register but writes no memory gets `read_only`, never `none`: the IR does
 * not record which inputs an effect depends on, so a frame address read from a GPR must keep the
 * conservative escape treatment (`none` is only for effects whose inputs are vector, flag or
 * unmodeled x87/MMX state, as on ARM64). Unmodeled x87, MMX and mask registers are not outputs.
 * Returns undefined (keep the whole-state clobber) for anything but a valid, unprivileged
 * instruction that falls through, for segment-register and FS/GS-base writes and for MXCSR loads.
 */
export function boundedUnknownClobbers(instruction: DecodedInstruction): CallClobbers | undefined {
  const p = instruction.payload;
  if (
    instruction.validity !== 'valid' ||
    instruction.flow.kind !== 'fallthrough' ||
    p?.architecture !== 'x86_64' ||
    p.privileged ||
    wholeStateMnemonics.has(p.mnemonic)
  )
    return undefined;
  const registers = new Map<string, RegisterDescriptor>();
  // Every instruction that can set MXCSR exception flags names an XMM/YMM/ZMM register.
  let readsGeneral = false,
    simd = false;
  for (const { register, access } of p.registers) {
    const xmm = register.bank === 'vector' && register.root.startsWith('x86_64:zmm');
    simd ||= xmm;
    if (register.bank === 'integer' && register.role !== 'program_counter')
      readsGeneral ||= readAccesses.has(access);
    if (!writeAccesses.has(access)) continue;
    if (register.bank === 'segment' || register.role === 'program_counter') return undefined;
    if (register.bank === 'integer' || xmm) {
      const descriptor =
        register.write_rule === 'preserve_other_bits'
          ? register
          : register.bank === 'integer'
            ? gpr(register.root.slice('x86_64:'.length))
            : unknownClobbers.registers.find((root) => root.root === register.root)!;
      registers.set(descriptor.id, descriptor);
    }
    // x87, MMX, mask and other control registers are not modeled state.
  }
  // A full-root write subsumes slices of the same root.
  const roots = new Set(
    [...registers.values()]
      .filter((register) => register.width_bits === register.root_width_bits)
      .map((register) => register.root),
  );
  const outputs = [...registers.values()].filter(
    (register) => register.width_bits === register.root_width_bits || !roots.has(register.root),
  );
  const modified = p.flags.written | p.flags.cleared | p.flags.set | p.flags.undefined;
  const flags = (Object.keys(flagBits) as Flag[])
    .filter((name) => (modified >> BigInt(flagBits[name])) & 1n)
    .map(flagRegister);
  if (simd) flags.push(mxcsrStatus);
  const memory = p.memory.some((access) => writeAccesses.has(access.access))
    ? 'unknown_read_write'
    : readsGeneral || p.memory.some((access) => readAccesses.has(access.access))
      ? 'read_only'
      : 'none';
  return { registers: outputs, flags, memory };
}
export class Unsupported extends Error {}
// CMPSS/CMPSD/CMPPS/CMPPD predicates 0-7: EQ, LT, LE, UNORD, NEQ, NLT, NLE, ORD. NEQ/NLT/NLE are
// true for unordered operands (IR `ne` is unordered-or-unequal).
const fpPredicates: readonly (readonly [
  'eq' | 'lt' | 'le' | 'unordered' | 'ne' | 'ordered',
  boolean,
])[] = [
  ['eq', false],
  ['lt', false],
  ['le', false],
  ['unordered', false],
  ['ne', false],
  ['lt', true],
  ['le', true],
  ['ordered', false],
];
function laneSize(suffix: string): number {
  return ({ b: 8, w: 16, d: 32, q: 64 } as Record<string, number>)[suffix]!;
}
const lockable = new Set([
  'add',
  'adc',
  'and',
  'btc',
  'btr',
  'bts',
  'cmpxchg',
  'dec',
  'inc',
  'neg',
  'not',
  'or',
  'sbb',
  'sub',
  'xadd',
  'xchg',
  'xor',
]);

/** Architectural semantics, never inferred from decoder access metadata. */
export class X86Semantics {
  block: BlockBuilder;
  constructor(
    readonly builder: IRBuilder,
    block: BlockBuilder,
    readonly instruction: DecodedInstruction,
    readonly abi: AbiProfile,
    readonly abstractFP: () => void,
  ) {
    this.block = block;
  }

  get p(): X86Payload {
    return this.instruction.payload as X86Payload;
  }

  c(bits: number, value: bigint): Value {
    return this.block.constant(integer(bits), value);
  }

  resize(value: Value, width: number, signed = false): Value {
    const old = bitWidth(value.type);
    return old === width
      ? value
      : this.block.cast(
          old > width ? 'truncate' : signed ? 'sign_extend' : 'zero_extend',
          integer(width),
          value,
        );
  }

  address(memory: Memory, lea = false): Value {
    const b = this.block;
    let address: Value;
    if (memory.rip_relative_target) address = b.address(memory.rip_relative_target);
    else {
      address = this.c(memory.address_bits, memory.displacement);
      if (memory.base)
        address = b.int(
          'add',
          address,
          this.resize(b.readRegister(memory.base), memory.address_bits),
        );
      if (memory.index)
        address = b.int(
          'add',
          address,
          b.int(
            'mul',
            this.resize(b.readRegister(memory.index), memory.address_bits),
            this.c(memory.address_bits, BigInt(memory.scale)),
          ),
        );
      address = this.resize(address, 64);
    }
    if (!lea && (memory.segment?.id === 'x86_64:fs' || memory.segment?.id === 'x86_64:gs')) {
      const name = `${memory.segment.id}_base`;
      address = b.int(
        'add',
        address,
        b.readRegister({
          id: name,
          root: name,
          bank: 'control',
          offset_bits: 0,
          width_bits: 64,
          root_width_bits: 64,
          role: 'general',
          write_rule: 'replace_root',
        }),
      );
    }
    return address;
  }

  width(operand: Operand): number {
    switch (operand.kind) {
      case 'register':
        return operand.register.width_bits;
      case 'memory':
        return operand.memory.access_bits;
      case 'immediate':
        return operand.effective_bits;
      case 'relative':
        return 64;
      default:
        throw new Unsupported('Far pointers');
    }
  }

  read(operand: Operand, width = this.width(operand), alignment = 1): Value {
    switch (operand.kind) {
      case 'register': {
        const register = operand.register;
        return width < register.width_bits
          ? this.block.readRegister({
              ...register,
              id: `${register.id}:low${width}`,
              width_bits: width,
              write_rule: 'preserve_other_bits',
            })
          : this.resize(this.block.readRegister(register), width);
      }
      case 'immediate':
        return this.c(width, operand.value);
      case 'relative':
        return this.block.address(operand.target);
      case 'memory':
        return this.block.load(integer(width), this.address(operand.memory), {
          endian: 'little',
          alignment,
          volatile: false,
        });
      default:
        throw new Unsupported('Far pointers');
    }
  }

  write(operand: Operand, value: Value, alignment = 1): void {
    if (operand.kind === 'register')
      this.block.writeRegister(operand.register, this.resize(value, operand.register.width_bits));
    else if (operand.kind === 'memory')
      this.block.store(this.address(operand.memory), value, {
        endian: 'little',
        alignment,
        volatile: false,
      });
    else throw new Unsupported('Non-writable destination');
  }

  flag(name: Flag): Value {
    return this.block.readRegister(flagRegister(name));
  }

  setFlag(name: Flag, value: Value): void {
    this.block.writeRegister(flagRegister(name), value);
  }

  undefinedFlags(names: readonly Flag[]): void {
    for (const name of names)
      this.setFlag(
        name,
        this.block.indeterminate(
          integer(1),
          'undefined',
          `${this.p.mnemonic} leaves ${name} undefined`,
        ),
      );
  }

  condition(condition: string): Value {
    const b = this.block;
    switch (condition) {
      case 'e':
      case 'z':
        return this.flag('zf');
      case 'ne':
      case 'nz':
        return b.unary('not', this.flag('zf'));
      case 'b':
      case 'c':
      case 'nae':
        return this.flag('cf');
      case 'ae':
      case 'nb':
      case 'nc':
        return b.unary('not', this.flag('cf'));
      case 'be':
      case 'na':
        return b.int('or', this.flag('cf'), this.flag('zf'));
      case 'a':
      case 'nbe':
        return b.unary('not', b.int('or', this.flag('cf'), this.flag('zf')));
      case 'l':
      case 'nge':
        return b.int('xor', this.flag('sf'), this.flag('of'));
      case 'ge':
      case 'nl':
        return b.unary('not', b.int('xor', this.flag('sf'), this.flag('of')));
      case 'le':
      case 'ng':
        return b.int('or', this.flag('zf'), b.int('xor', this.flag('sf'), this.flag('of')));
      case 'g':
      case 'nle':
        return b.unary(
          'not',
          b.int('or', this.flag('zf'), b.int('xor', this.flag('sf'), this.flag('of'))),
        );
      case 'o':
        return this.flag('of');
      case 'no':
        return b.unary('not', this.flag('of'));
      case 's':
        return this.flag('sf');
      case 'ns':
        return b.unary('not', this.flag('sf'));
      case 'p':
      case 'pe':
        return this.flag('pf');
      case 'np':
      case 'po':
        return b.unary('not', this.flag('pf'));
      default:
        throw new Unsupported(`Condition ${condition}`);
    }
  }

  resultFlags(result: Value): void {
    const b = this.block,
      width = bitWidth(result.type),
      zero = this.c(width, 0n);
    this.setFlag('zf', b.compare('eq', result, zero));
    this.setFlag('sf', b.extract(result, width - 1, 1));
    this.setFlag('pf', b.flag('add', 'parity', result, zero, this.c(1, 0n)));
  }

  arithmetic(
    op: 'add' | 'sub',
    left: Value,
    right: Value,
    carry: Value,
    preserveCarry = false,
  ): Value {
    const b = this.block;
    const value = b.int(op, b.int(op, left, right), this.resize(carry, bitWidth(left.type)));
    if (!preserveCarry)
      this.setFlag('cf', b.flag(op, op === 'sub' ? 'borrow' : 'carry', left, right, carry));
    this.setFlag('of', b.flag(op, 'overflow', left, right, carry));
    this.setFlag('af', b.extract(b.int('xor', b.int('xor', left, right), value), 4, 1));
    this.resultFlags(value);
    return value;
  }

  /** Guard returns block parameters: data never leaks between IR blocks. */
  guard(bad: Value, values: readonly Value[], reason: string, trap: boolean): readonly Value[] {
    const origin = instructionProvenance(this.instruction);
    const good = this.builder.block(
      [this.instruction.id, reason, 'continue'],
      values.map((value) => value.type),
      origin,
    );
    const failure = this.builder.block([this.instruction.id, reason, 'boundary'], [], origin);
    failure.terminate({ kind: trap ? 'trap' : 'unknown', reason });
    this.block.branch(bad, this.block.edge(failure), this.block.edge(good, values));
    this.block = good;
    return good.parameters;
  }

  fpEnvironment(): void {
    const b = this.block,
      state = b.readRegister({
        ...mxcsr,
        id: 'x86_64:mxcsr[6:16]',
        offset_bits: x86FpEnvironmentGuard.offset_bits,
        width_bits: x86FpEnvironmentGuard.width_bits,
        write_rule: 'preserve_other_bits',
      });
    this.guard(
      b.compare(
        'ne',
        state,
        this.c(x86FpEnvironmentGuard.width_bits, x86FpEnvironmentGuard.supported_bits),
      ),
      [],
      x86FpEnvironmentGuard.unsupported_exit,
      false,
    );
    this.abstractFP();
  }

  fpStatus(): void {
    this.block.writeRegister(
      mxcsrStatus,
      this.block.indeterminate(
        integer(6),
        'unknown',
        'FP exception status is abstracted; arithmetic NaNs are canonical',
      ),
    );
  }

  multiply(signed: boolean): void {
    const operands = this.p.operands,
      dst = operands[0]!;
    const width = this.width(dst),
      b = this.block;
    const left =
      operands.length === 1
        ? b.readRegister(gpr('rax', width))
        : this.read(operands.length === 3 ? operands[1]! : dst, width);
    const right = this.read(operands.at(-1)!, width);
    const product = b.int(
      'mul',
      this.resize(left, width * 2, signed),
      this.resize(right, width * 2, signed),
    );
    const low = this.resize(product, width),
      high = b.extract(product, width, width);
    const overflow = signed
      ? b.compare('ne', product, this.resize(low, width * 2, true))
      : b.compare('ne', high, this.c(width, 0n));
    if (operands.length === 1) {
      if (width === 8) b.writeRegister(gpr('rax', 16), product);
      else {
        b.writeRegister(gpr('rax', width), low);
        b.writeRegister(gpr('rdx', width), high);
      }
    } else this.write(dst, low);
    this.setFlag('cf', overflow);
    this.setFlag('of', overflow);
    this.undefinedFlags(['sf', 'zf', 'af', 'pf']);
  }

  divide(signed: boolean): void {
    const operand = this.p.operands[0]!,
      width = this.width(operand),
      wide = width * 2;
    let b = this.block;
    const numerator =
      width === 8
        ? b.readRegister(gpr('rax', 16))
        : b.insert(
            this.resize(b.readRegister(gpr('rax', width)), wide),
            b.readRegister(gpr('rdx', width)),
            width,
          );
    const divisor = this.resize(this.read(operand), wide, signed);
    let bad = b.compare('eq', divisor, this.c(wide, 0n));
    if (signed)
      bad = b.int(
        'or',
        bad,
        b.int(
          'and',
          b.compare('eq', numerator, this.c(wide, 1n << BigInt(wide - 1))),
          b.compare('eq', divisor, this.c(wide, -1n)),
        ),
      );
    const checked = this.guard(
      bad,
      [numerator, divisor],
      'x86 divide error: zero divisor or wide overflow',
      true,
    );
    b = this.block;
    const quotient = b.int(signed ? 'sdiv' : 'udiv', checked[0]!, checked[1]!);
    const remainder = b.int(signed ? 'srem' : 'urem', checked[0]!, checked[1]!);
    const low = this.resize(quotient, width);
    const values = this.guard(
      b.compare('ne', quotient, this.resize(low, wide, signed)),
      [low, this.resize(remainder, width)],
      'x86 divide error: quotient overflow',
      true,
    );
    b = this.block;
    b.writeRegister(gpr('rax', width), values[0]!);
    b.writeRegister(width === 8 ? gpr('rax', 8, 8) : gpr('rdx', width), values[1]!);
    this.undefinedFlags(['cf', 'of', 'sf', 'zf', 'af', 'pf']);
  }

  shift(op: 'shl' | 'lshr' | 'ashr' | 'rol' | 'ror'): void {
    const [dst, source] = this.p.operands,
      b = this.block,
      width = this.width(dst!);
    const value = this.read(dst!),
      raw = this.read(source!, width),
      masked = b.int('and', raw, this.c(width, width === 64 ? 63n : 31n));
    const rotate = op === 'rol' || op === 'ror';
    const count = rotate ? b.int('and', masked, this.c(width, BigInt(width - 1))) : masked;
    // Flag suppression uses the masked count, not the lane-width-reduced rotate.
    // https://www.felixcloutier.com/x86/rcl:rcr:rol:ror#flags-affected
    const zero = b.compare('eq', masked, this.c(width, 0n)),
      one = b.compare('eq', masked, this.c(width, 1n));
    const result = b.int(op, value, count);
    const old = new Map<Flag, Value>(
      (rotate ? (['cf', 'of'] as const) : (['cf', 'of', 'zf', 'sf', 'pf', 'af'] as const)).map(
        (name) => [name, this.flag(name)],
      ),
    );
    this.write(dst!, result);
    let carry: Value;
    if (rotate) carry = b.extract(result, op === 'rol' ? 0 : width - 1, 1);
    else {
      const position =
        op === 'shl'
          ? b.int('sub', this.c(width, BigInt(width)), count)
          : b.int('sub', count, this.c(width, 1n));
      carry = b.extract(b.int('lshr', value, position), 0, 1);
      if (op === 'ashr')
        carry = b.select(
          b.compare('uge', count, this.c(width, BigInt(width))),
          b.extract(value, width - 1, 1),
          carry,
        );
      else
        carry = b.select(
          b.compare('uge', count, this.c(width, BigInt(width))),
          b.indeterminate(integer(1), 'undefined', 'Shift carry at or beyond operand width'),
          carry,
        );
    }
    this.setFlag('cf', b.select(zero, old.get('cf')!, carry));
    const overflow =
      op === 'shl' || op === 'rol'
        ? b.int('xor', b.extract(result, width - 1, 1), carry)
        : op === 'ror'
          ? b.int('xor', b.extract(result, width - 1, 1), b.extract(result, width - 2, 1))
          : op === 'lshr'
            ? b.extract(value, width - 1, 1)
            : this.c(1, 0n);
    this.setFlag(
      'of',
      b.select(
        zero,
        old.get('of')!,
        b.select(
          one,
          overflow,
          b.indeterminate(integer(1), 'undefined', 'Shift overflow for count other than one'),
        ),
      ),
    );
    if (!rotate) {
      const computed: readonly [Flag, Value][] = [
        ['zf', b.compare('eq', result, this.c(width, 0n))],
        ['sf', b.extract(result, width - 1, 1)],
        ['pf', b.flag('add', 'parity', result, this.c(width, 0n), this.c(1, 0n))],
        ['af', b.indeterminate(integer(1), 'undefined', 'Shift auxiliary carry')],
      ];
      for (const [name, flag] of computed) this.setFlag(name, b.select(zero, old.get(name)!, flag));
    }
  }

  /**
   * BT/BTS/BTR/BTC: CF receives the selected bit, which BTS sets, BTR clears and BTC complements
   * (BT writes nothing); OF/SF/AF/PF are undefined and ZF is unchanged. A register or immediate
   * offset selects bit `offset mod width`. A memory operand with a register offset is a signed bit
   * string: the access is the operand-width word at `address + floor(offset / width) * width / 8`
   * (Intel SDM, BT), then bit `offset mod width`.
   */
  bitTest(op: 'bt' | 'bts' | 'btr' | 'btc'): void {
    const [dst, source] = this.p.operands,
      b = this.block,
      name = op.toUpperCase();
    if (!dst || !source || (dst.kind !== 'register' && dst.kind !== 'memory'))
      throw new Unsupported(`${name} operands`);
    const width = this.width(dst);
    if (width !== 16 && width !== 32 && width !== 64)
      throw new Unsupported(`${name} operand width`);
    const offset = this.read(source, width),
      bit = b.int('and', offset, this.c(width, BigInt(width - 1)));
    let location: Value | undefined;
    if (dst.kind === 'memory' && source.kind === 'register') {
      if (dst.memory.address_bits !== 64)
        throw new Unsupported(`${name} register bit offset with a non-64-bit address size`);
      const words = this.resize(
        b.int('ashr', offset, this.c(width, BigInt(Math.log2(width)))),
        64,
        true,
      );
      location = b.int(
        'add',
        this.address(dst.memory),
        b.int('mul', words, this.c(64, BigInt(width / 8))),
      );
    }
    const old = location
      ? b.load(integer(width), location, { endian: 'little', alignment: 1, volatile: false })
      : this.read(dst, width);
    const selected = b.extract(b.int('lshr', old, bit), 0, 1);
    if (op !== 'bt') {
      const mask = b.int('shl', this.c(width, 1n), bit);
      const value =
        op === 'bts'
          ? b.int('or', old, mask)
          : op === 'btr'
            ? b.int('and', old, b.unary('not', mask))
            : b.int('xor', old, mask);
      if (location) b.store(location, value, { endian: 'little', alignment: 1, volatile: false });
      else this.write(dst, value);
    }
    this.setFlag('cf', selected);
    this.undefinedFlags(['of', 'sf', 'af', 'pf']);
  }

  /**
   * BSF/BSR/TZCNT/LZCNT/POPCNT. A zero BSF/BSR source leaves the destination undefined (Intel SDM;
   * AMD documents it unchanged), including the upper half of a 32-bit destination's root, and sets
   * ZF; CF/OF/SF/AF/PF are undefined. TZCNT/LZCNT are the BMI1/LZCNT instructions the decoder
   * reports (on older processors the same bytes execute as BSF/BSR): the operand width for a zero
   * source, CF = source is zero, ZF = result is zero, OF/SF/AF/PF undefined. POPCNT clears
   * CF/OF/SF/AF/PF and sets ZF when the source is zero.
   */
  bitCount(m: 'bsf' | 'bsr' | 'tzcnt' | 'lzcnt' | 'popcnt'): void {
    const [dst, src] = this.p.operands,
      b = this.block;
    if (dst?.kind !== 'register' || !src) throw new Unsupported(`${m} operands`);
    const width = this.width(dst),
      source = this.read(src, width),
      zero = b.compare('eq', source, this.c(width, 0n));
    if (m === 'bsf' || m === 'bsr') {
      const index =
        m === 'bsf'
          ? b.unary('ctz', source)
          : b.int('sub', this.c(width, BigInt(width - 1)), b.unary('clz', source));
      const target = width === 16 ? dst.register : gpr(dst.register.root.slice('x86_64:'.length));
      const bits = target.width_bits;
      b.writeRegister(
        target,
        b.select(
          zero,
          b.indeterminate(integer(bits), 'undefined', `${m} destination for a zero source`),
          this.resize(index, bits),
        ),
      );
      this.setFlag('zf', zero);
      this.undefinedFlags(['cf', 'of', 'sf', 'af', 'pf']);
      return;
    }
    const result = b.unary(m === 'tzcnt' ? 'ctz' : m === 'lzcnt' ? 'clz' : 'popcount', source);
    this.write(dst, result);
    if (m === 'popcnt') {
      this.setFlag('zf', zero);
      for (const name of ['cf', 'of', 'sf', 'af', 'pf'] as const) this.setFlag(name, this.c(1, 0n));
      return;
    }
    this.setFlag('cf', zero);
    this.setFlag('zf', b.compare('eq', result, this.c(width, 0n)));
    this.undefinedFlags(['of', 'sf', 'af', 'pf']);
  }

  /**
   * SHLD/SHRD: the count is masked to 5 bits (6 for 64-bit operands); a zero count changes
   * nothing. CF is the last bit shifted out of the destination, OF (count 1 only) whether the sign
   * changed, SF/ZF/PF follow the result and AF is undefined. A 16-bit count above 16 leaves the
   * result and every flag undefined.
   */
  doubleShift(left: boolean): void {
    const [dst, src, count] = this.p.operands,
      b = this.block;
    if (!dst || src?.kind !== 'register' || !count) throw new Unsupported('SHLD/SHRD operands');
    const width = this.width(dst),
      wide = width * 2;
    const value = this.read(dst),
      fill = this.read(src, width),
      masked = b.int(
        'and',
        this.resize(this.read(count, 8), width),
        this.c(width, width === 64 ? 63n : 31n),
      );
    const zero = b.compare('eq', masked, this.c(width, 0n)),
      one = b.compare('eq', masked, this.c(width, 1n)),
      shift = this.resize(masked, wide);
    const old = new Map<Flag, Value>(
      (['cf', 'of', 'zf', 'sf', 'pf', 'af'] as const).map((name) => [name, this.flag(name)]),
    );
    let result: Value, carry: Value;
    if (left) {
      const joined = b.concat([fill, value]);
      result = b.extract(b.int('shl', joined, shift), width, width);
      carry = b.extract(
        b.int('lshr', joined, b.int('sub', this.c(wide, BigInt(wide)), shift)),
        0,
        1,
      );
    } else {
      const joined = b.concat([value, fill]);
      result = b.extract(b.int('lshr', joined, shift), 0, width);
      carry = b.extract(b.int('lshr', joined, b.int('sub', shift, this.c(wide, 1n))), 0, 1);
    }
    const overflow = b.int('xor', b.extract(result, width - 1, 1), b.extract(value, width - 1, 1));
    const flags: [Flag, Value][] = [
      ['cf', carry],
      [
        'of',
        b.select(
          one,
          overflow,
          b.indeterminate(
            integer(1),
            'undefined',
            'Double shift overflow for count other than one',
          ),
        ),
      ],
      ['zf', b.compare('eq', result, this.c(width, 0n))],
      ['sf', b.extract(result, width - 1, 1)],
      ['pf', b.flag('add', 'parity', result, this.c(width, 0n), this.c(1, 0n))],
      ['af', b.indeterminate(integer(1), 'undefined', 'Double shift auxiliary carry')],
    ];
    const beyond = width === 16 ? b.compare('ugt', masked, this.c(width, 16n)) : undefined;
    const bounded = (value: Value, what: string): Value =>
      beyond
        ? b.select(
            beyond,
            b.indeterminate(
              value.type,
              'undefined',
              `16-bit double shift ${what} for a count above 16`,
            ),
            value,
          )
        : value;
    this.write(dst, bounded(result, 'result'));
    for (const [name, flag] of flags)
      this.setFlag(name, b.select(zero, old.get(name)!, bounded(flag, name)));
  }

  /**
   * A legacy SSE 128-bit source: an XMM register or a 16-byte aligned m128 (legacy SSE faults on
   * a misaligned m128; the alignment is carried by the load).
   */
  xmm(operand: Operand | undefined): Value {
    if (
      operand?.kind === 'register' &&
      operand.register.bank === 'vector' &&
      operand.register.width_bits === 128
    )
      return this.read(operand);
    if (operand?.kind === 'memory' && operand.memory.access_bits === 128)
      return this.read(operand, 128, 16);
    throw new Unsupported('Only legacy SSE XMM or m128 operands are modeled');
  }

  /** Legacy SSE destination write: bits above 127 are preserved. */
  writeXmm(operand: Operand | undefined, value: Value): void {
    if (
      operand?.kind !== 'register' ||
      operand.register.bank !== 'vector' ||
      operand.register.width_bits !== 128
    )
      throw new Unsupported('Only legacy SSE XMM destinations are modeled');
    this.write(operand, value);
  }

  /** Legacy SSE scalar write: only the low lane changes. */
  writeLow(operand: Extract<Operand, { kind: 'register' }>, value: Value): void {
    const width = bitWidth(value.type);
    this.block.writeRegister(
      {
        ...operand.register,
        id: `${operand.register.id}:low${width}`,
        width_bits: width,
        write_rule: 'preserve_other_bits',
      },
      value,
    );
  }

  /**
   * CVTT* truncation of one FP lane to a signed integer: NaN and out-of-range sources give the
   * integer indefinite value (only the sign bit set). In range means
   * -2^(n-1) - 1 < source < 2^(n-1).
   */
  truncateFloat(bits: Value, from: 32 | 64, to: number): Value {
    const b = this.block,
      source = b.cast('bitcast', floating(from), bits);
    const bound = (value: number): Value => b.constant(floating(from), floatBits(value, from));
    const limit = 2 ** (to - 1);
    // -2^(n-1) - 1 is representable only when n + 1 bits fit the significand.
    const low =
      to + 1 <= (from === 64 ? 53 : 24)
        ? b.fpCompare('gt', source, bound(-limit - 1))
        : b.fpCompare('ge', source, bound(-limit));
    const inRange = b.int('and', low, b.fpCompare('lt', source, bound(limit)));
    return b.select(
      inRange,
      b.cast('float_to_signed', integer(to), source),
      this.c(to, 1n << BigInt(to - 1)),
    );
  }

  immediate(operand: Operand | undefined): bigint {
    if (operand?.kind !== 'immediate') throw new Unsupported('Missing immediate operand');
    return operand.value;
  }

  stackPush(value: Value): void {
    const b = this.block,
      sp = b.readRegister(this.abi.stack_pointer),
      next = b.int('sub', sp, this.c(64, BigInt(bitWidth(value.type) / 8)));
    b.writeRegister(this.abi.stack_pointer, next);
    b.store(next, value);
  }

  call(tail = false): void {
    const b = this.block,
      operand = this.p.operands[0]!;
    const target =
      operand.kind === 'relative'
        ? { kind: 'direct' as const, address: operand.target }
        : { kind: 'indirect' as const, value: this.read(operand, 64) };
    const sp = b.readRegister(this.abi.stack_pointer);
    if (!tail)
      this.stackPush(
        b.address({
          ...this.instruction.address,
          value: this.instruction.address.value + BigInt(this.instruction.size),
        }),
      );
    b.call(target, [], [], this.abi.unknown_call_clobbers);
    if (!tail) b.writeRegister(this.abi.stack_pointer, sp);
  }

  /**
   * A LOCK-prefixed read-modify-write (and XCHG with memory, which is always locked) is the
   * unlocked operation between two `memory_fence` events: exact for a single-threaded reading,
   * and locked instructions order all earlier and later loads and stores. The IR does not express
   * the atomicity of the read-modify-write itself.
   */
  execute(): void {
    const p = this.p,
      locked =
        p.prefixes.lock ||
        (p.mnemonic === 'xchg' && p.operands.some((operand) => operand.kind === 'memory'));
    if (!locked) {
      this.operation();
      return;
    }
    if (!lockable.has(p.mnemonic) || p.operands[0]?.kind !== 'memory')
      throw new Unsupported('Privileged, atomic, VEX/EVEX/XOP/MVEX or masked/rounding instruction');
    this.block.memoryFence();
    this.operation();
    this.block.memoryFence();
  }

  operation(): void {
    const p = this.p,
      m = p.mnemonic,
      operands = p.operands,
      dst = operands[0],
      src = operands[1];
    let b = this.block;
    if (
      p.privileged ||
      p.prefixes.encoding !== 'legacy' ||
      p.prefixes.mask ||
      p.prefixes.rounding !== 'none' ||
      p.prefixes.suppress_exceptions
    )
      throw new Unsupported('Privileged, atomic, VEX/EVEX/XOP/MVEX or masked/rounding instruction');
    if (
      operands.some(
        (operand) =>
          operand.kind === 'register' &&
          (operand.register.bank === 'float' || operand.register.id.startsWith('x86_64:mm')),
      )
    )
      throw new Unsupported('x87/MMX register semantics');
    // A segment selector load also replaces the FS/GS base the lifter models.
    if (
      p.registers.some(
        ({ register, access }) => register.bank === 'segment' && writeAccesses.has(access),
      )
    )
      throw new Unsupported('Segment register write');
    if (m === 'nop' || m === 'endbr64') return;
    if (m === 'mov' || m === 'movzx' || m === 'movsx' || m === 'movsxd') {
      const value = this.read(src!);
      this.write(dst!, this.resize(value, this.width(dst!), m === 'movsx' || m === 'movsxd'));
      return;
    }
    if (m === 'lea') {
      if (src?.kind !== 'memory') throw new Unsupported('LEA operand');
      this.write(dst!, this.resize(this.address(src.memory, true), this.width(dst!)));
      return;
    }
    if (m === 'xchg') {
      const left = this.read(dst!),
        right = this.read(src!);
      this.write(dst!, right);
      this.write(src!, left);
      return;
    }
    if (['add', 'adc', 'sub', 'sbb', 'cmp', 'inc', 'dec', 'neg'].includes(m)) {
      const value = this.read(dst!),
        width = bitWidth(value.type),
        unary = m === 'inc' || m === 'dec';
      const left = m === 'neg' ? this.c(width, 0n) : value,
        right = m === 'neg' ? value : unary ? this.c(width, 1n) : this.read(src!, width);
      const carry = m === 'adc' || m === 'sbb' ? this.flag('cf') : this.c(1, 0n);
      const result = this.arithmetic(
        m === 'add' || m === 'adc' || m === 'inc' ? 'add' : 'sub',
        left,
        right,
        carry,
        unary,
      );
      if (m !== 'cmp') this.write(dst!, result);
      return;
    }
    if (['and', 'or', 'xor', 'test'].includes(m)) {
      const left = this.read(dst!),
        right = this.read(src!, bitWidth(left.type));
      const result =
        m === 'xor' &&
        dst?.kind === 'register' &&
        src?.kind === 'register' &&
        dst.register.id === src.register.id
          ? this.c(bitWidth(left.type), 0n)
          : b.int(m === 'test' ? 'and' : (m as IntegerOp), left, right);
      if (m !== 'test') this.write(dst!, result);
      this.setFlag('cf', this.c(1, 0n));
      this.setFlag('of', this.c(1, 0n));
      this.undefinedFlags(['af']);
      this.resultFlags(result);
      return;
    }
    if (m === 'not') {
      this.write(dst!, b.unary('not', this.read(dst!)));
      return;
    }
    if (m === 'shl' || m === 'sal' || m === 'shr' || m === 'sar' || m === 'rol' || m === 'ror') {
      this.shift(m === 'sal' ? 'shl' : m === 'shr' ? 'lshr' : m === 'sar' ? 'ashr' : m);
      return;
    }
    if (m === 'mul' || m === 'imul') {
      this.multiply(m === 'imul');
      return;
    }
    if (m === 'div' || m === 'idiv') {
      this.divide(m === 'idiv');
      return;
    }
    if (['cbw', 'cwde', 'cdqe', 'cwd', 'cdq', 'cqo'].includes(m)) {
      const width =
        m === 'cbw' ? 8 : m === 'cwde' || m === 'cwd' ? 16 : m === 'cdqe' || m === 'cdq' ? 32 : 64;
      const value = b.readRegister(gpr('rax', width));
      if (m === 'cbw' || m === 'cwde' || m === 'cdqe')
        b.writeRegister(gpr('rax', width * 2), this.resize(value, width * 2, true));
      else
        b.writeRegister(gpr('rdx', width), b.int('ashr', value, this.c(width, BigInt(width - 1))));
      return;
    }
    if (m.startsWith('cmov')) {
      const condition = this.condition(m.slice(4)),
        source = this.read(src!, this.width(dst!)),
        old = this.read(dst!);
      this.write(dst!, b.select(condition, source, old));
      return;
    }
    if (m.startsWith('set')) {
      this.write(dst!, this.resize(this.condition(m.slice(3)), 8));
      return;
    }
    if (m === 'clc' || m === 'stc' || m === 'cmc') {
      this.setFlag(
        'cf',
        m === 'cmc' ? b.unary('not', this.flag('cf')) : this.c(1, m === 'stc' ? 1n : 0n),
      );
      return;
    }
    if (m === 'push') {
      this.stackPush(this.read(dst!, p.operand_bits === 16 ? 16 : 64));
      return;
    }
    if (m === 'pop') {
      const width = this.width(dst!),
        sp = b.readRegister(this.abi.stack_pointer),
        value = b.load(integer(width), sp);
      b.writeRegister(this.abi.stack_pointer, b.int('add', sp, this.c(64, BigInt(width / 8))));
      this.write(dst!, value);
      return;
    }
    if (m === 'leave') {
      const width = p.operand_bits === 16 ? 16 : 64,
        sp = b.readRegister(gpr('rbp')),
        value = b.load(integer(width), sp);
      b.writeRegister(gpr('rbp', width), value);
      b.writeRegister(this.abi.stack_pointer, b.int('add', sp, this.c(64, BigInt(width / 8))));
      return;
    }
    if (m === 'call') {
      this.call();
      return;
    }
    if (m === 'ret') {
      const sp = b.readRegister(this.abi.stack_pointer);
      b.load(integer(64), sp);
      b.writeRegister(
        this.abi.stack_pointer,
        b.int('add', sp, this.c(64, 8n + (dst?.kind === 'immediate' ? dst.value : 0n))),
      );
      return;
    }
    if (
      m === 'jmp' ||
      m.startsWith('j') ||
      ['loop', 'loope', 'loopne', 'ud2', 'int3', 'int'].includes(m)
    )
      return;
    if (m === 'bt' || m === 'bts' || m === 'btr' || m === 'btc') {
      this.bitTest(m);
      return;
    }
    if (m === 'bsf' || m === 'bsr' || m === 'tzcnt' || m === 'lzcnt' || m === 'popcnt') {
      this.bitCount(m);
      return;
    }
    if (m === 'shld' || m === 'shrd') {
      this.doubleShift(m === 'shld');
      return;
    }
    if (m === 'bswap') {
      const value = this.read(dst!),
        width = bitWidth(value.type);
      let result = this.c(width, 0n);
      for (let i = 0; i < width; i += 8)
        result = b.insert(result, b.extract(value, i, 8), width - 8 - i);
      this.write(dst!, result);
      return;
    }
    if (['movaps', 'movups', 'movapd', 'movupd', 'movdqa', 'movdqu'].includes(m)) {
      const alignment = m === 'movaps' || m === 'movapd' || m === 'movdqa' ? 16 : 1;
      this.write(dst!, this.read(src!, 128, alignment), alignment);
      return;
    }
    if (m === 'movss' || m === 'movsd' || m === 'movd' || m === 'movq') {
      if (
        !operands.some(
          (operand) => operand.kind === 'register' && operand.register.bank === 'vector',
        )
      )
        throw new Unsupported('String/MMX move');
      const width = m === 'movss' || m === 'movd' ? 32 : 64,
        value = this.read(src!, width);
      if (dst?.kind === 'register' && dst.register.width_bits === 128) {
        if ((m === 'movss' || m === 'movsd') && src?.kind === 'register')
          b.writeRegister(
            {
              ...dst.register,
              id: `${dst.register.id}:low${width}`,
              width_bits: width,
              write_rule: 'preserve_other_bits',
            },
            value,
          );
        else this.write(dst, this.resize(value, 128));
      } else this.write(dst!, value);
      return;
    }
    if (
      [
        'pxor',
        'xorps',
        'xorpd',
        'pand',
        'andps',
        'andpd',
        'por',
        'orps',
        'orpd',
        'pandn',
        'andnps',
        'andnpd',
      ].includes(m)
    ) {
      let left = this.read(dst!, 128);
      const right = this.read(src!, 128);
      if (m.includes('andn')) left = b.unary('not', left);
      this.write(
        dst!,
        m.includes('xor') &&
          dst?.kind === 'register' &&
          src?.kind === 'register' &&
          dst.register.id === src.register.id
          ? this.c(128, 0n)
          : b.int(m.includes('xor') ? 'xor' : m.includes('and') ? 'and' : 'or', left, right),
      );
      return;
    }
    const packed = /^(padd|psub)(b|w|d|q)$/.exec(m);
    if (packed) {
      const width = ({ b: 8, w: 16, d: 32, q: 64 } as const)[packed[2] as 'b' | 'w' | 'd' | 'q'];
      const type = vector(integer(width), 128 / width),
        left = b.cast('bitcast', type, this.read(dst!, 128)),
        right = b.cast('bitcast', type, this.read(src!, 128));
      this.write(
        dst!,
        b.cast(
          'bitcast',
          integer(128),
          b.vectorInt(packed[1] === 'padd' ? 'add' : 'sub', left, right),
        ),
      );
      return;
    }
    if (m === 'cmpxchg') {
      // Memory forms only: the destination is always written (with its old value on failure).
      if (dst?.kind !== 'memory' || src?.kind !== 'register')
        throw new Unsupported('CMPXCHG with a register destination');
      const width = this.width(dst),
        accumulator = gpr('rax', width);
      const old = this.read(dst),
        expected = b.readRegister(accumulator);
      this.arithmetic('sub', expected, old, this.c(1, 0n));
      const equal = this.flag('zf');
      this.write(dst, b.select(equal, this.read(src, width), old));
      // A 32-bit accumulator write zero-extends RAX only when the comparison fails.
      b.writeRegister(
        width === 32 ? gpr('rax') : accumulator,
        b.select(
          equal,
          b.readRegister(width === 32 ? gpr('rax') : accumulator),
          this.resize(old, width === 32 ? 64 : width),
        ),
      );
      return;
    }
    if (m === 'xadd') {
      if (src?.kind !== 'register' || !dst) throw new Unsupported('XADD operands');
      const old = this.read(dst),
        sum = this.arithmetic('add', old, this.read(src, bitWidth(old.type)), this.c(1, 0n));
      this.write(src, old);
      this.write(dst, sum);
      return;
    }
    if (m === 'mfence' || m === 'lfence' || m === 'sfence') {
      b.memoryFence();
      return;
    }
    if (m === 'pause') return;
    const unpack = /^(?:punpck|unpck)([lh])(bw|wd|dq|qdq|ps|pd)$/.exec(m);
    if (unpack) {
      // Interleave the low (or high) halves of destination and source, destination first.
      const size = { bw: 8, wd: 16, dq: 32, qdq: 64, ps: 32, pd: 64 }[unpack[2]!]!,
        half = 64 / size,
        base = unpack[1] === 'h' ? half : 0;
      const left = this.xmm(dst),
        right = this.xmm(src);
      const parts: Value[] = [];
      for (let lane = base; lane < base + half; lane++)
        parts.push(b.extract(left, lane * size, size), b.extract(right, lane * size, size));
      this.writeXmm(dst, b.concat(parts));
      return;
    }
    if (m === 'pshufd' || m === 'pshuflw' || m === 'pshufhw') {
      const source = this.xmm(src),
        order = this.immediate(operands[2]);
      const lanes = (offset: number, size: number): Value[] =>
        [0, 1, 2, 3].map((lane) =>
          b.extract(source, offset + Number((order >> BigInt(2 * lane)) & 3n) * size, size),
        );
      this.writeXmm(
        dst,
        b.concat(
          m === 'pshufd'
            ? lanes(0, 32)
            : m === 'pshuflw'
              ? [...lanes(0, 16), b.extract(source, 64, 64)]
              : [b.extract(source, 0, 64), ...lanes(64, 16)],
        ),
      );
      return;
    }
    if (m === 'shufps' || m === 'shufpd') {
      const left = this.xmm(dst),
        right = this.xmm(src),
        order = this.immediate(operands[2]);
      const pick = (value: Value, selector: bigint, size: number): Value =>
        b.extract(value, Number(selector) * size, size);
      this.writeXmm(
        dst,
        b.concat(
          m === 'shufps'
            ? [0, 1, 2, 3].map((lane) =>
                pick(lane < 2 ? left : right, (order >> BigInt(2 * lane)) & 3n, 32),
              )
            : [pick(left, order & 1n, 64), pick(right, (order >> 1n) & 1n, 64)],
        ),
      );
      return;
    }
    const laneCompare = /^pcmp(eq|gt)(b|w|d|q)$/.exec(m) ?? /^pm(ax|in)([su])(b|w|d)$/.exec(m);
    if (laneCompare) {
      const compare = m.startsWith('pcmp'),
        size = laneSize(laneCompare.at(-1)!);
      if (
        compare &&
        laneCompare[1] === 'eq' &&
        dst?.kind === 'register' &&
        src?.kind === 'register' &&
        dst.register.id === src.register.id
      ) {
        this.writeXmm(dst, this.c(128, -1n));
        return;
      }
      const left = this.xmm(dst),
        right = this.xmm(src);
      const predicate = compare
        ? laneCompare[1] === 'eq'
          ? 'eq'
          : 'sgt'
        : laneCompare[1] === 'ax'
          ? laneCompare[2] === 's'
            ? 'sgt'
            : 'ugt'
          : laneCompare[2] === 's'
            ? 'slt'
            : 'ult';
      const parts: Value[] = [];
      for (let lane = 0; lane < 128 / size; lane++) {
        const l = b.extract(left, lane * size, size),
          r = b.extract(right, lane * size, size),
          holds = b.compare(predicate, l, r);
        parts.push(compare ? b.cast('sign_extend', integer(size), holds) : b.select(holds, l, r));
      }
      this.writeXmm(dst, b.concat(parts));
      return;
    }
    if (m === 'pmovmskb' || m === 'movmskps' || m === 'movmskpd') {
      if (dst?.kind !== 'register' || src?.kind !== 'register')
        throw new Unsupported('Mask extraction operands');
      const size = m === 'pmovmskb' ? 8 : m === 'movmskps' ? 32 : 64,
        source = this.xmm(src);
      const signs: Value[] = [];
      for (let lane = 0; lane < 128 / size; lane++)
        signs.push(b.extract(source, lane * size + size - 1, 1));
      this.write(dst, this.resize(b.concat(signs), this.width(dst)));
      return;
    }
    if (m === 'pinsrw') {
      const lane = Number(this.immediate(operands[2]) & 7n);
      this.writeXmm(dst, b.insert(this.xmm(dst), this.read(src!, 16), lane * 16));
      return;
    }
    if (m === 'pextrw') {
      const lane = Number(this.immediate(operands[2]) & 7n),
        word = b.extract(this.xmm(src), lane * 16, 16);
      this.write(dst!, dst?.kind === 'memory' ? word : this.resize(word, this.width(dst!)));
      return;
    }
    const vectorShift = /^ps(ll|rl|ra)(w|d|q|dq)$/.exec(m);
    if (vectorShift && m !== 'psraq' && m !== 'psradq') {
      const value = this.xmm(dst),
        op = vectorShift[1] === 'll' ? 'shl' : vectorShift[1] === 'rl' ? 'lshr' : 'ashr';
      if (vectorShift[2] === 'dq') {
        // Whole-register byte shift; counts above 15 clear the register.
        const bytes = this.immediate(src);
        this.writeXmm(
          dst,
          bytes > 15n ? this.c(128, 0n) : b.int(op, value, this.c(128, bytes * 8n)),
        );
        return;
      }
      // The count is the unsigned immediate or the source's low quadword. Counts at or above the
      // lane width clear logical lanes and fill arithmetic lanes with the sign (IR shifts
      // saturate the same way), so the count is clamped to the lane width.
      const size = laneSize(vectorShift[2]!),
        type = vector(integer(size), 128 / size);
      let count: Value;
      if (src?.kind === 'immediate')
        count = this.c(size, src.value < BigInt(size) ? src.value : BigInt(size));
      else {
        const raw = b.extract(this.xmm(src), 0, 64);
        count = b.select(
          b.compare('uge', raw, this.c(64, BigInt(size))),
          this.c(size, BigInt(size)),
          this.resize(raw, size),
        );
      }
      const counts = b.pack(
        type,
        Array.from({ length: 128 / size }, () => count),
      );
      this.writeXmm(
        dst,
        b.cast('bitcast', integer(128), b.vectorInt(op, b.cast('bitcast', type, value), counts)),
      );
      return;
    }
    if (m === 'pmuludq') {
      const left = this.xmm(dst),
        right = this.xmm(src);
      const product = (offset: number): Value =>
        b.int(
          'mul',
          this.resize(b.extract(left, offset, 32), 64),
          this.resize(b.extract(right, offset, 32), 64),
        );
      this.writeXmm(dst, b.concat([product(0), product(64)]));
      return;
    }
    if (m === 'pmullw') {
      const type = vector(integer(16), 8);
      this.writeXmm(
        dst,
        b.cast(
          'bitcast',
          integer(128),
          b.vectorInt(
            'mul',
            b.cast('bitcast', type, this.xmm(dst)),
            b.cast('bitcast', type, this.xmm(src)),
          ),
        ),
      );
      return;
    }
    if (['movhps', 'movhpd', 'movlps', 'movlpd', 'movhlps', 'movlhps'].includes(m)) {
      // Quadword moves between XMM halves and memory; the other half (and bits above 127) stay.
      const high = m === 'movhps' || m === 'movhpd';
      if (dst?.kind === 'memory') {
        this.write(dst, b.extract(this.xmm(src), high ? 64 : 0, 64));
        return;
      }
      const quadword =
        m === 'movhlps'
          ? b.extract(this.xmm(src), 64, 64)
          : m === 'movlhps'
            ? b.extract(this.xmm(src), 0, 64)
            : this.read(src!, 64);
      this.writeXmm(dst, b.insert(this.xmm(dst), quadword, high || m === 'movlhps' ? 64 : 0));
      return;
    }
    if (m === 'cvtsi2ss' || m === 'cvtsi2sd') {
      if (
        dst?.kind !== 'register' ||
        dst.register.bank !== 'vector' ||
        dst.register.width_bits !== 128 ||
        !src ||
        (src.kind !== 'register' && src.kind !== 'memory') ||
        (this.width(src) !== 32 && this.width(src) !== 64)
      )
        throw new Unsupported('Only legacy SSE signed GPR/memory scalar conversion is modeled');
      this.fpEnvironment();
      b = this.block;
      const width = m === 'cvtsi2sd' ? 64 : 32;
      const converted = b.cast('signed_to_float', floating(width), this.read(src));
      // Legacy SSE replaces only the low scalar; all upper vector bits and
      // integer flags survive. VEX/EVEX zeroing/merge rules are not implied.
      b.writeRegister(
        {
          ...dst.register,
          id: `${dst.register.id}:low${width}`,
          width_bits: width,
          write_rule: 'preserve_other_bits',
        },
        b.cast('bitcast', integer(width), converted),
      );
      this.fpStatus();
      return;
    }
    const truncate = /^cvtt(ss|sd)2si$/.exec(m);
    if (truncate) {
      if (dst?.kind !== 'register' || !src) throw new Unsupported('CVTT operands');
      this.fpEnvironment();
      b = this.block;
      const from = truncate[1] === 'sd' ? 64 : 32;
      this.write(dst, this.truncateFloat(this.read(src, from), from, this.width(dst)));
      this.fpStatus();
      return;
    }
    const packedConversion = /^(cvttpd2dq|cvttps2dq|cvtdq2pd|cvtdq2ps|cvtps2pd|cvtpd2ps)$/.test(m);
    if (packedConversion) {
      // Packed conversions; narrowing forms (from 64-bit lanes) zero the upper quadword.
      // CVTDQ2PD and CVTPS2PD read only the low quadword (an m64 memory source).
      this.fpEnvironment();
      b = this.block;
      const widening = m === 'cvtdq2pd' || m === 'cvtps2pd';
      const source = widening
        ? src?.kind === 'memory'
          ? this.read(src, 64)
          : b.extract(this.xmm(src), 0, 64)
        : this.xmm(src);
      const from = m === 'cvttpd2dq' || m === 'cvtpd2ps' ? 64 : 32,
        to = from === 64 || m === 'cvtdq2ps' || m === 'cvttps2dq' ? 32 : 64;
      const parts: Value[] = [];
      for (let offset = 0; offset < bitWidth(source.type); offset += from) {
        const lane = b.extract(source, offset, from);
        if (m === 'cvttpd2dq' || m === 'cvttps2dq') parts.push(this.truncateFloat(lane, from, 32));
        else {
          const result = m.startsWith('cvtdq')
            ? b.cast('signed_to_float', floating(to), lane)
            : b.cast('float_convert', floating(to), b.cast('bitcast', floating(from), lane));
          parts.push(b.cast('bitcast', integer(to), result));
        }
      }
      if (from === 64 && to === 32) parts.push(this.c(64, 0n));
      this.writeXmm(dst, b.concat(parts));
      this.fpStatus();
      return;
    }
    const pack = /^pack(ss|us)(wb|dw)$/.exec(m);
    if (pack) {
      // Saturate each signed source lane to half width (signed or unsigned), destination first.
      const size = pack[2] === 'wb' ? 16 : 32,
        half = size / 2,
        unsigned = pack[1] === 'us';
      const minimum = unsigned ? 0n : -(1n << BigInt(half - 1)),
        maximum = unsigned ? (1n << BigInt(half)) - 1n : (1n << BigInt(half - 1)) - 1n;
      const parts: Value[] = [];
      for (const value of [this.xmm(dst), this.xmm(src)])
        for (let offset = 0; offset < 128; offset += size) {
          const lane = b.extract(value, offset, size);
          parts.push(
            this.resize(
              b.select(
                b.compare('slt', lane, this.c(size, minimum)),
                this.c(size, minimum),
                b.select(
                  b.compare('sgt', lane, this.c(size, maximum)),
                  this.c(size, maximum),
                  lane,
                ),
              ),
              half,
            ),
          );
        }
      this.writeXmm(dst, b.concat(parts));
      return;
    }
    const scalar = /^(cvtss2sd|cvtsd2ss|sqrtss|sqrtsd|minss|minsd|maxss|maxsd)$/.test(m);
    const packedMinMax = /^(min|max)(ps|pd)$/.exec(m);
    const fpCompare = /^cmp(ss|sd|ps|pd)$/.exec(m);
    if (scalar || packedMinMax || (fpCompare && operands.length === 3)) {
      if (dst?.kind !== 'register' || dst.register.bank !== 'vector' || !src)
        throw new Unsupported('Only legacy SSE XMM destinations are modeled');
      this.fpEnvironment();
      b = this.block;
      const suffix = m.slice(-2),
        size: 32 | 64 = suffix.endsWith('d') ? 64 : 32,
        packed = suffix.startsWith('p');
      // The source width of a conversion is its input format, not its result.
      const input: 32 | 64 = m === 'cvtss2sd' ? 32 : m === 'cvtsd2ss' ? 64 : size;
      // Conversions and square roots read only the source.
      const unary = m.startsWith('cvt') || m.startsWith('sqrt');
      const left = unary ? undefined : packed ? this.xmm(dst) : this.read(dst, input),
        right = packed ? this.xmm(src) : this.read(src, input);
      const lane = (l: Value | undefined, r: Value): Value => {
        const y = b.cast('bitcast', floating(input), r);
        // The mnemonic suffix is the result format.
        if (m === 'cvtss2sd' || m === 'cvtsd2ss')
          return b.cast('bitcast', integer(size), b.cast('float_convert', floating(size), y));
        if (m.startsWith('sqrt'))
          return b.cast(
            'bitcast',
            integer(size),
            b.assign(floating(size), { kind: 'float_unary', op: 'sqrt', value: y }),
          );
        const x = b.cast('bitcast', floating(input), l!);
        if (fpCompare) {
          const predicate = Number(this.immediate(operands[2]) & 7n);
          const [op, negate] = fpPredicates[predicate]!;
          const holds = b.fpCompare(op, x, y);
          return b.cast('sign_extend', integer(size), negate ? b.unary('not', holds) : holds);
        }
        // MIN/MAX return the second operand when either is NaN or both are zero: exact bits.
        return b.select(b.fpCompare(m.startsWith('min') ? 'lt' : 'gt', x, y), l!, r);
      };
      if (packed) {
        const parts: Value[] = [];
        for (let index = 0; index < 128 / size; index++)
          parts.push(
            lane(b.extract(left!, index * size, size), b.extract(right, index * size, size)),
          );
        this.writeXmm(dst, b.concat(parts));
      } else {
        const result = lane(left, right);
        this.writeLow(dst, result);
      }
      this.fpStatus();
      return;
    }
    const fp = /^(add|sub|mul|div)(ss|sd|ps|pd)$/.exec(m);
    const compare = /^(ucomi|comi)(ss|sd)$/.exec(m);
    if (fp || compare) {
      this.fpEnvironment();
      b = this.block;
      const suffix = (fp ?? compare)![2]!,
        width = suffix.endsWith('d') ? 64 : 32,
        scalar = suffix.startsWith('s');
      const type: DataType = scalar ? floating(width) : vector(floating(width), 128 / width);
      const left = b.cast('bitcast', type, this.read(dst!, scalar ? width : 128)),
        right = b.cast('bitcast', type, this.read(src!, scalar ? width : 128));
      if (compare) {
        const unordered = b.fpCompare('unordered', left, right);
        this.setFlag('zf', b.int('or', unordered, b.fpCompare('eq', left, right)));
        this.setFlag('pf', unordered);
        this.setFlag('cf', b.int('or', unordered, b.fpCompare('lt', left, right)));
        for (const name of ['of', 'sf', 'af'] as const) this.setFlag(name, this.c(1, 0n));
      } else {
        const op = fp![1] as 'add' | 'sub' | 'mul' | 'div',
          result = scalar ? b.fp(op, left, right) : b.vectorFloat(op, left, right);
        const raw = b.cast('bitcast', integer(scalar ? width : 128), result);
        if (scalar && dst?.kind === 'register')
          b.writeRegister(
            {
              ...dst.register,
              id: `${dst.register.id}:low${width}`,
              width_bits: width,
              write_rule: 'preserve_other_bits',
            },
            raw,
          );
        else this.write(dst!, raw);
      }
      this.fpStatus();
      return;
    }
    throw new Unsupported(`Instruction family ${m} (${p.encoding})`);
  }
}

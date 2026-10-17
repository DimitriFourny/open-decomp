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
export class Unsupported extends Error {}

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
        offset_bits: 6,
        width_bits: 10,
        write_rule: 'preserve_other_bits',
      });
    this.guard(
      b.compare('ne', state, this.c(10, 0x7en)),
      [],
      'Unsupported MXCSR environment (rounding, DAZ, FTZ or unmasked exception)',
      false,
    );
    this.abstractFP();
  }

  fpStatus(): void {
    this.block.writeRegister(
      {
        ...mxcsr,
        id: 'x86_64:mxcsr[0:6]',
        bank: 'flags',
        role: 'flags',
        width_bits: 6,
        write_rule: 'preserve_other_bits',
      },
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

  execute(): void {
    const p = this.p,
      m = p.mnemonic,
      operands = p.operands,
      dst = operands[0],
      src = operands[1];
    let b = this.block;
    if (
      p.privileged ||
      p.prefixes.lock ||
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
      if (dst?.kind === 'memory' || src?.kind === 'memory')
        throw new Unsupported('Atomic memory XCHG');
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

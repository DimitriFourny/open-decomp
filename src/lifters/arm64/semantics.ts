import type {
  Arm64Payload,
  CallClobbers,
  DecodedInstruction,
  RegisterDescriptor,
} from '../../core/index.js';
import {
  bitWidth,
  floatBits,
  floating,
  integer,
  vector,
  type BlockBuilder,
  type DataType,
  type IntegerOp,
  type Value,
} from '../../ir/index.js';

type Operand = Arm64Payload['operands'][number];
type RegisterOperand = Extract<Operand, { kind: 'register' }>;
export function gp(index: number, bits = 64, sp = false): RegisterDescriptor {
  const root = index === 31 ? (sp ? 'sp' : 'xzr') : `x${index}`;
  return {
    id: `arm64:${bits === 32 ? (root === 'sp' ? 'wsp' : root.replace('x', 'w')) : root}`,
    root: `arm64:${root}`,
    bank: 'integer',
    offset_bits: 0,
    width_bits: bits,
    root_width_bits: 64,
    role: index === 31 ? (sp ? 'stack_pointer' : 'zero') : 'general',
    write_rule: index === 31 && !sp ? 'discard' : bits === 32 ? 'zero_extend_root' : 'replace_root',
  };
}
function fpRegister(index: number, bits: 32 | 64): RegisterDescriptor {
  return {
    id: `arm64:${bits === 32 ? 's' : 'd'}${index}`,
    root: `arm64:v${index}`,
    bank: 'float',
    offset_bits: 0,
    width_bits: bits,
    root_width_bits: 128,
    role: 'general',
    write_rule: 'zero_extend_root',
  };
}
export function stateRegister(name: 'nzcv' | 'fpsr' | 'fpcr'): RegisterDescriptor {
  return {
    id: `arm64:${name}`,
    root: `arm64:${name}`,
    bank: name === 'fpcr' ? 'control' : 'flags',
    offset_bits: 0,
    width_bits: 32,
    root_width_bits: 32,
    role: name === 'fpcr' ? 'general' : 'flags',
    write_rule: 'replace_root',
  };
}
const vectorRoots: readonly RegisterDescriptor[] = Array.from(
  { length: 32 },
  (_, n): RegisterDescriptor => ({
    id: `arm64:v${n}`,
    root: `arm64:v${n}`,
    bank: 'vector',
    offset_bits: 0,
    width_bits: 128,
    root_width_bits: 128,
    role: 'general',
    write_rule: 'replace_root',
  }),
);
export const unknownClobbers: CallClobbers = {
  registers: [
    ...Array.from({ length: 31 }, (_, n) => gp(n)),
    gp(31, 64, true),
    ...vectorRoots,
    stateRegister('fpcr'),
  ],
  flags: [stateRegister('nzcv'), stateRegister('fpsr')],
  memory: 'unknown_read_write',
};
/**
 * ISA bound of an unlifted A64 "Data Processing - Scalar Floating-Point and
 * Advanced SIMD" or Cryptographic encoding, derived from its decoded class
 * (`asimd*`, `asisd*`, `float*`, `crypto*`; `asisdls*` are the SIMD loads and
 * stores): it accesses no memory, never names SP (register 31 is ZR), reads
 * FPCR without writing it, and writes only V registers, GP Rd in the
 * to-general forms, NZCV (FCMP/FCCMP) and FPSR. Forms that read a
 * general-purpose register (INS/DUP from general, the to-FP conversions and
 * moves) stay unbounded: the IR records no data dependence from an effect's
 * inputs to its outputs, so a frame address read from Rn could not be
 * followed. Bounded effects therefore read only V, FPCR, NZCV and FPSR.
 */
export function boundedUnknownClobbers(payload: Arm64Payload): CallClobbers | undefined {
  const parts = payload.canonical_encoding.split('_'),
    name = parts[0]!;
  const simd = parts
    .slice(1)
    .some(
      (part) =>
        (part.startsWith('asimd') ||
          part.startsWith('asisd') ||
          part.startsWith('float') ||
          part.startsWith('crypto')) &&
        !part.startsWith('asisdls'),
    );
  if (!simd) return undefined;
  const conversion = parts.includes('float2int') || parts.includes('float2fix'),
    opcode = payload.fields.opcode;
  // float2int/float2fix opcodes 010, 011 (SCVTF/UCVTF) and 111 (FMOV from
  // general) read Rn as a general-purpose register.
  if (conversion && (opcode === undefined || opcode === 2n || opcode === 3n || opcode === 7n))
    return undefined;
  if (
    payload.canonical_encoding === 'INS_asimdins_IR_r' ||
    payload.canonical_encoding === 'DUP_asimdins_DR_r'
  )
    return undefined;
  const registers: RegisterDescriptor[] = [...vectorRoots];
  if (conversion || ((name === 'UMOV' || name === 'SMOV') && parts.includes('asimdins'))) {
    const rd = payload.fields.Rd;
    if (rd === undefined || rd < 0n || rd > 31n) return undefined;
    if (rd !== 31n) registers.push(gp(Number(rd)));
  }
  return { registers, flags: [stateRegister('nzcv'), stateRegister('fpsr')], memory: 'none' };
}
const mask = (bits: number): bigint => (1n << BigInt(bits)) - 1n;
const rotate = (v: bigint, r: number, bits: number): bigint =>
  ((v >> BigInt(r)) | (v << BigInt(bits - r))) & mask(bits);
export const fpEnvironmentGuard = Object.freeze({
  control_root: 'arm64:fpcr',
  mask: (3n << 22n) | (1n << 24n) | (1n << 26n) | (1n << 19n) | 0x9f00n | 3n,
  unsupported_effect: 'Unsupported FPCR rounding, flush or trapping environment',
  unsupported_exit: 'Unsupported FPCR environment',
});
export function needsFpGuard(payload: Arm64Payload): boolean {
  return /^(FADD|FSUB|FMUL|FDIV|FSQRT|FCMP|FCMPE|FCCMP|FCCMPE|FCVT|FCVTZS|FCVTZU|SCVTF|UCVTF)(_|$)/.test(
    payload.canonical_encoding,
  );
}
/** Canonical encoding IDs and fields drive semantics; formatted assembly is never consulted. */
export class ArmSemantics {
  readonly name: string;
  readonly bits: number;
  constructor(
    readonly b: BlockBuilder,
    readonly instruction: DecodedInstruction,
    readonly p: Arm64Payload,
    readonly report: (message: string) => void,
  ) {
    this.name = p.canonical_encoding.split('_')[0]!;
    this.bits = p.fields.sf === 1n ? 64 : 32;
  }

  field(name: string): number {
    const value = this.p.fields[name];
    if (value === undefined || value < 0n || value > 0xffffffffn)
      throw new Unsupported(`Missing or invalid canonical field ${name}`);
    return Number(value);
  }

  constant(bits: number, value: bigint | number): Value {
    return this.b.constant(integer(bits), BigInt(value));
  }

  read(name: string, bits = this.bits, sp = false): Value {
    return this.b.readRegister(gp(this.field(name), bits, sp));
  }

  put(value: Value, bits = this.bits, sp = false): void {
    this.b.writeRegister(gp(this.field('Rd'), bits, sp), value);
  }

  resize(value: Value, bits: number, signed = false): Value {
    const width = bitWidth(value.type);
    return width === bits
      ? value
      : this.b.cast(
          width > bits ? 'truncate' : signed ? 'sign_extend' : 'zero_extend',
          integer(bits),
          value,
        );
  }

  shift(value: Value, kind: number, amount: number): Value {
    if (amount >= bitWidth(value.type)) throw new Unsupported('Reserved immediate shift');
    return amount === 0
      ? value
      : this.b.int(
          (['shl', 'lshr', 'ashr', 'ror'] as const)[kind]!,
          value,
          this.constant(bitWidth(value.type), amount),
        );
  }

  condition(code = this.field('cond')): Value {
    const f = this.b.readRegister(stateRegister('nzcv'));
    const n = this.b.extract(f, 31, 1),
      z = this.b.extract(f, 30, 1),
      c = this.b.extract(f, 29, 1),
      v = this.b.extract(f, 28, 1);
    let result: Value;
    switch (code >> 1) {
      case 0:
        result = z;
        break;
      case 1:
        result = c;
        break;
      case 2:
        result = n;
        break;
      case 3:
        result = v;
        break;
      case 4:
        result = this.b.int('and', c, this.b.unary('not', z));
        break;
      case 5:
        result = this.b.compare('eq', n, v);
        break;
      case 6:
        result = this.b.int('and', this.b.compare('eq', n, v), this.b.unary('not', z));
        break;
      default:
        return this.constant(1, 1);
    }
    return code & 1 ? this.b.unary('not', result) : result;
  }

  flags(values: readonly Value[]): void {
    let packed = this.constant(32, 0);
    values.forEach((value, i) => {
      packed = this.b.insert(packed, value, 31 - i);
    });
    this.b.writeRegister(stateRegister('nzcv'), packed);
  }

  arithmetic(
    a: Value,
    c: Value,
    subtract: boolean,
    carry: Value,
    flags: boolean,
    alternate?: { condition: Value; nzcv: number },
  ): Value {
    const op = subtract ? 'sub' : 'add';
    const result = this.b.int(op, this.b.int(op, a, c), this.resize(carry, bitWidth(a.type)));
    if (flags)
      this.flags(
        (['negative', 'zero', 'carry', 'overflow'] as const).map((flag, i) => {
          const value = this.b.flag(op, flag, a, c, carry);
          return alternate
            ? this.b.select(
                alternate.condition,
                value,
                this.constant(1, (alternate.nzcv >> (3 - i)) & 1),
              )
            : value;
        }),
      );
    return result;
  }

  transferCondition(): Value {
    if (this.name === 'CBZ' || this.name === 'CBNZ')
      return this.b.compare(
        this.name === 'CBZ' ? 'eq' : 'ne',
        this.read('Rt'),
        this.constant(this.bits, 0),
      );
    if (this.name === 'TBZ' || this.name === 'TBNZ')
      return this.b.compare(
        this.name === 'TBZ' ? 'eq' : 'ne',
        this.b.extract(this.read('Rt', 64), this.field('b5') * 32 + this.field('b40'), 1),
        this.constant(1, 0),
      );
    if (this.name === 'B') return this.condition();
    throw new Unsupported('Unsupported conditional transfer');
  }

  execute(): boolean {
    const { b, p, name, bits } = this;
    const encoding = p.canonical_encoding;
    // SQLite's observed initialization barrier is DMB ISH (d5033bbf).
    // Inspect canonical fields/word, never assembly text; other barriers remain unsupported.
    if (encoding === 'DMB_BO_barriers' && p.word === 0xd5033bbfn) {
      b.memoryFence();
      return true;
    }
    if (name === 'NOP' || p.behavior === 'nop') return true;
    if (/^(PAC|AUT|XPAC)/.test(name) && !name.startsWith('PACGA')) {
      let destination = p.fields.Rd === undefined ? 30 : this.field('Rd');
      if (/1716/.test(name)) destination = 17;
      if (name !== 'PACM') b.writeRegister(gp(destination), b.readRegister(gp(destination)));
      this.authentication();
      return true;
    }
    if (/^(ADD|ADDS|SUB|SUBS)$/.test(name) && /addsub_(imm|shift|ext)$/.test(encoding)) {
      const imm = encoding.endsWith('_imm'),
        ext = encoding.endsWith('_ext'),
        flags = name.endsWith('S');
      const a = this.read('Rn', bits, imm || ext);
      let c: Value;
      if (imm)
        c = this.constant(bits, BigInt(this.field('imm12')) << BigInt(this.field('sh') * 12));
      else if (ext) {
        const option = this.field('option'),
          width = [8, 16, 32, 64][option & 3]!;
        c = this.shift(
          this.resize(this.resize(this.read('Rm', 64), width), bits, (option & 4) !== 0),
          0,
          this.field('imm3'),
        );
      } else c = this.shift(this.read('Rm'), this.field('shift'), this.field('imm6'));
      this.put(
        this.arithmetic(a, c, name.startsWith('SUB'), this.constant(1, 0), flags),
        bits,
        !flags && (imm || ext),
      );
      return true;
    }
    if (/^(ADC|ADCS|SBC|SBCS)$/.test(name)) {
      const subtract = name.startsWith('SBC');
      const old = b.extract(b.readRegister(stateRegister('nzcv')), 29, 1);
      this.put(
        this.arithmetic(
          this.read('Rn'),
          this.read('Rm'),
          subtract,
          subtract ? b.unary('not', old) : old,
          name.endsWith('S'),
        ),
      );
      return true;
    }
    if (/^(AND|ANDS|ORR|ORN|EOR|EON|BIC|BICS)$/.test(name) && /log_(imm|shift)$/.test(encoding)) {
      const imm = encoding.endsWith('_imm');
      let c: Value;
      if (imm) {
        const n = this.field('N'),
          r = this.field('immr'),
          s = this.field('imms');
        const length = 31 - Math.clz32((n << 6) | (~s & 63)),
          size = 1 << length;
        if (length < 1 || size > bits || (s & (size - 1)) === size - 1)
          throw new Unsupported('Reserved logical immediate');
        const element = rotate(mask((s & (size - 1)) + 1), r & (size - 1), size);
        let value = 0n;
        for (let offset = 0; offset < bits; offset += size) value |= element << BigInt(offset);
        c = this.constant(bits, value);
      } else c = this.shift(this.read('Rm'), this.field('shift'), this.field('imm6'));
      if (['ORN', 'EON', 'BIC', 'BICS'].includes(name)) c = b.unary('not', c);
      const value = b.int(
        name.startsWith('OR') ? 'or' : name.startsWith('EO') ? 'xor' : 'and',
        this.read('Rn'),
        c,
      );
      if (name === 'ANDS' || name === 'BICS')
        this.flags([
          b.extract(value, bits - 1, 1),
          b.compare('eq', value, this.constant(bits, 0)),
          this.constant(1, 0),
          this.constant(1, 0),
        ]);
      this.put(value, bits, imm && name !== 'ANDS');
      return true;
    }
    if (/^MOV[ZNK]$/.test(name)) {
      const offset = this.field('hw') * 16,
        immediate = this.field('imm16');
      const value = this.constant(bits, BigInt(immediate) << BigInt(offset));
      this.put(
        name === 'MOVN'
          ? b.unary('not', value)
          : name === 'MOVK'
            ? b.insert(this.read('Rd'), this.constant(16, immediate), offset)
            : value,
      );
      return true;
    }
    if (['BFM', 'UBFM', 'SBFM'].includes(name)) {
      const r = this.field('immr'),
        s = this.field('imms'),
        w = rotate(mask(s + 1), r, bits),
        t = mask(((s - r) & (bits - 1)) + 1);
      const source = this.read('Rn');
      let bottom = b.int('and', this.shift(source, 3, r), this.constant(bits, w)),
        top = this.constant(bits, 0);
      if (name === 'BFM') {
        top = this.read('Rd');
        bottom = b.int('or', b.int('and', top, this.constant(bits, mask(bits) ^ w)), bottom);
      }
      if (name === 'SBFM')
        top = b.select(b.extract(source, s, 1), this.constant(bits, mask(bits)), top);
      this.put(
        b.int(
          'or',
          b.int('and', top, this.constant(bits, mask(bits) ^ t)),
          b.int('and', bottom, this.constant(bits, t)),
        ),
      );
      return true;
    }
    if (name === 'EXTR') {
      const amount = this.field('imms'),
        low = this.read('Rm');
      this.put(
        amount === 0
          ? low
          : b.int('or', this.shift(low, 1, amount), this.shift(this.read('Rn'), 0, bits - amount)),
      );
      return true;
    }
    if (['LSLV', 'LSRV', 'ASRV', 'RORV', 'UDIV', 'SDIV'].includes(name)) {
      const a = this.read('Rn'),
        c = this.read('Rm');
      if (name.endsWith('DIV')) {
        // Widen signed division so MIN/-1 is defined, then truncate the wrapped result.
        const wide = bits * 2,
          signed = name === 'SDIV';
        const safe = b.select(
          b.compare('eq', c, this.constant(bits, 0)),
          this.constant(bits, 1),
          c,
        );
        const result = this.resize(
          b.int(
            signed ? 'sdiv' : 'udiv',
            this.resize(a, wide, signed),
            this.resize(safe, wide, signed),
          ),
          bits,
        );
        this.put(
          b.select(b.compare('eq', c, this.constant(bits, 0)), this.constant(bits, 0), result),
        );
      } else {
        const op = ({ LSLV: 'shl', LSRV: 'lshr', ASRV: 'ashr', RORV: 'ror' } as const)[
          name as 'LSLV'
        ];
        this.put(b.int(op, a, b.int('and', c, this.constant(bits, bits - 1))));
      }
      return true;
    }
    if (['MADD', 'MSUB', 'SMADDL', 'SMSUBL', 'UMADDL', 'UMSUBL'].includes(name)) {
      const long = name.endsWith('L'),
        width = long ? 64 : bits;
      const a = this.resize(this.read('Rn', long ? 32 : bits), width, name.startsWith('S'));
      const c = this.resize(this.read('Rm', long ? 32 : bits), width, name.startsWith('S'));
      this.put(
        b.int(name.includes('SUB') ? 'sub' : 'add', this.read('Ra', width), b.int('mul', a, c)),
        width,
      );
      return true;
    }
    if (name === 'SMULH' || name === 'UMULH') {
      const signed = name === 'SMULH';
      this.put(
        b.extract(
          b.int(
            'mul',
            this.resize(this.read('Rn', 64), 128, signed),
            this.resize(this.read('Rm', 64), 128, signed),
          ),
          64,
          64,
        ),
        64,
      );
      return true;
    }
    if (['CSEL', 'CSINC', 'CSINV', 'CSNEG'].includes(name)) {
      let alternative = this.read('Rm');
      if (name === 'CSINC') alternative = b.int('add', alternative, this.constant(bits, 1));
      if (name === 'CSINV') alternative = b.unary('not', alternative);
      if (name === 'CSNEG') alternative = b.unary('neg', alternative);
      this.put(b.select(this.condition(), this.read('Rn'), alternative));
      return true;
    }
    if (name === 'CCMP' || name === 'CCMN') {
      const alternate = { condition: this.condition(), nzcv: this.field('nzcv') };
      const c = encoding.endsWith('_imm')
        ? this.constant(bits, this.field('imm5'))
        : this.read('Rm');
      this.arithmetic(this.read('Rn'), c, name === 'CCMP', this.constant(1, 0), true, alternate);
      return true;
    }
    if (['CLZ', 'CLS', 'RBIT', 'REV16', 'REV32', 'REV'].includes(name)) {
      let value = this.read('Rn');
      if (name === 'CLS')
        value = b.int(
          'xor',
          value,
          b.select(
            b.extract(value, bits - 1, 1),
            this.constant(bits, mask(bits)),
            this.constant(bits, 0),
          ),
        );
      if (name === 'CLZ' || name === 'CLS') {
        value = b.unary('clz', value);
        if (name === 'CLS') value = b.int('sub', value, this.constant(bits, 1));
      } else {
        const max = name === 'REV16' ? 8 : name === 'REV32' ? 16 : bits / 2;
        for (let step = name === 'RBIT' ? 1 : 8; step <= max; step *= 2) {
          let low = 0n;
          for (let offset = 0; offset < bits; offset += 2 * step)
            low |= mask(step) << BigInt(offset);
          value = b.int(
            'or',
            this.shift(b.int('and', value, this.constant(bits, low)), 0, step),
            b.int('and', this.shift(value, 1, step), this.constant(bits, low)),
          );
        }
      }
      this.put(value);
      return true;
    }
    if (name === 'ADR' || name === 'ADRP') {
      const offset = BigInt.asIntN(
        21,
        (BigInt(this.field('immhi')) << 2n) | BigInt(this.field('immlo')),
      );
      const pc = this.instruction.address.value;
      this.put(
        b.address({
          ...this.instruction.address,
          value: BigInt.asUintN(
            64,
            name === 'ADRP' ? (pc & ~4095n) + (offset << 12n) : pc + offset,
          ),
        }),
        64,
      );
      return true;
    }
    if (this.memory() || this.laneMemory()) return true;
    return this.simd();
  }

  /** A canonical-field vector register: the full root, or its low 64 bits with the high half cleared. */
  vectorRegister(index: number, width: 64 | 128): RegisterDescriptor {
    return {
      id: width === 128 ? `arm64:v${index}` : `arm64:v${index}[0:64]`,
      root: `arm64:v${index}`,
      bank: 'vector',
      offset_bits: 0,
      width_bits: width,
      root_width_bits: 128,
      role: 'general',
      write_rule: width === 128 ? 'replace_root' : 'zero_extend_root',
    };
  }

  authentication(): void {
    this.report(
      'Pointer authentication is abstracted to logical pointers: PAC bits, key/modifier checks, failure poisoning and authentication traps are not modeled.',
    );
  }

  /**
   * ST1/LD1 single structure, one lane (`asisdlso`, `asisdlsop`). The decoder
   * supplies these operands as opaque text, so the canonical fields define
   * everything: element size and lane index from opcode/size/S/Q, the base
   * (SP for Rn=31), and for the post-indexed form the writeback amount, the
   * element size in bytes for Rm=31 or X[Rm]. ST1 stores the little-endian lane
   * of V[Rt]; LD1 replaces only that lane. Multi-register forms (`asisdlse`,
   * `asisdlsep`) and the replicating LD1R are not matched.
   */
  laneMemory(): boolean {
    const { b, p, name } = this;
    const match = /^(ST1|LD1)_asisdlso(p?)_[BHSD]X?1_/.exec(p.canonical_encoding);
    if (!match || name !== match[1]) return false;
    const post = match[2] === 'p',
      load = name === 'LD1';
    if (this.field('R') !== 0) throw new Unsupported('Unrecognized single-lane SIMD form');
    const opcode = this.field('opcode'),
      size = this.field('size'),
      s = this.field('S'),
      q = this.field('Q');
    let esize: number, index: number;
    if (opcode === 0) {
      esize = 8;
      index = (q << 3) | (s << 2) | size;
    } else if (opcode === 2 && (size & 1) === 0) {
      esize = 16;
      index = (q << 2) | (s << 1) | (size >> 1);
    } else if (opcode === 4 && size === 0) {
      esize = 32;
      index = (q << 1) | s;
    } else if (opcode === 4 && size === 1 && s === 0) {
      esize = 64;
      index = q;
    } else throw new Unsupported('Reserved single-lane SIMD element size');
    const vector = this.vectorRegister(this.field('Rt'), 128),
      baseRegister = gp(this.field('Rn'), 64, true),
      base = b.readRegister(baseRegister);
    // Read X[Rm] before any write; Rm=31 selects the immediate increment.
    let step: Value | null = null;
    if (post) {
      const rm = this.field('Rm');
      step = rm === 31 ? this.constant(64, esize / 8) : b.readRegister(gp(rm, 64));
    }
    if (load) {
      const element = b.load(integer(esize), base);
      b.writeRegister(
        vector,
        b.insert(b.readRegister(vector, integer(128)), element, index * esize),
      );
    } else b.store(base, b.extract(b.readRegister(vector, integer(128)), index * esize, esize));
    if (step) b.writeRegister(baseRegister, b.int('add', base, step));
    return true;
  }

  memory(): boolean {
    const { b, p, name } = this;
    if (
      !/^(LDR|STR|LDUR|STUR|LDP|STP|LDNP|STNP|LDPSW)(B|H|SB|SH|SW)?$/.test(name) &&
      name !== 'LDRAA' &&
      name !== 'LDRAB'
    )
      return false;
    if (name === 'LDRAA' || name === 'LDRAB') this.authentication();
    const memory = p.operands.find((o) => o.kind === 'memory' || o.kind === 'relative');
    const regs = p.operands.filter((o): o is RegisterOperand => o.kind === 'register');
    const pair = /^(LDP|STP|LDNP|STNP)/.test(name);
    if (!memory || regs.length !== (pair ? 2 : 1))
      throw new Unsupported('Unrecognized ordinary memory operands');
    const load = name.startsWith('LD'),
      signed = /^(LDRS|LDURS|LDPSW)/.test(name);
    const width =
      memory.kind === 'memory'
        ? memory.access_bits / regs.length
        : /SW$/.test(name)
          ? 32
          : regs[0]!.register.width_bits;
    if (!Number.isInteger(width) || width < 8) throw new Unsupported('Unknown memory access width');
    if (load && pair && regs[0]!.register.root === regs[1]!.register.root)
      throw new Unsupported('Constrained-unpredictable pair destination overlap');
    if (
      memory.kind === 'memory' &&
      memory.writeback !== 'none' &&
      memory.base.role !== 'stack_pointer' &&
      regs.some((o) => o.register.root === memory.base.root)
    )
      throw new Unsupported('Constrained-unpredictable writeback overlap');
    let address: Value,
      writeback: Value | null = null;
    if (memory.kind === 'relative') address = b.address(memory.target);
    else if (memory.kind === 'memory') {
      const base = b.readRegister(memory.base);
      let offset = this.constant(64, memory.displacement);
      if (memory.index) {
        let index = b.readRegister(memory.index);
        if (memory.extend === 'uxtw' || memory.extend === 'sxtw') index = this.resize(index, 32);
        index = this.resize(index, 64, memory.extend === 'sxtw' || memory.extend === 'sxtx');
        offset = b.int('add', offset, this.shift(index, 0, memory.shift));
      }
      const adjusted = b.int('add', base, offset);
      address = memory.writeback === 'post' ? base : adjusted;
      if (memory.writeback !== 'none') writeback = adjusted;
    } else throw new Unsupported('Unsupported memory address');
    const values = regs.map((operand, i) => {
      const location =
        i === 0 ? address : b.int('add', address, this.constant(64, (i * width) / 8));
      if (load)
        return this.resize(b.load(integer(width), location), operand.register.width_bits, signed);
      const value = this.resize(b.readRegister(operand.register), width);
      b.store(location, value);
      return value;
    });
    if (load) regs.forEach((operand, i) => b.writeRegister(operand.register, values[i]!));
    if (writeback && memory.kind === 'memory') b.writeRegister(memory.base, writeback);
    return true;
  }

  simd(): boolean {
    const { b, p, name, bits } = this;
    // These decoder families retain canonical fields even when one displayed
    // operand is opaque. Do not parse that text or infer its register identity.
    if (/^FMOV_(S32|32S|D64|64D)_float2int$/.test(p.canonical_encoding)) {
      const width = this.bits as 32 | 64,
        toFloat = (this.field('opcode') & 1) !== 0;
      const source = toFloat ? gp(this.field('Rn'), width) : fpRegister(this.field('Rn'), width);
      const target = toFloat ? fpRegister(this.field('Rd'), width) : gp(this.field('Rd'), width);
      b.writeRegister(target, b.readRegister(source));
      return true;
    }
    if (name === 'FCVT' && p.canonical_encoding.endsWith('_floatdp1')) {
      const sourceType = this.field('ftype'),
        targetType = this.field('opc');
      if (sourceType > 1 || targetType > 1 || sourceType === targetType)
        throw new Unsupported('Only distinct FP32/FP64 precision conversion is modeled');
      const from = sourceType === 1 ? 64 : 32,
        to = targetType === 1 ? 64 : 32;
      b.writeRegister(
        fpRegister(this.field('Rd'), to),
        b.cast(
          'float_convert',
          floating(to),
          b.readRegister(fpRegister(this.field('Rn'), from), floating(from)),
        ),
      );
      this.fpStatus();
      return true;
    }
    if (
      p.canonical_encoding === 'SCVTF_asisdmisc_R' ||
      p.canonical_encoding === 'UCVTF_asisdmisc_R'
    ) {
      const size = this.field('sz');
      if (size > 1) throw new Unsupported('Invalid SIMD scalar integer conversion width');
      const width = size === 1 ? 64 : 32;
      b.writeRegister(
        fpRegister(this.field('Rd'), width),
        b.cast(
          name === 'SCVTF' ? 'signed_to_float' : 'unsigned_to_float',
          floating(width),
          b.readRegister(fpRegister(this.field('Rn'), width), integer(width)),
        ),
      );
      // Scalar SIMD writes clear the rest of Vd, preserve NZCV, and retain
      // the existing guarded FPCR / explicitly unknown FPSR contract.
      this.fpStatus();
      return true;
    }
    if ((name === 'SCVTF' || name === 'UCVTF') && p.canonical_encoding.endsWith('_float2int')) {
      const ftype = this.field('ftype');
      if (ftype > 1) throw new Unsupported('FP16 integer conversion is not modeled');
      const width = ftype === 1 ? 64 : 32;
      b.writeRegister(
        fpRegister(this.field('Rd'), width),
        b.cast(
          name === 'SCVTF' ? 'signed_to_float' : 'unsigned_to_float',
          floating(width),
          this.read('Rn'),
        ),
      );
      this.fpStatus();
      return true;
    }
    if ((name === 'FCVTZS' || name === 'FCVTZU') && p.canonical_encoding.endsWith('_float2int')) {
      // Round toward zero regardless of FPCR.RMode; NaN converts to zero and
      // out-of-range values saturate (unlike the IR's C-style float_to_* cast,
      // which is undefined there, so that cast only feeds the in-range arm).
      const ftype = this.field('ftype');
      if (ftype > 1) throw new Unsupported('FP16 integer conversion is not modeled');
      const from = ftype === 1 ? 64 : 32,
        signed = name === 'FCVTZS';
      const source = b.readRegister(fpRegister(this.field('Rn'), from), floating(from));
      const limit = (value: number): Value => b.constant(floating(from), floatBits(value, from));
      const high = 2 ** (signed ? bits - 1 : bits);
      const top = this.constant(bits, signed ? mask(bits - 1) : mask(bits));
      const converted = b.cast(
        signed ? 'float_to_signed' : 'float_to_unsigned',
        integer(bits),
        source,
      );
      const inRange = signed
        ? b.select(
            b.fpCompare('lt', source, limit(-high)),
            this.constant(bits, 1n << BigInt(bits - 1)),
            b.select(b.fpCompare('unordered', source, source), this.constant(bits, 0), converted),
          )
        : b.select(b.fpCompare('gt', source, limit(0)), converted, this.constant(bits, 0));
      this.put(b.select(b.fpCompare('ge', source, limit(high)), top, inRange));
      this.fpStatus();
      return true;
    }
    if ((name === 'SCVTF' || name === 'UCVTF') && p.canonical_encoding.endsWith('_float2fix')) {
      // The integer rounds once (FPCR is guarded to nearest-even) and the power-of-two
      // scale 2^-fbits is exact: no FP32/FP64 result of a 32/64-bit input is subnormal.
      const ftype = this.field('ftype'),
        fbits = 64 - this.field('scale');
      if (ftype > 1) throw new Unsupported('FP16 fixed-point conversion is not modeled');
      if (fbits < 1 || fbits > bits) throw new Unsupported('Reserved fixed-point fraction width');
      const width = ftype === 1 ? 64 : 32;
      const converted = b.cast(
        name === 'SCVTF' ? 'signed_to_float' : 'unsigned_to_float',
        floating(width),
        this.read('Rn'),
      );
      b.writeRegister(
        fpRegister(this.field('Rd'), width),
        b.fp('mul', converted, b.constant(floating(width), floatBits(2 ** -fbits, width))),
      );
      this.fpStatus();
      return true;
    }
    if (
      p.canonical_encoding === 'ORR_asimdsame_only' ||
      p.canonical_encoding === 'AND_asimdsame_only'
    ) {
      // MOV is an ORR alias with Rn == Rm. Its displayed operands may be
      // opaque, but canonical fields still define the complete bitwise operation.
      const q = this.field('Q');
      if (q > 1) throw new Unsupported('Invalid SIMD logical register width');
      const width = q === 1 ? 128 : 64;
      const destination = this.vectorRegister(this.field('Rd'), width),
        first = this.vectorRegister(this.field('Rn'), width),
        second = this.vectorRegister(this.field('Rm'), width);
      const left = b.readRegister(first, integer(width));
      const value =
        name === 'ORR' && first.root === second.root
          ? left
          : b.int(name === 'ORR' ? 'or' : 'and', left, b.readRegister(second, integer(width)));
      b.writeRegister(destination, value);
      return true;
    }
    if (p.canonical_encoding === 'CMEQ_asimdsame_only') {
      // Per-lane equality mask: all ones when the lanes are equal, else zero.
      const q = this.field('Q'),
        size = this.field('size');
      if (q > 1 || size > 3 || (q === 0 && size === 3))
        throw new Unsupported('Reserved SIMD CMEQ arrangement');
      const width = q === 1 ? 128 : 64,
        lane = 8 << size,
        type = vector(integer(lane), width / lane);
      const left = b.readRegister(this.vectorRegister(this.field('Rn'), width), type),
        right = b.readRegister(this.vectorRegister(this.field('Rm'), width), type);
      b.writeRegister(
        this.vectorRegister(this.field('Rd'), width),
        b.pack(
          type,
          Array.from({ length: type.lanes }, (_, index) =>
            b.cast(
              'sign_extend',
              integer(lane),
              b.compare('eq', b.lane(left, index), b.lane(right, index)),
            ),
          ),
        ),
      );
      return true;
    }
    if (p.canonical_encoding === 'DUP_asimdins_DR_r') {
      // Broadcast the low element-size bits of a general register. The element
      // size is the position of the lowest set bit of imm5.
      const q = this.field('Q'),
        imm5 = this.field('imm5');
      const size = imm5 & 15 ? 31 - Math.clz32(imm5 & -imm5) : -1;
      if (q > 1 || size < 0 || size > 3 || (q === 0 && size === 3))
        throw new Unsupported('Reserved SIMD DUP arrangement');
      const width = q === 1 ? 128 : 64,
        lane = 8 << size;
      const source = this.resize(b.readRegister(gp(this.field('Rn'), lane === 64 ? 64 : 32)), lane);
      b.writeRegister(
        this.vectorRegister(this.field('Rd'), width),
        b.pack(
          vector(integer(lane), width / lane),
          Array.from({ length: width / lane }, () => source),
        ),
      );
      return true;
    }
    if (p.canonical_encoding === 'INS_asimdins_IR_r') {
      // Insert the low element-size bits of a general register into one lane;
      // every other bit of the 128-bit register is kept. The element size is
      // the position of the lowest set bit of imm5, the lane index the bits
      // above it.
      const imm5 = this.field('imm5');
      const size = imm5 & 15 ? 31 - Math.clz32(imm5 & -imm5) : -1;
      if (size < 0 || size > 3) throw new Unsupported('Reserved SIMD INS arrangement');
      const index = imm5 >> (size + 1),
        lane = 8 << size;
      const destination = this.vectorRegister(this.field('Rd'), 128);
      const source = this.resize(b.readRegister(gp(this.field('Rn'), lane === 64 ? 64 : 32)), lane);
      b.writeRegister(
        destination,
        b.insert(b.readRegister(destination, integer(128)), source, index * lane),
      );
      return true;
    }
    const regs = p.operands.filter((o): o is RegisterOperand => o.kind === 'register');
    const destination = regs[0];
    if (!destination) return false;
    const arranged =
      destination.arrangement !== null && /^\d+[bhsd]$/.test(destination.arrangement);
    const simd = destination.register.bank === 'float' || destination.register.bank === 'vector';
    const typeFor = (operand: RegisterOperand, fp: boolean): DataType => {
      if (operand.arrangement && /^\d+[bhsd]$/.test(operand.arrangement)) {
        const lanes = Number.parseInt(operand.arrangement),
          width = operand.register.width_bits / lanes;
        if (fp && width !== 32 && width !== 64)
          throw new Unsupported('FP16 is outside the modeled FP environment');
        return vector(fp ? floating(width as 32 | 64) : integer(width), lanes);
      }
      const width = operand.register.width_bits;
      if (fp && width !== 32 && width !== 64)
        throw new Unsupported('Only FP32/FP64 scalar arithmetic is modeled');
      return fp ? floating(width as 32 | 64) : integer(width);
    };
    const read = (index: number, fp: boolean): Value => {
      const operand = regs[index];
      if (!operand) throw new Unsupported('Missing SIMD operand');
      if (operand.lane !== null)
        throw new Unsupported('Lane-indexed SIMD operation is not modeled');
      return b.readRegister(operand.register, typeFor(operand, fp));
    };
    if (name === 'MOVI' && arranged) {
      const immediate = p.operands.find((o) => o.kind === 'immediate');
      if (!immediate) throw new Unsupported('Unsupported vector immediate form');
      const type = typeFor(destination, false);
      if (type.kind !== 'vector') return false;
      const modifier = p.operands.find((o) => o.kind === 'modifier');
      if (modifier && modifier.operation !== 'lsl')
        throw new Unsupported('Unsupported vector immediate modifier');
      const lane = b.constant(type.element, immediate.value << BigInt(modifier?.amount ?? 0));
      b.writeRegister(
        destination.register,
        b.pack(
          type,
          Array.from({ length: type.lanes }, () => lane),
        ),
      );
      return true;
    }
    if (simd && arranged && ['ADD', 'SUB', 'MUL', 'AND', 'ORR', 'EOR', 'BIC'].includes(name)) {
      const op: IntegerOp =
        name === 'ADD'
          ? 'add'
          : name === 'SUB'
            ? 'sub'
            : name === 'MUL'
              ? 'mul'
              : name === 'ORR'
                ? 'or'
                : name === 'EOR'
                  ? 'xor'
                  : 'and';
      const left = read(1, false),
        right = read(2, false);
      // Bitwise operations operate on the whole register and need no lane typing.
      const value = ['AND', 'ORR', 'EOR', 'BIC'].includes(name)
        ? b.int(
            op,
            b.cast('bitcast', integer(destination.register.width_bits), left),
            name === 'BIC'
              ? b.unary('not', b.cast('bitcast', integer(destination.register.width_bits), right))
              : b.cast('bitcast', integer(destination.register.width_bits), right),
          )
        : b.vectorInt(op, left, right);
      b.writeRegister(destination.register, value);
      return true;
    }
    if (name === 'FMOV') {
      const immediate = p.operands.find((o) => o.kind === 'floating_immediate');
      if (immediate) {
        const width = destination.register.width_bits;
        if (width !== 32 && width !== 64) throw new Unsupported('Unsupported FP immediate width');
        const bytes = new DataView(new ArrayBuffer(8));
        if (width === 32) bytes.setFloat32(0, immediate.value, true);
        else bytes.setFloat64(0, immediate.value, true);
        b.writeRegister(
          destination.register,
          this.constant(
            width,
            width === 32 ? BigInt(bytes.getUint32(0, true)) : bytes.getBigUint64(0, true),
          ),
        );
        return true;
      }
      if (
        regs.length === 2 &&
        regs[1]!.register.width_bits === destination.register.width_bits &&
        regs.every((o) => o.lane === null)
      ) {
        b.writeRegister(destination.register, b.readRegister(regs[1]!.register));
        return true;
      }
      return false;
    }
    if (simd && ['FADD', 'FSUB', 'FMUL', 'FDIV'].includes(name)) {
      const op = ({ FADD: 'add', FSUB: 'sub', FMUL: 'mul', FDIV: 'div' } as const)[name as 'FADD'];
      const a = read(1, true),
        c = read(2, true);
      b.writeRegister(destination.register, arranged ? b.vectorFloat(op, a, c) : b.fp(op, a, c));
      this.fpStatus();
      return true;
    }
    if (simd && !arranged && ['FNEG', 'FABS', 'FSQRT'].includes(name)) {
      const source = read(1, true);
      b.writeRegister(
        destination.register,
        b.assign(source.type, {
          kind: 'float_unary',
          op: name === 'FNEG' ? 'neg' : name === 'FABS' ? 'abs' : 'sqrt',
          value: source,
        }),
      );
      if (name === 'FSQRT') this.fpStatus();
      return true;
    }
    if (name === 'FCMP' || name === 'FCMPE') {
      const a = read(0, true),
        c = regs.length > 1 ? read(1, true) : b.constant(a.type, 0n);
      const unordered = b.fpCompare('unordered', a, c),
        less = b.fpCompare('lt', a, c),
        equal = b.fpCompare('eq', a, c);
      this.flags([less, equal, b.unary('not', less), unordered]);
      this.fpStatus();
      return true;
    }
    if (name === 'FCSEL') {
      b.writeRegister(
        destination.register,
        b.select(this.condition(), read(1, true), read(2, true)),
      );
      return true;
    }
    return false;
  }

  fpStatus(): void {
    this.b.writeRegister(
      stateRegister('fpsr'),
      this.b.indeterminate(
        integer(32),
        'unknown',
        'Floating exception/status accumulation is not modeled',
      ),
    );
    this.report(
      'FP arithmetic requires nearest-even, gradual underflow and disabled exception traps; arithmetic NaNs are canonicalized and FPSR status is unknown.',
    );
  }
}
export class Unsupported extends Error {}

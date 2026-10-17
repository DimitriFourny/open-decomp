import type { Address, Arm64Payload, RegisterDescriptor } from '../../core/index.js';
import type {
  DecodedInstruction as NativeInstruction,
  Operand,
  RegisterName,
  SimdRegisterOperand,
} from '../../../vendor/a64js/src/types.js';

export type ArmOperand = Arm64Payload['operands'][number];
const elementBits = { b: 8, h: 16, s: 32, d: 64, q: 128 } as const;
const elementByBits: Readonly<Record<number, string>> = {
  8: 'b',
  16: 'h',
  32: 's',
  64: 'd',
  128: 'q',
};

export function gpRegister(
  index: number,
  width: 32 | 64,
  zeroName: 'sp' | 'zr' = 'zr',
): RegisterDescriptor {
  const role = index === 31 ? (zeroName === 'sp' ? 'stack_pointer' : 'zero') : 'general';
  const root = index === 31 ? (zeroName === 'sp' ? 'sp' : 'xzr') : `x${index}`;
  return {
    id: `arm64:${width === 32 ? (root === 'sp' ? 'wsp' : root.replace(/^x/, 'w')) : root}`,
    bank: 'integer',
    root: `arm64:${root}`,
    offset_bits: 0,
    width_bits: width,
    root_width_bits: 64,
    role,
    write_rule: role === 'zero' ? 'discard' : width === 32 ? 'zero_extend_root' : 'replace_root',
  };
}
function simdRegister(index: number, width: number, scalar: boolean): RegisterDescriptor {
  return {
    id: `arm64:${scalar ? (elementByBits[width] ?? 'v') : 'v'}${index}`,
    bank: scalar && width < 128 ? 'float' : 'vector',
    root: `arm64:v${index}`,
    offset_bits: 0,
    width_bits: width,
    root_width_bits: 128,
    role: 'general',
    write_rule: width === 128 ? 'replace_root' : 'zero_extend_root',
  };
}
function regOperand(
  register: RegisterDescriptor,
  arrangement: string | null = null,
  lane: number | null = null,
): ArmOperand {
  return { kind: 'register', register, access: 'unknown', arrangement, lane };
}
function simd(operand: SimdRegisterOperand): ArmOperand {
  if (operand.scalar)
    return regOperand(simdRegister(operand.index, elementBits[operand.scalar], true));
  if (operand.arrangement) {
    const { lanes, element } = operand.arrangement;
    return regOperand(
      simdRegister(operand.index, lanes * elementBits[element], false),
      `${lanes}${element}`,
      operand.laneIndex ?? null,
    );
  }
  return regOperand(
    simdRegister(operand.index, 128, false),
    operand.element ?? null,
    operand.laneIndex ?? null,
  );
}
export function relativeAddress(pc: Address, offset: bigint, pageRelative = false): Address {
  return {
    ...pc,
    value: BigInt.asUintN(64, (pageRelative ? pc.value & ~0xfffn : pc.value) + offset),
  };
}
function memoryBits(decoded: NativeInstruction): number {
  const fields = decoded.fields ?? {};
  const file = decoded.encoding?.canonicalFileName ?? decoded.encoding?.fileName ?? '';
  if (file === 'ldpsw.xml') return 64; // Two 32-bit memory elements.
  if (file.includes('fpsimd')) {
    const single =
      fields.size !== undefined
        ? 8 << fields.size
        : fields.opc === 2
          ? 128
          : fields.opc === 1
            ? 64
            : 32;
    const bits = fields.size === 0 && ((fields.opc ?? 0) & 2) !== 0 ? 128 : single;
    return /^(ldp|stp|ldnp|stnp)/.test(file) ? bits * 2 : bits;
  }
  if (fields.imm7 !== undefined) return fields.opc === 2 ? 128 : 64;
  return fields.size !== undefined && /^(ldr|str|ldur|stur|ldtr|sttr)/.test(file)
    ? 8 << fields.size
    : 0;
}
function nativeOperand(operand: Operand, decoded: NativeInstruction, pc: Address): ArmOperand[] {
  switch (operand.kind) {
    case 'reg':
      return [regOperand(gpRegister(operand.index, operand.width, operand.zeroName))];
    case 'simd':
      return [simd(operand)];
    case 'imm':
      return [
        { kind: 'immediate', value: operand.value, width_bits: decoded.fields?.sf === 0 ? 32 : 64 },
        ...(operand.shift
          ? [{ kind: 'modifier' as const, operation: 'lsl' as const, amount: operand.shift }]
          : []),
      ];
    case 'label':
      return [
        {
          kind: 'relative',
          displacement: operand.offset,
          target:
            operand.absolute === undefined
              ? relativeAddress(pc, operand.offset, operand.pageRelative)
              : { ...pc, value: BigInt.asUintN(64, operand.absolute) },
        },
      ];
    case 'cond':
      return [{ kind: 'condition', code: operand.code }];
    case 'sysreg':
      return [
        {
          kind: 'system',
          op0: operand.op0,
          op1: operand.op1,
          crn: operand.CRn,
          crm: operand.CRm,
          op2: operand.op2,
        },
      ];
    case 'fpimm':
      return [{ kind: 'floating_immediate', value: operand.value }];
    case 'text':
      return [{ kind: 'opaque', text: operand.text }];
    case 'vec':
      return [
        {
          kind: 'scalable_register',
          bank: 'vector',
          index: operand.index,
          element: operand.lane ?? null,
          mode: null,
        },
      ];
    case 'pred':
      return [
        {
          kind: 'scalable_register',
          bank: 'predicate',
          index: operand.index,
          element: operand.lane ?? null,
          mode: operand.mode ?? null,
        },
      ];
    case 'vector-group':
      return [
        {
          kind: 'vector_group',
          registers: operand.registers.map((register) => ({
            kind: 'scalable_register' as const,
            bank: 'vector' as const,
            index: register.index,
            element: register.lane ?? null,
            mode: null,
          })),
          style: operand.style,
        },
      ];
    case 'za':
      return [
        {
          kind: 'za',
          element: operand.lane,
          index: operand.index ?? null,
          selector: operand.slice?.selector ?? null,
          offset: operand.slice?.offset ?? null,
          end: operand.slice?.end ?? null,
          group: operand.slice?.group ?? null,
        },
      ];
    case 'mem': {
      const extend = operand.modifier?.kind ?? 'none';
      if (
        operand.base.kind !== 'reg' ||
        operand.offset?.kind === 'vec' ||
        (extend !== 'none' &&
          extend !== 'uxtw' &&
          extend !== 'sxtw' &&
          extend !== 'sxtx' &&
          extend !== 'lsl')
      ) {
        const addressRegister = (
          register: RegisterName | Extract<Operand, { kind: 'vec' }>,
        ): RegisterDescriptor | Extract<ArmOperand, { kind: 'scalable_register' }> =>
          register.kind === 'reg'
            ? gpRegister(register.index, register.width, register.zeroName)
            : {
                kind: 'scalable_register',
                bank: 'vector',
                index: register.index,
                element: register.lane ?? null,
                mode: null,
              };
        return [
          {
            kind: 'scalable_memory',
            base: addressRegister(operand.base),
            index:
              operand.offset && operand.offset.kind !== 'imm'
                ? addressRegister(operand.offset)
                : null,
            displacement: operand.offset?.kind === 'imm' ? operand.offset.value : 0n,
            modifier: operand.modifier?.kind ?? null,
            shift: operand.modifier?.amount ?? 0,
            writeback:
              operand.mode === 'pre-index'
                ? 'pre'
                : operand.mode === 'post-index'
                  ? 'post'
                  : 'none',
          },
        ];
      }
      const mnemonic = decoded.mnemonic ?? '';
      return [
        {
          kind: 'memory',
          base: gpRegister(operand.base.index, operand.base.width, operand.base.zeroName),
          index:
            operand.offset?.kind === 'reg'
              ? gpRegister(operand.offset.index, operand.offset.width, operand.offset.zeroName)
              : null,
          displacement: operand.offset?.kind === 'imm' ? operand.offset.value : 0n,
          extend,
          shift: operand.modifier?.amount ?? 0,
          writeback:
            operand.mode === 'pre-index' ? 'pre' : operand.mode === 'post-index' ? 'post' : 'none',
          access_bits: memoryBits(decoded),
          access: /^LD(R|UR|P|NP|TR)/.test(mnemonic)
            ? 'read'
            : /^ST(R|UR|P|NP|TR)/.test(mnemonic)
              ? 'write'
              : 'unknown',
        },
      ];
    }
  }
}

/** Replace upstream text-only common families from encoded fields, never from assembly text. */
export function structuredOperands(decoded: NativeInstruction, pc: Address): ArmOperand[] {
  if (decoded.status !== 'ok') return [];
  const fields = decoded.fields ?? {};
  const family = decoded.encoding?.operandFamilyId;
  const native = decoded.operands ?? [];
  const scalar = (field: string): ArmOperand =>
    regOperand(
      simdRegister(
        fields[field] ?? 0,
        fields.ftype === 1 ? 64 : fields.ftype === 3 ? 16 : 32,
        true,
      ),
    );
  if (family === 'scalar-fp-binary') return [scalar('Rd'), scalar('Rn'), scalar('Rm')];
  if (family === 'scalar-fp-ternary')
    return [scalar('Rd'), scalar('Rn'), scalar('Rm'), scalar('Ra')];
  if (family === 'scalar-fp-unary') return [scalar('Rd'), scalar('Rn')];
  if (family === 'scalar-fp-move-immediate')
    return [
      scalar('Rd'),
      ...native
        .filter((operand) => operand.kind === 'fpimm')
        .flatMap((operand) => nativeOperand(operand, decoded, pc)),
    ];
  if (family === 'scalar-fp-compare')
    return [
      scalar('Rn'),
      (fields.opc ?? 0) & 1 ? { kind: 'floating_immediate', value: 0 } : scalar('Rm'),
    ];
  if (family === 'scalar-fp-conditional-select')
    return [
      scalar('Rd'),
      scalar('Rn'),
      scalar('Rm'),
      { kind: 'condition', code: fields.cond ?? 0 },
    ];
  const file = decoded.encoding?.fileName ?? '';
  if (
    ['add_advsimd.xml', 'fadd_advsimd.xml', 'eor_advsimd.xml'].includes(file) &&
    (decoded.word & 0x10000000) === 0
  ) {
    const bits =
      file === 'eor_advsimd.xml'
        ? 8
        : file === 'fadd_advsimd.xml'
          ? fields.sz === 1
            ? 64
            : 32
          : 8 << (fields.size ?? 0);
    const width = fields.Q === 1 ? 128 : 64;
    const element = elementByBits[bits]!;
    return ['Rd', 'Rn', 'Rm'].map((field) =>
      regOperand(simdRegister(fields[field] ?? 0, width, false), `${width / bits}${element}`),
    );
  }
  if (file === 'movi_advsimd.xml') {
    const cmode = fields.cmode ?? 0;
    const imm8 =
      ((fields.a ?? 0) << 7) |
      ((fields.b ?? 0) << 6) |
      ((fields.c ?? 0) << 5) |
      ((fields.d ?? 0) << 4) |
      ((fields.e ?? 0) << 3) |
      ((fields.f ?? 0) << 2) |
      ((fields.g ?? 0) << 1) |
      (fields.h ?? 0);
    // MOVI's common immediate forms. MSL remains opaque rather than guessed.
    if (cmode < 12 || cmode === 14) {
      const bits = cmode === 14 ? (fields.op === 1 ? 64 : 8) : cmode < 8 ? 32 : 16;
      const width = fields.Q === 1 ? 128 : 64;
      const element = elementByBits[bits]!;
      let immediate = BigInt(imm8);
      if (cmode === 14 && fields.op === 1) {
        immediate = 0n;
        for (let bit = 0; bit < 8; bit++)
          if ((imm8 & (1 << bit)) !== 0) immediate |= 0xffn << BigInt(bit * 8);
      }
      return [
        regOperand(simdRegister(fields.Rd ?? 0, width, false), `${width / bits}${element}`),
        { kind: 'immediate', value: immediate, width_bits: bits },
        ...(cmode < 12 && ((cmode >>> 1) & 3) !== 0
          ? [
              {
                kind: 'modifier' as const,
                operation: 'lsl' as const,
                amount: ((cmode >>> 1) & 3) * 8,
              },
            ]
          : []),
      ];
    }
  }
  let operands = native.flatMap((operand) => nativeOperand(operand, decoded, pc));
  if (family === 'logical-shifted-register' || file.endsWith('_addsub_shift.xml')) {
    operands = operands.filter(
      (operand) =>
        operand.kind !== 'opaque' && operand.kind !== 'modifier' && !(operand.kind === 'immediate'),
    );
    if ((fields.shift ?? 0) !== 0 || (fields.imm6 ?? 0) !== 0)
      operands.push({
        kind: 'modifier',
        operation: (['lsl', 'lsr', 'asr', 'ror'] as const)[fields.shift ?? 0]!,
        amount: fields.imm6 ?? 0,
      });
  }
  if (file.endsWith('_addsub_ext.xml')) {
    operands = operands.filter((operand) => operand.kind !== 'opaque');
    operands.push({
      kind: 'modifier',
      operation: (['uxtb', 'uxth', 'uxtw', 'uxtx', 'sxtb', 'sxth', 'sxtw', 'sxtx'] as const)[
        fields.option ?? 0
      ]!,
      amount: fields.imm3 ?? 0,
    });
  }
  if (file === 'ldra.xml') {
    const raw = BigInt(((fields.S ?? 0) << 9) | (fields.imm9 ?? 0));
    operands = [
      regOperand(gpRegister(fields.Rt ?? 0, 64)),
      {
        kind: 'memory',
        base: gpRegister(fields.Rn ?? 0, 64, 'sp'),
        index: null,
        displacement: BigInt.asIntN(10, raw) * 8n,
        extend: 'none',
        shift: 0,
        writeback: fields.W === 1 ? 'pre' : 'none',
        access_bits: 64,
        access: 'read',
      },
    ];
  }
  return operands;
}

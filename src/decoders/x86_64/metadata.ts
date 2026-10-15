import {
  Code, CpuidFeature, EncodingKind, FlowControl, MemorySizeExt, Mnemonic, OpAccess,
  OpKind, Register, RegisterExt, RflagsBits, RoundingControl,
  type ConstantOffsets, type Instruction, type InstructionInfo, type UsedMemory, type UsedRegister,
} from 'iced-x86';
import type { Address, DecodedFlow, RegisterDescriptor, X86Payload } from '../../core/index.js';

type Access = X86Payload['registers'][number]['access'];
type Memory = X86Payload['memory'][number];
type Operand = X86Payload['operands'][number];
const accesses: readonly Access[] = ['none', 'read', 'conditional_read', 'write', 'conditional_write', 'read_write', 'read_conditional_write', 'none'];
function access(value: OpAccess): Access { return accesses[value]!; }
const registers = new Map<string, RegisterDescriptor>();

/** Descriptors are architectural slices, not iced enum identities. */
export function register(value: Register, encoding = EncodingKind.Legacy): RegisterDescriptor {
  const key = `${value}:${encoding}`;
  const cached = registers.get(key);
  if (cached) return cached;
  const name = Register[value]!.toLowerCase();
  const root = RegisterExt.fullRegister(value);
  const width = RegisterExt.size(value) * 8;
  const rootWidth = RegisterExt.size(root) * 8;
  const vector = RegisterExt.isXMM(value) || RegisterExt.isYMM(value) || RegisterExt.isZMM(value);
  const descriptor: RegisterDescriptor = Object.freeze({
    id: `x86_64:${name}`, root: `x86_64:${Register[root]!.toLowerCase()}`,
    bank: RegisterExt.isSegmentRegister(value) ? 'segment' : vector || RegisterExt.isMM(value) ? 'vector' : RegisterExt.isST(value) ? 'float' : RegisterExt.isGPR(value) || value === Register.EIP || value === Register.RIP ? 'integer' : 'control',
    width_bits: width, root_width_bits: rootWidth,
    offset_bits: value >= Register.AH && value <= Register.BH ? 8 : 0,
    role: root === Register.RSP ? 'stack_pointer' : root === Register.RIP ? 'program_counter' : 'general',
    write_rule: width === rootWidth ? 'replace_root' : RegisterExt.isGPR32(value) || (vector && encoding !== EncodingKind.Legacy) ? 'zero_extend_root' : 'preserve_other_bits',
  });
  registers.set(key, descriptor);
  return descriptor;
}
function nullableRegister(value: Register, encoding: EncodingKind): RegisterDescriptor | null {
  return value === Register.None ? null : register(value, encoding);
}
const flagPositions: readonly (readonly [number, number])[] = [
  [RflagsBits.CF, 0], [RflagsBits.PF, 2], [RflagsBits.AF, 4], [RflagsBits.ZF, 6],
  [RflagsBits.SF, 7], [RflagsBits.IF, 9], [RflagsBits.DF, 10], [RflagsBits.OF, 11],
  [RflagsBits.AC, 18], [RflagsBits.UIF, 25],
];
const flagUniverse = flagPositions.reduce((mask, [, bit]) => mask | (1n << BigInt(bit)), 0n);
function flags(mask: number): bigint {
  let result = 0n;
  for (const [source, bit] of flagPositions) if (mask & source) result |= 1n << BigInt(bit);
  return result;
}
const fpuPositions: readonly (readonly [number, number])[] = [[RflagsBits.C0, 8], [RflagsBits.C1, 9], [RflagsBits.C2, 10], [RflagsBits.C3, 14]];
function fpuFlags(mask: number): bigint {
  let result = 0n;
  for (const [source, bit] of fpuPositions) if (mask & source) result |= 1n << BigInt(bit);
  return result;
}
function scale(value: number): 1 | 2 | 4 | 8 {
  if (value !== 1 && value !== 2 && value !== 4 && value !== 8) throw new Error('Invalid iced address scale');
  return value;
}
function scalarBits(value: number): 8 | 16 | 32 | 64 {
  if (value !== 8 && value !== 16 && value !== 32 && value !== 64) throw new Error('Invalid x86 scalar width');
  return value;
}
function relativeBits(value: number): 8 | 16 | 32 {
  if (value !== 8 && value !== 16 && value !== 32) throw new Error('Invalid x86 relative width');
  return value;
}
const legacyPrefixBytes: readonly number[] = [0xf0, 0xf2, 0xf3, 0x2e, 0x36, 0x3e, 0x26, 0x64, 0x65, 0x66, 0x67];
function encodedPrefixes(bytes: Uint8Array, start: number, length: number, encoding: EncodingKind): number[] {
  const result: number[] = [];
  for (let i = start; i < start + length; i++) {
    const b = bytes[i]!;
    if (legacyPrefixBytes.includes(b) || (b >= 0x40 && b <= 0x4f)) result.push(b);
    else {
      const extra = encoding === EncodingKind.VEX ? (b === 0xc5 ? 2 : 3) : encoding === EncodingKind.EVEX || encoding === EncodingKind.MVEX ? 4 : encoding === EncodingKind.XOP ? 3 : 0;
      for (let j = 0; j < extra; j++) result.push(bytes[i + j]!);
      break;
    }
  }
  return result;
}
function memoryOf(instruction: Instruction, kind: OpKind, mode: 32 | 64, operandAccess: OpAccess, at: Address): Memory {
  let base = instruction.memoryBase;
  let segment = instruction.memorySegment;
  let index = instruction.memoryIndex;
  let displacement = instruction.memoryDisplacement;
  let multiplier = instruction.memoryIndexScale;
  if (kind !== OpKind.Memory) {
    const stringBases = [Register.SI, Register.ESI, Register.RSI, Register.DI, Register.EDI, Register.RDI, Register.DI, Register.EDI, Register.RDI];
    base = stringBases[kind - OpKind.MemorySegSI]!;
    if (kind >= OpKind.MemoryESDI) segment = Register.ES;
    index = Register.None; displacement = 0n; multiplier = 1;
  }
  const relative = base === Register.EIP || base === Register.RIP;
  if (relative) displacement = BigInt.asIntN(base === Register.EIP ? 32 : 64, instruction.ipRelMemoryAddress - instruction.nextIP);
  else if (base !== Register.None || index !== Register.None) displacement = BigInt.asIntN(mode, displacement);
  return {
    segment: nullableRegister(segment, instruction.encoding), base: nullableRegister(base, instruction.encoding), index: nullableRegister(index, instruction.encoding),
    scale: scale(multiplier), displacement, address_bits: mode,
    access_bits: MemorySizeExt.size(instruction.memorySize) * 8,
    rip_relative_target: relative ? { ...at, value: instruction.ipRelMemoryAddress } : null,
    broadcast: instruction.isBroadcast, access: access(operandAccess),
  };
}
function usedMemory(memory: UsedMemory, instruction: Instruction, mode: 32 | 64): Memory {
  if (RegisterExt.isGPR32(memory.base) || RegisterExt.isGPR32(memory.index)) mode = 32;
  else if (RegisterExt.isGPR64(memory.base) || RegisterExt.isGPR64(memory.index)) mode = 64;
  return {
    segment: nullableRegister(memory.segment, instruction.encoding), base: nullableRegister(memory.base, instruction.encoding), index: nullableRegister(memory.index, instruction.encoding),
    scale: scale(memory.scale), displacement: memory.base === Register.None && memory.index === Register.None ? memory.displacement : BigInt.asIntN(mode, memory.displacement),
    address_bits: mode, access_bits: MemorySizeExt.size(memory.memorySize) * 8,
    rip_relative_target: null, broadcast: instruction.isBroadcast, access: access(memory.access),
  };
}
export function payload(instruction: Instruction, info: InstructionInfo, constants: ConstantOffsets, bytes: Uint8Array, start: number, at: Address): X86Payload {
  const prefixes = encodedPrefixes(bytes, start, instruction.length, instruction.encoding);
  const vectorStart = prefixes.findIndex((b) => b === 0xc4 || b === 0xc5 || b === 0x62 || b === 0x8f);
  const legacyPrefixes = vectorStart === -1 ? prefixes : prefixes.slice(0, vectorStart);
  const mode: 32 | 64 = legacyPrefixes.includes(0x67) ? 32 : 64;
  const operands: Operand[] = [];
  const explicit = new Set<Register>();
  for (let i = 0; i < instruction.opCount; i++) {
    const kind = instruction.opKind(i);
    const operandAccess = info.opAccess(i);
    if (kind === OpKind.Register) {
      const r = instruction.opRegister(i); explicit.add(r);
      operands.push({ kind: 'register', register: register(r, instruction.encoding), access: access(operandAccess) });
    } else if (kind >= OpKind.NearBranch16 && kind <= OpKind.NearBranch64) {
      const bits = relativeBits(constants.immediateSize * 8);
      operands.push({ kind: 'relative', target: { ...at, value: instruction.nearBranchTarget }, displacement: BigInt.asIntN(bits, instruction.nearBranchTarget - instruction.nextIP), encoded_bits: bits });
    } else if (kind === OpKind.FarBranch16 || kind === OpKind.FarBranch32) {
      operands.push({ kind: 'far_pointer', selector: instruction.farBranchSelector, offset: BigInt(kind === OpKind.FarBranch16 ? instruction.farBranch16 : instruction.farBranch32) });
    } else if (kind >= OpKind.Immediate8 && kind <= OpKind.Immediate32to64) {
      const widths: readonly (readonly [number, number])[] = [[8, 8], [8, 8], [16, 16], [32, 32], [64, 64], [8, 16], [8, 32], [8, 64], [32, 64]];
      const [encoded, effective] = widths[kind - OpKind.Immediate8]!;
      const encodedSize = kind === OpKind.Immediate8_2nd ? constants.immediateSize2 : constants.immediateSize;
      operands.push({ kind: 'immediate', value: BigInt.asUintN(effective, instruction.immediate(i)), encoded_bits: encodedSize === 0 ? 0 : scalarBits(encoded), effective_bits: scalarBits(effective), sign_extended: encoded !== effective });
    } else operands.push({ kind: 'memory', memory: memoryOf(instruction, kind, mode, operandAccess, at) });
  }
  const nativeRegisters = info.usedRegisters() as UsedRegister[];
  let accessesResult: X86Payload['registers'];
  try {
    const explicitRegisters = [...explicit];
    const doubleWidth = instruction.opCount === 1 && (instruction.mnemonic === Mnemonic.Mul || instruction.mnemonic === Mnemonic.Imul || instruction.mnemonic === Mnemonic.Div || instruction.mnemonic === Mnemonic.Idiv);
    const operandWidth = operands[0]?.kind === 'register' ? operands[0].register.width_bits : operands[0]?.kind === 'memory' ? operands[0].memory.access_bits : 0;
    accessesResult = nativeRegisters.map((r) => {
      // iced widens zero-extending writes to their physical roots. Preserve the
      // encoded slice while retaining its architectural root-write rule.
      const equivalent = explicitRegisters.find((e) => RegisterExt.fullRegister(e) === r.register && (RegisterExt.isGPR32(e) || RegisterExt.isXMM(e) || RegisterExt.isYMM(e)) && (r.access === OpAccess.Write || r.access === OpAccess.CondWrite));
      const implicit32 = doubleWidth && operandWidth === 32 && (r.register === Register.RAX || r.register === Register.RDX);
      const selected = equivalent ?? (implicit32 ? r.register === Register.RAX ? Register.EAX : Register.EDX : r.register);
      const root = RegisterExt.fullRegister(selected);
      const implicitArithmetic = doubleWidth && (root === Register.RAX || root === Register.RDX);
      const implicitStack = instruction.isStackInstruction && root === Register.RSP;
      return { register: register(selected, instruction.encoding), access: access(r.access), implicit: implicitArithmetic || implicitStack || !explicit.has(selected) };
    });
  } finally { for (const r of nativeRegisters) r.free(); }
  const nativeMemory = info.usedMemory() as UsedMemory[];
  let memory: X86Payload['memory'];
  try {
    memory = nativeMemory.map((m) => {
      const adapted = usedMemory(m, instruction, mode);
      const operand = operands.find((o) => o.kind === 'memory' && o.memory.access === adapted.access && o.memory.access_bits === adapted.access_bits &&
        (o.memory.rip_relative_target !== null ? o.memory.rip_relative_target.value === BigInt.asUintN(64, m.displacement) :
          o.memory.base?.id === adapted.base?.id && o.memory.index?.id === adapted.index?.id && o.memory.displacement === adapted.displacement));
      return operand?.kind === 'memory' ? operand.memory : adapted;
    });
  } finally { for (const m of nativeMemory) m.free(); }
  const opcode = instruction.opCode;
  let operandBits: X86Payload['operand_bits'];
  try {
    const first = operands[0];
    const width = opcode.operandSize || (first?.kind === 'register' ? first.register.width_bits : first?.kind === 'memory' ? first.memory.access_bits : 0);
    switch (width) {
      case 0: case 8: case 16: case 32: case 64: case 80: case 128: case 256: case 512: case 8192:
        operandBits = width; break;
      default: operandBits = 0; // Total state-block size is not an operand-size class.
    }
  } finally { opcode.free(); }
  const lastPrefix = legacyPrefixes.at(-1);
  const rex = lastPrefix !== undefined && lastPrefix >= 0x40 && lastPrefix <= 0x4f ? lastPrefix : null;
  const encodings: readonly X86Payload['prefixes']['encoding'][] = ['legacy', 'vex', 'evex', 'xop', 'legacy', 'mvex'];
  const rounding: readonly X86Payload['prefixes']['rounding'][] = ['none', 'nearest', 'down', 'up', 'zero'];
  return {
    architecture: 'x86_64', encoding: Code[instruction.code]!, mnemonic: Mnemonic[instruction.mnemonic]!.toLowerCase(),
    operand_bits: operandBits, address_bits: mode,
    prefixes: { bytes: prefixes, lock: instruction.hasLockPrefix, rep: instruction.hasRepPrefix, repne: instruction.hasRepnePrefix, rex,
      segment: nullableRegister(instruction.segmentPrefix, instruction.encoding), encoding: encodings[instruction.encoding]!, mask: nullableRegister(instruction.opMask, instruction.encoding),
      zeroing: instruction.zeroingMasking, rounding: rounding[instruction.roundingControl]!, suppress_exceptions: instruction.suppressAllExceptions || instruction.roundingControl !== RoundingControl.None },
    operands, registers: accessesResult, memory,
    flags: { read: flags(instruction.rflagsRead), written: flags(instruction.rflagsWritten), cleared: flags(instruction.rflagsCleared), set: flags(instruction.rflagsSet), undefined: flags(instruction.rflagsUndefined), preserved: flagUniverse & ~flags(instruction.rflagsModified) },
    fpu_flags: fpuFlags(instruction.rflagsRead | instruction.rflagsModified) === 0n ? null : {
      read: fpuFlags(instruction.rflagsRead), written: fpuFlags(instruction.rflagsWritten), cleared: fpuFlags(instruction.rflagsCleared),
      set: fpuFlags(instruction.rflagsSet), undefined: fpuFlags(instruction.rflagsUndefined), preserved: 0x4700n & ~fpuFlags(instruction.rflagsModified),
    },
    required_features: Array.from(instruction.cpuidFeatures(), (f) => CpuidFeature[f]!), privileged: instruction.isPrivileged,
  };
}
export function flow(instruction: Instruction, at: Address): DecodedFlow {
  const next = { ...at, value: instruction.nextIP };
  const target = { ...at, value: instruction.nearBranchTarget };
  const near = instruction.opCount > 0 && instruction.op0Kind >= OpKind.NearBranch16 && instruction.op0Kind <= OpKind.NearBranch64;
  switch (instruction.flowControl) {
    case FlowControl.Next: return { kind: 'fallthrough', next };
    case FlowControl.UnconditionalBranch: return near ? { kind: 'branch', target, conditional: false, fallthrough: null } : { kind: 'unknown', reason: 'Segmented far transfer', may_fallthrough: false };
    case FlowControl.ConditionalBranch: return { kind: 'branch', target, conditional: true, fallthrough: next };
    case FlowControl.IndirectBranch: return { kind: 'indirect_branch', conditional: false, fallthrough: null };
    case FlowControl.Call: return near ? { kind: 'call', target, indirect: false, fallthrough: next } : { kind: 'unknown', reason: 'System or segmented call', may_fallthrough: true };
    case FlowControl.IndirectCall: return { kind: 'call', target: null, indirect: true, fallthrough: next };
    case FlowControl.Return: return { kind: 'return' };
    case FlowControl.Exception: return { kind: 'trap', reason: Mnemonic[instruction.mnemonic]!, conditional: false, fallthrough: null };
    case FlowControl.Interrupt: return { kind: 'trap', reason: Mnemonic[instruction.mnemonic]!, conditional: instruction.mnemonic === Mnemonic.Into, fallthrough: instruction.mnemonic === Mnemonic.Into ? next : null };
    case FlowControl.XbeginXabortXend: return near ? { kind: 'branch', target, conditional: true, fallthrough: next } : { kind: 'unknown', reason: 'Transactional control transfer', may_fallthrough: true };
  }
}

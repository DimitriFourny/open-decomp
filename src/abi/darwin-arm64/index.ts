import type {
  AbiCallLayout,
  AbiLocation,
  AbiProfile,
  AbiType,
  CallClobbers,
  DataLayout,
  Diagnostic,
  RegisterDescriptor,
} from '../../core/index.js';

/**
 * Darwin's LP64 C calling convention, not Swift, C++ nontrivial-object lowering,
 * SVE/SME, or an inferred prototype. Layouts must describe complete, trivial
 * objects; fields may encode nested records/arrays but not unions/bit-fields.
 *
 * Apple differences (packing, odd-register int128, extensions, varargs, LP64):
 * https://developer.apple.com/documentation/xcode/writing-arm64-code-for-apple-platforms
 * Baseline classification and preservation: AAPCS64 sections 5.10, 6.1, 6.8:
 * https://github.com/ARM-software/abi-aa/blob/2025Q1/aapcs64/aapcs64.rst
 * The legacy calls.js supported anonymous eight-byte slots but limited fixed
 * signatures to eight integer arguments. This profile also handles real stack,
 * FP/vector and structural aggregate contracts without consulting symbol names.
 *
 * Every stack offset is relative to callee-entry SP (also caller SP at BL).
 * stack_bytes is the outgoing stack argument area rounded to 16, excluding any
 * pushed return address (there is none), red zone, callee frame, and caller-chosen
 * indirect object/result storage. shadow_space is zero. Stack location size is
 * meaningful object bytes, not slot padding; alignment is the placement guarantee.
 * register value_offset_bits indexes the source value, not the physical register.
 * Narrow integers use low source bits in Wn; Apple requires the caller to sign/
 * zero-extend arguments to 32 bits according to AbiType.signed. Unused upper bits
 * are not additional value bits. Anonymous C float/narrow-integer arguments undergo
 * default promotions; ambiguous half-precision and unprototyped calls are unsupported.
 *
 * On partial results an unclassified parameter and all following parameters have
 * no locations: neither register bank nor stack cursor is guessed. stack_bytes
 * is then only the rounded known-prefix lower bound, NOT a complete allocation.
 */
export class DarwinArm64Abi implements AbiProfile {
  readonly name = 'Darwin ARM64 C ABI';
  readonly version = '1.2.0';
  readonly id = 'darwin-arm64' as const;
  readonly architecture = 'arm64' as const;
  readonly layout: DataLayout = Object.freeze({
    endian: 'little',
    pointer_bits: 64,
    char_bits: 8,
    short_bits: 16,
    int_bits: 32,
    long_bits: 64,
    long_long_bits: 64,
    float_bits: 32,
    double_bits: 64,
    long_double_bits: 64,
    long_double_storage_bits: 64,
    stack_alignment: 16,
    aggregate_max_alignment: 16,
  });
  readonly stack_pointer = SP;
  readonly stack_return_address_bytes = 0n;
  readonly red_zone_bytes = 128n;
  /** x18 is platform-reserved, not an allocatable callee-saved register. */
  readonly preserved: readonly RegisterDescriptor[] = PRESERVED;
  /** Includes upper halves of v8-v15, never their preserved low 64 bits. */
  readonly unknown_call_clobbers = CLOBBERS;

  classifyCall(signature: Parameters<AbiProfile['classifyCall']>[0]): AbiCallLayout {
    const diagnostics: Diagnostic[] = [];
    const argument_count =
      signature.parameters !== null &&
      (signature.argument_list_complete ?? (!signature.variadic && signature.prototyped !== false))
        ? signature.parameters.length
        : null;
    const report = (message: string, invalid = false): void => {
      diagnostics.push({
        code: invalid ? 'invalid_input' : 'unavailable_semantics',
        severity: 'warning',
        message,
        evidence_ids: [],
      });
    };
    if (
      (signature.calling_convention !== undefined && signature.calling_convention !== 'default') ||
      signature.prototyped === false
    ) {
      report(
        'Only the prototyped Darwin C calling convention is supported; no foreign or unprototyped locations are assumed.',
      );
      return {
        parameters: (signature.parameters ?? []).map((_, index) => ({ index, locations: [] })),
        argument_count,
        returns: [],
        hidden_result: null,
        stack_bytes: 0n,
        shadow_space: 0n,
        stack_alignment: 16,
        implicit_register_inputs: [],
        clobbers: CLOBBERS,
        diagnostics,
        state: 'unsupported',
      };
    }

    let returns: readonly AbiLocation[] = [],
      hidden_result: AbiLocation | null = null;
    const result = classify(signature.returns);
    if (result === null)
      report(
        'Return layout is unknown or unsupported; no return location or hidden-result contract is assumed.',
      );
    else if (result.kind === 'indirect')
      hidden_result = {
        kind: 'indirect',
        pointer: X[8]!,
        size: result.size,
        alignment: result.alignment,
      };
    else returns = registerLocations(result, 0);
    if (signature.parameters === null) {
      report(
        'Parameter count is unknown; no arguments or complete stack allocation are established.',
      );
      return {
        parameters: [],
        argument_count,
        returns,
        hidden_result,
        stack_bytes: 0n,
        shadow_space: 0n,
        stack_alignment: 16,
        implicit_register_inputs: [],
        clobbers: CLOBBERS,
        diagnostics,
        state: 'partial',
      };
    }
    const validCount =
      Number.isSafeInteger(signature.fixed_parameter_count) &&
      signature.fixed_parameter_count >= 0 &&
      signature.fixed_parameter_count <= signature.parameters.length &&
      (signature.variadic || signature.fixed_parameter_count === signature.parameters.length);
    if (!validCount) {
      report(
        'Invalid fixed_parameter_count: it must identify the fixed prefix (all parameters for a nonvariadic call).',
        true,
      );
      return {
        parameters: signature.parameters.map((_, index) => ({ index, locations: [] })),
        argument_count,
        returns: [],
        hidden_result: null,
        stack_bytes: 0n,
        shadow_space: 0n,
        stack_alignment: 16,
        implicit_register_inputs: [],
        clobbers: CLOBBERS,
        diagnostics,
        state: 'unsupported',
      };
    }
    if (argument_count === null)
      report(
        'Only a known argument prefix is supplied; total arity and final stack allocation remain unknown.',
      );

    let ngrn = 0,
      nsrn = 0,
      stack = 0n,
      uncertain = false;
    const parameters = signature.parameters.map(
      (type, index): AbiCallLayout['parameters'][number] => {
        if (uncertain) return { index, locations: [] };
        const anonymous = signature.variadic && index >= signature.fixed_parameter_count;
        const effective: AbiType =
          anonymous && type.kind === 'float' && type.bits === 32
            ? { kind: 'float', bits: 64 }
            : anonymous && type.kind === 'integer' && type.bits < 32
              ? { kind: 'integer', bits: 32, signed: true }
              : type;
        const shape = classify(effective);
        if (
          shape === null ||
          type.kind === 'void' ||
          (anonymous && type.kind === 'float' && type.bits === 16)
        ) {
          report(
            `Parameter ${index} has an unknown or unsupported layout; later locations are unresolved and stack_bytes is only a known-prefix lower bound.`,
          );
          uncertain = true;
          return { index, locations: [] };
        }
        if (shape.kind === 'empty') return { index, locations: [] };
        const indirect = shape.kind === 'indirect';
        const size = indirect ? 8n : shape.size;
        // Darwin anonymous arguments occupy eight-byte slots, but natural 16-byte
        // scalar/vector alignment is retained. HFA/HVA members remain contiguous.
        // See CC_AArch64_DarwinPCS_VarArg / Custom_Stack_Block for compiler evidence:
        // https://github.com/llvm/llvm-project/blob/main/llvm/lib/Target/AArch64/AArch64CallingConvention.td
        const alignment = anonymous
          ? type.kind === 'aggregate' && shape.kind === 'simd'
            ? 8
            : Math.max(8, indirect ? 8 : shape.alignment)
          : indirect
            ? 8
            : shape.alignment;
        if (!anonymous) {
          if (shape.kind === 'simd' && nsrn + shape.members.length <= 8) {
            const locations = registerLocations(shape, nsrn);
            nsrn += shape.members.length;
            return { index, locations };
          }
          if (shape.kind === 'simd') nsrn = 8;
          else {
            const count = indirect ? 1 : Number((size + 7n) / 8n);
            // Apple deliberately does not round NGRN to even for 16-byte values.
            if (ngrn + count <= 8) {
              const locations: readonly AbiLocation[] = indirect
                ? [
                    {
                      kind: 'indirect',
                      pointer: X[ngrn]!,
                      size: shape.size,
                      alignment: shape.alignment,
                    },
                  ]
                : registerLocations(shape, ngrn);
              ngrn += count;
              return { index, locations };
            }
            ngrn = 8; // No splitting of an aggregate/int128 between x7 and stack.
          }
        }
        stack = align(stack, alignment);
        const locations: readonly AbiLocation[] = indirect
          ? [
              {
                kind: 'indirect',
                pointer: { stack_offset: stack },
                size: shape.size,
                alignment: shape.alignment,
              },
            ]
          : [{ kind: 'stack', offset: stack, size, alignment, value_offset_bits: 0 }];
        stack += anonymous ? align(size, 8) : size;
        return { index, locations };
      },
    );
    return {
      parameters,
      argument_count,
      returns,
      hidden_result,
      stack_bytes: align(stack, 16),
      shadow_space: 0n,
      stack_alignment: 16,
      implicit_register_inputs: [],
      clobbers: CLOBBERS,
      diagnostics,
      state: diagnostics.length === 0 ? 'complete' : 'partial',
    };
  }
}

function integerRegister(index: number, width: 32 | 64): RegisterDescriptor {
  return Object.freeze({
    id: `arm64:${width === 32 ? 'w' : 'x'}${index}`,
    bank: 'integer',
    root: `arm64:x${index}`,
    offset_bits: 0,
    width_bits: width,
    root_width_bits: 64,
    role: 'general',
    write_rule: width === 32 ? 'zero_extend_root' : 'replace_root',
  });
}
function simdRegister(index: number, width: number, vector: boolean): RegisterDescriptor {
  const prefix = vector ? 'v' : width === 16 ? 'h' : width === 32 ? 's' : 'd';
  return Object.freeze({
    id: `arm64:${prefix}${index}${vector && width < 128 ? `:0:${width}` : ''}`,
    bank: vector ? 'vector' : 'float',
    root: `arm64:v${index}`,
    offset_bits: 0,
    width_bits: width,
    root_width_bits: 128,
    role: 'general',
    write_rule: width === 128 ? 'replace_root' : 'zero_extend_root',
  });
}
const X = Array.from({ length: 31 }, (_, index) => integerRegister(index, 64));
const W = Array.from({ length: 8 }, (_, index) => integerRegister(index, 32));
const V = Array.from({ length: 32 }, (_, index) => simdRegister(index, 128, true));
const D = Array.from({ length: 32 }, (_, index) => simdRegister(index, 64, false));
const S = Array.from({ length: 8 }, (_, index) => simdRegister(index, 32, false));
const H = Array.from({ length: 8 }, (_, index) => simdRegister(index, 16, false));
const V64 = Array.from({ length: 8 }, (_, index) => simdRegister(index, 64, true));
const SP: RegisterDescriptor = Object.freeze({
  id: 'arm64:sp',
  bank: 'integer',
  root: 'arm64:sp',
  offset_bits: 0,
  width_bits: 64,
  root_width_bits: 64,
  role: 'stack_pointer',
  write_rule: 'replace_root',
});
const PRESERVED = Object.freeze([...X.slice(19, 30), SP, ...D.slice(8, 16)]);
const CLOBBERS: CallClobbers = Object.freeze({
  // x18 is reserved by Apple; no application value is assumed preserved in it.
  // FPCR may change through support functions (AAPCS64 6.1.2): unknown targets
  // get conservative control-state effects as well as FPSR/NZCV and memory.
  registers: Object.freeze([
    ...X.slice(0, 19),
    X[30]!,
    ...V.slice(0, 8),
    ...V.slice(16),
    ...V.slice(8, 16).map((register): RegisterDescriptor =>
      Object.freeze({
        ...register,
        id: `${register.id}:high64`,
        offset_bits: 64,
        width_bits: 64,
        write_rule: 'preserve_other_bits',
      }),
    ),
    Object.freeze({
      id: 'arm64:fpcr',
      bank: 'control' as const,
      root: 'arm64:fpcr',
      offset_bits: 0,
      width_bits: 32,
      root_width_bits: 32,
      role: 'general' as const,
      write_rule: 'replace_root' as const,
    }),
  ]),
  flags: Object.freeze(
    ['nzcv', 'fpsr'].map((name): RegisterDescriptor =>
      Object.freeze({
        id: `arm64:${name}`,
        bank: 'flags',
        root: `arm64:${name}`,
        offset_bits: 0,
        width_bits: 32,
        root_width_bits: 32,
        role: 'flags',
        write_rule: 'replace_root',
      }),
    ),
  ),
  memory: 'unknown_read_write',
});

interface SimdMember {
  readonly bits: number;
  readonly vector: boolean;
  readonly offset: number;
}
type Shape =
  | { readonly kind: 'empty'; readonly size: 0n; readonly alignment: number }
  | {
      readonly kind: 'integer';
      readonly size: bigint;
      readonly alignment: number;
      readonly bits: number;
      readonly scalar: boolean;
    }
  | {
      readonly kind: 'simd';
      readonly size: bigint;
      readonly alignment: number;
      readonly members: readonly SimdMember[];
    }
  | { readonly kind: 'indirect'; readonly size: bigint; readonly alignment: number };
function align(value: bigint, alignment: number): bigint {
  const a = BigInt(alignment);
  return ((value + a - 1n) / a) * a;
}
/** Bounds recursion/work on untrusted or cyclic source layouts; no opaque-field guesses. */
function classify(type: AbiType, depth = 0, budget = { remaining: 4096 }): Shape | null {
  if (depth > 64 || --budget.remaining < 0) return null;
  switch (type.kind) {
    case 'unknown':
      return null;
    case 'void':
      return { kind: 'empty', size: 0n, alignment: 1 };
    case 'pointer':
      return { kind: 'integer', size: 8n, alignment: 8, bits: 64, scalar: true };
    case 'integer': {
      if (![1, 8, 16, 32, 64, 128].includes(type.bits)) return null;
      const size = BigInt(Math.max(1, type.bits / 8));
      return { kind: 'integer', size, alignment: Number(size), bits: type.bits, scalar: true };
    }
    case 'float':
      // Darwin long double is binary64, not the generic PCS binary128.
      if (type.bits === 80 || type.bits === 128) return null;
      return {
        kind: 'simd',
        size: BigInt(type.bits / 8),
        alignment: type.bits / 8,
        members: [{ bits: type.bits, vector: false, offset: 0 }],
      };
    case 'vector': {
      const bits = type.element_bits * type.lanes;
      if (
        !Number.isSafeInteger(type.lanes) ||
        type.lanes < 1 ||
        !Number.isInteger(Math.log2(type.lanes)) ||
        !(type.element === 'float' ? [16, 32, 64] : [8, 16, 32, 64]).includes(type.element_bits) ||
        (bits !== 64 && bits !== 128)
      )
        return null;
      return {
        kind: 'simd',
        size: BigInt(bits / 8),
        alignment: bits / 8,
        members: [{ bits, vector: true, offset: 0 }],
      };
    }
    case 'aggregate': {
      if (type.trivial_for_abi === false) return null;
      if (
        ![1, 2, 4, 8, 16].includes(type.alignment) ||
        type.size < 0n ||
        type.size > (1n << 64n) - 1n ||
        type.size % BigInt(type.alignment) !== 0n ||
        type.fields.length > budget.remaining
      )
        return null;
      if (type.size === 0n)
        return type.fields.length === 0
          ? { kind: 'empty', size: 0n, alignment: type.alignment }
          : null;
      if (type.fields.length === 0) return null;
      const members: SimdMember[] = [];
      let end = 0n,
        homogeneous = true;
      for (const field of type.fields) {
        const child = classify(field.type, depth + 1, budget);
        if (
          child === null ||
          field.type.kind === 'void' ||
          field.offset < end ||
          field.offset + child.size > type.size
        )
          return null;
        if (child.kind !== 'empty') {
          if (
            child.kind !== 'simd' ||
            field.offset !== end ||
            members.length + child.members.length > 4
          )
            homogeneous = false;
          if (homogeneous && child.kind === 'simd') {
            for (const member of child.members)
              members.push({ ...member, offset: Number(field.offset * 8n) + member.offset });
          }
        }
        end = field.offset + child.size;
      }
      const first = members[0];
      if (
        homogeneous &&
        first !== undefined &&
        end === type.size &&
        members.every((member) => member.bits === first.bits && member.vector === first.vector)
      ) {
        return { kind: 'simd', size: type.size, alignment: type.alignment, members };
      }
      return type.size > 16n
        ? { kind: 'indirect', size: type.size, alignment: type.alignment }
        : {
            kind: 'integer',
            size: type.size,
            alignment: type.alignment,
            bits: Number(type.size * 8n),
            scalar: false,
          };
    }
  }
}
function registerLocations(shape: Shape, start: number): readonly AbiLocation[] {
  if (shape.kind === 'empty' || shape.kind === 'indirect') return [];
  if (shape.kind === 'simd')
    return shape.members.map((member, index) => {
      const registers = member.vector
        ? member.bits === 128
          ? V
          : V64
        : member.bits === 16
          ? H
          : member.bits === 32
            ? S
            : D;
      return {
        kind: 'register',
        register: registers[start + index]!,
        value_offset_bits: member.offset,
        width_bits: member.bits,
      };
    });
  const count = Number((shape.size + 7n) / 8n);
  return Array.from({ length: count }, (_, index) => ({
    kind: 'register' as const,
    register: (shape.scalar && shape.bits <= 32 ? W : X)[start + index]!,
    value_offset_bits: index * 64,
    width_bits: Math.min(64, shape.bits - index * 64),
  }));
}

/** Stateless shared profile. No library/name lookup or host-dependent decisions. */
export const darwinArm64Abi = new DarwinArm64Abi();

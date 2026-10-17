// SPDX-License-Identifier: MIT
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

// Keep physical identities/slices in agreement with the x86 decoder: XMM is
// low128 of a ZMM root, with legacy writes preserving the other bits.
function gpr(name: string): RegisterDescriptor {
  return Object.freeze({
    id: `x86_64:${name}`,
    root: `x86_64:${name}`,
    bank: 'integer',
    offset_bits: 0,
    width_bits: 64,
    root_width_bits: 64,
    role: name === 'rsp' ? 'stack_pointer' : 'general',
    write_rule: 'replace_root',
  });
}
function simd(index: number, offset = 0, width = 512): RegisterDescriptor {
  return Object.freeze({
    id:
      offset === 0
        ? `x86_64:${width === 128 ? 'xmm' : 'zmm'}${index}`
        : `x86_64:zmm${index}[${offset}:${offset + width}]`,
    root: `x86_64:zmm${index}`,
    bank: 'vector',
    offset_bits: offset,
    width_bits: width,
    root_width_bits: 512,
    role: 'general',
    write_rule: width === 512 ? 'replace_root' : 'preserve_other_bits',
  });
}
function stateRegister(
  name: string,
  bank: RegisterDescriptor['bank'],
  width: number,
): RegisterDescriptor {
  return Object.freeze({
    id: `x86_64:${name}`,
    root: `x86_64:${name}`,
    bank,
    offset_bits: 0,
    width_bits: width,
    root_width_bits: width,
    role: bank === 'flags' ? 'flags' : 'general',
    write_rule: 'replace_root',
  });
}
const integerArguments = ['rcx', 'rdx', 'r8', 'r9'].map(gpr);
const floatingArguments = Array.from({ length: 4 }, (_, index) => simd(index, 0, 128));
const rax = gpr('rax');
const xmm0 = floatingArguments[0]!;
const rsp = gpr('rsp');
const mxcsr = stateRegister('mxcsr', 'control', 32);
const preserved: readonly RegisterDescriptor[] = Object.freeze([
  ...['rbx', 'rbp', 'rdi', 'rsi', 'rsp', 'r12', 'r13', 'r14', 'r15'].map(gpr),
  ...Array.from({ length: 10 }, (_, index) => simd(index + 6, 0, 128)),
  stateRegister('fpcsr', 'control', 16),
  Object.freeze({
    ...mxcsr,
    id: 'x86_64:mxcsr[6:16]',
    offset_bits: 6,
    width_bits: 10,
    write_rule: 'preserve_other_bits' as const,
  }),
]);
const clobbers: CallClobbers = Object.freeze({
  registers: Object.freeze([
    ...['rax', 'rcx', 'rdx', 'r8', 'r9', 'r10', 'r11'].map(gpr),
    ...Array.from({ length: 32 }, (_, index) =>
      index >= 6 && index <= 15 ? simd(index, 128, 384) : simd(index),
    ),
    ...Array.from({ length: 8 }, (_, index) => stateRegister(`st${index}`, 'float', 80)),
    ...Array.from({ length: 8 }, (_, index) => stateRegister(`mm${index}`, 'vector', 64)),
    ...Array.from({ length: 8 }, (_, index) => stateRegister(`k${index}`, 'control', 64)),
  ]),
  flags: Object.freeze([
    ...(
      [
        ['cf', 0],
        ['pf', 2],
        ['af', 4],
        ['zf', 6],
        ['sf', 7],
        ['of', 11],
      ] as const
    ).map(([name, bit]): RegisterDescriptor =>
      Object.freeze({
        id: `x86_64:${name}`,
        root: 'x86_64:rflags',
        bank: 'flags',
        offset_bits: bit,
        width_bits: 1,
        root_width_bits: 64,
        role: 'flags',
        write_rule: 'preserve_other_bits',
      }),
    ),
    Object.freeze({
      ...mxcsr,
      id: 'x86_64:mxcsr[0:6]',
      bank: 'flags' as const,
      role: 'flags' as const,
      width_bits: 6,
      write_rule: 'preserve_other_bits' as const,
    }),
    stateRegister('fpsw', 'flags', 16),
  ]),
  memory: 'unknown_read_write',
});
const dataLayout: DataLayout = Object.freeze({
  endian: 'little',
  pointer_bits: 64,
  char_bits: 8,
  short_bits: 16,
  int_bits: 32,
  long_bits: 32,
  long_long_bits: 64,
  float_bits: 32,
  double_bits: 64,
  long_double_bits: 64,
  long_double_storage_bits: 64,
  stack_alignment: 16,
  aggregate_max_alignment: 16,
});

type Argument =
  | { readonly kind: 'integer' | 'float'; readonly bits: number }
  | { readonly kind: 'indirect'; readonly size: bigint; readonly alignment: number };
function unsupported(message: string): Diagnostic {
  return { code: 'unavailable_semantics', severity: 'warning', message, evidence_ids: [] };
}
function classifyType(type: AbiType): Argument | null {
  switch (type.kind) {
    case 'pointer':
      return { kind: 'integer', bits: 64 };
    case 'integer':
      return [8, 16, 32, 64].includes(type.bits) ? { kind: 'integer', bits: type.bits } : null;
    case 'float':
      return type.bits === 32 || type.bits === 64 ? { kind: 'float', bits: type.bits } : null;
    case 'vector': {
      if (
        !Number.isSafeInteger(type.lanes) ||
        type.lanes < 1 ||
        ![8, 16, 32, 64].includes(type.element_bits)
      )
        return null;
      const bits = type.lanes * type.element_bits;
      if (bits === 128) return { kind: 'indirect', size: 16n, alignment: 16 }; // __m128 family
      return null;
    }
    case 'aggregate': {
      if (
        type.trivial_for_abi === false ||
        type.size <= 0n ||
        !Number.isSafeInteger(type.alignment) ||
        type.alignment < 1 ||
        type.alignment > 16 ||
        (type.alignment & (type.alignment - 1)) !== 0
      )
        return null;
      if ([1n, 2n, 4n, 8n].includes(type.size))
        return { kind: 'integer', bits: Number(type.size * 8n) };
      return { kind: 'indirect', size: type.size, alignment: 16 };
    }
    case 'unknown':
    case 'void':
      return null;
  }
}
function registerLocation(register: RegisterDescriptor, bits: number): AbiLocation {
  return { kind: 'register', register, value_offset_bits: 0, width_bits: bits };
}

/**
 * Default Microsoft x64 ABI for resolved C layouts, including plain/trivial
 * aggregates and 128-bit __m128-family vectors. Not SysV, MinGW long-double,
 * vectorcall, instance-member, nontrivial C++, APX, or AMX contracts. Other
 * vector sizes are unsupported: shape alone cannot identify special __m64
 * integer ABI classification versus a compiler's generic vector extension.
 *
 * Primary rules: https://learn.microsoft.com/en-us/cpp/build/x64-calling-convention
 * Layout: https://learn.microsoft.com/en-us/cpp/build/x64-software-conventions
 * long double: https://learn.microsoft.com/en-us/cpp/c-language/type-long-double
 *
 * All stack offsets are relative to callee-entry RSP: return address at +0,
 * four 8-byte home slots at +8..+39, fifth ordinary argument at +40. Home
 * slots are reserved storage, NOT additional initialized argument locations.
 * stack_bytes is the 16-aligned outgoing shadow/argument area, excluding the
 * hardware return-address push, caller locals, alignment of an existing frame,
 * and indirect argument/result objects. It is a lower bound for partial layouts.
 * Unwind and symbol evidence belongs to discovery/metadata; neither determines
 * parameter counts here. Unknown calls use unknown_call_clobbers directly.
 */
export class WindowsX64Abi implements AbiProfile {
  readonly name = 'Microsoft x64 ABI';
  readonly version = '2';
  readonly id = 'windows-x64';
  readonly architecture = 'x86_64';
  readonly layout = dataLayout;
  readonly stack_pointer = rsp;
  readonly stack_return_address_bytes = 8n;
  readonly red_zone_bytes = 0n;
  readonly preserved = preserved;
  readonly unknown_call_clobbers = clobbers;

  classifyCall(signature: Parameters<AbiProfile['classifyCall']>[0]): AbiCallLayout {
    const diagnostics: Diagnostic[] = [];
    const parameters: { index: number; locations: AbiLocation[] }[] = [];
    const returns: AbiLocation[] = [];
    const argument_count =
      signature.parameters !== null &&
      (signature.argument_list_complete ?? (!signature.variadic && signature.prototyped !== false))
        ? signature.parameters.length
        : null;
    let hiddenResult: AbiLocation | null = null;
    let state: AbiCallLayout['state'] = 'complete';
    let slots = 0;
    const result = (): AbiCallLayout => ({
      parameters,
      argument_count,
      returns,
      hidden_result: hiddenResult,
      stack_bytes: ((32n + BigInt(Math.max(0, slots - 4)) * 8n + 15n) / 16n) * 16n,
      shadow_space: 32n,
      stack_alignment: 16,
      implicit_register_inputs: [],
      clobbers,
      diagnostics,
      state,
    });
    if (signature.calling_convention !== undefined && signature.calling_convention !== 'default') {
      diagnostics.push(
        unsupported(
          `Calling convention ${signature.calling_convention} is not the default Microsoft x64 ABI; no argument or return locations established.`,
        ),
      );
      state = 'unsupported';
      return result();
    }
    if (signature.returns.kind !== 'void') {
      const classified = classifyType(signature.returns);
      if (classified === null) {
        diagnostics.push(
          unsupported(
            'Return layout is unknown or unsupported; a hidden result pointer may shift all argument positions.',
          ),
        );
        state = signature.returns.kind === 'unknown' ? 'partial' : 'unsupported';
        return result();
      }
      if (
        signature.returns.kind === 'vector' &&
        signature.returns.lanes * signature.returns.element_bits === 128
      ) {
        returns.push(registerLocation(xmm0, 128));
      } else if (classified.kind === 'indirect') {
        hiddenResult = {
          kind: 'indirect',
          pointer: integerArguments[0]!,
          size: classified.size,
          alignment:
            signature.returns.kind === 'aggregate'
              ? signature.returns.alignment
              : classified.alignment,
        };
        returns.push(registerLocation(rax, 64)); // Same hidden-result pointer, not aggregate bytes.
        slots = 1;
      } else
        returns.push(registerLocation(classified.kind === 'float' ? xmm0 : rax, classified.bits));
    }
    if (signature.parameters === null) {
      diagnostics.push(
        unsupported(
          'Parameter count is unknown; names and unwind metadata do not establish a signature.',
        ),
      );
      state = 'partial';
      return result();
    }
    if (
      !Number.isSafeInteger(signature.fixed_parameter_count) ||
      signature.fixed_parameter_count < 0 ||
      signature.fixed_parameter_count > signature.parameters.length ||
      (!signature.variadic && signature.fixed_parameter_count !== signature.parameters.length)
    ) {
      diagnostics.push({
        code: 'invalid_input',
        severity: 'error',
        message: 'Invalid fixed parameter count for the supplied ABI signature.',
        evidence_ids: [],
      });
      state = 'unsupported';
      return result();
    }
    if (argument_count === null) {
      diagnostics.push(
        unsupported(
          'Only a known argument prefix is supplied; total arity and final stack allocation remain unknown.',
        ),
      );
      state = 'partial';
    }
    for (let index = 0; index < signature.parameters.length; index++, slots++) {
      const type = signature.parameters[index]!;
      let classified = classifyType(type);
      const locations: AbiLocation[] = [];
      parameters.push({ index, locations });
      if (classified === null) {
        diagnostics.push(
          unsupported(`Parameter ${index} has an unknown or unsupported Microsoft x64 layout.`),
        );
        if (state !== 'unsupported') state = type.kind === 'unknown' ? 'partial' : 'unsupported';
        continue;
      }
      // The API describes source arguments. Apply C default promotions to
      // ellipsis/unprototyped arguments; fixed float parameters remain binary32.
      if (
        signature.prototyped === false ||
        (signature.variadic && index >= signature.fixed_parameter_count)
      ) {
        if (classified.kind === 'float') classified = { kind: 'float', bits: 64 };
        else if (type.kind === 'integer' && classified.kind === 'integer' && classified.bits < 32)
          classified = { kind: 'integer', bits: 32 };
      }
      const offset = 40n + BigInt(slots - 4) * 8n;
      if (classified.kind === 'indirect') {
        locations.push({
          kind: 'indirect',
          pointer: slots < 4 ? integerArguments[slots]! : { stack_offset: offset },
          size: classified.size,
          alignment: classified.alignment,
        });
      } else if (slots >= 4) {
        locations.push({
          kind: 'stack',
          offset,
          size: BigInt(classified.bits / 8),
          alignment: 8,
          value_offset_bits: 0,
        });
      } else {
        locations.push(
          registerLocation(
            classified.kind === 'float' ? floatingArguments[slots]! : integerArguments[slots]!,
            classified.bits,
          ),
        );
        if (classified.kind === 'float' && (signature.variadic || signature.prototyped === false)) {
          locations.push(registerLocation(integerArguments[slots]!, classified.bits));
        }
      }
    }
    return result();
  }
}

export const windowsX64Abi = new WindowsX64Abi();

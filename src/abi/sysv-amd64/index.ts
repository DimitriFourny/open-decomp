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
function vector(index: number, width = 128): RegisterDescriptor {
  return Object.freeze({
    id: `x86_64:${width === 128 ? 'xmm' : 'zmm'}${index}`,
    root: `x86_64:zmm${index}`,
    bank: 'vector',
    offset_bits: 0,
    width_bits: width,
    root_width_bits: 512,
    role: 'general',
    write_rule: width === 512 ? 'replace_root' : 'preserve_other_bits',
  });
}
function state(name: string, bank: RegisterDescriptor['bank'], width: number): RegisterDescriptor {
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
const integers = ['rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9'].map(gpr);
const vectors = Array.from({ length: 8 }, (_, index) => vector(index));
const resultIntegers = ['rax', 'rdx'].map(gpr);
const al: RegisterDescriptor = Object.freeze({
  ...resultIntegers[0]!,
  id: 'x86_64:al',
  width_bits: 8,
  write_rule: 'preserve_other_bits',
});
const mxcsr = state('mxcsr', 'control', 32);
/** FP control state: the x87 control word and MXCSR[6:16] (DAZ, exception
 * masks, rounding control, FTZ) are callee-saved (SysV psABI 3.2.1). */
const fpControl: readonly RegisterDescriptor[] = Object.freeze([
  state('fpcsr', 'control', 16),
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
    ...['rax', 'rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9', 'r10', 'r11'].map(gpr),
    ...Array.from({ length: 32 }, (_, index) => vector(index, 512)),
    ...Array.from({ length: 8 }, (_, index) => state(`st${index}`, 'float', 80)),
    ...Array.from({ length: 8 }, (_, index) => state(`mm${index}`, 'vector', 64)),
    ...Array.from({ length: 8 }, (_, index) => state(`k${index}`, 'control', 64)),
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
    state('fpsw', 'flags', 16),
  ]),
  memory: 'unknown_read_write',
});
const align = (value: bigint, alignment: number): bigint =>
  ((value + BigInt(alignment - 1)) / BigInt(alignment)) * BigInt(alignment);
type Class = 'NO_CLASS' | 'INTEGER' | 'SSE' | 'SSEUP' | 'X87' | 'X87UP' | 'MEMORY';
interface Classification {
  readonly size: bigint;
  readonly alignment: number;
  readonly classes: readonly Class[];
  readonly extended: boolean;
}
const memory = (size: bigint, alignment: number, extended = false): Classification => ({
  size,
  alignment,
  classes: ['MEMORY'],
  extended,
});
function merge(a: Class, b: Class): Class {
  if (a === b || b === 'NO_CLASS') return a;
  if (a === 'NO_CLASS') return b;
  if (a === 'MEMORY' || b === 'MEMORY') return 'MEMORY';
  if (a === 'INTEGER' || b === 'INTEGER') return 'INTEGER';
  if (a === 'X87' || a === 'X87UP' || b === 'X87' || b === 'X87UP') return 'MEMORY';
  return 'SSE';
}
/** Resolved layouts only. Missing members are not inferred from aggregate size. */
function classify(
  type: AbiType,
  depth = 0,
  work = { remaining: 10_000 },
  absoluteOffset = 0n,
): Classification | null {
  if (depth > 64 || --work.remaining < 0) return null;
  switch (type.kind) {
    case 'void':
      return { size: 0n, alignment: 1, classes: [], extended: false };
    case 'unknown':
      return null;
    case 'pointer':
      return { size: 8n, alignment: 8, classes: ['INTEGER'], extended: false };
    case 'integer': {
      if (![8, 16, 32, 64, 128].includes(type.bits)) return null;
      return {
        size: BigInt(type.bits / 8),
        alignment: type.bits / 8,
        classes: type.bits === 128 ? ['INTEGER', 'INTEGER'] : ['INTEGER'],
        extended: false,
      };
    }
    case 'float':
      return {
        size: BigInt(type.bits === 80 ? 16 : type.bits / 8),
        alignment: type.bits === 80 ? 16 : type.bits / 8,
        classes:
          type.bits === 80 ? ['X87', 'X87UP'] : type.bits === 128 ? ['SSE', 'SSEUP'] : ['SSE'],
        extended: type.bits === 80,
      };
    case 'vector': {
      if (
        !Number.isSafeInteger(type.lanes) ||
        type.lanes < 1 ||
        ![8, 16, 32, 64].includes(type.element_bits)
      )
        return null;
      const bits = type.lanes * type.element_bits;
      if (bits !== 64 && bits !== 128) return null; // No AVX or compiler-specific small-vector contracts.
      return {
        size: BigInt(bits / 8),
        alignment: bits / 8,
        classes: bits === 128 ? ['SSE', 'SSEUP'] : ['SSE'],
        extended: false,
      };
    }
    case 'aggregate': {
      if (
        type.trivial_for_abi === false ||
        type.size < 0n ||
        type.size > 0xffff_ffff_ffff_ffffn ||
        !Number.isSafeInteger(type.alignment) ||
        type.alignment < 1 ||
        type.alignment > 65_536 ||
        (type.alignment & (type.alignment - 1)) !== 0 ||
        type.size % BigInt(type.alignment) !== 0n
      )
        return null;
      if (type.size === 0n)
        return type.fields.length
          ? null
          : { size: 0n, alignment: type.alignment, classes: [], extended: false };
      if (type.fields.length === 0) return null;
      const classes: Class[] = Array.from(
        { length: Number(((type.size > 64n ? 64n : type.size) + 7n) / 8n) },
        () => 'NO_CLASS',
      );
      let extended = false,
        inMemory = type.size > 64n;
      for (const field of type.fields) {
        const part = classify(field.type, depth + 1, work, absoluteOffset + field.offset);
        if (!part || field.offset < 0n || field.offset + part.size > type.size) return null;
        extended ||= part.extended;
        if (
          (absoluteOffset + field.offset) % BigInt(part.alignment) !== 0n ||
          part.classes.includes('MEMORY')
        )
          inMemory = true;
        if (inMemory) continue;
        for (let index = 0; index < part.classes.length; index++) {
          const start = field.offset + BigInt(index * 8),
            end =
              field.offset +
              (BigInt((index + 1) * 8) < part.size ? BigInt((index + 1) * 8) : part.size);
          for (let at = Number(start / 8n); at < Number((end + 7n) / 8n); at++)
            classes[at] = merge(classes[at]!, part.classes[index]!);
        }
      }
      if (
        inMemory ||
        classes.includes('MEMORY') ||
        classes.some((kind, index) => kind === 'X87UP' && classes[index - 1] !== 'X87') ||
        (classes.length > 2 &&
          (classes[0] !== 'SSE' || classes.slice(1).some((kind) => kind !== 'SSEUP')))
      )
        return memory(type.size, type.alignment, extended);
      // Wider SSE/SSEUP aggregates require AVX semantics, not a guessed MEMORY ABI.
      if (classes.length > 2) return null;
      for (let index = 0; index < classes.length; index++)
        if (
          classes[index] === 'SSEUP' &&
          classes[index - 1] !== 'SSE' &&
          classes[index - 1] !== 'SSEUP'
        )
          classes[index] = 'SSE';
      return { size: type.size, alignment: type.alignment, classes, extended };
    }
  }
}
function locations(
  value: Classification,
  integerBank: readonly RegisterDescriptor[],
  gi: number,
  vi: number,
): AbiLocation[] {
  const result: AbiLocation[] = [];
  for (let index = 0; index < value.classes.length; index++) {
    const kind = value.classes[index]!,
      offset = index * 64,
      width = Math.min(64, Number(value.size * 8n) - offset);
    if (kind === 'INTEGER' || kind === 'SSE')
      result.push({
        kind: 'register',
        register: kind === 'INTEGER' ? integerBank[gi++]! : vectors[vi++]!,
        value_offset_bits: offset,
        width_bits: width,
      });
    else if (kind === 'SSEUP') {
      const previous = result.pop()!;
      if (previous.kind === 'register')
        result.push({ ...previous, width_bits: previous.width_bits + width });
    }
  }
  return result;
}

/** System V AMD64 psABI, LP64 base ISA C layouts (section 3.2.3).
 * https://gitlab.com/x86-psABIs/x86-64-ABI/-/blob/master/x86-64-ABI/low-level-sys-info.tex
 * Stack offsets use callee-entry RSP, including its hardware return address.
 * stack_bytes excludes that push and caller locals. For partial layouts it is a
 * lower bound. Red-zone capability never establishes ownership or survives calls.
 * x87 value reconstruction, AVX argument types, nontrivial C++ and kernel/syscall
 * conventions are deliberately unsupported, not reclassified as ordinary C.
 */
export class SysVAMD64Abi implements AbiProfile {
  readonly name = 'System V AMD64 ABI';
  readonly version = '1';
  readonly id = 'sysv-amd64';
  readonly architecture = 'x86_64';
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
    long_double_bits: 80,
    long_double_storage_bits: 128,
    stack_alignment: 16,
    aggregate_max_alignment: 16,
  });
  readonly stack_pointer = gpr('rsp');
  readonly stack_return_address_bytes = 8n;
  readonly red_zone_bytes = 128n;
  readonly preserved = Object.freeze([
    ...['rbx', 'rbp', 'rsp', 'r12', 'r13', 'r14', 'r15'].map(gpr),
    ...fpControl,
  ]);
  readonly unknown_call_clobbers = clobbers;
  /** fenv/`fpset*` writers change the callee-saved control state. */
  readonly environment_writer_clobbers = fpControl;

  classifyCall(signature: Parameters<AbiProfile['classifyCall']>[0]): AbiCallLayout {
    const parameters: { index: number; locations: AbiLocation[] }[] = [],
      returns: AbiLocation[] = [],
      diagnostics: Diagnostic[] = [];
    let hidden_result: AbiLocation | null = null,
      gi = 0,
      vi = 0,
      stack = 0n,
      stackAlignment = 16;
    let status: AbiCallLayout['state'] = 'complete';
    const implicit = signature.variadic || signature.prototyped === false;
    const argument_count =
      signature.parameters !== null && (signature.argument_list_complete ?? !implicit)
        ? signature.parameters.length
        : null;
    const report = (message: string, unsupported = false): void => {
      diagnostics.push({
        code: 'unavailable_semantics',
        severity: 'warning',
        message,
        evidence_ids: [],
      });
      if (status !== 'unsupported') status = unsupported ? 'unsupported' : 'partial';
    };
    const result = (): AbiCallLayout => ({
      parameters,
      argument_count,
      returns,
      hidden_result,
      implicit_register_inputs: implicit
        ? [
            {
              register: al,
              unsigned_minimum: BigInt(vi),
              unsigned_maximum: 8n,
              purpose: 'vector_argument_register_upper_bound',
            },
          ]
        : [],
      stack_bytes: align(stack, stackAlignment),
      shadow_space: 0n,
      stack_alignment: stackAlignment,
      clobbers,
      diagnostics,
      state: status,
    });
    if (signature.calling_convention !== undefined && signature.calling_convention !== 'default') {
      report('Only the default System V AMD64 C calling convention is supported.', true);
      return { ...result(), implicit_register_inputs: [] };
    }
    const returned = classify(signature.returns);
    if (!returned) {
      report(
        'Unknown or unsupported return layout may require a hidden result pointer; argument allocation remains unknown.',
        signature.returns.kind !== 'unknown',
      );
      return result();
    }
    if (returned.classes.includes('MEMORY')) {
      hidden_result = {
        kind: 'indirect',
        pointer: integers[gi++]!,
        size: returned.size,
        alignment: returned.alignment,
      };
      returns.push({
        kind: 'register',
        register: resultIntegers[0]!,
        value_offset_bits: 0,
        width_bits: 64,
      });
    } else if (returned.classes.includes('X87'))
      report(
        'x87 extended-precision return reconstruction is unsupported; no return register value is asserted.',
        true,
      );
    else returns.push(...locations(returned, resultIntegers, 0, 0));
    if (returned.extended && !returned.classes.includes('X87'))
      report(
        'Extended-precision object storage is known, but x87 value reconstruction is unsupported.',
        true,
      );
    if (signature.parameters === null) {
      report(
        'Parameter count is unknown; vector-register usage and complete stack allocation are not established.',
      );
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
      status = 'unsupported';
      return result();
    }
    if (argument_count === null)
      report(
        'Only a known argument prefix is supplied; anonymous register usage, total arity and final stack allocation remain unknown.',
      );
    let uncertain = false;
    for (let index = 0; index < signature.parameters.length; index++) {
      let type = signature.parameters[index]!;
      const parameter = { index, locations: [] as AbiLocation[] };
      parameters.push(parameter);
      if (uncertain) continue;
      if (
        signature.prototyped === false ||
        (signature.variadic && index >= signature.fixed_parameter_count)
      ) {
        // Width alone cannot distinguish _Float16 (no default promotion) from
        // a compiler's storage-only half type. Do not invent a double actual.
        if (type.kind === 'float' && type.bits === 16) {
          report(
            `Parameter ${index} has an ambiguous half-precision default-promotion contract.`,
            true,
          );
          uncertain = true;
          continue;
        }
        if (type.kind === 'float' && type.bits === 32) type = { kind: 'float', bits: 64 };
        else if (type.kind === 'integer' && (type.bits === 8 || type.bits === 16))
          type = { kind: 'integer', bits: 32, signed: true };
      }
      const value = type.kind === 'void' ? null : classify(type);
      if (!value) {
        report(
          `Parameter ${index} has an unknown or unsupported layout; later register and stack allocation remains unknown.`,
          type.kind !== 'unknown',
        );
        uncertain = true;
        continue;
      }
      if (value.extended)
        report(
          `Parameter ${index} has known extended-precision storage but unsupported x87 value semantics.`,
          true,
        );
      const ni = value.classes.filter((kind) => kind === 'INTEGER').length,
        nv = value.classes.filter((kind) => kind === 'SSE').length;
      if (
        value.classes.includes('MEMORY') ||
        value.classes.includes('X87') ||
        gi + ni > 6 ||
        vi + nv > 8
      ) {
        const alignment = Math.max(8, value.alignment);
        stackAlignment = Math.max(stackAlignment, alignment);
        const start = align(stack, alignment),
          end = start + align(value.size, 8);
        if (align(end, stackAlignment) + 8n > 0xffff_ffff_ffff_ffffn) {
          report(
            `Parameter ${index} exceeds the AMD64 stack address range; later allocation remains unknown.`,
            true,
          );
          uncertain = true;
          continue;
        }
        parameter.locations.push({
          kind: 'stack',
          offset: start + 8n,
          size: value.size,
          alignment,
          value_offset_bits: 0,
        });
        stack = end;
      } else {
        parameter.locations.push(...locations(value, integers, gi, vi));
        gi += ni;
        vi += nv;
      }
    }
    return result();
  }
}
export const sysvAMD64Abi = new SysVAMD64Abi();

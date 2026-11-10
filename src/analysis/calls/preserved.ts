import type { RegisterDescriptor } from '../../core/index.js';
import { bitWidth, type Instruction, type Value } from '../../ir/index.js';

/** A bit range of one architectural register root. */
export interface RegisterSlice {
  readonly root: string;
  readonly offset_bits: number;
  readonly width_bits: number;
}

/** Whether a written-register set touches any bit of `register`. */
export function writesRegister(
  written: readonly RegisterSlice[],
  register: RegisterSlice,
): boolean {
  return written.some(
    (slice) =>
      slice.root === register.root &&
      slice.offset_bits < register.offset_bits + register.width_bits &&
      register.offset_bits < slice.offset_bits + slice.width_bits,
  );
}

/** The register outputs of a call that its callee's written-register set proves
 * unchanged, each with the value the same cell held before the call. Only general
 * integer and vector cells qualify: flags and every other bank stay clobbered. */
export function preservedCallOutputs(
  call: Extract<Instruction, { kind: 'call' }>,
  written: readonly RegisterSlice[],
): readonly (readonly [output: Value, input: Value])[] {
  const preserved: (readonly [Value, Value])[] = [];
  for (const { register, value } of call.register_outputs) {
    if (!preservable(register) || writesRegister(written, register)) continue;
    const input = call.register_inputs.find(
      (item) =>
        item.register.root === register.root &&
        item.register.offset_bits === register.offset_bits &&
        item.register.width_bits === register.width_bits,
    );
    if (input && bitWidth(input.value.type) === bitWidth(value.type))
      preserved.push([value, input.value]);
  }
  return preserved;
}

const preservable = (register: RegisterDescriptor): boolean =>
  register.role === 'general' && (register.bank === 'integer' || register.bank === 'vector');

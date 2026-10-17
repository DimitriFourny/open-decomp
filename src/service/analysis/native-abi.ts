import type { AbiProfile, AbiType, RegisterDescriptor } from '../../core/index.js';

const parameterRegisterBanks = new WeakMap<AbiProfile, readonly RegisterDescriptor[]>();

/** Storage capabilities, not a source prototype. Integer and floating banks
 * retain independent ABI allocation sequences; no host register names occur. */
export function parameterRegisters(abi: AbiProfile): readonly RegisterDescriptor[] {
  const cached = parameterRegisterBanks.get(abi);
  if (cached) return cached;
  const registers = new Map<string, RegisterDescriptor>();
  for (const type of [{ kind: 'pointer' }, { kind: 'float', bits: 64 }] as const) {
    const parameters: AbiType[] = Array.from({ length: 16 }, () => type);
    const layout = abi.classifyCall({
      returns: { kind: 'void' },
      parameters,
      variadic: false,
      fixed_parameter_count: parameters.length,
    });
    for (const parameter of layout.parameters)
      for (const location of parameter.locations)
        if (location.kind === 'register' && !registers.has(location.register.root))
          registers.set(location.register.root, {
            ...location.register,
            width_bits: location.width_bits,
          });
  }
  const result = [...registers.values()];
  parameterRegisterBanks.set(abi, result);
  return result;
}

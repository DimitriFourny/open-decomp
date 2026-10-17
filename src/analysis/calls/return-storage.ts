import type { AbiProfile, AbiType, RegisterDescriptor } from '../../core/index.js';

const capabilities = new WeakMap<AbiProfile, readonly RegisterDescriptor[]>();

/** Possible return storage, not a recovered source result list. The layouts are
 * ABI capability probes only: their synthetic field offsets/numbers never become
 * author structure fields or evidence that a spare register is a result. */
export function possibleAbiReturnStorage(abi: AbiProfile): readonly RegisterDescriptor[] {
  const prior = capabilities.get(abi);
  if (prior) return prior;
  const word: AbiType = { kind: 'integer', bits: abi.layout.pointer_bits, signed: false };
  const wordBytes = BigInt(abi.layout.pointer_bits / 8);
  const probes: AbiType[] = [word, { kind: 'float', bits: 32 }, { kind: 'float', bits: 64 },
    { kind: 'float', bits: 80 }, { kind: 'float', bits: 128 },
    ...[4, 8, 16].map((lanes): AbiType => ({ kind: 'vector', element: 'integer', element_bits: 32, lanes })),
    { kind: 'aggregate', size: wordBytes * 2n, alignment: Number(wordBytes), fields: [
      { offset: 0n, type: word }, { offset: wordBytes, type: word }] },
    { kind: 'aggregate', size: 16n, alignment: 8, fields: [
      { offset: 0n, type: { kind: 'float', bits: 64 } }, { offset: 8n, type: { kind: 'float', bits: 64 } }] },
    { kind: 'aggregate', size: 16n, alignment: 4, fields: [0n, 4n, 8n, 12n].map((offset) =>
      ({ offset, type: { kind: 'float' as const, bits: 32 as const } })) },
  ];
  const roots = new Map<string, RegisterDescriptor>();
  for (const returns of probes) {
    const layout = abi.classifyCall({ returns, parameters: [], variadic: false, fixed_parameter_count: 0 });
    for (const location of layout.returns) {
      if (location.kind !== 'register') continue;
      const register = location.register, previous = roots.get(register.root);
      roots.set(register.root, { ...register, offset_bits: 0,
        width_bits: Math.max(previous?.width_bits ?? 0, register.offset_bits + location.width_bits) });
    }
  }
  const result = [...roots.values()];
  capabilities.set(abi, result);
  return result;
}

import { OperationError, type AbiLocation, type AbiProfile, type AbiSignature, type AbiType, type OperationContext, type RegisterDescriptor } from '../../core/index.js';

/** Storage slices that may be observable at a native ABI boundary, not a
 * signature, actual argument list, or proof that any result is written. Source
 * SSA separately keeps every root actually read/written by the lifted body. */
export function abiObservableRegisterMasks(abi: AbiProfile, context: OperationContext): ReadonlyMap<string, bigint> {
  context.checkpoint(1);
  if (!Array.isArray(abi.preserved))
    throw new OperationError({ code: 'unavailable_semantics', severity: 'error',
      message: 'ABI preservation contract is unavailable for source SSA register masks', evidence_ids: [] });
  const masks = new Map<string, bigint>();
  const note = (register: RegisterDescriptor, width = register.width_bits): void => {
    context.checkpoint(1);
    const mask = ((1n << BigInt(width)) - 1n) << BigInt(register.offset_bits);
    masks.set(register.root, (masks.get(register.root) ?? 0n) | mask);
  };
  note(abi.stack_pointer);
  // Preservation is observable, including when an unsupported effect clobbers
  // storage an ordinary call would preserve. Its exact slice does not assert
  // preservation or observation of unrelated high architectural carrier bits.
  for (const register of abi.preserved) note(register);
  const noteLocation = (location: AbiLocation | null): void => {
    if (location?.kind === 'register') note(location.register, location.width_bits);
    else if (location?.kind === 'indirect' && !('stack_offset' in location.pointer)) note(location.pointer);
    else context.checkpoint(1);
  };
  const probe = (signature: AbiSignature) => {
    context.checkpoint(1);
    const layout = abi.classifyCall(signature);
    for (const location of layout.returns) noteLocation(location);
    noteLocation(layout.hidden_result);
    for (const parameter of layout.parameters)
      for (const location of parameter.locations) noteLocation(location);
    for (const implicit of layout.implicit_register_inputs) note(implicit.register);
    return layout;
  };
  const types: AbiType[] = [{ kind: 'pointer' }];
  for (const bits of [1, 8, 16, 32, 64, 128])
    for (const signed of [false, true]) types.push({ kind: 'integer', bits, signed });
  for (const bits of [16, 32, 64, 80, 128] as const) types.push({ kind: 'float', bits });
  const homogeneous: Extract<AbiType, { kind: 'float' | 'vector' }>[] = types.filter((type) => type.kind === 'float');
  for (const element of ['integer', 'float'] as const)
    for (const element_bits of [8, 16, 32, 64])
      for (const bits of [64, 128]) {
        const type: AbiType = { kind: 'vector', element, element_bits, lanes: bits / element_bits };
        types.push(type);
        homogeneous.push(type);
      }
  const word = abi.layout.pointer_bits / 8;
  const wordType: AbiType = { kind: 'integer', bits: abi.layout.pointer_bits, signed: false };
  // Two words expose secondary aggregate results. Three non-homogeneous words
  // expose hidden-result pointers without assuming their architectural names.
  for (const count of [2, 3]) types.push({ kind: 'aggregate', size: BigInt(word * count), alignment: word,
    fields: Array.from({ length: count }, (_, index) => ({ offset: BigInt(index * word), type: wordType })) });
  for (const type of homogeneous)
    for (let count = 1; count <= 4; count++) {
      const size = type.kind === 'float' ? (type.bits === 80 ? 16 : type.bits / 8)
        : type.element_bits * type.lanes / 8;
      types.push({ kind: 'aggregate', size: BigInt(size * count),
        alignment: Math.min(size, abi.layout.aggregate_max_alignment),
        fields: Array.from({ length: count }, (_, index) => ({ offset: BigInt(index * size), type })) });
    }
  for (const type of types) {
    probe({ returns: type, parameters: [], variadic: false, fixed_parameter_count: 0 });
    const parameters: AbiType[] = [type];
    // Probe each homogeneous allocation sequence until its final member spills
    // or is unsupported. This discovers bank capacity, never source arity, and
    // does not impose a guessed architectural register-count limit.
    for (;;) {
      const layout = probe({ returns: { kind: 'void' }, parameters, variadic: false,
        fixed_parameter_count: parameters.length });
      const last = layout.parameters.at(-1);
      if (!last?.locations.some((location) => location.kind === 'register' ||
        (location.kind === 'indirect' && !('stack_offset' in location.pointer)))) break;
      const count = parameters.length;
      for (let index = 0; index < count; index++) {
        context.checkpoint(1);
        parameters.push(type);
      }
    }
  }
  // These classify machine-boundary inputs such as a vector-bank upper bound,
  // independently of any known source actuals or complete prototype.
  probe({ returns: { kind: 'void' }, parameters: null, variadic: true, fixed_parameter_count: 0 });
  probe({ returns: { kind: 'void' }, parameters: null, variadic: false,
    prototyped: false, fixed_parameter_count: 0 });
  return masks;
}

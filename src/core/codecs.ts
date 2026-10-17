import { z } from 'zod';
import { parseHexU64, formatHexU64 } from './integers.js';
import { addressSchema, rangeSchema, imageIdSchema, hexU64Schema } from './primitives.js';

/** Runtime/wire codecs stay separate from MCP-facing JSON Schema (which contains no bigint). */
export const machineU64Schema = z
  .bigint()
  .min(0n)
  .max((1n << 64n) - 1n);
export const machineAddressSchema = z.strictObject({
  image_id: imageIdSchema,
  space: z.enum(['va', 'rva', 'file']),
  value: machineU64Schema,
});
export const machineRangeSchema = z
  .strictObject({ start: machineAddressSchema, size: machineU64Schema })
  .superRefine((range, context) => {
    if (range.start.value + range.size > 1n << 64n)
      context.addIssue({ code: 'custom', message: 'Range exceeds unsigned 64-bit address space' });
  });
export const hexU64Codec = z.codec(hexU64Schema, machineU64Schema, {
  decode: parseHexU64,
  encode: (value) => hexU64Schema.parse(formatHexU64(value)),
});
export const addressCodec = z.codec(addressSchema, machineAddressSchema, {
  decode: (wire) => ({ ...wire, value: parseHexU64(wire.value) }),
  encode: (address) => ({
    ...address,
    value: hexU64Schema.parse(z.encode(hexU64Codec, address.value)),
  }),
});
export const rangeCodec = z.codec(rangeSchema, machineRangeSchema, {
  decode: (wire) => ({ start: z.decode(addressCodec, wire.start), size: parseHexU64(wire.size) }),
  encode: (range) => ({
    start: addressSchema.parse(z.encode(addressCodec, range.start)),
    size: hexU64Schema.parse(z.encode(hexU64Codec, range.size)),
  }),
});

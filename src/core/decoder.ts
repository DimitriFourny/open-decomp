import { z } from 'zod';
import {
  addressSchema,
  rangeSchema,
  entityIdSchema,
  hexU64Schema,
  diagnosticSchema,
  evidenceRefsSchema,
  type Diagnostic,
  type Internal,
} from './primitives.js';
import type { Address, AddressRange } from './addresses.js';

/** Register identities are ISA-qualified, independent of decoder-library enum values. */
export const registerSchema = z
  .strictObject({
    id: z.string().min(1).max(128),
    bank: z.enum(['integer', 'float', 'vector', 'flags', 'segment', 'control']),
    root: z.string().min(1).max(128),
    offset_bits: z.number().int().min(0).max(8191),
    width_bits: z.number().int().min(1).max(8192),
    root_width_bits: z.number().int().min(1).max(8192),
    role: z.enum(['general', 'stack_pointer', 'program_counter', 'zero', 'flags']),
    write_rule: z.enum(['preserve_other_bits', 'zero_extend_root', 'replace_root', 'discard']),
  })
  .superRefine((register, context) => {
    if (register.offset_bits + register.width_bits > register.root_width_bits)
      context.addIssue({ code: 'custom', message: 'Register slice exceeds its root' });
    if (register.role === 'zero' && register.write_rule !== 'discard')
      context.addIssue({ code: 'custom', message: 'Zero-register writes are discarded' });
  });
export type RegisterDescriptor = z.infer<typeof registerSchema>;
export const flowSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('fallthrough'), next: addressSchema }),
    z.strictObject({
      kind: z.literal('branch'),
      target: addressSchema,
      conditional: z.boolean(),
      fallthrough: addressSchema.nullable(),
    }),
    z.strictObject({
      kind: z.literal('call'),
      target: addressSchema.nullable(),
      fallthrough: addressSchema,
      indirect: z.boolean(),
    }),
    z.strictObject({
      kind: z.literal('indirect_branch'),
      conditional: z.boolean(),
      fallthrough: addressSchema.nullable(),
    }),
    z.strictObject({ kind: z.literal('return') }),
    z.strictObject({
      kind: z.literal('trap'),
      reason: z.string().min(1),
      conditional: z.boolean(),
      fallthrough: addressSchema.nullable(),
    }),
    z.strictObject({
      kind: z.literal('unknown'),
      reason: z.string().min(1),
      may_fallthrough: z.boolean(),
    }),
  ])
  .superRefine((flow, context) => {
    if ('conditional' in flow && flow.conditional !== (flow.fallthrough !== null))
      context.addIssue({
        code: 'custom',
        message: 'Only conditional transfers have a fallthrough',
      });
    if (flow.kind === 'call' && flow.indirect !== (flow.target === null))
      context.addIssue({
        code: 'custom',
        message: 'Direct calls require a decoded target; indirect calls remain unresolved',
      });
  });
export type DecodedFlow =
  | { readonly kind: 'fallthrough'; readonly next: Address }
  | {
      readonly kind: 'branch';
      readonly target: Address;
      readonly conditional: boolean;
      readonly fallthrough: Address | null;
    }
  | {
      readonly kind: 'call';
      readonly target: Address | null;
      readonly fallthrough: Address;
      readonly indirect: boolean;
    }
  | {
      readonly kind: 'indirect_branch';
      readonly conditional: boolean;
      readonly fallthrough: Address | null;
    }
  | { readonly kind: 'return' }
  | {
      readonly kind: 'trap';
      readonly reason: string;
      readonly conditional: boolean;
      readonly fallthrough: Address | null;
    }
  | { readonly kind: 'unknown'; readonly reason: string; readonly may_fallthrough: boolean };
const accessSchema = z.enum([
  'read',
  'write',
  'read_write',
  'conditional_read',
  'conditional_write',
  'read_conditional_write',
  'none',
  'unknown',
]);
export const registerAccessSchema = z.strictObject({
  register: registerSchema,
  access: accessSchema,
  implicit: z.boolean(),
});
const signedSchema = z.strictObject({ negative: z.boolean(), magnitude: hexU64Schema });
const scalableRegisterSchema = z.strictObject({
  kind: z.literal('scalable_register'),
  bank: z.enum(['vector', 'predicate']),
  index: z.number().int().min(0).max(31),
  element: z.string().nullable(),
  mode: z.enum(['m', 'z']).nullable(),
});
export const armOperandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('register'),
    register: registerSchema,
    access: accessSchema,
    arrangement: z.string().nullable(),
    lane: z.number().int().min(0).max(255).nullable(),
  }),
  z.strictObject({
    kind: z.literal('immediate'),
    value: signedSchema,
    width_bits: z.number().int().min(1).max(64),
  }),
  z.strictObject({
    kind: z.literal('relative'),
    displacement: signedSchema,
    target: addressSchema,
  }),
  z.strictObject({
    kind: z.literal('memory'),
    base: registerSchema,
    index: registerSchema.nullable(),
    displacement: signedSchema,
    extend: z.enum(['none', 'uxtw', 'sxtw', 'sxtx', 'lsl']),
    shift: z.number().int().min(0).max(63),
    writeback: z.enum(['none', 'pre', 'post']),
    access_bits: z.number().int().min(0).max(2048),
    access: accessSchema,
  }),
  z.strictObject({ kind: z.literal('condition'), code: z.number().int().min(0).max(15) }),
  z.strictObject({
    kind: z.literal('system'),
    op0: z.number().int().min(0).max(3),
    op1: z.number().int().min(0).max(7),
    crn: z.number().int().min(0).max(15),
    crm: z.number().int().min(0).max(15),
    op2: z.number().int().min(0).max(7),
  }),
  z.strictObject({
    kind: z.literal('modifier'),
    operation: z.enum([
      'lsl',
      'lsr',
      'asr',
      'ror',
      'uxtb',
      'uxth',
      'uxtw',
      'uxtx',
      'sxtb',
      'sxth',
      'sxtw',
      'sxtx',
    ]),
    amount: z.number().int().min(0).max(63),
  }),
  z.strictObject({ kind: z.literal('floating_immediate'), value: z.number() }),
  z.strictObject({ kind: z.literal('opaque'), text: z.string().max(4096) }),
  scalableRegisterSchema,
  z.strictObject({
    kind: z.literal('vector_group'),
    registers: z.array(scalableRegisterSchema).min(1).max(32),
    style: z.enum(['list', 'range']),
  }),
  z.strictObject({
    kind: z.literal('za'),
    element: z.string(),
    index: z.number().int().min(0).nullable(),
    selector: z.number().int().min(0).nullable(),
    offset: z.number().int().min(0).nullable(),
    end: z.number().int().min(0).nullable(),
    group: z.literal([2, 4]).nullable(),
  }),
  z.strictObject({
    kind: z.literal('scalable_memory'),
    base: z.union([scalableRegisterSchema, registerSchema]),
    index: z.union([scalableRegisterSchema, registerSchema]).nullable(),
    displacement: signedSchema,
    modifier: z.string().nullable(),
    shift: z.number().int().min(0).max(63),
    writeback: z.enum(['none', 'pre', 'post']),
  }),
]);
export const armPayloadSchema = z
  .strictObject({
    architecture: z.literal('arm64'),
    encoding: z.string().min(1),
    canonical_encoding: z.string().min(1),
    alias: z.string().nullable(),
    word: hexU64Schema,
    fields: z.record(z.string().min(1), hexU64Schema),
    operands: z.array(armOperandSchema).max(32),
    availability: z.enum(['available', 'feature_disabled', 'reserved', 'undefined']),
    required_features: z.array(z.string().min(1)).max(128),
    registers: z.array(registerAccessSchema).max(128),
    behavior: z.enum(['instruction', 'nop', 'undefined', 'unknown']),
  })
  .superRefine((payload, context) => {
    if (hexU64Schema.safeParse(payload.word).success && BigInt(payload.word) > 0xffffffffn)
      context.addIssue({ code: 'custom', message: 'ARM64 encoding exceeds 32 bits' });
  });
export const x86MemorySchema = z.strictObject({
  segment: registerSchema.nullable(),
  base: registerSchema.nullable(),
  index: registerSchema.nullable(),
  scale: z.literal([1, 2, 4, 8]),
  displacement: signedSchema,
  address_bits: z.literal([16, 32, 64]),
  access_bits: z.number().int().min(0).max(65536),
  rip_relative_target: addressSchema.nullable(),
  broadcast: z.boolean(),
  access: accessSchema,
});
export const x86OperandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('register'), register: registerSchema, access: accessSchema }),
  z.strictObject({
    kind: z.literal('immediate'),
    value: hexU64Schema,
    encoded_bits: z.literal([0, 8, 16, 32, 64]),
    effective_bits: z.literal([8, 16, 32, 64]),
    sign_extended: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('relative'),
    target: addressSchema,
    displacement: signedSchema,
    encoded_bits: z.literal([8, 16, 32]),
  }),
  z.strictObject({ kind: z.literal('memory'), memory: x86MemorySchema }),
  z.strictObject({
    kind: z.literal('far_pointer'),
    selector: z.number().int().min(0).max(65535),
    offset: hexU64Schema,
  }),
]);
const flagsSchema = z.strictObject({
  read: hexU64Schema,
  written: hexU64Schema,
  cleared: hexU64Schema,
  set: hexU64Schema,
  undefined: hexU64Schema,
  preserved: hexU64Schema,
});
export const x86PayloadSchema = z.strictObject({
  architecture: z.literal('x86_64'),
  encoding: z.string().min(1),
  mnemonic: z.string().min(1),
  operand_bits: z.literal([0, 8, 16, 32, 64, 80, 128, 256, 512, 8192]),
  address_bits: z.literal([16, 32, 64]),
  prefixes: z.strictObject({
    bytes: z.array(z.number().int().min(0).max(255)).max(15),
    lock: z.boolean(),
    rep: z.boolean(),
    repne: z.boolean(),
    rex: z.number().int().min(0).max(255).nullable(),
    segment: registerSchema.nullable(),
    encoding: z.enum(['legacy', 'vex', 'evex', 'xop', 'mvex']),
    mask: registerSchema.nullable(),
    zeroing: z.boolean(),
    rounding: z.enum(['none', 'nearest', 'down', 'up', 'zero']),
    suppress_exceptions: z.boolean(),
  }),
  operands: z.array(x86OperandSchema).max(16),
  registers: z.array(registerAccessSchema).max(256),
  memory: z.array(x86MemorySchema).max(64),
  /** Architectural RFLAGS and x87 status-word bit positions are separate namespaces. */
  flags: flagsSchema,
  fpu_flags: flagsSchema.nullable(),
  required_features: z.array(z.string().min(1)).max(128),
  privileged: z.boolean(),
});
export const instructionSchema = z
  .strictObject({
    id: entityIdSchema,
    address: addressSchema,
    bytes: rangeSchema,
    size: z.number().int().min(1).max(15),
    validity: z.enum(['valid', 'invalid', 'undefined', 'reserved', 'feature_disabled']),
    payload: z.discriminatedUnion('architecture', [armPayloadSchema, x86PayloadSchema]).nullable(),
    flow: flowSchema,
    diagnostics: z.array(diagnosticSchema).max(1000),
    evidence_ids: evidenceRefsSchema,
  })
  .superRefine((instruction, context) => {
    if (instruction.validity === 'valid' && instruction.payload === null)
      context.addIssue({
        code: 'custom',
        message: 'Valid instructions require structured payloads',
      });
    if (instruction.payload?.architecture === 'arm64' && instruction.size !== 4)
      context.addIssue({ code: 'custom', message: 'ARM64 instructions have four bytes' });
    if (
      hexU64Schema.safeParse(instruction.bytes.size).success &&
      Number.isSafeInteger(instruction.size) &&
      BigInt(instruction.bytes.size) !== BigInt(instruction.size)
    )
      context.addIssue({
        code: 'custom',
        message: 'Instruction byte reference has inconsistent size',
      });
  });

/** Internal payload conversion is structural and does not import decoder-library objects. */
type SignedWire = z.infer<typeof signedSchema>;
type InternalValue<T> =
  T extends z.infer<typeof addressSchema>
    ? Address
    : T extends SignedWire
      ? bigint
      : T extends readonly (infer U)[]
        ? readonly InternalValue<U>[]
        : T extends object
          ? {
              readonly [K in keyof T]: K extends
                | 'word'
                | 'fields'
                | 'value'
                | 'offset'
                | 'read'
                | 'written'
                | 'cleared'
                | 'set'
                | 'undefined'
                | 'preserved'
                ? T[K] extends string
                  ? bigint
                  : K extends 'fields'
                    ? Readonly<Record<string, bigint>>
                    : InternalValue<T[K]>
                : InternalValue<T[K]>;
            }
          : T;
export type Arm64Payload = InternalValue<z.infer<typeof armPayloadSchema>>;
export type X86Payload = InternalValue<z.infer<typeof x86PayloadSchema>>;
export interface DecodedInstruction {
  readonly id: string;
  readonly address: Address;
  readonly bytes: AddressRange;
  readonly size: number;
  readonly validity: z.infer<typeof instructionSchema>['validity'];
  readonly payload: Arm64Payload | X86Payload | null;
  readonly flow: DecodedFlow;
  readonly diagnostics: readonly Diagnostic[];
  readonly evidence_ids: readonly string[];
}
export interface DecodeGap {
  readonly range: AddressRange;
  readonly reason: 'truncated' | 'unmapped' | 'data' | 'budget';
  readonly diagnostics: readonly Diagnostic[];
}
export const cfgEdgeSchema = z.strictObject({
  from: entityIdSchema,
  to: entityIdSchema.nullable(),
  target: addressSchema.nullable(),
  kind: z.enum(['fallthrough', 'branch', 'call', 'tail_call', 'return', 'trap', 'unknown']),
  conditional: z.boolean(),
  evidence_ids: evidenceRefsSchema,
});
export const cfgBlockSchema = z.strictObject({
  id: entityIdSchema,
  ranges: z.array(rangeSchema).min(1).max(1000),
  instructions: z.array(entityIdSchema).max(100000),
  edges: z.array(cfgEdgeSchema).max(10000),
});
export type CFGEdge = Internal<z.infer<typeof cfgEdgeSchema>>;
export type CFGBlock = Internal<z.infer<typeof cfgBlockSchema>>;

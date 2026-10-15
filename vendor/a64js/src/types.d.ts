import type { MemoryOperand, SimdRegisterOperand, VectorGroupOperand, ZaOperand } from "./operand-types.js";
export type { ElementSize, MemoryModifier, MemoryOperand, SimdRegisterOperand, VectorGroupOperand, ZaOperand } from "./operand-types.js";
export type FeatureName = string;
export type GuardCheck = {
    kind: "feature";
    feature: string;
    implemented: boolean;
} | {
    kind: "eq";
    field: string;
    mask: number;
    lsb: number;
    value: number;
} | {
    kind: "ne";
    field: string;
    mask: number;
    lsb: number;
    value: number;
} | {
    kind: "eq_field";
    field: string;
    otherField: string;
} | {
    kind: "ne_field";
    field: string;
    otherField: string;
} | {
    kind: "eq_concat";
    parts: Array<{
        field: string;
        msb: number;
        lsb: number;
    }>;
    value: number;
} | {
    kind: "ne_concat";
    parts: Array<{
        field: string;
        msb: number;
        lsb: number;
    }>;
    value: number;
};
export type Guard = {
    all: GuardCheck[];
    outcome?: "undefined" | "nop";
};
export type GeneratedField = {
    name: string;
    lsb: number;
    width: number;
};
export type FeatureGuard = {
    feature: FeatureName;
    all: GuardCheck[];
};
export type GeneratedEncoding = {
    instructionId: string;
    encodingId: string;
    mnemonic: string;
    className: string;
    fileName: string;
    operandSchemaId?: string;
    operandFamilyId?: string;
    canonicalEncodingId?: string;
    canonicalFileName?: string;
    guardDiagnostics?: string[];
    bitCount?: number;
    mask: number;
    value: number;
    fields: GeneratedField[];
    features: FeatureName[];
    featureGuards: FeatureGuard[];
    guards: Guard[];
};
export type RegisterName = {
    kind: "reg";
    width: 32 | 64;
    index: number;
    zeroName: "zr" | "sp";
};
export type ImmediateOperand = {
    kind: "imm";
    value: bigint;
    signed?: boolean;
    shift?: number;
};
export type LabelOperand = {
    kind: "label";
    offset: bigint;
    absolute?: bigint;
    pageRelative?: boolean;
};
export type ConditionOperand = {
    kind: "cond";
    code: number;
    suffix: string;
};
export type SystemRegisterOperand = {
    kind: "sysreg";
    op0: number;
    op1: number;
    CRn: number;
    CRm: number;
    op2: number;
};
export type VectorRegisterOperand = {
    kind: "vec";
    index: number;
    lane?: "b" | "h" | "s" | "d" | "q";
    laneIndex?: number;
};
export type PredicateRegisterOperand = {
    kind: "pred";
    index: number;
    lane?: "b" | "h" | "s" | "d";
    mode?: "m" | "z";
};
export type FloatingImmediateOperand = {
    kind: "fpimm";
    value: number;
};
export type TextOperand = {
    kind: "text";
    text: string;
};
export type Operand = RegisterName | ImmediateOperand | LabelOperand | ConditionOperand | SystemRegisterOperand | VectorRegisterOperand | PredicateRegisterOperand | FloatingImmediateOperand | SimdRegisterOperand | VectorGroupOperand | MemoryOperand | ZaOperand | TextOperand;
export type DecodeStatus = "ok" | "unknown" | "undefined";
export type DecodedInstruction = {
    status: DecodeStatus;
    word: number;
    encoding?: GeneratedEncoding;
    mnemonic?: string;
    fields?: Record<string, number>;
    operands?: Operand[];
    errors?: string[];
    availability?: "available" | "unavailable";
    behavior?: "instruction" | "nop" | "undefined";
};
export type DecodeOptions = {
    features?: Iterable<FeatureName>;
};
export type FormatOptions = {
    pc?: bigint | number;
    onUnknown?: "error" | "raw";
};
export type BlockOptions = DecodeOptions & FormatOptions & {
    /** Reject incomplete words by default; ignore only when explicitly requested. */
    trailingBytes?: "error" | "ignore";
};
export type DecodedLine = {
    address: bigint;
    word: number;
    text: string;
    decoded: DecodedInstruction;
};

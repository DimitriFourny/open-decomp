import type { ImmediateOperand, RegisterName, VectorRegisterOperand } from "./types.js";
export type ElementSize = "b" | "h" | "s" | "d" | "q";
/** A scalar SIMD/FP register, an arranged V register, or an indexed element. */
export type SimdRegisterOperand = {
    kind: "simd";
    index: number;
} & ({
    scalar: ElementSize;
    arrangement?: never;
    element?: never;
    laneIndex?: never;
} | {
    scalar?: never;
    arrangement: {
        lanes: number;
        element: ElementSize;
    };
    element?: never;
    laneIndex?: number;
} | {
    scalar?: never;
    arrangement?: never;
    element: ElementSize;
    laneIndex: number;
});
/** An ordered group of scalable vector registers, including register wraparound. */
export type VectorGroupOperand = {
    kind: "vector-group";
    registers: VectorRegisterOperand[];
    style: "list" | "range";
};
export type MemoryModifier = {
    kind: "lsl" | "uxtb" | "uxth" | "uxtw" | "sxtb" | "sxth" | "sxtw" | "sxtx" | "mul vl";
    amount?: number;
};
/** Address components stay structured; mode describes where writeback is printed. */
export type MemoryOperand = {
    kind: "mem";
    base: RegisterName | VectorRegisterOperand;
    offset?: ImmediateOperand | RegisterName | VectorRegisterOperand;
    modifier?: MemoryModifier;
    mode?: "offset" | "pre-index" | "post-index";
    immediateFormat?: "decimal" | "hex";
};
/** A ZA tile or a selected ZA array vector, with an optional vector group. */
export type ZaOperand = {
    kind: "za";
    lane: ElementSize;
    index?: number;
    slice?: {
        selector: number;
        offset: number;
        end?: number;
        group?: 2 | 4;
    };
};

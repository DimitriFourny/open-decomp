import { OperandDecodeError } from "./operand-errors.js";
import { buildOperandSchema, gpOperand, operandField, vectorGroup } from "./operand-schemas.js";
const schema = (rules) => (instruction) => buildOperandSchema(instruction, rules);
const laneFromSize = (instruction) => ["b", "h", "s", "d"][operandField(instruction, "size")];
const groupCount = (instruction) => instruction.encoding.className === "Four registers" ? 4 : 2;
function multiVectorArithmetic(instruction) {
    const count = groupCount(instruction);
    const lane = instruction.encoding.mnemonic.startsWith("BF") ? "h" : laneFromSize(instruction);
    const group = { kind: "group", field: "Zdn", count, lane };
    return buildOperandSchema(instruction, [group, group,
        instruction.encoding.fileName.endsWith("_zzw.xml")
            ? { kind: "group", field: "Zm", count, lane }
            : { kind: "vector", field: "Zm", lane },
    ]);
}
function fp8Dot(instruction) {
    const file = instruction.encoding.fileName;
    const twoWay = file.includes("2way");
    const vectorBits = operandField(instruction, "Q") === 1 ? 128 : 64;
    const destinationLane = twoWay ? "h" : "s";
    const destinationElements = vectorBits / (twoWay ? 16 : 32);
    const source = { kind: "simd", field: "Rn", lane: "b", lanes: vectorBits / 8 };
    const third = file.endsWith("vec.xml")
        ? { ...source, field: "Rm" }
        : {
            kind: "simd", field: "Rm", lane: "b", lanes: twoWay ? 2 : 4,
            index: operandField(instruction, "Rm") | (twoWay ? 0 : operandField(instruction, "M") << 4),
            laneIndex: (operandField(instruction, "H") << (twoWay ? 2 : 1)) |
                (operandField(instruction, "L") << (twoWay ? 1 : 0)) |
                (twoWay ? operandField(instruction, "M") : 0),
        };
    return buildOperandSchema(instruction, [
        { kind: "simd", field: "Rd", lane: destinationLane, lanes: destinationElements }, source, third,
    ]);
}
function predicatedConversion(instruction) {
    // XML names describe semantic source and destination types; x/w mean 64/32-bit integers.
    const suffix = instruction.encoding.encodingId.split("_").at(-1);
    const match = /^(fp16|fp32|fp64|[hwsdx])2(fp16|fp32|fp64|[hwsdx])(z)?$/.exec(suffix);
    if (!match) {
        throw new OperandDecodeError("unsupported", `unsupported conversion layout: ${suffix}`, instruction.encoding.fileName);
    }
    const lanes = { h: "h", fp16: "h", w: "s", s: "s", fp32: "s", x: "d", d: "d", fp64: "d" };
    return buildOperandSchema(instruction, [
        { kind: "vector", field: "Zd", lane: lanes[match[2]] },
        { kind: "predicate", field: "Pg", mode: match[3] ? "z" : "m" },
        { kind: "vector", field: "Zn", lane: lanes[match[1]] },
    ]);
}
function signedNonTemporalLoad(instruction) {
    const fields = instruction.fields;
    const lane = instruction.encoding.encodingId.includes("_s_") ? "s" : "d";
    return [
        vectorGroup(operandField(instruction, "Zt"), 1, lane),
        { kind: "pred", index: operandField(instruction, "Pg"), mode: "z" },
        {
            kind: "mem", base: { kind: "vec", index: operandField(instruction, "Zn"), lane },
            offset: fields.Rm === 31 ? undefined : gpOperand(operandField(instruction, "Rm")),
        },
    ];
}
function twoVectorNarrowingShift(instruction) {
    const byteDestination = instruction.encoding.encodingId.endsWith("_b");
    const destinationBits = byteDestination ? 8 : 16;
    return buildOperandSchema(instruction, [
        { kind: "vector", field: "Zd", lane: byteDestination ? "b" : "h" },
        { kind: "group", field: "Zn", count: 2, lane: byteDestination ? "h" : "s" },
        { kind: "immediate", value: BigInt(destinationBits - operandField(instruction, byteDestination ? "imm3" : "imm4")), signed: true },
    ]);
}
export const TYPED_OPERAND_FAMILIES = [
    { id: "scalar-bfloat16-conversion", files: ["bfcvt_float.xml"], build: schema([{ kind: "scalar", field: "Rd", lane: "h" }, { kind: "scalar", field: "Rn", lane: "s" }]) },
    { id: "pauth-lr-auth-register", files: ["autiasppcr.xml", "autibsppcr.xml"], build: schema([{ kind: "gp", field: "Rn", width: 64 }]) },
    { id: "pauth-lr-return-register", files: ["retasppcr_reg.xml"], build: schema([{ kind: "gp", field: "Rm", width: 64 }]) },
    { id: "sme-fp8-multi-vector-arithmetic", files: ["famax_mz_zzw.xml", "famin_mz_zzw.xml", "fscale_mz_zzv.xml", "fscale_mz_zzw.xml"], build: multiVectorArithmetic },
    { id: "advsimd-fp8-dot", files: ["fdot_advsimd_2wayvec.xml", "fdot_advsimd_4wayvec.xml", "fdot_advsimd_2wayelem.xml", "fdot_advsimd_4wayelem.xml"], build: fp8Dot },
    { id: "sve-signed-nontemporal-vector-base-load", files: ["ldnt1sb_z_p_ar.xml", "ldnt1sh_z_p_ar.xml", "ldnt1sw_z_p_ar.xml"], build: signedNonTemporalLoad },
    { id: "sme-two-vector-narrowing-shift", files: ["sqrshr_z_mz2.xml", "sqrshru_z_mz2.xml", "uqrshr_z_mz2.xml", "sqrshrn_z_mz2.xml", "sqrshrun_z_mz2.xml", "uqrshrn_z_mz2.xml"], build: twoVectorNarrowingShift },
    { id: "sve-predicated-conversion", files: ["fcvt_z_p_z.xml", "fcvtzs_z_p_z.xml", "fcvtzu_z_p_z.xml", "scvtf_z_p_z.xml", "ucvtf_z_p_z.xml"], build: predicatedConversion },
];

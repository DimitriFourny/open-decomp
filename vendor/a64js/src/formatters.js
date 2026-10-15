import { smeDotGroupCount, smeDotAccumulatorLane, smeMultiVectorArithmeticOperands, smeMultiVectorClampOperands, smeIntFloatConvertOperands, smeLutiOperands, smeFp8LutiMixedOperands, smeIndexedSourceOperand, smeIndexedSourceText, smeLongArithmeticOperands, smeFloatLongArithmeticOperands, smeFp8LongArithmeticOperands, smeArithmeticOperands, smeDotOperands, } from "./sme-operands.js";
import { OperandDecodeError } from "./operand-errors.js";
import { buildOperandSchemaById, buildRegisteredSchema, vectorGroup } from "./operand-schemas.js";
import { TYPED_OPERAND_FAMILIES } from "./operand-families.js";
import { OperandFamilyRegistry } from "./operand-registry.js";
const COND_NAMES = [
    "eq",
    "ne",
    "hs",
    "lo",
    "mi",
    "pl",
    "vs",
    "vc",
    "hi",
    "ls",
    "ge",
    "lt",
    "gt",
    "le",
    "al",
    "nv",
];
const BARRIER_OPTION_NAMES = new Map([
    [0b0001, "oshld"],
    [0b0010, "oshst"],
    [0b0011, "osh"],
    [0b0101, "nshld"],
    [0b0110, "nshst"],
    [0b0111, "nsh"],
    [0b1001, "ishld"],
    [0b1010, "ishst"],
    [0b1011, "ish"],
    [0b1101, "ld"],
    [0b1110, "st"],
    [0b1111, "sy"],
]);
const AT_SYSTEM_ALIASES = new Map([
    ["0:7:8:0", { mnemonic: "at", op: "s1e1r", hasRegister: true }],
    ["0:7:8:1", { mnemonic: "at", op: "s1e1w", hasRegister: true }],
    ["0:7:8:2", { mnemonic: "at", op: "s1e0r", hasRegister: true }],
    ["0:7:8:3", { mnemonic: "at", op: "s1e0w", hasRegister: true }],
    ["0:7:9:0", { mnemonic: "at", op: "s1e1rp", hasRegister: true }],
    ["0:7:9:1", { mnemonic: "at", op: "s1e1wp", hasRegister: true }],
    ["0:7:9:2", { mnemonic: "at", op: "s1e1a", hasRegister: true }],
    ["4:7:8:0", { mnemonic: "at", op: "s1e2r", hasRegister: true }],
    ["4:7:8:1", { mnemonic: "at", op: "s1e2w", hasRegister: true }],
    ["4:7:8:4", { mnemonic: "at", op: "s12e1r", hasRegister: true }],
    ["4:7:8:5", { mnemonic: "at", op: "s12e1w", hasRegister: true }],
    ["4:7:8:6", { mnemonic: "at", op: "s12e0r", hasRegister: true }],
    ["4:7:8:7", { mnemonic: "at", op: "s12e0w", hasRegister: true }],
    ["4:7:9:2", { mnemonic: "at", op: "s1e2a", hasRegister: true }],
    ["6:7:8:0", { mnemonic: "at", op: "s1e3r", hasRegister: true }],
    ["6:7:8:1", { mnemonic: "at", op: "s1e3w", hasRegister: true }],
    ["6:7:9:2", { mnemonic: "at", op: "s1e3a", hasRegister: true }],
]);
const DC_SYSTEM_ALIASES = new Map([
    ["0:7:1:0", { mnemonic: "ic", op: "ialluis", hasRegister: false }],
    ["0:7:5:0", { mnemonic: "ic", op: "iallu", hasRegister: false }],
    ["3:7:5:1", { mnemonic: "ic", op: "ivau", hasRegister: true }],
    ["0:7:6:1", { mnemonic: "dc", op: "ivac", hasRegister: true }],
    ["0:7:6:2", { mnemonic: "dc", op: "isw", hasRegister: true }],
    ["0:7:6:3", { mnemonic: "dc", op: "igvac", hasRegister: true }],
    ["0:7:6:4", { mnemonic: "dc", op: "igsw", hasRegister: true }],
    ["0:7:6:5", { mnemonic: "dc", op: "igdvac", hasRegister: true }],
    ["0:7:6:6", { mnemonic: "dc", op: "igdsw", hasRegister: true }],
    ["0:7:10:2", { mnemonic: "dc", op: "csw", hasRegister: true }],
    ["0:7:10:4", { mnemonic: "dc", op: "cgsw", hasRegister: true }],
    ["0:7:10:6", { mnemonic: "dc", op: "cgdsw", hasRegister: true }],
    ["0:7:14:2", { mnemonic: "dc", op: "cisw", hasRegister: true }],
    ["0:7:14:4", { mnemonic: "dc", op: "cigsw", hasRegister: true }],
    ["0:7:14:6", { mnemonic: "dc", op: "cigdsw", hasRegister: true }],
    ["3:7:4:1", { mnemonic: "dc", op: "zva", hasRegister: true }],
    ["3:7:4:3", { mnemonic: "dc", op: "gva", hasRegister: true }],
    ["3:7:4:4", { mnemonic: "dc", op: "gzva", hasRegister: true }],
    ["3:7:10:1", { mnemonic: "dc", op: "cvac", hasRegister: true }],
    ["3:7:10:3", { mnemonic: "dc", op: "cgvac", hasRegister: true }],
    ["3:7:10:5", { mnemonic: "dc", op: "cgdvac", hasRegister: true }],
    ["3:7:11:1", { mnemonic: "dc", op: "cvau", hasRegister: true }],
    ["3:7:12:1", { mnemonic: "dc", op: "cvap", hasRegister: true }],
    ["3:7:12:3", { mnemonic: "dc", op: "cgvap", hasRegister: true }],
    ["3:7:12:5", { mnemonic: "dc", op: "cgdvap", hasRegister: true }],
    ["3:7:13:1", { mnemonic: "dc", op: "cvadp", hasRegister: true }],
    ["3:7:13:3", { mnemonic: "dc", op: "cgvadp", hasRegister: true }],
    ["3:7:13:5", { mnemonic: "dc", op: "cgdvadp", hasRegister: true }],
    ["3:7:14:1", { mnemonic: "dc", op: "civac", hasRegister: true }],
    ["3:7:14:3", { mnemonic: "dc", op: "cigvac", hasRegister: true }],
    ["3:7:14:5", { mnemonic: "dc", op: "cigdvac", hasRegister: true }],
    ["4:7:14:0", { mnemonic: "dc", op: "cipae", hasRegister: true }],
    ["4:7:14:7", { mnemonic: "dc", op: "cigdpae", hasRegister: true }],
]);
const TLBI_SYSTEM_ALIASES = new Map([
    ["0:8:3:0", { mnemonic: "tlbi", op: "vmalle1is", hasRegister: false }],
    ["0:8:3:1", { mnemonic: "tlbi", op: "vae1is", hasRegister: true }],
    ["0:8:3:2", { mnemonic: "tlbi", op: "aside1is", hasRegister: true }],
    ["0:8:3:3", { mnemonic: "tlbi", op: "vaae1is", hasRegister: true }],
    ["0:8:3:5", { mnemonic: "tlbi", op: "vale1is", hasRegister: true }],
    ["0:8:3:7", { mnemonic: "tlbi", op: "vaale1is", hasRegister: true }],
    ["0:8:7:0", { mnemonic: "tlbi", op: "vmalle1", hasRegister: false }],
    ["0:8:7:1", { mnemonic: "tlbi", op: "vae1", hasRegister: true }],
    ["0:8:7:2", { mnemonic: "tlbi", op: "aside1", hasRegister: true }],
    ["0:8:7:3", { mnemonic: "tlbi", op: "vaae1", hasRegister: true }],
    ["0:8:7:5", { mnemonic: "tlbi", op: "vale1", hasRegister: true }],
    ["0:8:7:7", { mnemonic: "tlbi", op: "vaale1", hasRegister: true }],
    ["4:8:0:1", { mnemonic: "tlbi", op: "ipas2e1is", hasRegister: true }],
    ["4:8:0:5", { mnemonic: "tlbi", op: "ipas2le1is", hasRegister: true }],
    ["4:8:2:2", { mnemonic: "tlbi", op: "vmallws2e1is", hasRegister: false }],
    ["4:8:3:0", { mnemonic: "tlbi", op: "alle2is", hasRegister: false }],
    ["4:8:3:1", { mnemonic: "tlbi", op: "vae2is", hasRegister: true }],
    ["4:8:3:4", { mnemonic: "tlbi", op: "alle1is", hasRegister: false }],
    ["4:8:3:5", { mnemonic: "tlbi", op: "vale2is", hasRegister: true }],
    ["4:8:3:6", { mnemonic: "tlbi", op: "vmalls12e1is", hasRegister: false }],
    ["4:8:4:1", { mnemonic: "tlbi", op: "ipas2e1", hasRegister: true }],
    ["4:8:4:5", { mnemonic: "tlbi", op: "ipas2le1", hasRegister: true }],
    ["4:8:5:2", { mnemonic: "tlbi", op: "vmallws2e1os", hasRegister: false }],
    ["4:8:6:2", { mnemonic: "tlbi", op: "vmallws2e1", hasRegister: false }],
    ["4:8:7:0", { mnemonic: "tlbi", op: "alle2", hasRegister: false }],
    ["4:8:7:1", { mnemonic: "tlbi", op: "vae2", hasRegister: true }],
    ["4:8:7:4", { mnemonic: "tlbi", op: "alle1", hasRegister: false }],
    ["4:8:7:5", { mnemonic: "tlbi", op: "vale2", hasRegister: true }],
    ["4:8:7:6", { mnemonic: "tlbi", op: "vmalls12e1", hasRegister: false }],
    ["4:9:2:2", { mnemonic: "tlbi", op: "vmallws2e1isnxs", hasRegister: false }],
    ["4:9:5:2", { mnemonic: "tlbi", op: "vmallws2e1osnxs", hasRegister: false }],
    ["4:9:6:2", { mnemonic: "tlbi", op: "vmallws2e1nxs", hasRegister: false }],
    ["6:8:3:0", { mnemonic: "tlbi", op: "alle3is", hasRegister: false }],
    ["6:8:3:1", { mnemonic: "tlbi", op: "vae3is", hasRegister: true }],
    ["6:8:7:0", { mnemonic: "tlbi", op: "alle3", hasRegister: false }],
    ["6:8:7:1", { mnemonic: "tlbi", op: "vae3", hasRegister: true }],
    ["6:8:7:5", { mnemonic: "tlbi", op: "vale3", hasRegister: true }],
    ["6:8:3:5", { mnemonic: "tlbi", op: "vale3is", hasRegister: true }],
]);
function signExtend(value, bits) {
    const mask = (1n << BigInt(bits)) - 1n;
    let result = BigInt(value) & mask;
    const signBit = 1n << BigInt(bits - 1);
    if ((result & signBit) !== 0n) {
        result -= 1n << BigInt(bits);
    }
    return result;
}
function reg(width, index, zeroName) {
    return { kind: "reg", width, index, zeroName };
}
function widthFromSf(sf) {
    return sf === 1 ? 64 : 32;
}
function gpReg(width, index, zeroName = "zr") {
    return reg(width, index, zeroName);
}
function sysReg(op0, op1, CRn, CRm, op2) {
    return { kind: "sysreg", op0, op1, CRn, CRm, op2 };
}
function vecReg(index, lane) {
    return { kind: "vec", index, lane };
}
function predReg(index, mode, lane) {
    return { kind: "pred", index, mode, lane };
}
function labelFromOffset(offset) {
    return { kind: "label", offset };
}
function labelFromPc(offset, pc, pageRelative = false) {
    return { kind: "label", offset, absolute: (pageRelative ? pc & ~0xfffn : pc) + offset, pageRelative };
}
function addSubImmediateOperands(inst, encoding) {
    const fields = inst.fields;
    const width = widthFromSf(fields.sf);
    const mnemonic = encoding.mnemonic;
    const shift = fields.sh === 1 ? 12 : 0;
    const imm = BigInt(fields.imm12);
    const rdZero = mnemonic === "ADD" || mnemonic === "SUB" ? "sp" : "zr";
    const rnZero = "sp";
    const ops = [
        gpReg(width, fields.Rd, rdZero),
        gpReg(width, fields.Rn, rnZero),
        { kind: "imm", value: imm, shift },
    ];
    return ops;
}
function addSubShiftedOperands(inst) {
    const fields = inst.fields;
    const width = widthFromSf(fields.sf);
    const imm6 = fields.imm6 ?? 0;
    const shiftType = ["lsl", "lsr", "asr"][fields.shift ?? 0] ?? "lsl";
    const ops = [
        gpReg(width, fields.Rd, "zr"),
        gpReg(width, fields.Rn, "zr"),
        gpReg(width, fields.Rm, "zr"),
    ];
    if (imm6 !== 0) {
        ops.push({ kind: "imm", value: BigInt(imm6), signed: false, shift: 0 });
        ops[3].displayHint = shiftType;
    }
    return ops;
}
function checkedPointerAddSubOperands(inst) {
    const fields = inst.fields;
    const shift = fields.imm3 ?? 0;
    const ops = [
        gpReg(64, fields.Rd, "sp"),
        gpReg(64, fields.Rn, "sp"),
        gpReg(64, fields.Rm, "zr"),
    ];
    if (shift !== 0) {
        ops.push({ kind: "text", text: `lsl #${shift}` });
    }
    return ops;
}
function addSubExtendedPreferredLsl(width, option, rd, rn) {
    if (width === 32) {
        return option === 2 && (rd === 31 || rn === 31);
    }
    return option === 3 && (rd === 31 || rn === 31);
}
function addSubExtendedOperands(inst) {
    const fields = inst.fields;
    const width = widthFromSf(fields.sf);
    const fileName = inst.encoding.fileName;
    const isAlias = fileName === "cmn_adds_addsub_ext.xml" || fileName === "cmp_subs_addsub_ext.xml";
    const option = fields.option ?? 0;
    const shift = fields.imm3 ?? 0;
    const sourceWidth = width === 32 ? 32 : option === 3 || option === 7 ? 64 : 32;
    const extendNames = ["uxtb", "uxth", "uxtw", "uxtx", "sxtb", "sxth", "sxtw", "sxtx"];
    const ops = [];
    if (!isAlias) {
        const rdZero = fileName === "add_addsub_ext.xml" || fileName === "sub_addsub_ext.xml" ? "sp" : "zr";
        ops.push(gpReg(width, fields.Rd, rdZero));
    }
    ops.push(gpReg(width, fields.Rn, "sp"));
    ops.push(gpReg(sourceWidth, fields.Rm, "zr"));
    if (addSubExtendedPreferredLsl(width, option, fields.Rd, fields.Rn)) {
        if (shift !== 0) {
            ops.push({ kind: "text", text: `lsl #${shift}` });
        }
        return ops;
    }
    const extend = extendNames[option] ?? "uxtb";
    ops.push({ kind: "text", text: shift === 0 ? extend : `${extend} #${shift}` });
    return ops;
}
function threeSourceIntegerOperands(inst) {
    const fields = inst.fields;
    const width = widthFromSf(fields.sf);
    return [
        gpReg(width, fields.Rd, "zr"),
        gpReg(width, fields.Rn, "zr"),
        gpReg(width, fields.Rm, "zr"),
        gpReg(width, fields.Ra, "zr"),
    ];
}
function oneSourceIntegerOperands(inst) {
    const fields = inst.fields;
    const width = widthFromSf(fields.sf);
    return [gpReg(width, fields.Rd, "zr"), gpReg(width, fields.Rn, "zr")];
}
function twoSourceIntegerOperands(inst) {
    const fields = inst.fields;
    const width = widthFromSf(fields.sf);
    return [
        gpReg(width, fields.Rd, "zr"),
        gpReg(width, fields.Rn, "zr"),
        gpReg(width, fields.Rm, "zr"),
    ];
}
function crc32Operands(inst) {
    const fields = inst.fields;
    const rmWidth = (fields.sf ?? 0) === 1 ? 64 : 32;
    return [
        gpReg(32, fields.Rd, "zr"),
        gpReg(32, fields.Rn, "zr"),
        gpReg(rmWidth, fields.Rm, "zr"),
    ];
}
function exceptionImmediateOperands(inst) {
    const fields = inst.fields;
    const imm = BigInt(fields.imm16 ?? 0);
    return [{ kind: "text", text: imm === 0n ? "#0" : formatSignedHexImmediate(imm) }];
}
function signExtendImmediate(value, width) {
    const shift = 32 - width;
    return (value << shift) >> shift;
}
function minMaxImmediateOperands(inst) {
    const fields = inst.fields;
    const width = widthFromSf(fields.sf);
    const fileName = inst.encoding.fileName;
    const immediate = fileName.startsWith("smax_") || fileName.startsWith("smin_")
        ? signExtendImmediate(fields.imm8 ?? 0, 8)
        : (fields.imm8 ?? 0);
    return [gpReg(width, fields.Rd, "zr"), gpReg(width, fields.Rn, "zr"), { kind: "text", text: `#${immediate}` }];
}
function mulAliasOperands(inst) {
    return threeSourceIntegerOperands(inst).slice(0, 3);
}
function scalarMultiplyLongOperands(inst) {
    const fields = inst.fields;
    return [
        gpReg(64, fields.Rd, "zr"),
        gpReg(32, fields.Rn, "zr"),
        gpReg(32, fields.Rm, "zr"),
        gpReg(64, fields.Ra, "zr"),
    ];
}
function scalarMultiplyLongAliasOperands(inst) {
    return scalarMultiplyLongOperands(inst).slice(0, 3);
}
function multiplyHighOperands(inst) {
    const fields = inst.fields;
    return [gpReg(64, fields.Rd, "zr"), gpReg(64, fields.Rn, "zr"), gpReg(64, fields.Rm, "zr")];
}
function logicalShiftedRegisterOperands(inst) {
    const fields = inst.fields;
    const width = widthFromSf(fields.sf);
    const shiftType = ["lsl", "lsr", "asr", "ror"][fields.shift ?? 0] ?? "lsl";
    const shiftAmount = fields.imm6 ?? 0;
    const ops = inst.encoding.fileName === "tst_ands_log_shift.xml"
        ? [
            gpReg(width, fields.Rn, "zr"),
            gpReg(width, fields.Rm, "zr"),
        ]
        : [
            gpReg(width, fields.Rd, "zr"),
            gpReg(width, fields.Rn, "zr"),
            gpReg(width, fields.Rm, "zr"),
        ];
    if (shiftAmount !== 0 || shiftType !== "lsl") {
        ops.push({ kind: "text", text: `${shiftType} #${shiftAmount}` });
    }
    return ops;
}
function movRegisterAliasOperands(inst) {
    const fields = inst.fields;
    const width = widthFromSf(fields.sf);
    return [gpReg(width, fields.Rd, "zr"), gpReg(width, fields.Rm, "zr")];
}
function highestSetBit(value) {
    for (let bit = 31; bit >= 0; bit -= 1) {
        if (((value >>> bit) & 1) === 1) {
            return bit;
        }
    }
    return -1;
}
function rotateRight(value, shift, width) {
    const normalizedShift = ((shift % width) + width) % width;
    const mask = (1n << BigInt(width)) - 1n;
    if (normalizedShift === 0) {
        return value & mask;
    }
    return ((value >> BigInt(normalizedShift)) | (value << BigInt(width - normalizedShift))) & mask;
}
function decodeLogicalImmediate(fields, width) {
    const n = fields.N ?? 0;
    const immr = fields.immr ?? 0;
    const imms = fields.imms ?? 0;
    const len = highestSetBit((n << 6) | ((~imms) & 0x3f));
    if (len < 1) {
        return null;
    }
    const size = 1 << len;
    if (size > width) {
        return null;
    }
    const levels = size - 1;
    const s = imms & levels;
    const r = immr & levels;
    if (s === levels) {
        return null;
    }
    const element = rotateRight((1n << BigInt(s + 1)) - 1n, r, size);
    let value = 0n;
    for (let offset = 0; offset < width; offset += size) {
        value |= element << BigInt(offset);
    }
    return value;
}
function logicalImmediateOperands(inst) {
    const fields = inst.fields;
    const width = widthFromSf(fields.sf);
    const imm = decodeLogicalImmediate(fields, width);
    if (imm === null) {
        throw new OperandDecodeError("invalid", "invalid logical immediate", inst.encoding.fileName);
    }
    if (inst.encoding.fileName === "tst_ands_log_imm.xml") {
        return [gpReg(width, fields.Rn, "zr"), { kind: "imm", value: imm }];
    }
    if (inst.encoding.fileName === "mov_orr_log_imm.xml") {
        return [gpReg(width, fields.Rd, "sp"), { kind: "imm", value: imm }];
    }
    return [
        gpReg(width, fields.Rd, inst.encoding.mnemonic === "ANDS" ? "zr" : "sp"),
        gpReg(width, fields.Rn, "zr"),
        { kind: "imm", value: imm },
    ];
}
function moveWideOperands(inst) {
    const fields = inst.fields;
    const width = widthFromSf(fields.sf);
    const shift = (fields.hw ?? 0) << 4;
    const ops = [
        gpReg(width, fields.Rd, "zr"),
        { kind: "imm", value: BigInt(fields.imm16), shift },
    ];
    return ops;
}
function hintOperands(inst) {
    const fields = inst.fields;
    const imm = ((fields.CRm ?? 0) << 3) | (fields.op2 ?? 0);
    return [{ kind: "text", text: `#${imm}` }];
}
function btiOperands(inst) {
    const targets = ((inst.fields.op2 ?? 0) >> 1) & 0b11;
    switch (targets) {
        case 0b01:
            return [{ kind: "text", text: "c" }];
        case 0b10:
            return [{ kind: "text", text: "j" }];
        case 0b11:
            return [{ kind: "text", text: "jc" }];
        default:
            return noOperands();
    }
}
const INTENTIONAL_ZERO_OPERANDS = new WeakSet();
function noOperands() {
    const operands = [];
    INTENTIONAL_ZERO_OPERANDS.add(operands);
    return operands;
}
function setfOperands(inst) {
    const fields = inst.fields;
    return [gpReg(32, fields.Rn, "zr")];
}
function rmifOperands(inst) {
    const fields = inst.fields;
    return [
        gpReg(64, fields.Rn, "zr"),
        { kind: "text", text: `#${fields.imm6 ?? 0}` },
        { kind: "text", text: `#${fields.mask ?? 0}` },
    ];
}
function bitfieldImmediateOperands(inst) {
    const fields = inst.fields;
    const width = widthFromSf(fields.sf);
    return [
        gpReg(width, fields.Rd, "zr"),
        gpReg(width, fields.Rn, "zr"),
        { kind: "imm", value: BigInt(fields.immr ?? 0) },
        { kind: "imm", value: BigInt(fields.imms ?? 0) },
    ];
}
function extractRegisterOperands(inst) {
    const fields = inst.fields;
    const width = widthFromSf(fields.sf);
    return [
        gpReg(width, fields.Rd, "zr"),
        gpReg(width, fields.Rn, "zr"),
        gpReg(width, fields.Rm, "zr"),
        { kind: "text", text: `#${fields.imms ?? 0}` },
    ];
}
function branchOffsetOperand(inst, field) {
    const fields = inst.fields;
    const width = field === "imm26" ? 28 : field === "imm19" ? 21 : 16;
    const offset = signExtend(fields[field] << 2, width);
    return [labelFromOffset(offset)];
}
function adrOperands(inst, pageRelative) {
    const fields = inst.fields;
    const imm = (fields.immhi << 2) | fields.immlo;
    const signed = signExtend(imm, 21);
    const offset = pageRelative ? signed << 12n : signed;
    return [gpReg(64, fields.Rd, "zr"), { kind: "label", offset, pageRelative }];
}
function cbzOperands(inst) {
    const fields = inst.fields;
    const width = widthFromSf(fields.sf);
    const offset = signExtend(fields.imm19 << 2, 21);
    return [gpReg(width, fields.Rt, "zr"), labelFromOffset(offset)];
}
function tbzOperands(inst) {
    const fields = inst.fields;
    const width = fields.b5 === 1 ? 64 : 32;
    const bit = (fields.b5 << 5) | fields.b40;
    const offset = signExtend(fields.imm14 << 2, 16);
    return [
        gpReg(width, fields.Rt, "zr"),
        { kind: "imm", value: BigInt(bit) },
        labelFromOffset(offset),
    ];
}
function registerBranchOperands(inst, omitDefaultRet = false) {
    const fields = inst.fields;
    if (omitDefaultRet && fields.Rn === 30) {
        return noOperands();
    }
    return [gpReg(64, fields.Rn, "zr")];
}
function authBranchOperands(inst) {
    const fields = inst.fields;
    const ops = [gpReg(64, fields.Rn, "zr")];
    if (fields.Z === 1) {
        ops.push(gpReg(64, fields.Rm, "sp"));
    }
    return ops;
}
function authGenericOperands(inst, mnemonic) {
    const fields = inst.fields;
    if (fields.Rd !== undefined && fields.Rn !== undefined && !mnemonic.endsWith("ZA") && !mnemonic.endsWith("ZB")) {
        return [gpReg(64, fields.Rd, "zr"), gpReg(64, fields.Rn, "sp")];
    }
    if (fields.Rd !== undefined && (mnemonic.endsWith("ZA") || mnemonic.endsWith("ZB"))) {
        return [gpReg(64, fields.Rd, "zr")];
    }
    if (fields.Rd === undefined && fields.Rn === undefined) {
        return noOperands();
    }
    return [];
}
function authLoadRegisterOperands(inst) {
    const fields = inst.fields;
    const base = formatRegister(gpReg(64, fields.Rn, "sp"));
    const simm10 = ((fields.S ?? 0) << 9) | (fields.imm9 ?? 0);
    const offset = signExtend(simm10 << 3, 13);
    const writeback = (fields.W ?? 0) === 1;
    const memory = writeback
        ? `[${base}, ${formatSignedDecimalImmediate(offset)}]!`
        : offset === 0n
            ? `[${base}]`
            : `[${base}, ${formatSignedDecimalImmediate(offset)}]`;
    return [gpReg(64, fields.Rt, "zr"), { kind: "text", text: memory }];
}
function authGenericThreeSourceOperands(inst) {
    const fields = inst.fields;
    return [
        gpReg(64, fields.Rd, "zr"),
        gpReg(64, fields.Rn, "zr"),
        gpReg(64, fields.Rm, "sp"),
    ];
}
function labelFromImm16Negative(inst) {
    const fields = inst.fields;
    const offset = BigInt((fields.imm16 ?? 0) << 2);
    return [{ kind: "label", offset: -offset }];
}
export function conditionSuffix(code) {
    return COND_NAMES[code & 0xf] ?? "nv";
}
export function invertConditionCode(code) {
    const normalized = code & 0xf;
    return normalized >= 0xe ? normalized : normalized ^ 1;
}
function conditionOperand(code) {
    const normalized = code & 0xf;
    return { kind: "cond", code: normalized, suffix: conditionSuffix(normalized) };
}
function bCondOperands(inst) {
    const fields = inst.fields;
    const offset = signExtend(fields.imm19 << 2, 21);
    return [conditionOperand(fields.cond), labelFromOffset(offset)];
}
function conditionalSelectOperands(inst) {
    const fields = inst.fields;
    const width = widthFromSf(fields.sf);
    return [
        gpReg(width, fields.Rd, "zr"),
        gpReg(width, fields.Rn, "zr"),
        gpReg(width, fields.Rm, "zr"),
        conditionOperand(fields.cond),
    ];
}
function conditionalCompareImmediateOperands(inst) {
    const fields = inst.fields;
    const width = widthFromSf(fields.sf);
    return [
        gpReg(width, fields.Rn, "zr"),
        { kind: "text", text: `#${fields.imm5 ?? 0}` },
        { kind: "text", text: `#${fields.nzcv ?? 0}` },
        conditionOperand(fields.cond),
    ];
}
function conditionalCompareRegisterOperands(inst) {
    const fields = inst.fields;
    const width = widthFromSf(fields.sf);
    return [
        gpReg(width, fields.Rn, "zr"),
        gpReg(width, fields.Rm, "zr"),
        { kind: "text", text: `#${fields.nzcv ?? 0}` },
        conditionOperand(fields.cond),
    ];
}
function systemMoveOperands(inst, mnemonic) {
    const fields = inst.fields;
    const systemRegister = sysReg(2 + (fields.o0 ?? 0), fields.op1 ?? 0, fields.CRn ?? 0, fields.CRm ?? 0, fields.op2 ?? 0);
    const xt = gpReg(64, fields.Rt, "zr");
    return mnemonic === "MRS" ? [xt, systemRegister] : [systemRegister, xt];
}
function systemMove128Operands(inst, mnemonic) {
    const fields = inst.fields;
    const systemRegister = sysReg(2 + (fields.o0 ?? 0), fields.op1 ?? 0, fields.CRn ?? 0, fields.CRm ?? 0, fields.op2 ?? 0);
    const xt = gpReg(64, fields.Rt, "zr");
    const xt2 = gpReg(64, (fields.Rt + 1) & 31, "zr");
    return mnemonic === "MRRS" ? [xt, xt2, systemRegister] : [systemRegister, xt, xt2];
}
function systemAliasKey(fields) {
    return `${fields.op1 ?? 0}:${fields.CRn ?? 0}:${fields.CRm ?? 0}:${fields.op2 ?? 0}`;
}
function barrierOperands(inst) {
    const fields = inst.fields;
    const option = BARRIER_OPTION_NAMES.get(fields.CRm ?? 0) ?? `#${fields.CRm ?? 0}`;
    return [{ kind: "text", text: option }];
}
function clrexOperands(inst) {
    const fields = inst.fields;
    return (fields.CRm ?? 0) === 15 ? noOperands() : [{ kind: "text", text: `#${fields.CRm ?? 0}` }];
}
function isbOperands(inst) {
    const fields = inst.fields;
    return (fields.CRm ?? 0) === 15 ? noOperands() : [{ kind: "text", text: `#${fields.CRm ?? 0}` }];
}
function pstateFieldName(fields) {
    const op1 = fields.op1 ?? 0;
    const op2 = fields.op2 ?? 0;
    const CRm = fields.CRm ?? 0;
    if (op1 === 0 && op2 === 3) {
        return "UAO";
    }
    if (op1 === 0 && op2 === 4) {
        return "PAN";
    }
    if (op1 === 0 && op2 === 5) {
        return "SPSel";
    }
    if (op1 === 1 && op2 === 0) {
        if ((CRm & 0b1110) === 0) {
            return "ALLINT";
        }
        if ((CRm & 0b1110) === 0b0010) {
            return "PM";
        }
        return null;
    }
    if (op1 === 3 && op2 === 1) {
        return "SSBS";
    }
    if (op1 === 3 && op2 === 2) {
        return "DIT";
    }
    if (op1 === 3 && op2 === 3) {
        if ((CRm & 0b1110) === 0b0010) {
            return "SVCRSM";
        }
        if ((CRm & 0b1110) === 0b0100) {
            return "SVCRZA";
        }
        if ((CRm & 0b1110) === 0b0110) {
            return "SVCRSMZA";
        }
        return null;
    }
    if (op1 === 3 && op2 === 4) {
        return "TCO";
    }
    if (op1 === 3 && op2 === 6) {
        return "DAIFSet";
    }
    if (op1 === 3 && op2 === 7) {
        return "DAIFClr";
    }
    return null;
}
function pstateImmediateValue(fields) {
    const fieldName = pstateFieldName(fields);
    const CRm = fields.CRm ?? 0;
    if (fieldName === "ALLINT" || fieldName === "PM" || fieldName?.startsWith("SVCR")) {
        return CRm & 1;
    }
    return CRm;
}
function msrImmediateOperands(inst) {
    const fields = inst.fields;
    const fieldName = pstateFieldName(fields);
    if (!fieldName) {
        return [];
    }
    return [{ kind: "text", text: fieldName }, { kind: "text", text: `#${pstateImmediateValue(fields)}` }];
}
function syslOperands(inst) {
    const fields = inst.fields;
    return [
        gpReg(64, fields.Rt, "zr"),
        { kind: "text", text: `#${fields.op1 ?? 0}` },
        { kind: "text", text: `c${fields.CRn ?? 0}` },
        { kind: "text", text: `c${fields.CRm ?? 0}` },
        { kind: "text", text: `#${fields.op2 ?? 0}` },
    ];
}
function smstartSmstopOperands(inst) {
    const fields = inst.fields;
    const CRm = fields.CRm ?? 0;
    if ((CRm & 0b0110) === 0b0110) {
        return noOperands();
    }
    if ((CRm & 0b0110) === 0b0010) {
        return [{ kind: "text", text: "sm" }];
    }
    if ((CRm & 0b0110) === 0b0100) {
        return [{ kind: "text", text: "za" }];
    }
    return [];
}
function gcsSyslAliasOperands(inst) {
    const fields = inst.fields;
    return fields.Rt === 31 ? noOperands() : [gpReg(64, fields.Rt, "zr")];
}
function chkfeatOperands() {
    return [gpReg(64, 16, "zr")];
}
function gcsbOperands() {
    return [{ kind: "text", text: "dsync" }];
}
function specResContextOperands(inst) {
    const fields = inst.fields;
    return [{ kind: "text", text: "rctx" }, gpReg(64, fields.Rt, "zr")];
}
function trcitOperands(inst) {
    const fields = inst.fields;
    return [gpReg(64, fields.Rt, "zr")];
}
function gcsStoreOperands(inst) {
    const fields = inst.fields;
    return [gpReg(64, fields.Rt, "zr"), gpReg(64, fields.Rn, "sp")];
}
function rawSysOperands(inst) {
    const fields = inst.fields;
    const ops = [
        { kind: "text", text: `#${fields.op1 ?? 0}` },
        { kind: "text", text: `c${fields.CRn ?? 0}` },
        { kind: "text", text: `c${fields.CRm ?? 0}` },
        { kind: "text", text: `#${fields.op2 ?? 0}` },
    ];
    if ((fields.Rt ?? 31) !== 31) {
        ops.push(gpReg(64, fields.Rt, "zr"));
    }
    return ops;
}
function systemInstructionAliasOperands(inst, aliases) {
    const fields = inst.fields;
    const alias = aliases.get(systemAliasKey(fields));
    if (!alias) {
        return rawSysOperands(inst);
    }
    const ops = [{ kind: "text", text: alias.op }];
    if (alias.hasRegister) {
        ops.push(gpReg(64, fields.Rt, "zr"));
    }
    return alias.mnemonic === "dc" || alias.mnemonic === "ic"
        ? [{ kind: "text", text: alias.mnemonic }, ...ops]
        : ops;
}
function ldaprOperands(inst) {
    const fields = inst.fields;
    const width = (fields.size ?? 0) === 3 ? 64 : 32;
    const base = formatRegister(gpReg(64, fields.Rn, "sp"));
    const memory = inst.encoding.encodingId.includes("writeback")
        ? `[${base}], #${width / 8}`
        : `[${base}]`;
    return [gpReg(width, fields.Rt, "zr"), { kind: "text", text: memory }];
}
function ldaprByteHalfwordOperands(inst) {
    const fields = inst.fields;
    const base = formatRegister(gpReg(64, fields.Rn, "sp"));
    return [gpReg(32, fields.Rt, "zr"), { kind: "text", text: `[${base}]` }];
}
function ldiappOperands(inst) {
    const fields = inst.fields;
    const width = (fields.size ?? 0) === 3 ? 64 : 32;
    const base = formatRegister(gpReg(64, fields.Rn, "sp"));
    const postIndexAmount = width === 64 ? 16 : 8;
    const memory = ((fields.opc2 ?? 0) & 1) === 0 ? `[${base}], #${postIndexAmount}` : `[${base}]`;
    return [
        gpReg(width, fields.Rt, "zr"),
        gpReg(width, fields.Rt2, "zr"),
        { kind: "text", text: memory },
    ];
}
function rcpcUnscaledMemoryText(inst) {
    const fields = inst.fields;
    const base = formatRegister(gpReg(64, fields.Rn, "sp"));
    const offset = signExtend(fields.imm9 ?? 0, 9);
    return offset === 0n ? `[${base}]` : `[${base}, ${formatSignedDecimalImmediate(offset)}]`;
}
function rcpcGeneralUnscaledWidth(fileName, fields) {
    switch (fileName) {
        case "ldapursw.xml":
            return 64;
        case "ldapursb.xml":
        case "ldapursh.xml":
            return (fields.opc ?? 0) === 0b10 ? 64 : 32;
        case "stlur_gen.xml":
        case "ldapur_gen.xml":
        case "stlr.xml":
            return (fields.size ?? 0) === 0b11 ? 64 : 32;
        default:
            return 32;
    }
}
function rcpcUnscaledOperands(inst) {
    const fields = inst.fields;
    const fileName = inst.encoding.fileName;
    const memory = rcpcUnscaledMemoryText(inst);
    if (fileName === "stlur_fpsimd.xml" || fileName === "ldapur_fpsimd.xml") {
        return [
            { kind: "simd", index: fields.Rt, scalar: (fields.size ?? 0) === 0 && ((fields.opc ?? 0) & 2) !== 0 ? "q" : advsimdLaneFromSize(fields.size) },
            { kind: "text", text: memory },
        ];
    }
    return [
        gpReg(rcpcGeneralUnscaledWidth(fileName, fields), fields.Rt, "zr"),
        { kind: "text", text: memory },
    ];
}
function stlrOperands(inst) {
    const fields = inst.fields;
    const width = rcpcGeneralUnscaledWidth(inst.encoding.fileName, fields);
    const base = formatRegister(gpReg(64, fields.Rn, "sp"));
    const offset = width === 64 ? -8n : -4n;
    const memory = inst.encoding.encodingId.includes("writeback")
        ? `[${base}, ${formatSignedDecimalImmediate(offset)}]!`
        : `[${base}]`;
    return [gpReg(width, fields.Rt, "zr"), { kind: "text", text: memory }];
}
function stilpOperands(inst) {
    const fields = inst.fields;
    const width = (fields.size ?? 0) === 0b11 ? 64 : 32;
    const base = formatRegister(gpReg(64, fields.Rn, "sp"));
    const offset = width === 64 ? -16n : -8n;
    const memory = ((fields.opc2 ?? 0) & 1) === 0 ? `[${base}, ${formatSignedDecimalImmediate(offset)}]!` : `[${base}]`;
    return [
        gpReg(width, fields.Rt, "zr"),
        gpReg(width, fields.Rt2, "zr"),
        { kind: "text", text: memory },
    ];
}
function formatSignedHexImmediate(value) {
    if (value < 0) {
        return `#-0x${(-value).toString(16)}`;
    }
    return `#0x${value.toString(16)}`;
}
function formatSignedDecimalImmediate(value) {
    return `#${value.toString()}`;
}
function prfmOpText(value) {
    const accessNames = ["pld", "pli", "pst", "ir"];
    const levelNames = ["l1", "l2", "l3", "slc"];
    const policyNames = ["keep", "strm"];
    const accessName = accessNames[value >> 3];
    const levelName = levelNames[(value >> 1) & 0x3];
    const policyName = policyNames[value & 0x1];
    if (!accessName || !levelName || !policyName) {
        return `#${value}`;
    }
    return `${accessName}${levelName}${policyName}`;
}
function scalarLoadStoreRegisterWidth(fileName, size) {
    switch (fileName) {
        case "ldr_imm_gen.xml":
        case "str_imm_gen.xml":
        case "ldur_gen.xml":
        case "stur_gen.xml":
        case "ldtr.xml":
        case "sttr.xml":
        case "ldr_reg_gen.xml":
        case "str_reg_gen.xml":
            return size === 3 ? 64 : 32;
        case "ldrsw_imm.xml":
        case "ldursw.xml":
        case "ldtrsw.xml":
        case "ldrsw_reg.xml":
            return 64;
        default:
            return 32;
    }
}
function fpSimdRegisterText(size, opc, index) {
    if ((size ?? 0) === 0 && ((opc ?? 0) & 0b10) !== 0) {
        return `q${index}`;
    }
    return `${advsimdLaneFromSize(size)}${index}`;
}
function fpSimdPairRegisterText(opc, index) {
    switch (opc ?? 0) {
        case 0:
            return `s${index}`;
        case 1:
            return `d${index}`;
        case 2:
            return `q${index}`;
        default:
            return `s${index}`;
    }
}
function isFpSimdLoadStore(fileName) {
    switch (fileName) {
        case "ldr_imm_fpsimd.xml":
        case "str_imm_fpsimd.xml":
        case "ldur_fpsimd.xml":
        case "stur_fpsimd.xml":
        case "ldr_reg_fpsimd.xml":
        case "str_reg_fpsimd.xml":
        case "ldp_fpsimd.xml":
        case "stp_fpsimd.xml":
        case "stnp_fpsimd.xml":
            return true;
        default:
            return false;
    }
}
function scalarLoadStoreImmediateScale(fileName, size) {
    switch (fileName) {
        case "ldr_imm_gen.xml":
        case "str_imm_gen.xml":
            return 1n << BigInt(size ?? 0);
        case "ldrh_imm.xml":
        case "strh_imm.xml":
            return 2n;
        case "ldrsh_imm.xml":
            return 2n;
        case "ldrsw_imm.xml":
            return 4n;
        case "prfm_imm.xml":
            return 8n;
        default:
            return 1n;
    }
}
function isScalarRegisterOffsetLoadStore(fileName) {
    switch (fileName) {
        case "ldr_reg_gen.xml":
        case "ldrb_reg.xml":
        case "ldrh_reg.xml":
        case "ldrsb_reg.xml":
        case "ldrsh_reg.xml":
        case "ldrsw_reg.xml":
        case "str_reg_gen.xml":
        case "strb_reg.xml":
        case "strh_reg.xml":
        case "ldr_reg_fpsimd.xml":
        case "str_reg_fpsimd.xml":
        case "prfm_reg.xml":
            return true;
        default:
            return false;
    }
}
function isDecimalUnscaledLoadStore(fileName) {
    switch (fileName) {
        case "ldursb.xml":
        case "ldursh.xml":
        case "ldursw.xml":
        case "sturb.xml":
        case "sturh.xml":
        case "ldurb.xml":
        case "ldurh.xml":
        case "prfum.xml":
        case "sttr.xml":
        case "sttrb.xml":
        case "sttrh.xml":
        case "ldtr.xml":
        case "ldtrb.xml":
        case "ldtrh.xml":
        case "ldtrsb.xml":
        case "ldtrsh.xml":
        case "ldtrsw.xml":
            return true;
        default:
            return false;
    }
}
function scalarRegisterOffsetMemoryOperand(inst) {
    const fields = inst.fields;
    const option = fields.option ?? 0;
    const shift = fields.S === 1
        ? isFpSimdLoadStore(inst.encoding.fileName) && (fields.size ?? 0) === 0 && ((fields.opc ?? 0) & 2) !== 0 ? 4 : (fields.size ?? 0)
        : 0;
    const extendNames = ["uxtb", "uxth", "uxtw", "lsl", "sxtb", "sxth", "sxtw", "sxtx"];
    return {
        kind: "mem", base: gpReg(64, fields.Rn, "sp"),
        offset: gpReg((option & 1) === 0 ? 32 : 64, fields.Rm, "zr"),
        modifier: option === 3 && shift === 0 ? undefined : { kind: extendNames[option], amount: shift === 0 ? undefined : shift },
    };
}
function scalarLoadStoreMemoryOperand(inst) {
    const fields = inst.fields;
    const encoding = inst.encoding;
    if (isScalarRegisterOffsetLoadStore(encoding.fileName)) {
        return scalarRegisterOffsetMemoryOperand(inst);
    }
    const base = gpReg(64, fields.Rn, "sp");
    if (fields.imm12 !== undefined) {
        const scale = isFpSimdLoadStore(encoding.fileName)
            ? (fields.size ?? 0) === 0 && ((fields.opc ?? 0) & 0b10) !== 0 ? 16n : 1n << BigInt(fields.size ?? 0)
            : scalarLoadStoreImmediateScale(encoding.fileName, fields.size);
        return {
            kind: "mem", base, offset: { kind: "imm", value: BigInt(fields.imm12) * scale },
            immediateFormat: encoding.fileName === "prfm_imm.xml" || isFpSimdLoadStore(encoding.fileName) ? "decimal" : "hex",
        };
    }
    const decimal = encoding.fileName === "ldrsb_imm.xml" || encoding.fileName === "ldrsh_imm.xml" ||
        isDecimalUnscaledLoadStore(encoding.fileName) || isFpSimdLoadStore(encoding.fileName);
    return {
        kind: "mem", base, offset: { kind: "imm", value: signExtend(fields.imm9 ?? 0, 9) },
        mode: encoding.encodingId.includes("immpost") ? "post-index" : encoding.encodingId.includes("immpre") ? "pre-index" : "offset",
        immediateFormat: decimal ? "decimal" : "hex",
    };
}
function pairLoadStoreScaledImmediate(inst) {
    const fields = inst.fields;
    if (inst.encoding.fileName === "ldpsw.xml") {
        return signExtend(fields.imm7 ?? 0, 7) * 4n;
    }
    if (inst.encoding.fileName === "ldp_fpsimd.xml" ||
        inst.encoding.fileName === "stp_fpsimd.xml" ||
        inst.encoding.fileName === "stnp_fpsimd.xml" ||
        inst.encoding.fileName === "ldnp_fpsimd.xml") {
        const scale = (fields.opc ?? 0) === 2 ? 16n : (fields.opc ?? 0) === 1 ? 8n : 4n;
        return signExtend(fields.imm7 ?? 0, 7) * scale;
    }
    const width = (fields.opc ?? 0) === 2 ? 64 : 32;
    return signExtend(fields.imm7 ?? 0, 7) * BigInt(width / 8);
}
function pairLoadStoreMemoryOperand(inst) {
    const fields = inst.fields;
    const encodingId = inst.encoding.encodingId;
    return {
        kind: "mem", base: gpReg(64, fields.Rn, "sp"),
        offset: { kind: "imm", value: pairLoadStoreScaledImmediate(inst) },
        mode: encodingId.includes("_post") ? "post-index" : encodingId.includes("_pre") ? "pre-index" : "offset",
        immediateFormat: "decimal",
    };
}
function pairLoadStoreOperands(inst) {
    const fields = inst.fields;
    if (inst.encoding.fileName === "ldp_fpsimd.xml" ||
        inst.encoding.fileName === "stp_fpsimd.xml" ||
        inst.encoding.fileName === "stnp_fpsimd.xml" ||
        inst.encoding.fileName === "ldnp_fpsimd.xml") {
        return [
            { kind: "simd", index: fields.Rt, scalar: (fields.opc ?? 0) === 2 ? "q" : (fields.opc ?? 0) === 1 ? "d" : "s" },
            { kind: "simd", index: fields.Rt2, scalar: (fields.opc ?? 0) === 2 ? "q" : (fields.opc ?? 0) === 1 ? "d" : "s" },
            pairLoadStoreMemoryOperand(inst),
        ];
    }
    const width = inst.encoding.fileName === "ldpsw.xml" ? 64 : (fields.opc ?? 0) === 2 ? 64 : 32;
    return [
        gpReg(width, fields.Rt, "zr"),
        gpReg(width, fields.Rt2, "zr"),
        pairLoadStoreMemoryOperand(inst),
    ];
}
function scalarLoadStoreOperands(inst) {
    const fields = inst.fields;
    if (inst.encoding.fileName === "prfm_imm.xml" || inst.encoding.fileName === "prfm_reg.xml" || inst.encoding.fileName === "prfum.xml") {
        return [
            { kind: "text", text: prfmOpText(fields.Rt) },
            scalarLoadStoreMemoryOperand(inst),
        ];
    }
    if (inst.encoding.fileName === "ldrsb_imm.xml" ||
        inst.encoding.fileName === "ldrsh_imm.xml" ||
        inst.encoding.fileName === "ldrsb_reg.xml" ||
        inst.encoding.fileName === "ldrsh_reg.xml" ||
        inst.encoding.fileName === "ldursb.xml" ||
        inst.encoding.fileName === "ldursh.xml" ||
        inst.encoding.fileName === "ldtrsb.xml" ||
        inst.encoding.fileName === "ldtrsh.xml") {
        const width = (fields.opc ?? 0) === 2 ? 64 : 32;
        return [gpReg(width, fields.Rt, "zr"), scalarLoadStoreMemoryOperand(inst)];
    }
    if (isFpSimdLoadStore(inst.encoding.fileName)) {
        return [
            { kind: "simd", index: fields.Rt, scalar: (fields.size ?? 0) === 0 && ((fields.opc ?? 0) & 2) !== 0 ? "q" : advsimdLaneFromSize(fields.size) },
            scalarLoadStoreMemoryOperand(inst),
        ];
    }
    const width = scalarLoadStoreRegisterWidth(inst.encoding.fileName, fields.size);
    return [gpReg(width, fields.Rt, "zr"), scalarLoadStoreMemoryOperand(inst)];
}
function orderedMemoryWidth(fileName, fields) {
    switch (fileName) {
        case "ldarb.xml":
        case "ldarh.xml":
            return 32;
        case "ldar.xml":
        case "ldxr.xml":
        case "ldaxr.xml":
        case "stxr.xml":
        case "stlxr.xml":
            return (fields.size ?? 0) === 0b11 ? 64 : 32;
        case "stxrb.xml":
        case "stxrh.xml":
        case "ldxrb.xml":
        case "ldxrh.xml":
        case "stlxrb.xml":
        case "stlxrh.xml":
        case "ldaxrb.xml":
        case "ldaxrh.xml":
            return 32;
        case "ldxp.xml":
        case "stxp.xml":
        case "ldaxp.xml":
            return (fields.sz ?? 0) === 1 ? 64 : 32;
        default:
            return 32;
    }
}
function orderedMemoryAddress(inst) {
    const base = formatRegister(gpReg(64, inst.fields.Rn, "sp"));
    return { kind: "text", text: `[${base}]` };
}
function ldrLiteralOperands(inst) {
    const fields = inst.fields;
    const width = ((fields.opc ?? 0) & 1) === 1 ? 64 : 32;
    return [
        gpReg(width, fields.Rt, "zr"),
        labelFromOffset(signExtend((fields.imm19 ?? 0) << 2, 21)),
    ];
}
function storeExclusiveOperands(inst) {
    const fields = inst.fields;
    const width = orderedMemoryWidth(inst.encoding.fileName, fields);
    return [
        gpReg(32, fields.Rs, "zr"),
        gpReg(width, fields.Rt, "zr"),
        orderedMemoryAddress(inst),
    ];
}
function loadExclusiveOperands(inst) {
    const fields = inst.fields;
    return [
        gpReg(orderedMemoryWidth(inst.encoding.fileName, fields), fields.Rt, "zr"),
        orderedMemoryAddress(inst),
    ];
}
function exclusivePairOperands(inst) {
    const fields = inst.fields;
    const width = orderedMemoryWidth(inst.encoding.fileName, fields);
    const ops = [];
    if (inst.encoding.fileName === "stxp.xml") {
        ops.push(gpReg(32, fields.Rs, "zr"));
    }
    ops.push(gpReg(width, fields.Rt, "zr"));
    ops.push(gpReg(width, fields.Rt2, "zr"));
    ops.push(orderedMemoryAddress(inst));
    return ops;
}
function stlxpOperands(inst) {
    const fields = inst.fields;
    const width = (fields.sz ?? 0) === 1 ? 64 : 32;
    const base = formatRegister(gpReg(64, fields.Rn, "sp"));
    return [
        gpReg(32, fields.Rs, "zr"),
        gpReg(width, fields.Rt, "zr"),
        gpReg(width, fields.Rt2, "zr"),
        { kind: "text", text: `[${base}]` },
    ];
}
function mteTagOffset(value, bits) {
    return signExtend(value ?? 0, bits) * 16n;
}
function mteTagMemoryText(inst, offsetField, bits) {
    const fields = inst.fields;
    const base = formatRegister(gpReg(64, fields.Rn, "sp"));
    const offset = mteTagOffset(fields[offsetField], bits);
    const encodingId = inst.encoding.encodingId;
    if (encodingId.includes("post")) {
        return `[${base}], ${formatSignedDecimalImmediate(offset)}`;
    }
    if (encodingId.includes("pre")) {
        return `[${base}, ${formatSignedDecimalImmediate(offset)}]!`;
    }
    return offset === 0n ? `[${base}]` : `[${base}, ${formatSignedDecimalImmediate(offset)}]`;
}
function mteTagStoreOperands(inst) {
    const fields = inst.fields;
    return [
        gpReg(64, fields.Rt, "sp"),
        { kind: "text", text: mteTagMemoryText(inst, "imm9", 9) },
    ];
}
function mteTagLoadOperands(inst) {
    const fields = inst.fields;
    return [
        gpReg(64, fields.Rt, "zr"),
        { kind: "text", text: mteTagMemoryText(inst, "imm9", 9) },
    ];
}
function mteTagPairStoreOperands(inst) {
    const fields = inst.fields;
    return [
        gpReg(64, fields.Rt, "zr"),
        gpReg(64, fields.Rt2, "zr"),
        { kind: "text", text: mteTagMemoryText(inst, "simm7", 7) },
    ];
}
function mteInsertRandomTagOperands(inst) {
    const fields = inst.fields;
    const ops = [
        gpReg(64, fields.Rd, "sp"),
        gpReg(64, fields.Rn, "sp"),
    ];
    if ((fields.Rm ?? 31) !== 31) {
        ops.push(gpReg(64, fields.Rm, "zr"));
    }
    return ops;
}
function mteAddSubTagOperands(inst) {
    const fields = inst.fields;
    return [
        gpReg(64, fields.Rd, "sp"),
        gpReg(64, fields.Rn, "sp"),
        { kind: "text", text: `#${((fields.imm6 ?? 0) << 4)}` },
        { kind: "text", text: `#${fields.imm4 ?? 0}` },
    ];
}
function mteTagMaskInsertOperands(inst) {
    const fields = inst.fields;
    return [
        gpReg(64, fields.Rd, "zr"),
        gpReg(64, fields.Rn, "sp"),
        gpReg(64, fields.Rm, "zr"),
    ];
}
function mteSubtractPointerOperands(inst) {
    const fields = inst.fields;
    return [
        gpReg(64, fields.Rd, "zr"),
        gpReg(64, fields.Rn, "sp"),
        gpReg(64, fields.Rm, "sp"),
    ];
}
function sveLaneFromSize(size) {
    return ["h", "s", "d"][(size ?? 1) - 1] ?? "h";
}
function sveVectorLaneFromSize(size) {
    return ["b", "h", "s", "d"][size ?? 0] ?? "b";
}
function sveSignedImmediate(value, bits) {
    return signExtend(value, bits);
}
function svePatternName(pattern) {
    return [
        "pow2",
        "vl1",
        "vl2",
        "vl3",
        "vl4",
        "vl5",
        "vl6",
        "vl7",
        "vl8",
        "vl16",
        "vl32",
        "vl64",
        "vl128",
        "vl256",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "mul4",
        "mul3",
    ][pattern];
}
function expandVfpImmediate(imm8, width) {
    const exponentBits = width === 16 ? 5 : width === 32 ? 8 : 11;
    const fractionBits = width - exponentBits - 1;
    const exponentBias = width === 16 ? 15 : width === 32 ? 127 : 1023;
    const sign = (imm8 >>> 7) & 1;
    const immBit6 = (imm8 >>> 6) & 1;
    const exponent = (((immBit6 ^ 1) & 1) << (exponentBits - 1)) |
        (((immBit6 === 1 ? 1 : 0) * ((1 << (exponentBits - 3)) - 1)) << 2) |
        ((imm8 >>> 4) & 0x3);
    const fraction = (imm8 & 0xf) * 2 ** (fractionBits - 4);
    const magnitude = exponent === 0 ? 2 ** (1 - exponentBias) * (fraction / 2 ** fractionBits) : 2 ** (exponent - exponentBias) * (1 + fraction / 2 ** fractionBits);
    return (sign ? -1 : 1) * magnitude;
}
function sveFloatingImmediate(imm8, size) {
    const width = (size === 1 ? 16 : size === 2 ? 32 : 64);
    return { kind: "fpimm", value: expandVfpImmediate(imm8, width) };
}
function scalarFpLaneFromFtype(ftype) {
    switch (ftype ?? 0) {
        case 3:
            return "h";
        case 1:
            return "d";
        default:
            return "s";
    }
}
function scalarFpRegisterText(index, lane) {
    return `${lane}${index}`;
}
function scalarFpCompareOperands(inst) {
    const fields = inst.fields;
    const lane = scalarFpLaneFromFtype(fields.ftype);
    const lhs = { kind: "text", text: scalarFpRegisterText(fields.Rn, lane) };
    if (((fields.opc ?? 0) & 1) === 1) {
        return [lhs, { kind: "text", text: "#0.0" }];
    }
    return [lhs, { kind: "text", text: scalarFpRegisterText(fields.Rm, lane) }];
}
function scalarFpConditionalCompareOperands(inst) {
    const fields = inst.fields;
    const lane = scalarFpLaneFromFtype(fields.ftype);
    return [
        { kind: "text", text: scalarFpRegisterText(fields.Rn, lane) },
        { kind: "text", text: scalarFpRegisterText(fields.Rm, lane) },
        { kind: "text", text: `#${fields.nzcv ?? 0}` },
        conditionOperand(fields.cond),
    ];
}
function scalarFpConditionalSelectOperands(inst) {
    const fields = inst.fields;
    const lane = scalarFpLaneFromFtype(fields.ftype);
    return [
        { kind: "text", text: scalarFpRegisterText(fields.Rd, lane) },
        { kind: "text", text: scalarFpRegisterText(fields.Rn, lane) },
        { kind: "text", text: scalarFpRegisterText(fields.Rm, lane) },
        conditionOperand(fields.cond),
    ];
}
function scalarFpConvertPrecisionOperands(inst) {
    const encodingId = inst.encoding.encodingId;
    const match = /^FCVT_([HSD])([HSD])_/.exec(encodingId);
    if (match) {
        const destLane = match[1].toLowerCase();
        const sourceLane = match[2].toLowerCase();
        const fields = inst.fields;
        return [
            { kind: "text", text: scalarFpRegisterText(fields.Rd, destLane) },
            { kind: "text", text: scalarFpRegisterText(fields.Rn, sourceLane) },
        ];
    }
    const fields = inst.fields;
    if (encodingId === "BFCVT_BS_floatdp1") {
        return [
            { kind: "text", text: scalarFpRegisterText(fields.Rd, "h") },
            { kind: "text", text: scalarFpRegisterText(fields.Rn, "s") },
        ];
    }
    return [];
}
function scalarFpMoveGeneralOperands(inst) {
    const fields = inst.fields;
    switch (inst.encoding.encodingId) {
        case "FMOV_32H_float2int":
            return [gpReg(32, fields.Rd, "zr"), { kind: "text", text: scalarFpRegisterText(fields.Rn, "h") }];
        case "FMOV_64H_float2int":
            return [gpReg(64, fields.Rd, "zr"), { kind: "text", text: scalarFpRegisterText(fields.Rn, "h") }];
        case "FMOV_H32_float2int":
            return [{ kind: "text", text: scalarFpRegisterText(fields.Rd, "h") }, gpReg(32, fields.Rn, "zr")];
        case "FMOV_S32_float2int":
            return [{ kind: "text", text: scalarFpRegisterText(fields.Rd, "s") }, gpReg(32, fields.Rn, "zr")];
        case "FMOV_32S_float2int":
            return [gpReg(32, fields.Rd, "zr"), { kind: "text", text: scalarFpRegisterText(fields.Rn, "s") }];
        case "FMOV_H64_float2int":
            return [{ kind: "text", text: scalarFpRegisterText(fields.Rd, "h") }, gpReg(64, fields.Rn, "zr")];
        case "FMOV_D64_float2int":
            return [{ kind: "text", text: scalarFpRegisterText(fields.Rd, "d") }, gpReg(64, fields.Rn, "zr")];
        case "FMOV_V64I_float2int":
            return [{ kind: "text", text: `v${fields.Rd}.d[1]` }, gpReg(64, fields.Rn, "zr")];
        case "FMOV_64D_float2int":
            return [gpReg(64, fields.Rd, "zr"), { kind: "text", text: scalarFpRegisterText(fields.Rn, "d") }];
        case "FMOV_64VX_float2int":
            return [gpReg(64, fields.Rd, "zr"), { kind: "text", text: `v${fields.Rn}.d[1]` }];
        default:
            return [];
    }
}
function scalarFpMoveImmediateOperands(inst) {
    const fields = inst.fields;
    const lane = scalarFpLaneFromFtype(fields.ftype);
    const width = lane === "h" ? 16 : lane === "s" ? 32 : 64;
    return [{ kind: "text", text: scalarFpRegisterText(fields.Rd, lane) }, { kind: "fpimm", value: expandVfpImmediate(fields.imm8 ?? 0, width) }];
}
function scalarFpToIntegerOperands(inst, fixedPoint = false) {
    const fields = inst.fields;
    const lane = scalarFpLaneFromFtype(fields.ftype);
    const ops = [
        gpReg(widthFromSf(fields.sf), fields.Rd, "zr"),
        { kind: "text", text: scalarFpRegisterText(fields.Rn, lane) },
    ];
    if (fixedPoint) {
        ops.push({ kind: "text", text: `#${64 - (fields.scale ?? 0)}` });
    }
    return ops;
}
function scalarIntegerToFpOperands(inst, fixedPoint = false) {
    const fields = inst.fields;
    const lane = scalarFpLaneFromFtype(fields.ftype);
    const ops = [
        { kind: "text", text: scalarFpRegisterText(fields.Rd, lane) },
        gpReg(widthFromSf(fields.sf), fields.Rn, "zr"),
    ];
    if (fixedPoint) {
        ops.push({ kind: "text", text: `#${64 - (fields.scale ?? 0)}` });
    }
    return ops;
}
function scalarFpUnaryOperands(inst) {
    const fields = inst.fields;
    const lane = scalarFpLaneFromFtype(fields.ftype);
    return [
        { kind: "text", text: scalarFpRegisterText(fields.Rd, lane) },
        { kind: "text", text: scalarFpRegisterText(fields.Rn, lane) },
    ];
}
function scalarFpBinaryOperands(inst) {
    const fields = inst.fields;
    const lane = scalarFpLaneFromFtype(fields.ftype);
    return [
        { kind: "text", text: scalarFpRegisterText(fields.Rd, lane) },
        { kind: "text", text: scalarFpRegisterText(fields.Rn, lane) },
        { kind: "text", text: scalarFpRegisterText(fields.Rm, lane) },
    ];
}
function scalarFpTernaryOperands(inst) {
    const fields = inst.fields;
    const lane = scalarFpLaneFromFtype(fields.ftype);
    return [
        { kind: "text", text: scalarFpRegisterText(fields.Rd, lane) },
        { kind: "text", text: scalarFpRegisterText(fields.Rn, lane) },
        { kind: "text", text: scalarFpRegisterText(fields.Rm, lane) },
        { kind: "text", text: scalarFpRegisterText(fields.Ra, lane) },
    ];
}
function sveMovprfxOperands(inst) {
    const fields = inst.fields;
    return [vecReg(fields.Zd), vecReg(fields.Zn)];
}
function svePredicatedMovprfxOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    return [vecReg(fields.Zd, lane), predReg(fields.Pg, fields.M === 1 ? "m" : "z"), vecReg(fields.Zn, lane)];
}
function sveFcpyOperands(inst) {
    const fields = inst.fields;
    const lane = sveLaneFromSize(fields.size);
    return [vecReg(fields.Zd, lane), predReg(fields.Pg, "m"), sveFloatingImmediate(fields.imm8, fields.size)];
}
function sveFdupOperands(inst) {
    const fields = inst.fields;
    const lane = sveLaneFromSize(fields.size);
    if (inst.encoding.fileName === "fmov_dup_z_i.xml")
        return sveDupImmediateOperands(inst);
    return [vecReg(fields.Zd, lane), sveFloatingImmediate(fields.imm8, fields.size)];
}
function sveDupIndexedLane(tsz) {
    const lowestBit = tsz & -tsz;
    switch (lowestBit) {
        case 1:
            return { lane: "b", lsb: 0 };
        case 2:
            return { lane: "h", lsb: 1 };
        case 4:
            return { lane: "s", lsb: 2 };
        case 8:
            return { lane: "d", lsb: 3 };
        case 16:
            return { lane: "q", lsb: 4 };
        default:
            return { lane: "b", lsb: 0 };
    }
}
function sveDupIndexedOperands(inst) {
    const fields = inst.fields;
    const encodedImm = ((fields.imm2 ?? 0) << 5) | (fields.tsz ?? 0);
    const { lane, lsb } = sveDupIndexedLane(fields.tsz ?? 0);
    const index = encodedImm >> (lsb + 1);
    const source = encodedImm !== 0 && (encodedImm & (encodedImm - 1)) === 0
        ? `${lane}${fields.Zn ?? 0}`
        : `z${fields.Zn ?? 0}.${lane}[${index}]`;
    return [vecReg(fields.Zd, lane), { kind: "text", text: source }];
}
function sveDupqIndexedOperands(inst) {
    const fields = inst.fields;
    const tsz = fields.tsz ?? 0;
    const encodedImm = ((fields.i1 ?? 0) << 4) | tsz;
    const { lane, lsb } = sveDupIndexedLane(tsz);
    if (lane === "q") {
        return [];
    }
    const index = encodedImm >> (lsb + 1);
    return [vecReg(fields.Zd ?? 0, lane), { kind: "text", text: `z${fields.Zn ?? 0}.${lane}[${index}]` }];
}
function sveDupImmediateOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    let imm = Number(signExtend(fields.imm8, 8));
    if ((fields.sh ?? 0) === 1) {
        imm <<= 8;
    }
    return [vecReg(fields.Zd, lane), { kind: "imm", value: BigInt(imm), signed: true }];
}
function sveCopyImmediateOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    let imm = Number(signExtend(fields.imm8, 8));
    if ((fields.sh ?? 0) === 1) {
        imm <<= 8;
    }
    return [vecReg(fields.Zd, lane), predReg(fields.Pg, "z"), { kind: "imm", value: BigInt(imm), signed: true }];
}
function sveCopyMergingImmediateOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    let imm = Number(signExtend(fields.imm8, 8));
    if ((fields.sh ?? 0) === 1) {
        imm <<= 8;
    }
    return [vecReg(fields.Zd, lane), predReg(fields.Pg, "m"), { kind: "imm", value: BigInt(imm), signed: true }];
}
function sveCopyScalarOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    const width = fields.size === 3 ? 64 : 32;
    return [vecReg(fields.Zd, lane), predReg(fields.Pg, "m"), gpReg(width, fields.Rn, "sp")];
}
function sveCopyScalarVectorOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    return [vecReg(fields.Zd, lane), predReg(fields.Pg, "m"), { kind: "text", text: `${lane}${fields.Vn ?? 0}` }];
}
function advsimdLaneFromSize(size) {
    switch (size ?? 0) {
        case 0:
            return "b";
        case 1:
            return "h";
        case 2:
            return "s";
        case 3:
            return "d";
        default:
            return "b";
    }
}
function advsimdArrangementFromSizeQ(size, q) {
    return (q === 1 ? ["16b", "8h", "4s", "2d"] : ["8b", "4h", "2s", "1d"])[size ?? 0];
}
function advsimdScalarRegisterText(index, size) {
    return `${advsimdLaneFromSize(size)}${index}`;
}
function advsimdVectorRegisterText(index, size, q) {
    return `v${index}.${advsimdArrangementFromSizeQ(size, q)}`;
}
function advsimdImmediateImm8(fields) {
    return (((fields.a ?? 0) << 7) |
        ((fields.b ?? 0) << 6) |
        ((fields.c ?? 0) << 5) |
        ((fields.d ?? 0) << 4) |
        ((fields.e ?? 0) << 3) |
        ((fields.f ?? 0) << 2) |
        ((fields.g ?? 0) << 1) |
        (fields.h ?? 0));
}
function replicatePattern(pattern, patternWidth, totalWidth) {
    let value = 0n;
    for (let offset = 0; offset < totalWidth; offset += patternWidth) {
        value |= pattern << BigInt(offset);
    }
    return value;
}
function advsimdExpandImmediate(op, cmode, imm8) {
    const cmodeHigh = (cmode >>> 1) & 0x7;
    const cmodeLow = cmode & 1;
    const imm = BigInt(imm8);
    switch (cmodeHigh) {
        case 0:
            return replicatePattern(imm, 32, 64);
        case 1:
            return replicatePattern(imm << 8n, 32, 64);
        case 2:
            return replicatePattern(imm << 16n, 32, 64);
        case 3:
            return replicatePattern(imm << 24n, 32, 64);
        case 4:
            return replicatePattern(imm, 16, 64);
        case 5:
            return replicatePattern(imm << 8n, 16, 64);
        case 6:
            return cmodeLow === 0
                ? replicatePattern((imm << 8n) | 0xffn, 32, 64)
                : replicatePattern((imm << 16n) | 0xffffn, 32, 64);
        case 7:
            if (cmodeLow === 0 && op === 0) {
                return replicatePattern(imm, 8, 64);
            }
            if (cmodeLow === 0 && op === 1) {
                let value = 0n;
                for (let bit = 7; bit >= 0; bit -= 1) {
                    value = (value << 8n) | (((imm8 >>> bit) & 1) === 1 ? 0xffn : 0n);
                }
                return value;
            }
            break;
        default:
            break;
    }
    return 0n;
}
function advsimdImmediateVectorText(fields, size, scalar = false) {
    if (scalar) {
        return advsimdScalarRegisterText(fields.Rd ?? 0, size);
    }
    return advsimdVectorRegisterText(fields.Rd ?? 0, size, fields.Q);
}
function advsimdImmediateShiftText(cmode, masked = false) {
    if (cmode === 14)
        return null;
    if (masked) {
        return (cmode & 1) === 0 ? "msl #8" : "msl #16";
    }
    const shift = ((cmode >>> 1) & 0x3) << 3;
    return shift === 0 ? null : `lsl #${shift}`;
}
function advsimdMoveImmediateOperands(inst) {
    const fields = inst.fields;
    const fileName = inst.encoding.fileName;
    const className = inst.encoding.className.toLowerCase();
    const imm8 = advsimdImmediateImm8(fields);
    const cmode = fields.cmode ?? 0;
    const op = fields.op ?? 0;
    const cmodeHigh = (cmode >>> 1) & 0x7;
    const cmodeLow = cmode & 1;
    const is64BitImmediate = (cmode === 0b1110) && op === 1;
    const isMaskedImmediate = cmodeHigh === 0b110;
    const size = fileName === "fmov_advsimd.xml"
        ? (className.includes("half-precision") ? 1 : op === 1 ? 3 : 2)
        : is64BitImmediate
            ? 3
            : cmodeHigh <= 0b011 || cmodeHigh === 0b110
                ? 2
                : cmodeHigh <= 0b101
                    ? 1
                    : (cmodeLow === 0 && op === 0 ? 0 : 3);
    const destination = advsimdImmediateVectorText(fields, size, fileName === "movi_advsimd.xml" && is64BitImmediate && (fields.Q ?? 0) === 0);
    if (fileName === "fmov_advsimd.xml") {
        const width = size === 1 ? 16 : size === 2 ? 32 : 64;
        return [{ kind: "text", text: destination }, { kind: "fpimm", value: expandVfpImmediate(imm8, width) }];
    }
    if (is64BitImmediate) {
        const imm64 = advsimdExpandImmediate(op, cmode, imm8);
        return [{ kind: "text", text: destination }, { kind: "text", text: `#0x${imm64.toString(16)}` }];
    }
    const operands = [
        { kind: "text", text: destination },
        { kind: "text", text: `#${imm8}` },
    ];
    const shiftText = advsimdImmediateShiftText(cmode, isMaskedImmediate);
    if (shiftText) {
        operands.push({ kind: "text", text: shiftText });
    }
    return operands;
}
function advsimdMoveRegisterAliasOperands(inst) {
    const fields = inst.fields;
    if (fields.Rn !== fields.Rm) {
        return [fields.Rd, fields.Rn, fields.Rm].map((index) => ({ kind: "simd", index, arrangement: { lanes: fields.Q === 1 ? 16 : 8, element: "b" } }));
    }
    return [
        { kind: "text", text: advsimdVectorRegisterText(fields.Rd ?? 0, 0, fields.Q) },
        { kind: "text", text: advsimdVectorRegisterText(fields.Rn ?? 0, 0, fields.Q) },
    ];
}
function advsimdLaneSizeFromImm5(imm5) {
    const encoded = imm5 ?? 0;
    for (let size = 0; size < 4; size += 1) {
        if (((encoded >> size) & 1) === 1) {
            return size;
        }
    }
    return 0;
}
function advsimdLaneIndexFromImm5(imm5, size) {
    return (imm5 ?? 0) >> (size + 1);
}
function advsimdCopyGeneralToElementOperands(inst) {
    const fields = inst.fields;
    const size = advsimdLaneSizeFromImm5(fields.imm5);
    const lane = advsimdLaneFromSize(size);
    const index = advsimdLaneIndexFromImm5(fields.imm5, size);
    const width = lane === "d" ? 64 : 32;
    return [
        { kind: "text", text: `v${fields.Rd ?? 0}.${lane}[${index}]` },
        gpReg(width, fields.Rn ?? 0, "zr"),
    ];
}
function advsimdCopyElementToElementOperands(inst) {
    const fields = inst.fields;
    const size = advsimdLaneSizeFromImm5(fields.imm5);
    const lane = advsimdLaneFromSize(size);
    const dstIndex = advsimdLaneIndexFromImm5(fields.imm5, size);
    const srcIndex = (fields.imm4 ?? 0) >> size;
    return [
        { kind: "text", text: `v${fields.Rd ?? 0}.${lane}[${dstIndex}]` },
        { kind: "text", text: `v${fields.Rn ?? 0}.${lane}[${srcIndex}]` },
    ];
}
function advsimdCopyElementToGeneralOperands(inst) {
    const fields = inst.fields;
    const size = advsimdLaneSizeFromImm5(fields.imm5);
    const lane = advsimdLaneFromSize(size);
    const index = advsimdLaneIndexFromImm5(fields.imm5, size);
    const width = (fields.Q ?? 0) === 1 ? 64 : 32;
    return [
        gpReg(width, fields.Rd ?? 0, "zr"),
        { kind: "text", text: `v${fields.Rn ?? 0}.${lane}[${index}]` },
    ];
}
function advsimdScalarDuplicateElementOperands(inst) {
    const fields = inst.fields;
    const size = advsimdLaneSizeFromImm5(fields.imm5);
    const lane = advsimdLaneFromSize(size);
    const index = advsimdLaneIndexFromImm5(fields.imm5, size);
    return [
        inst.encoding.className.toLowerCase().includes("vector")
            ? { kind: "simd", index: fields.Rd, arrangement: { lanes: (8 << fields.Q) >> size, element: lane } }
            : { kind: "simd", index: fields.Rd, scalar: lane },
        { kind: "text", text: `v${fields.Rn ?? 0}.${lane}[${index}]` },
    ];
}
function advsimdDuplicateGeneralOperands(inst) {
    const fields = inst.fields;
    const size = advsimdLaneSizeFromImm5(fields.imm5);
    const width = size === 3 ? 64 : 32;
    return [
        { kind: "text", text: advsimdVectorRegisterText(fields.Rd ?? 0, size, fields.Q) },
        gpReg(width, fields.Rn ?? 0, "zr"),
    ];
}
function advsimdPmullOperands(inst) {
    const fields = inst.fields;
    const size = fields.size ?? 0;
    const upper = (fields.Q ?? 0) === 1;
    const destinationArrangement = size === 0b11 ? "1q" : "8h";
    const sourceArrangement = size === 0b11 ? (upper ? "2d" : "1d") : (upper ? "16b" : "8b");
    return [
        { kind: "text", text: `v${fields.Rd ?? 0}.${destinationArrangement}` },
        { kind: "text", text: `v${fields.Rn ?? 0}.${sourceArrangement}` },
        { kind: "text", text: `v${fields.Rm ?? 0}.${sourceArrangement}` },
    ];
}
function advsimdExtractOperands(inst) {
    const fields = inst.fields;
    const arrangement = (fields.Q ?? 0) === 1 ? "16b" : "8b";
    return [
        { kind: "text", text: `v${fields.Rd ?? 0}.${arrangement}` },
        { kind: "text", text: `v${fields.Rn ?? 0}.${arrangement}` },
        { kind: "text", text: `v${fields.Rm ?? 0}.${arrangement}` },
        { kind: "text", text: `#${fields.imm4 ?? 0}` },
    ];
}
function advsimdElementSize(inst) {
    const fields = inst.fields;
    const className = inst.encoding.className.toLowerCase();
    if (["and_advsimd.xml", "orr_advsimd_reg.xml", "orn_advsimd.xml", "bic_advsimd_reg.xml", "eor_advsimd.xml", "rbit_advsimd.xml"].includes(inst.encoding.fileName))
        return 0;
    if (fields.immh !== undefined)
        return highestSetBitNZ(fields.immh);
    if (fields.size !== undefined) {
        return fields.size;
    }
    if (className.includes("half-precision")) {
        return 1;
    }
    if (fields.sz !== undefined) {
        return fields.sz + 2;
    }
    return 0;
}
function highestSetBitNZ(value) {
    const n = value ?? 0;
    return n === 0 ? 0 : 31 - Math.clz32(n);
}
function advsimdScalarRegisterFromImmh(index, immh) {
    return advsimdScalarRegisterText(index, highestSetBitNZ(immh));
}
function advsimdVectorRegisterFromImmh(index, immh, q) {
    return advsimdVectorRegisterText(index, highestSetBitNZ(immh), q);
}
function advsimdImmediateShiftOperands(inst) {
    const fields = inst.fields;
    const fileName = inst.encoding.fileName;
    const isScalar = inst.encoding.className.toLowerCase().includes("scalar");
    const immh = fields.immh ?? 0;
    const imm = (immh << 3) | (fields.immb ?? 0);
    const isLeftShift = fileName === "shl_advsimd.xml" ||
        fileName === "sqshl_advsimd_imm.xml" ||
        fileName === "uqshl_advsimd_imm.xml" ||
        fileName === "sqshlu_advsimd.xml" ||
        fileName === "sli_advsimd.xml";
    const esize = 8 << highestSetBitNZ(immh);
    const shift = isLeftShift ? imm - esize : (esize * 2) - imm;
    const registerText = isScalar
        ? (index) => advsimdScalarRegisterFromImmh(index, immh)
        : (index) => advsimdVectorRegisterFromImmh(index, immh, fields.Q);
    return [
        { kind: "text", text: registerText(fields.Rd ?? 0) },
        { kind: "text", text: registerText(fields.Rn ?? 0) },
        { kind: "text", text: `#${shift}` },
    ];
}
function advsimdNarrowingImmediateShiftOperands(inst) {
    const fields = inst.fields;
    const immh = fields.immh ?? 0;
    const size = highestSetBitNZ(immh);
    const esize = 8 << size;
    const shift = (2 * esize) - ((immh << 3) | (fields.immb ?? 0));
    const isScalar = inst.encoding.className.toLowerCase().includes("scalar");
    if (isScalar) {
        return [
            { kind: "text", text: advsimdScalarRegisterText(fields.Rd ?? 0, size) },
            { kind: "text", text: advsimdScalarRegisterText(fields.Rn ?? 0, size + 1) },
            { kind: "text", text: `#${shift}` },
        ];
    }
    return [
        { kind: "text", text: advsimdVectorRegisterText(fields.Rd ?? 0, size, fields.Q) },
        { kind: "text", text: `v${fields.Rn ?? 0}.${advsimdNarrowSourceArrangement(size)}` },
        { kind: "text", text: `#${shift}` },
    ];
}
function advsimdDotProductSourceText(index, q) {
    return `v${index}.${q === 1 ? "16b" : "8b"}`;
}
function advsimdBfloat16DotProductSourceText(index, q) {
    return `v${index}.${q === 1 ? "8h" : "4h"}`;
}
function advsimdUnaryOperands(inst) {
    const fields = inst.fields;
    const isScalar = inst.encoding.className.toLowerCase().includes("scalar") || inst.encoding.encodingId.includes("_asisd");
    const size = advsimdElementSize(inst);
    if (isScalar) {
        return [
            { kind: "text", text: advsimdScalarRegisterText(fields.Rd ?? 0, size) },
            { kind: "text", text: advsimdScalarRegisterText(fields.Rn ?? 0, size) },
        ];
    }
    return [
        { kind: "text", text: advsimdVectorRegisterText(fields.Rd ?? 0, size, fields.Q) },
        { kind: "text", text: advsimdVectorRegisterText(fields.Rn ?? 0, size, fields.Q) },
    ];
}
function advsimdUnaryWithImmediateOperands(inst) {
    const fields = inst.fields;
    const operands = advsimdUnaryOperands(inst);
    const fractionalBits = fields.immh === undefined ? 64 - (fields.scale ?? 0)
        : (16 << highestSetBitNZ(fields.immh)) - ((fields.immh << 3) | fields.immb);
    operands.push({ kind: "imm", value: BigInt(fractionalBits), signed: true });
    return operands;
}
function advsimdFloatingConvertNarrowOperands(inst) {
    const fields = inst.fields;
    const destArrangement = (fields.sz ?? 0) === 1
        ? ((fields.Q ?? 0) === 1 ? "4s" : "2s")
        : ((fields.Q ?? 0) === 1 ? "8h" : "4h");
    const sourceArrangement = (fields.sz ?? 0) === 1 ? "2d" : "4s";
    return [
        { kind: "text", text: `v${fields.Rd ?? 0}.${destArrangement}` },
        { kind: "text", text: `v${fields.Rn ?? 0}.${sourceArrangement}` },
    ];
}
function advsimdFloatingConvertLongOperands(inst) {
    const fields = inst.fields;
    const destArrangement = (fields.sz ?? 0) === 1 ? "2d" : "4s";
    const sourceArrangement = (fields.sz ?? 0) === 1
        ? ((fields.Q ?? 0) === 1 ? "4s" : "2s")
        : ((fields.Q ?? 0) === 1 ? "8h" : "4h");
    return [
        { kind: "text", text: `v${fields.Rd ?? 0}.${destArrangement}` },
        { kind: "text", text: `v${fields.Rn ?? 0}.${sourceArrangement}` },
    ];
}
function advsimdThreeSameOperands(inst) {
    const fields = inst.fields;
    const size = advsimdElementSize(inst);
    return [
        { kind: "text", text: advsimdVectorRegisterText(fields.Rd ?? 0, size, fields.Q) },
        { kind: "text", text: advsimdVectorRegisterText(fields.Rn ?? 0, size, fields.Q) },
        { kind: "text", text: advsimdVectorRegisterText(fields.Rm ?? 0, size, fields.Q) },
    ];
}
function advsimdTableLookupOperands(inst) {
    const fields = inst.fields;
    const arrangement = (fields.Q ?? 0) === 1 ? "16b" : "8b";
    const registerCount = ((fields.len ?? 0) & 0x3) + 1;
    const tableRegisters = Array.from({ length: registerCount }, (_, index) => `v${((fields.Rn ?? 0) + index) & 31}.16b`);
    return [
        { kind: "text", text: `v${fields.Rd ?? 0}.${arrangement}` },
        { kind: "text", text: `{ ${tableRegisters.join(", ")} }` },
        { kind: "text", text: `v${fields.Rm ?? 0}.${arrangement}` },
    ];
}
function advsimdFloatingPairwiseOperands(inst) {
    if (inst.encoding.fileName.endsWith("_vec.xml")) {
        return advsimdThreeSameOperands(inst);
    }
    const fields = inst.fields;
    const className = inst.encoding.className.toLowerCase();
    const size = className.includes("half") ? 1 : (fields.sz ?? 0) + 2;
    const sourceArrangement = size === 1 ? "2h" : size === 2 ? "2s" : "2d";
    return [
        { kind: "text", text: advsimdScalarRegisterText(fields.Rd ?? 0, size) },
        { kind: "text", text: `v${fields.Rn ?? 0}.${sourceArrangement}` },
    ];
}
function advsimdIntegerPairwiseOperands(inst) {
    if (inst.encoding.fileName.endsWith("_vec.xml")) {
        return advsimdThreeSameOperands(inst);
    }
    const fields = inst.fields;
    return [
        { kind: "text", text: `d${fields.Rd ?? 0}` },
        { kind: "text", text: `v${fields.Rn ?? 0}.2d` },
    ];
}
function advsimdFp8ConvertLongOperands(inst) {
    const fields = inst.fields;
    return [
        { kind: "text", text: `v${fields.Rd ?? 0}.8h` },
        { kind: "text", text: `v${fields.Rn ?? 0}.${(fields.Q ?? 0) === 1 ? "16b" : "8b"}` },
    ];
}
function advsimdFp8NarrowPairOperands(inst) {
    const fields = inst.fields;
    const fileName = inst.encoding.fileName;
    const sourceArrangement = fileName === "fcvtn_advsimd_168.xml"
        ? advsimdArrangementFromSizeQ(1, fields.Q)
        : "4s";
    return [
        { kind: "text", text: advsimdVectorRegisterText(fields.Rd ?? 0, 0, fields.Q) },
        { kind: "text", text: `v${fields.Rn ?? 0}.${sourceArrangement}` },
        { kind: "text", text: `v${fields.Rm ?? 0}.${sourceArrangement}` },
    ];
}
function advsimdFp8LutiRegisterCount(inst) {
    if (inst.encoding.fileName === "luti2_advsimd.xml") {
        return 1;
    }
    return 1 << inst.fields.op;
}
function advsimdFp8LutiOperands(inst) {
    const fields = inst.fields;
    const luti2 = inst.encoding.fileName === "luti2_advsimd.xml";
    const size = luti2 ? (fields.op2 === 2 ? 0 : 1) : fields.op;
    const arrangement = advsimdArrangementFromSizeQ(size, 1);
    const registerCount = advsimdFp8LutiRegisterCount(inst);
    const tableRegisters = Array.from({ length: registerCount }, (_, index) => `v${((fields.Rn ?? 0) + index) & 31}.${arrangement}`);
    const sourceIndex = fields.Rm;
    const elementIndex = luti2 ? (size === 0 ? fields.len : (fields.len << 1) | fields.op)
        : (size === 0 ? fields.len >>> 1 : fields.len);
    return [
        { kind: "text", text: `v${fields.Rd ?? 0}.${arrangement}` },
        { kind: "text", text: `{ ${tableRegisters.join(", ")} }` },
        { kind: "text", text: `v${sourceIndex}[${elementIndex}]` },
    ];
}
function complexRotateDegrees(inst) {
    const fields = inst.fields ?? {};
    if (inst.encoding?.fileName === "fcadd_advsimd_vec.xml" ||
        inst.encoding?.fileName === "fcadd_z_p_zz.xml" ||
        inst.encoding?.fileName === "cadd_z_zz.xml" ||
        inst.encoding?.fileName === "sqcadd_z_zz.xml") {
        return (((fields.rot ?? 0) & 0x1) * 180) + 90;
    }
    return ((fields.rot ?? 0) & 0x3) * 90;
}
function advsimdComplexVectorArrangement(inst) {
    const fields = inst.fields;
    const size = fields.size ?? 0;
    const q = fields.Q ?? 0;
    if (size === 1) {
        return q === 1 ? "8h" : "4h";
    }
    if (size === 2) {
        return q === 1 ? "4s" : "2s";
    }
    return "2d";
}
function advsimdComplexByElementLane(inst) {
    return (inst.fields.size ?? 0) === 1 ? "h" : "s";
}
function advsimdComplexByElementSourceIndex(inst) {
    const fields = inst.fields;
    if ((fields.size ?? 0) === 1) {
        return fields.Rm ?? 0;
    }
    return (((fields.M ?? 0) << 4) | (fields.Rm ?? 0));
}
function advsimdComplexByElementIndex(inst) {
    const fields = inst.fields;
    if ((fields.size ?? 0) === 1) {
        return (((fields.H ?? 0) << 1) | (fields.L ?? 0));
    }
    return fields.H ?? 0;
}
function advsimdComplexVectorOperands(inst) {
    const fields = inst.fields;
    const arrangement = advsimdComplexVectorArrangement(inst);
    return [
        { kind: "text", text: `v${fields.Rd ?? 0}.${arrangement}` },
        { kind: "text", text: `v${fields.Rn ?? 0}.${arrangement}` },
        { kind: "text", text: `v${fields.Rm ?? 0}.${arrangement}` },
        { kind: "text", text: `#${complexRotateDegrees(inst)}` },
    ];
}
function advsimdComplexByElementOperands(inst) {
    const fields = inst.fields;
    const arrangement = advsimdComplexVectorArrangement(inst);
    const lane = advsimdComplexByElementLane(inst);
    const sourceIndex = advsimdComplexByElementSourceIndex(inst);
    const elementIndex = advsimdComplexByElementIndex(inst);
    return [
        { kind: "text", text: `v${fields.Rd ?? 0}.${arrangement}` },
        { kind: "text", text: `v${fields.Rn ?? 0}.${arrangement}` },
        { kind: "text", text: `v${sourceIndex}.${lane}[${elementIndex}]` },
        { kind: "text", text: `#${complexRotateDegrees(inst)}` },
    ];
}
function advsimdFpLongMultiplyAccumulateOperands(inst) {
    const fields = inst.fields;
    if (inst.encoding.fileName.startsWith("fmlalb_") || inst.encoding.fileName.startsWith("fmlallbb_")) {
        const half = inst.encoding.fileName.startsWith("fmlalb_");
        const operands = [
            { kind: "simd", index: fields.Rd, arrangement: { lanes: half ? 8 : 4, element: half ? "h" : "s" } },
            { kind: "simd", index: fields.Rn, arrangement: { lanes: 16, element: "b" } },
        ];
        operands.push(inst.encoding.fileName.endsWith("_vec.xml")
            ? { kind: "simd", index: fields.Rm, arrangement: { lanes: 16, element: "b" } }
            : { kind: "simd", index: fields.Rm & 7, element: "b", laneIndex: (fields.H << 3) | (fields.L << 2) | (fields.M << 1) | (fields.Rm >>> 3) });
        return operands;
    }
    const destArrangement = (fields.Q ?? 0) === 1 ? "4s" : "2s";
    const sourceArrangement = (fields.Q ?? 0) === 1 ? "4h" : "2h";
    if (inst.encoding.fileName.endsWith("_vec.xml")) {
        return [
            { kind: "text", text: `v${fields.Rd ?? 0}.${destArrangement}` },
            { kind: "text", text: `v${fields.Rn ?? 0}.${sourceArrangement}` },
            { kind: "text", text: `v${fields.Rm ?? 0}.${sourceArrangement}` },
        ];
    }
    return [
        { kind: "text", text: `v${fields.Rd ?? 0}.${destArrangement}` },
        { kind: "text", text: `v${fields.Rn ?? 0}.${sourceArrangement}` },
        { kind: "simd", index: fields.Rm, element: "h", laneIndex: (fields.H << 2) | (fields.L << 1) | fields.M },
    ];
}
function advsimdPairwiseLongOperands(inst) {
    const fields = inst.fields;
    return [
        { kind: "text", text: advsimdVectorRegisterText(fields.Rd ?? 0, (fields.size ?? 0) + 1, fields.Q) },
        { kind: "text", text: advsimdVectorRegisterText(fields.Rn ?? 0, fields.size, fields.Q) },
    ];
}
function advsimdAcrossLaneOperands(inst) {
    const fields = inst.fields;
    const fileName = inst.encoding.fileName;
    const isLongReduction = fileName === "saddlv_advsimd.xml" || fileName === "uaddlv_advsimd.xml";
    const sourceSize = inst.encoding.className.toLowerCase().includes("half") ? 1 : fields.size ?? (fields.sz ?? 0) + 2;
    const destinationSize = isLongReduction ? sourceSize + 1 : sourceSize;
    return [
        { kind: "text", text: advsimdScalarRegisterText(fields.Rd ?? 0, destinationSize) },
        { kind: "text", text: advsimdVectorRegisterText(fields.Rn ?? 0, sourceSize, fields.Q) },
    ];
}
function advsimdLongDestArrangement(size) {
    switch (size ?? 0) {
        case 0:
            return "8h";
        case 1:
            return "4s";
        default:
            return "2d";
    }
}
function advsimdLongSourceArrangement(size, q) {
    if ((size ?? 0) === 0) {
        return q === 1 ? "16b" : "8b";
    }
    if ((size ?? 0) === 1) {
        return q === 1 ? "8h" : "4h";
    }
    return q === 1 ? "4s" : "2s";
}
function advsimdNarrowSourceArrangement(size) {
    switch (size ?? 0) {
        case 0:
            return "8h";
        case 1:
            return "4s";
        default:
            return "2d";
    }
}
function advsimdNarrowOperands(inst) {
    const fields = inst.fields;
    const size = inst.encoding.fileName === "bfcvtn_advsimd.xml" ? 1
        : inst.encoding.fileName === "fcvtxn_advsimd.xml" ? 2 : advsimdElementSize(inst);
    const isScalar = inst.encoding.className.toLowerCase().includes("scalar");
    if (isScalar) {
        return [
            { kind: "text", text: advsimdScalarRegisterText(fields.Rd ?? 0, size) },
            { kind: "text", text: advsimdScalarRegisterText(fields.Rn ?? 0, size + 1) },
        ];
    }
    return [
        { kind: "text", text: advsimdVectorRegisterText(fields.Rd ?? 0, size, fields.Q) },
        { kind: "text", text: `v${fields.Rn ?? 0}.${advsimdNarrowSourceArrangement(size)}` },
    ];
}
function advsimdShiftLeftLongOperands(inst) {
    const fields = inst.fields;
    const size = fields.size ?? highestSetBitNZ(fields.immh);
    const shift = fields.size !== undefined
        ? 8 << size
        : (((fields.immh ?? 0) << 3) | (fields.immb ?? 0)) - (8 << size);
    return [
        { kind: "text", text: `v${fields.Rd ?? 0}.${advsimdLongDestArrangement(size)}` },
        { kind: "text", text: `v${fields.Rn ?? 0}.${advsimdLongSourceArrangement(size, fields.Q)}` },
        { kind: "text", text: `#${shift}` },
    ];
}
function advsimdExtendLongOperands(inst) {
    const fields = inst.fields;
    const size = highestSetBitNZ(fields.immh);
    return [
        { kind: "text", text: `v${fields.Rd ?? 0}.${advsimdLongDestArrangement(size)}` },
        { kind: "text", text: `v${fields.Rn ?? 0}.${advsimdLongSourceArrangement(size, fields.Q)}` },
    ];
}
function advsimdWideningThreeRegOperands(inst) {
    const fields = inst.fields;
    const className = inst.encoding.className.toLowerCase();
    if (className.includes("scalar")) {
        const sourceSize = fields.size ?? 0;
        return [
            { kind: "text", text: advsimdScalarRegisterText(fields.Rd ?? 0, sourceSize + 1) },
            { kind: "text", text: advsimdScalarRegisterText(fields.Rn ?? 0, sourceSize) },
            { kind: "text", text: advsimdScalarRegisterText(fields.Rm ?? 0, sourceSize) },
        ];
    }
    const destArrangement = advsimdLongDestArrangement(fields.size);
    const sourceArrangement = advsimdLongSourceArrangement(fields.size, fields.Q);
    return [
        { kind: "text", text: `v${fields.Rd ?? 0}.${destArrangement}` },
        { kind: "text", text: `v${fields.Rn ?? 0}.${sourceArrangement}` },
        { kind: "text", text: `v${fields.Rm ?? 0}.${sourceArrangement}` },
    ];
}
function advsimdWideThreeRegOperands(inst) {
    const fields = inst.fields;
    const destArrangement = advsimdLongDestArrangement(fields.size);
    const sourceArrangement = advsimdLongSourceArrangement(fields.size, fields.Q);
    return [
        { kind: "text", text: `v${fields.Rd ?? 0}.${destArrangement}` },
        { kind: "text", text: `v${fields.Rn ?? 0}.${destArrangement}` },
        { kind: "text", text: `v${fields.Rm ?? 0}.${sourceArrangement}` },
    ];
}
function advsimdScalarOrVectorThreeSameOperands(inst) {
    const fields = inst.fields;
    const className = inst.encoding.className.toLowerCase();
    const size = advsimdElementSize(inst);
    if (className.includes("scalar")) {
        return [
            { kind: "text", text: advsimdScalarRegisterText(fields.Rd ?? 0, size) },
            { kind: "text", text: advsimdScalarRegisterText(fields.Rn ?? 0, size) },
            { kind: "text", text: advsimdScalarRegisterText(fields.Rm ?? 0, size) },
        ];
    }
    return [
        { kind: "text", text: advsimdVectorRegisterText(fields.Rd ?? 0, size, fields.Q) },
        { kind: "text", text: advsimdVectorRegisterText(fields.Rn ?? 0, size, fields.Q) },
        { kind: "text", text: advsimdVectorRegisterText(fields.Rm ?? 0, size, fields.Q) },
    ];
}
function advsimdCryptoBinaryOperands(inst) {
    const fields = inst.fields;
    return [
        { kind: "text", text: "v" + (fields.Rd ?? 0) + ".16b" },
        { kind: "text", text: "v" + (fields.Rn ?? 0) + ".16b" },
    ];
}
function advsimdCryptoSha1HashOperands(inst) {
    const fields = inst.fields;
    return [
        { kind: "text", text: advsimdScalarRegisterText(fields.Rd ?? 0, 2) },
        { kind: "text", text: advsimdScalarRegisterText(fields.Rn ?? 0, 2) },
    ];
}
function advsimdCryptoVector4sBinaryOperands(inst) {
    const fields = inst.fields;
    return [
        { kind: "text", text: `v${fields.Rd ?? 0}.4s` },
        { kind: "text", text: `v${fields.Rn ?? 0}.4s` },
    ];
}
function advsimdCryptoSha1ThreeRegOperands(inst) {
    const fields = inst.fields;
    return [
        { kind: "text", text: `q${fields.Rd ?? 0}` },
        { kind: "text", text: advsimdScalarRegisterText(fields.Rn ?? 0, 2) },
        { kind: "text", text: `v${fields.Rm ?? 0}.4s` },
    ];
}
function advsimdCryptoSha256HashOperands(inst) {
    const fields = inst.fields;
    return [
        { kind: "text", text: `q${fields.Rd ?? 0}` },
        { kind: "text", text: `q${fields.Rn ?? 0}` },
        { kind: "text", text: `v${fields.Rm ?? 0}.4s` },
    ];
}
function advsimdCryptoVector4sThreeRegOperands(inst) {
    const fields = inst.fields;
    return [
        { kind: "text", text: `v${fields.Rd ?? 0}.4s` },
        { kind: "text", text: `v${fields.Rn ?? 0}.4s` },
        { kind: "text", text: `v${fields.Rm ?? 0}.4s` },
    ];
}
function advsimdHighNarrowThreeRegOperands(inst) {
    const fields = inst.fields;
    const destArrangement = advsimdArrangementFromSizeQ(fields.size, fields.Q);
    const sourceArrangement = advsimdNarrowSourceArrangement(fields.size);
    return [
        { kind: "text", text: `v${fields.Rd ?? 0}.${destArrangement}` },
        { kind: "text", text: `v${fields.Rn ?? 0}.${sourceArrangement}` },
        { kind: "text", text: `v${fields.Rm ?? 0}.${sourceArrangement}` },
    ];
}
function advsimdStructureRegisterCount(encodingId) {
    const match = /_(?:R|I)([1-4])(?:_|$)/.exec(encodingId);
    if (!match) {
        return 1;
    }
    return Number(match[1]);
}
function advsimdStructureRegisterGroupText(start, count, size, q) {
    const arrangement = advsimdArrangementFromSizeQ(size, q);
    const registers = Array.from({ length: count }, (_, index) => `v${(start + index) & 31}.${arrangement}`);
    return `{ ${registers.join(", ")} }`;
}
function advsimdStructureMemoryText(base, postIndex, count, q) {
    const baseText = formatRegister(gpReg(64, base, "sp"));
    if (postIndex === undefined) {
        return `[${baseText}]`;
    }
    if (postIndex === 31) {
        const amount = BigInt(count * (8 << (q ?? 0)));
        return `[${baseText}], #${amount.toString()}`;
    }
    return `[${baseText}], ${formatRegister(gpReg(64, postIndex, "zr"))}`;
}
function advsimdSingleStructureRegisterCount(fileName) {
    const match = /^(?:ld|st)([1-4])r?_advsimd(?:_sngl)?\.xml$/.exec(fileName);
    if (!match) {
        return 1;
    }
    return Number(match[1]);
}
function advsimdSingleStructureElementSize(fileName, encodingId, fields) {
    if (fileName.endsWith("_sngl.xml")) {
        if (encodingId.includes("_B")) {
            return 0;
        }
        if (encodingId.includes("_H")) {
            return 1;
        }
        if (encodingId.includes("_S")) {
            return 2;
        }
        if (encodingId.includes("_D")) {
            return 3;
        }
    }
    return fields.size ?? 0;
}
function advsimdSingleStructureLaneIndex(size, fields) {
    const q = fields.Q ?? 0;
    const s = fields.S ?? 0;
    const encodedSize = fields.size ?? 0;
    switch (size) {
        case 0:
            return (q << 3) | (s << 2) | encodedSize;
        case 1:
            return (q << 2) | (s << 1) | (encodedSize >> 1);
        case 2:
            return (q << 1) | s;
        case 3:
            return q;
        default:
            return 0;
    }
}
function advsimdSingleStructureRegistersText(start, count, lane, laneIndex) {
    const registers = Array.from({ length: count }, (_, index) => `v${(start + index) & 31}.${lane}`);
    return `{ ${registers.join(", ")} }[${laneIndex}]`;
}
function advsimdSingleStructureMemoryText(base, postIndex, count, elementSize) {
    const baseText = formatRegister(gpReg(64, base, "sp"));
    if (postIndex === undefined) {
        return `[${baseText}]`;
    }
    if (postIndex === 31) {
        const amount = BigInt(count << elementSize);
        return `[${baseText}], #${amount.toString()}`;
    }
    return `[${baseText}], ${formatRegister(gpReg(64, postIndex, "zr"))}`;
}
function advsimdSingleStructureOperands(inst) {
    const encoding = inst.encoding;
    const fields = inst.fields;
    const fileName = encoding.fileName;
    const count = advsimdSingleStructureRegisterCount(fileName);
    const elementSize = advsimdSingleStructureElementSize(fileName, encoding.encodingId, fields);
    const start = fields.Rt ?? 0;
    if (fileName.endsWith("r_advsimd.xml")) {
        const registers = advsimdStructureRegisterGroupText(start, count, elementSize, fields.Q);
        const memory = advsimdSingleStructureMemoryText(fields.Rn ?? 0, fields.Rm, count, elementSize);
        return [{ kind: "text", text: registers }, { kind: "text", text: memory }];
    }
    const lane = advsimdLaneFromSize(elementSize);
    const laneIndex = advsimdSingleStructureLaneIndex(elementSize, fields);
    const registers = advsimdSingleStructureRegistersText(start, count, lane, laneIndex);
    const memory = advsimdSingleStructureMemoryText(fields.Rn ?? 0, fields.Rm, count, elementSize);
    return [{ kind: "text", text: registers }, { kind: "text", text: memory }];
}
function advsimdByElementSourceIndex(fields, size) {
    return size === 2 ? (((fields.M ?? 0) << 4) | (fields.Rm ?? 0)) : (fields.Rm ?? 0);
}
function advsimdByElementIndex(fields, size) {
    if (size === 2) {
        return ((fields.H ?? 0) << 1) | (fields.L ?? 0);
    }
    return ((fields.H ?? 0) << 2) | ((fields.L ?? 0) << 1) | (fields.M ?? 0);
}
function advsimdFpByElementLane(inst) {
    const className = inst.encoding.className.toLowerCase();
    if (className.includes("half")) {
        return "h";
    }
    return (inst.fields.sz ?? 0) === 1 ? "d" : "s";
}
function advsimdFpByElementVectorArrangement(inst) {
    const lane = advsimdFpByElementLane(inst);
    const q = inst.fields.Q ?? 0;
    if (lane === "h") {
        return q === 1 ? "8h" : "4h";
    }
    if (lane === "s") {
        return q === 1 ? "4s" : "2s";
    }
    return "2d";
}
function advsimdFpByElementSourceIndex(inst) {
    const className = inst.encoding.className.toLowerCase();
    const fields = inst.fields;
    return className.includes("half") ? (fields.Rm ?? 0) : (((fields.M ?? 0) << 4) | (fields.Rm ?? 0));
}
function advsimdFpByElementIndex(inst) {
    const className = inst.encoding.className.toLowerCase();
    const fields = inst.fields;
    if (className.includes("half")) {
        return ((fields.H ?? 0) << 2) | ((fields.L ?? 0) << 1) | (fields.M ?? 0);
    }
    return (fields.sz ?? 0) === 1 ? (fields.H ?? 0) : (((fields.H ?? 0) << 1) | (fields.L ?? 0));
}
function advsimdByElementMultiplyAccumulateOperands(inst) {
    const fields = inst.fields;
    const fileName = inst.encoding.fileName;
    if (fileName === "mla_advsimd_elt.xml" || fileName === "mls_advsimd_elt.xml" || fileName === "mul_advsimd_elt.xml") {
        const lane = advsimdLaneFromSize(fields.size);
        return [
            { kind: "text", text: advsimdVectorRegisterText(fields.Rd ?? 0, fields.size, fields.Q) },
            { kind: "text", text: advsimdVectorRegisterText(fields.Rn ?? 0, fields.size, fields.Q) },
            { kind: "text", text: `v${advsimdByElementSourceIndex(fields, fields.size)}.${lane}[${advsimdByElementIndex(fields, fields.size)}]` },
        ];
    }
    const lane = advsimdFpByElementLane(inst);
    const sourceIndex = advsimdFpByElementSourceIndex(inst);
    const elementIndex = advsimdFpByElementIndex(inst);
    const className = inst.encoding.className.toLowerCase();
    if (className.includes("scalar")) {
        return [
            { kind: "text", text: advsimdScalarRegisterText(fields.Rd ?? 0, lane === "h" ? 1 : lane === "s" ? 2 : 3) },
            { kind: "text", text: advsimdScalarRegisterText(fields.Rn ?? 0, lane === "h" ? 1 : lane === "s" ? 2 : 3) },
            { kind: "text", text: `v${sourceIndex}.${lane}[${elementIndex}]` },
        ];
    }
    const arrangement = advsimdFpByElementVectorArrangement(inst);
    return [
        { kind: "text", text: `v${fields.Rd ?? 0}.${arrangement}` },
        { kind: "text", text: `v${fields.Rn ?? 0}.${arrangement}` },
        { kind: "text", text: `v${sourceIndex}.${lane}[${elementIndex}]` },
    ];
}
function advsimdByElementLongOperands(inst) {
    const fields = inst.fields;
    const size = fields.size;
    const lane = advsimdLaneFromSize(size);
    const sourceIndex = advsimdByElementSourceIndex(fields, size);
    const elementIndex = advsimdByElementIndex(fields, size);
    if (inst.encoding.className.toLowerCase().includes("scalar")) {
        const destSize = (size ?? 0) + 1;
        return [
            { kind: "text", text: advsimdScalarRegisterText(fields.Rd ?? 0, destSize) },
            { kind: "text", text: advsimdScalarRegisterText(fields.Rn ?? 0, size) },
            { kind: "text", text: `v${sourceIndex}.${lane}[${elementIndex}]` },
        ];
    }
    return [
        { kind: "text", text: `v${fields.Rd ?? 0}.${advsimdLongDestArrangement(size)}` },
        { kind: "text", text: `v${fields.Rn ?? 0}.${advsimdLongSourceArrangement(size, fields.Q)}` },
        { kind: "text", text: `v${sourceIndex}.${lane}[${elementIndex}]` },
    ];
}
function advsimdSaturatingRoundingDoublingMultiplyOperands(inst) {
    const fields = inst.fields;
    const size = fields.size;
    const lane = advsimdLaneFromSize(size);
    if (inst.encoding.className === "Scalar") {
        if (inst.encoding.fileName.endsWith("_vec.xml")) {
            return [
                { kind: "text", text: advsimdScalarRegisterText(fields.Rd ?? 0, size) },
                { kind: "text", text: advsimdScalarRegisterText(fields.Rn ?? 0, size) },
                { kind: "text", text: advsimdScalarRegisterText(fields.Rm ?? 0, size) },
            ];
        }
        return [
            { kind: "text", text: advsimdScalarRegisterText(fields.Rd ?? 0, size) },
            { kind: "text", text: advsimdScalarRegisterText(fields.Rn ?? 0, size) },
            { kind: "text", text: `v${advsimdByElementSourceIndex(fields, size)}.${lane}[${advsimdByElementIndex(fields, size)}]` },
        ];
    }
    if (inst.encoding.fileName.endsWith("_vec.xml")) {
        return [
            { kind: "text", text: advsimdVectorRegisterText(fields.Rd ?? 0, size, fields.Q) },
            { kind: "text", text: advsimdVectorRegisterText(fields.Rn ?? 0, size, fields.Q) },
            { kind: "text", text: advsimdVectorRegisterText(fields.Rm ?? 0, size, fields.Q) },
        ];
    }
    if (inst.encoding.fileName.endsWith("_elt.xml")) {
        return [
            { kind: "text", text: advsimdVectorRegisterText(fields.Rd ?? 0, size, fields.Q) },
            { kind: "text", text: advsimdVectorRegisterText(fields.Rn ?? 0, size, fields.Q) },
            { kind: "text", text: `v${advsimdByElementSourceIndex(fields, size)}.${lane}[${advsimdByElementIndex(fields, size)}]` },
        ];
    }
    return [];
}
function advsimdDotProductOperands(inst) {
    const fields = inst.fields;
    const fileName = inst.encoding.fileName;
    const isBfloat16 = fileName.startsWith("bfdot_");
    const isMixedSignByElement = fileName === "sudot_advsimd_elt.xml" || fileName === "usdot_advsimd_elt.xml";
    const size = isMixedSignByElement || isBfloat16 ? 2 : fields.size;
    if (fileName.endsWith("_vec.xml")) {
        return [
            { kind: "text", text: advsimdVectorRegisterText(fields.Rd ?? 0, size, fields.Q) },
            {
                kind: "text",
                text: isBfloat16
                    ? advsimdBfloat16DotProductSourceText(fields.Rn ?? 0, fields.Q)
                    : advsimdDotProductSourceText(fields.Rn ?? 0, fields.Q),
            },
            {
                kind: "text",
                text: isBfloat16
                    ? advsimdBfloat16DotProductSourceText(fields.Rm ?? 0, fields.Q)
                    : advsimdDotProductSourceText(fields.Rm ?? 0, fields.Q),
            },
        ];
    }
    if (fileName.endsWith("_elt.xml")) {
        const sourceIndex = isMixedSignByElement
            ? (((fields.M ?? 0) << 4) | (fields.Rm ?? 0))
            : advsimdByElementSourceIndex(fields, size);
        const elementIndex = isMixedSignByElement
            ? (((fields.H ?? 0) << 1) | (fields.L ?? 0))
            : advsimdByElementIndex(fields, size);
        return [
            { kind: "text", text: advsimdVectorRegisterText(fields.Rd ?? 0, size, fields.Q) },
            {
                kind: "text",
                text: isBfloat16
                    ? advsimdBfloat16DotProductSourceText(fields.Rn ?? 0, fields.Q)
                    : advsimdDotProductSourceText(fields.Rn ?? 0, fields.Q),
            },
            {
                kind: "text",
                text: isBfloat16
                    ? `v${sourceIndex}.2h[${elementIndex}]`
                    : `v${sourceIndex}.4b[${elementIndex}]`,
            },
        ];
    }
    return [];
}
function advsimdBfloat16MultiplyAccumulateOperands(inst) {
    const fields = inst.fields;
    if (inst.encoding.fileName === "bfmmla_advsimd.xml") {
        return [
            { kind: "text", text: "v" + (fields.Rd ?? 0) + ".4s" },
            { kind: "text", text: "v" + (fields.Rn ?? 0) + ".8h" },
            { kind: "text", text: "v" + (fields.Rm ?? 0) + ".8h" },
        ];
    }
    if (inst.encoding.fileName === "bfmlal_advsimd_vec.xml") {
        return [
            { kind: "text", text: "v" + (fields.Rd ?? 0) + ".4s" },
            { kind: "text", text: "v" + (fields.Rn ?? 0) + ".8h" },
            { kind: "text", text: "v" + (fields.Rm ?? 0) + ".8h" },
        ];
    }
    if (inst.encoding.fileName === "bfmlal_advsimd_elt.xml") {
        return [
            { kind: "text", text: "v" + (fields.Rd ?? 0) + ".4s" },
            { kind: "text", text: "v" + (fields.Rn ?? 0) + ".8h" },
            { kind: "text", text: `v${advsimdByElementSourceIndex(fields, fields.size)}.h[${advsimdByElementIndex(fields, fields.size)}]` },
        ];
    }
    return [];
}
function advsimdMatrixMultiplyAccumulateOperands(inst) {
    const fields = inst.fields;
    return [
        { kind: "text", text: `v${fields.Rd ?? 0}.4s` },
        { kind: "text", text: `v${fields.Rn ?? 0}.16b` },
        { kind: "text", text: `v${fields.Rm ?? 0}.16b` },
    ];
}
function advsimdMultipleStructureOperands(inst) {
    const fields = inst.fields;
    const encodingId = inst.encoding.encodingId;
    const regCount = advsimdStructureRegisterCount(encodingId);
    const start = fields.Rt ?? 0;
    const registers = advsimdStructureRegisterGroupText(start, regCount, fields.size, fields.Q);
    const memory = advsimdStructureMemoryText(fields.Rn ?? 0, fields.Rm, regCount, fields.Q);
    return [{ kind: "text", text: registers }, { kind: "text", text: memory }];
}
function advsimdFpCompareLane(inst) {
    const className = inst.encoding.className.toLowerCase();
    if (className.includes("half")) {
        return "h";
    }
    return (inst.fields.sz ?? 0) === 1 ? "d" : "s";
}
function advsimdFpCompareVectorArrangement(inst) {
    const lane = advsimdFpCompareLane(inst);
    const q = inst.fields.Q ?? 0;
    if (lane === "h") {
        return q === 1 ? "8h" : "4h";
    }
    if (lane === "s") {
        return q === 1 ? "4s" : "2s";
    }
    return "2d";
}
function advsimdCompareOperands(inst) {
    const encoding = inst.encoding;
    const fields = inst.fields;
    const fileName = encoding.fileName;
    const className = encoding.className.toLowerCase();
    const isFloat = fileName.startsWith("fcm") || fileName.startsWith("facg");
    const isScalar = className.includes("scalar");
    const isZeroForm = fileName.includes("_zero") ||
        fileName === "cmle_advsimd.xml" ||
        fileName === "cmlt_advsimd.xml" ||
        fileName === "fcmle_advsimd.xml" ||
        fileName === "fcmlt_advsimd.xml";
    if (isFloat) {
        const lane = advsimdFpCompareLane(inst);
        const destination = isScalar
            ? scalarFpRegisterText(fields.Rd ?? 0, lane)
            : `v${fields.Rd ?? 0}.${advsimdFpCompareVectorArrangement(inst)}`;
        const source = isScalar
            ? scalarFpRegisterText(fields.Rn ?? 0, lane)
            : `v${fields.Rn ?? 0}.${advsimdFpCompareVectorArrangement(inst)}`;
        if (isZeroForm) {
            return [
                { kind: "text", text: destination },
                { kind: "text", text: source },
                { kind: "text", text: "#0.0" },
            ];
        }
        const other = isScalar
            ? scalarFpRegisterText(fields.Rm ?? 0, lane)
            : `v${fields.Rm ?? 0}.${advsimdFpCompareVectorArrangement(inst)}`;
        return [
            { kind: "text", text: destination },
            { kind: "text", text: source },
            { kind: "text", text: other },
        ];
    }
    const destination = isScalar
        ? advsimdScalarRegisterText(fields.Rd ?? 0, fields.size)
        : advsimdVectorRegisterText(fields.Rd ?? 0, fields.size, fields.Q);
    const source = isScalar
        ? advsimdScalarRegisterText(fields.Rn ?? 0, fields.size)
        : advsimdVectorRegisterText(fields.Rn ?? 0, fields.size, fields.Q);
    if (isZeroForm) {
        return [
            { kind: "text", text: destination },
            { kind: "text", text: source },
            { kind: "text", text: "#0" },
        ];
    }
    const other = isScalar
        ? advsimdScalarRegisterText(fields.Rm ?? 0, fields.size)
        : advsimdVectorRegisterText(fields.Rm ?? 0, fields.size, fields.Q);
    return [
        { kind: "text", text: destination },
        { kind: "text", text: source },
        { kind: "text", text: other },
    ];
}
function sveCompareImmediateOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    const immField = fields.imm5 ?? fields.imm7 ?? 0;
    const immBits = fields.imm5 !== undefined ? 5 : 7;
    return [
        predReg(fields.Pd, undefined, lane),
        predReg(fields.Pg, "z"),
        vecReg(fields.Zn, lane),
        { kind: "imm", value: immBits === 7 ? BigInt(immField) : sveSignedImmediate(immField, immBits), signed: immBits === 5 },
    ];
}
function sveFloatingCompareImmediateOperands(inst) {
    const fields = inst.fields;
    const lane = sveLaneFromSize(fields.size);
    return [
        predReg(fields.Pd, undefined, lane),
        predReg(fields.Pg, "z"),
        vecReg(fields.Zn, lane),
        { kind: "text", text: "#0.0" },
    ];
}
function sveCompareVectorOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    return [
        predReg(fields.Pd, undefined, lane),
        predReg(fields.Pg, "z"),
        vecReg(fields.Zn, lane),
        vecReg(fields.Zm, lane),
    ];
}
function sveCompareWideVectorOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    return [
        predReg(fields.Pd, undefined, lane),
        predReg(fields.Pg, "z"),
        vecReg(fields.Zn, lane),
        vecReg(fields.Zm, "d"),
    ];
}
function sveIncDecScalarOperands(inst) {
    const fields = inst.fields;
    const pattern = fields.pattern ?? 0;
    const multiplier = (fields.imm4 ?? 0) + 1;
    const ops = sveIncDecScalarRegisters(inst);
    const patternName = pattern === 31 ? "all" : svePatternName(pattern);
    if (patternName) {
        if (!(pattern === 31 && (fields.imm4 ?? 0) === 0)) {
            ops.push({ kind: "text", text: patternName });
        }
    }
    else if (pattern !== 31) {
        ops.push({ kind: "imm", value: BigInt(pattern), signed: true });
    }
    if ((fields.imm4 ?? 0) !== 0) {
        ops.push({ kind: "text", text: `mul #${multiplier}` });
    }
    return ops;
}
function sveIncDecScalarRegisters(inst) {
    const fields = inst.fields;
    const isUnsignedScalar32 = inst.encoding.className === "32-bit" && inst.encoding.mnemonic.startsWith("UQ");
    const rd = fields.Rdn ?? fields.Rd ?? 0;
    const ops = [gpReg(isUnsignedScalar32 ? 32 : 64, rd, "zr")];
    if (inst.encoding.className === "32-bit" && !isUnsignedScalar32) {
        ops.push(gpReg(32, rd, "zr"));
    }
    return ops;
}
function sveIncDecPredicateScalarOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    const ops = sveIncDecScalarRegisters(inst);
    const [dst, ...rest] = ops;
    return [dst, predReg(fields.Pm ?? 0, undefined, lane), ...rest];
}
function sveCountPredicateOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    if (inst.encoding.fileName === "cntp_r_pn.xml") {
        return [
            gpReg(64, fields.Rd ?? 0),
            { kind: "text", text: `pn${fields.PNn ?? 0}.${lane}` },
            { kind: "text", text: `vlx${2 << (fields.vl ?? 0)}` },
        ];
    }
    return [
        gpReg(64, fields.Rd ?? 0),
        predReg(fields.Pg ?? 0),
        predReg(fields.Pn ?? 0, undefined, lane),
    ];
}
function svePtrueOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    const pattern = fields.pattern ?? 31;
    const ops = [predReg(fields.Pd, undefined, lane)];
    const patternName = pattern === 31 ? "all" : svePatternName(pattern);
    if (patternName) {
        if (pattern !== 31) {
            ops.push({ kind: "text", text: patternName });
        }
    }
    else if (pattern !== 31) {
        ops.push({ kind: "imm", value: BigInt(pattern), signed: false });
    }
    return ops;
}
function svePredicatePairText(pd, lane) {
    const first = pd << 1;
    return `{ p${first}.${lane}, p${first + 1}.${lane} }`;
}
function svePredicateCounterText(pnd, lane) {
    return `pn${8 + pnd}.${lane}`;
}
function sveWhileCompareOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    const fileName = inst.encoding.fileName;
    if (fileName.endsWith("_p_rr.xml") && !fileName.endsWith("_p_p_rr.xml")) {
        return [predReg(fields.Pd, undefined, lane), gpReg(64, fields.Rn, "zr"), gpReg(64, fields.Rm, "zr")];
    }
    if (fileName.endsWith("_p_p_rr.xml")) {
        const width = widthFromSf(fields.sf);
        return [
            predReg(fields.Pd, undefined, lane),
            gpReg(width, fields.Rn, "zr"),
            gpReg(width, fields.Rm, "zr"),
        ];
    }
    if (fileName.endsWith("_pp_rr.xml")) {
        return [
            { kind: "text", text: svePredicatePairText(fields.Pd, lane) },
            gpReg(64, fields.Rn, "zr"),
            gpReg(64, fields.Rm, "zr"),
        ];
    }
    if (fileName.endsWith("_pn_rr.xml")) {
        return [
            { kind: "text", text: svePredicateCounterText(fields.PNd, lane) },
            gpReg(64, fields.Rn, "zr"),
            gpReg(64, fields.Rm, "zr"),
            { kind: "text", text: `vlx${2 << (fields.vl ?? 0)}` },
        ];
    }
    return [];
}
function svePtruePredicateCounterOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    return [{ kind: "text", text: svePredicateCounterText(fields.PNd, lane) }];
}
function svePmovLane(inst) {
    const encodingId = inst.encoding.encodingId;
    if (encodingId.endsWith("_d")) {
        return "d";
    }
    if (encodingId.endsWith("_s")) {
        return "s";
    }
    if (encodingId.endsWith("_h")) {
        return "h";
    }
    return "b";
}
function svePmovIndex(fields) {
    if (fields.i3h !== undefined || fields.i3l !== undefined) {
        return ((fields.i3h ?? 0) << 2) | (fields.i3l ?? 0);
    }
    if (fields.i2 !== undefined) {
        return fields.i2;
    }
    if (fields.i1 !== undefined) {
        return fields.i1;
    }
    return 0;
}
function svePmovPredicateOperands(inst) {
    const fields = inst.fields;
    const lane = svePmovLane(inst);
    const index = svePmovIndex(fields);
    const source = index === 0 && lane === "b" ? `z${fields.Zn ?? 0}` : `z${fields.Zn ?? 0}[${index}]`;
    return [predReg(fields.Pd ?? 0, undefined, lane), { kind: "text", text: source }];
}
function svePmovVectorOperands(inst) {
    const fields = inst.fields;
    const lane = svePmovLane(inst);
    const index = svePmovIndex(fields);
    const destination = index === 0 && lane === "b" ? `z${fields.Zd ?? 0}` : `z${fields.Zd ?? 0}[${index}]`;
    return [{ kind: "text", text: destination }, predReg(fields.Pn ?? 0, undefined, lane)];
}
function svePextOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    const source = { kind: "text", text: `pn${8 + (fields.PNn ?? 0)}[${fields.imm2 ?? fields.i1 ?? 0}]` };
    if (inst.encoding.fileName === "pext_pp_rr.xml") {
        const first = fields.Pd ?? 0;
        return [{ kind: "text", text: `{ p${first}.${lane}, p${(first + 1) & 15}.${lane} }` }, source];
    }
    return [predReg(fields.Pd ?? 0, undefined, lane), source];
}
function svePredicateBreakOperands(inst) {
    const fields = inst.fields;
    return [
        predReg(fields.Pd ?? 0, undefined, "b"),
        predReg(fields.Pg ?? 0, (fields.M ?? 0) === 1 ? "m" : "z"),
        predReg(fields.Pn ?? 0, undefined, "b"),
    ];
}
function svePredicateFlowOperands(inst) {
    const fields = inst.fields;
    const lane = inst.encoding.fileName === "pnext_p_p_p.xml" ? sveVectorLaneFromSize(fields.size) : "b";
    const pdn = predReg(fields.Pdn ?? 0, undefined, lane);
    const pgField = inst.encoding.fileName === "pnext_p_p_p.xml" ? "Pv" : "Pg";
    return [pdn, predReg(fields[pgField] ?? 0), pdn];
}
function svePredicateBreakPropagationOperands(inst) {
    const fields = inst.fields;
    const pdm = fields.Pdm ?? 0;
    return [
        predReg(pdm, undefined, "b"),
        predReg(fields.Pg ?? 0, "z"),
        predReg(fields.Pn ?? 0, undefined, "b"),
        predReg(pdm, undefined, "b"),
    ];
}
function svePredicateBreakPairOperands(inst) {
    const fields = inst.fields;
    return [
        predReg(fields.Pd ?? 0, undefined, "b"),
        predReg(fields.Pg ?? 0, "z"),
        predReg(fields.Pn ?? 0, undefined, "b"),
        predReg(fields.Pm ?? 0, undefined, "b"),
    ];
}
function svePredicateTestOperands(inst) {
    const fields = inst.fields;
    return [predReg(fields.Pg ?? 0), predReg(fields.Pn ?? 0, undefined, "b")];
}
function sveRdffrOperands(inst) {
    const fields = inst.fields;
    switch (inst.encoding.fileName) {
        case "rdffr_p_f.xml":
            return [predReg(fields.Pd ?? 0, undefined, "b")];
        case "rdffr_p_p_f.xml":
        case "rdffrs_p_p_f.xml":
            return [predReg(fields.Pd ?? 0, undefined, "b"), predReg(fields.Pg ?? 0, "z")];
        default:
            return [];
    }
}
function svePredicatedUnaryOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    const mode = inst.encoding.encodingId.endsWith("_z") ? "z" : "m";
    return [vecReg(fields.Zd, lane), predReg(fields.Pg, mode), vecReg(fields.Zn, lane)];
}
function sveUnpackOperands(inst) {
    const fields = inst.fields;
    const destinationLane = sveVectorLaneFromSize(fields.size);
    const sourceLane = sveVectorLaneFromSize(fields.size === undefined ? undefined : Math.max(0, fields.size - 1));
    return [vecReg(fields.Zd ?? 0, destinationLane), vecReg(fields.Zn ?? 0, sourceLane)];
}
function sveBfloat16ConversionOperands(inst) {
    const fields = inst.fields;
    const mode = inst.encoding.encodingId.endsWith("z") ? "z" : "m";
    return [vecReg(fields.Zd ?? 0, "h"), predReg(fields.Pg ?? 0, mode), vecReg(fields.Zn ?? 0, "s")];
}
function sveIndexOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    const width = lane === "d" ? 64 : 32;
    const signedImm = (value) => sveSignedImmediate(value ?? 0, 5);
    switch (inst.encoding.fileName) {
        case "index_z_ii.xml":
            return [vecReg(fields.Zd ?? 0, lane), { kind: "imm", value: signedImm(fields.imm5), signed: true }, {
                    kind: "imm",
                    value: signedImm(fields.imm5b),
                    signed: true,
                }];
        case "index_z_ir.xml":
            return [
                vecReg(fields.Zd ?? 0, lane),
                { kind: "imm", value: signedImm(fields.imm5), signed: true },
                gpReg(width, fields.Rm ?? 0, "zr"),
            ];
        case "index_z_ri.xml":
            return [
                vecReg(fields.Zd ?? 0, lane),
                gpReg(width, fields.Rn ?? 0, "zr"),
                { kind: "imm", value: signedImm(fields.imm5), signed: true },
            ];
        case "index_z_rr.xml":
            return [vecReg(fields.Zd ?? 0, lane), gpReg(width, fields.Rn ?? 0, "zr"), gpReg(width, fields.Rm ?? 0, "zr")];
        default:
            return [];
    }
}
function sveInsrOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    const width = lane === "d" ? 64 : 32;
    const dest = vecReg(fields.Zdn ?? 0, lane);
    if (inst.encoding.fileName === "insr_z_r.xml") {
        return [dest, gpReg(width, fields.Rm ?? 0, "zr")];
    }
    return [dest, { kind: "text", text: `${lane}${fields.Vm ?? 0}` }];
}
function sveLastExtractOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    switch (inst.encoding.fileName) {
        case "lasta_r_p_z.xml":
        case "lastb_r_p_z.xml": {
            const width = lane === "d" ? 64 : 32;
            return [gpReg(width, fields.Rd ?? 0, "zr"), predReg(fields.Pg ?? 0), vecReg(fields.Zn ?? 0, lane)];
        }
        case "lasta_v_p_z.xml":
        case "lastb_v_p_z.xml":
            return [{ kind: "text", text: `${lane}${fields.Vd ?? 0}` }, predReg(fields.Pg ?? 0), vecReg(fields.Zn ?? 0, lane)];
        case "clasta_r_p_z.xml":
        case "clastb_r_p_z.xml": {
            const width = lane === "d" ? 64 : 32;
            const rdn = gpReg(width, fields.Rdn ?? 0, "zr");
            return [rdn, predReg(fields.Pg ?? 0), rdn, vecReg(fields.Zm ?? 0, lane)];
        }
        case "clasta_v_p_z.xml":
        case "clastb_v_p_z.xml": {
            const vdn = { kind: "text", text: `${lane}${fields.Vdn ?? 0}` };
            return [vdn, predReg(fields.Pg ?? 0), vdn, vecReg(fields.Zm ?? 0, lane)];
        }
        case "clasta_z_p_zz.xml":
        case "clastb_z_p_zz.xml": {
            const zdn = vecReg(fields.Zdn ?? 0, lane);
            return [zdn, predReg(fields.Pg ?? 0), zdn, vecReg(fields.Zm ?? 0, lane)];
        }
        default:
            return [];
    }
}
function sveAdrVectorOperands(inst) {
    const fields = inst.fields;
    const packed = inst.encoding.className.includes("Packed");
    const lane = packed ? ((fields.sz ?? 0) === 0 ? "s" : "d") : "d";
    const base = `z${fields.Zn ?? 0}.${lane}`;
    const offset = `z${fields.Zm ?? 0}.${lane}`;
    const shift = fields.msz ?? 0;
    const destination = vecReg(fields.Zd ?? 0, lane);
    if (packed) {
        const address = shift === 0 ? `[${base}, ${offset}]` : `[${base}, ${offset}, lsl #${shift}]`;
        return [destination, { kind: "text", text: address }];
    }
    const extension = inst.encoding.className.includes("unsigned") ? "uxtw" : "sxtw";
    const address = shift === 0 ? `[${base}, ${offset}, ${extension}]` : `[${base}, ${offset}, ${extension} #${shift}]`;
    return [destination, { kind: "text", text: address }];
}
function sveExtOperands(inst) {
    const fields = inst.fields;
    const imm = inst.encoding.fileName === "extq_z_zi.xml" ? (fields.imm4 ?? 0) : ((fields.imm8h ?? 0) << 3) | (fields.imm8l ?? 0);
    if (inst.encoding.className === "Constructive") {
        const first = fields.Zn ?? 0;
        const second = (first + 1) & 31;
        return [
            vecReg(fields.Zd ?? 0, "b"),
            { kind: "text", text: `{ z${first}.b, z${second}.b }` },
            { kind: "imm", value: BigInt(imm) },
        ];
    }
    const zdn = vecReg(fields.Zdn ?? 0, "b");
    return [zdn, zdn, vecReg(fields.Zm ?? 0, "b"), { kind: "imm", value: BigInt(imm) }];
}
function sveQVectorPermuteOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    if (inst.encoding.fileName === "tblq_z_zz.xml") {
        return [
            vecReg(fields.Zd ?? 0, lane),
            { kind: "text", text: sveSingleVectorListText(fields.Zn ?? 0, lane) },
            vecReg(fields.Zm ?? 0, lane),
        ];
    }
    return [vecReg(fields.Zd ?? 0, lane), vecReg(fields.Zn ?? 0, lane), vecReg(fields.Zm ?? 0, lane)];
}
function sveSpliceOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    const predicate = predReg(fields.Pv ?? 0);
    if (inst.encoding.className === "Constructive") {
        const first = fields.Zn ?? 0;
        const second = (first + 1) & 31;
        return [
            vecReg(fields.Zd ?? 0, lane),
            predicate,
            { kind: "text", text: `{ z${first}.${lane}, z${second}.${lane} }` },
        ];
    }
    const zdn = vecReg(fields.Zdn ?? 0, lane);
    return [zdn, predicate, zdn, vecReg(fields.Zm ?? 0, lane)];
}
function svePredicatedConversionOperands(inst) {
    const fields = inst.fields;
    const mode = inst.encoding.encodingId.endsWith("_z") ? "z" : "m";
    const encodingId = inst.encoding.encodingId;
    if (inst.encoding.mnemonic === "FCVTZS" || inst.encoding.mnemonic === "FCVTZU") {
        const match = encodingId.match(/fp(16|32|64)2([hwd])/);
        if (!match) {
            return [];
        }
        const destinationLane = match[2] === "h" ? "h" : match[2] === "w" ? "s" : "d";
        const sourceLane = match[1] === "16" ? "h" : match[1] === "32" ? "s" : "d";
        return [vecReg(fields.Zd ?? 0, destinationLane), predReg(fields.Pg ?? 0, mode), vecReg(fields.Zn ?? 0, sourceLane)];
    }
    const match = encodingId.match(/([hwd])2fp(16|32|64)/);
    if (!match) {
        return [];
    }
    const sourceLane = match[1] === "h" ? "h" : match[1] === "w" ? "s" : "d";
    const destinationLane = match[2] === "16" ? "h" : match[2] === "32" ? "s" : "d";
    return [vecReg(fields.Zd ?? 0, destinationLane), predReg(fields.Pg ?? 0, mode), vecReg(fields.Zn ?? 0, sourceLane)];
}
function svePredicatedNarrowingConversionOperands(inst) {
    const fields = inst.fields;
    const mode = inst.encoding.encodingId.endsWith("z") ? "z" : "m";
    const match = inst.encoding.encodingId.match(/_([hsd])2([hsd])z?$/);
    if (!match) {
        return [];
    }
    const sourceLane = match[1];
    const destinationLane = match[2];
    return [vecReg(fields.Zd ?? 0, destinationLane), predReg(fields.Pg ?? 0, mode), vecReg(fields.Zn ?? 0, sourceLane)];
}
function svePredicatePermutationOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    return [
        predReg(fields.Pd ?? 0, undefined, lane),
        predReg(fields.Pn ?? 0, undefined, lane),
        predReg(fields.Pm ?? 0, undefined, lane),
    ];
}
function svePredicateLogicalOperands(inst) {
    const fields = inst.fields;
    const pd = predReg(fields.Pd ?? 0, undefined, "b");
    const pn = predReg(fields.Pn ?? 0, undefined, "b");
    const pg = predReg(fields.Pg ?? 0, "z");
    const pm = predReg(fields.Pm ?? 0, undefined, "b");
    switch (inst.encoding.fileName) {
        case "and_p_p_pp.xml":
        case "mov_and_p_p_pp.xml":
        case "ands_p_p_pp.xml":
        case "movs_ands_p_p_pp.xml":
            if ((fields.S ?? 0) === 0 && fields.Pn === fields.Pm) {
                return [pd, pg, pn];
            }
            if ((fields.S ?? 0) === 1 && fields.Pn === fields.Pm) {
                return [pd, pg, pn];
            }
            return [pd, pg, pn, pm];
        case "orr_p_p_pp.xml":
        case "mov_orr_p_p_pp.xml":
        case "orrs_p_p_pp.xml":
        case "movs_orrs_p_p_pp.xml":
            if ((fields.S ?? 0) === 0 && fields.Pn === fields.Pm && fields.Pm === fields.Pg) {
                return [pd, pn];
            }
            if ((fields.S ?? 0) === 1 && fields.Pn === fields.Pm && fields.Pm === fields.Pg) {
                return [pd, pn];
            }
            return [pd, pg, pn, pm];
        case "eor_p_p_pp.xml":
        case "eors_p_p_pp.xml":
        case "nots_eors_p_p_pp.xml":
            if ((fields.S ?? 0) === 1 && fields.Pm === fields.Pg) {
                return [pd, pg, pn];
            }
            return [pd, pg, pn, pm];
        case "bic_p_p_pp.xml":
        case "orn_p_p_pp.xml":
        case "orns_p_p_pp.xml":
        case "nand_p_p_pp.xml":
        case "nor_p_p_pp.xml":
        case "bics_p_p_pp.xml":
        case "nands_p_p_pp.xml":
        case "nors_p_p_pp.xml":
            return [pd, pg, pn, pm];
        default:
            return [];
    }
}
function sveBinaryOperands(inst) {
    const fields = inst.fields;
    const fileName = inst.encoding.fileName;
    const lane = /^(?:and|bic|eor|orr|mov_orr)_z_zz\.xml$/.test(fileName) ? "d"
        : fileName.startsWith("bf") ? "h" : sveVectorLaneFromSize(fields.size);
    if ((inst.encoding.fileName === "orr_z_zz.xml" || inst.encoding.fileName === "mov_orr_z_zz.xml") && fields.Zn === fields.Zm) {
        return [vecReg(fields.Zd ?? 0, lane), vecReg(fields.Zn ?? 0, lane)];
    }
    return [vecReg(fields.Zd ?? 0, lane), vecReg(fields.Zn ?? 0, lane), vecReg(fields.Zm ?? 0, lane)];
}
function sveBinaryIndexedOperands(inst) {
    const fields = inst.fields;
    const lane = inst.encoding.encodingId.endsWith("_d") ? "d" : inst.encoding.encodingId.endsWith("_s") ? "s" : "h";
    return [vecReg(fields.Zd ?? 0, lane), vecReg(fields.Zn ?? 0, lane), { kind: "text", text: smeIndexedSourceText(inst, lane) }];
}
function sveWideningBinaryOperands(inst) {
    const fields = inst.fields;
    const sourceLane = sveVectorLaneFromSize(fields.size === undefined ? undefined : Math.max(0, fields.size - 1));
    const destinationLane = sveVectorLaneFromSize(fields.size);
    return [
        vecReg(fields.Zd ?? 0, destinationLane),
        vecReg(fields.Zn ?? 0, /^(?:s|u)(?:add|sub)w[bt]_/.test(inst.encoding.fileName) ? destinationLane : sourceLane),
        vecReg(fields.Zm ?? 0, sourceLane),
    ];
}
function sveLongMultiplyLanes(inst) {
    const encodingId = inst.encoding.encodingId;
    const size = inst.fields.size;
    if (encodingId.endsWith("_d")) {
        return { destination: "d", source: "s" };
    }
    if (encodingId.endsWith("_s")) {
        return { destination: "s", source: "h" };
    }
    return {
        destination: sveVectorLaneFromSize(size),
        source: sveVectorLaneFromSize(size === undefined ? undefined : Math.max(0, size - 1)),
    };
}
function sveLongMultiplyOperands(inst) {
    const fields = inst.fields;
    const lanes = sveLongMultiplyLanes(inst);
    const destinationField = fields.Zda !== undefined ? fields.Zda : fields.Zd;
    return [
        vecReg(destinationField ?? 0, lanes.destination),
        vecReg(fields.Zn ?? 0, lanes.source),
        vecReg(fields.Zm ?? 0, lanes.source),
    ];
}
function sveLongMultiplyIndexedOperands(inst) {
    const fields = inst.fields;
    const lanes = sveLongMultiplyLanes(inst);
    const destinationField = fields.Zda !== undefined ? fields.Zda : fields.Zd;
    return [
        vecReg(destinationField ?? 0, lanes.destination),
        vecReg(fields.Zn ?? 0, lanes.source),
        { kind: "text", text: smeIndexedSourceText(inst, lanes.source) },
    ];
}
function sveNarrowingBinaryOperands(inst) {
    const fields = inst.fields;
    const destinationLane = sveVectorLaneFromSize(fields.size === undefined ? undefined : Math.max(0, fields.size - 1));
    const sourceLane = sveVectorLaneFromSize(fields.size);
    return [
        vecReg(fields.Zd ?? 0, destinationLane),
        vecReg(fields.Zn ?? 0, sourceLane),
        vecReg(fields.Zm ?? 0, sourceLane),
    ];
}
function svePredicatedBinaryOperands(inst) {
    const fields = inst.fields;
    const lane = inst.encoding.fileName.startsWith("bf") ? "h" : sveVectorLaneFromSize(fields.size);
    return [
        vecReg(fields.Zdn ?? 0, lane),
        predReg(fields.Pg ?? 0, "m"),
        vecReg(fields.Zdn ?? 0, lane),
        vecReg(fields.Zm ?? 0, lane),
    ];
}
function svePredicatedPairwiseLongAccumulateOperands(inst) {
    const fields = inst.fields;
    const destinationLane = sveVectorLaneFromSize(fields.size);
    const sourceLane = sveVectorLaneFromSize(fields.size === undefined ? undefined : Math.max(0, fields.size - 1));
    return [
        vecReg(fields.Zda ?? 0, destinationLane),
        predReg(fields.Pg ?? 0, "m"),
        vecReg(fields.Zn ?? 0, sourceLane),
    ];
}
function sveHorizontalReductionOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    const destinationLane = inst.encoding.fileName === "saddv_r_p_z.xml" || inst.encoding.fileName === "uaddv_r_p_z.xml"
        ? "d"
        : lane;
    return [
        { kind: "text", text: `${destinationLane}${fields.Vd ?? 0}` },
        predReg(fields.Pg ?? 0),
        vecReg(fields.Zn ?? 0, lane),
    ];
}
function sveQVectorReductionOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    const arrangement = lane === "b" ? "16b" : lane === "h" ? "8h" : lane === "s" ? "4s" : "2d";
    return [{ kind: "text", text: `v${fields.Vd ?? 0}.${arrangement}` }, predReg(fields.Pg ?? 0), vecReg(fields.Zn ?? 0, lane)];
}
function sveFloatingReductionOperands(inst) {
    const fields = inst.fields;
    const lane = sveLaneFromSize(fields.size);
    const accumulator = { kind: "text", text: `${lane}${fields.Vdn ?? 0}` };
    return [accumulator, predReg(fields.Pg ?? 0), accumulator, vecReg(fields.Zm ?? 0, lane)];
}
function sveMoveMaskLane(imm13) {
    if (((imm13 >>> 12) & 1) === 1) {
        return "d";
    }
    const imms = imm13 & 0x3f;
    if ((imms & 0x20) === 0) {
        return "s";
    }
    if ((imms & 0x10) === 0) {
        return "h";
    }
    return "b";
}
function sveMaskImmediate(imm13) {
    const expanded = decodeLogicalImmediate({
        N: (imm13 >>> 12) & 1,
        immr: (imm13 >>> 6) & 0x3f,
        imms: imm13 & 0x3f,
    }, 64);
    if (expanded === null)
        return null;
    const lane = sveMoveMaskLane(imm13);
    const width = lane === "b" ? 8 : lane === "h" ? 16 : lane === "s" ? 32 : 64;
    return BigInt.asUintN(width, expanded);
}
function sveLogicalImmediateOperands(inst) {
    const fields = inst.fields;
    const imm13 = fields.imm13 ?? 0;
    const imm = sveMaskImmediate(imm13);
    if (imm === null) {
        return [];
    }
    const lane = sveMoveMaskLane(imm13);
    return [vecReg(fields.Zdn ?? 0, lane), vecReg(fields.Zdn ?? 0, lane), { kind: "imm", value: imm }];
}
function sveDupMaskImmediateOperands(inst) {
    const fields = inst.fields;
    const imm13 = fields.imm13 ?? 0;
    const imm = sveMaskImmediate(imm13);
    if (imm === null) {
        return [];
    }
    return [vecReg(fields.Zd ?? 0, sveMoveMaskLane(imm13)), { kind: "imm", value: imm }];
}
function sveDupScalarOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    const width = (fields.size ?? 0) === 3 ? 64 : 32;
    return [vecReg(fields.Zd ?? 0, lane), gpReg(width, fields.Rn ?? 0, "sp")];
}
function sveSelectPredicateOperands(inst) {
    const fields = inst.fields;
    const pd = predReg(fields.Pd ?? 0, undefined, "b");
    const pn = predReg(fields.Pn ?? 0, undefined, "b");
    if (fields.Pd === fields.Pm) {
        return [pd, predReg(fields.Pg ?? 0, "m"), pn];
    }
    return [pd, predReg(fields.Pg ?? 0), pn, predReg(fields.Pm ?? 0, undefined, "b")];
}
function sveSelectVectorOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    const zd = vecReg(fields.Zd ?? 0, lane);
    const zn = vecReg(fields.Zn ?? 0, lane);
    if (fields.Zd === fields.Zm) {
        return [zd, predReg(fields.Pv ?? 0, "m"), zn];
    }
    return [zd, predReg(fields.Pv ?? 0), zn, vecReg(fields.Zm ?? 0, lane)];
}
function sveArithmeticImmediateText(fields) {
    const imm8 = fields.imm8 ?? 0;
    if ((fields.sh ?? 0) === 1) {
        return imm8 === 0 ? "#0, lsl #8" : `#${imm8 << 8}`;
    }
    return `#${imm8}`;
}
function sveDestructiveImmediateOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    const zdn = fields.Zdn ?? 0;
    const isSigned = /^(?:mul|smax|smin)_z_zi\.xml$/.test(inst.encoding.fileName);
    const immediate = isSigned ? `#${sveSignedImmediate(fields.imm8 ?? 0, 8)}` : sveArithmeticImmediateText(fields);
    return [vecReg(zdn, lane), vecReg(zdn, lane), { kind: "text", text: immediate }];
}
function sveDestructiveBinaryOperands(inst, lane) {
    const fields = inst.fields;
    const zdn = fields.Zdn ?? 0;
    return [vecReg(zdn, lane), vecReg(zdn, lane), vecReg(fields.Zm ?? 0, lane)];
}
function sveDestructiveTernaryOperands(inst, lane) {
    const fields = inst.fields;
    const zdn = fields.Zdn ?? 0;
    return [vecReg(zdn, lane), vecReg(zdn, lane), vecReg(fields.Zm ?? 0, lane), vecReg(fields.Zk ?? 0, lane)];
}
function sveXarOperands(inst) {
    const fields = inst.fields;
    const { lane, shift } = sveShiftImmediateInfo(fields, false);
    const zdn = fields.Zdn ?? 0;
    return [vecReg(zdn, lane), vecReg(zdn, lane), vecReg(fields.Zm ?? 0, lane), { kind: "text", text: `#${shift}` }];
}
function sveShiftImmediateInfo(fields, leftShift) {
    const tsize = ((fields.tszh ?? 0) << 2) | (fields.tszl ?? 0);
    const elementLog2 = highestSetBitNZ(tsize);
    const esize = 8 << elementLog2;
    const encoded = (tsize << 3) | (fields.imm3 ?? 0);
    return {
        lane: sveVectorLaneFromSize(elementLog2),
        shift: leftShift ? encoded - esize : (2 * esize) - encoded,
    };
}
function sveShiftImmediateOperands(inst) {
    const fields = inst.fields;
    const isLeftShift = inst.encoding.fileName.startsWith("lsl_") ||
        inst.encoding.fileName.startsWith("sshll") ||
        inst.encoding.fileName.startsWith("ushll") ||
        inst.encoding.fileName.startsWith("sqshl_") ||
        inst.encoding.fileName.startsWith("uqshl_") ||
        inst.encoding.fileName.startsWith("sqshlu_");
    const { lane, shift } = sveShiftImmediateInfo(fields, isLeftShift);
    if (inst.encoding.fileName.includes("_p_")) {
        const zdn = fields.Zdn ?? 0;
        return [vecReg(zdn, lane), predReg(fields.Pg ?? 0, "m"), vecReg(zdn, lane), { kind: "text", text: `#${shift}` }];
    }
    return [
        vecReg(fields.Zd ?? 0, /^(?:sshll|ushll)/.test(inst.encoding.fileName) ? sveVectorLaneFromSize(highestSetBitNZ(((fields.tszh ?? 0) << 2) | (fields.tszl ?? 0)) + 1) : lane),
        vecReg(fields.Zn ?? 0, lane),
        { kind: "text", text: `#${shift}` },
    ];
}
function sveNarrowingShiftImmediateOperands(inst) {
    const fields = inst.fields;
    const tsize = ((fields.tszh ?? 0) << 2) | (fields.tszl ?? 0);
    if (tsize === 0) {
        return [];
    }
    const destinationSizeLog2 = highestSetBitNZ(tsize);
    const destinationLane = sveVectorLaneFromSize(destinationSizeLog2);
    const sourceLane = sveVectorLaneFromSize(destinationSizeLog2 + 1);
    const esize = 8 << destinationSizeLog2;
    const encoded = (tsize << 3) | (fields.imm3 ?? 0);
    const shift = (2 * esize) - encoded;
    return [
        vecReg(fields.Zd ?? 0, destinationLane),
        vecReg(fields.Zn ?? 0, sourceLane),
        { kind: "text", text: `#${shift}` },
    ];
}
function sveNarrowingExtractOperands(inst) {
    const fields = inst.fields;
    const tsize = ((fields.tszh ?? 0) << 2) | (fields.tszl ?? 0);
    if (tsize === 0) {
        return [];
    }
    const destinationSizeLog2 = highestSetBitNZ(tsize);
    const destinationLane = sveVectorLaneFromSize(destinationSizeLog2);
    const sourceLane = sveVectorLaneFromSize(destinationSizeLog2 + 1);
    return [vecReg(fields.Zd ?? 0, destinationLane), vecReg(fields.Zn ?? 0, sourceLane)];
}
function sveAccumulateShiftImmediateOperands(inst) {
    const fields = inst.fields;
    const tsize = ((fields.tszh ?? 0) << 2) | (fields.tszl ?? 0);
    if (tsize === 0) {
        return [];
    }
    const lane = sveVectorLaneFromSize(highestSetBitNZ(tsize));
    const esize = 8 << highestSetBitNZ(tsize);
    const encoded = (tsize << 3) | (fields.imm3 ?? 0);
    const shift = (2 * esize) - encoded;
    return [
        vecReg(fields.Zda ?? 0, lane),
        vecReg(fields.Zn ?? 0, lane),
        { kind: "text", text: `#${shift}` },
    ];
}
function sveWideShiftOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    const wideSource = vecReg(fields.Zm ?? 0, "d");
    if (inst.encoding.fileName.includes("_p_")) {
        const zdn = fields.Zdn ?? 0;
        return [vecReg(zdn, lane), predReg(fields.Pg ?? 0, "m"), vecReg(zdn, lane), wideSource];
    }
    return [vecReg(fields.Zd ?? 0, lane), vecReg(fields.Zn ?? 0, lane), wideSource];
}
function sveCountVectorLane(mnemonic) {
    if (mnemonic.endsWith("CH")) {
        return "h";
    }
    if (mnemonic.endsWith("CW")) {
        return "s";
    }
    if (mnemonic.endsWith("CD")) {
        return "d";
    }
    return "b";
}
function sveIncDecVectorOperands(inst) {
    const fields = inst.fields;
    const pattern = fields.pattern ?? 0;
    const multiplier = (fields.imm4 ?? 0) + 1;
    const lane = sveCountVectorLane(inst.encoding.mnemonic);
    const ops = [vecReg(fields.Zdn ?? 0, lane)];
    const patternName = pattern === 31 ? "all" : svePatternName(pattern);
    if (patternName) {
        if (!(pattern === 31 && (fields.imm4 ?? 0) === 0)) {
            ops.push({ kind: "text", text: patternName });
        }
    }
    else if (pattern !== 31) {
        ops.push({ kind: "imm", value: BigInt(pattern), signed: true });
    }
    if ((fields.imm4 ?? 0) !== 0) {
        ops.push({ kind: "text", text: `mul #${multiplier}` });
    }
    return ops;
}
function sveIncDecPredicateVectorOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    return [vecReg(fields.Zdn ?? 0, lane), predReg(fields.Pm ?? 0, undefined, lane)];
}
function sveBfSubOperands(inst) {
    const fields = inst.fields;
    const lane = sveLaneFromSize(fields.size);
    switch (inst.encoding.fileName) {
        case "bfsub_z_p_zz.xml":
            return [
                vecReg(fields.Zdn ?? 0, lane),
                predReg(fields.Pg ?? 0, "m"),
                vecReg(fields.Zdn ?? 0, lane),
                vecReg(fields.Zm ?? 0, lane),
            ];
        case "bfsub_z_zz.xml":
            return [vecReg(fields.Zd ?? 0, lane), vecReg(fields.Zn ?? 0, lane), vecReg(fields.Zm ?? 0, lane)];
        default:
            return [];
    }
}
function sveBfmlsOperands(inst) {
    const fields = inst.fields;
    const lane = sveLaneFromSize(fields.size);
    const dest = vecReg(fields.Zda ?? 0, lane);
    const first = vecReg(fields.Zn ?? 0, lane);
    switch (inst.encoding.fileName) {
        case "bfmls_z_p_zzz.xml":
            return [dest, predReg(fields.Pg ?? 0, "m"), first, vecReg(fields.Zm ?? 0, lane)];
        case "bfmls_z_zzzi.xml":
            return [dest, first, smeIndexedSourceOperand(inst, lane)];
        default:
            return [];
    }
}
function sveFpMultiplyAccumulateOperands(inst) {
    const fields = inst.fields;
    if (inst.encoding.fileName.endsWith("_p_zzz.xml")) {
        const lane = sveLaneFromSize(fields.size);
        const dest = vecReg(fields.Zda ?? 0, lane);
        return [dest, predReg(fields.Pg ?? 0, "m"), vecReg(fields.Zn ?? 0, lane), vecReg(fields.Zm ?? 0, lane)];
    }
    const lane = inst.encoding.encodingId.endsWith("_s") ? "s" : inst.encoding.encodingId.endsWith("_d") ? "d" : "h";
    return [vecReg(fields.Zda ?? 0, lane), vecReg(fields.Zn ?? 0, lane), smeIndexedSourceOperand(inst, lane)];
}
function sveMultiplyAccumulateOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    if (inst.encoding.fileName.endsWith("_p_zzz.xml")) {
        if (fields.Zda !== undefined) {
            return [vecReg(fields.Zda, lane), predReg(fields.Pg ?? 0, "m"), vecReg(fields.Zn ?? 0, lane), vecReg(fields.Zm ?? 0, lane)];
        }
        const zdn = vecReg(fields.Zdn ?? 0, lane);
        return [zdn, predReg(fields.Pg ?? 0, "m"), vecReg(fields.Zm ?? 0, lane), vecReg(fields.Za ?? 0, lane)];
    }
    return [vecReg(fields.Zda ?? 0, lane), vecReg(fields.Zn ?? 0, lane), vecReg(fields.Zm ?? 0, lane)];
}
function sveCdotOperands(inst) {
    const fields = inst.fields;
    const ops = sveDotProductOperands(inst);
    ops.push({ kind: "text", text: `#${(fields.rot ?? 0) * 90}` });
    return ops;
}
function svePmullOperands(inst) {
    const fields = inst.fields;
    if (inst.encoding.encodingId.endsWith("_q")) {
        return [vecReg(fields.Zd ?? 0, "q"), vecReg(fields.Zn ?? 0, "d"), vecReg(fields.Zm ?? 0, "d")];
    }
    return sveWideningBinaryOperands(inst);
}
function sveFmlalLongOperands(inst) {
    const fields = inst.fields;
    switch (inst.encoding.fileName) {
        case "fmlalb_z_zzz.xml":
        case "fmlalt_z_zzz.xml":
        case "fmlslb_z_zzz.xml":
        case "fmlslt_z_zzz.xml":
            return [vecReg(fields.Zda ?? 0, "s"), vecReg(fields.Zn ?? 0, "h"), vecReg(fields.Zm ?? 0, "h")];
        case "fmlalb_z_zzzi.xml":
        case "fmlalt_z_zzzi.xml":
        case "fmlslb_z_zzzi.xml":
        case "fmlslt_z_zzzi.xml":
            return [vecReg(fields.Zda ?? 0, "s"), vecReg(fields.Zn ?? 0, "h"), { kind: "text", text: smeIndexedSourceText(inst, "h") }];
        default:
            return [];
    }
}
function sveLd1bLaneFromEncodingId(encodingId) {
    if (encodingId.endsWith("_u16")) {
        return "h";
    }
    if (encodingId.endsWith("_u32")) {
        return "s";
    }
    if (encodingId.endsWith("_u64")) {
        return "d";
    }
    return "b";
}
function sveSignExtLoadLaneFromEncodingId(encodingId) {
    if (encodingId.endsWith("_s16")) {
        return "h";
    }
    if (encodingId.endsWith("_s32")) {
        return "s";
    }
    return "d";
}
function sveLd1roLaneFromFile(fileName) {
    switch (fileName) {
        case "ld1roh_z_p_bi.xml":
        case "ld1roh_z_p_br.xml":
            return "h";
        case "ld1row_z_p_bi.xml":
        case "ld1row_z_p_br.xml":
            return "s";
        case "ld1rod_z_p_bi.xml":
        case "ld1rod_z_p_br.xml":
            return "d";
        default:
            return "b";
    }
}
function sveReplicateLoadLaneFromEncoding(inst) {
    const fileName = inst.encoding.fileName;
    if (fileName.startsWith("ld1ro")) {
        return sveLd1roLaneFromFile(fileName);
    }
    if (fileName.startsWith("ld1rq")) {
        switch (fileName) {
            case "ld1rqh_z_p_bi.xml":
            case "ld1rqh_z_p_br.xml":
                return "h";
            case "ld1rqw_z_p_bi.xml":
            case "ld1rqw_z_p_br.xml":
                return "s";
            case "ld1rqd_z_p_bi.xml":
            case "ld1rqd_z_p_br.xml":
                return "d";
            default:
                return "b";
        }
    }
    if (inst.encoding.encodingId.endsWith("16")) {
        return "h";
    }
    if (inst.encoding.encodingId.endsWith("32")) {
        return "s";
    }
    if (inst.encoding.encodingId.endsWith("64")) {
        return "d";
    }
    return "b";
}
function sveReplicateLoadImmediateScale(fileName) {
    if (fileName.startsWith("ld1ro")) {
        return 32n;
    }
    if (fileName.startsWith("ld1rq")) {
        return 16n;
    }
    const mnemonic = fileName.split("_")[0] ?? "";
    switch (mnemonic.at(-1)) {
        case "h":
            return 2n;
        case "w":
            return 4n;
        case "d":
            return 8n;
        default:
            return 1n;
    }
}
function sveReplicateLoadImmediateOffset(inst) {
    const fileName = inst.encoding.fileName;
    const scale = sveReplicateLoadImmediateScale(fileName);
    if (fileName.startsWith("ld1rq") || fileName.startsWith("ld1ro")) {
        return signExtend(inst.fields.imm4 ?? 0, 4) * scale;
    }
    return BigInt(inst.fields.imm6 ?? 0) * scale;
}
function sveLd1roRegisterShift(lane) {
    switch (lane) {
        case "h":
            return 1;
        case "s":
            return 2;
        case "d":
            return 3;
        default:
            return 0;
    }
}
function sveSingleVectorListText(register, lane) {
    return `{ z${register}.${lane} }`;
}
function sveElementShiftFromMnemonic(mnemonic) {
    switch (mnemonic.at(-1)?.toLowerCase()) {
        case "q":
            return 4;
        case "h":
            return 1;
        case "w":
            return 2;
        case "d":
            return 3;
        default:
            return 0;
    }
}
function sveMemoryLaneFromEncoding(inst) {
    const fileName = inst.encoding.fileName;
    const fields = inst.fields;
    const encodingId = inst.encoding.encodingId;
    // The memory access width and the scalable register element width are independent.
    // XML encoding names distinguish widening/128-bit forms even when size is fixed.
    const width = /_[us](8|16|32|64|128)$/.exec(encodingId)?.[1];
    if (width)
        return width === "8" ? "b" : width === "16" ? "h" : width === "32" ? "s" : width === "64" ? "d" : "q";
    if (fileName.startsWith("ld1q_") || fileName.startsWith("st1q_"))
        return "q";
    const addressLane = /_(s|d)(?:_|$)/.exec(encodingId)?.[1];
    if (addressLane)
        return addressLane;
    if (/_mzx?_p_/.test(fileName)) {
        const shift = sveElementShiftFromMnemonic(inst.encoding.mnemonic);
        return shift === 0 ? "b" : shift === 1 ? "h" : shift === 2 ? "s" : shift === 3 ? "d" : "q";
    }
    if (fileName.startsWith("ld2q_") || fileName.startsWith("ld3q_") || fileName.startsWith("ld4q_")) {
        return "q";
    }
    if (fileName.startsWith("st2q_") || fileName.startsWith("st3q_") || fileName.startsWith("st4q_")) {
        return "q";
    }
    if (fileName.startsWith("ld1b_")) {
        if (fileName.endsWith("_ar.xml")) {
            return encodingId.includes("_x32_") ? "s" : "d";
        }
        return sveLd1bLaneFromEncodingId(inst.encoding.encodingId);
    }
    if (fileName.startsWith("ld1s")) {
        if (fileName.endsWith("_ar.xml")) {
            return encodingId.includes("_x32_") ? "s" : "d";
        }
        return sveSignExtLoadLaneFromEncodingId(inst.encoding.encodingId);
    }
    if (fileName.startsWith("st1b_") || fileName.startsWith("st1h_")) {
        if (fileName.endsWith("_ar.xml")) {
            return encodingId.includes("_x32_") ? "s" : "d";
        }
        return sveVectorLaneFromSize(fields.size);
    }
    if (fileName.startsWith("st1w_")) {
        if (fileName.endsWith("_ar.xml")) {
            return encodingId.includes("_x32_") ? "s" : "d";
        }
        return (fields.sz ?? 0) === 0 ? "s" : "d";
    }
    switch (inst.encoding.mnemonic.at(-1)?.toLowerCase()) {
        case "h":
            return "h";
        case "w":
            return "s";
        case "d":
            return "d";
        case "q":
            return "q";
        default:
            return "b";
    }
}
function sveMemoryRegisterCount(inst) {
    const fileName = inst.encoding.fileName;
    const encodingId = inst.encoding.encodingId;
    if (/_mzx?_p_/.test(fileName)) {
        const match = /_(2|4)(?:x\d+)?$/.exec(encodingId);
        if (match) {
            return Number(match[1]);
        }
    }
    const mnemonic = inst.encoding.mnemonic;
    const match = /^(?:LD|ST)([234])/.exec(mnemonic);
    return match ? Number(match[1]) : 1;
}
function sveContiguousVectorListText(start, count, lane) {
    if (count === 1) {
        return sveSingleVectorListText(start, lane);
    }
    const end = start + count - 1;
    if (count > 2 && end < 32) {
        return `{ z${start}.${lane} - z${end}.${lane} }`;
    }
    const registers = Array.from({ length: count }, (_, index) => `z${(start + index) & 31}.${lane}`);
    return `{ ${registers.join(", ")} }`;
}
function svePredicateCounterGroupText(png, mode) {
    const base = `pn${8 + png}`;
    return mode === "z" ? `${base}/z` : base;
}
function sveFaultLoadLaneFromEncodingId(encodingId) {
    if (encodingId.endsWith("16")) {
        return "h";
    }
    if (encodingId.endsWith("32") || encodingId.includes("_s_") || encodingId.endsWith("_s")) {
        return "s";
    }
    if (encodingId.endsWith("64") || encodingId.includes("_d_") || encodingId.endsWith("_d")) {
        return "d";
    }
    return "b";
}
function sveFaultLoadSourceByteSize(mnemonic) {
    const lower = mnemonic.toLowerCase();
    if (lower.endsWith("h") || lower.endsWith("sh")) {
        return 2;
    }
    if (lower.endsWith("w") || lower.endsWith("sw")) {
        return 4;
    }
    if (lower.endsWith("d")) {
        return 8;
    }
    return 1;
}
function sveGatherMemorySourceByteSize(mnemonic) {
    return sveFaultLoadSourceByteSize(mnemonic);
}
function sveGatherVectorImmediateMemoryText(inst) {
    const fields = inst.fields;
    const lane = sveMemoryLaneFromEncoding(inst);
    const base = `z${fields.Zn ?? 0}.${lane}`;
    const imm = (fields.imm5 ?? 0) * sveGatherMemorySourceByteSize(inst.encoding.mnemonic);
    return imm === 0 ? `[${base}]` : `[${base}, #${imm}]`;
}
function sveGatherVectorOffsetMemoryText(inst) {
    const fields = inst.fields;
    const lane = sveMemoryLaneFromEncoding(inst);
    const base = formatRegister(gpReg(64, fields.Rn ?? 0, "sp"));
    const index = `z${fields.Zm ?? 0}.${lane}`;
    const shift = inst.encoding.encodingId.includes("scaled") && !inst.encoding.encodingId.includes("unscaled")
        ? sveFaultLoadSourceShift(inst)
        : 0;
    let modifier;
    if (inst.encoding.encodingId.includes("_64_")) {
        modifier = shift === 0 ? undefined : `lsl #${shift}`;
    }
    else {
        modifier = (fields.xs ?? 0) === 0 ? "uxtw" : "sxtw";
        if (shift !== 0) {
            modifier += ` #${shift}`;
        }
    }
    return modifier ? `[${base}, ${index}, ${modifier}]` : `[${base}, ${index}]`;
}
function sveFaultLoadSourceShift(inst) {
    const sourceBytes = sveFaultLoadSourceByteSize(inst.encoding.mnemonic);
    return sourceBytes === 8 ? 3 : sourceBytes === 4 ? 2 : sourceBytes === 2 ? 1 : 0;
}
function sveFaultLoadVectorOffsetMemoryText(inst, base) {
    const fields = inst.fields;
    const lane = sveFaultLoadLaneFromEncodingId(inst.encoding.encodingId);
    const shift = inst.encoding.encodingId.includes("scaled") && !inst.encoding.encodingId.includes("unscaled")
        ? sveFaultLoadSourceShift(inst)
        : 0;
    const index = `z${fields.Zm ?? 0}.${lane}`;
    let modifier;
    if (inst.encoding.encodingId.includes("_64_")) {
        modifier = shift === 0 ? undefined : `lsl #${shift}`;
    }
    else {
        modifier = (fields.xs ?? 0) === 0 ? "uxtw" : "sxtw";
        if (shift !== 0) {
            modifier += ` #${shift}`;
        }
    }
    return modifier ? `[${base}, ${index}, ${modifier}]` : `[${base}, ${index}]`;
}
function sveFaultTolerantLoadOperands(inst) {
    const fields = inst.fields;
    const lane = sveFaultLoadLaneFromEncodingId(inst.encoding.encodingId);
    const destination = { kind: "text", text: sveSingleVectorListText(fields.Zt ?? 0, lane) };
    const predicate = predReg(fields.Pg ?? 0, "z");
    const fileName = inst.encoding.fileName;
    if (fileName.endsWith("_ai.xml")) {
        const sourceBytes = sveFaultLoadSourceByteSize(inst.encoding.mnemonic);
        const imm = (fields.imm5 ?? 0) * sourceBytes;
        const base = `z${fields.Zn ?? 0}.${lane}`;
        const memory = imm === 0 ? `[${base}]` : `[${base}, #${imm}]`;
        return [destination, predicate, { kind: "text", text: memory }];
    }
    const base = formatRegister(gpReg(64, fields.Rn ?? 0, "sp"));
    if (fileName.endsWith("_bi.xml")) {
        const imm = Number(signExtend(fields.imm4 ?? 0, 4));
        const memory = imm === 0 ? `[${base}]` : `[${base}, #${imm}, mul vl]`;
        return [destination, predicate, { kind: "text", text: memory }];
    }
    if (fileName.endsWith("_br.xml")) {
        const offsetRegister = fields.Rm ?? 31;
        if (offsetRegister === 31) {
            return [destination, predicate, { kind: "text", text: `[${base}]` }];
        }
        const offset = formatRegister(gpReg(64, offsetRegister, "zr"));
        const shift = sveFaultLoadSourceShift(inst);
        const memory = shift === 0 ? `[${base}, ${offset}]` : `[${base}, ${offset}, lsl #${shift}]`;
        return [destination, predicate, { kind: "text", text: memory }];
    }
    return [destination, predicate, { kind: "text", text: sveFaultLoadVectorOffsetMemoryText(inst, base) }];
}
function sveContiguousByteMemoryOperands(inst) {
    const fields = inst.fields;
    const fileName = inst.encoding.fileName;
    const isPredicateCounter = /_mzx?_p_/.test(fileName);
    const lane = sveMemoryLaneFromEncoding(inst);
    const registerCount = sveMemoryRegisterCount(inst);
    const isStrided = fileName.includes("_mzx_");
    const first = isStrided ? ((fields.T ?? 0) << 4) | (fields.Zt ?? 0)
        : isPredicateCounter ? (fields.Zt ?? 0) * registerCount : fields.Zt ?? 0;
    const register = {
        kind: "text",
        text: isStrided
            ? `{ ${Array.from({ length: registerCount }, (_, index) => `z${first + index * (16 / registerCount)}.${lane}`).join(", ")} }`
            : sveContiguousVectorListText(first, registerCount, lane),
    };
    const predicate = isPredicateCounter
        ? { kind: "text", text: svePredicateCounterGroupText(fields.PNg ?? 0, fileName.startsWith("ld") ? "z" : undefined) }
        : fileName.startsWith("ld")
            ? predReg(fields.Pg ?? 0, "z")
            : predReg(fields.Pg ?? 0);
    if (fileName.endsWith("_ai.xml")) {
        return [register, predicate, { kind: "text", text: sveGatherVectorImmediateMemoryText(inst) }];
    }
    if (fileName.endsWith("_bz.xml")) {
        return [register, predicate, { kind: "text", text: sveGatherVectorOffsetMemoryText(inst) }];
    }
    const base = formatRegister(gpReg(64, fields.Rn ?? 0, "sp"));
    if (fileName.endsWith("_ar.xml")) {
        const vectorBase = `z${fields.Zn ?? 0}.${lane === "q" ? "d" : lane}`;
        const offsetRegister = fields.Rm ?? 31;
        const memory = offsetRegister === 31 ? `[${vectorBase}]` : `[${vectorBase}, x${offsetRegister}]`;
        return [register, predicate, { kind: "text", text: memory }];
    }
    if (fileName.endsWith("_bi.xml")) {
        const imm = Number(signExtend(fields.imm4 ?? 0, 4)) * registerCount;
        const memory = imm === 0 ? `[${base}]` : `[${base}, #${imm}, mul vl]`;
        return [register, predicate, { kind: "text", text: memory }];
    }
    const offset = formatRegister(gpReg(64, fields.Rm ?? 0, "zr"));
    const shift = sveElementShiftFromMnemonic(inst.encoding.mnemonic);
    const memory = shift === 0 ? `[${base}, ${offset}]` : `[${base}, ${offset}, lsl #${shift}]`;
    return [register, predicate, { kind: "text", text: memory }];
}
function sveReplicateLoadOperands(inst) {
    const fields = inst.fields;
    const lane = sveReplicateLoadLaneFromEncoding(inst);
    const register = { kind: "text", text: sveSingleVectorListText(fields.Zt ?? 0, lane) };
    const base = formatRegister(gpReg(64, fields.Rn ?? 0, "sp"));
    if (inst.encoding.fileName.endsWith("_bi.xml")) {
        const imm = sveReplicateLoadImmediateOffset(inst);
        const memory = imm === 0n ? `[${base}]` : `[${base}, ${formatSignedDecimalImmediate(imm)}]`;
        return [register, predReg(fields.Pg ?? 0, "z"), { kind: "text", text: memory }];
    }
    const offset = formatRegister(gpReg(64, fields.Rm ?? 0, "zr"));
    const shift = sveLd1roRegisterShift(lane);
    const memory = shift === 0 ? `[${base}, ${offset}]` : `[${base}, ${offset}, lsl #${shift}]`;
    return [register, predReg(fields.Pg ?? 0, "z"), { kind: "text", text: memory }];
}
function sveBfmlalOperands(inst) {
    const fields = inst.fields;
    switch (inst.encoding.fileName) {
        case "bfmlalb_z_zzz.xml":
        case "bfmlslb_z_zzz.xml":
        case "bfmlalt_z_zzz.xml":
        case "bfmlslt_z_zzz.xml":
            return [vecReg(fields.Zda ?? 0, "s"), vecReg(fields.Zn ?? 0, "h"), vecReg(fields.Zm ?? 0, "h")];
        case "bfmlalb_z_zzzi.xml":
        case "bfmlslb_z_zzzi.xml":
        case "bfmlalt_z_zzzi.xml":
        case "bfmlslt_z_zzzi.xml": {
            const lowWidth = inst.encoding.fields.find((field) => field.name === "i3l")?.width ?? 0;
            const index = ((fields.i3h ?? 0) << lowWidth) | (fields.i3l ?? 0);
            return [
                vecReg(fields.Zda ?? 0, "s"),
                vecReg(fields.Zn ?? 0, "h"),
                { kind: "text", text: `z${fields.Zm ?? 0}.h[${index}]` },
            ];
        }
        default:
            return [];
    }
}
function sveComplexRotateImmediate(inst) {
    return { kind: "text", text: `#${complexRotateDegrees(inst)}` };
}
function sveComplexVectorOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    return [
        vecReg(fields.Zda ?? 0, lane),
        vecReg(fields.Zn ?? 0, lane),
        vecReg(fields.Zm ?? 0, lane),
        sveComplexRotateImmediate(inst),
    ];
}
function sveFcmlaPredicatedOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    return [
        vecReg(fields.Zda ?? 0, lane),
        predReg(fields.Pg ?? 0, "m"),
        vecReg(fields.Zn ?? 0, lane),
        vecReg(fields.Zm ?? 0, lane),
        sveComplexRotateImmediate(inst),
    ];
}
function sveFcaddOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    return [
        vecReg(fields.Zdn ?? 0, lane),
        predReg(fields.Pg ?? 0, "m"),
        vecReg(fields.Zdn ?? 0, lane),
        vecReg(fields.Zm ?? 0, lane),
        sveComplexRotateImmediate(inst),
    ];
}
function sveCaddLikeOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    const zdn = vecReg(fields.Zdn ?? 0, lane);
    return [zdn, zdn, vecReg(fields.Zm ?? 0, lane), sveComplexRotateImmediate(inst)];
}
function sveCarryLongOperands(inst) {
    const fields = inst.fields;
    const lane = (fields.sz ?? 0) === 0 ? "s" : "d";
    return [
        vecReg(fields.Zda ?? 0, lane),
        vecReg(fields.Zn ?? 0, lane),
        vecReg(fields.Zm ?? 0, lane),
    ];
}
function sveShiftInsertImmediateOperands(inst) {
    const fields = inst.fields;
    const tsize = ((fields.tszh ?? 0) << 2) | (fields.tszl ?? 0);
    if (tsize === 0) {
        return [];
    }
    const lane = sveVectorLaneFromSize(highestSetBitNZ(tsize));
    const esize = 8 << highestSetBitNZ(tsize);
    const encoded = (tsize << 3) | (fields.imm3 ?? 0);
    const shift = ["sli_z_zzi.xml", "lsl_z_zi.xml"].includes(inst.encoding.fileName) ? encoded - esize : (2 * esize) - encoded;
    return [vecReg(fields.Zd ?? 0, lane), vecReg(fields.Zn ?? 0, lane), { kind: "text", text: `#${shift}` }];
}
function sveComplexIndexedOperands(inst) {
    const fields = inst.fields;
    const lane = inst.encoding.encodingId.endsWith("_s") ? "s" : "h";
    const index = fields.i2 ?? fields.i1 ?? 0;
    return [
        vecReg(fields.Zda ?? 0, lane),
        vecReg(fields.Zn ?? 0, lane),
        { kind: "text", text: `z${fields.Zm ?? 0}.${lane}[${index}]` },
        sveComplexRotateImmediate(inst),
    ];
}
function sveFp8ConvertOperands(inst) {
    const fields = inst.fields;
    return [vecReg(fields.Zd ?? 0, "h"), vecReg(fields.Zn ?? 0, "b")];
}
function sveFmulImmediateOperands(inst) {
    const fields = inst.fields;
    const lane = sveLaneFromSize(fields.size);
    const immediate = (fields.i1 ?? 0) === 0 ? "#0.5" : "#2.0";
    return [vecReg(fields.Zdn ?? 0, lane), predReg(fields.Pg ?? 0, "m"), vecReg(fields.Zdn ?? 0, lane), { kind: "text", text: immediate }];
}
function sveFpAddSubImmediateOperands(inst) {
    const fields = inst.fields;
    const lane = sveLaneFromSize(fields.size);
    const isMinMax = /^F(?:MIN|MAX)(?:NM)?$/.test(inst.encoding.mnemonic);
    const immediate = (fields.i1 ?? 0) === 0 ? (isMinMax ? "#0.0" : "#0.5") : "#1.0";
    return [vecReg(fields.Zdn ?? 0, lane), predReg(fields.Pg ?? 0, "m"), vecReg(fields.Zdn ?? 0, lane), { kind: "text", text: immediate }];
}
function sveFmulIndexedOperands(inst) {
    const fields = inst.fields;
    let lane = "h";
    let index = 0;
    if (inst.encoding.encodingId.endsWith("_s")) {
        lane = "s";
        index = fields.i2 ?? 0;
    }
    else if (inst.encoding.encodingId.endsWith("_d")) {
        lane = "d";
        index = fields.i1 ?? 0;
    }
    else {
        index = ((fields.i3h ?? 0) << 2) | (fields.i3l ?? 0);
    }
    return [
        vecReg(fields.Zd ?? 0, lane),
        vecReg(fields.Zn ?? 0, lane),
        { kind: "text", text: `z${fields.Zm ?? 0}.${lane}[${index}]` },
    ];
}
function sveFmadOperands(inst) {
    const fields = inst.fields;
    const lane = sveLaneFromSize(fields.size);
    return [
        vecReg(fields.Zdn ?? 0, lane),
        predReg(fields.Pg ?? 0, "m"),
        vecReg(fields.Zm ?? 0, lane),
        vecReg(fields.Za ?? 0, lane),
    ];
}
function sveFtmadOperands(inst) {
    const fields = inst.fields;
    const lane = sveLaneFromSize(fields.size);
    const zdn = vecReg(fields.Zdn ?? 0, lane);
    return [zdn, zdn, vecReg(fields.Zm ?? 0, lane), { kind: "imm", value: BigInt(fields.imm3 ?? 0) }];
}
function sveFmmlaOperands(inst) {
    const fields = inst.fields;
    const lane = inst.encoding.encodingId.endsWith("_d") ? "d" : inst.encoding.encodingId.endsWith("_s") ? "s" : "h";
    return [vecReg(fields.Zda ?? 0, lane), vecReg(fields.Zn ?? 0, lane), vecReg(fields.Zm ?? 0, lane)];
}
function sveMatrixMultiplyOperands(inst) {
    const fields = inst.fields;
    switch (inst.encoding.fileName) {
        case "bfmmla_z_zzz.xml":
            return [vecReg(fields.Zda ?? 0, "s"), vecReg(fields.Zn ?? 0, "h"), vecReg(fields.Zm ?? 0, "h")];
        case "bfmmla_z16_zzz.xml":
            return [vecReg(fields.Zda ?? 0, "h"), vecReg(fields.Zn ?? 0, "h"), vecReg(fields.Zm ?? 0, "h")];
        case "smmla_z_zzz.xml":
        case "ummla_z_zzz.xml":
        case "usmmla_z_zzz.xml":
            return [vecReg(fields.Zda ?? 0, "s"), vecReg(fields.Zn ?? 0, "b"), vecReg(fields.Zm ?? 0, "b")];
        default:
            return sveFmmlaOperands(inst);
    }
}
function sveDotLanes(inst) {
    const fileName = inst.encoding.fileName;
    const encodingId = inst.encoding.encodingId;
    const fields = inst.fields;
    if (fileName.includes("z8z8z8") || fileName.includes("zz8z8")) {
        return { destination: fileName.includes("_z32_") ? "s" : "h", source: "b" };
    }
    if (fileName.startsWith("bfdot_")) {
        return { destination: "s", source: "h" };
    }
    if (fileName === "sudot_z_zzzi.xml" || fileName === "usdot_z_zzz.xml" || fileName === "usdot_z_zzzi.xml") {
        return { destination: "s", source: "b" };
    }
    if (fileName.startsWith("fdot_")) {
        return { destination: "s", source: "h" };
    }
    if (encodingId.includes("_z16_") || encodingId.endsWith("_h")) {
        return { destination: "h", source: "b" };
    }
    if (fileName.includes("_z32_")) {
        return { destination: "s", source: "h" };
    }
    if ((fields.size ?? 0) === 3 || encodingId.endsWith("_d")) {
        return { destination: "d", source: "h" };
    }
    return { destination: "s", source: "b" };
}
function sveDotIndexedSourceText(inst, sourceLane) {
    const fields = inst.fields;
    const widthByName = new Map(inst.encoding.fields.map((field) => [field.name, field.width]));
    let index = 0;
    if (fields.i4h !== undefined || fields.i4l !== undefined) {
        index = ((fields.i4h ?? 0) << (widthByName.get("i4l") ?? 0)) | (fields.i4l ?? 0);
    }
    else if (fields.i3h !== undefined || fields.i3l !== undefined) {
        index = ((fields.i3h ?? 0) << (widthByName.get("i3l") ?? 0)) | (fields.i3l ?? 0);
    }
    else if (fields.i2 !== undefined) {
        index = fields.i2;
    }
    else if (fields.i1 !== undefined) {
        index = fields.i1;
    }
    return `z${fields.Zm ?? 0}.${sourceLane}[${index}]`;
}
function sveDotProductOperands(inst) {
    const fields = inst.fields;
    const lanes = sveDotLanes(inst);
    const hasIndexedSource = fields.i1 !== undefined || fields.i2 !== undefined || fields.i3h !== undefined || fields.i3l !== undefined || fields.i4h !== undefined || fields.i4l !== undefined;
    const ops = [
        vecReg(fields.Zda ?? 0, lanes.destination),
        vecReg(fields.Zn ?? 0, lanes.source),
    ];
    if (hasIndexedSource) {
        ops.push({ kind: "text", text: sveDotIndexedSourceText(inst, lanes.source) });
    }
    else {
        ops.push(vecReg(fields.Zm ?? 0, lanes.source));
    }
    return ops;
}
function sveFp8LutiRegisterCount(inst) {
    if (inst.encoding.fileName === "luti2_z_zz.xml") {
        return 1;
    }
    return inst.encoding.encodingId.endsWith("_2x16") ? 2 : 1;
}
function sveFp8LutiIndex(inst) {
    const fields = inst.fields;
    if (fields.i3h !== undefined || fields.i3l !== undefined) {
        const lowWidth = inst.encoding.fields.find((field) => field.name === "i3l")?.width ?? 0;
        return ((fields.i3h ?? 0) << lowWidth) | (fields.i3l ?? 0);
    }
    if (fields.i2 !== undefined) {
        return fields.i2;
    }
    return fields.i1 ?? 0;
}
function sveFp8LutiOperands(inst) {
    const fields = inst.fields;
    const lane = inst.encoding.encodingId.endsWith("16") ? "h" : "b";
    const registerCount = sveFp8LutiRegisterCount(inst);
    const sourceRegisters = Array.from({ length: registerCount }, (_, index) => `z${((fields.Zn ?? 0) + index) & 31}.${lane}`);
    const index = sveFp8LutiIndex(inst);
    return [
        vecReg(fields.Zd ?? 0, lane),
        { kind: "text", text: `{ ${sourceRegisters.join(", ")} }` },
        { kind: "text", text: `z${fields.Zm ?? 0}[${index}]` },
    ];
}
function svePermutationOperands(inst) {
    const fields = inst.fields;
    const lane = inst.encoding.encodingId.endsWith("_q") ? "q" : sveVectorLaneFromSize(fields.size);
    return [vecReg(fields.Zd ?? 0, lane), vecReg(fields.Zn ?? 0, lane), vecReg(fields.Zm ?? 0, lane)];
}
function sveTableLookupOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    if (inst.encoding.encodingId.endsWith("_2")) {
        const first = fields.Zn ?? 0;
        return [
            vecReg(fields.Zd ?? 0, lane),
            { kind: "text", text: `{ z${first}.${lane}, z${(first + 1) & 31}.${lane} }` },
            vecReg(fields.Zm ?? 0, lane),
        ];
    }
    return [vecReg(fields.Zd ?? 0, lane), { kind: "vector-group", registers: [vecReg(fields.Zn ?? 0, lane)], style: "list" }, vecReg(fields.Zm ?? 0, lane)];
}
function sveHistcntOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    return [vecReg(fields.Zd ?? 0, lane), predReg(fields.Pg ?? 0, "z"), vecReg(fields.Zn ?? 0, lane), vecReg(fields.Zm ?? 0, lane)];
}
function sveUnaryPermutationOperands(inst) {
    const fields = inst.fields;
    const lane = sveVectorLaneFromSize(fields.size);
    return [vecReg(fields.Zd ?? 0, lane), vecReg(fields.Zn ?? 0, lane)];
}
function sveCompactOperands(inst) {
    const fields = inst.fields;
    const lane = inst.encoding.encodingId.endsWith("_s")
        ? sveVectorLaneFromSize(fields.sz)
        : sveVectorLaneFromSize((fields.sz ?? 0) + 2);
    return [vecReg(fields.Zd ?? 0, lane), predReg(fields.Pg ?? 0), vecReg(fields.Zn ?? 0, lane)];
}
function svePrefetchOpText(prfop) {
    switch (prfop) {
        case 0:
            return "pldl1keep";
        case 1:
            return "pldl1strm";
        case 2:
            return "pldl2keep";
        case 3:
            return "pldl2strm";
        case 4:
            return "pldl3keep";
        case 5:
            return "pldl3strm";
        case 8:
            return "pstl1keep";
        case 9:
            return "pstl1strm";
        case 10:
            return "pstl2keep";
        case 11:
            return "pstl2strm";
        case 12:
            return "pstl3keep";
        case 13:
            return "pstl3strm";
        default:
            return `#${prfop}`;
    }
}
function sveScalarImmediatePrefetchOperands(inst) {
    const fields = inst.fields;
    let memory;
    if (inst.encoding.fileName.endsWith("_ai.xml")) {
        memory = sveGatherVectorImmediateMemoryText(inst);
    }
    else if (inst.encoding.fileName.endsWith("_bz.xml")) {
        memory = sveGatherVectorOffsetMemoryText(inst);
    }
    else {
        const imm = Number(signExtend(fields.imm6 ?? 0, 6));
        const base = formatRegister(gpReg(64, fields.Rn, "sp"));
        memory = imm === 0 ? `[${base}]` : `[${base}, #${imm}, mul vl]`;
    }
    return [
        { kind: "text", text: svePrefetchOpText(fields.prfop ?? 0) },
        predReg(fields.Pg),
        { kind: "text", text: memory },
    ];
}
function movaLaneFromClassName(className) {
    switch (className) {
        case "16-bit":
            return "h";
        case "32-bit":
            return "s";
        case "64-bit":
            return "d";
        case "128-bit":
            return "q";
        default:
            return "b";
    }
}
function movaTileIndex(fields, fieldName, className) {
    return className === "8-bit" ? 0 : (fields[fieldName] ?? 0);
}
function movaOrientation(fields) {
    return fields.V === 1 ? "v" : "h";
}
function movaSingleOffset(fields, className) {
    switch (className) {
        case "16-bit":
            return fields.off3 ?? 0;
        case "32-bit":
            return fields.off2 ?? 0;
        case "64-bit":
            return fields.o1 ?? 0;
        case "128-bit":
            return 0;
        default:
            return fields.off4 ?? 0;
    }
}
function movaSliceRange(fields, className, count) {
    if (count === 2) {
        switch (className) {
            case "16-bit": {
                const base = (fields.off2 ?? 0) * 2;
                return [base, base + 1];
            }
            case "32-bit": {
                const base = (fields.o1 ?? 0) * 2;
                return [base, base + 1];
            }
            case "64-bit":
                return [0, 1];
            default: {
                const base = (fields.off3 ?? 0) * 2;
                return [base, base + 1];
            }
        }
    }
    switch (className) {
        case "16-bit": {
            const base = (fields.o1 ?? 0) * 4;
            return [base, base + 3];
        }
        case "32-bit":
        case "64-bit":
            return [0, 3];
        default: {
            const base = (fields.off2 ?? 0) * 4;
            return [base, base + 3];
        }
    }
}
function movaVectorGroupText(start, count, lane) {
    if (count === 2) {
        return `{ z${start}.${lane}, z${start + 1}.${lane} }`;
    }
    return `{ z${start}.${lane} - z${start + 3}.${lane} }`;
}
function movaSingleZaText(fields, className, fieldName) {
    const lane = movaLaneFromClassName(className);
    const tile = movaTileIndex(fields, fieldName, className);
    const selector = 12 + (fields.Rs ?? 0);
    const offset = movaSingleOffset(fields, className);
    return `za${tile}${movaOrientation(fields)}.${lane}[w${selector}, ${offset}]`;
}
function movaSliceZaText(fields, className, fieldName, count) {
    const lane = movaLaneFromClassName(className);
    const tile = movaTileIndex(fields, fieldName, className);
    const selector = 12 + (fields.Rs ?? 0);
    const [start, end] = movaSliceRange(fields, className, count);
    return `za${tile}${movaOrientation(fields)}.${lane}[w${selector}, ${start}:${end}]`;
}
function movaArrayZaText(fields, count) {
    return `za.d[w${8 + (fields.Rv ?? 0)}, ${fields.off3 ?? 0}, vgx${count}]`;
}
function smeWideningFloatConvertOperands(inst) {
    const fields = inst.fields;
    return [
        vectorGroup((fields.Zd ?? 0) * 2, 2, "s"),
        vecReg(fields.Zn ?? 0, "h"),
    ];
}
function smeFp8WideningConvertOperands(inst) {
    const fields = inst.fields;
    return [
        vectorGroup((fields.Zd ?? 0) * 2, 2, "h"),
        vecReg(fields.Zn ?? 0, "b"),
    ];
}
function smeNarrowingConvertOperands(inst) {
    const fields = inst.fields;
    if (inst.encoding.fileName.endsWith("_mz4.xml")) {
        const destLane = (fields.sz ?? 0) === 1 ? "h" : "b";
        const srcLane = destLane === "h" ? "d" : "s";
        return [
            vecReg(fields.Zd ?? 0, destLane),
            vectorGroup((fields.Zn ?? 0) * 4, 4, srcLane),
        ];
    }
    return [vecReg(fields.Zd ?? 0, "h"), vectorGroup((fields.Zn ?? 0) * 2, 2, "s")];
}
function smeNarrowingShiftOperands(inst) {
    const fields = inst.fields;
    if (inst.encoding.fileName.endsWith("_mz4.xml")) {
        const tsize = fields.tsize ?? 0;
        if (tsize === 0) {
            return [];
        }
        const sourceElementBits = 8 << highestSetBitNZ(tsize);
        const encoded = (tsize << 5) | (fields.imm5 ?? 0);
        const shift = (8 * sourceElementBits) - encoded;
        const sourceLane = sourceElementBits === 8 ? "s" : "d";
        const destLane = sourceElementBits === 8 ? "b" : "h";
        return [
            vecReg(fields.Zd ?? 0, destLane),
            vectorGroup((fields.Zn ?? 0) * 4, 4, sourceLane),
            { kind: "text", text: `#${shift}` },
        ];
    }
    const tsize = ((fields.tszh ?? 0) << 2) | (fields.tszl ?? 0);
    if (tsize === 0) {
        return [];
    }
    const sourceElementBits = 8 << highestSetBitNZ(tsize);
    const encoded = (tsize << 3) | (fields.imm3 ?? 0);
    const shift = (2 * sourceElementBits) - encoded;
    return [
        vecReg(fields.Zd ?? 0, "h"),
        vectorGroup((fields.Zn ?? 0) * 2, 2, "s"),
        { kind: "text", text: `#${shift}` },
    ];
}
function smeFp8NarrowConvertSourceLane(fileName) {
    return fileName === "fcvtnb_z8_mz2.xml" || fileName === "fcvtnt_z8_mz2.xml" ? "s" : "h";
}
function smeFp8NarrowConvertOperands(inst) {
    const fields = inst.fields;
    const lane = smeFp8NarrowConvertSourceLane(inst.encoding.fileName);
    return [
        vecReg(fields.Zd ?? 0, "b"),
        vectorGroup((fields.Zn ?? 0) * 2, 2, lane),
    ];
}
function smeFp8NarrowingConvertOperands(inst) {
    const fields = inst.fields;
    if (inst.encoding.fileName.endsWith("_mz4.xml")) {
        return [vecReg(fields.Zd ?? 0, "b"), vectorGroup((fields.Zn ?? 0) * 4, 4, "s")];
    }
    return [vecReg(fields.Zd ?? 0, "b"), vectorGroup((fields.Zn ?? 0) * 2, 2, "h")];
}
const SME_ZERO_MASK_ENTRIES = [
    { text: "za", mask: 0xff },
    { text: "za0.h", mask: 0x55 },
    { text: "za1.h", mask: 0xaa },
    { text: "za0.s", mask: 0x11 },
    { text: "za1.s", mask: 0x22 },
    { text: "za2.s", mask: 0x44 },
    { text: "za3.s", mask: 0x88 },
    { text: "za0.d", mask: 0x01 },
    { text: "za1.d", mask: 0x02 },
    { text: "za2.d", mask: 0x04 },
    { text: "za3.d", mask: 0x08 },
    { text: "za4.d", mask: 0x10 },
    { text: "za5.d", mask: 0x20 },
    { text: "za6.d", mask: 0x40 },
    { text: "za7.d", mask: 0x80 },
];
function smeZeroMaskText(mask) {
    const normalized = mask & 0xff;
    if (normalized === 0xff)
        return "{za}";
    // All listed tiles use one arrangement. Choose the widest tiles that cover
    // exactly this mask; a partial tile requires the next smaller arrangement.
    for (const lane of ["h", "s", "d"]) {
        const tiles = SME_ZERO_MASK_ENTRIES.filter((entry) => entry.text.endsWith(`.${lane}`) && (normalized & entry.mask) === entry.mask);
        if (tiles.reduce((covered, entry) => covered | entry.mask, 0) === normalized) {
            return `{${tiles.map((entry) => entry.text).join(", ")}}`;
        }
    }
    return "{}";
}
function smeZeroGroupCount(encodingId) {
    if (encodingId.endsWith("_4")) {
        return 4;
    }
    if (encodingId.endsWith("_2")) {
        return 2;
    }
    return 1;
}
function smeZeroBaseOperands(inst) {
    return [{ kind: "text", text: smeZeroMaskText(inst.fields.imm8 ?? 0) }];
}
function smeZeroSingleVectorOperands(inst) {
    const count = smeZeroGroupCount(inst.encoding.encodingId);
    return [{ kind: "text", text: movaArrayZaText(inst.fields, count === 1 ? 2 : count) }];
}
function smeZeroGroupedOperands(inst, vectorsPerGroup) {
    const fields = inst.fields;
    const start = vectorsPerGroup === 2 ? 2 * (fields.off3 ?? fields.off2 ?? 0) : 4 * (fields.off2 ?? fields.o1 ?? 0);
    const end = start + vectorsPerGroup - 1;
    const groupCount = smeZeroGroupCount(inst.encoding.encodingId);
    const vgx = groupCount === 1 ? "" : `, vgx${groupCount}`;
    return [{ kind: "text", text: `za.d[w${8 + (fields.Rv ?? 0)}, ${start}:${end}${vgx}]` }];
}
function movaSingleToVectorOperands(inst) {
    const fields = inst.fields;
    const className = inst.encoding.className;
    const lane = movaLaneFromClassName(className);
    return [vecReg(fields.Zd, lane), predReg(fields.Pg, "m"), { kind: "text", text: movaSingleZaText(fields, className, "ZAn") }];
}
function movazSingleToVectorOperands(inst) {
    const fields = inst.fields;
    const className = inst.encoding.className;
    const lane = movaLaneFromClassName(className);
    return [vecReg(fields.Zd, lane), { kind: "text", text: movaSingleZaText(fields, className, "ZAn") }];
}
function movaVectorToSingleOperands(inst) {
    const fields = inst.fields;
    const className = inst.encoding.className;
    const lane = movaLaneFromClassName(className);
    return [{ kind: "text", text: movaSingleZaText(fields, className, "ZAd") }, predReg(fields.Pg, "m"), vecReg(fields.Zn, lane)];
}
function movaSliceToVectorsOperands(inst, count) {
    const fields = inst.fields;
    const className = inst.encoding.className;
    const lane = movaLaneFromClassName(className);
    const start = (fields.Zd ?? 0) * count;
    return [{ kind: "text", text: movaVectorGroupText(start, count, lane) }, { kind: "text", text: movaSliceZaText(fields, className, "ZAn", count) }];
}
function movaVectorsToSliceOperands(inst, count) {
    const fields = inst.fields;
    const className = inst.encoding.className;
    const lane = movaLaneFromClassName(className);
    const start = (fields.Zn ?? 0) * count;
    return [{ kind: "text", text: movaSliceZaText(fields, className, "ZAd", count) }, { kind: "text", text: movaVectorGroupText(start, count, lane) }];
}
function movaArrayToVectorsOperands(inst, count) {
    const fields = inst.fields;
    const start = (fields.Zd ?? 0) * count;
    return [
        { kind: "text", text: movaVectorGroupText(start, count, "d") },
        { kind: "text", text: movaArrayZaText(fields, count) },
    ];
}
function movaVectorsToArrayOperands(inst, count) {
    const fields = inst.fields;
    const start = (fields.Zn ?? 0) * count;
    return [
        { kind: "text", text: movaArrayZaText(fields, count) },
        { kind: "text", text: movaVectorGroupText(start, count, "d") },
    ];
}
function smeZaTileSliceLane(fileName) {
    if (fileName.includes("1b_")) {
        return "b";
    }
    if (fileName.includes("1h_")) {
        return "h";
    }
    if (fileName.includes("1w_")) {
        return "s";
    }
    if (fileName.includes("1d_")) {
        return "d";
    }
    return "q";
}
function smeZaTileSliceMemoryShift(fileName) {
    switch (smeZaTileSliceLane(fileName)) {
        case "b":
            return 0;
        case "h":
            return 1;
        case "s":
            return 2;
        case "d":
            return 3;
        case "q":
            return 4;
    }
}
function smeZaTileSliceText(inst) {
    const fields = inst.fields;
    const lane = smeZaTileSliceLane(inst.encoding.fileName);
    const tile = fields.ZAt ?? 0;
    const orientation = (fields.V ?? 0) === 1 ? "v" : "h";
    const selector = 12 + (fields.Rs ?? 0);
    const offset = fields.off4 ?? fields.off3 ?? fields.off2 ?? fields.o1 ?? 0;
    return `za${tile}${orientation}.${lane}[w${selector}, ${offset}]`;
}
function smeZaTileSliceMemoryText(inst) {
    const fields = inst.fields;
    const base = formatRegister(gpReg(64, fields.Rn ?? 0, "sp"));
    const rm = fields.Rm ?? 0;
    if (rm === 31) {
        return `[${base}]`;
    }
    const offset = formatRegister(gpReg(64, rm, "zr"));
    const shift = smeZaTileSliceMemoryShift(inst.encoding.fileName);
    return shift === 0 ? `[${base}, ${offset}]` : `[${base}, ${offset}, lsl #${shift}]`;
}
function smeZaTileSliceOperands(inst) {
    const predicateMode = inst.encoding.mnemonic.startsWith("LD") ? "z" : undefined;
    return [
        { kind: "text", text: `{${smeZaTileSliceText(inst)}}` },
        predReg(inst.fields.Pg ?? 0, predicateMode),
        { kind: "text", text: smeZaTileSliceMemoryText(inst) },
    ];
}
function smeOuterProductLane(inst) {
    switch (inst.encoding.className) {
        case "Half-precision":
            return "h";
        case "Single-precision":
            return "s";
        case "Double-precision":
            return "d";
        default:
            return "h";
    }
}
function smeOuterProductOperands(inst) {
    const fields = inst.fields;
    let lane = smeOuterProductLane(inst);
    let sourceLane = lane;
    switch (inst.encoding.fileName) {
        case "sumopa_za_pp_zz.xml":
        case "sumops_za_pp_zz.xml":
        case "usmopa_za_pp_zz.xml":
        case "usmops_za_pp_zz.xml":
        case "smopa_za_pp_zz.xml":
        case "smops_za_pp_zz.xml":
        case "umopa_za_pp_zz.xml":
        case "umops_za_pp_zz.xml":
        case "smopa_za32_pp_zz.xml":
        case "smops_za32_pp_zz.xml":
        case "umopa_za32_pp_zz.xml":
        case "umops_za32_pp_zz.xml":
            lane = inst.encoding.fileName.includes("za32") ? "s" : inst.encoding.className.includes("64-bit") ? "d" : "s";
            sourceLane = inst.encoding.fileName.includes("za32") ? "h" : lane === "d" ? "h" : "b";
            break;
        case "bmopa_za_pp_zz.xml":
        case "bmops_za_pp_zz.xml":
            lane = "s";
            sourceLane = "s";
            break;
        case "bfmopa_za_pp_zz.xml":
        case "bfmops_za_pp_zz.xml":
            lane = "h";
            sourceLane = "h";
            break;
        case "bfmopa_za32_pp_zz.xml":
        case "bfmops_za32_pp_zz.xml":
            lane = "s";
            sourceLane = "h";
            break;
        case "fmopa_za32_pp_zz.xml":
        case "fmops_za32_pp_zz.xml":
            lane = "s";
            sourceLane = "h";
            break;
    }
    return [
        { kind: "za", index: fields.ZAda ?? 0, lane },
        predReg(fields.Pn ?? 0, "m"),
        predReg(fields.Pm ?? 0, "m"),
        vecReg(fields.Zn ?? 0, sourceLane),
        vecReg(fields.Zm ?? 0, sourceLane),
    ];
}
function smeSliceAccumulatorOperands(inst) {
    const fields = inst.fields;
    const lane = smeDotAccumulatorLane(inst);
    return [
        { kind: "za", index: fields.ZAda ?? 0, lane },
        predReg(fields.Pn ?? 0, "m"),
        predReg(fields.Pm ?? 0, "m"),
        vecReg(fields.Zn ?? 0, lane),
    ];
}
function smeFp8OuterProductOperands(inst) {
    const fields = inst.fields;
    const lane = inst.encoding.fileName.includes("za16") ? "h" : "s";
    return [
        { kind: "za", index: fields.ZAda ?? 0, lane },
        predReg(fields.Pn ?? 0, "m"),
        predReg(fields.Pm ?? 0, "m"),
        vecReg(fields.Zn ?? 0, "b"),
        vecReg(fields.Zm ?? 0, "b"),
    ];
}
function smeMovtZtOperands(inst) {
    const fields = inst.fields;
    const offset = fields.off2 ?? fields.imm2 ?? 0;
    const destination = offset === 0 ? "zt0" : `zt0[${offset}, mul vl]`;
    return [{ kind: "text", text: destination }, vecReg(fields.Zt ?? fields.Zn ?? fields.Zm ?? 0)];
}
function smeMovtScalarOperands(inst) {
    const fields = inst.fields;
    const offset = (fields.off3 ?? 0) * 8;
    const table = { kind: "text", text: `zt0[${offset}]` };
    const scalar = gpReg(64, fields.Rt ?? 0, "zr");
    return inst.encoding.fileName === "movt_r_zt.xml" ? [scalar, table] : [table, scalar];
}
function smeZeroZtOperands() {
    return [{ kind: "text", text: "{ zt0 }" }];
}
function smePermutationOperands(inst) {
    const fields = inst.fields;
    const lane = inst.encoding.className.includes("128-bit") ? "q" : sveVectorLaneFromSize(fields.size);
    return [
        vectorGroup((fields.Zd ?? 0) * 2, 2, lane),
        vecReg(fields.Zn ?? 0, lane),
        vecReg(fields.Zm ?? 0, lane),
    ];
}
function smeVectorGroupPermutationOperands(inst) {
    const fields = inst.fields;
    const lane = inst.encoding.className.includes("128-bit") ? "q" : sveVectorLaneFromSize(fields.size);
    return [
        vectorGroup((fields.Zd ?? 0) * 4, 4, lane),
        vectorGroup((fields.Zn ?? 0) * 4, 4, lane),
    ];
}
function smeSelectOperands(inst) {
    const fields = inst.fields;
    const count = smeDotGroupCount(inst.encoding.className);
    const lane = sveVectorLaneFromSize(fields.size);
    return [
        vectorGroup((fields.Zd ?? 0) * count, count, lane),
        { kind: "text", text: `pn${8 + (fields.PNv ?? 0)}` },
        vectorGroup((fields.Zn ?? 0) * count, count, lane),
        vectorGroup((fields.Zm ?? 0) * count, count, lane),
    ];
}
function smeUnpackSourceLane(lane) {
    switch (lane) {
        case "h":
            return "b";
        case "s":
            return "h";
        case "d":
            return "s";
    }
}
function smeUnpackOperands(inst) {
    const fields = inst.fields;
    const count = smeDotGroupCount(inst.encoding.className);
    const lane = sveVectorLaneFromSize(fields.size);
    const sourceLane = smeUnpackSourceLane(lane);
    const source = count === 4
        ? vectorGroup((fields.Zn ?? 0) * 2, 2, sourceLane)
        : vecReg(fields.Zn ?? 0, sourceLane);
    return [
        vectorGroup((fields.Zd ?? 0) * count, count, lane),
        source,
    ];
}
function rprfmOpText(fields) {
    const operation = (((fields.option ?? 0) >> 2) << 5) | (((fields.option ?? 0) & 1) << 4) | ((fields.S ?? 0) << 3) | ((fields.Rt ?? 0) & 0x7);
    switch (operation) {
        case 0:
            return "pldkeep";
        case 1:
            return "pstkeep";
        case 4:
            return "pldstrm";
        case 5:
            return "pststrm";
        default:
            return `#${operation}`;
    }
}
function rprfmOperands(inst) {
    const fields = inst.fields;
    return [
        { kind: "text", text: rprfmOpText(fields) },
        gpReg(64, fields.Rm, "zr"),
        { kind: "text", text: `[${formatRegister(gpReg(64, fields.Rn, "sp"))}]` },
    ];
}
function fjcvtzsOperands(inst) {
    const fields = inst.fields;
    return [gpReg(32, fields.Rd, "zr"), { kind: "text", text: `d${fields.Rn ?? 0}` }];
}
function wfxtOperands(inst) {
    const fields = inst.fields;
    return [gpReg(64, fields.Rd, "zr")];
}
function udfOperands(inst) {
    const fields = inst.fields;
    return [{ kind: "text", text: `#${fields.imm16 ?? 0}` }];
}
function smeLdrZaArrayVectorOperands(inst) {
    const fields = inst.fields;
    const selector = 12 + (fields.Rv ?? 0);
    const offset = fields.off4 ?? 0;
    const base = formatRegister(gpReg(64, fields.Rn ?? 0, "sp"));
    const memory = offset === 0 ? `[${base}]` : `[${base}, #${offset}, mul vl]`;
    return [
        { kind: "text", text: `za[w${selector}, ${offset}]` },
        { kind: "text", text: memory },
    ];
}
function smeZtMemoryOperands(inst) {
    const fields = inst.fields;
    const base = formatRegister(gpReg(64, fields.Rn ?? 0, "sp"));
    return [{ kind: "text", text: "zt0" }, { kind: "text", text: `[${base}]` }];
}
function pselLaneAndImmediate(fields) {
    const i1 = fields.i1 ?? 0;
    const tszh = fields.tszh ?? 0;
    const tszl = fields.tszl ?? 0;
    const encodedImm = (i1 << 4) | (tszh << 3) | tszl;
    if ((tszl & 0b001) === 0b001) {
        return { lane: "b", imm: encodedImm >> 1 };
    }
    if ((tszl & 0b010) === 0b010) {
        return { lane: "h", imm: encodedImm >> 2 };
    }
    if ((tszl & 0b100) === 0b100) {
        return { lane: "s", imm: encodedImm >> 3 };
    }
    if (tszh === 1 && tszl === 0) {
        return { lane: "d", imm: i1 };
    }
    return { lane: "b", imm: encodedImm >> 1 };
}
function smePredicateSelectOperands(inst) {
    const fields = inst.fields;
    const { lane, imm } = pselLaneAndImmediate(fields);
    const selector = 12 + (fields.Rv ?? 0);
    return [
        predReg(fields.Pd ?? 0),
        predReg(fields.Pn ?? 0),
        { kind: "text", text: `p${fields.Pm ?? 0}.${lane}[w${selector}, ${imm}]` },
    ];
}
function sveRevdOperands(inst) {
    const fields = inst.fields;
    const mode = inst.encoding.encodingId.endsWith("_z") ? "z" : "m";
    return [vecReg(fields.Zd ?? 0, "q"), predReg(fields.Pg ?? 0, mode), vecReg(fields.Zn ?? 0, "q")];
}
function rdsvlOperands(inst) {
    const fields = inst.fields;
    return [gpReg(64, fields.Rd ?? 0, "zr"), { kind: "imm", value: signExtend(fields.imm6 ?? 0, 6), signed: true }];
}
function sveVectorLengthGpImmediateOperands(inst) {
    const fields = inst.fields;
    const fileName = inst.encoding.fileName;
    const destinationZeroName = fileName === "rdvl_r_i.xml" ? "zr" : "sp";
    const ops = [gpReg(64, fields.Rd ?? 0, destinationZeroName)];
    if (fileName !== "rdvl_r_i.xml") {
        ops.push(gpReg(64, fields.Rn ?? 0, "sp"));
    }
    ops.push({ kind: "imm", value: signExtend(fields.imm6 ?? 0, 6), signed: true });
    return ops;
}
function svePredicateControlOperands(inst) {
    const fields = inst.fields;
    switch (inst.encoding.fileName) {
        case "pfalse_p.xml":
            return [predReg(fields.Pd ?? 0, undefined, "b")];
        case "wrffr_f_p.xml":
            return [predReg(fields.Pn ?? 0, undefined, "b")];
        case "punpkhi_p_p.xml":
            return [predReg(fields.Pd ?? 0, undefined, "h"), predReg(fields.Pn ?? 0, undefined, "b")];
        default:
            return [];
    }
}
function sveTerminateConditionOperands(inst) {
    const fields = inst.fields;
    const width = widthFromSf(fields.sz);
    return [gpReg(width, fields.Rn ?? 0, "zr"), gpReg(width, fields.Rm ?? 0, "zr")];
}
function svePredicateMemoryOperands(inst) {
    const fields = inst.fields;
    const base = formatRegister(gpReg(64, fields.Rn ?? 0, "sp"));
    const encodedImm = ((fields.imm9h ?? 0) << 3) | (fields.imm9l ?? 0);
    const imm = signExtend(encodedImm, 9);
    const memory = imm === 0n ? `[${base}]` : `[${base}, ${formatSignedDecimalImmediate(imm)}, mul vl]`;
    const register = inst.encoding.fileName.includes("_p_") ? predReg(fields.Pt ?? 0) : vecReg(fields.Zt ?? 0);
    return [register, { kind: "text", text: memory }];
}
function svePredicateAsCounterOperands(inst) {
    const fields = inst.fields;
    switch (inst.encoding.fileName) {
        case "addpt_z_zz.xml":
        case "subpt_z_zz.xml":
            return [vecReg(fields.Zd ?? 0, "d"), vecReg(fields.Zn ?? 0, "d"), vecReg(fields.Zm ?? 0, "d")];
        case "addpt_z_p_zz.xml":
        case "subpt_z_p_zz.xml":
            return [vecReg(fields.Zdn ?? 0, "d"), predReg(fields.Pg ?? 0, "m"), vecReg(fields.Zdn ?? 0, "d"), vecReg(fields.Zm ?? 0, "d")];
        case "madpt_z_zzz.xml":
            return [vecReg(fields.Zdn ?? 0, "d"), vecReg(fields.Zm ?? 0, "d"), vecReg(fields.Za ?? 0, "d")];
        case "mlapt_z_zzz.xml":
            return [vecReg(fields.Zda ?? 0, "d"), vecReg(fields.Zn ?? 0, "d"), vecReg(fields.Zm ?? 0, "d")];
        default:
            return [];
    }
}
export function buildOperands(inst) {
    const operands = buildEncodingOperands(inst);
    if (operands.length === 0 && !INTENTIONAL_ZERO_OPERANDS.has(operands)) {
        throw new OperandDecodeError("unsupported", `unsupported operands for ${inst.encoding?.encodingId ?? "missing encoding"}`, inst.encoding?.fileName);
    }
    return operands;
}
function operandFamily(id, files, build) {
    return { id, files, build };
}
const OPERAND_FAMILIES = new OperandFamilyRegistry([
    ...TYPED_OPERAND_FAMILIES,
    operandFamily("gp-rd-rn-rm-sf", [
        "adc.xml", "adcs.xml", "sbc.xml", "sbcs.xml",
        "ngc_sbc.xml", "ngcs_sbcs.xml",
    ], inst => buildRegisteredSchema(inst) ?? buildOperandSchemaById(inst, "gp-rd-rn-rm-sf")),
    operandFamily("sve-fault-tolerant-load", [
        "ldff1b_z_p_ai.xml", "ldff1b_z_p_br.xml", "ldff1b_z_p_bz.xml", "ldff1h_z_p_ai.xml",
        "ldff1h_z_p_br.xml", "ldff1h_z_p_bz.xml", "ldff1w_z_p_ai.xml", "ldff1w_z_p_br.xml",
        "ldff1w_z_p_bz.xml", "ldff1d_z_p_ai.xml", "ldff1d_z_p_br.xml", "ldff1d_z_p_bz.xml",
        "ldff1sb_z_p_ai.xml", "ldff1sb_z_p_br.xml", "ldff1sb_z_p_bz.xml", "ldff1sh_z_p_ai.xml",
        "ldff1sh_z_p_br.xml", "ldff1sh_z_p_bz.xml", "ldff1sw_z_p_ai.xml", "ldff1sw_z_p_br.xml",
        "ldff1sw_z_p_bz.xml", "ldnf1b_z_p_bi.xml", "ldnf1h_z_p_bi.xml", "ldnf1w_z_p_bi.xml",
        "ldnf1d_z_p_bi.xml", "ldnf1sb_z_p_bi.xml", "ldnf1sh_z_p_bi.xml", "ldnf1sw_z_p_bi.xml",
    ], sveFaultTolerantLoadOperands),
    operandFamily("sve-contiguous-memory", [
        "ld1b_z_p_bi.xml", "ld1b_z_p_br.xml", "ld1h_z_p_bi.xml", "ld1h_z_p_br.xml",
        "ld1w_z_p_bi.xml", "ld1w_z_p_br.xml", "ld1d_z_p_bi.xml", "ld1d_z_p_br.xml",
        "ld1q_z_p_ar.xml", "ld1sb_z_p_bi.xml", "ld1sb_z_p_br.xml", "ld1sh_z_p_bi.xml",
        "ld1sh_z_p_br.xml", "ld1sw_z_p_bi.xml", "ld1sw_z_p_br.xml", "ldnt1b_z_p_bi.xml",
        "ldnt1b_z_p_br.xml", "ldnt1b_z_p_ar.xml", "ldnt1h_z_p_bi.xml", "ldnt1h_z_p_br.xml",
        "ldnt1h_z_p_ar.xml", "ldnt1w_z_p_bi.xml", "ldnt1w_z_p_br.xml", "ldnt1w_z_p_ar.xml",
        "ldnt1d_z_p_bi.xml", "ldnt1d_z_p_br.xml", "ldnt1d_z_p_ar.xml", "ld1b_mz_p_bi.xml",
        "ld1b_mz_p_br.xml", "ld1b_mzx_p_bi.xml", "ld1b_mzx_p_br.xml", "ld1h_mz_p_bi.xml",
        "ld1h_mz_p_br.xml", "ld1h_mzx_p_bi.xml", "ld1h_mzx_p_br.xml", "ld1w_mz_p_bi.xml",
        "ld1w_mz_p_br.xml", "ld1w_mzx_p_bi.xml", "ld1w_mzx_p_br.xml", "ld1d_mz_p_bi.xml",
        "ld1d_mz_p_br.xml", "ld1d_mzx_p_bi.xml", "ld1d_mzx_p_br.xml", "ldnt1b_mz_p_bi.xml",
        "ldnt1b_mz_p_br.xml", "ldnt1b_mzx_p_bi.xml", "ldnt1b_mzx_p_br.xml", "ldnt1h_mz_p_bi.xml",
        "ldnt1h_mz_p_br.xml", "ldnt1h_mzx_p_bi.xml", "ldnt1h_mzx_p_br.xml", "ldnt1w_mz_p_bi.xml",
        "ldnt1w_mz_p_br.xml", "ldnt1w_mzx_p_bi.xml", "ldnt1w_mzx_p_br.xml", "ldnt1d_mz_p_bi.xml",
        "ldnt1d_mz_p_br.xml", "ldnt1d_mzx_p_bi.xml", "ldnt1d_mzx_p_br.xml", "ld2q_z_p_bi.xml",
        "ld2q_z_p_br.xml", "ld3q_z_p_bi.xml", "ld3q_z_p_br.xml", "ld4q_z_p_bi.xml",
        "ld4q_z_p_br.xml", "st1b_z_p_bi.xml", "st1b_z_p_br.xml", "st1h_z_p_bi.xml",
        "st1h_z_p_br.xml", "st1w_z_p_bi.xml", "st1w_z_p_br.xml", "st1d_z_p_bi.xml",
        "st1d_z_p_br.xml", "st1q_z_p_ar.xml", "st1b_mz_p_bi.xml", "st1b_mz_p_br.xml",
        "st1b_mzx_p_bi.xml", "st1b_mzx_p_br.xml", "st1h_mz_p_bi.xml", "st1h_mz_p_br.xml",
        "st1h_mzx_p_bi.xml", "st1h_mzx_p_br.xml", "st1w_mz_p_bi.xml", "st1w_mz_p_br.xml",
        "st1w_mzx_p_bi.xml", "st1w_mzx_p_br.xml", "st1d_mz_p_bi.xml", "st1d_mz_p_br.xml",
        "st1d_mzx_p_bi.xml", "st1d_mzx_p_br.xml", "ld2b_z_p_bi.xml", "ld2b_z_p_br.xml",
        "ld2h_z_p_bi.xml", "ld2h_z_p_br.xml", "ld2w_z_p_bi.xml", "ld2w_z_p_br.xml",
        "ld2d_z_p_bi.xml", "ld2d_z_p_br.xml", "ld3b_z_p_bi.xml", "ld3b_z_p_br.xml",
        "ld3h_z_p_bi.xml", "ld3h_z_p_br.xml", "ld3w_z_p_bi.xml", "ld3w_z_p_br.xml",
        "ld3d_z_p_bi.xml", "ld3d_z_p_br.xml", "ld4b_z_p_bi.xml", "ld4b_z_p_br.xml",
        "ld4h_z_p_bi.xml", "ld4h_z_p_br.xml", "ld4w_z_p_bi.xml", "ld4w_z_p_br.xml",
        "ld4d_z_p_bi.xml", "ld4d_z_p_br.xml", "st2b_z_p_bi.xml", "st2b_z_p_br.xml",
        "st2h_z_p_bi.xml", "st2h_z_p_br.xml", "st2w_z_p_bi.xml", "st2w_z_p_br.xml",
        "st2d_z_p_bi.xml", "st2d_z_p_br.xml", "st2q_z_p_bi.xml", "st2q_z_p_br.xml",
        "st3b_z_p_bi.xml", "st3b_z_p_br.xml", "st3h_z_p_bi.xml", "st3h_z_p_br.xml",
        "st3w_z_p_bi.xml", "st3w_z_p_br.xml", "st3d_z_p_bi.xml", "st3d_z_p_br.xml",
        "st3q_z_p_bi.xml", "st3q_z_p_br.xml", "st4b_z_p_bi.xml", "st4b_z_p_br.xml",
        "st4h_z_p_bi.xml", "st4h_z_p_br.xml", "st4w_z_p_bi.xml", "st4w_z_p_br.xml",
        "st4d_z_p_bi.xml", "st4d_z_p_br.xml", "st4q_z_p_bi.xml", "st4q_z_p_br.xml",
        "stnt1b_z_p_bi.xml", "stnt1b_z_p_br.xml", "stnt1b_z_p_ar.xml", "stnt1h_z_p_bi.xml",
        "stnt1h_z_p_br.xml", "stnt1h_z_p_ar.xml", "stnt1w_z_p_bi.xml", "stnt1w_z_p_br.xml",
        "stnt1w_z_p_ar.xml", "stnt1d_z_p_bi.xml", "stnt1d_z_p_br.xml", "stnt1d_z_p_ar.xml",
        "stnt1b_mz_p_bi.xml", "stnt1b_mz_p_br.xml", "stnt1b_mzx_p_bi.xml", "stnt1b_mzx_p_br.xml",
        "stnt1h_mz_p_bi.xml", "stnt1h_mz_p_br.xml", "stnt1h_mzx_p_bi.xml", "stnt1h_mzx_p_br.xml",
        "stnt1w_mz_p_bi.xml", "stnt1w_mz_p_br.xml", "stnt1w_mzx_p_bi.xml", "stnt1w_mzx_p_br.xml",
        "stnt1d_mz_p_bi.xml", "stnt1d_mz_p_br.xml", "stnt1d_mzx_p_bi.xml", "stnt1d_mzx_p_br.xml",
    ], sveContiguousByteMemoryOperands),
    operandFamily("three-source-integer", ["madd.xml", "msub.xml", "maddpt.xml", "msubpt.xml"], threeSourceIntegerOperands),
    operandFamily("one-source-integer", [
        "clz_int.xml", "rbit_int.xml", "rev16_int.xml", "rev32_int.xml",
        "cls_int.xml", "abs.xml", "cnt.xml", "ctz.xml",
        "rev.xml",
    ], oneSourceIntegerOperands),
    operandFamily("mul-alias", ["mul_madd.xml"], mulAliasOperands),
    operandFamily("two-source-integer", [
        "mneg_msub.xml", "udiv.xml", "sdiv.xml", "smax_reg.xml",
        "smin_reg.xml", "umax_reg.xml", "umin_reg.xml", "lsl_lslv.xml",
        "lsr_lsrv.xml", "asr_asrv.xml", "ror_rorv.xml",
    ], twoSourceIntegerOperands),
    operandFamily("crc32", ["crc32.xml", "crc32c.xml"], crc32Operands),
    operandFamily("scalar-multiply-long", ["smaddl.xml", "smsubl.xml", "umaddl.xml", "umsubl.xml"], scalarMultiplyLongOperands),
    operandFamily("scalar-multiply-long-alias", ["smull_smaddl.xml", "smnegl_smsubl.xml", "umull_umaddl.xml", "umnegl_umsubl.xml"], scalarMultiplyLongAliasOperands),
    operandFamily("multiply-high", ["smulh.xml", "umulh.xml"], multiplyHighOperands),
    operandFamily("system-move", ["mrs.xml", "msr_reg.xml"], inst => {
        const encoding = inst.encoding;
        return systemMoveOperands(inst, encoding.mnemonic);
    }),
    operandFamily("system-move128", ["mrrs.xml", "msrr.xml"], inst => {
        const encoding = inst.encoding;
        return systemMove128Operands(inst, encoding.mnemonic);
    }),
    operandFamily("barrier", ["dmb.xml", "dsb.xml"], barrierOperands),
    operandFamily("clrex", ["clrex.xml"], clrexOperands),
    operandFamily("isb", ["isb.xml"], isbOperands),
    operandFamily("exception-immediate", [
        "svc.xml", "hvc.xml", "smc.xml", "brk.xml",
        "hlt.xml", "dcps1.xml", "dcps2.xml", "dcps3.xml",
    ], exceptionImmediateOperands),
    operandFamily("system-instruction-alias", ["at_sys.xml"], inst => {
        return systemInstructionAliasOperands(inst, AT_SYSTEM_ALIASES);
    }),
    operandFamily("system-instruction-alias-dc-sys", ["dc_sys.xml"], inst => {
        return systemInstructionAliasOperands(inst, DC_SYSTEM_ALIASES);
    }),
    operandFamily("system-instruction-alias-tlbi-sys", ["tlbi_sys.xml"], inst => {
        return systemInstructionAliasOperands(inst, TLBI_SYSTEM_ALIASES);
    }),
    operandFamily("msr-immediate", ["msr_imm.xml"], msrImmediateOperands),
    operandFamily("smstart-smstop", ["smstart_msr_imm.xml", "smstop_msr_imm.xml"], smstartSmstopOperands),
    operandFamily("rdsvl", ["rdsvl_r_i.xml"], rdsvlOperands),
    operandFamily("sve-vector-length-gp-immediate", [
        "addspl_r_ri.xml", "addsvl_r_ri.xml", "addpl_r_ri.xml", "addvl_r_ri.xml",
        "rdvl_r_i.xml",
    ], sveVectorLengthGpImmediateOperands),
    operandFamily("sysl", ["sysl.xml"], syslOperands),
    operandFamily("raw-sys", ["sys.xml"], rawSysOperands),
    operandFamily("spec-res-context", ["cfp_sys.xml", "dvp_sys.xml", "cpp_sys.xml", "cosp_sys.xml"], specResContextOperands),
    operandFamily("chkfeat", ["chkfeat.xml"], inst => {
        return chkfeatOperands();
    }),
    operandFamily("gcs-sysl-alias", ["gcsss2_sysl.xml", "gcspopm_sysl.xml", "gcsss1_sys.xml", "gcspushm_sys.xml"], gcsSyslAliasOperands),
    operandFamily("no-operands", [
        "gcspushx_sys.xml", "gcspopcx_sys.xml", "gcspopx_sys.xml", "nop.xml",
        "yield.xml", "wfe.xml", "wfi.xml", "sev.xml",
        "sevl.xml", "cfinv.xml", "xaflag.xml", "axflag.xml",
        "dgh.xml", "esb.xml", "csdb.xml", "ssbb_dsb.xml",
        "pssbb_dsb.xml", "sb.xml", "eret.xml", "drps.xml",
        "clrbhb.xml", "pacnbiasppc.xml", "pacnbibsppc.xml", "pacm.xml",
        "setffr_f.xml", "reta.xml", "ereta.xml", "autia171615.xml",
        "autib171615.xml", "pacia171615.xml", "pacib171615.xml", "paciasppc.xml",
        "pacibsppc.xml",
    ], inst => {
        return noOperands();
    }),
    operandFamily("gcsb", ["gcsb.xml"], inst => {
        return gcsbOperands();
    }),
    operandFamily("gcs-store", ["gcsstr.xml", "gcssttr.xml"], gcsStoreOperands),
    operandFamily("trcit", ["trcit_sys.xml"], trcitOperands),
    operandFamily("ldapr", ["ldapr.xml"], ldaprOperands),
    operandFamily("ldapr-byte-halfword", ["ldaprb.xml", "ldaprh.xml"], ldaprByteHalfwordOperands),
    operandFamily("ldiapp", ["ldiapp.xml"], ldiappOperands),
    operandFamily("rcpc-unscaled", [
        "ldapursb.xml", "ldapursh.xml", "ldapur_gen.xml", "ldapurb.xml",
        "ldapurh.xml", "ldapursw.xml", "stlur_gen.xml", "stlurb.xml",
        "stlurh.xml", "stlur_fpsimd.xml", "ldapur_fpsimd.xml",
    ], rcpcUnscaledOperands),
    operandFamily("stlr", ["stlr.xml", "stlrb.xml", "stlrh.xml"], stlrOperands),
    operandFamily("stilp", ["stilp.xml"], stilpOperands),
    operandFamily("sve-movprfx", ["movprfx_z_z.xml"], sveMovprfxOperands),
    operandFamily("sve-predicated-movprfx", ["movprfx_z_p_z.xml"], svePredicatedMovprfxOperands),
    operandFamily("sve-fcpy", ["fcpy_z_p_i.xml"], sveFcpyOperands),
    operandFamily("sve-fdup", ["fdup_z_i.xml", "fmov_dup_z_i.xml"], sveFdupOperands),
    operandFamily("scalar-fp-compare", ["fcmp_float.xml", "fcmpe_float.xml"], scalarFpCompareOperands),
    operandFamily("scalar-fp-conditional-compare", ["fccmp_float.xml", "fccmpe_float.xml"], scalarFpConditionalCompareOperands),
    operandFamily("scalar-fp-conditional-select", ["fcsel_float.xml"], scalarFpConditionalSelectOperands),
    operandFamily("scalar-fp-convert-precision", ["fcvt_float.xml"], scalarFpConvertPrecisionOperands),
    operandFamily("scalar-fp-unary", [
        "fmov_float.xml", "fabs_float.xml", "fneg_float.xml", "fsqrt_float.xml",
        "frintn_float.xml", "frintp_float.xml", "frintm_float.xml", "frintz_float.xml",
        "frinta_float.xml", "frintx_float.xml", "frinti_float.xml", "frint32z_float.xml",
        "frint64z_float.xml", "frint32x_float.xml", "frint64x_float.xml",
    ], scalarFpUnaryOperands),
    operandFamily("scalar-fp-move-general", ["fmov_float_gen.xml"], scalarFpMoveGeneralOperands),
    operandFamily("scalar-fp-move-immediate", ["fmov_float_imm.xml"], scalarFpMoveImmediateOperands),
    operandFamily("scalar-fp-to-integer", [
        "fcvtns_float.xml", "fcvtnu_float.xml", "fcvtas_float.xml", "fcvtau_float.xml",
        "fcvtps_float.xml", "fcvtpu_float.xml", "fcvtms_float.xml", "fcvtmu_float.xml",
        "fcvtzs_float_int.xml", "fcvtzu_float_int.xml",
    ], scalarFpToIntegerOperands),
    operandFamily("scalar-fp-to-integer-fcvtzs-float-fix", ["fcvtzs_float_fix.xml", "fcvtzu_float_fix.xml"], inst => {
        return scalarFpToIntegerOperands(inst, true);
    }),
    operandFamily("scalar-integer-to-fp", ["scvtf_float_int.xml", "ucvtf_float_int.xml"], scalarIntegerToFpOperands),
    operandFamily("scalar-integer-to-fp-scvtf-float-fix", ["scvtf_float_fix.xml", "ucvtf_float_fix.xml"], inst => {
        return scalarIntegerToFpOperands(inst, true);
    }),
    operandFamily("scalar-fp-binary", [
        "fmul_float.xml", "fdiv_float.xml", "fadd_float.xml", "fsub_float.xml",
        "fmax_float.xml", "fmin_float.xml", "fmaxnm_float.xml", "fminnm_float.xml",
        "fnmul_float.xml",
    ], scalarFpBinaryOperands),
    operandFamily("scalar-fp-ternary", ["fmadd_float.xml", "fmsub_float.xml", "fnmadd_float.xml", "fnmsub_float.xml"], scalarFpTernaryOperands),
    operandFamily("logical-shifted-register", [
        "and_log_shift.xml", "bic_log_shift.xml", "orr_log_shift.xml", "orn_log_shift.xml",
        "ands_log_shift.xml", "bics.xml", "tst_ands_log_shift.xml",
    ], logicalShiftedRegisterOperands),
    operandFamily("mov-register-alias", ["mov_orr_log_shift.xml"], movRegisterAliasOperands),
    operandFamily("logical-immediate", [
        "and_log_imm.xml", "ands_log_imm.xml", "tst_ands_log_imm.xml", "orr_log_imm.xml",
        "eor_log_imm.xml", "mov_orr_log_imm.xml",
    ], logicalImmediateOperands),
    operandFamily("scalar-load-store", [
        "ldr_imm_gen.xml", "str_imm_gen.xml", "ldur_gen.xml", "stur_gen.xml",
        "ldur_fpsimd.xml", "stur_fpsimd.xml", "ldrb_imm.xml", "ldurb.xml",
        "ldtrb.xml", "ldrh_imm.xml", "ldurh.xml", "ldtrh.xml",
        "strb_imm.xml", "sturb.xml", "sttrb.xml", "strh_imm.xml",
        "sturh.xml", "sttrh.xml", "ldr_reg_gen.xml", "ldrsw_reg.xml",
        "str_reg_gen.xml", "strb_reg.xml", "strh_reg.xml", "ldrb_reg.xml",
        "ldrh_reg.xml", "ldrsb_reg.xml", "ldrsh_reg.xml", "ldr_imm_fpsimd.xml",
        "str_imm_fpsimd.xml", "ldr_reg_fpsimd.xml", "str_reg_fpsimd.xml", "ldrsb_imm.xml",
        "ldrsh_imm.xml", "ldrsw_imm.xml", "ldursb.xml", "ldursh.xml",
        "ldursw.xml", "ldtr.xml", "sttr.xml", "ldtrsb.xml",
        "ldtrsh.xml", "ldtrsw.xml", "prfm_reg.xml", "prfm_imm.xml",
        "prfum.xml",
    ], scalarLoadStoreOperands),
    operandFamily("store-exclusive", [
        "stxr.xml", "stxrb.xml", "stxrh.xml", "stlxr.xml",
        "stlxrb.xml", "stlxrh.xml",
    ], storeExclusiveOperands),
    operandFamily("load-exclusive", [
        "ldxr.xml", "ldxrb.xml", "ldxrh.xml", "ldaxr.xml",
        "ldaxrb.xml", "ldaxrh.xml", "ldar.xml", "ldarb.xml",
        "ldarh.xml",
    ], loadExclusiveOperands),
    operandFamily("exclusive-pair", ["stxp.xml", "ldxp.xml", "ldaxp.xml"], exclusivePairOperands),
    operandFamily("ldr-literal", ["ldr_lit_gen.xml"], ldrLiteralOperands),
    operandFamily("pair-load-store", [
        "stnp_gen.xml", "ldp_gen.xml", "stp_gen.xml", "ldnp_gen.xml",
        "ldp_fpsimd.xml", "ldnp_fpsimd.xml", "stp_fpsimd.xml", "stnp_fpsimd.xml",
        "ldpsw.xml",
    ], pairLoadStoreOperands),
    operandFamily("conditional-select", [
        "csel.xml", "cinc_csinc.xml", "cinv_csinv.xml", "cneg_csneg.xml",
        "cset_csinc.xml", "csetm_csinv.xml",
    ], conditionalSelectOperands),
    operandFamily("conditional-compare-immediate", ["ccmp_imm.xml", "ccmn_imm.xml"], conditionalCompareImmediateOperands),
    operandFamily("conditional-compare-register", ["ccmp_reg.xml", "ccmn_reg.xml"], conditionalCompareRegisterOperands),
    operandFamily("min-max-immediate", ["smax_imm.xml", "smin_imm.xml", "umax_imm.xml", "umin_imm.xml"], minMaxImmediateOperands),
    operandFamily("bitfield-immediate", [
        "bfm.xml", "bfi_bfm.xml", "bfc_bfm.xml", "bfxil_bfm.xml",
        "sbfm.xml", "asr_sbfm.xml", "sbfiz_sbfm.xml", "sbfx_sbfm.xml",
        "sxtb_sbfm.xml", "sxth_sbfm.xml", "sxtw_sbfm.xml", "ubfm.xml",
        "lsl_ubfm.xml", "lsr_ubfm.xml", "ubfiz_ubfm.xml", "ubfx_ubfm.xml",
        "uxtb_ubfm.xml", "uxth_ubfm.xml",
    ], bitfieldImmediateOperands),
    operandFamily("stlxp", ["stlxp.xml"], stlxpOperands),
    operandFamily("sve-dup-indexed", ["dup_z_zi.xml"], sveDupIndexedOperands),
    operandFamily("sve-dup-immediate", ["dup_z_i.xml"], sveDupImmediateOperands),
    operandFamily("sve-pmov-predicate", ["pmov_p_zi.xml"], svePmovPredicateOperands),
    operandFamily("sve-pmov-vector", ["pmov_z_pi.xml"], svePmovVectorOperands),
    operandFamily("sve-pext", ["pext_pn_rr.xml", "pext_pp_rr.xml"], svePextOperands),
    operandFamily("sve-copy-immediate", ["cpy_z_o_i.xml"], sveCopyImmediateOperands),
    operandFamily("sve-copy-merging-immediate", ["cpy_z_p_i.xml"], sveCopyMergingImmediateOperands),
    operandFamily("sve-copy-scalar", ["cpy_z_p_r.xml"], sveCopyScalarOperands),
    operandFamily("sve-copy-scalar-vector", ["cpy_z_p_v.xml"], sveCopyScalarVectorOperands),
    operandFamily("extract-register", ["extr.xml"], extractRegisterOperands),
    operandFamily("bti", ["bti.xml"], btiOperands),
    operandFamily("hint", ["hint.xml"], hintOperands),
    operandFamily("setf", ["setf.xml"], setfOperands),
    operandFamily("rmif", ["rmif.xml"], rmifOperands),
    operandFamily("advsimd-saturating-rounding-doubling-multiply", [
        "sqrdmlah_advsimd_vec.xml", "sqrdmlah_advsimd_elt.xml", "sqrdmlsh_advsimd_vec.xml", "sqrdmlsh_advsimd_elt.xml",
        "sqdmulh_advsimd_vec.xml", "sqrdmulh_advsimd_vec.xml", "sqdmulh_advsimd_elt.xml", "sqrdmulh_advsimd_elt.xml",
    ], advsimdSaturatingRoundingDoublingMultiplyOperands),
    operandFamily("advsimd-by-element-multiply-accumulate", [
        "mla_advsimd_elt.xml", "mls_advsimd_elt.xml", "mul_advsimd_elt.xml", "fmla_advsimd_elt.xml",
        "fmls_advsimd_elt.xml", "fmul_advsimd_elt.xml", "fmulx_advsimd_elt.xml",
    ], advsimdByElementMultiplyAccumulateOperands),
    operandFamily("advsimd-by-element-long", [
        "smull_advsimd_elt.xml", "umull_advsimd_elt.xml", "sqdmull_advsimd_elt.xml", "smlal_advsimd_elt.xml",
        "smlsl_advsimd_elt.xml", "sqdmlal_advsimd_elt.xml", "umlal_advsimd_elt.xml", "umlsl_advsimd_elt.xml",
        "sqdmlsl_advsimd_elt.xml",
    ], advsimdByElementLongOperands),
    operandFamily("advsimd-complex-vector", ["fcmla_advsimd_vec.xml", "fcadd_advsimd_vec.xml"], advsimdComplexVectorOperands),
    operandFamily("advsimd-complex-by-element", ["fcmla_advsimd_elt.xml"], advsimdComplexByElementOperands),
    operandFamily("advsimd-fp-long-multiply-accumulate", [
        "fmlal_advsimd_vec.xml", "fmlalb_advsimd_vec.xml", "fmlallbb_advsimd_vec.xml", "fmlsl_advsimd_vec.xml",
        "fmlal_advsimd_elt.xml", "fmlalb_advsimd_elem.xml", "fmlallbb_advsimd_elem.xml", "fmlsl_advsimd_elt.xml",
    ], advsimdFpLongMultiplyAccumulateOperands),
    operandFamily("advsimd-floating-pairwise", [
        "fmaxp_advsimd_pair.xml", "fminp_advsimd_pair.xml", "fmaxnmp_advsimd_pair.xml", "fminnmp_advsimd_pair.xml",
        "faddp_advsimd_vec.xml", "faddp_advsimd_pair.xml", "fmaxp_advsimd_vec.xml", "fminp_advsimd_vec.xml",
        "fmaxnmp_advsimd_vec.xml", "fminnmp_advsimd_vec.xml",
    ], advsimdFloatingPairwiseOperands),
    operandFamily("advsimd-integer-pairwise", ["addp_advsimd_vec.xml", "addp_advsimd_pair.xml"], advsimdIntegerPairwiseOperands),
    operandFamily("advsimd-crypto-binary", ["aese_advsimd.xml", "aesd_advsimd.xml", "aesmc_advsimd.xml", "aesimc_advsimd.xml"], advsimdCryptoBinaryOperands),
    operandFamily("advsimd-scalar-or-vector-three-same", [
        "fscale_advsimd.xml", "add_advsimd.xml", "sub_advsimd.xml", "fadd_advsimd.xml",
        "fsub_advsimd.xml", "shadd_advsimd.xml", "uhadd_advsimd.xml", "shsub_advsimd.xml",
        "uhsub_advsimd.xml", "srhadd_advsimd.xml", "urhadd_advsimd.xml", "smaxp_advsimd.xml",
        "sminp_advsimd.xml", "umaxp_advsimd.xml", "uminp_advsimd.xml", "smax_advsimd.xml",
        "smin_advsimd.xml", "umax_advsimd.xml", "umin_advsimd.xml", "fmax_advsimd.xml",
        "famax_advsimd.xml", "fmin_advsimd.xml", "famin_advsimd.xml", "fmaxnm_advsimd.xml",
        "fminnm_advsimd.xml", "fabd_advsimd.xml", "frecps_advsimd.xml", "frsqrts_advsimd.xml",
        "saba_advsimd.xml", "uaba_advsimd.xml", "sabd_advsimd.xml", "uabd_advsimd.xml",
        "sqadd_advsimd.xml", "uqadd_advsimd.xml", "sqsub_advsimd.xml", "uqsub_advsimd.xml",
        "mul_advsimd_vec.xml", "mla_advsimd_vec.xml", "mls_advsimd_vec.xml", "fmul_advsimd_vec.xml",
        "fdiv_advsimd.xml", "pmul_advsimd.xml", "fmulx_advsimd_vec.xml", "fmla_advsimd_vec.xml",
        "fmls_advsimd_vec.xml", "and_advsimd.xml", "eor_advsimd.xml", "bit_advsimd.xml",
        "bif_advsimd.xml", "bsl_advsimd.xml", "orn_advsimd.xml", "bic_advsimd_reg.xml",
        "sshl_advsimd.xml", "ushl_advsimd.xml", "srshl_advsimd.xml", "urshl_advsimd.xml",
        "sqshl_advsimd_reg.xml", "uqshl_advsimd_reg.xml", "sqrshl_advsimd.xml", "uqrshl_advsimd.xml",
    ], advsimdScalarOrVectorThreeSameOperands),
    operandFamily("advsimd-bfloat16-multiply-accumulate", ["bfmmla_advsimd.xml", "bfmlal_advsimd_vec.xml", "bfmlal_advsimd_elt.xml"], advsimdBfloat16MultiplyAccumulateOperands),
    operandFamily("advsimd-matrix-multiply-accumulate", ["smmla_advsimd_vec.xml", "ummla_advsimd_vec.xml", "usmmla_advsimd_vec.xml"], advsimdMatrixMultiplyAccumulateOperands),
    operandFamily("advsimd-dot-product", [
        "sdot_advsimd_vec.xml", "sdot_advsimd_elt.xml", "sudot_advsimd_elt.xml", "udot_advsimd_vec.xml",
        "udot_advsimd_elt.xml", "usdot_advsimd_vec.xml", "usdot_advsimd_elt.xml", "bfdot_advsimd_vec.xml",
        "bfdot_advsimd_elt.xml",
    ], advsimdDotProductOperands),
    operandFamily("advsimd-compare", [
        "cmeq_advsimd_reg.xml", "cmeq_advsimd_zero.xml", "cmge_advsimd_reg.xml", "cmge_advsimd_zero.xml",
        "cmgt_advsimd_reg.xml", "cmgt_advsimd_zero.xml", "cmhi_advsimd.xml", "cmhs_advsimd.xml",
        "cmtst_advsimd.xml", "cmle_advsimd.xml", "cmlt_advsimd.xml", "fcmeq_advsimd_reg.xml",
        "fcmeq_advsimd_zero.xml", "fcmge_advsimd_reg.xml", "fcmge_advsimd_zero.xml", "fcmgt_advsimd_reg.xml",
        "fcmgt_advsimd_zero.xml", "fcmle_advsimd.xml", "fcmlt_advsimd.xml", "facge_advsimd.xml",
        "facgt_advsimd.xml",
    ], advsimdCompareOperands),
    operandFamily("advsimd-crypto-sha1-hash", ["sha1h_advsimd.xml"], advsimdCryptoSha1HashOperands),
    operandFamily("advsimd-crypto-vector4s-binary", ["sha1su1_advsimd.xml", "sha256su0_advsimd.xml"], advsimdCryptoVector4sBinaryOperands),
    operandFamily("advsimd-crypto-sha1-three-reg", ["sha1c_advsimd.xml", "sha1p_advsimd.xml", "sha1m_advsimd.xml"], advsimdCryptoSha1ThreeRegOperands),
    operandFamily("advsimd-crypto-vector4s-three-reg", ["sha1su0_advsimd.xml", "sha256su1_advsimd.xml"], advsimdCryptoVector4sThreeRegOperands),
    operandFamily("advsimd-crypto-sha256-hash", ["sha256h_advsimd.xml", "sha256h2_advsimd.xml"], advsimdCryptoSha256HashOperands),
    operandFamily("advsimd-unary", [
        "suqadd_advsimd.xml", "usqadd_advsimd.xml", "sqabs_advsimd.xml", "sqneg_advsimd.xml",
        "abs_advsimd.xml", "neg_advsimd.xml", "rev64_advsimd.xml", "rev32_advsimd.xml",
        "rev16_advsimd.xml", "cls_advsimd.xml", "clz_advsimd.xml", "cnt_advsimd.xml",
        "mvn_not_advsimd.xml", "rbit_advsimd.xml", "fabs_advsimd.xml", "fneg_advsimd.xml",
        "urecpe_advsimd.xml", "ursqrte_advsimd.xml", "frecpe_advsimd.xml", "frecpx_advsimd.xml",
        "frsqrte_advsimd.xml", "fsqrt_advsimd.xml", "frintn_advsimd.xml", "frinta_advsimd.xml",
        "frintp_advsimd.xml", "frintm_advsimd.xml", "frintx_advsimd.xml", "frintz_advsimd.xml",
        "frinti_advsimd.xml", "frint32z_advsimd.xml", "frint64z_advsimd.xml", "frint32x_advsimd.xml",
        "frint64x_advsimd.xml", "fcvtas_advsimd.xml", "fcvtau_advsimd.xml", "fcvtps_advsimd.xml",
        "fcvtpu_advsimd.xml", "fcvtms_advsimd.xml", "fcvtmu_advsimd.xml", "fcvtnu_advsimd.xml",
        "scvtf_advsimd_int.xml", "ucvtf_advsimd_int.xml", "fcvtzs_advsimd_int.xml", "fcvtzu_advsimd_int.xml",
        "fcvtns_advsimd.xml",
    ], advsimdUnaryOperands),
    operandFamily("advsimd-floating-convert-narrow", ["fcvtn_advsimd.xml"], advsimdFloatingConvertNarrowOperands),
    operandFamily("advsimd-floating-convert-long", ["fcvtl_advsimd.xml"], advsimdFloatingConvertLongOperands),
    operandFamily("advsimd-unary-with-immediate", ["scvtf_advsimd_fix.xml", "ucvtf_advsimd_fix.xml", "fcvtzs_advsimd_fix.xml", "fcvtzu_advsimd_fix.xml"], advsimdUnaryWithImmediateOperands),
    operandFamily("advsimd-fp8-convert-long", ["f12cvtl_advsimd.xml", "bf12cvtl_advsimd.xml"], advsimdFp8ConvertLongOperands),
    operandFamily("advsimd-three-same", [
        "uzp1_advsimd.xml", "uzp2_advsimd.xml", "trn1_advsimd.xml", "trn2_advsimd.xml",
        "zip1_advsimd.xml", "zip2_advsimd.xml",
    ], advsimdThreeSameOperands),
    operandFamily("advsimd-table-lookup", ["tbl_advsimd.xml", "tbx_advsimd.xml"], advsimdTableLookupOperands),
    operandFamily("advsimd-fp8-luti", ["luti2_advsimd.xml", "luti4_advsimd.xml"], advsimdFp8LutiOperands),
    operandFamily("advsimd-narrow", [
        "xtn_advsimd.xml", "fcvtxn_advsimd.xml", "bfcvtn_advsimd.xml", "sqxtun_advsimd.xml",
        "sqxtn_advsimd.xml", "uqxtn_advsimd.xml",
    ], advsimdNarrowOperands),
    operandFamily("advsimd-fp8-narrow-pair", ["fcvtn_advsimd_168.xml", "fcvtn_advsimd_328.xml"], advsimdFp8NarrowPairOperands),
    operandFamily("advsimd-shift-left-long", ["shll_advsimd.xml", "sshll_advsimd.xml", "ushll_advsimd.xml"], advsimdShiftLeftLongOperands),
    operandFamily("advsimd-extend-long", ["sxtl_sshll_advsimd.xml", "uxtl_ushll_advsimd.xml"], advsimdExtendLongOperands),
    operandFamily("advsimd-pairwise-long", ["saddlp_advsimd.xml", "uaddlp_advsimd.xml", "sadalp_advsimd.xml", "uadalp_advsimd.xml"], advsimdPairwiseLongOperands),
    operandFamily("advsimd-across-lane", [
        "saddlv_advsimd.xml", "uaddlv_advsimd.xml", "smaxv_advsimd.xml", "sminv_advsimd.xml",
        "umaxv_advsimd.xml", "uminv_advsimd.xml", "addv_advsimd.xml", "fmaxnmv_advsimd.xml",
        "fminnmv_advsimd.xml", "fmaxv_advsimd.xml", "fminv_advsimd.xml",
    ], advsimdAcrossLaneOperands),
    operandFamily("advsimd-widening-three-reg", [
        "saddl_advsimd.xml", "uaddl_advsimd.xml", "ssubl_advsimd.xml", "usubl_advsimd.xml",
        "smull_advsimd_vec.xml", "umull_advsimd_vec.xml", "sabal_advsimd.xml", "uabal_advsimd.xml",
        "sabdl_advsimd.xml", "uabdl_advsimd.xml", "smlal_advsimd_vec.xml", "umlal_advsimd_vec.xml",
        "smlsl_advsimd_vec.xml", "umlsl_advsimd_vec.xml", "sqdmull_advsimd_vec.xml", "sqdmlal_advsimd_vec.xml",
        "sqdmlsl_advsimd_vec.xml",
    ], advsimdWideningThreeRegOperands),
    operandFamily("advsimd-wide-three-reg", ["saddw_advsimd.xml", "uaddw_advsimd.xml", "ssubw_advsimd.xml", "usubw_advsimd.xml"], advsimdWideThreeRegOperands),
    operandFamily("advsimd-immediate-shift", [
        "sshr_advsimd.xml", "ushr_advsimd.xml", "ssra_advsimd.xml", "usra_advsimd.xml",
        "srshr_advsimd.xml", "urshr_advsimd.xml", "srsra_advsimd.xml", "ursra_advsimd.xml",
        "sri_advsimd.xml", "sli_advsimd.xml", "shl_advsimd.xml", "sqshlu_advsimd.xml",
        "sqshl_advsimd_imm.xml", "uqshl_advsimd_imm.xml",
    ], advsimdImmediateShiftOperands),
    operandFamily("advsimd-narrowing-immediate-shift", [
        "shrn_advsimd.xml", "rshrn_advsimd.xml", "sqshrn_advsimd.xml", "uqshrn_advsimd.xml",
        "sqrshrn_advsimd.xml", "uqrshrn_advsimd.xml", "sqshrun_advsimd.xml", "sqrshrun_advsimd.xml",
    ], advsimdNarrowingImmediateShiftOperands),
    operandFamily("advsimd-high-narrow-three-reg", ["addhn_advsimd.xml", "raddhn_advsimd.xml", "rsubhn_advsimd.xml"], advsimdHighNarrowThreeRegOperands),
    operandFamily("advsimd-pmull", ["pmull_advsimd.xml"], advsimdPmullOperands),
    operandFamily("advsimd-move-immediate", [
        "movi_advsimd.xml", "mvni_advsimd.xml", "bic_advsimd_imm.xml", "orr_advsimd_imm.xml",
        "fmov_advsimd.xml",
    ], advsimdMoveImmediateOperands),
    operandFamily("advsimd-move-register-alias", ["mov_orr_advsimd_reg.xml"], advsimdMoveRegisterAliasOperands),
    operandFamily("advsimd-copy-general-to-element", ["ins_advsimd_gen.xml"], advsimdCopyGeneralToElementOperands),
    operandFamily("advsimd-copy-element-to-element", ["ins_advsimd_elt.xml"], advsimdCopyElementToElementOperands),
    operandFamily("advsimd-copy-element-to-general", ["smov_advsimd.xml", "umov_advsimd.xml", "mov_umov_advsimd.xml"], advsimdCopyElementToGeneralOperands),
    operandFamily("advsimd-scalar-duplicate-element", ["dup_advsimd_elt.xml"], advsimdScalarDuplicateElementOperands),
    operandFamily("advsimd-duplicate-general", ["dup_advsimd_gen.xml"], advsimdDuplicateGeneralOperands),
    operandFamily("advsimd-extract", ["ext_advsimd.xml"], advsimdExtractOperands),
    operandFamily("advsimd-single-structure", [
        "ld1r_advsimd.xml", "ld2r_advsimd.xml", "ld3r_advsimd.xml", "ld4r_advsimd.xml",
        "ld1_advsimd_sngl.xml", "ld2_advsimd_sngl.xml", "ld3_advsimd_sngl.xml", "ld4_advsimd_sngl.xml",
        "st1_advsimd_sngl.xml", "st2_advsimd_sngl.xml", "st3_advsimd_sngl.xml", "st4_advsimd_sngl.xml",
        "stl1_advsimd_sngl.xml", "ldap1_advsimd_sngl.xml",
    ], advsimdSingleStructureOperands),
    operandFamily("advsimd-multiple-structure", [
        "ld1_advsimd_mult.xml", "ld2_advsimd_mult.xml", "ld3_advsimd_mult.xml", "ld4_advsimd_mult.xml",
        "st1_advsimd_mult.xml", "st2_advsimd_mult.xml", "st3_advsimd_mult.xml", "st4_advsimd_mult.xml",
    ], advsimdMultipleStructureOperands),
    operandFamily("mova-single-to-vector", ["mov_mova_z_p_rza.xml"], movaSingleToVectorOperands),
    operandFamily("movaz-single-to-vector", ["movaz_z_rza.xml"], movazSingleToVectorOperands),
    operandFamily("mova-vector-to-single", ["mov_mova_za_p_rz.xml"], movaVectorToSingleOperands),
    operandFamily("mova-slice-to-vectors", ["mov_mova_mz2_za.xml"], inst => {
        return movaSliceToVectorsOperands(inst, 2);
    }),
    operandFamily("mova-vectors-to-slice", ["mov_mova_za2_z.xml"], inst => {
        return movaVectorsToSliceOperands(inst, 2);
    }),
    operandFamily("mova-vectors-to-slice-mov-mova-za4-z", ["mov_mova_za4_z.xml"], inst => {
        return movaVectorsToSliceOperands(inst, 4);
    }),
    operandFamily("mova-slice-to-vectors-mov-mova-mz4-za", ["mov_mova_mz4_za.xml"], inst => {
        return movaSliceToVectorsOperands(inst, 4);
    }),
    operandFamily("mova-array-to-vectors", ["mov_mova_mz_za2.xml", "movaz_mz_za2.xml"], inst => {
        return movaArrayToVectorsOperands(inst, 2);
    }),
    operandFamily("mova-array-to-vectors-mov-mova-mz-za4", ["mov_mova_mz_za4.xml", "movaz_mz_za4.xml"], inst => {
        return movaArrayToVectorsOperands(inst, 4);
    }),
    operandFamily("mova-vectors-to-array", ["mov_mova_za_mz2.xml"], inst => {
        return movaVectorsToArrayOperands(inst, 2);
    }),
    operandFamily("mova-vectors-to-array-mov-mova-za-mz4", ["mov_mova_za_mz4.xml"], inst => {
        return movaVectorsToArrayOperands(inst, 4);
    }),
    operandFamily("sme-widening-float-convert", ["fcvt_mz2_z.xml", "fcvtl_mz2_z.xml"], smeWideningFloatConvertOperands),
    operandFamily("sme-fp8-widening-convert", ["f1cvt_mz2_z8.xml", "f1cvtl_mz2_z8.xml", "bf1cvt_mz2_z8.xml", "bf1cvtl_mz2_z8.xml"], smeFp8WideningConvertOperands),
    operandFamily("sme-narrowing-convert", [
        "fcvt_z_mz2.xml", "bfcvt_z_mz2.xml", "fcvtn_z_mz2.xml", "bfcvtn_z_mz2.xml",
        "sqcvt_z_mz2.xml", "sqcvtn_z_mz2.xml", "sqcvtu_z_mz2.xml", "uqcvt_z_mz2.xml",
        "sqcvtun_z_mz2.xml", "uqcvtn_z_mz2.xml", "sqcvt_z_mz4.xml", "sqcvtu_z_mz4.xml",
        "sqcvtun_z_mz4.xml", "uqcvt_z_mz4.xml", "sqcvtn_z_mz4.xml", "uqcvtn_z_mz4.xml",
    ], smeNarrowingConvertOperands),
    operandFamily("sme-narrowing-shift", [
        "sqrshr_z_mz4.xml", "uqrshr_z_mz4.xml", "sqrshru_z_mz4.xml", "sqrshrun_z_mz4.xml",
        "sqrshrn_z_mz4.xml", "uqrshrn_z_mz4.xml",
    ], smeNarrowingShiftOperands),
    operandFamily("sme-fp8-narrow-convert", ["fcvtn_z8_mz2.xml", "fcvtnb_z8_mz2.xml", "fcvtnt_z8_mz2.xml", "bfcvtn_z8_mz2.xml"], smeFp8NarrowConvertOperands),
    operandFamily("sme-fp8-narrowing-convert", ["fcvt_z8_mz2.xml", "fcvt_z8_mz4.xml", "fcvtn_z8_mz4.xml", "bfcvt_z8_mz2.xml"], smeFp8NarrowingConvertOperands),
    operandFamily("sme-zero-base", ["zero_za_i.xml"], smeZeroBaseOperands),
    operandFamily("sme-zero-zt", ["zero_zt_i.xml"], inst => {
        return smeZeroZtOperands();
    }),
    operandFamily("sme-zero-single-vector", ["zero_za1_ri.xml"], smeZeroSingleVectorOperands),
    operandFamily("sme-zero-grouped", ["zero_za2_ri.xml"], inst => {
        return smeZeroGroupedOperands(inst, 2);
    }),
    operandFamily("sme-zero-grouped-zero-za4-ri", ["zero_za4_ri.xml"], inst => {
        return smeZeroGroupedOperands(inst, 4);
    }),
    operandFamily("sme-za-tile-slice", [
        "ld1b_za_p_rrr.xml", "ld1h_za_p_rrr.xml", "ld1w_za_p_rrr.xml", "ld1d_za_p_rrr.xml",
        "ld1q_za_p_rrr.xml", "st1b_za_p_rrr.xml", "st1h_za_p_rrr.xml", "st1w_za_p_rrr.xml",
        "st1d_za_p_rrr.xml", "st1q_za_p_rrr.xml",
    ], smeZaTileSliceOperands),
    operandFamily("sme-ldr-za-array-vector", ["ldr_za_ri.xml", "str_za_ri.xml"], smeLdrZaArrayVectorOperands),
    operandFamily("sme-zt-memory", ["ldr_zt_br.xml", "str_zt_br.xml"], smeZtMemoryOperands),
    operandFamily("sme-multi-vector-arithmetic", ["add_mz_zzv.xml"], smeMultiVectorArithmeticOperands),
    operandFamily("sme-multi-vector-clamp", ["sclamp_mz_zz.xml", "uclamp_mz_zz.xml", "fclamp_mz_zz.xml", "bfclamp_mz_zz.xml"], smeMultiVectorClampOperands),
    operandFamily("sme-int-float-convert", [
        "frinta_mz_z.xml", "frintm_mz_z.xml", "frintn_mz_z.xml", "frintp_mz_z.xml",
        "scvtf_mz_z.xml", "ucvtf_mz_z.xml", "fcvtzs_mz_z.xml", "fcvtzu_mz_z.xml",
    ], smeIntFloatConvertOperands),
    operandFamily("sme-arithmetic", [
        "add_za_zzv.xml", "sub_za_zzv.xml", "smax_mz_zzv.xml", "smin_mz_zzv.xml",
        "umax_mz_zzv.xml", "umin_mz_zzv.xml", "bfmax_mz_zzv.xml", "bfmaxnm_mz_zzv.xml",
        "bfmin_mz_zzv.xml", "bfminnm_mz_zzv.xml", "fmax_mz_zzv.xml", "fmaxnm_mz_zzv.xml",
        "fmin_mz_zzv.xml", "fminnm_mz_zzv.xml", "sqdmulh_mz_zzv.xml", "srshl_mz_zzv.xml",
        "urshl_mz_zzv.xml", "add_za_zw.xml", "sub_za_zw.xml", "add_za_zzw.xml",
        "sub_za_zzw.xml", "smax_mz_zzw.xml", "smin_mz_zzw.xml", "umax_mz_zzw.xml",
        "umin_mz_zzw.xml", "bfmax_mz_zzw.xml", "bfmaxnm_mz_zzw.xml", "bfmin_mz_zzw.xml",
        "bfminnm_mz_zzw.xml", "fmax_mz_zzw.xml", "fmaxnm_mz_zzw.xml", "fmin_mz_zzw.xml",
        "fminnm_mz_zzw.xml", "sqdmulh_mz_zzw.xml", "srshl_mz_zzw.xml", "urshl_mz_zzw.xml",
        "fadd_za_zw.xml", "fsub_za_zw.xml", "bfadd_za_zw.xml", "bfsub_za_zw.xml",
        "fmla_za_zzv.xml", "fmla_za_zzi.xml", "fmla_za_zzw.xml", "fmls_za_zzv.xml",
        "fmls_za_zzi.xml", "fmls_za_zzw.xml", "bfmla_za_zzv.xml", "bfmla_za_zzi.xml",
        "bfmla_za_zzw.xml", "bfmls_za_zzv.xml", "bfmls_za_zzi.xml", "bfmls_za_zzw.xml",
    ], smeArithmeticOperands),
    operandFamily("sme-outer-product", [
        "fmopa_za_pp_zz.xml", "fmops_za_pp_zz.xml", "sumopa_za_pp_zz.xml", "sumops_za_pp_zz.xml",
        "usmopa_za_pp_zz.xml", "usmops_za_pp_zz.xml", "smopa_za_pp_zz.xml", "smopa_za32_pp_zz.xml",
        "smops_za_pp_zz.xml", "smops_za32_pp_zz.xml", "umopa_za_pp_zz.xml", "umopa_za32_pp_zz.xml",
        "umops_za_pp_zz.xml", "umops_za32_pp_zz.xml", "bmopa_za_pp_zz.xml", "bmops_za_pp_zz.xml",
        "bfmopa_za_pp_zz.xml", "bfmops_za_pp_zz.xml", "bfmopa_za32_pp_zz.xml", "bfmops_za32_pp_zz.xml",
        "fmopa_za32_pp_zz.xml", "fmops_za32_pp_zz.xml",
    ], smeOuterProductOperands),
    operandFamily("sme-slice-accumulator", ["addha_za_pp_z.xml", "addva_za_pp_z.xml"], smeSliceAccumulatorOperands),
    operandFamily("sme-fp8-outer-product", ["fmopa_za16_pp_z8z8.xml", "fmopa_za32_pp_z8z8.xml"], smeFp8OuterProductOperands),
    operandFamily("sme-movt-scalar", ["movt_r_zt.xml", "movt_zt_r.xml"], smeMovtScalarOperands),
    operandFamily("sme-movt-zt", ["movt_zt_z.xml"], smeMovtZtOperands),
    operandFamily("sme-permutation", ["zip_mz_zz.xml", "uzp_mz_zz.xml"], smePermutationOperands),
    operandFamily("sme-vector-group-permutation", ["zip_mz_z.xml", "uzp_mz_z.xml"], smeVectorGroupPermutationOperands),
    operandFamily("sme-select", ["sel_mz_p_zz.xml"], smeSelectOperands),
    operandFamily("sme-unpack", ["sunpk_mz_z.xml", "uunpk_mz_z.xml"], smeUnpackOperands),
    operandFamily("sme-luti", ["luti2_z_ztz.xml", "luti4_z_ztz.xml"], inst => {
        return smeLutiOperands(inst, 1);
    }),
    operandFamily("sme-luti-luti2-mz2-ztz", ["luti2_mz2_ztz.xml", "luti4_mz2_ztz.xml"], inst => {
        return smeLutiOperands(inst, 2);
    }),
    operandFamily("sme-luti-luti2-mz4-ztz", ["luti2_mz4_ztz.xml", "luti4_mz4_ztz.xml"], inst => {
        return smeLutiOperands(inst, 4);
    }),
    operandFamily("sme-fp8-luti-mixed", ["luti4_mz4_ztmz2.xml"], smeFp8LutiMixedOperands),
    operandFamily("sme-long-arithmetic", [
        "smlall_za_zzi.xml", "smlall_za_zzv.xml", "smlall_za_zzw.xml", "smlal_za_zzi.xml",
        "smlal_za_zzv.xml", "smlal_za_zzw.xml", "smlsl_za_zzi.xml", "smlsl_za_zzv.xml",
        "smlsl_za_zzw.xml", "smlsll_za_zzi.xml", "smlsll_za_zzv.xml", "smlsll_za_zzw.xml",
        "umlal_za_zzi.xml", "umlal_za_zzv.xml", "umlal_za_zzw.xml", "umlall_za_zzi.xml",
        "umlall_za_zzv.xml", "umlall_za_zzw.xml", "umlsl_za_zzi.xml", "umlsl_za_zzv.xml",
        "umlsl_za_zzw.xml", "umlsll_za_zzi.xml", "umlsll_za_zzv.xml", "umlsll_za_zzw.xml",
        "sumlall_za_zzi.xml", "sumlall_za_zzv.xml", "usmlall_za_zzi.xml", "usmlall_za_zzv.xml",
        "usmlall_za_zzw.xml",
    ], smeLongArithmeticOperands),
    operandFamily("sme-float-long-arithmetic", [
        "bfmlal_za_zzi.xml", "bfmlal_za_zzv.xml", "bfmlal_za_zzw.xml", "bfmlsl_za_zzi.xml",
        "bfmlsl_za_zzv.xml", "bfmlsl_za_zzw.xml", "fmlal_za_zzi.xml", "fmlal_za_zzv.xml",
        "fmlal_za_zzw.xml", "fmlsl_za_zzi.xml", "fmlsl_za_zzv.xml", "fmlsl_za_zzw.xml",
    ], smeFloatLongArithmeticOperands),
    operandFamily("sme-fp8-long-arithmetic", [
        "fmlal_za_z8z8i.xml", "fmlal_za_z8z8v.xml", "fmlal_za_z8z8w.xml", "fmlall_za32_z8z8i.xml",
        "fmlall_za32_z8z8v.xml", "fmlall_za32_z8z8w.xml",
    ], smeFp8LongArithmeticOperands),
    operandFamily("sme-dot", [
        "sdot_za32_zzv.xml", "sdot_za32_zzi.xml", "sdot_za32_zzw.xml", "sdot_za_zzv.xml",
        "sdot_za_zzi.xml", "sdot_za_zzw.xml", "udot_za32_zzv.xml", "udot_za32_zzi.xml",
        "udot_za32_zzw.xml", "udot_za_zzv.xml", "udot_za_zzi.xml", "udot_za_zzw.xml",
        "bfdot_za_zzv.xml", "bfdot_za_zzi.xml", "bfdot_za_zzw.xml", "fdot_za_zzv.xml",
        "fdot_za_zzi.xml", "fdot_za_zzw.xml", "fdot_za_z8z8v.xml", "fdot_za_z8z8i.xml",
        "fdot_za_z8z8w.xml", "fdot_za32_z8z8v.xml", "fdot_za32_z8z8i.xml", "fdot_za32_z8z8w.xml",
        "fvdot_za_z8z8i.xml", "fvdot_za_zzi.xml", "bfvdot_za_zzi.xml", "fvdotb_za32_z8z8i.xml",
        "fvdott_za32_z8z8i.xml", "svdot_za_zzi.xml", "svdot_za32_zzi.xml", "sudot_za_zzv.xml",
        "sudot_za_zzi.xml", "suvdot_za_zzi.xml", "uvdot_za_zzi.xml", "uvdot_za32_zzi.xml",
        "usdot_za_zzv.xml", "usdot_za_zzi.xml", "usvdot_za_zzi.xml", "usdot_za_zzw.xml",
    ], smeDotOperands),
    operandFamily("sve-compare-immediate", ["cmpeq_p_p_zi.xml"], sveCompareImmediateOperands),
    operandFamily("sve-floating-compare-immediate", ["fcmeq_p_p_z0.xml"], sveFloatingCompareImmediateOperands),
    operandFamily("sve-compare-vector", [
        "cmpeq_p_p_zz.xml", "fcmeq_p_p_zz.xml", "facge_p_p_zz.xml", "match_p_p_zz.xml",
        "nmatch_p_p_zz.xml",
    ], sveCompareVectorOperands),
    operandFamily("sve-histcnt", ["histcnt_z_p_zz.xml"], sveHistcntOperands),
    operandFamily("sve-compare-wide-vector", ["cmpeq_p_p_zw.xml"], sveCompareWideVectorOperands),
    operandFamily("sve-ptrue", ["ptrue_p_s.xml", "ptrues_p_s.xml"], svePtrueOperands),
    operandFamily("sve-ptrue-predicate-counter", ["ptrue_pn_i.xml"], svePtruePredicateCounterOperands),
    operandFamily("sve-predicate-break", ["brka_p_p_p.xml", "brkas_p_p_p.xml", "brkb_p_p_p.xml", "brkbs_p_p_p.xml"], svePredicateBreakOperands),
    operandFamily("sve-predicate-break-propagation", ["brkn_p_p_pp.xml", "brkns_p_p_pp.xml"], svePredicateBreakPropagationOperands),
    operandFamily("sve-predicate-break-pair", ["brkpa_p_p_pp.xml", "brkpas_p_p_pp.xml", "brkpb_p_p_pp.xml", "brkpbs_p_p_pp.xml"], svePredicateBreakPairOperands),
    operandFamily("sve-predicate-flow", ["pfirst_p_p_p.xml", "pnext_p_p_p.xml"], svePredicateFlowOperands),
    operandFamily("sve-predicate-test", ["ptest_p_p.xml"], svePredicateTestOperands),
    operandFamily("sve-rdffr", ["rdffr_p_f.xml", "rdffr_p_p_f.xml", "rdffrs_p_p_f.xml"], sveRdffrOperands),
    operandFamily("sve-predicate-control", ["pfalse_p.xml", "punpkhi_p_p.xml", "wrffr_f_p.xml"], svePredicateControlOperands),
    operandFamily("sve-terminate-condition", ["ctermeq_rr.xml"], sveTerminateConditionOperands),
    operandFamily("sve-predicate-logical", [
        "and_p_p_pp.xml", "mov_and_p_p_pp.xml", "ands_p_p_pp.xml", "movs_ands_p_p_pp.xml",
        "orn_p_p_pp.xml", "orns_p_p_pp.xml", "orr_p_p_pp.xml", "mov_orr_p_p_pp.xml",
        "orrs_p_p_pp.xml", "movs_orrs_p_p_pp.xml", "eor_p_p_pp.xml", "eors_p_p_pp.xml",
        "nots_eors_p_p_pp.xml", "bic_p_p_pp.xml", "nand_p_p_pp.xml", "nor_p_p_pp.xml",
        "bics_p_p_pp.xml", "nands_p_p_pp.xml", "nors_p_p_pp.xml",
    ], svePredicateLogicalOperands),
    operandFamily("sve-predicate-permutation", ["zip1_p_pp.xml", "uzp1_p_pp.xml", "trn1_p_pp.xml"], svePredicatePermutationOperands),
    operandFamily("sve-index", ["index_z_ii.xml", "index_z_ir.xml", "index_z_ri.xml", "index_z_rr.xml"], sveIndexOperands),
    operandFamily("sve-insr", ["insr_z_r.xml", "insr_z_v.xml"], sveInsrOperands),
    operandFamily("sve-last-extract", [
        "lasta_r_p_z.xml", "lasta_v_p_z.xml", "lastb_r_p_z.xml", "lastb_v_p_z.xml",
        "clasta_r_p_z.xml", "clasta_v_p_z.xml", "clasta_z_p_zz.xml", "clastb_r_p_z.xml",
        "clastb_v_p_z.xml", "clastb_z_p_zz.xml",
    ], sveLastExtractOperands),
    operandFamily("sve-predicated-unary", [
        "frinta_z_p_z.xml", "cls_z_p_z.xml", "clz_z_p_z.xml", "cnot_z_p_z.xml",
        "cnt_z_p_z.xml", "fabs_z_p_z.xml", "fneg_z_p_z.xml", "frecpx_z_p_z.xml",
        "fsqrt_z_p_z.xml", "not_z_p_z.xml", "rbit_z_p_z.xml", "sxtb_z_p_z.xml",
        "uxtb_z_p_z.xml", "revb_z_z.xml", "flogb_z_p_z.xml", "urecpe_z_p_z.xml",
        "ursqrte_z_p_z.xml", "abs_z_p_z.xml", "neg_z_p_z.xml", "sqabs_z_p_z.xml",
        "sqneg_z_p_z.xml",
    ], svePredicatedUnaryOperands),
    operandFamily("sve-revd", ["revd_z_p_z.xml"], sveRevdOperands),
    operandFamily("sve-predicated-narrowing-conversion", ["fcvtlt_z_p_z.xml", "fcvtnt_z_p_z.xml", "fcvtx_z_p_z.xml", "fcvtxnt_z_p_z.xml"], svePredicatedNarrowingConversionOperands),
    operandFamily("sve-bfloat16-conversion", ["bfcvt_z_p_z.xml", "bfcvtnt_z_p_z.xml"], sveBfloat16ConversionOperands),
    operandFamily("sve-predicated-binary", [
        "add_z_p_zz.xml", "addpt_z_p_zz.xml", "addp_z_p_zz.xml", "sub_z_p_zz.xml",
        "subpt_z_p_zz.xml", "subr_z_p_zz.xml", "shadd_z_p_zz.xml", "uhadd_z_p_zz.xml",
        "shsub_z_p_zz.xml", "uhsub_z_p_zz.xml", "bfadd_z_p_zz.xml", "fabd_z_p_zz.xml",
        "fdivr_z_p_zz.xml", "fmulx_z_p_zz.xml", "fscale_z_p_zz.xml", "bfmul_z_p_zz.xml",
        "faddp_z_p_zz.xml", "bfmax_z_p_zz.xml", "bfmaxnm_z_p_zz.xml", "bfmin_z_p_zz.xml",
        "bfminnm_z_p_zz.xml", "and_z_p_zz.xml", "orr_z_p_zz.xml", "eor_z_p_zz.xml",
        "bic_z_p_zz.xml", "asr_z_p_zz.xml", "asrr_z_p_zz.xml", "lsl_z_p_zz.xml",
        "lslr_z_p_zz.xml", "lsr_z_p_zz.xml", "lsrr_z_p_zz.xml", "sqshl_z_p_zz.xml",
        "uqshl_z_p_zz.xml", "sqrshl_z_p_zz.xml", "uqrshl_z_p_zz.xml", "sabd_z_p_zz.xml",
        "uabd_z_p_zz.xml", "sqadd_z_p_zz.xml", "uqadd_z_p_zz.xml", "sqsub_z_p_zz.xml",
        "uqsub_z_p_zz.xml", "suqadd_z_p_zz.xml", "usqadd_z_p_zz.xml", "sqsubr_z_p_zz.xml",
        "uqsubr_z_p_zz.xml", "srshl_z_p_zz.xml", "urshl_z_p_zz.xml", "srshlr_z_p_zz.xml",
        "urshlr_z_p_zz.xml", "sqshlr_z_p_zz.xml", "uqshlr_z_p_zz.xml", "sqrshlr_z_p_zz.xml",
        "uqrshlr_z_p_zz.xml", "srhadd_z_p_zz.xml", "urhadd_z_p_zz.xml", "shsubr_z_p_zz.xml",
        "uhsubr_z_p_zz.xml", "mul_z_p_zz.xml", "sdiv_z_p_zz.xml", "sdivr_z_p_zz.xml",
        "smax_z_p_zz.xml", "smin_z_p_zz.xml", "smulh_z_p_zz.xml", "udiv_z_p_zz.xml",
        "udivr_z_p_zz.xml", "umax_z_p_zz.xml", "umin_z_p_zz.xml", "umulh_z_p_zz.xml",
        "smaxp_z_p_zz.xml", "sminp_z_p_zz.xml", "umaxp_z_p_zz.xml", "uminp_z_p_zz.xml",
        "fmaxp_z_p_zz.xml", "fmaxnmp_z_p_zz.xml", "fminp_z_p_zz.xml", "fminnmp_z_p_zz.xml",
        "fadd_z_p_zz.xml", "fsub_z_p_zz.xml", "fsubr_z_p_zz.xml", "fdiv_z_p_zz.xml",
        "fmax_z_p_zz.xml", "fmaxnm_z_p_zz.xml", "fmin_z_p_zz.xml", "fminnm_z_p_zz.xml",
        "famin_z_p_zz.xml", "famax_z_p_zz.xml", "fmul_z_p_zz.xml",
    ], svePredicatedBinaryOperands),
    operandFamily("sve-binary", [
        "add_z_zz.xml", "addpt_z_zz.xml", "mul_z_zz.xml", "sqdmulh_z_zz.xml",
        "sqrdmulh_z_zz.xml", "pmul_z_zz.xml", "sqadd_z_zz.xml", "sub_z_zz.xml",
        "subpt_z_zz.xml", "sqsub_z_zz.xml", "and_z_zz.xml", "orr_z_zz.xml",
        "mov_orr_z_zz.xml", "eor_z_zz.xml", "bic_z_zz.xml", "uqadd_z_zz.xml",
        "uqsub_z_zz.xml", "bfadd_z_zz.xml", "fadd_z_zz.xml", "bfmul_z_zz.xml",
        "bfclamp_z_zz.xml", "fclamp_z_zz.xml", "fsub_z_zz.xml", "frecps_z_zz.xml",
        "frsqrts_z_zz.xml", "ftsmul_z_zz.xml", "ftssel_z_zz.xml", "sclamp_z_zz.xml",
        "uclamp_z_zz.xml", "tbx_z_zz.xml", "bdep_z_zz.xml", "bext_z_zz.xml",
        "bgrp_z_zz.xml", "histseg_z_zz.xml", "eorbt_z_zz.xml", "eortb_z_zz.xml",
        "smulh_z_zz.xml", "umulh_z_zz.xml", "fmul_z_zz.xml",
    ], sveBinaryOperands),
    operandFamily("sve-predicate-as-counter", ["madpt_z_zzz.xml", "mlapt_z_zzz.xml"], svePredicateAsCounterOperands),
    operandFamily("sve-destructive-binary", ["aese_z_zz.xml", "aesd_z_zz.xml", "sm4e_z_zz.xml"], inst => {
        const encoding = inst.encoding;
        return sveDestructiveBinaryOperands(inst, inst.encoding.fileName.startsWith("sm4") ? "s" : "b");
    }),
    operandFamily("aesmc-z-z", ["aesmc_z_z.xml", "aesimc_z_z.xml"], inst => {
        return [vecReg(inst.fields.Zdn ?? 0, "b"), vecReg(inst.fields.Zdn ?? 0, "b")];
    }),
    operandFamily("sm4ekey-z-zz", ["sm4ekey_z_zz.xml"], inst => {
        return [vecReg(inst.fields.Zd ?? 0, "s"), vecReg(inst.fields.Zn ?? 0, "s"), vecReg(inst.fields.Zm ?? 0, "s")];
    }),
    operandFamily("sve-destructive-ternary", [
        "bsl_z_zzz.xml", "bsl1n_z_zzz.xml", "bsl2n_z_zzz.xml", "nbsl_z_zzz.xml",
        "bcax_z_zzz.xml", "eor3_z_zzz.xml",
    ], inst => {
        return sveDestructiveTernaryOperands(inst, "d");
    }),
    operandFamily("sve-logical-immediate", [
        "and_z_zi.xml", "bic_and_z_zi.xml", "orr_z_zi.xml", "orn_orr_z_zi.xml",
        "eor_z_zi.xml", "eon_eor_z_zi.xml",
    ], sveLogicalImmediateOperands),
    operandFamily("sve-dup-mask-immediate", ["dupm_z_i.xml", "mov_dupm_z_i.xml"], sveDupMaskImmediateOperands),
    operandFamily("sve-dup-scalar", ["dup_z_r.xml", "mov_dup_z_r.xml"], sveDupScalarOperands),
    operandFamily("sve-select-predicate", ["sel_p_p_pp.xml", "mov_sel_p_p_pp.xml"], sveSelectPredicateOperands),
    operandFamily("sme-predicate-select", ["psel_p_ppi.xml"], smePredicateSelectOperands),
    operandFamily("sve-select-vector", ["sel_z_p_zz.xml", "mov_sel_z_p_zz.xml"], sveSelectVectorOperands),
    operandFamily("sve-destructive-immediate", [
        "add_z_zi.xml", "mul_z_zi.xml", "smax_z_zi.xml", "smin_z_zi.xml",
        "umax_z_zi.xml", "umin_z_zi.xml", "sqadd_z_zi.xml", "sub_z_zi.xml",
        "sqsub_z_zi.xml", "subr_z_zi.xml", "uqadd_z_zi.xml", "uqsub_z_zi.xml",
    ], sveDestructiveImmediateOperands),
    operandFamily("sve-binary-indexed", ["mul_z_zzi.xml", "sqdmulh_z_zzi.xml", "sqrdmulh_z_zzi.xml"], sveBinaryIndexedOperands),
    operandFamily("sve-xar", ["xar_z_zzi.xml"], sveXarOperands),
    operandFamily("sve-shift-insert-immediate", [
        "asr_z_zi.xml", "lsl_z_zi.xml", "lsr_z_zi.xml", "sli_z_zzi.xml",
        "sri_z_zzi.xml",
    ], sveShiftInsertImmediateOperands),
    operandFamily("sve-shift-immediate", [
        "sqshl_z_p_zi.xml", "uqshl_z_p_zi.xml", "sqshlu_z_p_zi.xml", "srshr_z_p_zi.xml",
        "urshr_z_p_zi.xml", "asr_z_p_zi.xml", "asrd_z_p_zi.xml", "lsl_z_p_zi.xml",
        "lsr_z_p_zi.xml", "sshllb_z_zi.xml", "sshllt_z_zi.xml", "ushllb_z_zi.xml",
        "ushllt_z_zi.xml",
    ], sveShiftImmediateOperands),
    operandFamily("sve-narrowing-shift-immediate", [
        "sqshrnb_z_zi.xml", "sqshrnt_z_zi.xml", "sqshrunb_z_zi.xml", "sqshrunt_z_zi.xml",
        "uqshrnb_z_zi.xml", "uqshrnt_z_zi.xml", "shrnb_z_zi.xml", "shrnt_z_zi.xml",
        "rshrnb_z_zi.xml", "rshrnt_z_zi.xml", "sqrshrnb_z_zi.xml", "sqrshrnt_z_zi.xml",
        "sqrshrunb_z_zi.xml", "sqrshrunt_z_zi.xml", "uqrshrnb_z_zi.xml", "uqrshrnt_z_zi.xml",
    ], sveNarrowingShiftImmediateOperands),
    operandFamily("sve-narrowing-extract", [
        "sqxtnb_z_zz.xml", "sqxtnt_z_zz.xml", "sqxtunb_z_zz.xml", "sqxtunt_z_zz.xml",
        "uqxtnb_z_zz.xml", "uqxtnt_z_zz.xml",
    ], sveNarrowingExtractOperands),
    operandFamily("sve-long-multiply", [
        "sabalb_z_zzz.xml", "sabalt_z_zzz.xml", "uabalb_z_zzz.xml", "uabalt_z_zzz.xml",
        "smlalb_z_zzz.xml", "smlalt_z_zzz.xml", "smlslb_z_zzz.xml", "smlslt_z_zzz.xml",
        "sqdmlalb_z_zzz.xml", "sqdmlalbt_z_zzz.xml", "sqdmlalt_z_zzz.xml", "sqdmlslb_z_zzz.xml",
        "sqdmlslbt_z_zzz.xml", "sqdmlslt_z_zzz.xml", "umlalb_z_zzz.xml", "umlalt_z_zzz.xml",
        "umlslb_z_zzz.xml", "umlslt_z_zzz.xml", "smullb_z_zz.xml", "smullt_z_zz.xml",
        "sqdmullb_z_zz.xml", "sqdmullt_z_zz.xml", "umullb_z_zz.xml", "umullt_z_zz.xml",
    ], sveLongMultiplyOperands),
    operandFamily("sve-widening-binary", [
        "saddlb_z_zz.xml", "saddlt_z_zz.xml", "saddlbt_z_zz.xml", "uaddlb_z_zz.xml",
        "uaddlt_z_zz.xml", "saddwb_z_zz.xml", "saddwt_z_zz.xml", "ssublb_z_zz.xml",
        "ssublt_z_zz.xml", "ssublbt_z_zz.xml", "ssubltb_z_zz.xml", "ssubwb_z_zz.xml",
        "ssubwt_z_zz.xml", "usublb_z_zz.xml", "usublt_z_zz.xml", "sabdlb_z_zz.xml",
        "sabdlt_z_zz.xml", "uabdlb_z_zz.xml", "uabdlt_z_zz.xml", "uaddwb_z_zz.xml",
        "uaddwt_z_zz.xml", "usubwb_z_zz.xml", "usubwt_z_zz.xml",
    ], sveWideningBinaryOperands),
    operandFamily("sve-narrowing-binary", [
        "addhnb_z_zz.xml", "addhnt_z_zz.xml", "subhnb_z_zz.xml", "subhnt_z_zz.xml",
        "raddhnb_z_zz.xml", "raddhnt_z_zz.xml", "rsubhnb_z_zz.xml", "rsubhnt_z_zz.xml",
    ], sveNarrowingBinaryOperands),
    operandFamily("sve-accumulate-shift-immediate", ["ssra_z_zi.xml", "usra_z_zi.xml", "srsra_z_zi.xml", "ursra_z_zi.xml"], sveAccumulateShiftImmediateOperands),
    operandFamily("sve-horizontal-reduction", [
        "saddv_r_p_z.xml", "uaddv_r_p_z.xml", "smaxv_r_p_z.xml", "umaxv_r_p_z.xml",
        "sminv_r_p_z.xml", "uminv_r_p_z.xml", "orv_r_p_z.xml", "eorv_r_p_z.xml",
        "andv_r_p_z.xml", "faddv_v_p_z.xml", "fmaxnmv_v_p_z.xml", "fminnmv_v_p_z.xml",
        "fmaxv_v_p_z.xml", "fminv_v_p_z.xml",
    ], sveHorizontalReductionOperands),
    operandFamily("sve-floating-reduction", ["fadda_v_p_z.xml"], sveFloatingReductionOperands),
    operandFamily("sve-qvector-reduction", [
        "addqv_z_p_z.xml", "andqv_z_p_z.xml", "eorqv_z_p_z.xml", "orqv_z_p_z.xml",
        "smaxqv_z_p_z.xml", "sminqv_z_p_z.xml", "umaxqv_z_p_z.xml", "uminqv_z_p_z.xml",
        "faddqv_z_p_z.xml", "fmaxqv_z_p_z.xml", "fmaxnmqv_z_p_z.xml", "fminqv_z_p_z.xml",
        "fminnmqv_z_p_z.xml",
    ], sveQVectorReductionOperands),
    operandFamily("sve-wide-shift", [
        "asr_z_zw.xml", "lsl_z_zw.xml", "lsr_z_zw.xml", "asr_z_p_zw.xml",
        "lsl_z_p_zw.xml", "lsr_z_p_zw.xml",
    ], sveWideShiftOperands),
    operandFamily("sve-adr-vector", ["adr_z_az.xml"], sveAdrVectorOperands),
    operandFamily("sve-ext", ["ext_z_zi.xml", "extq_z_zi.xml"], sveExtOperands),
    operandFamily("sve-splice", ["splice_z_p_zz.xml"], sveSpliceOperands),
    operandFamily("sve-bf-sub", ["bfsub_z_p_zz.xml", "bfsub_z_zz.xml"], sveBfSubOperands),
    operandFamily("sve-fcadd", ["fcadd_z_p_zz.xml"], sveFcaddOperands),
    operandFamily("sve-cadd-like", ["cadd_z_zz.xml", "sqcadd_z_zz.xml"], sveCaddLikeOperands),
    operandFamily("rax1-z-zz", ["rax1_z_zz.xml"], inst => {
        return [vecReg(inst.fields.Zd ?? 0, "d"), vecReg(inst.fields.Zn ?? 0, "d"), vecReg(inst.fields.Zm ?? 0, "d")];
    }),
    operandFamily("sve-carry-long", ["adclb_z_zzz.xml", "adclt_z_zzz.xml", "sbclb_z_zzz.xml", "sbclt_z_zzz.xml"], sveCarryLongOperands),
    operandFamily("sve-complex-vector", ["cmla_z_zzz.xml", "sqrdcmlah_z_zzz.xml"], sveComplexVectorOperands),
    operandFamily("sve-long-multiply-indexed", [
        "smullb_z_zzi.xml", "smullt_z_zzi.xml", "sqdmullb_z_zzi.xml", "sqdmullt_z_zzi.xml",
        "umullb_z_zzi.xml", "umullt_z_zzi.xml", "smlalb_z_zzzi.xml", "smlalt_z_zzzi.xml",
        "smlslb_z_zzzi.xml", "smlslt_z_zzzi.xml", "sqdmlalb_z_zzzi.xml", "sqdmlalt_z_zzzi.xml",
        "sqdmlslb_z_zzzi.xml", "sqdmlslt_z_zzzi.xml", "umlalb_z_zzzi.xml", "umlalt_z_zzzi.xml",
        "umlslb_z_zzzi.xml", "umlslt_z_zzzi.xml",
    ], sveLongMultiplyIndexedOperands),
    operandFamily("sve-multiply-accumulate", [
        "sqrdmlah_z_zzz.xml", "sqrdmlsh_z_zzz.xml", "saba_z_zzz.xml", "uaba_z_zzz.xml",
        "mad_z_p_zzz.xml", "mla_z_p_zzz.xml", "mls_z_p_zzz.xml", "msb_z_p_zzz.xml",
    ], sveMultiplyAccumulateOperands),
    operandFamily("sve-fcmla-predicated", ["fcmla_z_p_zzz.xml"], sveFcmlaPredicatedOperands),
    operandFamily("sve-complex-indexed", ["cmla_z_zzzi.xml", "fcmla_z_zzzi.xml", "sqrdcmlah_z_zzzi.xml"], sveComplexIndexedOperands),
    operandFamily("sve-fp-multiply-accumulate", [
        "mla_z_zzzi.xml", "mls_z_zzzi.xml", "sqrdmlah_z_zzzi.xml", "sqrdmlsh_z_zzzi.xml",
        "bfmla_z_p_zzz.xml", "bfmla_z_zzzi.xml", "fmla_z_p_zzz.xml", "fmla_z_zzzi.xml",
        "fmls_z_p_zzz.xml", "fmls_z_zzzi.xml", "fnmla_z_p_zzz.xml", "fnmls_z_p_zzz.xml",
    ], sveFpMultiplyAccumulateOperands),
    operandFamily("sve-bfmlal", [
        "bfmlalb_z_zzz.xml", "bfmlslb_z_zzz.xml", "bfmlalt_z_zzz.xml", "bfmlslt_z_zzz.xml",
        "bfmlalb_z_zzzi.xml", "bfmlslb_z_zzzi.xml", "bfmlalt_z_zzzi.xml", "bfmlslt_z_zzzi.xml",
    ], sveBfmlalOperands),
    operandFamily("sve-fmlal-long", [
        "fmlalb_z_zzz.xml", "fmlalt_z_zzz.xml", "fmlslb_z_zzz.xml", "fmlslt_z_zzz.xml",
        "fmlalb_z_zzzi.xml", "fmlalt_z_zzzi.xml", "fmlslb_z_zzzi.xml", "fmlslt_z_zzzi.xml",
    ], sveFmlalLongOperands),
    operandFamily("sve-bfmls", ["bfmls_z_p_zzz.xml", "bfmls_z_zzzi.xml"], sveBfmlsOperands),
    operandFamily("sve-fp-add-sub-immediate", [
        "fadd_z_p_zs.xml", "fsub_z_p_zs.xml", "fmax_z_p_zs.xml", "fmaxnm_z_p_zs.xml",
        "fmin_z_p_zs.xml", "fminnm_z_p_zs.xml", "fsubr_z_p_zs.xml",
    ], sveFpAddSubImmediateOperands),
    operandFamily("sve-contiguous-byte-memory", [
        "ld1b_z_p_ai.xml", "ld1b_z_p_bz.xml", "ld1h_z_p_ai.xml", "ld1h_z_p_bz.xml",
        "ld1w_z_p_ai.xml", "ld1w_z_p_bz.xml", "ld1d_z_p_ai.xml", "ld1d_z_p_bz.xml",
        "ld1sb_z_p_ai.xml", "ld1sb_z_p_bz.xml", "ld1sh_z_p_ai.xml", "ld1sh_z_p_bz.xml",
        "ld1sw_z_p_ai.xml", "ld1sw_z_p_bz.xml", "st1b_z_p_ai.xml", "st1b_z_p_bz.xml",
        "st1h_z_p_ai.xml", "st1h_z_p_bz.xml", "st1w_z_p_ai.xml", "st1w_z_p_bz.xml",
        "st1d_z_p_ai.xml", "st1d_z_p_bz.xml",
    ], sveContiguousByteMemoryOperands),
    operandFamily("sve-replicate-load", [
        "ld1rb_z_p_bi.xml", "ld1rh_z_p_bi.xml", "ld1rw_z_p_bi.xml", "ld1rd_z_p_bi.xml",
        "ld1rsb_z_p_bi.xml", "ld1rsh_z_p_bi.xml", "ld1rsw_z_p_bi.xml", "ld1rqb_z_p_bi.xml",
        "ld1rqh_z_p_bi.xml", "ld1rqw_z_p_bi.xml", "ld1rqd_z_p_bi.xml", "ld1rqb_z_p_br.xml",
        "ld1rqh_z_p_br.xml", "ld1rqw_z_p_br.xml", "ld1rqd_z_p_br.xml", "ld1rob_z_p_bi.xml",
        "ld1roh_z_p_bi.xml", "ld1row_z_p_bi.xml", "ld1rod_z_p_bi.xml", "ld1rob_z_p_br.xml",
        "ld1roh_z_p_br.xml", "ld1row_z_p_br.xml", "ld1rod_z_p_br.xml",
    ], sveReplicateLoadOperands),
    operandFamily("sve-fmul-immediate", ["fmul_z_p_zs.xml"], sveFmulImmediateOperands),
    operandFamily("sve-fmul-indexed", ["bfmul_z_zzi.xml", "fmul_z_zzi.xml"], sveFmulIndexedOperands),
    operandFamily("sve-fmad", ["fmad_z_p_zzz.xml", "fmsb_z_p_zzz.xml", "fnmad_z_p_zzz.xml", "fnmsb_z_p_zzz.xml"], sveFmadOperands),
    operandFamily("sve-ftmad", ["ftmad_z_zzi.xml"], sveFtmadOperands),
    operandFamily("sve-predicated-pairwise-long-accumulate", ["sadalp_z_p_z.xml", "uadalp_z_p_z.xml"], svePredicatedPairwiseLongAccumulateOperands),
    operandFamily("fexpa-z-z", [
        "fexpa_z_z.xml", "frecpe_z_z.xml", "frsqrte_z_z.xml", "sunpkhi_z_z.xml",
        "uunpkhi_z_z.xml",
    ], inst => {
        const encoding = inst.encoding;
        return inst.encoding.mnemonic.endsWith("UNPKHI") || inst.encoding.mnemonic.endsWith("UNPKLO")
            ? sveUnpackOperands(inst)
            : sveUnaryPermutationOperands(inst);
    }),
    operandFamily("sdot-z-zzz", [
        "sdot_z_zzz.xml", "sdot_z_zzzi.xml", "sdot_z32_zzz.xml", "sdot_z32_zzzi.xml",
        "udot_z_zzz.xml", "udot_z_zzzi.xml", "udot_z32_zzz.xml", "udot_z32_zzzi.xml",
        "bfdot_z_zzz.xml", "bfdot_z_zzzi.xml", "fdot_z_zzz.xml", "fdot_z_zzzi.xml",
        "fdot_z_zz8z8.xml", "fdot_z_zz8z8i.xml", "fdot_z32_zz8z8.xml", "fdot_z32_zz8z8i.xml",
        "usdot_z_zzz.xml", "usdot_z_zzzi.xml", "sudot_z_zzzi.xml", "cdot_z_zzz.xml",
        "cdot_z_zzzi.xml", "fmlalb_z_z8z8z8.xml", "fmlalb_z_z8z8z8i.xml", "fmlalt_z_z8z8z8.xml",
        "fmlalt_z_z8z8z8i.xml", "fmlallbb_z32_z8z8z8.xml", "fmlallbb_z32_z8z8z8i.xml", "fmlallbt_z32_z8z8z8.xml",
        "fmlallbt_z32_z8z8z8i.xml", "fmlalltb_z32_z8z8z8.xml", "fmlalltb_z32_z8z8z8i.xml", "fmlalltt_z32_z8z8z8.xml",
        "fmlalltt_z32_z8z8z8i.xml",
    ], inst => {
        const encoding = inst.encoding;
        return inst.encoding.fileName.startsWith("cdot_") ? sveCdotOperands(inst) : sveDotProductOperands(inst);
    }),
    operandFamily("sve-pmull", ["pmullb_z_zz.xml", "pmullt_z_zz.xml"], svePmullOperands),
    operandFamily("sve-matrix-multiply", [
        "fmmla_z_zzz.xml", "bfmmla_z_zzz.xml", "bfmmla_z16_zzz.xml", "smmla_z_zzz.xml",
        "ummla_z_zzz.xml", "usmmla_z_zzz.xml",
    ], sveMatrixMultiplyOperands),
    operandFamily("sve-permutation", ["zip1_z_zz.xml", "uzp1_z_zz.xml", "trn1_z_zz.xml"], svePermutationOperands),
    operandFamily("sve-table-lookup", ["tbl_z_zz.xml"], sveTableLookupOperands),
    operandFamily("sve-fp8-luti", ["luti2_z_zz.xml", "luti4_z_zz.xml"], sveFp8LutiOperands),
    operandFamily("sve-qvector-permute", [
        "tblq_z_zz.xml", "tbxq_z_zz.xml", "zipq1_z_zz.xml", "zipq2_z_zz.xml",
        "uzpq1_z_zz.xml", "uzpq2_z_zz.xml",
    ], sveQVectorPermuteOperands),
    operandFamily("sve-dupq-indexed", ["dupq_z_zi.xml"], sveDupqIndexedOperands),
    operandFamily("sve-unary-permutation", ["rev_z_z.xml"], sveUnaryPermutationOperands),
    operandFamily("sve-compact", ["compact_z_p_z.xml"], sveCompactOperands),
    operandFamily("sve-fp8-convert", ["f1cvt_z_z8.xml", "bf1cvt_z_z8.xml", "f1cvtlt_z_z8.xml", "bf1cvtlt_z_z8.xml"], sveFp8ConvertOperands),
    operandFamily("sve-scalar-immediate-prefetch", [
        "prfb_i_p_bi.xml", "prfb_i_p_ai.xml", "prfb_i_p_bz.xml", "prfd_i_p_bi.xml",
        "prfd_i_p_ai.xml", "prfd_i_p_bz.xml", "prfh_i_p_bi.xml", "prfh_i_p_ai.xml",
        "prfh_i_p_bz.xml", "prfw_i_p_bi.xml", "prfw_i_p_ai.xml", "prfw_i_p_bz.xml",
    ], sveScalarImmediatePrefetchOperands),
    operandFamily("sve-predicate-memory", ["ldr_p_bi.xml", "ldr_z_bi.xml", "str_p_bi.xml", "str_z_bi.xml"], svePredicateMemoryOperands),
    operandFamily("sve-inc-dec-scalar", [
        "cntb_r_s.xml", "incb_r_rs.xml", "decb_r_rs.xml", "sqincb_r_rs.xml",
        "sqincd_r_rs.xml", "sqinch_r_rs.xml", "sqincw_r_rs.xml", "uqincb_r_rs.xml",
        "uqincd_r_rs.xml", "uqinch_r_rs.xml", "uqincw_r_rs.xml", "sqdecb_r_rs.xml",
        "sqdecd_r_rs.xml", "sqdech_r_rs.xml", "sqdecw_r_rs.xml", "uqdecb_r_rs.xml",
        "uqdecd_r_rs.xml", "uqdech_r_rs.xml", "uqdecw_r_rs.xml",
    ], sveIncDecScalarOperands),
    operandFamily("sve-inc-dec-predicate-scalar", [
        "sqincp_r_p_r.xml", "uqincp_r_p_r.xml", "sqdecp_r_p_r.xml", "uqdecp_r_p_r.xml",
        "incp_r_p_r.xml", "decp_r_p_r.xml",
    ], sveIncDecPredicateScalarOperands),
    operandFamily("sve-count-predicate", ["cntp_r_p_p.xml", "cntp_r_pn.xml"], sveCountPredicateOperands),
    operandFamily("sve-inc-dec-vector", [
        "incd_z_zs.xml", "sqincd_z_zs.xml", "sqinch_z_zs.xml", "sqincw_z_zs.xml",
        "uqincd_z_zs.xml", "uqinch_z_zs.xml", "uqincw_z_zs.xml", "sqdecd_z_zs.xml",
        "sqdech_z_zs.xml", "sqdecw_z_zs.xml", "uqdecd_z_zs.xml", "uqdech_z_zs.xml",
        "uqdecw_z_zs.xml",
    ], sveIncDecVectorOperands),
    operandFamily("sve-inc-dec-predicate-vector", [
        "sqincp_z_p_z.xml", "uqincp_z_p_z.xml", "sqdecp_z_p_z.xml", "uqdecp_z_p_z.xml",
        "incp_z_p_z.xml", "decp_z_p_z.xml",
    ], sveIncDecPredicateVectorOperands),
    operandFamily("sve-while-compare", [
        "whilege_p_p_rr.xml", "whilegt_p_p_rr.xml", "whilehi_p_p_rr.xml", "whilehs_p_p_rr.xml",
        "whilele_p_p_rr.xml", "whilelo_p_p_rr.xml", "whilels_p_p_rr.xml", "whilelt_p_p_rr.xml",
        "whilege_pp_rr.xml", "whilegt_pp_rr.xml", "whilehi_pp_rr.xml", "whilehs_pp_rr.xml",
        "whilele_pp_rr.xml", "whilelo_pp_rr.xml", "whilels_pp_rr.xml", "whilelt_pp_rr.xml",
        "whilege_pn_rr.xml", "whilegt_pn_rr.xml", "whilehi_pn_rr.xml", "whilehs_pn_rr.xml",
        "whilele_pn_rr.xml", "whilelo_pn_rr.xml", "whilels_pn_rr.xml", "whilelt_pn_rr.xml",
        "whilewr_p_rr.xml", "whilerw_p_rr.xml",
    ], sveWhileCompareOperands),
    operandFamily("mte-insert-random-tag", ["irg.xml"], mteInsertRandomTagOperands),
    operandFamily("mte-add-sub-tag", ["addg.xml", "subg.xml"], mteAddSubTagOperands),
    operandFamily("mte-tag-mask-insert", ["gmi.xml"], mteTagMaskInsertOperands),
    operandFamily("mte-tag-store", ["stg.xml", "stzg.xml", "st2g.xml", "stz2g.xml"], mteTagStoreOperands),
    operandFamily("mte-tag-pair-store", ["stgp.xml"], mteTagPairStoreOperands),
    operandFamily("mte-subtract-pointer", ["cmpp_subps.xml", "subp.xml", "subps.xml"], mteSubtractPointerOperands),
    operandFamily("mte-tag-load", ["ldg.xml", "ldgm.xml", "stgm.xml", "stzgm.xml"], mteTagLoadOperands),
    operandFamily("add-sub-immediate", ["add_addsub_imm.xml", "adds_addsub_imm.xml", "sub_addsub_imm.xml", "subs_addsub_imm.xml"], inst => {
        const encoding = inst.encoding;
        return addSubImmediateOperands(inst, encoding);
    }),
    operandFamily("add-sub-shifted", ["add_addsub_shift.xml", "adds_addsub_shift.xml", "sub_addsub_shift.xml", "subs_addsub_shift.xml"], addSubShiftedOperands),
    operandFamily("checked-pointer-add-sub", ["addpt.xml", "subpt.xml"], checkedPointerAddSubOperands),
    operandFamily("add-sub-extended", [
        "add_addsub_ext.xml", "adds_addsub_ext.xml", "sub_addsub_ext.xml", "subs_addsub_ext.xml",
        "cmn_adds_addsub_ext.xml", "cmp_subs_addsub_ext.xml",
    ], addSubExtendedOperands),
    operandFamily("move-wide", ["movz.xml", "movn.xml", "movk.xml"], moveWideOperands),
    operandFamily("adr", ["adr.xml"], inst => {
        return adrOperands(inst, false);
    }),
    operandFamily("adr-adrp", ["adrp.xml"], inst => {
        return adrOperands(inst, true);
    }),
    operandFamily("branch-offset-operand", ["b_uncond.xml", "bl.xml"], inst => {
        return branchOffsetOperand(inst, "imm26");
    }),
    operandFamily("b-cond", ["b_cond.xml"], bCondOperands),
    operandFamily("cbz", ["cbz.xml", "cbnz.xml"], cbzOperands),
    operandFamily("tbz", ["tbz.xml", "tbnz.xml"], tbzOperands),
    operandFamily("register-branch", ["br.xml", "blr.xml"], registerBranchOperands),
    operandFamily("register-branch-ret", ["ret.xml"], inst => {
        return registerBranchOperands(inst, true);
    }),
    operandFamily("auth-branch", ["bra.xml", "blra.xml"], authBranchOperands),
    operandFamily("auth-load-register", ["ldra.xml"], authLoadRegisterOperands),
    operandFamily("label-from-imm16-negative", ["autiasppc_imm.xml", "autibsppc_imm.xml", "retasppc_imm.xml"], labelFromImm16Negative),
    operandFamily("auth-generic", [
        "autia.xml", "autib.xml", "pacia.xml", "pacib.xml",
        "autda.xml", "autdb.xml", "pacda.xml", "pacdb.xml",
    ], inst => {
        const encoding = inst.encoding;
        return authGenericOperands(inst, encoding.mnemonic);
    }),
    operandFamily("auth-generic-three-source", ["pacga.xml"], authGenericThreeSourceOperands),
    operandFamily("fjcvtzs", ["fjcvtzs.xml"], fjcvtzsOperands),
    operandFamily("tsb", ["tsb.xml"], inst => {
        return [{ kind: "text", text: "csync" }];
    }),
    operandFamily("wfxt", ["wfet.xml", "wfit.xml"], wfxtOperands),
    operandFamily("udf", ["udf_perm_undef.xml"], udfOperands),
    operandFamily("xpac", ["xpac.xml"], inst => {
        const encoding = inst.encoding;
        if (encoding.mnemonic === "XPACLRI") {
            return noOperands();
        }
        return [gpReg(64, inst.fields.Rd, "zr")];
    }),
    operandFamily("rprfm", ["rprfm_reg.xml"], rprfmOperands),
]);
export function getOperandFamilyId(fileName) {
    return OPERAND_FAMILIES.familyIdForFile(fileName);
}
export function listOperandFamilies() {
    return OPERAND_FAMILIES.list();
}
function buildEncodingOperands(inst) {
    return OPERAND_FAMILIES.dispatch(inst);
}
export function resolvePcRelativeOperands(operands, pc) {
    if (pc === undefined) {
        return operands;
    }
    return operands.map((operand) => {
        if (operand.kind !== "label" || operand.absolute !== undefined) {
            return operand;
        }
        return labelFromPc(operand.offset, pc, operand.pageRelative === true);
    });
}
export function formatRegister(register) {
    if (register.index === 31) {
        if (register.zeroName === "sp") {
            return register.width === 64 ? "sp" : "wsp";
        }
        return register.width === 64 ? "xzr" : "wzr";
    }
    const prefix = register.width === 64 ? "x" : "w";
    return `${prefix}${register.index}`;
}
function formatVectorRegister(register) {
    const lane = register.lane ? `.${register.lane}` : "";
    const index = register.laneIndex === undefined ? "" : `[${register.laneIndex}]`;
    return `z${register.index}${lane}${index}`;
}
function formatPredicateRegister(register) {
    const lane = register.lane ? `.${register.lane}` : "";
    return register.mode ? `p${register.index}${lane}/${register.mode}` : `p${register.index}${lane}`;
}
function formatFloatingImmediate(value) {
    const normalized = Object.is(value, -0) ? 0 : value;
    return `#${normalized.toFixed(8)}`;
}
function formatSimdRegister(register) {
    if (register.scalar) {
        return `${register.scalar}${register.index}`;
    }
    const arrangement = register.arrangement
        ? `${register.arrangement.lanes}${register.arrangement.element}`
        : register.element;
    const lane = register.laneIndex === undefined ? "" : `[${register.laneIndex}]`;
    return `v${register.index}.${arrangement}${lane}`;
}
function formatVectorGroup(group) {
    const registers = group.registers.map(formatVectorRegister);
    return group.style === "range" && registers.length > 1
        ? `{ ${registers[0]} - ${registers[registers.length - 1]} }`
        : `{ ${registers.join(", ")} }`;
}
function formatMemoryOperand(memory) {
    const base = formatOperand(memory.base);
    const mode = memory.mode ?? "offset";
    let offset;
    if (memory.offset?.kind === "imm") {
        if (memory.offset.value !== 0n || mode !== "offset" || memory.modifier) {
            offset = memory.immediateFormat === "hex"
                ? formatSignedHexImmediate(memory.offset.value)
                : formatSignedDecimalImmediate(memory.offset.value);
        }
    }
    else if (memory.offset) {
        offset = formatOperand(memory.offset);
    }
    const modifier = memory.modifier
        ? memory.modifier.amount === undefined
            ? memory.modifier.kind
            : `${memory.modifier.kind} #${memory.modifier.amount}`
        : undefined;
    const suffix = [offset, modifier].filter((part) => part !== undefined).join(", ");
    if (mode === "post-index") {
        return `[${base}], ${suffix}`;
    }
    return `[${base}${suffix ? `, ${suffix}` : ""}]${mode === "pre-index" ? "!" : ""}`;
}
function formatZaOperand(operand) {
    const tile = operand.index === undefined ? "" : String(operand.index);
    if (!operand.slice)
        return `za${tile}.${operand.lane}`;
    const slice = operand.slice;
    const range = slice.end === undefined ? `${slice.offset}` : `${slice.offset}:${slice.end}`;
    return `za${tile}.${operand.lane}[w${slice.selector}, ${range}${slice.group ? `, vgx${slice.group}` : ""}]`;
}
export function formatOperand(operand) {
    switch (operand.kind) {
        case "reg":
            return formatRegister(operand);
        case "imm":
            return operand.shift && operand.shift !== 0
                ? `#0x${operand.value.toString(16)}, lsl #${operand.shift}`
                : operand.signed
                    ? `#${operand.value.toString()}`
                    : `#0x${operand.value.toString(16)}`;
        case "label":
            if (operand.absolute !== undefined) {
                return `0x${operand.absolute.toString(16)}`;
            }
            if (operand.offset < 0) {
                return `.-0x${(-operand.offset).toString(16)}`;
            }
            return `.+0x${operand.offset.toString(16)}`;
        case "cond":
            return operand.suffix;
        case "sysreg":
            return `S${operand.op0}_${operand.op1}_C${operand.CRn}_C${operand.CRm}_${operand.op2}`;
        case "vec":
            return formatVectorRegister(operand);
        case "pred":
            return formatPredicateRegister(operand);
        case "fpimm":
            return formatFloatingImmediate(operand.value);
        case "simd":
            return formatSimdRegister(operand);
        case "vector-group":
            return formatVectorGroup(operand);
        case "mem":
            return formatMemoryOperand(operand);
        case "za":
            return formatZaOperand(operand);
        case "text":
            return operand.text;
    }
}

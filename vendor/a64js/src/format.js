import { conditionSuffix, formatOperand, invertConditionCode, resolvePcRelativeOperands } from "./formatters.js";
import { addressToBigInt } from "./input.js";
const BITFIELD_FILES = new Set([
    "bfm.xml",
    "bfi_bfm.xml",
    "bfc_bfm.xml",
    "bfxil_bfm.xml",
    "sbfm.xml",
    "asr_sbfm.xml",
    "sbfiz_sbfm.xml",
    "sbfx_sbfm.xml",
    "sxtb_sbfm.xml",
    "sxth_sbfm.xml",
    "sxtw_sbfm.xml",
    "ubfm.xml",
    "lsl_ubfm.xml",
    "lsr_ubfm.xml",
    "ubfiz_ubfm.xml",
    "ubfx_ubfm.xml",
    "uxtb_ubfm.xml",
    "uxth_ubfm.xml",
]);
const ADVSIMD_WIDENING_LONG_FILES = new Set([
    "saddl_advsimd.xml",
    "uaddl_advsimd.xml",
    "ssubl_advsimd.xml",
    "usubl_advsimd.xml",
    "saddw_advsimd.xml",
    "uaddw_advsimd.xml",
    "ssubw_advsimd.xml",
    "usubw_advsimd.xml",
    "sabal_advsimd.xml",
    "uabal_advsimd.xml",
    "sabdl_advsimd.xml",
    "uabdl_advsimd.xml",
    "smull_advsimd_vec.xml",
    "umull_advsimd_vec.xml",
    "smull_advsimd_elt.xml",
    "umull_advsimd_elt.xml",
    "sqdmull_advsimd_elt.xml",
    "sqdmull_advsimd_vec.xml",
    "smlal_advsimd_vec.xml",
    "umlal_advsimd_vec.xml",
    "smlsl_advsimd_vec.xml",
    "umlsl_advsimd_vec.xml",
    "smlal_advsimd_elt.xml",
    "smlsl_advsimd_elt.xml",
    "sqdmlal_advsimd_elt.xml",
    "sqdmlal_advsimd_vec.xml",
    "umlal_advsimd_elt.xml",
    "umlsl_advsimd_elt.xml",
    "sqdmlsl_advsimd_elt.xml",
    "sqdmlsl_advsimd_vec.xml",
]);
const ADVSIMD_UPPER_HALF_SUFFIX_FILES = new Set([
    "bf12cvtl_advsimd.xml",
    "f12cvtl_advsimd.xml",
    "bfcvtn_advsimd.xml",
    "fcvtl_advsimd.xml",
    "fcvtn_advsimd.xml",
    "fcvtn_advsimd_328.xml",
    "xtn_advsimd.xml",
    "sqxtun_advsimd.xml",
    "sqxtn_advsimd.xml",
    "uqxtn_advsimd.xml",
    "shll_advsimd.xml",
    "sshll_advsimd.xml",
    "ushll_advsimd.xml",
    "fcvtxn_advsimd.xml",
    "shrn_advsimd.xml",
    "rshrn_advsimd.xml",
    "addhn_advsimd.xml",
    "raddhn_advsimd.xml",
    "rsubhn_advsimd.xml",
    "pmull_advsimd.xml",
    "sqshrn_advsimd.xml",
    "uqshrn_advsimd.xml",
    "sqrshrn_advsimd.xml",
    "uqrshrn_advsimd.xml",
    "sqshrun_advsimd.xml",
    "sqrshrun_advsimd.xml",
]);
function formatUnknown(word) {
    return `.inst 0x${(word >>> 0).toString(16).padStart(8, "0")}`;
}
function bitfieldWidth(sf) {
    return sf === 1 ? 64 : 32;
}
function bitfieldInsertLsb(dataSize, immr) {
    return BigInt((dataSize - immr) % dataSize);
}
function formatGpRegister(width, index) {
    return formatOperand({ kind: "reg", width, index, zeroName: "zr" });
}
function formatConditionalSelect(decoded) {
    const fileName = decoded.encoding?.fileName;
    const operands = decoded.operands ?? [];
    const fields = decoded.fields;
    if (!fileName || !fields || operands.length !== 4 || operands[3].kind !== "cond") {
        return null;
    }
    if (!["csel.xml", "cinc_csinc.xml", "cinv_csinv.xml", "cneg_csneg.xml", "cset_csinc.xml", "csetm_csinv.xml"].includes(fileName)) {
        return null;
    }
    const rd = formatOperand(operands[0]);
    const encodedCond = operands[3].code & 0xf;
    if (fileName === "cset_csinc.xml") {
        return `cset ${rd}, ${conditionSuffix(invertConditionCode(encodedCond))}`;
    }
    if (fileName === "csetm_csinv.xml") {
        return `csetm ${rd}, ${conditionSuffix(invertConditionCode(encodedCond))}`;
    }
    const rn = formatOperand(operands[1]);
    const rm = formatOperand(operands[2]);
    if (fileName === "csel.xml") {
        return `csel ${rd}, ${rn}, ${rm}, ${conditionSuffix(encodedCond)}`;
    }
    const sameSource = fields.Rn === fields.Rm;
    const aliasCond = conditionSuffix(invertConditionCode(encodedCond));
    if (fileName === "cinc_csinc.xml") {
        return sameSource ? `cinc ${rd}, ${rn}, ${aliasCond}` : `csinc ${rd}, ${rn}, ${rm}, ${conditionSuffix(encodedCond)}`;
    }
    if (fileName === "cinv_csinv.xml") {
        return sameSource ? `cinv ${rd}, ${rn}, ${aliasCond}` : `csinv ${rd}, ${rn}, ${rm}, ${conditionSuffix(encodedCond)}`;
    }
    return sameSource ? `cneg ${rd}, ${rn}, ${aliasCond}` : `csneg ${rd}, ${rn}, ${rm}, ${conditionSuffix(encodedCond)}`;
}
function formatLogicalImmediateAlias(decoded) {
    const fileName = decoded.encoding?.fileName;
    const operands = decoded.operands ?? [];
    if (fileName === "mov_orr_log_imm.xml" && operands.length === 2) {
        return `mov ${formatOperand(operands[0])}, ${formatOperand(operands[1])}`;
    }
    if (fileName !== "tst_ands_log_imm.xml" || operands.length !== 2) {
        return null;
    }
    return `tst ${formatOperand(operands[0])}, ${formatOperand(operands[1])}`;
}
function formatLogicalShiftedRegisterAlias(decoded) {
    const fileName = decoded.encoding?.fileName;
    const operands = decoded.operands ?? [];
    if (fileName !== "tst_ands_log_shift.xml" || operands.length < 2 || operands.length > 3) {
        return null;
    }
    const rendered = [formatOperand(operands[0]), formatOperand(operands[1])];
    if (operands[2]) {
        rendered.push(formatOperand(operands[2]));
    }
    return `tst ${rendered.join(", ")}`;
}
function formatBfloat16Alias(decoded) {
    const fileName = decoded.encoding?.fileName;
    const operands = decoded.operands ?? [];
    const fields = decoded.fields;
    if (!fileName || !fields) {
        return null;
    }
    if (fileName === "bfcvt_float.xml" && operands.length === 2) {
        return `bfcvt ${operands.map((operand) => formatOperand(operand)).join(", ")}`;
    }
    if (["bfmlal_advsimd_vec.xml", "bfmlal_advsimd_elt.xml"].includes(fileName) && operands.length === 3) {
        return `bfmlal${(fields.Q ?? 0) === 1 ? "t" : "b"} ${operands.map((operand) => formatOperand(operand)).join(", ")}`;
    }
    return null;
}
function formatSubtractWithCarryAlias(decoded) {
    const fileName = decoded.encoding?.fileName;
    const operands = decoded.operands ?? [];
    if (!fileName || !["ngc_sbc.xml", "ngcs_sbcs.xml"].includes(fileName) || operands.length !== 3) {
        return null;
    }
    const mnemonic = fileName === "ngc_sbc.xml" ? "ngc" : "ngcs";
    return `${mnemonic} ${formatOperand(operands[0])}, ${formatOperand(operands[2])}`;
}
function formatMultiplyAlias(decoded) {
    const fileName = decoded.encoding?.fileName;
    const operands = decoded.operands ?? [];
    if (fileName !== "mul_madd.xml" || operands.length !== 3) {
        return null;
    }
    return `mul ${operands.map((operand) => formatOperand(operand)).join(", ")}`;
}
function formatMultiplyLongAlias(decoded) {
    const fileName = decoded.encoding?.fileName;
    const operands = decoded.operands ?? [];
    const mnemonicByFile = new Map([
        ["mneg_msub.xml", "mneg"],
        ["smull_smaddl.xml", "smull"],
        ["smnegl_smsubl.xml", "smnegl"],
        ["umull_umaddl.xml", "umull"],
        ["umnegl_umsubl.xml", "umnegl"],
    ]);
    const mnemonic = fileName ? mnemonicByFile.get(fileName) : undefined;
    if (!mnemonic) {
        return null;
    }
    if (operands.length !== 3) {
        return null;
    }
    return `${mnemonic} ${operands.map((operand) => formatOperand(operand)).join(", ")}`;
}
function formatExtractAlias(decoded) {
    const fileName = decoded.encoding?.fileName;
    const operands = decoded.operands ?? [];
    const fields = decoded.fields;
    if (fileName !== "extr.xml" || !fields || operands.length !== 4) {
        return null;
    }
    const rd = formatOperand(operands[0]);
    const rn = formatOperand(operands[1]);
    const rm = formatOperand(operands[2]);
    const lsb = fields.imms ?? 0;
    if (fields.Rn === fields.Rm) {
        return `ror ${rd}, ${rn}, #${lsb}`;
    }
    return `extr ${rd}, ${rn}, ${rm}, #${lsb}`;
}
function formatVariableShiftAlias(decoded) {
    const fileName = decoded.encoding?.fileName;
    const operands = decoded.operands ?? [];
    if (!fileName || operands.length !== 3) {
        return null;
    }
    const mnemonicByFile = new Map([
        ["lsl_lslv.xml", "lsl"],
        ["lsr_lsrv.xml", "lsr"],
        ["asr_asrv.xml", "asr"],
        ["ror_rorv.xml", "ror"],
    ]);
    const mnemonic = mnemonicByFile.get(fileName);
    if (!mnemonic) {
        return null;
    }
    return `${mnemonic} ${operands.map((operand) => formatOperand(operand)).join(", ")}`;
}
function formatBarrierInstruction(decoded) {
    const fileName = decoded.encoding?.fileName;
    const operands = decoded.operands ?? [];
    const fields = decoded.fields;
    if (!fileName || !fields || !["dmb.xml", "dsb.xml", "gcsb.xml"].includes(fileName) || operands.length !== 1 || operands[0].kind !== "text") {
        return null;
    }
    if (fileName === "dsb.xml" && (fields.CRm ?? 0) === 12) {
        return "dfb";
    }
    return `${decoded.mnemonic.toLowerCase()} ${operands[0].text}`;
}
function formatSystemInstructionAlias(decoded) {
    const fileName = decoded.encoding?.fileName;
    const operands = decoded.operands ?? [];
    if (!fileName || !["at_sys.xml", "dc_sys.xml", "tlbi_sys.xml", "gcsss1_sys.xml", "gcspushm_sys.xml"].includes(fileName) || operands.length === 0) {
        return null;
    }
    if (fileName === "at_sys.xml") {
        if (operands.length !== 2 || operands[0].kind !== "text") {
            return null;
        }
        return `at ${operands[0].text}, ${formatOperand(operands[1])}`;
    }
    if (fileName === "dc_sys.xml") {
        if (operands[0].kind === "text" && (operands[0].text === "dc" || operands[0].text === "ic") && operands[1]?.kind === "text") {
            return operands.length === 3
                ? `${operands[0].text} ${operands[1].text}, ${formatOperand(operands[2])}`
                : `${operands[0].text} ${operands[1].text}`;
        }
        return `sys ${operands.map((operand) => formatOperand(operand)).join(", ")}`;
    }
    if (fileName === "gcsss1_sys.xml" || fileName === "gcspushm_sys.xml") {
        const mnemonic = fileName === "gcsss1_sys.xml" ? "gcsss1" : "gcspushm";
        return operands.length === 0 ? mnemonic : `${mnemonic} ${operands.map((operand) => formatOperand(operand)).join(", ")}`;
    }
    if (operands[0].kind !== "text") {
        return null;
    }
    if (operands[0].text.startsWith("#")) {
        return `sys ${operands.map((operand) => formatOperand(operand)).join(", ")}`;
    }
    return operands.length === 2 ? `tlbi ${operands[0].text}, ${formatOperand(operands[1])}` : `tlbi ${operands[0].text}`;
}
function formatBitfieldAlias(decoded) {
    const fileName = decoded.encoding?.fileName;
    const operands = decoded.operands ?? [];
    const fields = decoded.fields;
    if (!fileName || !fields || operands.length < 4) {
        return null;
    }
    if (!BITFIELD_FILES.has(fileName)) {
        return null;
    }
    const dataSize = bitfieldWidth(fields.sf);
    const maxImm = dataSize - 1;
    const immr = fields.immr ?? 0;
    const imms = fields.imms ?? 0;
    const rd = formatOperand(operands[0]);
    const rn = formatOperand(operands[1]);
    const wn = formatGpRegister(32, fields.Rn ?? 0);
    const extractWidth = BigInt(imms - immr + 1);
    const insertLsb = bitfieldInsertLsb(dataSize, immr);
    const insertWidth = BigInt(imms + 1);
    if (fileName.endsWith("_bfm.xml") || fileName === "bfm.xml") {
        if (imms < immr) {
            return `bfi ${rd}, ${rn}, #${insertLsb.toString()}, #${insertWidth.toString()}`;
        }
        return `bfxil ${rd}, ${rn}, #${immr}, #${extractWidth.toString()}`;
    }
    if (fileName.endsWith("_sbfm.xml") || fileName === "sbfm.xml") {
        if (immr === 0 && imms === 7) {
            return `sxtb ${rd}, ${wn}`;
        }
        if (immr === 0 && imms === 15) {
            return `sxth ${rd}, ${wn}`;
        }
        if (dataSize === 64 && immr === 0 && imms === 31) {
            return `sxtw ${rd}, ${wn}`;
        }
        if (imms === maxImm) {
            return `asr ${rd}, ${rn}, #${immr}`;
        }
        if (imms < immr) {
            return `sbfiz ${rd}, ${rn}, #${insertLsb.toString()}, #${insertWidth.toString()}`;
        }
        return `sbfx ${rd}, ${rn}, #${immr}, #${extractWidth.toString()}`;
    }
    if (fileName.endsWith("_ubfm.xml") || fileName === "ubfm.xml") {
        if (dataSize === 32 && immr === 0 && imms === 7) {
            return `uxtb ${rd}, ${wn}`;
        }
        if (dataSize === 32 && immr === 0 && imms === 15) {
            return `uxth ${rd}, ${wn}`;
        }
        if (imms === maxImm) {
            return `lsr ${rd}, ${rn}, #${immr}`;
        }
        if (imms < immr) {
            if (imms + 1 === immr) {
                return `lsl ${rd}, ${rn}, #${insertLsb.toString()}`;
            }
            return `ubfiz ${rd}, ${rn}, #${insertLsb.toString()}, #${insertWidth.toString()}`;
        }
        return `ubfx ${rd}, ${rn}, #${immr}, #${extractWidth.toString()}`;
    }
    return null;
}
function rotateRight(value, shift, width) {
    const normalizedShift = ((shift % width) + width) % width;
    const mask = (1n << BigInt(width)) - 1n;
    if (normalizedShift === 0) {
        return value & mask;
    }
    return ((value >> BigInt(normalizedShift)) | (value << BigInt(width - normalizedShift))) & mask;
}
function highestSetBit(value) {
    for (let bit = 31; bit >= 0; bit -= 1) {
        if ((value & (1 << bit)) !== 0) {
            return bit;
        }
    }
    return -1;
}
function decodeLogicalImmediate(n, immr, imms, width) {
    const len = highestSetBit((n << 6) | ((~imms) & 0x3f));
    if (len < 1) {
        return null;
    }
    const size = 1 << len;
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
function sveMoveMaskPreferred(imm13) {
    const imm = decodeLogicalImmediate((imm13 >>> 12) & 1, (imm13 >>> 6) & 0x3f, imm13 & 0x3f, 64);
    if (imm === null) {
        return false;
    }
    const low8 = Number(imm & 0xffn);
    if (low8 !== 0) {
        const upper57 = imm >> 7n;
        if (upper57 === 0n || upper57 === ((1n << 57n) - 1n)) {
            return false;
        }
        const low32 = imm & 0xffffffffn;
        const high32 = (imm >> 32n) & 0xffffffffn;
        if (high32 === low32) {
            const upper25 = (low32 >> 7n) & ((1n << 25n) - 1n);
            if (upper25 === 0n || upper25 === ((1n << 25n) - 1n)) {
                return false;
            }
        }
        const low16 = imm & 0xffffn;
        const mid16 = (imm >> 16n) & 0xffffn;
        if (high32 === low32 && mid16 === low16) {
            const upper9 = (low16 >> 7n) & ((1n << 9n) - 1n);
            if (upper9 === 0n || upper9 === ((1n << 9n) - 1n)) {
                return false;
            }
        }
        const high8 = (low16 >> 8n) & 0xffn;
        if (high32 === low32 && mid16 === low16 && high8 === BigInt(low8)) {
            return false;
        }
    }
    else {
        const upper49 = imm >> 15n;
        if (upper49 === 0n || upper49 === ((1n << 49n) - 1n)) {
            return false;
        }
        const low32 = imm & 0xffffffffn;
        const high32 = (imm >> 32n) & 0xffffffffn;
        if (high32 === low32) {
            const upper25 = (low32 >> 7n) & ((1n << 25n) - 1n);
            if (upper25 === 0n || upper25 === ((1n << 25n) - 1n)) {
                return false;
            }
        }
        const low16 = imm & 0xffffn;
        const mid16 = (imm >> 16n) & 0xffffn;
        if (high32 === low32 && mid16 === low16) {
            return false;
        }
    }
    return true;
}
function preferredMnemonic(decoded, operands) {
    const fileName = decoded.encoding?.fileName;
    if (!fileName) {
        return decoded.mnemonic.toLowerCase();
    }
    if (fileName === "fmov_dup_z_i.xml")
        return "mov";
    if (fileName === "orr_z_zz.xml" || fileName === "mov_orr_z_zz.xml")
        return operands.length === 2 ? "mov" : "orr";
    if (fileName === "mov_orr_advsimd_reg.xml" && decoded.fields?.Rn !== decoded.fields?.Rm)
        return "orr";
    if (fileName === "dup_advsimd_elt.xml")
        return decoded.encoding.className.toLowerCase().includes("vector") ? "dup" : "mov";
    if (["autiasppcr.xml", "autibsppcr.xml", "retasppcr_reg.xml"].includes(fileName))
        return decoded.mnemonic.toLowerCase().replace(/r$/, "");
    if (["fcpy_z_p_i.xml", "fdup_z_i.xml"].includes(fileName)) {
        return "fmov";
    }
    if (fileName === "mvn_not_advsimd.xml") {
        return "mvn";
    }
    if ([
        "dup_z_i.xml",
        "dup_z_zi.xml",
        "cpy_z_p_r.xml",
        "cpy_z_o_i.xml",
        "cpy_z_p_i.xml",
        "cpy_z_p_v.xml",
        "mov_orr_log_shift.xml",
        "mov_orr_log_imm.xml",
        "mov_orr_advsimd_reg.xml",
        "mov_dup_z_r.xml",
        "dup_z_r.xml",
        "ins_advsimd_gen.xml",
        "ins_advsimd_elt.xml",
        "mov_umov_advsimd.xml",
    ].includes(fileName)) {
        return "mov";
    }
    if (fileName === "dupm_z_i.xml" || fileName === "mov_dupm_z_i.xml") {
        return decoded.fields && sveMoveMaskPreferred(decoded.fields.imm13 ?? 0) ? "mov" : "dupm";
    }
    if (fileName === "cmn_adds_addsub_ext.xml") {
        return "cmn";
    }
    if (fileName === "cmp_subs_addsub_ext.xml") {
        return "cmp";
    }
    if (fileName === "smstart_msr_imm.xml") {
        return "smstart";
    }
    if (fileName === "smstop_msr_imm.xml") {
        return "smstop";
    }
    if (fileName === "gcsss2_sysl.xml") {
        return "gcsss2";
    }
    if (fileName === "gcspopm_sysl.xml") {
        return "gcspopm";
    }
    if (fileName === "gcsss1_sys.xml") {
        return "gcsss1";
    }
    if (fileName === "gcspushm_sys.xml") {
        return "gcspushm";
    }
    if (fileName === "gcspushx_sys.xml") {
        return "gcspushx";
    }
    if (fileName === "gcspopx_sys.xml") {
        return "gcspopx";
    }
    if (fileName === "gcspopcx_sys.xml") {
        return "gcspopcx";
    }
    if (fileName === "trcit_sys.xml") {
        return "trcit";
    }
    if (fileName === "cfp_sys.xml") {
        return "cfp";
    }
    if (fileName === "dvp_sys.xml") {
        return "dvp";
    }
    if (fileName === "cpp_sys.xml") {
        return "cpp";
    }
    if (fileName === "cosp_sys.xml") {
        return "cosp";
    }
    if (fileName === "ssbb_dsb.xml") {
        return "ssbb";
    }
    if (fileName === "pssbb_dsb.xml") {
        return "pssbb";
    }
    if (fileName === "sxtl_sshll_advsimd.xml") {
        return `sxtl${(decoded.fields?.Q ?? 0) === 1 ? "2" : ""}`;
    }
    if (fileName === "uxtl_ushll_advsimd.xml") {
        return `uxtl${(decoded.fields?.Q ?? 0) === 1 ? "2" : ""}`;
    }
    if ([
        "mov_mova_z_p_rza.xml",
        "mov_mova_za_p_rz.xml",
        "mov_mova_mz2_za.xml",
        "mov_mova_za2_z.xml",
        "mov_mova_za4_z.xml",
        "mov_mova_mz4_za.xml",
        "mov_mova_mz_za2.xml",
        "mov_mova_mz_za4.xml",
        "mov_mova_za_mz2.xml",
        "mov_mova_za_mz4.xml",
    ].includes(fileName)) {
        return "mov";
    }
    if ([
        "and_p_p_pp.xml",
        "mov_and_p_p_pp.xml",
        "orr_p_p_pp.xml",
        "mov_orr_p_p_pp.xml",
        "sel_p_p_pp.xml",
        "mov_sel_p_p_pp.xml",
        "sel_z_p_zz.xml",
        "mov_sel_z_p_zz.xml",
    ].includes(fileName) &&
        operands.length <= 3) {
        return "mov";
    }
    if (["ands_p_p_pp.xml", "movs_ands_p_p_pp.xml", "orrs_p_p_pp.xml", "movs_orrs_p_p_pp.xml"].includes(fileName) &&
        operands.length <= 3) {
        return "movs";
    }
    if (["eors_p_p_pp.xml", "nots_eors_p_p_pp.xml"].includes(fileName) && operands.length === 3) {
        return "nots";
    }
    if (decoded.fields && ADVSIMD_WIDENING_LONG_FILES.has(fileName) && (decoded.fields.Q ?? 0) === 1) {
        return `${decoded.mnemonic.toLowerCase()}2`;
    }
    if (decoded.fields &&
        ADVSIMD_UPPER_HALF_SUFFIX_FILES.has(fileName) &&
        (decoded.fields.Q ?? 0) === 1) {
        return `${decoded.mnemonic.toLowerCase()}2`;
    }
    return decoded.mnemonic.toLowerCase();
}
export function format(decoded, options = {}) {
    if (decoded.status !== "ok" || !decoded.mnemonic) {
        if (options.onUnknown === "error") {
            throw new Error(decoded.errors?.join("; ") ?? "unknown instruction");
        }
        return formatUnknown(decoded.word);
    }
    if (decoded.behavior === "nop" && decoded.availability === "unavailable") {
        return "nop";
    }
    const pc = options.pc === undefined ? undefined : addressToBigInt(options.pc);
    const operands = resolvePcRelativeOperands(decoded.operands ?? [], pc);
    const multiplyAlias = formatMultiplyAlias({ ...decoded, operands });
    if (multiplyAlias) {
        return multiplyAlias;
    }
    const multiplyLongAlias = formatMultiplyLongAlias({ ...decoded, operands });
    if (multiplyLongAlias) {
        return multiplyLongAlias;
    }
    const logicalImmediateAlias = formatLogicalImmediateAlias({ ...decoded, operands });
    if (logicalImmediateAlias) {
        return logicalImmediateAlias;
    }
    const logicalShiftedRegisterAlias = formatLogicalShiftedRegisterAlias({ ...decoded, operands });
    if (logicalShiftedRegisterAlias) {
        return logicalShiftedRegisterAlias;
    }
    const bfloat16Alias = formatBfloat16Alias({ ...decoded, operands });
    if (bfloat16Alias) {
        return bfloat16Alias;
    }
    const subtractWithCarryAlias = formatSubtractWithCarryAlias({ ...decoded, operands });
    if (subtractWithCarryAlias) {
        return subtractWithCarryAlias;
    }
    const extractAlias = formatExtractAlias({ ...decoded, operands });
    if (extractAlias) {
        return extractAlias;
    }
    const variableShiftAlias = formatVariableShiftAlias({ ...decoded, operands });
    if (variableShiftAlias) {
        return variableShiftAlias;
    }
    const barrierInstruction = formatBarrierInstruction({ ...decoded, operands });
    if (barrierInstruction) {
        return barrierInstruction;
    }
    const systemInstructionAlias = formatSystemInstructionAlias({ ...decoded, operands });
    if (systemInstructionAlias) {
        return systemInstructionAlias;
    }
    const bitfieldAlias = formatBitfieldAlias({ ...decoded, operands });
    if (bitfieldAlias) {
        return bitfieldAlias;
    }
    const conditionalSelect = formatConditionalSelect({ ...decoded, operands });
    if (conditionalSelect) {
        return conditionalSelect;
    }
    if (decoded.encoding?.fileName === "b_cond.xml" && operands.length === 2 && operands[0].kind === "cond") {
        return `b.${operands[0].suffix} ${formatOperand(operands[1])}`;
    }
    if (decoded.encoding?.fileName === "ldr_lit_gen.xml" &&
        operands.length === 2 &&
        operands[1].kind === "label") {
        const target = operands[1].absolute !== undefined
            ? `0x${operands[1].absolute.toString(16)}`
            : `#${operands[1].offset.toString()}`;
        return `${preferredMnemonic(decoded, operands)} ${formatOperand(operands[0])}, ${target}`;
    }
    const mnemonic = preferredMnemonic(decoded, operands);
    const operandText = operands.map((operand, index) => {
        if (decoded.encoding &&
            ["add_addsub_shift.xml", "adds_addsub_shift.xml", "sub_addsub_shift.xml", "subs_addsub_shift.xml"].includes(decoded.encoding.fileName) &&
            index === 3 &&
            operand.kind === "imm") {
            const hint = operand.displayHint ?? "lsl";
            return `${hint} #${operand.value.toString()}`;
        }
        if (decoded.encoding &&
            ["movz.xml", "movn.xml", "movk.xml"].includes(decoded.encoding.fileName) &&
            index === 1 &&
            operand.kind === "imm" &&
            operand.shift &&
            operand.shift !== 0) {
            return `#0x${operand.value.toString(16)}, lsl #${operand.shift}`;
        }
        return formatOperand(operand);
    });
    return operandText.length === 0 ? mnemonic : `${mnemonic} ${operandText.join(", ")}`;
}

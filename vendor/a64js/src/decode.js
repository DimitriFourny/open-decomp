import { buildOperands } from "./formatters.js";
import { OperandDecodeError } from "./operand-errors.js";
import { normalizeWord } from "./input.js";
import { ENCODINGS, OPCODE_BUCKETS } from "./generated/isa/index.generated.js";
function extractField(word, lsb, width) {
    if (width === 32) {
        return word >>> 0;
    }
    return (word >>> lsb) & ((1 << width) - 1);
}
function extractFields(word, encoding) {
    const result = {};
    for (const field of encoding.fields) {
        result[field.name] = extractField(word, field.lsb, field.width);
    }
    return result;
}
function guardCheckMatches(fields, guard, enabledFeatures) {
    if (guard.kind === "feature") {
        return evaluateFeatureExpression(guard.feature, enabledFeatures) === guard.implemented;
    }
    if (guard.kind === "eq_field" || guard.kind === "ne_field") {
        const actual = fields[guard.field] ?? 0;
        const expected = fields[guard.otherField] ?? 0;
        return guard.kind === "eq_field" ? actual === expected : actual !== expected;
    }
    if (guard.kind === "eq_concat" || guard.kind === "ne_concat") {
        let actual = 0;
        for (const part of guard.parts) {
            const raw = fields[part.field] ?? 0;
            const width = part.msb - part.lsb + 1;
            const value = (raw >>> part.lsb) & ((1 << width) - 1);
            actual = (actual << width) | value;
        }
        return guard.kind === "eq_concat" ? (actual >>> 0) === guard.value : (actual >>> 0) !== guard.value;
    }
    const raw = fields[guard.field] ?? 0;
    const actual = guard.mask === -1 ? raw : (raw & guard.mask) >>> guard.lsb;
    return guard.kind === "eq" ? actual === guard.value : actual !== guard.value;
}
function stripOuterParentheses(expression) {
    let current = expression.trim();
    while (current.startsWith("(") && current.endsWith(")")) {
        let depth = 0;
        let wrapsWholeExpression = true;
        for (let index = 0; index < current.length; index += 1) {
            const char = current[index];
            if (char === "(") {
                depth += 1;
            }
            else if (char === ")") {
                depth -= 1;
                if (depth === 0 && index !== current.length - 1) {
                    wrapsWholeExpression = false;
                    break;
                }
            }
        }
        if (!wrapsWholeExpression) {
            break;
        }
        current = current.slice(1, -1).trim();
    }
    return current;
}
function splitTopLevel(expression, operator) {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < expression.length; index += 1) {
        const char = expression[index];
        if (char === "(") {
            depth += 1;
            continue;
        }
        if (char === ")") {
            depth -= 1;
            continue;
        }
        if (depth === 0 && expression.slice(index, index + operator.length) === operator) {
            parts.push(expression.slice(start, index).trim());
            start = index + operator.length;
            index += operator.length - 1;
        }
    }
    parts.push(expression.slice(start).trim());
    return parts;
}
function evaluateFeatureExpression(expression, enabledFeatures) {
    const normalized = stripOuterParentheses(expression);
    const orParts = splitTopLevel(normalized, "||");
    if (orParts.length > 1) {
        return orParts.some((part) => evaluateFeatureExpression(part, enabledFeatures));
    }
    const andParts = splitTopLevel(normalized, "&&");
    if (andParts.length > 1) {
        return andParts.every((part) => evaluateFeatureExpression(part, enabledFeatures));
    }
    return enabledFeatures.has(normalized);
}
function missingFeatures(encoding, fields, enabledFeatures) {
    const compositeExpressions = encoding.features.filter((feature) => feature.includes("||") || feature.includes("&&"));
    const missing = compositeExpressions.filter((feature) => !evaluateFeatureExpression(feature, enabledFeatures));
    for (const feature of encoding.features) {
        if (feature.includes("||") || feature.includes("&&")) {
            continue;
        }
        if (!enabledFeatures.has(feature)) {
            missing.push(feature);
        }
    }
    for (const featureGuard of encoding.featureGuards) {
        if (!featureGuard.all.every((check) => guardCheckMatches(fields, check, enabledFeatures))) {
            continue;
        }
        if (!evaluateFeatureExpression(featureGuard.feature, enabledFeatures)) {
            missing.push(featureGuard.feature);
        }
    }
    return missing;
}
const SUPPORTED_AT_SYS_KEYS = new Set([
    "0:7:8:0",
    "0:7:8:1",
    "0:7:8:2",
    "0:7:8:3",
    "0:7:9:0",
    "0:7:9:1",
    "0:7:9:2",
    "4:7:8:0",
    "4:7:8:1",
    "4:7:8:4",
    "4:7:8:5",
    "4:7:8:6",
    "4:7:8:7",
    "4:7:9:2",
    "6:7:8:0",
    "6:7:8:1",
    "6:7:9:2",
]);
const SUPPORTED_DC_SYS_KEYS = new Set([
    "0:7:1:0",
    "0:7:5:0",
    "3:7:5:1",
    "0:7:6:1",
    "0:7:6:2",
    "0:7:6:3",
    "0:7:6:4",
    "0:7:6:5",
    "0:7:6:6",
    "0:7:10:2",
    "0:7:10:4",
    "0:7:10:6",
    "0:7:14:2",
    "0:7:14:4",
    "0:7:14:6",
    "3:7:4:1",
    "3:7:4:3",
    "3:7:4:4",
    "3:7:10:1",
    "3:7:10:3",
    "3:7:10:5",
    "3:7:11:1",
    "3:7:12:1",
    "3:7:12:3",
    "3:7:12:5",
    "3:7:13:1",
    "3:7:13:3",
    "3:7:13:5",
    "3:7:14:1",
    "3:7:14:3",
    "3:7:14:5",
    "4:7:14:0",
    "4:7:14:7",
]);
const SUPPORTED_TLBI_SYS_KEYS = new Set([
    "0:8:3:0",
    "0:8:3:1",
    "0:8:3:2",
    "0:8:3:3",
    "0:8:3:5",
    "0:8:3:7",
    "0:8:7:0",
    "0:8:7:1",
    "0:8:7:2",
    "0:8:7:3",
    "0:8:7:5",
    "0:8:7:7",
    "3:9:2:1",
    "4:8:0:1",
    "4:8:0:5",
    "4:8:2:2",
    "4:8:3:0",
    "4:8:3:1",
    "4:8:3:4",
    "4:8:3:5",
    "4:8:3:6",
    "4:8:4:1",
    "4:8:4:5",
    "4:8:5:2",
    "4:8:6:2",
    "4:8:7:0",
    "4:8:7:1",
    "4:8:7:4",
    "4:8:7:5",
    "4:8:7:6",
    "4:9:2:2",
    "4:9:5:2",
    "4:9:6:2",
    "6:8:3:0",
    "6:8:3:1",
    "6:8:3:5",
    "6:8:7:0",
    "6:8:7:1",
    "6:8:7:5",
]);
function systemAliasKey(fields) {
    return `${fields.op1 ?? 0}:${fields.CRn ?? 0}:${fields.CRm ?? 0}:${fields.op2 ?? 0}`;
}
function isUnsupportedConditionalSelectAlias(encoding, fields) {
    return ((encoding.fileName === "cinc_csinc.xml" || encoding.fileName === "cinv_csinv.xml") &&
        fields.Rn === 31 &&
        fields.Rm === 31);
}
function isMultiplyAliasOverlap(encoding, fields) {
    return ((encoding.fileName === "msub.xml" && fields.Ra === 31) ||
        (encoding.fileName === "smaddl.xml" && fields.Ra === 31) ||
        (encoding.fileName === "smsubl.xml" && fields.Ra === 31) ||
        (encoding.fileName === "umaddl.xml" && fields.Ra === 31) ||
        (encoding.fileName === "umsubl.xml" && fields.Ra === 31));
}
function isUnsupportedLogicalImmediateAlias(encoding, fields) {
    return encoding.fileName === "orr_log_imm.xml" && fields.Rn === 31;
}
function isUnsupportedBarrierAlias(encoding, fields) {
    return encoding.fileName === "dsb.xml" && ((fields.CRm ?? 0) === 0 || (fields.CRm ?? 0) === 4);
}
function isUnsupportedHintAlias(encoding, fields) {
    if (encoding.fileName !== "hint.xml") {
        return false;
    }
    const imm = ((fields.CRm ?? 0) << 3) | (fields.op2 ?? 0);
    return new Set([
        0, 1, 2, 3, 4, 5, 6, 7,
        8, 10, 12, 14,
        16, 17, 18, 19, 20, 22,
        24, 25, 26, 27, 28, 29, 30, 31,
        32, 34, 36, 38, 39, 40,
        48, 49, 50, 51, 52,
    ]).has(imm);
}
function isUnsupportedSystemInstructionOverlap(encoding, fields) {
    const key = systemAliasKey(fields);
    if (encoding.fileName === "at_sys.xml") {
        return !SUPPORTED_AT_SYS_KEYS.has(key);
    }
    if (encoding.fileName === "dc_sys.xml") {
        return !SUPPORTED_DC_SYS_KEYS.has(key);
    }
    if (encoding.fileName === "tlbi_sys.xml") {
        return !SUPPORTED_TLBI_SYS_KEYS.has(key);
    }
    return false;
}
export function decode(word, options = {}) {
    const enabledFeatures = new Set(options.features ?? []);
    return decodeWithFeatures(normalizeWord(word), enabledFeatures);
}
/** Capture a target's features once for repeated decoding or single-use iterables. */
export function createDecoder(options = {}) {
    const enabledFeatures = new Set(options.features ?? []);
    return (word) => decodeWithFeatures(normalizeWord(word), enabledFeatures);
}
function decodeWithFeatures(word, enabledFeatures) {
    for (const index of OPCODE_BUCKETS[word >>> 24]) {
        const encoding = ENCODINGS[index];
        if (((word & encoding.mask) >>> 0) !== encoding.value) {
            continue;
        }
        const fields = extractFields(word, encoding);
        let behavior = "instruction";
        for (const guard of encoding.guards) {
            if (guard.all.every((check) => guardCheckMatches(fields, check, enabledFeatures))) {
                const nop = guard.outcome === "nop";
                const missing = [...new Set([
                        ...missingFeatures(encoding, fields, enabledFeatures),
                        ...guard.all.flatMap((check) => check.kind === "feature" && !check.implemented ? [check.feature] : []),
                    ])];
                // Named permanent traps and unconditional hints still have useful assembly operands.
                if (nop && missing.length === 0) {
                    behavior = "nop";
                    break;
                }
                if (encoding.mnemonic === "UDF" && guard.all.length === 0) {
                    behavior = "undefined";
                    break;
                }
                return {
                    status: nop ? "ok" : "undefined", word, encoding, mnemonic: encoding.mnemonic, fields,
                    ...(nop ? { operands: [], behavior: "nop" } : {}),
                    availability: missing.length === 0 ? "available" : "unavailable",
                    errors: nop ? undefined : [missing.length ? `missing features: ${missing.join(", ")}` : "decode guard failed"],
                };
            }
        }
        const missing = missingFeatures(encoding, fields, enabledFeatures);
        if (missing.length > 0) {
            return {
                status: "undefined",
                availability: "unavailable",
                word,
                encoding,
                mnemonic: encoding.mnemonic,
                fields,
                errors: [`missing features: ${missing.join(", ")}`],
            };
        }
        if (isUnsupportedConditionalSelectAlias(encoding, fields) ||
            isUnsupportedLogicalImmediateAlias(encoding, fields) ||
            isUnsupportedBarrierAlias(encoding, fields) ||
            isUnsupportedHintAlias(encoding, fields) ||
            isUnsupportedSystemInstructionOverlap(encoding, fields)) {
            return {
                status: "unknown",
                word,
            };
        }
        if (isMultiplyAliasOverlap(encoding, fields)) {
            continue;
        }
        const decoded = {
            status: "ok",
            availability: "available",
            behavior,
            word,
            encoding,
            mnemonic: encoding.mnemonic,
            fields,
        };
        try {
            decoded.operands = buildOperands(decoded);
        }
        catch (error) {
            if (!(error instanceof OperandDecodeError))
                throw error;
            return {
                ...decoded,
                status: error.reason === "invalid" ? "undefined" : "unknown",
                errors: [error.message],
            };
        }
        return decoded;
    }
    return { status: "unknown", word };
}

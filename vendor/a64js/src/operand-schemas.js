import { OperandDecodeError } from "./operand-errors.js";
function resolve(value, instruction) {
    return typeof value === "function" ? value(instruction) : value;
}
export function operandField(instruction, field) {
    const value = instruction.fields?.[field];
    if (value === undefined) {
        throw new OperandDecodeError("invalid", `missing operand field: ${field}`, instruction.encoding?.fileName);
    }
    const layout = instruction.encoding?.fields.find((layout) => layout.name === field);
    if (!Number.isInteger(value) || value < 0 || (layout && value >= 2 ** layout.width)) {
        throw new OperandDecodeError("invalid", `invalid operand field: ${field}`, instruction.encoding?.fileName);
    }
    return value;
}
export function operandFieldOneOf(instruction, fields) {
    const field = fields.find((field) => instruction.fields?.[field] !== undefined);
    if (!field)
        throw new OperandDecodeError("invalid", `missing operand field: ${fields.join(" or ")}`, instruction.encoding?.fileName);
    return operandField(instruction, field);
}
export function vectorGroup(start, count, lane, style) {
    return {
        kind: "vector-group",
        registers: Array.from({ length: count }, (_, index) => ({ kind: "vec", index: (start + index) & 31, lane })),
        style: style ?? (count >= 4 && start + count <= 32 ? "range" : "list"),
    };
}
export function gpOperand(index, width = 64, zeroName = "zr") {
    return { kind: "reg", index, width, zeroName };
}
export function buildOperandSchema(instruction, rules) {
    return rules.map((rule) => {
        switch (rule.kind) {
            case "gp":
                return gpOperand(operandField(instruction, rule.field), resolve(rule.width, instruction), rule.zeroName);
            case "scalar":
                return { kind: "simd", index: operandField(instruction, rule.field), scalar: resolve(rule.lane, instruction) };
            case "simd": {
                const index = rule.index === undefined ? operandField(instruction, rule.field) : resolve(rule.index, instruction);
                const lane = resolve(rule.lane, instruction);
                const laneIndex = rule.laneIndex === undefined ? undefined : resolve(rule.laneIndex, instruction);
                if (rule.lanes !== undefined) {
                    return { kind: "simd", index, arrangement: { lanes: resolve(rule.lanes, instruction), element: lane }, laneIndex };
                }
                if (laneIndex === undefined) {
                    throw new OperandDecodeError("invalid", "SIMD element requires a lane index", instruction.encoding?.fileName);
                }
                return { kind: "simd", index, element: lane, laneIndex };
            }
            case "vector":
                return { kind: "vec", index: operandField(instruction, rule.field), lane: resolve(rule.lane, instruction) };
            case "predicate":
                return {
                    kind: "pred", index: operandField(instruction, rule.field),
                    mode: rule.mode === undefined ? undefined : resolve(rule.mode, instruction),
                    lane: rule.lane === undefined ? undefined : resolve(rule.lane, instruction),
                };
            case "group": {
                const count = resolve(rule.count, instruction);
                const start = operandField(instruction, rule.field) * (rule.scale === undefined ? count : resolve(rule.scale, instruction));
                return vectorGroup(start, count, resolve(rule.lane, instruction), rule.style);
            }
            case "immediate":
                return { kind: "imm", value: resolve(rule.value, instruction), signed: rule.signed };
            case "memory":
                return resolve(rule.value, instruction);
        }
    });
}
const gpSf = (instruction) => instruction.fields?.sf === 1 ? 64 : 32;
const REGISTERED_SCHEMAS = {
    "gp-rd-rn-rm-sf": [
        { kind: "gp", field: "Rd", width: gpSf },
        { kind: "gp", field: "Rn", width: gpSf },
        { kind: "gp", field: "Rm", width: gpSf },
    ],
};
export function buildRegisteredSchema(instruction) {
    const id = instruction.encoding?.operandSchemaId;
    if (!id)
        return undefined;
    return buildOperandSchemaById(instruction, id);
}
export function buildOperandSchemaById(instruction, id) {
    const rules = REGISTERED_SCHEMAS[id];
    if (!rules) {
        throw new OperandDecodeError("unsupported", `unsupported operand schema: ${id}`, instruction.encoding?.fileName);
    }
    return buildOperandSchema(instruction, rules);
}

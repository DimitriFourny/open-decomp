/** An encoding matched, but its operand construction could not complete. */
export class OperandDecodeError extends Error {
    reason;
    fileName;
    constructor(reason, message, fileName) {
        super(message);
        this.name = "OperandDecodeError";
        this.reason = reason;
        this.fileName = fileName;
    }
}

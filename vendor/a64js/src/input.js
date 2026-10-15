/** Accept ordinary unsigned words and signed results of JavaScript bitwise operations. */
export function normalizeWord(word) {
    if (!Number.isInteger(word) || word < -0x8000_0000 || word > 0xffff_ffff) {
        throw new RangeError("instruction word must be a 32-bit integer");
    }
    return word >>> 0;
}
export function addressToBigInt(address) {
    if (typeof address === "number" && !Number.isSafeInteger(address)) {
        throw new RangeError("numeric addresses must be safe integers; use bigint for larger addresses");
    }
    return BigInt(address);
}

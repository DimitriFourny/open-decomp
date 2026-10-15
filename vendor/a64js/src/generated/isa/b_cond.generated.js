export const ENCODINGS = [
    {
        "instructionId": "B_cond",
        "encodingId": "B_only_condbranch",
        "mnemonic": "B",
        "className": "19-bit signed PC-relative branch offset",
        "fileName": "b_cond.xml",
        "mask": 4278190096,
        "value": 1409286144,
        "bitCount": 9,
        "fields": [
            {
                "name": "imm19",
                "lsb": 5,
                "width": 19
            },
            {
                "name": "o0",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "cond",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [],
        "operandFamilyId": "b-cond"
    }
];

export const ENCODINGS = [
    {
        "instructionId": "B_uncond",
        "encodingId": "B_only_branch_imm",
        "mnemonic": "B",
        "className": "26-bit signed PC-relative branch offset",
        "fileName": "b_uncond.xml",
        "mask": 4227858432,
        "value": 335544320,
        "bitCount": 6,
        "fields": [
            {
                "name": "op",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "imm26",
                "lsb": 0,
                "width": 26
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [],
        "operandFamilyId": "branch-offset-operand"
    }
];

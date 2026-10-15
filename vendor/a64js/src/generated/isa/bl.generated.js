export const ENCODINGS = [
    {
        "instructionId": "BL",
        "encodingId": "BL_only_branch_imm",
        "mnemonic": "BL",
        "className": "26-bit signed PC-relative branch offset",
        "fileName": "bl.xml",
        "mask": 4227858432,
        "value": 2483027968,
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

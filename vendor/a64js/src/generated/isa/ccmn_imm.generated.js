export const ENCODINGS = [
    {
        "instructionId": "CCMN_imm",
        "encodingId": "CCMN_32_condcmp_imm",
        "mnemonic": "CCMN",
        "className": "5-bit unsigned immediate",
        "fileName": "ccmn_imm.xml",
        "mask": 4292873232,
        "value": 977274880,
        "bitCount": 14,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "imm5",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "cond",
                "lsb": 12,
                "width": 4
            },
            {
                "name": "o2",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "o3",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "nzcv",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [],
        "operandFamilyId": "conditional-compare-immediate"
    },
    {
        "instructionId": "CCMN_imm",
        "encodingId": "CCMN_64_condcmp_imm",
        "mnemonic": "CCMN",
        "className": "5-bit unsigned immediate",
        "fileName": "ccmn_imm.xml",
        "mask": 4292873232,
        "value": 3124758528,
        "bitCount": 14,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "imm5",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "cond",
                "lsb": 12,
                "width": 4
            },
            {
                "name": "o2",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "o3",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "nzcv",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [],
        "operandFamilyId": "conditional-compare-immediate"
    }
];

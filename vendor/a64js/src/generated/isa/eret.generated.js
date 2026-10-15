export const ENCODINGS = [
    {
        "instructionId": "ERET",
        "encodingId": "ERET_64E_branch_reg",
        "mnemonic": "ERET",
        "className": "System",
        "fileName": "eret.xml",
        "mask": 4294967295,
        "value": 3600745440,
        "bitCount": 32,
        "fields": [
            {
                "name": "opc",
                "lsb": 21,
                "width": 4
            },
            {
                "name": "op2",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "A",
                "lsb": 11,
                "width": 1
            },
            {
                "name": "M",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "op4",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [],
        "operandFamilyId": "no-operands"
    }
];

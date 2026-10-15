export const ENCODINGS = [
    {
        "instructionId": "BLR",
        "encodingId": "BLR_64_branch_reg",
        "mnemonic": "BLR",
        "className": "Integer",
        "fileName": "blr.xml",
        "mask": 4294966303,
        "value": 3594452992,
        "bitCount": 27,
        "fields": [
            {
                "name": "Z",
                "lsb": 24,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 21,
                "width": 2
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
                "name": "Rm",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [],
        "operandFamilyId": "register-branch"
    }
];

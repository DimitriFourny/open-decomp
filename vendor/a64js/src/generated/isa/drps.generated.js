export const ENCODINGS = [
    {
        "instructionId": "DRPS",
        "encodingId": "DRPS_64E_branch_reg",
        "mnemonic": "DRPS",
        "className": "System",
        "fileName": "drps.xml",
        "mask": 4294967295,
        "value": 3602842592,
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
                "name": "op3",
                "lsb": 10,
                "width": 6
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

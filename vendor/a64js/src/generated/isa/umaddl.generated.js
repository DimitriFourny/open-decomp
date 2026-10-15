export const ENCODINGS = [
    {
        "instructionId": "UMADDL",
        "encodingId": "UMADDL_64WA_dp_3src",
        "mnemonic": "UMADDL",
        "className": "64-bit",
        "fileName": "umaddl.xml",
        "mask": 4292902912,
        "value": 2610954240,
        "bitCount": 12,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "op54",
                "lsb": 29,
                "width": 2
            },
            {
                "name": "U",
                "lsb": 23,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "o0",
                "lsb": 15,
                "width": 1
            },
            {
                "name": "Ra",
                "lsb": 10,
                "width": 5
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [],
        "operandFamilyId": "scalar-multiply-long"
    }
];

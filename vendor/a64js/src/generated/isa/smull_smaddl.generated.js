export const ENCODINGS = [
    {
        "instructionId": "SMULL_SMADDL",
        "encodingId": "SMULL_SMADDL_64WA_dp_3src",
        "mnemonic": "SMADDL",
        "className": "64-bit",
        "fileName": "smull_smaddl.xml",
        "mask": 4292934656,
        "value": 2602597376,
        "bitCount": 17,
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
        "canonicalEncodingId": "SMADDL_64WA_dp_3src",
        "canonicalFileName": "smaddl.xml",
        "operandFamilyId": "scalar-multiply-long-alias"
    }
];

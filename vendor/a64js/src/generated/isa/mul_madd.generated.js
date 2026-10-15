export const ENCODINGS = [
    {
        "instructionId": "MUL_MADD",
        "encodingId": "MUL_MADD_32A_dp_3src",
        "mnemonic": "MADD",
        "className": "Integer",
        "fileName": "mul_madd.xml",
        "mask": 4292934656,
        "value": 453016576,
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
                "name": "op31",
                "lsb": 21,
                "width": 3
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
        "canonicalEncodingId": "MADD_32A_dp_3src",
        "canonicalFileName": "madd.xml",
        "operandFamilyId": "mul-alias"
    },
    {
        "instructionId": "MUL_MADD",
        "encodingId": "MUL_MADD_64A_dp_3src",
        "mnemonic": "MADD",
        "className": "Integer",
        "fileName": "mul_madd.xml",
        "mask": 4292934656,
        "value": 2600500224,
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
                "name": "op31",
                "lsb": 21,
                "width": 3
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
        "canonicalEncodingId": "MADD_64A_dp_3src",
        "canonicalFileName": "madd.xml",
        "operandFamilyId": "mul-alias"
    }
];

export const ENCODINGS = [
    {
        "instructionId": "ROR_RORV",
        "encodingId": "ROR_RORV_32_dp_2src",
        "mnemonic": "RORV",
        "className": "Integer",
        "fileName": "ror_rorv.xml",
        "mask": 4292934656,
        "value": 448801792,
        "bitCount": 17,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "op2",
                "lsb": 10,
                "width": 2
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
        "canonicalEncodingId": "RORV_32_dp_2src",
        "canonicalFileName": "rorv.xml",
        "operandFamilyId": "two-source-integer"
    },
    {
        "instructionId": "ROR_RORV",
        "encodingId": "ROR_RORV_64_dp_2src",
        "mnemonic": "RORV",
        "className": "Integer",
        "fileName": "ror_rorv.xml",
        "mask": 4292934656,
        "value": 2596285440,
        "bitCount": 17,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "op2",
                "lsb": 10,
                "width": 2
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
        "canonicalEncodingId": "RORV_64_dp_2src",
        "canonicalFileName": "rorv.xml",
        "operandFamilyId": "two-source-integer"
    }
];

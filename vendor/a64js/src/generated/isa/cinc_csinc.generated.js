export const ENCODINGS = [
    {
        "instructionId": "CINC_CSINC",
        "encodingId": "CINC_CSINC_32_condsel",
        "mnemonic": "CSINC",
        "className": "Integer",
        "fileName": "cinc_csinc.xml",
        "mask": 4292873216,
        "value": 444597248,
        "bitCount": 13,
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
                "name": "Rm",
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
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [],
        "canonicalEncodingId": "CSINC_32_condsel",
        "canonicalFileName": "csinc.xml",
        "operandFamilyId": "conditional-select"
    },
    {
        "instructionId": "CINC_CSINC",
        "encodingId": "CINC_CSINC_64_condsel",
        "mnemonic": "CSINC",
        "className": "Integer",
        "fileName": "cinc_csinc.xml",
        "mask": 4292873216,
        "value": 2592080896,
        "bitCount": 13,
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
                "name": "Rm",
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
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [],
        "canonicalEncodingId": "CSINC_64_condsel",
        "canonicalFileName": "csinc.xml",
        "operandFamilyId": "conditional-select"
    }
];

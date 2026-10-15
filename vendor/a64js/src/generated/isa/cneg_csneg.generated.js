export const ENCODINGS = [
    {
        "instructionId": "CNEG_CSNEG",
        "encodingId": "CNEG_CSNEG_32_condsel",
        "mnemonic": "CSNEG",
        "className": "Integer",
        "fileName": "cneg_csneg.xml",
        "mask": 4292873216,
        "value": 1518339072,
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
        "canonicalEncodingId": "CSNEG_32_condsel",
        "canonicalFileName": "csneg.xml",
        "operandFamilyId": "conditional-select"
    },
    {
        "instructionId": "CNEG_CSNEG",
        "encodingId": "CNEG_CSNEG_64_condsel",
        "mnemonic": "CSNEG",
        "className": "Integer",
        "fileName": "cneg_csneg.xml",
        "mask": 4292873216,
        "value": 3665822720,
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
        "canonicalEncodingId": "CSNEG_64_condsel",
        "canonicalFileName": "csneg.xml",
        "operandFamilyId": "conditional-select"
    }
];

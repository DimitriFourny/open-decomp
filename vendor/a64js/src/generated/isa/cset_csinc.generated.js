export const ENCODINGS = [
    {
        "instructionId": "CSET_CSINC",
        "encodingId": "CSET_CSINC_32_condsel",
        "mnemonic": "CSINC",
        "className": "Integer",
        "fileName": "cset_csinc.xml",
        "mask": 4294905824,
        "value": 446629856,
        "bitCount": 23,
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
        "instructionId": "CSET_CSINC",
        "encodingId": "CSET_CSINC_64_condsel",
        "mnemonic": "CSINC",
        "className": "Integer",
        "fileName": "cset_csinc.xml",
        "mask": 4294905824,
        "value": 2594113504,
        "bitCount": 23,
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

export const ENCODINGS = [
    {
        "instructionId": "CSETM_CSINV",
        "encodingId": "CSETM_CSINV_32_condsel",
        "mnemonic": "CSINV",
        "className": "Integer",
        "fileName": "csetm_csinv.xml",
        "mask": 4294905824,
        "value": 1520370656,
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
        "canonicalEncodingId": "CSINV_32_condsel",
        "canonicalFileName": "csinv.xml",
        "operandFamilyId": "conditional-select"
    },
    {
        "instructionId": "CSETM_CSINV",
        "encodingId": "CSETM_CSINV_64_condsel",
        "mnemonic": "CSINV",
        "className": "Integer",
        "fileName": "csetm_csinv.xml",
        "mask": 4294905824,
        "value": 3667854304,
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
        "canonicalEncodingId": "CSINV_64_condsel",
        "canonicalFileName": "csinv.xml",
        "operandFamilyId": "conditional-select"
    }
];

export const ENCODINGS = [
    {
        "instructionId": "LSR_LSRV",
        "encodingId": "LSR_LSRV_32_dp_2src",
        "mnemonic": "LSRV",
        "className": "Integer",
        "fileName": "lsr_lsrv.xml",
        "mask": 4292934656,
        "value": 448799744,
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
        "canonicalEncodingId": "LSRV_32_dp_2src",
        "canonicalFileName": "lsrv.xml",
        "operandFamilyId": "two-source-integer"
    },
    {
        "instructionId": "LSR_LSRV",
        "encodingId": "LSR_LSRV_64_dp_2src",
        "mnemonic": "LSRV",
        "className": "Integer",
        "fileName": "lsr_lsrv.xml",
        "mask": 4292934656,
        "value": 2596283392,
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
        "canonicalEncodingId": "LSRV_64_dp_2src",
        "canonicalFileName": "lsrv.xml",
        "operandFamilyId": "two-source-integer"
    }
];

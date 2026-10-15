export const ENCODINGS = [
    {
        "instructionId": "UMAX_reg",
        "encodingId": "UMAX_32_dp_2src",
        "mnemonic": "UMAX",
        "className": "Integer",
        "fileName": "umax_reg.xml",
        "mask": 4292934656,
        "value": 448816128,
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
                "name": "opcode",
                "lsb": 10,
                "width": 6
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
        "features": [
            "FEAT_CSSC"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_CSSC",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "two-source-integer"
    },
    {
        "instructionId": "UMAX_reg",
        "encodingId": "UMAX_64_dp_2src",
        "mnemonic": "UMAX",
        "className": "Integer",
        "fileName": "umax_reg.xml",
        "mask": 4292934656,
        "value": 2596299776,
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
                "name": "opcode",
                "lsb": 10,
                "width": 6
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
        "features": [
            "FEAT_CSSC"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_CSSC",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "two-source-integer"
    }
];

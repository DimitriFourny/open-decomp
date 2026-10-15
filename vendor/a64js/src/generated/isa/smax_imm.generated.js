export const ENCODINGS = [
    {
        "instructionId": "SMAX_imm",
        "encodingId": "SMAX_32_minmax_imm",
        "mnemonic": "SMAX",
        "className": "Integer",
        "fileName": "smax_imm.xml",
        "mask": 4294705152,
        "value": 297795584,
        "bitCount": 14,
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
                "name": "opc",
                "lsb": 18,
                "width": 4
            },
            {
                "name": "imm8",
                "lsb": 10,
                "width": 8
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
        "operandFamilyId": "min-max-immediate"
    },
    {
        "instructionId": "SMAX_imm",
        "encodingId": "SMAX_64_minmax_imm",
        "mnemonic": "SMAX",
        "className": "Integer",
        "fileName": "smax_imm.xml",
        "mask": 4294705152,
        "value": 2445279232,
        "bitCount": 14,
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
                "name": "opc",
                "lsb": 18,
                "width": 4
            },
            {
                "name": "imm8",
                "lsb": 10,
                "width": 8
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
        "operandFamilyId": "min-max-immediate"
    }
];

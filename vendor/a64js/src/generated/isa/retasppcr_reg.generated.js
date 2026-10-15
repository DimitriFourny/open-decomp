export const ENCODINGS = [
    {
        "instructionId": "RETASPPCR_reg",
        "encodingId": "RETAASPPCR_64M_branch_reg",
        "mnemonic": "RETAASPPCR",
        "className": "Integer",
        "fileName": "retasppcr_reg.xml",
        "mask": 4294967264,
        "value": 3596553184,
        "bitCount": 27,
        "fields": [
            {
                "name": "opc",
                "lsb": 21,
                "width": 4
            },
            {
                "name": "op2",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "M",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rm",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_PAuth_LR"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_PAuth_LR",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "pauth-lr-return-register"
    },
    {
        "instructionId": "RETASPPCR_reg",
        "encodingId": "RETABSPPCR_64M_branch_reg",
        "mnemonic": "RETABSPPCR",
        "className": "Integer",
        "fileName": "retasppcr_reg.xml",
        "mask": 4294967264,
        "value": 3596554208,
        "bitCount": 27,
        "fields": [
            {
                "name": "opc",
                "lsb": 21,
                "width": 4
            },
            {
                "name": "op2",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "M",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rm",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_PAuth_LR"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_PAuth_LR",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "pauth-lr-return-register"
    }
];

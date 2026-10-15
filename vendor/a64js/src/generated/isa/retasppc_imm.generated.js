export const ENCODINGS = [
    {
        "instructionId": "RETASPPC_imm",
        "encodingId": "RETAASPPC_only_miscbranch",
        "mnemonic": "RETAASPPC",
        "className": "Integer",
        "fileName": "retasppc_imm.xml",
        "mask": 4292870175,
        "value": 1426063391,
        "bitCount": 16,
        "fields": [
            {
                "name": "opc",
                "lsb": 21,
                "width": 3
            },
            {
                "name": "imm16",
                "lsb": 5,
                "width": 16
            },
            {
                "name": "op2",
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
        "operandFamilyId": "label-from-imm16-negative"
    },
    {
        "instructionId": "RETASPPC_imm",
        "encodingId": "RETABSPPC_only_miscbranch",
        "mnemonic": "RETABSPPC",
        "className": "Integer",
        "fileName": "retasppc_imm.xml",
        "mask": 4292870175,
        "value": 1428160543,
        "bitCount": 16,
        "fields": [
            {
                "name": "opc",
                "lsb": 21,
                "width": 3
            },
            {
                "name": "imm16",
                "lsb": 5,
                "width": 16
            },
            {
                "name": "op2",
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
        "operandFamilyId": "label-from-imm16-negative"
    }
];

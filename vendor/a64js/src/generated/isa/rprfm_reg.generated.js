export const ENCODINGS = [
    {
        "instructionId": "RPRFM_reg",
        "encodingId": "RPRFM_R_ldst_regoff",
        "mnemonic": "RPRFM",
        "className": "Integer",
        "fileName": "rprfm_reg.xml",
        "mask": 4292889624,
        "value": 4171253784,
        "bitCount": 16,
        "fields": [
            {
                "name": "size",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "option",
                "lsb": 13,
                "width": 3
            },
            {
                "name": "S",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_RPRFM"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_RPRFM",
                        "implemented": false
                    }
                ],
                "outcome": "nop"
            }
        ],
        "operandFamilyId": "rprfm"
    }
];

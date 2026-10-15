export const ENCODINGS = [
    {
        "instructionId": "whilelo_p_p_rr",
        "encodingId": "whilelo_p_p_rr_",
        "mnemonic": "WHILELO",
        "className": "SVE",
        "fileName": "whilelo_p_p_rr.xml",
        "mask": 4280347664,
        "value": 622857216,
        "bitCount": 15,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "sf",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "U",
                "lsb": 11,
                "width": 1
            },
            {
                "name": "lt",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "eq",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "Pd",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [
            "FEAT_SVE || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-while-compare"
    }
];

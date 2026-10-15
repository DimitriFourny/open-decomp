export const ENCODINGS = [
    {
        "instructionId": "whilehi_p_p_rr",
        "encodingId": "whilehi_p_p_rr_",
        "mnemonic": "WHILEHI",
        "className": "SVE2",
        "fileName": "whilehi_p_p_rr.xml",
        "mask": 4280347664,
        "value": 622856208,
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
            "FEAT_SVE2 || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2",
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

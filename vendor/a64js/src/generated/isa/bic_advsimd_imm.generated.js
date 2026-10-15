export const ENCODINGS = [
    {
        "instructionId": "BIC_advsimd_imm",
        "encodingId": "BIC_asimdimm_L_hl",
        "mnemonic": "BIC",
        "className": "Shifted immediate",
        "fileName": "bic_advsimd_imm.xml",
        "mask": 3220757504,
        "value": 788567040,
        "bitCount": 17,
        "fields": [
            {
                "name": "Q",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "a",
                "lsb": 18,
                "width": 1
            },
            {
                "name": "b",
                "lsb": 17,
                "width": 1
            },
            {
                "name": "c",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "cmode",
                "lsb": 12,
                "width": 4
            },
            {
                "name": "o2",
                "lsb": 11,
                "width": 1
            },
            {
                "name": "d",
                "lsb": 9,
                "width": 1
            },
            {
                "name": "e",
                "lsb": 8,
                "width": 1
            },
            {
                "name": "f",
                "lsb": 7,
                "width": 1
            },
            {
                "name": "g",
                "lsb": 6,
                "width": 1
            },
            {
                "name": "h",
                "lsb": 5,
                "width": 1
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_AdvSIMD"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_AdvSIMD",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-move-immediate"
    },
    {
        "instructionId": "BIC_advsimd_imm",
        "encodingId": "BIC_asimdimm_L_sl",
        "mnemonic": "BIC",
        "className": "Shifted immediate",
        "fileName": "bic_advsimd_imm.xml",
        "mask": 3220741120,
        "value": 788534272,
        "bitCount": 16,
        "fields": [
            {
                "name": "Q",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "a",
                "lsb": 18,
                "width": 1
            },
            {
                "name": "b",
                "lsb": 17,
                "width": 1
            },
            {
                "name": "c",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "cmode",
                "lsb": 12,
                "width": 4
            },
            {
                "name": "o2",
                "lsb": 11,
                "width": 1
            },
            {
                "name": "d",
                "lsb": 9,
                "width": 1
            },
            {
                "name": "e",
                "lsb": 8,
                "width": 1
            },
            {
                "name": "f",
                "lsb": 7,
                "width": 1
            },
            {
                "name": "g",
                "lsb": 6,
                "width": 1
            },
            {
                "name": "h",
                "lsb": 5,
                "width": 1
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_AdvSIMD"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_AdvSIMD",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-move-immediate"
    }
];

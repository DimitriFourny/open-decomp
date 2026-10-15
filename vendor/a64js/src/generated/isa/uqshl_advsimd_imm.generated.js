export const ENCODINGS = [
    {
        "instructionId": "UQSHL_advsimd_imm",
        "encodingId": "UQSHL_asisdshf_R",
        "mnemonic": "UQSHL",
        "className": "Scalar",
        "fileName": "uqshl_advsimd_imm.xml",
        "mask": 4286643200,
        "value": 2130736128,
        "bitCount": 15,
        "fields": [
            {
                "name": "U",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "immh",
                "lsb": 19,
                "width": 4
            },
            {
                "name": "immb",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "op",
                "lsb": 12,
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
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "immh",
                        "mask": 15,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-immediate-shift"
    },
    {
        "instructionId": "UQSHL_advsimd_imm",
        "encodingId": "UQSHL_asimdshf_R",
        "mnemonic": "UQSHL",
        "className": "Vector",
        "fileName": "uqshl_advsimd_imm.xml",
        "mask": 3212901376,
        "value": 788558848,
        "bitCount": 14,
        "fields": [
            {
                "name": "Q",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "U",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "immh",
                "lsb": 19,
                "width": 4
            },
            {
                "name": "immb",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "op",
                "lsb": 12,
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
            },
            {
                "all": [
                    {
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "immh",
                                "msb": 3,
                                "lsb": 3
                            },
                            {
                                "field": "Q",
                                "msb": 0,
                                "lsb": 0
                            }
                        ],
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-immediate-shift"
    }
];

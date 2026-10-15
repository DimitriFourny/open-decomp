export const ENCODINGS = [
    {
        "instructionId": "SRI_advsimd",
        "encodingId": "SRI_asisdshf_R",
        "mnemonic": "SRI",
        "className": "Scalar",
        "fileName": "sri_advsimd.xml",
        "mask": 4290837504,
        "value": 2134918144,
        "bitCount": 16,
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
                "name": "opcode",
                "lsb": 11,
                "width": 5
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
                        "kind": "ne",
                        "field": "immh",
                        "mask": 8,
                        "lsb": 3,
                        "value": 1
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-immediate-shift"
    },
    {
        "instructionId": "SRI_advsimd",
        "encodingId": "SRI_asimdshf_R",
        "mnemonic": "SRI",
        "className": "Vector",
        "fileName": "sri_advsimd.xml",
        "mask": 3212901376,
        "value": 788546560,
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
                "name": "opcode",
                "lsb": 11,
                "width": 5
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

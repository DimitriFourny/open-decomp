export const ENCODINGS = [
    {
        "instructionId": "MOVI_advsimd",
        "encodingId": "MOVI_asimdimm_D_ds",
        "mnemonic": "MOVI",
        "className": "Advanced SIMD",
        "fileName": "movi_advsimd.xml",
        "mask": 4294507520,
        "value": 788587520,
        "bitCount": 19,
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
        "instructionId": "MOVI_advsimd",
        "encodingId": "MOVI_asimdimm_D2_d",
        "mnemonic": "MOVI",
        "className": "Advanced SIMD",
        "fileName": "movi_advsimd.xml",
        "mask": 4294507520,
        "value": 1862329344,
        "bitCount": 19,
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
        "instructionId": "MOVI_advsimd",
        "encodingId": "MOVI_asimdimm_N_b",
        "mnemonic": "MOVI",
        "className": "Advanced SIMD",
        "fileName": "movi_advsimd.xml",
        "mask": 3220765696,
        "value": 251716608,
        "bitCount": 18,
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
        "instructionId": "MOVI_advsimd",
        "encodingId": "MOVI_asimdimm_L_hl",
        "mnemonic": "MOVI",
        "className": "Advanced SIMD",
        "fileName": "movi_advsimd.xml",
        "mask": 3220757504,
        "value": 251692032,
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
        "instructionId": "MOVI_advsimd",
        "encodingId": "MOVI_asimdimm_M_sm",
        "mnemonic": "MOVI",
        "className": "Advanced SIMD",
        "fileName": "movi_advsimd.xml",
        "mask": 3220761600,
        "value": 251708416,
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
        "instructionId": "MOVI_advsimd",
        "encodingId": "MOVI_asimdimm_L_sl",
        "mnemonic": "MOVI",
        "className": "Advanced SIMD",
        "fileName": "movi_advsimd.xml",
        "mask": 3220741120,
        "value": 251659264,
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

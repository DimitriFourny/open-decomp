export const ENCODINGS = [
    {
        "instructionId": "FMOV_advsimd",
        "encodingId": "FMOV_asimdimm_D2_d",
        "mnemonic": "FMOV",
        "className": "Single-precision and double-precision",
        "fileName": "fmov_advsimd.xml",
        "mask": 4294507520,
        "value": 1862333440,
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
            },
            {
                "all": [
                    {
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "cmode",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op",
                                "msb": 0,
                                "lsb": 0
                            }
                        ],
                        "value": 31
                    },
                    {
                        "kind": "eq",
                        "field": "Q",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-move-immediate"
    },
    {
        "instructionId": "FMOV_advsimd",
        "encodingId": "FMOV_asimdimm_H_h",
        "mnemonic": "FMOV",
        "className": "Half-precision",
        "fileName": "fmov_advsimd.xml",
        "mask": 3220765696,
        "value": 251722752,
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
            "FEAT_AdvSIMD && FEAT_FP16"
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
                        "kind": "feature",
                        "feature": "FEAT_FP16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-move-immediate"
    },
    {
        "instructionId": "FMOV_advsimd",
        "encodingId": "FMOV_asimdimm_S_s",
        "mnemonic": "FMOV",
        "className": "Single-precision and double-precision",
        "fileName": "fmov_advsimd.xml",
        "mask": 3220765696,
        "value": 251720704,
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
            },
            {
                "all": [
                    {
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "cmode",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op",
                                "msb": 0,
                                "lsb": 0
                            }
                        ],
                        "value": 31
                    },
                    {
                        "kind": "eq",
                        "field": "Q",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-move-immediate"
    }
];

export const ENCODINGS = [
    {
        "instructionId": "MVNI_advsimd",
        "encodingId": "MVNI_asimdimm_L_hl",
        "mnemonic": "MVNI",
        "className": "Advanced SIMD",
        "fileName": "mvni_advsimd.xml",
        "mask": 3220757504,
        "value": 788562944,
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
        "instructionId": "MVNI_advsimd",
        "encodingId": "MVNI_asimdimm_M_sm",
        "mnemonic": "MVNI",
        "className": "Advanced SIMD",
        "fileName": "mvni_advsimd.xml",
        "mask": 3220761600,
        "value": 788579328,
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
        "instructionId": "MVNI_advsimd",
        "encodingId": "MVNI_asimdimm_L_sl",
        "mnemonic": "MVNI",
        "className": "Advanced SIMD",
        "fileName": "mvni_advsimd.xml",
        "mask": 3220741120,
        "value": 788530176,
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

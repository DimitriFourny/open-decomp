export const ENCODINGS = [
    {
        "instructionId": "FMAXNMP_advsimd_pair",
        "encodingId": "FMAXNMP_asisdpair_only_H",
        "mnemonic": "FMAXNMP",
        "className": "Half-precision",
        "fileName": "fmaxnmp_advsimd_pair.xml",
        "mask": 4294966272,
        "value": 1580255232,
        "bitCount": 22,
        "fields": [
            {
                "name": "U",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "o1",
                "lsb": 23,
                "width": 1
            },
            {
                "name": "sz",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "opcode",
                "lsb": 12,
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
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "sz",
                        "mask": 1,
                        "lsb": 0,
                        "value": 1
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-floating-pairwise"
    },
    {
        "instructionId": "FMAXNMP_advsimd_pair",
        "encodingId": "FMAXNMP_asisdpair_only_SD",
        "mnemonic": "FMAXNMP",
        "className": "Single-precision and double-precision",
        "fileName": "fmaxnmp_advsimd_pair.xml",
        "mask": 4290771968,
        "value": 2117126144,
        "bitCount": 21,
        "fields": [
            {
                "name": "U",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "o1",
                "lsb": 23,
                "width": 1
            },
            {
                "name": "sz",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "opcode",
                "lsb": 12,
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
            }
        ],
        "operandFamilyId": "advsimd-floating-pairwise"
    }
];

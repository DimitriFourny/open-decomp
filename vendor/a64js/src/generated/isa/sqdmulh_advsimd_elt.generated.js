export const ENCODINGS = [
    {
        "instructionId": "SQDMULH_advsimd_elt",
        "encodingId": "SQDMULH_asisdelem_R",
        "mnemonic": "SQDMULH",
        "className": "Scalar",
        "fileName": "sqdmulh_advsimd_elt.xml",
        "mask": 4278252544,
        "value": 1593884672,
        "bitCount": 13,
        "fields": [
            {
                "name": "U",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "L",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "M",
                "lsb": 20,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "op",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "H",
                "lsb": 11,
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
                        "kind": "ne",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "ne",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-saturating-rounding-doubling-multiply"
    },
    {
        "instructionId": "SQDMULH_advsimd_elt",
        "encodingId": "SQDMULH_asimdelem_R",
        "mnemonic": "SQDMULH",
        "className": "Vector",
        "fileName": "sqdmulh_advsimd_elt.xml",
        "mask": 3204510720,
        "value": 251707392,
        "bitCount": 12,
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
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "L",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "M",
                "lsb": 20,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "op",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "H",
                "lsb": 11,
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
                        "kind": "ne",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "ne",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-saturating-rounding-doubling-multiply"
    }
];

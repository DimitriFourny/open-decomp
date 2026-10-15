export const ENCODINGS = [
    {
        "instructionId": "DUP_advsimd_elt",
        "encodingId": "DUP_asisdone_only",
        "mnemonic": "DUP",
        "className": "Scalar",
        "fileName": "dup_advsimd_elt.xml",
        "mask": 4292934656,
        "value": 1577059328,
        "bitCount": 17,
        "fields": [
            {
                "name": "op",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "imm5",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "imm4",
                "lsb": 11,
                "width": 4
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
                        "field": "imm5",
                        "mask": 15,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-scalar-duplicate-element"
    },
    {
        "instructionId": "DUP_advsimd_elt",
        "encodingId": "DUP_asimdins_DV_v",
        "mnemonic": "DUP",
        "className": "Vector",
        "fileName": "dup_advsimd_elt.xml",
        "mask": 3219192832,
        "value": 234882048,
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
                "name": "imm5",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "imm4",
                "lsb": 11,
                "width": 4
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
                        "field": "imm5",
                        "mask": 15,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "imm5",
                        "mask": 15,
                        "lsb": 0,
                        "value": 8
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
        "operandFamilyId": "advsimd-scalar-duplicate-element"
    }
];

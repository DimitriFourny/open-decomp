export const ENCODINGS = [
    {
        "instructionId": "UQRSHRN_advsimd",
        "encodingId": "UQRSHRN_asisdshf_N",
        "mnemonic": "UQRSHRN",
        "className": "Scalar",
        "fileName": "uqrshrn_advsimd.xml",
        "mask": 4286643200,
        "value": 2130746368,
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
                        "kind": "eq",
                        "field": "immh",
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
                        "field": "immh",
                        "mask": 8,
                        "lsb": 3,
                        "value": 1
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-narrowing-immediate-shift"
    },
    {
        "instructionId": "UQRSHRN_advsimd",
        "encodingId": "UQRSHRN_asimdshf_N",
        "mnemonic": "UQRSHRN",
        "className": "Vector",
        "fileName": "uqrshrn_advsimd.xml",
        "mask": 3212901376,
        "value": 788569088,
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
                        "kind": "eq",
                        "field": "immh",
                        "mask": 8,
                        "lsb": 3,
                        "value": 1
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-narrowing-immediate-shift"
    }
];

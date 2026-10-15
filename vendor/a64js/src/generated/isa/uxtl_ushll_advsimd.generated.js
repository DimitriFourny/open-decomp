export const ENCODINGS = [
    {
        "instructionId": "UXTL_USHLL_advsimd",
        "encodingId": "UXTL_USHLL_asimdshf_L",
        "mnemonic": "USHLL",
        "className": "Vector",
        "fileName": "uxtl_ushll_advsimd.xml",
        "mask": 3213360128,
        "value": 788571136,
        "bitCount": 17,
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
        "canonicalEncodingId": "USHLL_asimdshf_L",
        "canonicalFileName": "ushll_advsimd.xml",
        "operandFamilyId": "advsimd-extend-long"
    }
];

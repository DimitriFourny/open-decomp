export const ENCODINGS = [
    {
        "instructionId": "SXTL_SSHLL_advsimd",
        "encodingId": "SXTL_SSHLL_asimdshf_L",
        "mnemonic": "SSHLL",
        "className": "Vector",
        "fileName": "sxtl_sshll_advsimd.xml",
        "mask": 3213360128,
        "value": 251700224,
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
        "canonicalEncodingId": "SSHLL_asimdshf_L",
        "canonicalFileName": "sshll_advsimd.xml",
        "operandFamilyId": "advsimd-extend-long"
    }
];

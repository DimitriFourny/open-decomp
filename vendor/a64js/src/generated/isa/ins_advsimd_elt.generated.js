export const ENCODINGS = [
    {
        "instructionId": "INS_advsimd_elt",
        "encodingId": "INS_asimdins_IV_v",
        "mnemonic": "INS",
        "className": "Advanced SIMD",
        "fileName": "ins_advsimd_elt.xml",
        "mask": 4292903936,
        "value": 1845494784,
        "bitCount": 13,
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
            }
        ],
        "operandFamilyId": "advsimd-copy-element-to-element"
    }
];

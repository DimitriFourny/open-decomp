export const ENCODINGS = [
    {
        "instructionId": "SDOT_advsimd_elt",
        "encodingId": "SDOT_asimdelem_D",
        "mnemonic": "SDOT",
        "className": "Vector",
        "fileName": "sdot_advsimd_elt.xml",
        "mask": 3204510720,
        "value": 251715584,
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
                "name": "opcode",
                "lsb": 12,
                "width": 4
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
            "FEAT_DotProd"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_DotProd",
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
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-dot-product"
    }
];

export const ENCODINGS = [
    {
        "instructionId": "FMLALB_advsimd_elem",
        "encodingId": "FMLALB_asimdelem_H",
        "mnemonic": "FMLALB",
        "className": "Advanced SIMD",
        "fileName": "fmlalb_advsimd_elem.xml",
        "mask": 4290835456,
        "value": 264241152,
        "bitCount": 15,
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
            "FEAT_FP8FMA"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_FP8FMA",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-fp-long-multiply-accumulate"
    },
    {
        "instructionId": "FMLALB_advsimd_elem",
        "encodingId": "FMLALT_asimdelem_H",
        "mnemonic": "FMLALT",
        "className": "Advanced SIMD",
        "fileName": "fmlalb_advsimd_elem.xml",
        "mask": 4290835456,
        "value": 1337982976,
        "bitCount": 15,
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
            "FEAT_FP8FMA"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_FP8FMA",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-fp-long-multiply-accumulate"
    }
];

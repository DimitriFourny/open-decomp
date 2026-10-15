export const ENCODINGS = [
    {
        "instructionId": "FCVTN_advsimd_328",
        "encodingId": "FCVTN_asimdsame2_H",
        "mnemonic": "FCVTN",
        "className": "Advanced SIMD",
        "fileName": "fcvtn_advsimd_328.xml",
        "mask": 3219192832,
        "value": 234943488,
        "bitCount": 16,
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
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "opcode",
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
            "FEAT_FP8"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_FP8",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-fp8-narrow-pair"
    }
];

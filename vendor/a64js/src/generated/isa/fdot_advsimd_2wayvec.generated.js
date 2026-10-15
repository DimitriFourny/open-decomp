export const ENCODINGS = [
    {
        "instructionId": "FDOT_advsimd_2wayvec",
        "encodingId": "FDOT_asimdsame2_D",
        "mnemonic": "FDOT",
        "className": "Advanced SIMD",
        "fileName": "fdot_advsimd_2wayvec.xml",
        "mask": 3219192832,
        "value": 239139840,
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
            "FEAT_FP8DOT2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_FP8DOT2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-fp8-dot"
    }
];

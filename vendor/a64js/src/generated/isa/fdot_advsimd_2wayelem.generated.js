export const ENCODINGS = [
    {
        "instructionId": "FDOT_advsimd_2wayelem",
        "encodingId": "FDOT_asimdelem_G",
        "mnemonic": "FDOT",
        "className": "Advanced SIMD",
        "fileName": "fdot_advsimd_2wayelem.xml",
        "mask": 3217093632,
        "value": 255852544,
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

export const ENCODINGS = [
    {
        "instructionId": "BFCVT_float",
        "encodingId": "BFCVT_BS_floatdp1",
        "mnemonic": "BFCVT",
        "className": "Single-precision to BFloat16",
        "fileName": "bfcvt_float.xml",
        "mask": 4294966272,
        "value": 509820928,
        "bitCount": 22,
        "fields": [
            {
                "name": "M",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "ftype",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "opcode",
                "lsb": 15,
                "width": 6
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
            "FEAT_BF16"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_BF16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-bfloat16-conversion"
    }
];

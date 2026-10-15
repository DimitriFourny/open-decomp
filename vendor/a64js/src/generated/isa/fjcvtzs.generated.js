export const ENCODINGS = [
    {
        "instructionId": "FJCVTZS",
        "encodingId": "FJCVTZS_32D_float2int",
        "mnemonic": "FJCVTZS",
        "className": "Double-precision to 32-bit",
        "fileName": "fjcvtzs.xml",
        "mask": 4294966272,
        "value": 511574016,
        "bitCount": 22,
        "fields": [
            {
                "name": "sf",
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
                "name": "rmode",
                "lsb": 19,
                "width": 2
            },
            {
                "name": "opcode",
                "lsb": 16,
                "width": 3
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
            "FEAT_JSCVT"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_JSCVT",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "fjcvtzs"
    }
];

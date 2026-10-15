export const ENCODINGS = [
    {
        "instructionId": "AUTIBSPPCR",
        "encodingId": "AUTIBSPPCR_64LRR_dp_1src",
        "mnemonic": "AUTIBSPPCR",
        "className": "Integer",
        "fileName": "autibsppcr.xml",
        "mask": 4294966303,
        "value": 3670119454,
        "bitCount": 27,
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
                "name": "opcode2",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "opcode",
                "lsb": 10,
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
            "FEAT_PAuth_LR"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_PAuth_LR",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "pauth-lr-auth-register"
    }
];

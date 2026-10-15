export const ENCODINGS = [
    {
        "instructionId": "str_z_bi",
        "encodingId": "str_z_bi_",
        "mnemonic": "STR",
        "className": "SVE",
        "fileName": "str_z_bi.xml",
        "mask": 4290830336,
        "value": 3850387456,
        "bitCount": 13,
        "fields": [
            {
                "name": "imm9h",
                "lsb": 16,
                "width": 6
            },
            {
                "name": "imm9l",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-predicate-memory"
    }
];

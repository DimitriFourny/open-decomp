export const ENCODINGS = [
    {
        "instructionId": "smin_z_zi",
        "encodingId": "smin_z_zi_",
        "mnemonic": "SMIN",
        "className": "SVE",
        "fileName": "smin_z_zi.xml",
        "mask": 4282376192,
        "value": 623558656,
        "bitCount": 17,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "U",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "o2",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "imm8",
                "lsb": 5,
                "width": 8
            },
            {
                "name": "Zdn",
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
        "operandFamilyId": "sve-destructive-immediate"
    }
];

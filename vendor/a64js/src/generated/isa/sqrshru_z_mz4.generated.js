export const ENCODINGS = [
    {
        "instructionId": "sqrshru_z_mz4",
        "encodingId": "sqrshru_z_mz4_",
        "mnemonic": "SQRSHRU",
        "className": "SME2",
        "fileName": "sqrshru_z_mz4.xml",
        "mask": 4280351840,
        "value": 3240155200,
        "bitCount": 17,
        "fields": [
            {
                "name": "tsize",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm5",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "N",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Zn",
                "lsb": 7,
                "width": 3
            },
            {
                "name": "op",
                "lsb": 6,
                "width": 1
            },
            {
                "name": "U",
                "lsb": 5,
                "width": 1
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SME2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "tsize",
                        "mask": 3,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-narrowing-shift"
    }
];

export const ENCODINGS = [
    {
        "instructionId": "dup_z_zi",
        "encodingId": "dup_z_zi_",
        "mnemonic": "DUP",
        "className": "SVE",
        "fileName": "dup_z_zi.xml",
        "mask": 4280351744,
        "value": 85991424,
        "bitCount": 15,
        "fields": [
            {
                "name": "imm2",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "tsz",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zd",
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
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "tsz",
                        "mask": 31,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-dup-indexed"
    }
];

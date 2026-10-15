export const ENCODINGS = [
    {
        "instructionId": "decp_z_p_z",
        "encodingId": "decp_z_p_z_",
        "mnemonic": "DECP",
        "className": "SVE",
        "fileName": "decp_z_p_z.xml",
        "mask": 4282383872,
        "value": 623738880,
        "bitCount": 21,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "op",
                "lsb": 17,
                "width": 1
            },
            {
                "name": "D",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "opc2",
                "lsb": 9,
                "width": 2
            },
            {
                "name": "Pm",
                "lsb": 5,
                "width": 4
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
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-inc-dec-predicate-vector"
    }
];

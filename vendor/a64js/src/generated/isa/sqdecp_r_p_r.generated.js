export const ENCODINGS = [
    {
        "instructionId": "sqdecp_r_p_r",
        "encodingId": "sqdecp_r_p_r_sx",
        "mnemonic": "SQDECP",
        "className": "32-bit",
        "fileName": "sqdecp_r_p_r.xml",
        "mask": 4282383872,
        "value": 623544320,
        "bitCount": 21,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "D",
                "lsb": 17,
                "width": 1
            },
            {
                "name": "U",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "sf",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 9,
                "width": 1
            },
            {
                "name": "Pm",
                "lsb": 5,
                "width": 4
            },
            {
                "name": "Rdn",
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
        "operandFamilyId": "sve-inc-dec-predicate-scalar"
    },
    {
        "instructionId": "sqdecp_r_p_r",
        "encodingId": "sqdecp_r_p_r_x",
        "mnemonic": "SQDECP",
        "className": "64-bit",
        "fileName": "sqdecp_r_p_r.xml",
        "mask": 4282383872,
        "value": 623545344,
        "bitCount": 21,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "D",
                "lsb": 17,
                "width": 1
            },
            {
                "name": "U",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "sf",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 9,
                "width": 1
            },
            {
                "name": "Pm",
                "lsb": 5,
                "width": 4
            },
            {
                "name": "Rdn",
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
        "operandFamilyId": "sve-inc-dec-predicate-scalar"
    }
];

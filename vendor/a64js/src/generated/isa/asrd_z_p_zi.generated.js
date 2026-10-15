export const ENCODINGS = [
    {
        "instructionId": "asrd_z_p_zi",
        "encodingId": "asrd_z_p_zi_",
        "mnemonic": "ASRD",
        "className": "SVE",
        "fileName": "asrd_z_p_zi.xml",
        "mask": 4282376192,
        "value": 67403776,
        "bitCount": 17,
        "fields": [
            {
                "name": "tszh",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "opc",
                "lsb": 18,
                "width": 2
            },
            {
                "name": "L",
                "lsb": 17,
                "width": 1
            },
            {
                "name": "U",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "tszl",
                "lsb": 8,
                "width": 2
            },
            {
                "name": "imm3",
                "lsb": 5,
                "width": 3
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
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "tszh",
                                "msb": 1,
                                "lsb": 0
                            },
                            {
                                "field": "tszl",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-shift-immediate"
    }
];

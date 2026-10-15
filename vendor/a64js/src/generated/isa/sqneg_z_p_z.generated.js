export const ENCODINGS = [
    {
        "instructionId": "sqneg_z_p_z",
        "encodingId": "sqneg_z_p_z_m",
        "mnemonic": "SQNEG",
        "className": "Merging",
        "fileName": "sqneg_z_p_z.xml",
        "mask": 4282376192,
        "value": 1141481472,
        "bitCount": 17,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Q",
                "lsb": 19,
                "width": 1
            },
            {
                "name": "Z",
                "lsb": 17,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
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
            "FEAT_SVE2 || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2",
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
        "operandFamilyId": "sve-predicated-unary"
    },
    {
        "instructionId": "sqneg_z_p_z",
        "encodingId": "sqneg_z_p_z_z",
        "mnemonic": "SQNEG",
        "className": "Zeroing",
        "fileName": "sqneg_z_p_z.xml",
        "mask": 4282376192,
        "value": 1141612544,
        "bitCount": 17,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Q",
                "lsb": 19,
                "width": 1
            },
            {
                "name": "Z",
                "lsb": 17,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
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
            "FEAT_SVE2p2 || FEAT_SME2p2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-predicated-unary"
    }
];

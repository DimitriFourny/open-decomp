export const ENCODINGS = [
    {
        "instructionId": "decb_r_rs",
        "encodingId": "decb_r_rs_",
        "mnemonic": "DECB",
        "className": "Byte",
        "fileName": "decb_r_rs.xml",
        "mask": 4293983232,
        "value": 70312960,
        "bitCount": 18,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm4",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "D",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "pattern",
                "lsb": 5,
                "width": 5
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
        "operandFamilyId": "sve-inc-dec-scalar"
    },
    {
        "instructionId": "decb_r_rs",
        "encodingId": "decd_r_rs_",
        "mnemonic": "DECD",
        "className": "Doubleword",
        "fileName": "decb_r_rs.xml",
        "mask": 4293983232,
        "value": 82895872,
        "bitCount": 18,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm4",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "D",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "pattern",
                "lsb": 5,
                "width": 5
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
        "operandFamilyId": "sve-inc-dec-scalar"
    },
    {
        "instructionId": "decb_r_rs",
        "encodingId": "dech_r_rs_",
        "mnemonic": "DECH",
        "className": "Halfword",
        "fileName": "decb_r_rs.xml",
        "mask": 4293983232,
        "value": 74507264,
        "bitCount": 18,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm4",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "D",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "pattern",
                "lsb": 5,
                "width": 5
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
        "operandFamilyId": "sve-inc-dec-scalar"
    },
    {
        "instructionId": "decb_r_rs",
        "encodingId": "decw_r_rs_",
        "mnemonic": "DECW",
        "className": "Word",
        "fileName": "decb_r_rs.xml",
        "mask": 4293983232,
        "value": 78701568,
        "bitCount": 18,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm4",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "D",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "pattern",
                "lsb": 5,
                "width": 5
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
        "operandFamilyId": "sve-inc-dec-scalar"
    }
];

export const ENCODINGS = [
    {
        "instructionId": "ldnf1b_z_p_bi",
        "encodingId": "ldnf1b_z_p_bi_u16",
        "mnemonic": "LDNF1B",
        "className": "16-bit element",
        "fileName": "ldnf1b_z_p_bi.xml",
        "mask": 4293976064,
        "value": 2754650112,
        "bitCount": 15,
        "fields": [
            {
                "name": "dtype",
                "lsb": 21,
                "width": 4
            },
            {
                "name": "imm4",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "Pg",
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
            "FEAT_SVE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-fault-tolerant-load"
    },
    {
        "instructionId": "ldnf1b_z_p_bi",
        "encodingId": "ldnf1b_z_p_bi_u32",
        "mnemonic": "LDNF1B",
        "className": "32-bit element",
        "fileName": "ldnf1b_z_p_bi.xml",
        "mask": 4293976064,
        "value": 2756747264,
        "bitCount": 15,
        "fields": [
            {
                "name": "dtype",
                "lsb": 21,
                "width": 4
            },
            {
                "name": "imm4",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "Pg",
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
            "FEAT_SVE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-fault-tolerant-load"
    },
    {
        "instructionId": "ldnf1b_z_p_bi",
        "encodingId": "ldnf1b_z_p_bi_u64",
        "mnemonic": "LDNF1B",
        "className": "64-bit element",
        "fileName": "ldnf1b_z_p_bi.xml",
        "mask": 4293976064,
        "value": 2758844416,
        "bitCount": 15,
        "fields": [
            {
                "name": "dtype",
                "lsb": 21,
                "width": 4
            },
            {
                "name": "imm4",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "Pg",
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
            "FEAT_SVE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-fault-tolerant-load"
    },
    {
        "instructionId": "ldnf1b_z_p_bi",
        "encodingId": "ldnf1b_z_p_bi_u8",
        "mnemonic": "LDNF1B",
        "className": "8-bit element",
        "fileName": "ldnf1b_z_p_bi.xml",
        "mask": 4293976064,
        "value": 2752552960,
        "bitCount": 15,
        "fields": [
            {
                "name": "dtype",
                "lsb": 21,
                "width": 4
            },
            {
                "name": "imm4",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "Pg",
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
            "FEAT_SVE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-fault-tolerant-load"
    }
];

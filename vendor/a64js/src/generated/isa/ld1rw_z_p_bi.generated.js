export const ENCODINGS = [
    {
        "instructionId": "ld1rw_z_p_bi",
        "encodingId": "ld1rw_z_p_bi_u32",
        "mnemonic": "LD1RW",
        "className": "32-bit element",
        "fileName": "ld1rw_z_p_bi.xml",
        "mask": 4290830336,
        "value": 2235613184,
        "bitCount": 13,
        "fields": [
            {
                "name": "dtypeh",
                "lsb": 23,
                "width": 2
            },
            {
                "name": "imm6",
                "lsb": 16,
                "width": 6
            },
            {
                "name": "dtypel",
                "lsb": 13,
                "width": 2
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
        "operandFamilyId": "sve-replicate-load"
    },
    {
        "instructionId": "ld1rw_z_p_bi",
        "encodingId": "ld1rw_z_p_bi_u64",
        "mnemonic": "LD1RW",
        "className": "64-bit element",
        "fileName": "ld1rw_z_p_bi.xml",
        "mask": 4290830336,
        "value": 2235621376,
        "bitCount": 13,
        "fields": [
            {
                "name": "dtypeh",
                "lsb": 23,
                "width": 2
            },
            {
                "name": "imm6",
                "lsb": 16,
                "width": 6
            },
            {
                "name": "dtypel",
                "lsb": 13,
                "width": 2
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
        "operandFamilyId": "sve-replicate-load"
    }
];

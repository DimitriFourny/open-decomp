export const ENCODINGS = [
    {
        "instructionId": "ld1rsb_z_p_bi",
        "encodingId": "ld1rsb_z_p_bi_s16",
        "mnemonic": "LD1RSB",
        "className": "16-bit element",
        "fileName": "ld1rsb_z_p_bi.xml",
        "mask": 4290830336,
        "value": 2244001792,
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
        "instructionId": "ld1rsb_z_p_bi",
        "encodingId": "ld1rsb_z_p_bi_s32",
        "mnemonic": "LD1RSB",
        "className": "32-bit element",
        "fileName": "ld1rsb_z_p_bi.xml",
        "mask": 4290830336,
        "value": 2243993600,
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
        "instructionId": "ld1rsb_z_p_bi",
        "encodingId": "ld1rsb_z_p_bi_s64",
        "mnemonic": "LD1RSB",
        "className": "64-bit element",
        "fileName": "ld1rsb_z_p_bi.xml",
        "mask": 4290830336,
        "value": 2243985408,
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

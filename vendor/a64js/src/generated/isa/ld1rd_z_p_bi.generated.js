export const ENCODINGS = [
    {
        "instructionId": "ld1rd_z_p_bi",
        "encodingId": "ld1rd_z_p_bi_u64",
        "mnemonic": "LD1RD",
        "className": "SVE",
        "fileName": "ld1rd_z_p_bi.xml",
        "mask": 4290830336,
        "value": 2244009984,
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

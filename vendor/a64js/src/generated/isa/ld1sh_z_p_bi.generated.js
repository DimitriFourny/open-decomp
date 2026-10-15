export const ENCODINGS = [
    {
        "instructionId": "ld1sh_z_p_bi",
        "encodingId": "ld1sh_z_p_bi_s32",
        "mnemonic": "LD1SH",
        "className": "32-bit element",
        "fileName": "ld1sh_z_p_bi.xml",
        "mask": 4293976064,
        "value": 2770378752,
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
        "operandFamilyId": "sve-contiguous-memory"
    },
    {
        "instructionId": "ld1sh_z_p_bi",
        "encodingId": "ld1sh_z_p_bi_s64",
        "mnemonic": "LD1SH",
        "className": "64-bit element",
        "fileName": "ld1sh_z_p_bi.xml",
        "mask": 4293976064,
        "value": 2768281600,
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
        "operandFamilyId": "sve-contiguous-memory"
    }
];

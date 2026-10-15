export const ENCODINGS = [
    {
        "instructionId": "ld1d_z_p_ai",
        "encodingId": "ld1d_z_p_ai_d",
        "mnemonic": "LD1D",
        "className": "SVE",
        "fileName": "ld1d_z_p_ai.xml",
        "mask": 4292927488,
        "value": 3315646464,
        "bitCount": 14,
        "fields": [
            {
                "name": "msz",
                "lsb": 23,
                "width": 2
            },
            {
                "name": "imm5",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "U",
                "lsb": 14,
                "width": 1
            },
            {
                "name": "ff",
                "lsb": 13,
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
        "operandFamilyId": "sve-contiguous-byte-memory"
    }
];

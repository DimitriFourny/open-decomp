export const ENCODINGS = [
    {
        "instructionId": "ld1rod_z_p_bi",
        "encodingId": "ld1rod_z_p_bi_u64",
        "mnemonic": "LD1ROD",
        "className": "SVE",
        "fileName": "ld1rod_z_p_bi.xml",
        "mask": 4293976064,
        "value": 2778734592,
        "bitCount": 15,
        "fields": [
            {
                "name": "msz",
                "lsb": 23,
                "width": 2
            },
            {
                "name": "ssz",
                "lsb": 21,
                "width": 2
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
            "FEAT_F64MM"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_F64MM",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-replicate-load"
    }
];

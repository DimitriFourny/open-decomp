export const ENCODINGS = [
    {
        "instructionId": "ld1roh_z_p_bi",
        "encodingId": "ld1roh_z_p_bi_u16",
        "mnemonic": "LD1ROH",
        "className": "SVE",
        "fileName": "ld1roh_z_p_bi.xml",
        "mask": 4293976064,
        "value": 2761957376,
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

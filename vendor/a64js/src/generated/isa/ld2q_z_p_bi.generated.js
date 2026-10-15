export const ENCODINGS = [
    {
        "instructionId": "ld2q_z_p_bi",
        "encodingId": "ld2q_z_p_bi_contiguous",
        "mnemonic": "LD2Q",
        "className": "SVE2",
        "fileName": "ld2q_z_p_bi.xml",
        "mask": 4293976064,
        "value": 2760957952,
        "bitCount": 15,
        "fields": [
            {
                "name": "num",
                "lsb": 23,
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
            "FEAT_SVE2p1 || FEAT_SME2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p1",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-contiguous-memory"
    }
];

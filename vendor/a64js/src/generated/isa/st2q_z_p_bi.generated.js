export const ENCODINGS = [
    {
        "instructionId": "st2q_z_p_bi",
        "encodingId": "st2q_z_p_bi_contiguous",
        "mnemonic": "ST2Q",
        "className": "SVE2",
        "fileName": "st2q_z_p_bi.xml",
        "mask": 4293976064,
        "value": 3829399552,
        "bitCount": 15,
        "fields": [
            {
                "name": "num",
                "lsb": 22,
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

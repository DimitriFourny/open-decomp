export const ENCODINGS = [
    {
        "instructionId": "ld1d_mz_p_bi",
        "encodingId": "ld1d_mz_p_bi_4",
        "mnemonic": "LD1D",
        "className": "Four registers",
        "fileName": "ld1d_mz_p_bi.xml",
        "mask": 4293976067,
        "value": 2688606208,
        "bitCount": 17,
        "fields": [
            {
                "name": "imm4",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "msz",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "PNg",
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
                "lsb": 2,
                "width": 3
            },
            {
                "name": "N",
                "lsb": 0,
                "width": 1
            }
        ],
        "features": [
            "FEAT_SME2 || FEAT_SVE2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-contiguous-memory"
    },
    {
        "instructionId": "ld1d_mz_p_bi",
        "encodingId": "ld1d_mz_p_bi_2",
        "mnemonic": "LD1D",
        "className": "Two registers",
        "fileName": "ld1d_mz_p_bi.xml",
        "mask": 4293976065,
        "value": 2688573440,
        "bitCount": 16,
        "fields": [
            {
                "name": "imm4",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "msz",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "PNg",
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
                "lsb": 1,
                "width": 4
            },
            {
                "name": "N",
                "lsb": 0,
                "width": 1
            }
        ],
        "features": [
            "FEAT_SME2 || FEAT_SVE2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-contiguous-memory"
    }
];

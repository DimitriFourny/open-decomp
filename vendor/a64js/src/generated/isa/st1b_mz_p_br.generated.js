export const ENCODINGS = [
    {
        "instructionId": "st1b_mz_p_br",
        "encodingId": "st1b_mz_p_br_4",
        "mnemonic": "ST1B",
        "className": "Four registers",
        "fileName": "st1b_mz_p_br.xml",
        "mask": 4292927491,
        "value": 2686484480,
        "bitCount": 16,
        "fields": [
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
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
        "instructionId": "st1b_mz_p_br",
        "encodingId": "st1b_mz_p_br_2",
        "mnemonic": "ST1B",
        "className": "Two registers",
        "fileName": "st1b_mz_p_br.xml",
        "mask": 4292927489,
        "value": 2686451712,
        "bitCount": 15,
        "fields": [
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
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

export const ENCODINGS = [
    {
        "instructionId": "st1w_z_p_br",
        "encodingId": "st1w_z_p_br_u128",
        "mnemonic": "ST1W",
        "className": "128-bit element",
        "fileName": "st1w_z_p_br.xml",
        "mask": 4292927488,
        "value": 3841998848,
        "bitCount": 14,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 3
            },
            {
                "name": "o2",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
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
            "FEAT_SVE2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "Rm",
                        "mask": 31,
                        "lsb": 0,
                        "value": 31
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-contiguous-memory"
    },
    {
        "instructionId": "st1w_z_p_br",
        "encodingId": "st1w_z_p_br_",
        "mnemonic": "ST1W",
        "className": "32-bit and 64-bit elements",
        "fileName": "st1w_z_p_br.xml",
        "mask": 4290830336,
        "value": 3846193152,
        "bitCount": 13,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 3
            },
            {
                "name": "sz",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
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
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "Rm",
                        "mask": 31,
                        "lsb": 0,
                        "value": 31
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-contiguous-memory"
    }
];

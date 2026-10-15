export const ENCODINGS = [
    {
        "instructionId": "ldff1w_z_p_br",
        "encodingId": "ldff1w_z_p_br_u32",
        "mnemonic": "LDFF1W",
        "className": "32-bit element",
        "fileName": "ldff1w_z_p_br.xml",
        "mask": 4292927488,
        "value": 2772459520,
        "bitCount": 14,
        "fields": [
            {
                "name": "dtype",
                "lsb": 21,
                "width": 4
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
        "operandFamilyId": "sve-fault-tolerant-load"
    },
    {
        "instructionId": "ldff1w_z_p_br",
        "encodingId": "ldff1w_z_p_br_u64",
        "mnemonic": "LDFF1W",
        "className": "64-bit element",
        "fileName": "ldff1w_z_p_br.xml",
        "mask": 4292927488,
        "value": 2774556672,
        "bitCount": 14,
        "fields": [
            {
                "name": "dtype",
                "lsb": 21,
                "width": 4
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
        "operandFamilyId": "sve-fault-tolerant-load"
    }
];

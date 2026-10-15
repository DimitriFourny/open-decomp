export const ENCODINGS = [
    {
        "instructionId": "ldff1sw_z_p_br",
        "encodingId": "ldff1sw_z_p_br_s64",
        "mnemonic": "LDFF1SW",
        "className": "SVE",
        "fileName": "ldff1sw_z_p_br.xml",
        "mask": 4292927488,
        "value": 2759876608,
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

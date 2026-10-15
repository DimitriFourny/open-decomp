export const ENCODINGS = [
    {
        "instructionId": "uqdecw_r_rs",
        "encodingId": "uqdecw_r_rs_uw",
        "mnemonic": "UQDECW",
        "className": "32-bit",
        "fileName": "uqdecw_r_rs.xml",
        "mask": 4293983232,
        "value": 77659136,
        "bitCount": 18,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "sf",
                "lsb": 20,
                "width": 1
            },
            {
                "name": "imm4",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "D",
                "lsb": 11,
                "width": 1
            },
            {
                "name": "U",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "pattern",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rdn",
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
            }
        ],
        "operandFamilyId": "sve-inc-dec-scalar"
    },
    {
        "instructionId": "uqdecw_r_rs",
        "encodingId": "uqdecw_r_rs_x",
        "mnemonic": "UQDECW",
        "className": "64-bit",
        "fileName": "uqdecw_r_rs.xml",
        "mask": 4293983232,
        "value": 78707712,
        "bitCount": 18,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "sf",
                "lsb": 20,
                "width": 1
            },
            {
                "name": "imm4",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "D",
                "lsb": 11,
                "width": 1
            },
            {
                "name": "U",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "pattern",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rdn",
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
            }
        ],
        "operandFamilyId": "sve-inc-dec-scalar"
    }
];

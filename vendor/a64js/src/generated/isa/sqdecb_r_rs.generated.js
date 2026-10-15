export const ENCODINGS = [
    {
        "instructionId": "sqdecb_r_rs",
        "encodingId": "sqdecb_r_rs_sx",
        "mnemonic": "SQDECB",
        "className": "32-bit",
        "fileName": "sqdecb_r_rs.xml",
        "mask": 4293983232,
        "value": 69269504,
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
        "instructionId": "sqdecb_r_rs",
        "encodingId": "sqdecb_r_rs_x",
        "mnemonic": "SQDECB",
        "className": "64-bit",
        "fileName": "sqdecb_r_rs.xml",
        "mask": 4293983232,
        "value": 70318080,
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

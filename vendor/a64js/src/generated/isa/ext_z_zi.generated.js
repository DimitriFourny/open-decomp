export const ENCODINGS = [
    {
        "instructionId": "ext_z_zi",
        "encodingId": "ext_z_zi_con",
        "mnemonic": "EXT",
        "className": "Constructive",
        "fileName": "ext_z_zi.xml",
        "mask": 4292927488,
        "value": 90177536,
        "bitCount": 14,
        "fields": [
            {
                "name": "imm8h",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "imm8l",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE2 || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2",
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
        "operandFamilyId": "sve-ext"
    },
    {
        "instructionId": "ext_z_zi",
        "encodingId": "ext_z_zi_des",
        "mnemonic": "EXT",
        "className": "Destructive",
        "fileName": "ext_z_zi.xml",
        "mask": 4292927488,
        "value": 85983232,
        "bitCount": 14,
        "fields": [
            {
                "name": "imm8h",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "imm8l",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zm",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zdn",
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
        "operandFamilyId": "sve-ext"
    }
];

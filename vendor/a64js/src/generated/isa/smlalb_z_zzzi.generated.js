export const ENCODINGS = [
    {
        "instructionId": "smlalb_z_zzzi",
        "encodingId": "smlalb_z_zzzi_d",
        "mnemonic": "SMLALB",
        "className": "64-bit",
        "fileName": "smlalb_z_zzzi.xml",
        "mask": 4292932608,
        "value": 1155563520,
        "bitCount": 16,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "i2h",
                "lsb": 20,
                "width": 1
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "S",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "U",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "i2l",
                "lsb": 11,
                "width": 1
            },
            {
                "name": "T",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zda",
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
        "operandFamilyId": "sve-long-multiply-indexed"
    },
    {
        "instructionId": "smlalb_z_zzzi",
        "encodingId": "smlalb_z_zzzi_s",
        "mnemonic": "SMLALB",
        "className": "32-bit",
        "fileName": "smlalb_z_zzzi.xml",
        "mask": 4292932608,
        "value": 1151369216,
        "bitCount": 16,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "i3h",
                "lsb": 19,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "S",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "U",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "i3l",
                "lsb": 11,
                "width": 1
            },
            {
                "name": "T",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zda",
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
        "operandFamilyId": "sve-long-multiply-indexed"
    }
];

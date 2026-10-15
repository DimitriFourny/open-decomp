export const ENCODINGS = [
    {
        "instructionId": "ummla_z_zzz",
        "encodingId": "ummla_z_zzz_",
        "mnemonic": "UMMLA",
        "className": "SVE",
        "fileName": "ummla_z_zzz.xml",
        "mask": 4292934656,
        "value": 1170249728,
        "bitCount": 17,
        "fields": [
            {
                "name": "uns",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
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
            "FEAT_SVE && FEAT_I8MM"
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
            },
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_I8MM",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-matrix-multiply"
    }
];

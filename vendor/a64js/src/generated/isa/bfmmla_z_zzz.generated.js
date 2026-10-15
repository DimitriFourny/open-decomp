export const ENCODINGS = [
    {
        "instructionId": "bfmmla_z_zzz",
        "encodingId": "bfmmla_z_zzz_",
        "mnemonic": "BFMMLA",
        "className": "SVE",
        "fileName": "bfmmla_z_zzz.xml",
        "mask": 4292934656,
        "value": 1684071424,
        "bitCount": 17,
        "fields": [
            {
                "name": "opc",
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
            "FEAT_SVE && FEAT_BF16"
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
                        "feature": "FEAT_BF16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-matrix-multiply"
    }
];

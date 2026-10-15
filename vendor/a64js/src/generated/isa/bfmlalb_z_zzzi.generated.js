export const ENCODINGS = [
    {
        "instructionId": "bfmlalb_z_zzzi",
        "encodingId": "bfmlalb_z_zzzi_",
        "mnemonic": "BFMLALB",
        "className": "SVE",
        "fileName": "bfmlalb_z_zzzi.xml",
        "mask": 4292932608,
        "value": 1692418048,
        "bitCount": 16,
        "fields": [
            {
                "name": "o2",
                "lsb": 22,
                "width": 1
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
                "name": "op",
                "lsb": 13,
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
            "(FEAT_SVE || FEAT_SME) && FEAT_BF16"
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
                        "kind": "feature",
                        "feature": "FEAT_BF16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-bfmlal"
    }
];

export const ENCODINGS = [
    {
        "instructionId": "bfmlslb_z_zzzi",
        "encodingId": "bfmlslb_z_zzzi_",
        "mnemonic": "BFMLSLB",
        "className": "SVE2",
        "fileName": "bfmlslb_z_zzzi.xml",
        "mask": 4292932608,
        "value": 1692426240,
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
            "FEAT_SME2 || FEAT_SVE2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-bfmlal"
    }
];

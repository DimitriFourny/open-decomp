export const ENCODINGS = [
    {
        "instructionId": "fmlslb_z_zzzi",
        "encodingId": "fmlslb_z_zzzi_s",
        "mnemonic": "FMLSLB",
        "className": "Single-precision",
        "fileName": "fmlslb_z_zzzi.xml",
        "mask": 4292932608,
        "value": 1688231936,
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
        "operandFamilyId": "sve-fmlal-long"
    }
];

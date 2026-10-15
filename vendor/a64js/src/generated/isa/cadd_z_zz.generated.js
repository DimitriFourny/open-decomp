export const ENCODINGS = [
    {
        "instructionId": "cadd_z_zz",
        "encodingId": "cadd_z_zz_",
        "mnemonic": "CADD",
        "className": "SVE2",
        "fileName": "cadd_z_zz.xml",
        "mask": 4282382336,
        "value": 1157683200,
        "bitCount": 19,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "op",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "rot",
                "lsb": 10,
                "width": 1
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
        "operandFamilyId": "sve-cadd-like"
    }
];

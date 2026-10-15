export const ENCODINGS = [
    {
        "instructionId": "mlapt_z_zzz",
        "encodingId": "mlapt_z_zzz_",
        "mnemonic": "MLAPT",
        "className": "SVE2",
        "fileName": "mlapt_z_zzz.xml",
        "mask": 4292934656,
        "value": 1153486848,
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
                "name": "o2",
                "lsb": 11,
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
            "FEAT_SVE && FEAT_CPA"
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
                        "feature": "FEAT_CPA",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-predicate-as-counter"
    }
];

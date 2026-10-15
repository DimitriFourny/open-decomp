export const ENCODINGS = [
    {
        "instructionId": "sel_z_p_zz",
        "encodingId": "sel_z_p_zz_",
        "mnemonic": "SEL",
        "className": "SVE",
        "fileName": "sel_z_p_zz.xml",
        "mask": 4280336384,
        "value": 86032384,
        "bitCount": 11,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "Pv",
                "lsb": 10,
                "width": 4
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
        "operandFamilyId": "sve-select-vector"
    }
];

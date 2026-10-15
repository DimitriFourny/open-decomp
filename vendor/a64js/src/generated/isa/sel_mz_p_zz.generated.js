export const ENCODINGS = [
    {
        "instructionId": "sel_mz_p_zz",
        "encodingId": "sel_mz_p_zz_4",
        "mnemonic": "SEL",
        "className": "Four registers",
        "fileName": "sel_mz_p_zz.xml",
        "mask": 4280541283,
        "value": 3240198144,
        "bitCount": 18,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 18,
                "width": 3
            },
            {
                "name": "PNv",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zn",
                "lsb": 7,
                "width": 3
            },
            {
                "name": "Zd",
                "lsb": 2,
                "width": 3
            }
        ],
        "features": [
            "FEAT_SME2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-select"
    },
    {
        "instructionId": "sel_mz_p_zz",
        "encodingId": "sel_mz_p_zz_2",
        "mnemonic": "SEL",
        "className": "Two registers",
        "fileName": "sel_mz_p_zz.xml",
        "mask": 4280410145,
        "value": 3240132608,
        "bitCount": 15,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 17,
                "width": 4
            },
            {
                "name": "PNv",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zn",
                "lsb": 6,
                "width": 4
            },
            {
                "name": "Zd",
                "lsb": 1,
                "width": 4
            }
        ],
        "features": [
            "FEAT_SME2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-select"
    }
];

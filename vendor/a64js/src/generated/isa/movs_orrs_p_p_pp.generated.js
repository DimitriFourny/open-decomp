export const ENCODINGS = [
    {
        "instructionId": "movs_orrs_p_p_pp",
        "encodingId": "movs_p_p__orrs_p_p_pp_z",
        "mnemonic": "ORRS",
        "className": "Setting the condition flags",
        "fileName": "movs_orrs_p_p_pp.xml",
        "mask": 4293968400,
        "value": 633356288,
        "bitCount": 16,
        "fields": [
            {
                "name": "op",
                "lsb": 23,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Pm",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 4
            },
            {
                "name": "o2",
                "lsb": 9,
                "width": 1
            },
            {
                "name": "Pn",
                "lsb": 5,
                "width": 4
            },
            {
                "name": "o3",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "Pd",
                "lsb": 0,
                "width": 4
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
        "canonicalEncodingId": "orrs_p_p_pp_z",
        "canonicalFileName": "orrs_p_p_pp.xml",
        "operandFamilyId": "sve-predicate-logical"
    }
];

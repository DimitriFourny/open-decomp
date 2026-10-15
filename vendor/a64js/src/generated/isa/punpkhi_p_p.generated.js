export const ENCODINGS = [
    {
        "instructionId": "punpkhi_p_p",
        "encodingId": "punpkhi_p_p_",
        "mnemonic": "PUNPKHI",
        "className": "High half",
        "fileName": "punpkhi_p_p.xml",
        "mask": 4294966800,
        "value": 87113728,
        "bitCount": 24,
        "fields": [
            {
                "name": "H",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "Pn",
                "lsb": 5,
                "width": 4
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
        "operandFamilyId": "sve-predicate-control"
    },
    {
        "instructionId": "punpkhi_p_p",
        "encodingId": "punpklo_p_p_",
        "mnemonic": "PUNPKLO",
        "className": "Low half",
        "fileName": "punpkhi_p_p.xml",
        "mask": 4294966800,
        "value": 87048192,
        "bitCount": 24,
        "fields": [
            {
                "name": "H",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "Pn",
                "lsb": 5,
                "width": 4
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
        "operandFamilyId": "sve-predicate-control"
    }
];

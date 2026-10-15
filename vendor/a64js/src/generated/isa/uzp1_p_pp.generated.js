export const ENCODINGS = [
    {
        "instructionId": "uzp1_p_pp",
        "encodingId": "uzp1_p_pp_",
        "mnemonic": "UZP1",
        "className": "Even",
        "fileName": "uzp1_p_pp.xml",
        "mask": 4281400848,
        "value": 86001664,
        "bitCount": 18,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Pm",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "opc",
                "lsb": 11,
                "width": 2
            },
            {
                "name": "H",
                "lsb": 10,
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
        "operandFamilyId": "sve-predicate-permutation"
    },
    {
        "instructionId": "uzp1_p_pp",
        "encodingId": "uzp2_p_pp_",
        "mnemonic": "UZP2",
        "className": "Odd",
        "fileName": "uzp1_p_pp.xml",
        "mask": 4281400848,
        "value": 86002688,
        "bitCount": 18,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Pm",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "opc",
                "lsb": 11,
                "width": 2
            },
            {
                "name": "H",
                "lsb": 10,
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
        "operandFamilyId": "sve-predicate-permutation"
    }
];

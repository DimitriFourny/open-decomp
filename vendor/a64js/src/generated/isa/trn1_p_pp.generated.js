export const ENCODINGS = [
    {
        "instructionId": "trn1_p_pp",
        "encodingId": "trn1_p_pp_",
        "mnemonic": "TRN1",
        "className": "Even",
        "fileName": "trn1_p_pp.xml",
        "mask": 4281400848,
        "value": 86003712,
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
        "instructionId": "trn1_p_pp",
        "encodingId": "trn2_p_pp_",
        "mnemonic": "TRN2",
        "className": "Odd",
        "fileName": "trn1_p_pp.xml",
        "mask": 4281400848,
        "value": 86004736,
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

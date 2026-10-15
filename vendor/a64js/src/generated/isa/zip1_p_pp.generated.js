export const ENCODINGS = [
    {
        "instructionId": "zip1_p_pp",
        "encodingId": "zip1_p_pp_",
        "mnemonic": "ZIP1",
        "className": "Low halves",
        "fileName": "zip1_p_pp.xml",
        "mask": 4281400848,
        "value": 85999616,
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
        "instructionId": "zip1_p_pp",
        "encodingId": "zip2_p_pp_",
        "mnemonic": "ZIP2",
        "className": "High halves",
        "fileName": "zip1_p_pp.xml",
        "mask": 4281400848,
        "value": 86000640,
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

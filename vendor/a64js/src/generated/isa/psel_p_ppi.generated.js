export const ENCODINGS = [
    {
        "instructionId": "psel_p_ppi",
        "encodingId": "psel_p_ppi_",
        "mnemonic": "PSEL",
        "className": "SVE2",
        "fileName": "psel_p_ppi.xml",
        "mask": 4280336912,
        "value": 622870528,
        "bitCount": 13,
        "fields": [
            {
                "name": "i1",
                "lsb": 23,
                "width": 1
            },
            {
                "name": "tszh",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "tszl",
                "lsb": 18,
                "width": 3
            },
            {
                "name": "Rv",
                "lsb": 16,
                "width": 2
            },
            {
                "name": "Pn",
                "lsb": 10,
                "width": 4
            },
            {
                "name": "S",
                "lsb": 9,
                "width": 1
            },
            {
                "name": "Pm",
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
            "FEAT_SME || FEAT_SVE2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "tszh",
                                "msb": 0,
                                "lsb": 0
                            },
                            {
                                "field": "tszl",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-predicate-select"
    }
];

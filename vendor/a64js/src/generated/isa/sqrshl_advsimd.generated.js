export const ENCODINGS = [
    {
        "instructionId": "SQRSHL_advsimd",
        "encodingId": "SQRSHL_asisdsame_only",
        "mnemonic": "SQRSHL",
        "className": "Scalar",
        "fileName": "sqrshl_advsimd.xml",
        "mask": 4280351744,
        "value": 1579179008,
        "bitCount": 15,
        "fields": [
            {
                "name": "U",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "R",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 11,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_AdvSIMD"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_AdvSIMD",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "S",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 3
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-scalar-or-vector-three-same"
    },
    {
        "instructionId": "SQRSHL_advsimd",
        "encodingId": "SQRSHL_asimdsame_only",
        "mnemonic": "SQRSHL",
        "className": "Vector",
        "fileName": "sqrshl_advsimd.xml",
        "mask": 3206609920,
        "value": 237001728,
        "bitCount": 14,
        "fields": [
            {
                "name": "Q",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "U",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "R",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 11,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_AdvSIMD"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_AdvSIMD",
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
                                "field": "size",
                                "msb": 1,
                                "lsb": 0
                            },
                            {
                                "field": "Q",
                                "msb": 0,
                                "lsb": 0
                            }
                        ],
                        "value": 6
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-scalar-or-vector-three-same"
    }
];

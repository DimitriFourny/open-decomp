export const ENCODINGS = [
    {
        "instructionId": "fadd_za_zw",
        "encodingId": "fadd_za_zw_4x4_16",
        "mnemonic": "FADD",
        "className": "Four ZA single-vectors of half-precision elements",
        "fileName": "fadd_za_zw.xml",
        "mask": 4294941816,
        "value": 3248823296,
        "bitCount": 24,
        "fields": [
            {
                "name": "sz",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 7,
                "width": 3
            },
            {
                "name": "S",
                "lsb": 3,
                "width": 1
            },
            {
                "name": "off3",
                "lsb": 0,
                "width": 3
            }
        ],
        "features": [
            "FEAT_SME_F16F16 || FEAT_SME_F8F16"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_F16F16",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_F8F16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-arithmetic"
    },
    {
        "instructionId": "fadd_za_zw",
        "encodingId": "fadd_za_zw_2x2_16",
        "mnemonic": "FADD",
        "className": "Two ZA single-vectors of half-precision elements",
        "fileName": "fadd_za_zw.xml",
        "mask": 4294941752,
        "value": 3248757760,
        "bitCount": 23,
        "fields": [
            {
                "name": "sz",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 6,
                "width": 4
            },
            {
                "name": "S",
                "lsb": 3,
                "width": 1
            },
            {
                "name": "off3",
                "lsb": 0,
                "width": 3
            }
        ],
        "features": [
            "FEAT_SME_F16F16 || FEAT_SME_F8F16"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_F16F16",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_F8F16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-arithmetic"
    },
    {
        "instructionId": "fadd_za_zw",
        "encodingId": "fadd_za_zw_4x4",
        "mnemonic": "FADD",
        "className": "Four ZA single-vectors",
        "fileName": "fadd_za_zw.xml",
        "mask": 4290747512,
        "value": 3248561152,
        "bitCount": 23,
        "fields": [
            {
                "name": "sz",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 7,
                "width": 3
            },
            {
                "name": "S",
                "lsb": 3,
                "width": 1
            },
            {
                "name": "off3",
                "lsb": 0,
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
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "sz",
                        "mask": 1,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_F64F64",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-arithmetic"
    },
    {
        "instructionId": "fadd_za_zw",
        "encodingId": "fadd_za_zw_2x2",
        "mnemonic": "FADD",
        "className": "Two ZA single-vectors",
        "fileName": "fadd_za_zw.xml",
        "mask": 4290747448,
        "value": 3248495616,
        "bitCount": 22,
        "fields": [
            {
                "name": "sz",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 6,
                "width": 4
            },
            {
                "name": "S",
                "lsb": 3,
                "width": 1
            },
            {
                "name": "off3",
                "lsb": 0,
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
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "sz",
                        "mask": 1,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_F64F64",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-arithmetic"
    }
];

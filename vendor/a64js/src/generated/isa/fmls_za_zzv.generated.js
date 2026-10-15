export const ENCODINGS = [
    {
        "instructionId": "fmls_za_zzv",
        "encodingId": "fmls_za_zzv_2x1_16",
        "mnemonic": "FMLS",
        "className": "Two ZA single-vectors of half-precision elements",
        "fileName": "fmls_za_zzv.xml",
        "mask": 4293958680,
        "value": 3240107016,
        "bitCount": 18,
        "fields": [
            {
                "name": "sz",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
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
            "FEAT_SME_F16F16"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_F16F16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-arithmetic"
    },
    {
        "instructionId": "fmls_za_zzv",
        "encodingId": "fmls_za_zzv_4x1_16",
        "mnemonic": "FMLS",
        "className": "Four ZA single-vectors of half-precision elements",
        "fileName": "fmls_za_zzv.xml",
        "mask": 4293958680,
        "value": 3241155592,
        "bitCount": 18,
        "fields": [
            {
                "name": "sz",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
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
            "FEAT_SME_F16F16"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_F16F16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-arithmetic"
    },
    {
        "instructionId": "fmls_za_zzv",
        "encodingId": "fmls_za_zzv_2x1",
        "mnemonic": "FMLS",
        "className": "Two ZA single-vectors",
        "fileName": "fmls_za_zzv.xml",
        "mask": 4289764376,
        "value": 3240105992,
        "bitCount": 17,
        "fields": [
            {
                "name": "sz",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
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
        "instructionId": "fmls_za_zzv",
        "encodingId": "fmls_za_zzv_4x1",
        "mnemonic": "FMLS",
        "className": "Four ZA single-vectors",
        "fileName": "fmls_za_zzv.xml",
        "mask": 4289764376,
        "value": 3241154568,
        "bitCount": 17,
        "fields": [
            {
                "name": "sz",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
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

export const ENCODINGS = [
    {
        "instructionId": "FCCMPE_float",
        "encodingId": "FCCMPE_D_floatccmp",
        "mnemonic": "FCCMPE",
        "className": "Floating-point",
        "fileName": "fccmpe_float.xml",
        "mask": 4292873232,
        "value": 509608976,
        "bitCount": 14,
        "fields": [
            {
                "name": "M",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "ftype",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "cond",
                "lsb": 12,
                "width": 4
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "op",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "nzcv",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_FP",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 3
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_FP16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-fp-conditional-compare"
    },
    {
        "instructionId": "FCCMPE_float",
        "encodingId": "FCCMPE_H_floatccmp",
        "mnemonic": "FCCMPE",
        "className": "Floating-point",
        "fileName": "fccmpe_float.xml",
        "mask": 4292873232,
        "value": 517997584,
        "bitCount": 14,
        "fields": [
            {
                "name": "M",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "ftype",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "cond",
                "lsb": 12,
                "width": 4
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "op",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "nzcv",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_FP",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 3
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_FP16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-fp-conditional-compare"
    },
    {
        "instructionId": "FCCMPE_float",
        "encodingId": "FCCMPE_S_floatccmp",
        "mnemonic": "FCCMPE",
        "className": "Floating-point",
        "fileName": "fccmpe_float.xml",
        "mask": 4292873232,
        "value": 505414672,
        "bitCount": 14,
        "fields": [
            {
                "name": "M",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "ftype",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "cond",
                "lsb": 12,
                "width": 4
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "op",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "nzcv",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_FP",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 3
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_FP16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-fp-conditional-compare"
    }
];

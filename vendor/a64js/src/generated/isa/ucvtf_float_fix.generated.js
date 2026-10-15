export const ENCODINGS = [
    {
        "instructionId": "UCVTF_float_fix",
        "encodingId": "UCVTF_D32_float2fix",
        "mnemonic": "UCVTF",
        "className": "Floating-point",
        "fileName": "ucvtf_float_fix.xml",
        "mask": 4294901760,
        "value": 507707392,
        "bitCount": 16,
        "fields": [
            {
                "name": "sf",
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
                "name": "rmode",
                "lsb": 19,
                "width": 2
            },
            {
                "name": "opcode",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "scale",
                "lsb": 10,
                "width": 6
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
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "eq",
                        "field": "scale",
                        "mask": 32,
                        "lsb": 5,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-integer-to-fp-scvtf-float-fix"
    },
    {
        "instructionId": "UCVTF_float_fix",
        "encodingId": "UCVTF_D64_float2fix",
        "mnemonic": "UCVTF",
        "className": "Floating-point",
        "fileName": "ucvtf_float_fix.xml",
        "mask": 4294901760,
        "value": 2655191040,
        "bitCount": 16,
        "fields": [
            {
                "name": "sf",
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
                "name": "rmode",
                "lsb": 19,
                "width": 2
            },
            {
                "name": "opcode",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "scale",
                "lsb": 10,
                "width": 6
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
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "eq",
                        "field": "scale",
                        "mask": 32,
                        "lsb": 5,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-integer-to-fp-scvtf-float-fix"
    },
    {
        "instructionId": "UCVTF_float_fix",
        "encodingId": "UCVTF_H32_float2fix",
        "mnemonic": "UCVTF",
        "className": "Floating-point",
        "fileName": "ucvtf_float_fix.xml",
        "mask": 4294901760,
        "value": 516096000,
        "bitCount": 16,
        "fields": [
            {
                "name": "sf",
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
                "name": "rmode",
                "lsb": 19,
                "width": 2
            },
            {
                "name": "opcode",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "scale",
                "lsb": 10,
                "width": 6
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
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "eq",
                        "field": "scale",
                        "mask": 32,
                        "lsb": 5,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-integer-to-fp-scvtf-float-fix"
    },
    {
        "instructionId": "UCVTF_float_fix",
        "encodingId": "UCVTF_H64_float2fix",
        "mnemonic": "UCVTF",
        "className": "Floating-point",
        "fileName": "ucvtf_float_fix.xml",
        "mask": 4294901760,
        "value": 2663579648,
        "bitCount": 16,
        "fields": [
            {
                "name": "sf",
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
                "name": "rmode",
                "lsb": 19,
                "width": 2
            },
            {
                "name": "opcode",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "scale",
                "lsb": 10,
                "width": 6
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
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "eq",
                        "field": "scale",
                        "mask": 32,
                        "lsb": 5,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-integer-to-fp-scvtf-float-fix"
    },
    {
        "instructionId": "UCVTF_float_fix",
        "encodingId": "UCVTF_S32_float2fix",
        "mnemonic": "UCVTF",
        "className": "Floating-point",
        "fileName": "ucvtf_float_fix.xml",
        "mask": 4294901760,
        "value": 503513088,
        "bitCount": 16,
        "fields": [
            {
                "name": "sf",
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
                "name": "rmode",
                "lsb": 19,
                "width": 2
            },
            {
                "name": "opcode",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "scale",
                "lsb": 10,
                "width": 6
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
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "eq",
                        "field": "scale",
                        "mask": 32,
                        "lsb": 5,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-integer-to-fp-scvtf-float-fix"
    },
    {
        "instructionId": "UCVTF_float_fix",
        "encodingId": "UCVTF_S64_float2fix",
        "mnemonic": "UCVTF",
        "className": "Floating-point",
        "fileName": "ucvtf_float_fix.xml",
        "mask": 4294901760,
        "value": 2650996736,
        "bitCount": 16,
        "fields": [
            {
                "name": "sf",
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
                "name": "rmode",
                "lsb": 19,
                "width": 2
            },
            {
                "name": "opcode",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "scale",
                "lsb": 10,
                "width": 6
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
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "eq",
                        "field": "scale",
                        "mask": 32,
                        "lsb": 5,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-integer-to-fp-scvtf-float-fix"
    }
];

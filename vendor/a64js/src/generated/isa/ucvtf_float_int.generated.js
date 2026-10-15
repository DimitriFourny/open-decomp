export const ENCODINGS = [
    {
        "instructionId": "UCVTF_float_int",
        "encodingId": "UCVTF_D32_float2int",
        "mnemonic": "UCVTF",
        "className": "Floating-point",
        "fileName": "ucvtf_float_int.xml",
        "mask": 4294966272,
        "value": 509804544,
        "bitCount": 22,
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
            }
        ],
        "operandFamilyId": "scalar-integer-to-fp"
    },
    {
        "instructionId": "UCVTF_float_int",
        "encodingId": "UCVTF_D64_float2int",
        "mnemonic": "UCVTF",
        "className": "Floating-point",
        "fileName": "ucvtf_float_int.xml",
        "mask": 4294966272,
        "value": 2657288192,
        "bitCount": 22,
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
            }
        ],
        "operandFamilyId": "scalar-integer-to-fp"
    },
    {
        "instructionId": "UCVTF_float_int",
        "encodingId": "UCVTF_H32_float2int",
        "mnemonic": "UCVTF",
        "className": "Floating-point",
        "fileName": "ucvtf_float_int.xml",
        "mask": 4294966272,
        "value": 518193152,
        "bitCount": 22,
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
            }
        ],
        "operandFamilyId": "scalar-integer-to-fp"
    },
    {
        "instructionId": "UCVTF_float_int",
        "encodingId": "UCVTF_H64_float2int",
        "mnemonic": "UCVTF",
        "className": "Floating-point",
        "fileName": "ucvtf_float_int.xml",
        "mask": 4294966272,
        "value": 2665676800,
        "bitCount": 22,
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
            }
        ],
        "operandFamilyId": "scalar-integer-to-fp"
    },
    {
        "instructionId": "UCVTF_float_int",
        "encodingId": "UCVTF_S32_float2int",
        "mnemonic": "UCVTF",
        "className": "Floating-point",
        "fileName": "ucvtf_float_int.xml",
        "mask": 4294966272,
        "value": 505610240,
        "bitCount": 22,
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
            }
        ],
        "operandFamilyId": "scalar-integer-to-fp"
    },
    {
        "instructionId": "UCVTF_float_int",
        "encodingId": "UCVTF_S64_float2int",
        "mnemonic": "UCVTF",
        "className": "Floating-point",
        "fileName": "ucvtf_float_int.xml",
        "mask": 4294966272,
        "value": 2653093888,
        "bitCount": 22,
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
            }
        ],
        "operandFamilyId": "scalar-integer-to-fp"
    }
];

export const ENCODINGS = [
    {
        "instructionId": "FMOV_float_gen",
        "encodingId": "FMOV_32H_float2int",
        "mnemonic": "FMOV",
        "className": "Floating-point",
        "fileName": "fmov_float_gen.xml",
        "mask": 4294966272,
        "value": 518389760,
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
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
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
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 1
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
                    },
                    {
                        "kind": "ne",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-fp-move-general"
    },
    {
        "instructionId": "FMOV_float_gen",
        "encodingId": "FMOV_32S_float2int",
        "mnemonic": "FMOV",
        "className": "Floating-point",
        "fileName": "fmov_float_gen.xml",
        "mask": 4294966272,
        "value": 505806848,
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
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
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
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 1
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
                    },
                    {
                        "kind": "ne",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-fp-move-general"
    },
    {
        "instructionId": "FMOV_float_gen",
        "encodingId": "FMOV_64D_float2int",
        "mnemonic": "FMOV",
        "className": "Floating-point",
        "fileName": "fmov_float_gen.xml",
        "mask": 4294966272,
        "value": 2657484800,
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
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
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
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 1
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
                    },
                    {
                        "kind": "ne",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-fp-move-general"
    },
    {
        "instructionId": "FMOV_float_gen",
        "encodingId": "FMOV_64H_float2int",
        "mnemonic": "FMOV",
        "className": "Floating-point",
        "fileName": "fmov_float_gen.xml",
        "mask": 4294966272,
        "value": 2665873408,
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
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
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
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 1
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
                    },
                    {
                        "kind": "ne",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-fp-move-general"
    },
    {
        "instructionId": "FMOV_float_gen",
        "encodingId": "FMOV_64VX_float2int",
        "mnemonic": "FMOV",
        "className": "Floating-point",
        "fileName": "fmov_float_gen.xml",
        "mask": 4294966272,
        "value": 2662203392,
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
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
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
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 1
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
                    },
                    {
                        "kind": "ne",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-fp-move-general"
    },
    {
        "instructionId": "FMOV_float_gen",
        "encodingId": "FMOV_D64_float2int",
        "mnemonic": "FMOV",
        "className": "Floating-point",
        "fileName": "fmov_float_gen.xml",
        "mask": 4294966272,
        "value": 2657550336,
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
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
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
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 1
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
                    },
                    {
                        "kind": "ne",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-fp-move-general"
    },
    {
        "instructionId": "FMOV_float_gen",
        "encodingId": "FMOV_H32_float2int",
        "mnemonic": "FMOV",
        "className": "Floating-point",
        "fileName": "fmov_float_gen.xml",
        "mask": 4294966272,
        "value": 518455296,
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
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
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
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 1
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
                    },
                    {
                        "kind": "ne",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-fp-move-general"
    },
    {
        "instructionId": "FMOV_float_gen",
        "encodingId": "FMOV_H64_float2int",
        "mnemonic": "FMOV",
        "className": "Floating-point",
        "fileName": "fmov_float_gen.xml",
        "mask": 4294966272,
        "value": 2665938944,
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
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
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
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 1
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
                    },
                    {
                        "kind": "ne",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-fp-move-general"
    },
    {
        "instructionId": "FMOV_float_gen",
        "encodingId": "FMOV_S32_float2int",
        "mnemonic": "FMOV",
        "className": "Floating-point",
        "fileName": "fmov_float_gen.xml",
        "mask": 4294966272,
        "value": 505872384,
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
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
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
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 1
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
                    },
                    {
                        "kind": "ne",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-fp-move-general"
    },
    {
        "instructionId": "FMOV_float_gen",
        "encodingId": "FMOV_V64I_float2int",
        "mnemonic": "FMOV",
        "className": "Floating-point",
        "fileName": "fmov_float_gen.xml",
        "mask": 4294966272,
        "value": 2662268928,
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
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
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
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 1
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 12
                    },
                    {
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
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
                                "field": "opcode",
                                "msb": 2,
                                "lsb": 1
                            },
                            {
                                "field": "rmode",
                                "msb": 1,
                                "lsb": 0
                            }
                        ],
                        "value": 13
                    },
                    {
                        "kind": "ne",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-fp-move-general"
    }
];

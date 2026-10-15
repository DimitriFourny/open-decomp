export const ENCODINGS = [
    {
        "instructionId": "FCVT_float",
        "encodingId": "FCVT_DH_floatdp1",
        "mnemonic": "FCVT",
        "className": "Floating-point",
        "fileName": "fcvt_float.xml",
        "mask": 4294966272,
        "value": 518176768,
        "bitCount": 22,
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
                "name": "opc",
                "lsb": 15,
                "width": 2
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
            "FEAT_FP"
        ],
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
                        "kind": "eq_field",
                        "field": "ftype",
                        "otherField": "opc"
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
                        "field": "opc",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-fp-convert-precision"
    },
    {
        "instructionId": "FCVT_float",
        "encodingId": "FCVT_DS_floatdp1",
        "mnemonic": "FCVT",
        "className": "Floating-point",
        "fileName": "fcvt_float.xml",
        "mask": 4294966272,
        "value": 505593856,
        "bitCount": 22,
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
                "name": "opc",
                "lsb": 15,
                "width": 2
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
            "FEAT_FP"
        ],
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
                        "kind": "eq_field",
                        "field": "ftype",
                        "otherField": "opc"
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
                        "field": "opc",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-fp-convert-precision"
    },
    {
        "instructionId": "FCVT_float",
        "encodingId": "FCVT_HD_floatdp1",
        "mnemonic": "FCVT",
        "className": "Floating-point",
        "fileName": "fcvt_float.xml",
        "mask": 4294966272,
        "value": 509853696,
        "bitCount": 22,
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
                "name": "opc",
                "lsb": 15,
                "width": 2
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
            "FEAT_FP"
        ],
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
                        "kind": "eq_field",
                        "field": "ftype",
                        "otherField": "opc"
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
                        "field": "opc",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-fp-convert-precision"
    },
    {
        "instructionId": "FCVT_float",
        "encodingId": "FCVT_HS_floatdp1",
        "mnemonic": "FCVT",
        "className": "Floating-point",
        "fileName": "fcvt_float.xml",
        "mask": 4294966272,
        "value": 505659392,
        "bitCount": 22,
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
                "name": "opc",
                "lsb": 15,
                "width": 2
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
            "FEAT_FP"
        ],
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
                        "kind": "eq_field",
                        "field": "ftype",
                        "otherField": "opc"
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
                        "field": "opc",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-fp-convert-precision"
    },
    {
        "instructionId": "FCVT_float",
        "encodingId": "FCVT_SD_floatdp1",
        "mnemonic": "FCVT",
        "className": "Floating-point",
        "fileName": "fcvt_float.xml",
        "mask": 4294966272,
        "value": 509755392,
        "bitCount": 22,
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
                "name": "opc",
                "lsb": 15,
                "width": 2
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
            "FEAT_FP"
        ],
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
                        "kind": "eq_field",
                        "field": "ftype",
                        "otherField": "opc"
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
                        "field": "opc",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-fp-convert-precision"
    },
    {
        "instructionId": "FCVT_float",
        "encodingId": "FCVT_SH_floatdp1",
        "mnemonic": "FCVT",
        "className": "Floating-point",
        "fileName": "fcvt_float.xml",
        "mask": 4294966272,
        "value": 518144000,
        "bitCount": 22,
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
                "name": "opc",
                "lsb": 15,
                "width": 2
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
            "FEAT_FP"
        ],
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
                        "kind": "eq_field",
                        "field": "ftype",
                        "otherField": "opc"
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
                        "field": "opc",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-fp-convert-precision"
    }
];

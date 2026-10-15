export const ENCODINGS = [
    {
        "instructionId": "LDUR_fpsimd",
        "encodingId": "LDUR_B_ldst_unscaled",
        "mnemonic": "LDUR",
        "className": "Unscaled offset",
        "fileName": "ldur_fpsimd.xml",
        "mask": 4292873216,
        "value": 1010827264,
        "bitCount": 13,
        "fields": [
            {
                "name": "size",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm9",
                "lsb": 12,
                "width": 9
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rt",
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
                        "kind": "eq",
                        "field": "opc",
                        "mask": 2,
                        "lsb": 1,
                        "value": 1
                    },
                    {
                        "kind": "ne",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-load-store"
    },
    {
        "instructionId": "LDUR_fpsimd",
        "encodingId": "LDUR_D_ldst_unscaled",
        "mnemonic": "LDUR",
        "className": "Unscaled offset",
        "fileName": "ldur_fpsimd.xml",
        "mask": 4292873216,
        "value": 4232052736,
        "bitCount": 13,
        "fields": [
            {
                "name": "size",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm9",
                "lsb": 12,
                "width": 9
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rt",
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
                        "kind": "eq",
                        "field": "opc",
                        "mask": 2,
                        "lsb": 1,
                        "value": 1
                    },
                    {
                        "kind": "ne",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-load-store"
    },
    {
        "instructionId": "LDUR_fpsimd",
        "encodingId": "LDUR_H_ldst_unscaled",
        "mnemonic": "LDUR",
        "className": "Unscaled offset",
        "fileName": "ldur_fpsimd.xml",
        "mask": 4292873216,
        "value": 2084569088,
        "bitCount": 13,
        "fields": [
            {
                "name": "size",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm9",
                "lsb": 12,
                "width": 9
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rt",
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
                        "kind": "eq",
                        "field": "opc",
                        "mask": 2,
                        "lsb": 1,
                        "value": 1
                    },
                    {
                        "kind": "ne",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-load-store"
    },
    {
        "instructionId": "LDUR_fpsimd",
        "encodingId": "LDUR_Q_ldst_unscaled",
        "mnemonic": "LDUR",
        "className": "Unscaled offset",
        "fileName": "ldur_fpsimd.xml",
        "mask": 4292873216,
        "value": 1019215872,
        "bitCount": 13,
        "fields": [
            {
                "name": "size",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm9",
                "lsb": 12,
                "width": 9
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rt",
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
                        "kind": "eq",
                        "field": "opc",
                        "mask": 2,
                        "lsb": 1,
                        "value": 1
                    },
                    {
                        "kind": "ne",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-load-store"
    },
    {
        "instructionId": "LDUR_fpsimd",
        "encodingId": "LDUR_S_ldst_unscaled",
        "mnemonic": "LDUR",
        "className": "Unscaled offset",
        "fileName": "ldur_fpsimd.xml",
        "mask": 4292873216,
        "value": 3158310912,
        "bitCount": 13,
        "fields": [
            {
                "name": "size",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm9",
                "lsb": 12,
                "width": 9
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rt",
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
                        "kind": "eq",
                        "field": "opc",
                        "mask": 2,
                        "lsb": 1,
                        "value": 1
                    },
                    {
                        "kind": "ne",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-load-store"
    }
];

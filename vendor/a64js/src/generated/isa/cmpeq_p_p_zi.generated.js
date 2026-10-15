export const ENCODINGS = [
    {
        "instructionId": "cmpeq_p_p_zi",
        "encodingId": "cmpeq_p_p_zi_",
        "mnemonic": "CMPEQ",
        "className": "Equal",
        "fileName": "cmpeq_p_p_zi.xml",
        "mask": 4280344592,
        "value": 620789760,
        "bitCount": 13,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm5",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "op",
                "lsb": 15,
                "width": 1
            },
            {
                "name": "o2",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "ne",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "Pd",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [
            "FEAT_SVE || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-compare-immediate"
    },
    {
        "instructionId": "cmpeq_p_p_zi",
        "encodingId": "cmpge_p_p_zi_",
        "mnemonic": "CMPGE",
        "className": "Greater than or equal",
        "fileName": "cmpeq_p_p_zi.xml",
        "mask": 4280344592,
        "value": 620756992,
        "bitCount": 13,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm5",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "op",
                "lsb": 15,
                "width": 1
            },
            {
                "name": "lt",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "ne",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "Pd",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [
            "FEAT_SVE || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-compare-immediate"
    },
    {
        "instructionId": "cmpeq_p_p_zi",
        "encodingId": "cmpgt_p_p_zi_",
        "mnemonic": "CMPGT",
        "className": "Greater than",
        "fileName": "cmpeq_p_p_zi.xml",
        "mask": 4280344592,
        "value": 620757008,
        "bitCount": 13,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm5",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "op",
                "lsb": 15,
                "width": 1
            },
            {
                "name": "lt",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "ne",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "Pd",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [
            "FEAT_SVE || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-compare-immediate"
    },
    {
        "instructionId": "cmpeq_p_p_zi",
        "encodingId": "cmple_p_p_zi_",
        "mnemonic": "CMPLE",
        "className": "Less than or equal",
        "fileName": "cmpeq_p_p_zi.xml",
        "mask": 4280344592,
        "value": 620765200,
        "bitCount": 13,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm5",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "op",
                "lsb": 15,
                "width": 1
            },
            {
                "name": "lt",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "ne",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "Pd",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [
            "FEAT_SVE || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-compare-immediate"
    },
    {
        "instructionId": "cmpeq_p_p_zi",
        "encodingId": "cmplt_p_p_zi_",
        "mnemonic": "CMPLT",
        "className": "Less than",
        "fileName": "cmpeq_p_p_zi.xml",
        "mask": 4280344592,
        "value": 620765184,
        "bitCount": 13,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm5",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "op",
                "lsb": 15,
                "width": 1
            },
            {
                "name": "lt",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "ne",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "Pd",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [
            "FEAT_SVE || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-compare-immediate"
    },
    {
        "instructionId": "cmpeq_p_p_zi",
        "encodingId": "cmpne_p_p_zi_",
        "mnemonic": "CMPNE",
        "className": "Not equal",
        "fileName": "cmpeq_p_p_zi.xml",
        "mask": 4280344592,
        "value": 620789776,
        "bitCount": 13,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm5",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "op",
                "lsb": 15,
                "width": 1
            },
            {
                "name": "o2",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "ne",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "Pd",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [
            "FEAT_SVE || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-compare-immediate"
    },
    {
        "instructionId": "cmpeq_p_p_zi",
        "encodingId": "cmphi_p_p_zi_",
        "mnemonic": "CMPHI",
        "className": "Higher",
        "fileName": "cmpeq_p_p_zi.xml",
        "mask": 4280295440,
        "value": 606076944,
        "bitCount": 11,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm7",
                "lsb": 14,
                "width": 7
            },
            {
                "name": "lt",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "ne",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "Pd",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [
            "FEAT_SVE || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-compare-immediate"
    },
    {
        "instructionId": "cmpeq_p_p_zi",
        "encodingId": "cmphs_p_p_zi_",
        "mnemonic": "CMPHS",
        "className": "Higher or same",
        "fileName": "cmpeq_p_p_zi.xml",
        "mask": 4280295440,
        "value": 606076928,
        "bitCount": 11,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm7",
                "lsb": 14,
                "width": 7
            },
            {
                "name": "lt",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "ne",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "Pd",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [
            "FEAT_SVE || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-compare-immediate"
    },
    {
        "instructionId": "cmpeq_p_p_zi",
        "encodingId": "cmplo_p_p_zi_",
        "mnemonic": "CMPLO",
        "className": "Lower",
        "fileName": "cmpeq_p_p_zi.xml",
        "mask": 4280295440,
        "value": 606085120,
        "bitCount": 11,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm7",
                "lsb": 14,
                "width": 7
            },
            {
                "name": "lt",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "ne",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "Pd",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [
            "FEAT_SVE || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-compare-immediate"
    },
    {
        "instructionId": "cmpeq_p_p_zi",
        "encodingId": "cmpls_p_p_zi_",
        "mnemonic": "CMPLS",
        "className": "Lower or same",
        "fileName": "cmpeq_p_p_zi.xml",
        "mask": 4280295440,
        "value": 606085136,
        "bitCount": 11,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm7",
                "lsb": 14,
                "width": 7
            },
            {
                "name": "lt",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "ne",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "Pd",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [
            "FEAT_SVE || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-compare-immediate"
    }
];

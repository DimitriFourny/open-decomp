export const ENCODINGS = [
    {
        "instructionId": "cmpeq_p_p_zz",
        "encodingId": "cmpeq_p_p_zz_",
        "mnemonic": "CMPEQ",
        "className": "Equal",
        "fileName": "cmpeq_p_p_zz.xml",
        "mask": 4280344592,
        "value": 604020736,
        "bitCount": 13,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Zm",
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
        "operandFamilyId": "sve-compare-vector"
    },
    {
        "instructionId": "cmpeq_p_p_zz",
        "encodingId": "cmpge_p_p_zz_",
        "mnemonic": "CMPGE",
        "className": "Greater than or equal",
        "fileName": "cmpeq_p_p_zz.xml",
        "mask": 4280344592,
        "value": 604012544,
        "bitCount": 13,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Zm",
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
        "operandFamilyId": "sve-compare-vector"
    },
    {
        "instructionId": "cmpeq_p_p_zz",
        "encodingId": "cmpgt_p_p_zz_",
        "mnemonic": "CMPGT",
        "className": "Greater than",
        "fileName": "cmpeq_p_p_zz.xml",
        "mask": 4280344592,
        "value": 604012560,
        "bitCount": 13,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Zm",
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
        "operandFamilyId": "sve-compare-vector"
    },
    {
        "instructionId": "cmpeq_p_p_zz",
        "encodingId": "cmphi_p_p_zz_",
        "mnemonic": "CMPHI",
        "className": "Higher",
        "fileName": "cmpeq_p_p_zz.xml",
        "mask": 4280344592,
        "value": 603979792,
        "bitCount": 13,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Zm",
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
        "operandFamilyId": "sve-compare-vector"
    },
    {
        "instructionId": "cmpeq_p_p_zz",
        "encodingId": "cmphs_p_p_zz_",
        "mnemonic": "CMPHS",
        "className": "Higher or same",
        "fileName": "cmpeq_p_p_zz.xml",
        "mask": 4280344592,
        "value": 603979776,
        "bitCount": 13,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Zm",
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
        "operandFamilyId": "sve-compare-vector"
    },
    {
        "instructionId": "cmpeq_p_p_zz",
        "encodingId": "cmpne_p_p_zz_",
        "mnemonic": "CMPNE",
        "className": "Not equal",
        "fileName": "cmpeq_p_p_zz.xml",
        "mask": 4280344592,
        "value": 604020752,
        "bitCount": 13,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Zm",
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
        "operandFamilyId": "sve-compare-vector"
    }
];

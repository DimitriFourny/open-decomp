export const ENCODINGS = [
    {
        "instructionId": "STP_fpsimd",
        "encodingId": "STP_D_ldstpair_off",
        "mnemonic": "STP",
        "className": "Signed offset",
        "fileName": "stp_fpsimd.xml",
        "mask": 4290772992,
        "value": 1828716544,
        "bitCount": 10,
        "fields": [
            {
                "name": "opc",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "imm7",
                "lsb": 15,
                "width": 7
            },
            {
                "name": "Rt2",
                "lsb": 10,
                "width": 5
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
            }
        ],
        "operandFamilyId": "pair-load-store"
    },
    {
        "instructionId": "STP_fpsimd",
        "encodingId": "STP_D_ldstpair_post",
        "mnemonic": "STP",
        "className": "Post-index",
        "fileName": "stp_fpsimd.xml",
        "mask": 4290772992,
        "value": 1820327936,
        "bitCount": 10,
        "fields": [
            {
                "name": "opc",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "imm7",
                "lsb": 15,
                "width": 7
            },
            {
                "name": "Rt2",
                "lsb": 10,
                "width": 5
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
            }
        ],
        "operandFamilyId": "pair-load-store"
    },
    {
        "instructionId": "STP_fpsimd",
        "encodingId": "STP_D_ldstpair_pre",
        "mnemonic": "STP",
        "className": "Pre-index",
        "fileName": "stp_fpsimd.xml",
        "mask": 4290772992,
        "value": 1837105152,
        "bitCount": 10,
        "fields": [
            {
                "name": "opc",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "imm7",
                "lsb": 15,
                "width": 7
            },
            {
                "name": "Rt2",
                "lsb": 10,
                "width": 5
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
            }
        ],
        "operandFamilyId": "pair-load-store"
    },
    {
        "instructionId": "STP_fpsimd",
        "encodingId": "STP_Q_ldstpair_off",
        "mnemonic": "STP",
        "className": "Signed offset",
        "fileName": "stp_fpsimd.xml",
        "mask": 4290772992,
        "value": 2902458368,
        "bitCount": 10,
        "fields": [
            {
                "name": "opc",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "imm7",
                "lsb": 15,
                "width": 7
            },
            {
                "name": "Rt2",
                "lsb": 10,
                "width": 5
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
            }
        ],
        "operandFamilyId": "pair-load-store"
    },
    {
        "instructionId": "STP_fpsimd",
        "encodingId": "STP_Q_ldstpair_post",
        "mnemonic": "STP",
        "className": "Post-index",
        "fileName": "stp_fpsimd.xml",
        "mask": 4290772992,
        "value": 2894069760,
        "bitCount": 10,
        "fields": [
            {
                "name": "opc",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "imm7",
                "lsb": 15,
                "width": 7
            },
            {
                "name": "Rt2",
                "lsb": 10,
                "width": 5
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
            }
        ],
        "operandFamilyId": "pair-load-store"
    },
    {
        "instructionId": "STP_fpsimd",
        "encodingId": "STP_Q_ldstpair_pre",
        "mnemonic": "STP",
        "className": "Pre-index",
        "fileName": "stp_fpsimd.xml",
        "mask": 4290772992,
        "value": 2910846976,
        "bitCount": 10,
        "fields": [
            {
                "name": "opc",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "imm7",
                "lsb": 15,
                "width": 7
            },
            {
                "name": "Rt2",
                "lsb": 10,
                "width": 5
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
            }
        ],
        "operandFamilyId": "pair-load-store"
    },
    {
        "instructionId": "STP_fpsimd",
        "encodingId": "STP_S_ldstpair_off",
        "mnemonic": "STP",
        "className": "Signed offset",
        "fileName": "stp_fpsimd.xml",
        "mask": 4290772992,
        "value": 754974720,
        "bitCount": 10,
        "fields": [
            {
                "name": "opc",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "imm7",
                "lsb": 15,
                "width": 7
            },
            {
                "name": "Rt2",
                "lsb": 10,
                "width": 5
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
            }
        ],
        "operandFamilyId": "pair-load-store"
    },
    {
        "instructionId": "STP_fpsimd",
        "encodingId": "STP_S_ldstpair_post",
        "mnemonic": "STP",
        "className": "Post-index",
        "fileName": "stp_fpsimd.xml",
        "mask": 4290772992,
        "value": 746586112,
        "bitCount": 10,
        "fields": [
            {
                "name": "opc",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "imm7",
                "lsb": 15,
                "width": 7
            },
            {
                "name": "Rt2",
                "lsb": 10,
                "width": 5
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
            }
        ],
        "operandFamilyId": "pair-load-store"
    },
    {
        "instructionId": "STP_fpsimd",
        "encodingId": "STP_S_ldstpair_pre",
        "mnemonic": "STP",
        "className": "Pre-index",
        "fileName": "stp_fpsimd.xml",
        "mask": 4290772992,
        "value": 763363328,
        "bitCount": 10,
        "fields": [
            {
                "name": "opc",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "imm7",
                "lsb": 15,
                "width": 7
            },
            {
                "name": "Rt2",
                "lsb": 10,
                "width": 5
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
            }
        ],
        "operandFamilyId": "pair-load-store"
    }
];

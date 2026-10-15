export const ENCODINGS = [
    {
        "instructionId": "fcvtzs_z_p_z",
        "encodingId": "fcvtzs_z_p_z_d2w",
        "mnemonic": "FCVTZS",
        "className": "Double-precision to 32-bit, merging",
        "fileName": "fcvtzs_z_p_z.xml",
        "mask": 4294959104,
        "value": 1708695552,
        "bitCount": 19,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "opc2",
                "lsb": 17,
                "width": 2
            },
            {
                "name": "int_U",
                "lsb": 16,
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
                "name": "Zd",
                "lsb": 0,
                "width": 5
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
        "operandFamilyId": "sve-predicated-conversion"
    },
    {
        "instructionId": "fcvtzs_z_p_z",
        "encodingId": "fcvtzs_z_p_z_d2wz",
        "mnemonic": "FCVTZS",
        "className": "Double-precision to 32-bit, zeroing",
        "fileName": "fcvtzs_z_p_z.xml",
        "mask": 4294959104,
        "value": 1692303360,
        "bitCount": 19,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "o2",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "o3",
                "lsb": 14,
                "width": 1
            },
            {
                "name": "int_U",
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
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE2p2 || FEAT_SME2p2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-predicated-conversion"
    },
    {
        "instructionId": "fcvtzs_z_p_z",
        "encodingId": "fcvtzs_z_p_z_d2x",
        "mnemonic": "FCVTZS",
        "className": "Double-precision to 64-bit, merging",
        "fileName": "fcvtzs_z_p_z.xml",
        "mask": 4294959104,
        "value": 1709088768,
        "bitCount": 19,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "opc2",
                "lsb": 17,
                "width": 2
            },
            {
                "name": "int_U",
                "lsb": 16,
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
                "name": "Zd",
                "lsb": 0,
                "width": 5
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
        "operandFamilyId": "sve-predicated-conversion"
    },
    {
        "instructionId": "fcvtzs_z_p_z",
        "encodingId": "fcvtzs_z_p_z_d2xz",
        "mnemonic": "FCVTZS",
        "className": "Double-precision to 64-bit, zeroing",
        "fileName": "fcvtzs_z_p_z.xml",
        "mask": 4294959104,
        "value": 1692385280,
        "bitCount": 19,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "o2",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "o3",
                "lsb": 14,
                "width": 1
            },
            {
                "name": "int_U",
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
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE2p2 || FEAT_SME2p2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-predicated-conversion"
    },
    {
        "instructionId": "fcvtzs_z_p_z",
        "encodingId": "fcvtzs_z_p_z_fp162h",
        "mnemonic": "FCVTZS",
        "className": "Half-precision to 16-bit, merging",
        "fileName": "fcvtzs_z_p_z.xml",
        "mask": 4294959104,
        "value": 1700438016,
        "bitCount": 19,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "opc2",
                "lsb": 17,
                "width": 2
            },
            {
                "name": "int_U",
                "lsb": 16,
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
                "name": "Zd",
                "lsb": 0,
                "width": 5
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
        "operandFamilyId": "sve-predicated-conversion"
    },
    {
        "instructionId": "fcvtzs_z_p_z",
        "encodingId": "fcvtzs_z_p_z_fp162hz",
        "mnemonic": "FCVTZS",
        "className": "Half-precision to 16-bit, zeroing",
        "fileName": "fcvtzs_z_p_z.xml",
        "mask": 4294959104,
        "value": 1683931136,
        "bitCount": 19,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "o2",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "o3",
                "lsb": 14,
                "width": 1
            },
            {
                "name": "int_U",
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
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE2p2 || FEAT_SME2p2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-predicated-conversion"
    },
    {
        "instructionId": "fcvtzs_z_p_z",
        "encodingId": "fcvtzs_z_p_z_fp162w",
        "mnemonic": "FCVTZS",
        "className": "Half-precision to 32-bit, merging",
        "fileName": "fcvtzs_z_p_z.xml",
        "mask": 4294959104,
        "value": 1700569088,
        "bitCount": 19,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "opc2",
                "lsb": 17,
                "width": 2
            },
            {
                "name": "int_U",
                "lsb": 16,
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
                "name": "Zd",
                "lsb": 0,
                "width": 5
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
        "operandFamilyId": "sve-predicated-conversion"
    },
    {
        "instructionId": "fcvtzs_z_p_z",
        "encodingId": "fcvtzs_z_p_z_fp162wz",
        "mnemonic": "FCVTZS",
        "className": "Half-precision to 32-bit, zeroing",
        "fileName": "fcvtzs_z_p_z.xml",
        "mask": 4294959104,
        "value": 1683980288,
        "bitCount": 19,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "o2",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "o3",
                "lsb": 14,
                "width": 1
            },
            {
                "name": "int_U",
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
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE2p2 || FEAT_SME2p2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-predicated-conversion"
    },
    {
        "instructionId": "fcvtzs_z_p_z",
        "encodingId": "fcvtzs_z_p_z_fp162x",
        "mnemonic": "FCVTZS",
        "className": "Half-precision to 64-bit, merging",
        "fileName": "fcvtzs_z_p_z.xml",
        "mask": 4294959104,
        "value": 1700700160,
        "bitCount": 19,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "opc2",
                "lsb": 17,
                "width": 2
            },
            {
                "name": "int_U",
                "lsb": 16,
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
                "name": "Zd",
                "lsb": 0,
                "width": 5
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
        "operandFamilyId": "sve-predicated-conversion"
    },
    {
        "instructionId": "fcvtzs_z_p_z",
        "encodingId": "fcvtzs_z_p_z_fp162xz",
        "mnemonic": "FCVTZS",
        "className": "Half-precision to 64-bit, zeroing",
        "fileName": "fcvtzs_z_p_z.xml",
        "mask": 4294959104,
        "value": 1683996672,
        "bitCount": 19,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "o2",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "o3",
                "lsb": 14,
                "width": 1
            },
            {
                "name": "int_U",
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
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE2p2 || FEAT_SME2p2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-predicated-conversion"
    },
    {
        "instructionId": "fcvtzs_z_p_z",
        "encodingId": "fcvtzs_z_p_z_s2w",
        "mnemonic": "FCVTZS",
        "className": "Single-precision to 32-bit, merging",
        "fileName": "fcvtzs_z_p_z.xml",
        "mask": 4294959104,
        "value": 1704763392,
        "bitCount": 19,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "opc2",
                "lsb": 17,
                "width": 2
            },
            {
                "name": "int_U",
                "lsb": 16,
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
                "name": "Zd",
                "lsb": 0,
                "width": 5
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
        "operandFamilyId": "sve-predicated-conversion"
    },
    {
        "instructionId": "fcvtzs_z_p_z",
        "encodingId": "fcvtzs_z_p_z_s2wz",
        "mnemonic": "FCVTZS",
        "className": "Single-precision to 32-bit, zeroing",
        "fileName": "fcvtzs_z_p_z.xml",
        "mask": 4294959104,
        "value": 1688174592,
        "bitCount": 19,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "o2",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "o3",
                "lsb": 14,
                "width": 1
            },
            {
                "name": "int_U",
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
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE2p2 || FEAT_SME2p2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-predicated-conversion"
    },
    {
        "instructionId": "fcvtzs_z_p_z",
        "encodingId": "fcvtzs_z_p_z_s2x",
        "mnemonic": "FCVTZS",
        "className": "Single-precision to 64-bit, merging",
        "fileName": "fcvtzs_z_p_z.xml",
        "mask": 4294959104,
        "value": 1708957696,
        "bitCount": 19,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "opc2",
                "lsb": 17,
                "width": 2
            },
            {
                "name": "int_U",
                "lsb": 16,
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
                "name": "Zd",
                "lsb": 0,
                "width": 5
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
        "operandFamilyId": "sve-predicated-conversion"
    },
    {
        "instructionId": "fcvtzs_z_p_z",
        "encodingId": "fcvtzs_z_p_z_s2xz",
        "mnemonic": "FCVTZS",
        "className": "Single-precision to 64-bit, zeroing",
        "fileName": "fcvtzs_z_p_z.xml",
        "mask": 4294959104,
        "value": 1692368896,
        "bitCount": 19,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "o2",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "o3",
                "lsb": 14,
                "width": 1
            },
            {
                "name": "int_U",
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
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE2p2 || FEAT_SME2p2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-predicated-conversion"
    }
];

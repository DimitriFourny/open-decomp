export const ENCODINGS = [
    {
        "instructionId": "fcvtzu_z_p_z",
        "encodingId": "fcvtzu_z_p_z_d2w",
        "mnemonic": "FCVTZU",
        "className": "Double-precision to 32-bit, merging",
        "fileName": "fcvtzu_z_p_z.xml",
        "mask": 4294959104,
        "value": 1708761088,
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
        "instructionId": "fcvtzu_z_p_z",
        "encodingId": "fcvtzu_z_p_z_d2wz",
        "mnemonic": "FCVTZU",
        "className": "Double-precision to 32-bit, zeroing",
        "fileName": "fcvtzu_z_p_z.xml",
        "mask": 4294959104,
        "value": 1692311552,
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
        "instructionId": "fcvtzu_z_p_z",
        "encodingId": "fcvtzu_z_p_z_d2x",
        "mnemonic": "FCVTZU",
        "className": "Double-precision to 64-bit, merging",
        "fileName": "fcvtzu_z_p_z.xml",
        "mask": 4294959104,
        "value": 1709154304,
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
        "instructionId": "fcvtzu_z_p_z",
        "encodingId": "fcvtzu_z_p_z_d2xz",
        "mnemonic": "FCVTZU",
        "className": "Double-precision to 64-bit, zeroing",
        "fileName": "fcvtzu_z_p_z.xml",
        "mask": 4294959104,
        "value": 1692393472,
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
        "instructionId": "fcvtzu_z_p_z",
        "encodingId": "fcvtzu_z_p_z_fp162h",
        "mnemonic": "FCVTZU",
        "className": "Half-precision to 16-bit, merging",
        "fileName": "fcvtzu_z_p_z.xml",
        "mask": 4294959104,
        "value": 1700503552,
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
        "instructionId": "fcvtzu_z_p_z",
        "encodingId": "fcvtzu_z_p_z_fp162hz",
        "mnemonic": "FCVTZU",
        "className": "Half-precision to 16-bit, zeroing",
        "fileName": "fcvtzu_z_p_z.xml",
        "mask": 4294959104,
        "value": 1683939328,
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
        "instructionId": "fcvtzu_z_p_z",
        "encodingId": "fcvtzu_z_p_z_fp162w",
        "mnemonic": "FCVTZU",
        "className": "Half-precision to 32-bit, merging",
        "fileName": "fcvtzu_z_p_z.xml",
        "mask": 4294959104,
        "value": 1700634624,
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
        "instructionId": "fcvtzu_z_p_z",
        "encodingId": "fcvtzu_z_p_z_fp162wz",
        "mnemonic": "FCVTZU",
        "className": "Half-precision to 32-bit, zeroing",
        "fileName": "fcvtzu_z_p_z.xml",
        "mask": 4294959104,
        "value": 1683988480,
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
        "instructionId": "fcvtzu_z_p_z",
        "encodingId": "fcvtzu_z_p_z_fp162x",
        "mnemonic": "FCVTZU",
        "className": "Half-precision to 64-bit, merging",
        "fileName": "fcvtzu_z_p_z.xml",
        "mask": 4294959104,
        "value": 1700765696,
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
        "instructionId": "fcvtzu_z_p_z",
        "encodingId": "fcvtzu_z_p_z_fp162xz",
        "mnemonic": "FCVTZU",
        "className": "Half-precision to 64-bit, zeroing",
        "fileName": "fcvtzu_z_p_z.xml",
        "mask": 4294959104,
        "value": 1684004864,
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
        "instructionId": "fcvtzu_z_p_z",
        "encodingId": "fcvtzu_z_p_z_s2w",
        "mnemonic": "FCVTZU",
        "className": "Single-precision to 32-bit, merging",
        "fileName": "fcvtzu_z_p_z.xml",
        "mask": 4294959104,
        "value": 1704828928,
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
        "instructionId": "fcvtzu_z_p_z",
        "encodingId": "fcvtzu_z_p_z_s2wz",
        "mnemonic": "FCVTZU",
        "className": "Single-precision to 32-bit, zeroing",
        "fileName": "fcvtzu_z_p_z.xml",
        "mask": 4294959104,
        "value": 1688182784,
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
        "instructionId": "fcvtzu_z_p_z",
        "encodingId": "fcvtzu_z_p_z_s2x",
        "mnemonic": "FCVTZU",
        "className": "Single-precision to 64-bit, merging",
        "fileName": "fcvtzu_z_p_z.xml",
        "mask": 4294959104,
        "value": 1709023232,
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
        "instructionId": "fcvtzu_z_p_z",
        "encodingId": "fcvtzu_z_p_z_s2xz",
        "mnemonic": "FCVTZU",
        "className": "Single-precision to 64-bit, zeroing",
        "fileName": "fcvtzu_z_p_z.xml",
        "mask": 4294959104,
        "value": 1692377088,
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

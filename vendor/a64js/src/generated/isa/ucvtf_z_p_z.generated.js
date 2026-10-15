export const ENCODINGS = [
    {
        "instructionId": "ucvtf_z_p_z",
        "encodingId": "ucvtf_z_p_z_h2fp16",
        "mnemonic": "UCVTF",
        "className": "16-bit to half-precision, merging",
        "fileName": "ucvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1699979264,
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
        "instructionId": "ucvtf_z_p_z",
        "encodingId": "ucvtf_z_p_z_h2fp16z",
        "mnemonic": "UCVTF",
        "className": "16-bit to half-precision, zeroing",
        "fileName": "ucvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1683808256,
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
        "instructionId": "ucvtf_z_p_z",
        "encodingId": "ucvtf_z_p_z_w2d",
        "mnemonic": "UCVTF",
        "className": "32-bit to double-precision, merging",
        "fileName": "ucvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1708236800,
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
        "instructionId": "ucvtf_z_p_z",
        "encodingId": "ucvtf_z_p_z_w2dz",
        "mnemonic": "UCVTF",
        "className": "32-bit to double-precision, zeroing",
        "fileName": "ucvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1692180480,
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
        "instructionId": "ucvtf_z_p_z",
        "encodingId": "ucvtf_z_p_z_w2fp16",
        "mnemonic": "UCVTF",
        "className": "32-bit to half-precision, merging",
        "fileName": "ucvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1700110336,
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
        "instructionId": "ucvtf_z_p_z",
        "encodingId": "ucvtf_z_p_z_w2fp16z",
        "mnemonic": "UCVTF",
        "className": "32-bit to half-precision, zeroing",
        "fileName": "ucvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1683857408,
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
        "instructionId": "ucvtf_z_p_z",
        "encodingId": "ucvtf_z_p_z_w2s",
        "mnemonic": "UCVTF",
        "className": "32-bit to single-precision, merging",
        "fileName": "ucvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1704304640,
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
        "instructionId": "ucvtf_z_p_z",
        "encodingId": "ucvtf_z_p_z_w2sz",
        "mnemonic": "UCVTF",
        "className": "32-bit to single-precision, zeroing",
        "fileName": "ucvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1688051712,
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
        "instructionId": "ucvtf_z_p_z",
        "encodingId": "ucvtf_z_p_z_x2d",
        "mnemonic": "UCVTF",
        "className": "64-bit to double-precision, merging",
        "fileName": "ucvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1708630016,
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
        "instructionId": "ucvtf_z_p_z",
        "encodingId": "ucvtf_z_p_z_x2dz",
        "mnemonic": "UCVTF",
        "className": "64-bit to double-precision, zeroing",
        "fileName": "ucvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1692262400,
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
        "instructionId": "ucvtf_z_p_z",
        "encodingId": "ucvtf_z_p_z_x2fp16",
        "mnemonic": "UCVTF",
        "className": "64-bit to half-precision, merging",
        "fileName": "ucvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1700241408,
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
        "instructionId": "ucvtf_z_p_z",
        "encodingId": "ucvtf_z_p_z_x2fp16z",
        "mnemonic": "UCVTF",
        "className": "64-bit to half-precision, zeroing",
        "fileName": "ucvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1683873792,
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
        "instructionId": "ucvtf_z_p_z",
        "encodingId": "ucvtf_z_p_z_x2s",
        "mnemonic": "UCVTF",
        "className": "64-bit to single-precision, merging",
        "fileName": "ucvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1708498944,
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
        "instructionId": "ucvtf_z_p_z",
        "encodingId": "ucvtf_z_p_z_x2sz",
        "mnemonic": "UCVTF",
        "className": "64-bit to single-precision, zeroing",
        "fileName": "ucvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1692246016,
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

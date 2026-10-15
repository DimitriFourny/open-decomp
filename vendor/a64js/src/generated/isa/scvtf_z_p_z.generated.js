export const ENCODINGS = [
    {
        "instructionId": "scvtf_z_p_z",
        "encodingId": "scvtf_z_p_z_h2fp16",
        "mnemonic": "SCVTF",
        "className": "16-bit to half-precision, merging",
        "fileName": "scvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1699913728,
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
        "instructionId": "scvtf_z_p_z",
        "encodingId": "scvtf_z_p_z_h2fp16z",
        "mnemonic": "SCVTF",
        "className": "16-bit to half-precision, zeroing",
        "fileName": "scvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1683800064,
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
        "instructionId": "scvtf_z_p_z",
        "encodingId": "scvtf_z_p_z_w2d",
        "mnemonic": "SCVTF",
        "className": "32-bit to double-precision, merging",
        "fileName": "scvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1708171264,
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
        "instructionId": "scvtf_z_p_z",
        "encodingId": "scvtf_z_p_z_w2dz",
        "mnemonic": "SCVTF",
        "className": "32-bit to double-precision, zeroing",
        "fileName": "scvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1692172288,
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
        "instructionId": "scvtf_z_p_z",
        "encodingId": "scvtf_z_p_z_w2fp16",
        "mnemonic": "SCVTF",
        "className": "32-bit to half-precision, merging",
        "fileName": "scvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1700044800,
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
        "instructionId": "scvtf_z_p_z",
        "encodingId": "scvtf_z_p_z_w2fp16z",
        "mnemonic": "SCVTF",
        "className": "32-bit to half-precision, zeroing",
        "fileName": "scvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1683849216,
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
        "instructionId": "scvtf_z_p_z",
        "encodingId": "scvtf_z_p_z_w2s",
        "mnemonic": "SCVTF",
        "className": "32-bit to single-precision, merging",
        "fileName": "scvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1704239104,
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
        "instructionId": "scvtf_z_p_z",
        "encodingId": "scvtf_z_p_z_w2sz",
        "mnemonic": "SCVTF",
        "className": "32-bit to single-precision, zeroing",
        "fileName": "scvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1688043520,
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
        "instructionId": "scvtf_z_p_z",
        "encodingId": "scvtf_z_p_z_x2d",
        "mnemonic": "SCVTF",
        "className": "64-bit to double-precision, merging",
        "fileName": "scvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1708564480,
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
        "instructionId": "scvtf_z_p_z",
        "encodingId": "scvtf_z_p_z_x2dz",
        "mnemonic": "SCVTF",
        "className": "64-bit to double-precision, zeroing",
        "fileName": "scvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1692254208,
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
        "instructionId": "scvtf_z_p_z",
        "encodingId": "scvtf_z_p_z_x2fp16",
        "mnemonic": "SCVTF",
        "className": "64-bit to half-precision, merging",
        "fileName": "scvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1700175872,
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
        "instructionId": "scvtf_z_p_z",
        "encodingId": "scvtf_z_p_z_x2fp16z",
        "mnemonic": "SCVTF",
        "className": "64-bit to half-precision, zeroing",
        "fileName": "scvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1683865600,
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
        "instructionId": "scvtf_z_p_z",
        "encodingId": "scvtf_z_p_z_x2s",
        "mnemonic": "SCVTF",
        "className": "64-bit to single-precision, merging",
        "fileName": "scvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1708433408,
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
        "instructionId": "scvtf_z_p_z",
        "encodingId": "scvtf_z_p_z_x2sz",
        "mnemonic": "SCVTF",
        "className": "64-bit to single-precision, zeroing",
        "fileName": "scvtf_z_p_z.xml",
        "mask": 4294959104,
        "value": 1692237824,
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

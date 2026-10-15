export const ENCODINGS = [
    {
        "instructionId": "LD3_advsimd_sngl",
        "encodingId": "LD3_asisdlso_D3_3d",
        "mnemonic": "LD3",
        "className": "No offset",
        "fileName": "ld3_advsimd_sngl.xml",
        "mask": 3221224448,
        "value": 222340096,
        "bitCount": 21,
        "fields": [
            {
                "name": "Q",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "R",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "o2",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "opcode",
                "lsb": 13,
                "width": 3
            },
            {
                "name": "S",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "size",
                "lsb": 10,
                "width": 2
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
            "FEAT_AdvSIMD"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_AdvSIMD",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-single-structure"
    },
    {
        "instructionId": "LD3_advsimd_sngl",
        "encodingId": "LD3_asisdlsop_D3_i3d",
        "mnemonic": "LD3",
        "className": "Post-index",
        "fileName": "ld3_advsimd_sngl.xml",
        "mask": 3221224448,
        "value": 232760320,
        "bitCount": 21,
        "fields": [
            {
                "name": "Q",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "R",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "opcode",
                "lsb": 13,
                "width": 3
            },
            {
                "name": "S",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "size",
                "lsb": 10,
                "width": 2
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
            "FEAT_AdvSIMD"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_AdvSIMD",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-single-structure"
    },
    {
        "instructionId": "LD3_advsimd_sngl",
        "encodingId": "LD3_asisdlso_S3_3s",
        "mnemonic": "LD3",
        "className": "No offset",
        "fileName": "ld3_advsimd_sngl.xml",
        "mask": 3221220352,
        "value": 222339072,
        "bitCount": 20,
        "fields": [
            {
                "name": "Q",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "R",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "o2",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "opcode",
                "lsb": 13,
                "width": 3
            },
            {
                "name": "S",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "size",
                "lsb": 10,
                "width": 2
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
            "FEAT_AdvSIMD"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_AdvSIMD",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-single-structure"
    },
    {
        "instructionId": "LD3_advsimd_sngl",
        "encodingId": "LD3_asisdlsop_S3_i3s",
        "mnemonic": "LD3",
        "className": "Post-index",
        "fileName": "ld3_advsimd_sngl.xml",
        "mask": 3221220352,
        "value": 232759296,
        "bitCount": 20,
        "fields": [
            {
                "name": "Q",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "R",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "opcode",
                "lsb": 13,
                "width": 3
            },
            {
                "name": "S",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "size",
                "lsb": 10,
                "width": 2
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
            "FEAT_AdvSIMD"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_AdvSIMD",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-single-structure"
    },
    {
        "instructionId": "LD3_advsimd_sngl",
        "encodingId": "LD3_asisdlso_H3_3h",
        "mnemonic": "LD3",
        "className": "No offset",
        "fileName": "ld3_advsimd_sngl.xml",
        "mask": 3221218304,
        "value": 222322688,
        "bitCount": 19,
        "fields": [
            {
                "name": "Q",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "R",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "o2",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "opcode",
                "lsb": 13,
                "width": 3
            },
            {
                "name": "S",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "size",
                "lsb": 10,
                "width": 2
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
            "FEAT_AdvSIMD"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_AdvSIMD",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-single-structure"
    },
    {
        "instructionId": "LD3_advsimd_sngl",
        "encodingId": "LD3_asisdlsop_H3_i3h",
        "mnemonic": "LD3",
        "className": "Post-index",
        "fileName": "ld3_advsimd_sngl.xml",
        "mask": 3221218304,
        "value": 232742912,
        "bitCount": 19,
        "fields": [
            {
                "name": "Q",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "R",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "opcode",
                "lsb": 13,
                "width": 3
            },
            {
                "name": "S",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "size",
                "lsb": 10,
                "width": 2
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
            "FEAT_AdvSIMD"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_AdvSIMD",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-single-structure"
    },
    {
        "instructionId": "LD3_advsimd_sngl",
        "encodingId": "LD3_asisdlso_B3_3b",
        "mnemonic": "LD3",
        "className": "No offset",
        "fileName": "ld3_advsimd_sngl.xml",
        "mask": 3221217280,
        "value": 222306304,
        "bitCount": 18,
        "fields": [
            {
                "name": "Q",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "R",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "o2",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "opcode",
                "lsb": 13,
                "width": 3
            },
            {
                "name": "S",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "size",
                "lsb": 10,
                "width": 2
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
            "FEAT_AdvSIMD"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_AdvSIMD",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-single-structure"
    },
    {
        "instructionId": "LD3_advsimd_sngl",
        "encodingId": "LD3_asisdlsop_B3_i3b",
        "mnemonic": "LD3",
        "className": "Post-index",
        "fileName": "ld3_advsimd_sngl.xml",
        "mask": 3221217280,
        "value": 232726528,
        "bitCount": 18,
        "fields": [
            {
                "name": "Q",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "R",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "opcode",
                "lsb": 13,
                "width": 3
            },
            {
                "name": "S",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "size",
                "lsb": 10,
                "width": 2
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
            "FEAT_AdvSIMD"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_AdvSIMD",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-single-structure"
    },
    {
        "instructionId": "LD3_advsimd_sngl",
        "encodingId": "LD3_asisdlsop_DX3_r3d",
        "mnemonic": "LD3",
        "className": "Post-index",
        "fileName": "ld3_advsimd_sngl.xml",
        "mask": 3219192832,
        "value": 230728704,
        "bitCount": 16,
        "fields": [
            {
                "name": "Q",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "R",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "opcode",
                "lsb": 13,
                "width": 3
            },
            {
                "name": "S",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "size",
                "lsb": 10,
                "width": 2
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
            "FEAT_AdvSIMD"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_AdvSIMD",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-single-structure"
    },
    {
        "instructionId": "LD3_advsimd_sngl",
        "encodingId": "LD3_asisdlsop_SX3_r3s",
        "mnemonic": "LD3",
        "className": "Post-index",
        "fileName": "ld3_advsimd_sngl.xml",
        "mask": 3219188736,
        "value": 230727680,
        "bitCount": 15,
        "fields": [
            {
                "name": "Q",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "R",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "opcode",
                "lsb": 13,
                "width": 3
            },
            {
                "name": "S",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "size",
                "lsb": 10,
                "width": 2
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
            "FEAT_AdvSIMD"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_AdvSIMD",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-single-structure"
    },
    {
        "instructionId": "LD3_advsimd_sngl",
        "encodingId": "LD3_asisdlsop_HX3_r3h",
        "mnemonic": "LD3",
        "className": "Post-index",
        "fileName": "ld3_advsimd_sngl.xml",
        "mask": 3219186688,
        "value": 230711296,
        "bitCount": 14,
        "fields": [
            {
                "name": "Q",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "R",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "opcode",
                "lsb": 13,
                "width": 3
            },
            {
                "name": "S",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "size",
                "lsb": 10,
                "width": 2
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
            "FEAT_AdvSIMD"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_AdvSIMD",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-single-structure"
    },
    {
        "instructionId": "LD3_advsimd_sngl",
        "encodingId": "LD3_asisdlsop_BX3_r3b",
        "mnemonic": "LD3",
        "className": "Post-index",
        "fileName": "ld3_advsimd_sngl.xml",
        "mask": 3219185664,
        "value": 230694912,
        "bitCount": 13,
        "fields": [
            {
                "name": "Q",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "R",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "opcode",
                "lsb": 13,
                "width": 3
            },
            {
                "name": "S",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "size",
                "lsb": 10,
                "width": 2
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
            "FEAT_AdvSIMD"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_AdvSIMD",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-single-structure"
    }
];

export const ENCODINGS = [
    {
        "instructionId": "ST1_advsimd_sngl",
        "encodingId": "ST1_asisdlso_D1_1d",
        "mnemonic": "ST1",
        "className": "No offset",
        "fileName": "st1_advsimd_sngl.xml",
        "mask": 3221224448,
        "value": 218137600,
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
        "instructionId": "ST1_advsimd_sngl",
        "encodingId": "ST1_asisdlsop_D1_i1d",
        "mnemonic": "ST1",
        "className": "Post-index",
        "fileName": "st1_advsimd_sngl.xml",
        "mask": 3221224448,
        "value": 228557824,
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
        "instructionId": "ST1_advsimd_sngl",
        "encodingId": "ST1_asisdlso_S1_1s",
        "mnemonic": "ST1",
        "className": "No offset",
        "fileName": "st1_advsimd_sngl.xml",
        "mask": 3221220352,
        "value": 218136576,
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
        "instructionId": "ST1_advsimd_sngl",
        "encodingId": "ST1_asisdlsop_S1_i1s",
        "mnemonic": "ST1",
        "className": "Post-index",
        "fileName": "st1_advsimd_sngl.xml",
        "mask": 3221220352,
        "value": 228556800,
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
        "instructionId": "ST1_advsimd_sngl",
        "encodingId": "ST1_asisdlso_H1_1h",
        "mnemonic": "ST1",
        "className": "No offset",
        "fileName": "st1_advsimd_sngl.xml",
        "mask": 3221218304,
        "value": 218120192,
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
        "instructionId": "ST1_advsimd_sngl",
        "encodingId": "ST1_asisdlsop_H1_i1h",
        "mnemonic": "ST1",
        "className": "Post-index",
        "fileName": "st1_advsimd_sngl.xml",
        "mask": 3221218304,
        "value": 228540416,
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
        "instructionId": "ST1_advsimd_sngl",
        "encodingId": "ST1_asisdlso_B1_1b",
        "mnemonic": "ST1",
        "className": "No offset",
        "fileName": "st1_advsimd_sngl.xml",
        "mask": 3221217280,
        "value": 218103808,
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
        "instructionId": "ST1_advsimd_sngl",
        "encodingId": "ST1_asisdlsop_B1_i1b",
        "mnemonic": "ST1",
        "className": "Post-index",
        "fileName": "st1_advsimd_sngl.xml",
        "mask": 3221217280,
        "value": 228524032,
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
        "instructionId": "ST1_advsimd_sngl",
        "encodingId": "ST1_asisdlsop_DX1_r1d",
        "mnemonic": "ST1",
        "className": "Post-index",
        "fileName": "st1_advsimd_sngl.xml",
        "mask": 3219192832,
        "value": 226526208,
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
        "instructionId": "ST1_advsimd_sngl",
        "encodingId": "ST1_asisdlsop_SX1_r1s",
        "mnemonic": "ST1",
        "className": "Post-index",
        "fileName": "st1_advsimd_sngl.xml",
        "mask": 3219188736,
        "value": 226525184,
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
        "instructionId": "ST1_advsimd_sngl",
        "encodingId": "ST1_asisdlsop_HX1_r1h",
        "mnemonic": "ST1",
        "className": "Post-index",
        "fileName": "st1_advsimd_sngl.xml",
        "mask": 3219186688,
        "value": 226508800,
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
        "instructionId": "ST1_advsimd_sngl",
        "encodingId": "ST1_asisdlsop_BX1_r1b",
        "mnemonic": "ST1",
        "className": "Post-index",
        "fileName": "st1_advsimd_sngl.xml",
        "mask": 3219185664,
        "value": 226492416,
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

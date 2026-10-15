export const ENCODINGS = [
    {
        "instructionId": "ST4_advsimd_sngl",
        "encodingId": "ST4_asisdlso_D4_4d",
        "mnemonic": "ST4",
        "className": "No offset",
        "fileName": "st4_advsimd_sngl.xml",
        "mask": 3221224448,
        "value": 220242944,
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
        "instructionId": "ST4_advsimd_sngl",
        "encodingId": "ST4_asisdlsop_D4_i4d",
        "mnemonic": "ST4",
        "className": "Post-index",
        "fileName": "st4_advsimd_sngl.xml",
        "mask": 3221224448,
        "value": 230663168,
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
        "instructionId": "ST4_advsimd_sngl",
        "encodingId": "ST4_asisdlso_S4_4s",
        "mnemonic": "ST4",
        "className": "No offset",
        "fileName": "st4_advsimd_sngl.xml",
        "mask": 3221220352,
        "value": 220241920,
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
        "instructionId": "ST4_advsimd_sngl",
        "encodingId": "ST4_asisdlsop_S4_i4s",
        "mnemonic": "ST4",
        "className": "Post-index",
        "fileName": "st4_advsimd_sngl.xml",
        "mask": 3221220352,
        "value": 230662144,
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
        "instructionId": "ST4_advsimd_sngl",
        "encodingId": "ST4_asisdlso_H4_4h",
        "mnemonic": "ST4",
        "className": "No offset",
        "fileName": "st4_advsimd_sngl.xml",
        "mask": 3221218304,
        "value": 220225536,
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
        "instructionId": "ST4_advsimd_sngl",
        "encodingId": "ST4_asisdlsop_H4_i4h",
        "mnemonic": "ST4",
        "className": "Post-index",
        "fileName": "st4_advsimd_sngl.xml",
        "mask": 3221218304,
        "value": 230645760,
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
        "instructionId": "ST4_advsimd_sngl",
        "encodingId": "ST4_asisdlso_B4_4b",
        "mnemonic": "ST4",
        "className": "No offset",
        "fileName": "st4_advsimd_sngl.xml",
        "mask": 3221217280,
        "value": 220209152,
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
        "instructionId": "ST4_advsimd_sngl",
        "encodingId": "ST4_asisdlsop_B4_i4b",
        "mnemonic": "ST4",
        "className": "Post-index",
        "fileName": "st4_advsimd_sngl.xml",
        "mask": 3221217280,
        "value": 230629376,
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
        "instructionId": "ST4_advsimd_sngl",
        "encodingId": "ST4_asisdlsop_DX4_r4d",
        "mnemonic": "ST4",
        "className": "Post-index",
        "fileName": "st4_advsimd_sngl.xml",
        "mask": 3219192832,
        "value": 228631552,
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
        "instructionId": "ST4_advsimd_sngl",
        "encodingId": "ST4_asisdlsop_SX4_r4s",
        "mnemonic": "ST4",
        "className": "Post-index",
        "fileName": "st4_advsimd_sngl.xml",
        "mask": 3219188736,
        "value": 228630528,
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
        "instructionId": "ST4_advsimd_sngl",
        "encodingId": "ST4_asisdlsop_HX4_r4h",
        "mnemonic": "ST4",
        "className": "Post-index",
        "fileName": "st4_advsimd_sngl.xml",
        "mask": 3219186688,
        "value": 228614144,
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
        "instructionId": "ST4_advsimd_sngl",
        "encodingId": "ST4_asisdlsop_BX4_r4b",
        "mnemonic": "ST4",
        "className": "Post-index",
        "fileName": "st4_advsimd_sngl.xml",
        "mask": 3219185664,
        "value": 228597760,
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

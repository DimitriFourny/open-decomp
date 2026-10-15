export const ENCODINGS = [
    {
        "instructionId": "ldff1sh_z_p_bz",
        "encodingId": "ldff1sh_z_p_bz_d_64_scaled",
        "mnemonic": "LDFF1SH",
        "className": "64-bit scaled offset",
        "fileName": "ldff1sh_z_p_bz.xml",
        "mask": 4292927488,
        "value": 3303055360,
        "bitCount": 14,
        "fields": [
            {
                "name": "opc",
                "lsb": 23,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "U",
                "lsb": 14,
                "width": 1
            },
            {
                "name": "ff",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-fault-tolerant-load"
    },
    {
        "instructionId": "ldff1sh_z_p_bz",
        "encodingId": "ldff1sh_z_p_bz_d_64_unscaled",
        "mnemonic": "LDFF1SH",
        "className": "64-bit unscaled offset",
        "fileName": "ldff1sh_z_p_bz.xml",
        "mask": 4292927488,
        "value": 3300958208,
        "bitCount": 14,
        "fields": [
            {
                "name": "msz",
                "lsb": 23,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "U",
                "lsb": 14,
                "width": 1
            },
            {
                "name": "ff",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-fault-tolerant-load"
    },
    {
        "instructionId": "ldff1sh_z_p_bz",
        "encodingId": "ldff1sh_z_p_bz_d_x32_scaled",
        "mnemonic": "LDFF1SH",
        "className": "32-bit unpacked scaled offset",
        "fileName": "ldff1sh_z_p_bz.xml",
        "mask": 4288733184,
        "value": 3298828288,
        "bitCount": 13,
        "fields": [
            {
                "name": "opc",
                "lsb": 23,
                "width": 2
            },
            {
                "name": "xs",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "U",
                "lsb": 14,
                "width": 1
            },
            {
                "name": "ff",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-fault-tolerant-load"
    },
    {
        "instructionId": "ldff1sh_z_p_bz",
        "encodingId": "ldff1sh_z_p_bz_d_x32_unscaled",
        "mnemonic": "LDFF1SH",
        "className": "32-bit unpacked unscaled offset",
        "fileName": "ldff1sh_z_p_bz.xml",
        "mask": 4288733184,
        "value": 3296731136,
        "bitCount": 13,
        "fields": [
            {
                "name": "msz",
                "lsb": 23,
                "width": 2
            },
            {
                "name": "xs",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "U",
                "lsb": 14,
                "width": 1
            },
            {
                "name": "ff",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-fault-tolerant-load"
    },
    {
        "instructionId": "ldff1sh_z_p_bz",
        "encodingId": "ldff1sh_z_p_bz_s_x32_scaled",
        "mnemonic": "LDFF1SH",
        "className": "32-bit scaled offset",
        "fileName": "ldff1sh_z_p_bz.xml",
        "mask": 4288733184,
        "value": 2225086464,
        "bitCount": 13,
        "fields": [
            {
                "name": "xs",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "U",
                "lsb": 14,
                "width": 1
            },
            {
                "name": "ff",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-fault-tolerant-load"
    },
    {
        "instructionId": "ldff1sh_z_p_bz",
        "encodingId": "ldff1sh_z_p_bz_s_x32_unscaled",
        "mnemonic": "LDFF1SH",
        "className": "32-bit unscaled offset",
        "fileName": "ldff1sh_z_p_bz.xml",
        "mask": 4288733184,
        "value": 2222989312,
        "bitCount": 13,
        "fields": [
            {
                "name": "opc",
                "lsb": 23,
                "width": 2
            },
            {
                "name": "xs",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "U",
                "lsb": 14,
                "width": 1
            },
            {
                "name": "ff",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-fault-tolerant-load"
    }
];

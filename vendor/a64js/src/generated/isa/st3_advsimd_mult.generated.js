export const ENCODINGS = [
    {
        "instructionId": "ST3_advsimd_mult",
        "encodingId": "ST3_asisdlse_R3",
        "mnemonic": "ST3",
        "className": "No offset",
        "fileName": "st3_advsimd_mult.xml",
        "mask": 3221221376,
        "value": 201342976,
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
                "name": "opcode",
                "lsb": 12,
                "width": 4
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
        "operandFamilyId": "advsimd-multiple-structure"
    },
    {
        "instructionId": "ST3_advsimd_mult",
        "encodingId": "ST3_asisdlsep_I3_i",
        "mnemonic": "ST3",
        "className": "Post-index",
        "fileName": "st3_advsimd_mult.xml",
        "mask": 3221221376,
        "value": 211763200,
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
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "opcode",
                "lsb": 12,
                "width": 4
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
        "operandFamilyId": "advsimd-multiple-structure"
    },
    {
        "instructionId": "ST3_advsimd_mult",
        "encodingId": "ST3_asisdlsep_R3_r",
        "mnemonic": "ST3",
        "className": "Post-index",
        "fileName": "st3_advsimd_mult.xml",
        "mask": 3219189760,
        "value": 209731584,
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
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "opcode",
                "lsb": 12,
                "width": 4
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
        "operandFamilyId": "advsimd-multiple-structure"
    }
];

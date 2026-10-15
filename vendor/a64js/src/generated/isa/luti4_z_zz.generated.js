export const ENCODINGS = [
    {
        "instructionId": "luti4_z_zz",
        "encodingId": "luti4_z_zz_8",
        "mnemonic": "LUTI4",
        "className": "Byte, single register table",
        "fileName": "luti4_z_zz.xml",
        "mask": 4284546048,
        "value": 1163961344,
        "bitCount": 16,
        "fields": [
            {
                "name": "i1",
                "lsb": 23,
                "width": 1
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
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
            "(FEAT_SVE2 || FEAT_SME2) && FEAT_LUT"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_LUT",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-fp8-luti"
    },
    {
        "instructionId": "luti4_z_zz",
        "encodingId": "luti4_z_zz_1x16",
        "mnemonic": "LUTI4",
        "className": "Halfword, single register table",
        "fileName": "luti4_z_zz.xml",
        "mask": 4280351744,
        "value": 1159773184,
        "bitCount": 15,
        "fields": [
            {
                "name": "i2",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "op",
                "lsb": 11,
                "width": 1
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
            "(FEAT_SVE2 || FEAT_SME2) && FEAT_LUT"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_LUT",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "guardDiagnostics": [
            "MaxImplementedAnyVL() < 256: maximum vector length is not configured; assumes the instruction is admitted by the implementation"
        ],
        "operandFamilyId": "sve-fp8-luti"
    },
    {
        "instructionId": "luti4_z_zz",
        "encodingId": "luti4_z_zz_2x16",
        "mnemonic": "LUTI4",
        "className": "Halfword, two register table",
        "fileName": "luti4_z_zz.xml",
        "mask": 4280351744,
        "value": 1159771136,
        "bitCount": 15,
        "fields": [
            {
                "name": "i2",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "op",
                "lsb": 11,
                "width": 1
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
            "(FEAT_SVE2 || FEAT_SME2) && FEAT_LUT"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_LUT",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-fp8-luti"
    }
];

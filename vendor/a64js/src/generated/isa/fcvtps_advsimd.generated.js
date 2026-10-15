export const ENCODINGS = [
    {
        "instructionId": "FCVTPS_advsimd",
        "encodingId": "FCVTPS_asisdmiscfp16_R",
        "mnemonic": "FCVTPS",
        "className": "Scalar half-precision",
        "fileName": "fcvtps_advsimd.xml",
        "mask": 4294966272,
        "value": 1593419776,
        "bitCount": 22,
        "fields": [
            {
                "name": "U",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "o2",
                "lsb": 23,
                "width": 1
            },
            {
                "name": "o1",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_AdvSIMD && FEAT_FP16"
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
            },
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_FP16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-unary"
    },
    {
        "instructionId": "FCVTPS_advsimd",
        "encodingId": "FCVTPS_asimdmiscfp16_R",
        "mnemonic": "FCVTPS",
        "className": "Vector half-precision",
        "fileName": "fcvtps_advsimd.xml",
        "mask": 3221224448,
        "value": 251242496,
        "bitCount": 21,
        "fields": [
            {
                "name": "Q",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "U",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "o2",
                "lsb": 23,
                "width": 1
            },
            {
                "name": "o1",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_AdvSIMD && FEAT_FP16"
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
            },
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_FP16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-unary"
    },
    {
        "instructionId": "FCVTPS_advsimd",
        "encodingId": "FCVTPS_asisdmisc_R",
        "mnemonic": "FCVTPS",
        "className": "Scalar single-precision and double-precision",
        "fileName": "fcvtps_advsimd.xml",
        "mask": 4290771968,
        "value": 1587652608,
        "bitCount": 21,
        "fields": [
            {
                "name": "U",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "o2",
                "lsb": 23,
                "width": 1
            },
            {
                "name": "sz",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "o1",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rd",
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
        "operandFamilyId": "advsimd-unary"
    },
    {
        "instructionId": "FCVTPS_advsimd",
        "encodingId": "FCVTPS_asimdmisc_R",
        "mnemonic": "FCVTPS",
        "className": "Vector single-precision and double-precision",
        "fileName": "fcvtps_advsimd.xml",
        "mask": 3217030144,
        "value": 245475328,
        "bitCount": 20,
        "fields": [
            {
                "name": "Q",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "U",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "o2",
                "lsb": 23,
                "width": 1
            },
            {
                "name": "sz",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "o1",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rd",
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
            },
            {
                "all": [
                    {
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "sz",
                                "msb": 0,
                                "lsb": 0
                            },
                            {
                                "field": "Q",
                                "msb": 0,
                                "lsb": 0
                            }
                        ],
                        "value": 2
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-unary"
    }
];

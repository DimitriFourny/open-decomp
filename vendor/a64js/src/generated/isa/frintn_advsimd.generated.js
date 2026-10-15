export const ENCODINGS = [
    {
        "instructionId": "FRINTN_advsimd",
        "encodingId": "FRINTN_asimdmiscfp16_R",
        "mnemonic": "FRINTN",
        "className": "Half-precision",
        "fileName": "frintn_advsimd.xml",
        "mask": 3221224448,
        "value": 242845696,
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
        "instructionId": "FRINTN_advsimd",
        "encodingId": "FRINTN_asimdmisc_R",
        "mnemonic": "FRINTN",
        "className": "Single-precision and double-precision",
        "fileName": "frintn_advsimd.xml",
        "mask": 3217030144,
        "value": 237078528,
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

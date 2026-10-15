export const ENCODINGS = [
    {
        "instructionId": "CMLE_advsimd",
        "encodingId": "CMLE_asisdmisc_Z",
        "mnemonic": "CMLE",
        "className": "Scalar",
        "fileName": "cmle_advsimd.xml",
        "mask": 4294966272,
        "value": 2128648192,
        "bitCount": 22,
        "fields": [
            {
                "name": "U",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "op",
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
                        "kind": "ne",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 3
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-compare"
    },
    {
        "instructionId": "CMLE_advsimd",
        "encodingId": "CMLE_asimdmisc_Z",
        "mnemonic": "CMLE",
        "className": "Vector",
        "fileName": "cmle_advsimd.xml",
        "mask": 3208641536,
        "value": 773888000,
        "bitCount": 19,
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
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "op",
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
                                "field": "size",
                                "msb": 1,
                                "lsb": 0
                            },
                            {
                                "field": "Q",
                                "msb": 0,
                                "lsb": 0
                            }
                        ],
                        "value": 6
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-compare"
    }
];

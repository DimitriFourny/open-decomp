export const ENCODINGS = [
    {
        "instructionId": "REV16_advsimd",
        "encodingId": "REV16_asimdmisc_R",
        "mnemonic": "REV16",
        "className": "Vector",
        "fileName": "rev16_advsimd.xml",
        "mask": 3208641536,
        "value": 236984320,
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
                "name": "o0",
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
                                "field": "o0",
                                "msb": 0,
                                "lsb": 0
                            },
                            {
                                "field": "U",
                                "msb": 0,
                                "lsb": 0
                            }
                        ],
                        "value": 0
                    },
                    {
                        "kind": "eq",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 3
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
                                "field": "o0",
                                "msb": 0,
                                "lsb": 0
                            },
                            {
                                "field": "U",
                                "msb": 0,
                                "lsb": 0
                            }
                        ],
                        "value": 1
                    },
                    {
                        "kind": "eq",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
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
                                "field": "o0",
                                "msb": 0,
                                "lsb": 0
                            },
                            {
                                "field": "U",
                                "msb": 0,
                                "lsb": 0
                            }
                        ],
                        "value": 1
                    },
                    {
                        "kind": "eq",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 3
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
                                "field": "o0",
                                "msb": 0,
                                "lsb": 0
                            },
                            {
                                "field": "U",
                                "msb": 0,
                                "lsb": 0
                            }
                        ],
                        "value": 2
                    },
                    {
                        "kind": "eq",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 1
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
                                "field": "o0",
                                "msb": 0,
                                "lsb": 0
                            },
                            {
                                "field": "U",
                                "msb": 0,
                                "lsb": 0
                            }
                        ],
                        "value": 2
                    },
                    {
                        "kind": "eq",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
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
                                "field": "o0",
                                "msb": 0,
                                "lsb": 0
                            },
                            {
                                "field": "U",
                                "msb": 0,
                                "lsb": 0
                            }
                        ],
                        "value": 2
                    },
                    {
                        "kind": "eq",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 3
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
                                "field": "o0",
                                "msb": 0,
                                "lsb": 0
                            },
                            {
                                "field": "U",
                                "msb": 0,
                                "lsb": 0
                            }
                        ],
                        "value": 3
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-unary"
    }
];

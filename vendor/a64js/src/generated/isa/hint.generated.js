export const ENCODINGS = [
    {
        "instructionId": "HINT",
        "encodingId": "HINT_HM_hints",
        "mnemonic": "HINT",
        "className": "System",
        "fileName": "hint.xml",
        "mask": 4294963231,
        "value": 3573751839,
        "bitCount": 25,
        "fields": [
            {
                "name": "CRm",
                "lsb": 8,
                "width": 4
            },
            {
                "name": "op2",
                "lsb": 5,
                "width": 3
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 6
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_DGH",
                        "implemented": false
                    }
                ],
                "outcome": "nop"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "ne",
                        "field": "op2",
                        "mask": 7,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne",
                        "field": "op2",
                        "mask": 7,
                        "lsb": 0,
                        "value": 2
                    },
                    {
                        "kind": "ne",
                        "field": "op2",
                        "mask": 7,
                        "lsb": 0,
                        "value": 4
                    },
                    {
                        "kind": "ne",
                        "field": "op2",
                        "mask": 7,
                        "lsb": 0,
                        "value": 6
                    }
                ],
                "outcome": "nop"
            },
            {
                "all": [
                    {
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 16
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_RAS",
                        "implemented": false
                    }
                ],
                "outcome": "nop"
            },
            {
                "all": [
                    {
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 17
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SPE",
                        "implemented": false
                    }
                ],
                "outcome": "nop"
            },
            {
                "all": [
                    {
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 18
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_TRF",
                        "implemented": false
                    }
                ],
                "outcome": "nop"
            },
            {
                "all": [
                    {
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 19
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_GCS",
                        "implemented": false
                    }
                ],
                "outcome": "nop"
            },
            {
                "all": [
                    {
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 22
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_CLRBHB",
                        "implemented": false
                    }
                ],
                "outcome": "nop"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 4
                    },
                    {
                        "kind": "eq",
                        "field": "op2",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_BTI",
                        "implemented": false
                    }
                ],
                "outcome": "nop"
            },
            {
                "all": [
                    {
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 40
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_CHK",
                        "implemented": false
                    }
                ],
                "outcome": "nop"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 6
                    },
                    {
                        "kind": "eq",
                        "field": "op2",
                        "mask": 6,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_PCDPHINT",
                        "implemented": false
                    }
                ],
                "outcome": "nop"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 6
                    },
                    {
                        "kind": "eq",
                        "field": "op2",
                        "mask": 6,
                        "lsb": 0,
                        "value": 2
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_CMH",
                        "implemented": false
                    }
                ],
                "outcome": "nop"
            },
            {
                "all": [
                    {
                        "kind": "eq_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 52
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_CMH",
                        "implemented": false
                    }
                ],
                "outcome": "nop"
            },
            {
                "all": [
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 0
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 1
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 2
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 3
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 4
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 5
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 6
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 7
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 16
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 17
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 18
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 19
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 20
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 22
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 3
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 4
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 39
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 40
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 6
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 6
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 52
                    }
                ],
                "outcome": "nop"
            },
            {
                "all": [
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 0
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 1
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 2
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 3
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 4
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 5
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 6
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 7
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 16
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 17
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 18
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 19
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 20
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 22
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 3
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 4
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 39
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 40
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 6
                    },
                    {
                        "kind": "ne",
                        "field": "op2",
                        "mask": 6,
                        "lsb": 0,
                        "value": 2
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 52
                    }
                ],
                "outcome": "nop"
            },
            {
                "all": [
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 0
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 1
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 2
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 3
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 4
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 5
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 6
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 7
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 16
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 17
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 18
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 19
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 20
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 22
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 3
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 4
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 39
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 40
                    },
                    {
                        "kind": "ne",
                        "field": "op2",
                        "mask": 6,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 6
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 52
                    }
                ],
                "outcome": "nop"
            },
            {
                "all": [
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 0
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 1
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 2
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 3
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 4
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 5
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 6
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 7
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 16
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 17
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 18
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 19
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 20
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 22
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 3
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 4
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 39
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 40
                    },
                    {
                        "kind": "ne",
                        "field": "op2",
                        "mask": 6,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne",
                        "field": "op2",
                        "mask": 6,
                        "lsb": 0,
                        "value": 2
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 52
                    }
                ],
                "outcome": "nop"
            },
            {
                "all": [
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 0
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 1
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 2
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 3
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 4
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 5
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 6
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 7
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 16
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 17
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 18
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 19
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 20
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 22
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 3
                    },
                    {
                        "kind": "ne",
                        "field": "op2",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 39
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 40
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 6
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 6
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 52
                    }
                ],
                "outcome": "nop"
            },
            {
                "all": [
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 0
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 1
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 2
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 3
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 4
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 5
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 6
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 7
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 16
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 17
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 18
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 19
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 20
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 22
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 3
                    },
                    {
                        "kind": "ne",
                        "field": "op2",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 39
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 40
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 6
                    },
                    {
                        "kind": "ne",
                        "field": "op2",
                        "mask": 6,
                        "lsb": 0,
                        "value": 2
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 52
                    }
                ],
                "outcome": "nop"
            },
            {
                "all": [
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 0
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 1
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 2
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 3
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 4
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 5
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 6
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 7
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 16
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 17
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 18
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 19
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 20
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 22
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 3
                    },
                    {
                        "kind": "ne",
                        "field": "op2",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 39
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 40
                    },
                    {
                        "kind": "ne",
                        "field": "op2",
                        "mask": 6,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 6
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 52
                    }
                ],
                "outcome": "nop"
            },
            {
                "all": [
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 0
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 1
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 2
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 3
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 4
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 5
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 6
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 7
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 1
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 16
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 17
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 18
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 19
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 20
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 22
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 15,
                        "lsb": 0,
                        "value": 3
                    },
                    {
                        "kind": "ne",
                        "field": "op2",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 39
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 40
                    },
                    {
                        "kind": "ne",
                        "field": "op2",
                        "mask": 6,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne",
                        "field": "op2",
                        "mask": 6,
                        "lsb": 0,
                        "value": 2
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "CRm",
                                "msb": 3,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 52
                    }
                ],
                "outcome": "nop"
            }
        ],
        "operandFamilyId": "hint"
    }
];

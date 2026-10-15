export const ENCODINGS = [
    {
        "instructionId": "SMSTART_MSR_imm",
        "encodingId": "SMSTART_MSR_SI_pstate",
        "mnemonic": "MSR",
        "className": "System",
        "fileName": "smstart_msr_imm.xml",
        "mask": 4294965759,
        "value": 3573760383,
        "bitCount": 30,
        "fields": [
            {
                "name": "op1",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "CRm",
                "lsb": 8,
                "width": 4
            },
            {
                "name": "op2",
                "lsb": 5,
                "width": 3
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "op1",
                        "mask": 7,
                        "lsb": 0,
                        "value": 5
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_VHE",
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
                                "field": "op1",
                                "msb": 2,
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
                        "kind": "feature",
                        "feature": "FEAT_UAO",
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
                                "field": "op1",
                                "msb": 2,
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
                        "kind": "feature",
                        "feature": "FEAT_PAN",
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
                                "field": "op1",
                                "msb": 2,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 8
                    },
                    {
                        "kind": "eq",
                        "field": "CRm",
                        "mask": 14,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_NMI",
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
                                "field": "op1",
                                "msb": 2,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 8
                    },
                    {
                        "kind": "eq",
                        "field": "CRm",
                        "mask": 14,
                        "lsb": 0,
                        "value": 2
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_EBEP",
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
                                "field": "op1",
                                "msb": 2,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 8
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 14,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 14,
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
                                "field": "op1",
                                "msb": 2,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 26
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_DIT",
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
                                "field": "op1",
                                "msb": 2,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 27
                    },
                    {
                        "kind": "eq",
                        "field": "CRm",
                        "mask": 14,
                        "lsb": 0,
                        "value": 2
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
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
                                "field": "op1",
                                "msb": 2,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 27
                    },
                    {
                        "kind": "eq",
                        "field": "CRm",
                        "mask": 14,
                        "lsb": 0,
                        "value": 4
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
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
                                "field": "op1",
                                "msb": 2,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 27
                    },
                    {
                        "kind": "eq",
                        "field": "CRm",
                        "mask": 14,
                        "lsb": 0,
                        "value": 6
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
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
                                "field": "op1",
                                "msb": 2,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 27
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 14,
                        "lsb": 0,
                        "value": 2
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 14,
                        "lsb": 0,
                        "value": 4
                    },
                    {
                        "kind": "ne",
                        "field": "CRm",
                        "mask": 14,
                        "lsb": 0,
                        "value": 6
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
                                "field": "op1",
                                "msb": 2,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 28
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_MTE",
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
                                "field": "op1",
                                "msb": 2,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 25
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SSBS",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "op1",
                                "msb": 2,
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
                                "field": "op1",
                                "msb": 2,
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
                                "field": "op1",
                                "msb": 2,
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
                                "field": "op1",
                                "msb": 2,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 8
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "op1",
                                "msb": 2,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 26
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "op1",
                                "msb": 2,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 27
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "op1",
                                "msb": 2,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 28
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "op1",
                                "msb": 2,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 30
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "op1",
                                "msb": 2,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 31
                    },
                    {
                        "kind": "ne_concat",
                        "parts": [
                            {
                                "field": "op1",
                                "msb": 2,
                                "lsb": 0
                            },
                            {
                                "field": "op2",
                                "msb": 2,
                                "lsb": 0
                            }
                        ],
                        "value": 25
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "canonicalEncodingId": "MSR_SI_pstate",
        "canonicalFileName": "msr_imm.xml",
        "operandFamilyId": "smstart-smstop"
    }
];

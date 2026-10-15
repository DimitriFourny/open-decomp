export const ENCODINGS = [
    {
        "instructionId": "PACIB",
        "encodingId": "PACIB1716_HI_hints",
        "mnemonic": "PACIB1716",
        "className": "System",
        "fileName": "pacib.xml",
        "mask": 4294967295,
        "value": 3573752159,
        "bitCount": 32,
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
        "features": [
            "FEAT_PAuth"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_PAuth",
                        "implemented": false
                    }
                ],
                "outcome": "nop"
            }
        ],
        "operandFamilyId": "auth-generic"
    },
    {
        "instructionId": "PACIB",
        "encodingId": "PACIBSP_HI_hints",
        "mnemonic": "PACIBSP",
        "className": "System",
        "fileName": "pacib.xml",
        "mask": 4294967295,
        "value": 3573752703,
        "bitCount": 32,
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
        "features": [
            "FEAT_PAuth"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_PAuth",
                        "implemented": false
                    }
                ],
                "outcome": "nop"
            }
        ],
        "operandFamilyId": "auth-generic"
    },
    {
        "instructionId": "PACIB",
        "encodingId": "PACIBZ_HI_hints",
        "mnemonic": "PACIBZ",
        "className": "System",
        "fileName": "pacib.xml",
        "mask": 4294967295,
        "value": 3573752671,
        "bitCount": 32,
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
        "features": [
            "FEAT_PAuth"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_PAuth",
                        "implemented": false
                    }
                ],
                "outcome": "nop"
            }
        ],
        "operandFamilyId": "auth-generic"
    },
    {
        "instructionId": "PACIB",
        "encodingId": "PACIZB_64Z_dp_1src",
        "mnemonic": "PACIZB",
        "className": "Integer",
        "fileName": "pacib.xml",
        "mask": 4294967264,
        "value": 3670091744,
        "bitCount": 27,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "opcode2",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "Z",
                "lsb": 13,
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
            "FEAT_PAuth"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_PAuth",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "ne",
                        "field": "Z",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne",
                        "field": "Rn",
                        "mask": 31,
                        "lsb": 0,
                        "value": 31
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "auth-generic"
    },
    {
        "instructionId": "PACIB",
        "encodingId": "PACIB_64P_dp_1src",
        "mnemonic": "PACIB",
        "className": "Integer",
        "fileName": "pacib.xml",
        "mask": 4294966272,
        "value": 3670082560,
        "bitCount": 22,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "opcode2",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "Z",
                "lsb": 13,
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
            "FEAT_PAuth"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_PAuth",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "ne",
                        "field": "Z",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne",
                        "field": "Rn",
                        "mask": 31,
                        "lsb": 0,
                        "value": 31
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "auth-generic"
    }
];

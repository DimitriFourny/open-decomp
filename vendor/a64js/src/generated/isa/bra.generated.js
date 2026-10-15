export const ENCODINGS = [
    {
        "instructionId": "BRA",
        "encodingId": "BRAAZ_64_branch_reg",
        "mnemonic": "BRAAZ",
        "className": "Integer",
        "fileName": "bra.xml",
        "mask": 4294966303,
        "value": 3592357919,
        "bitCount": 27,
        "fields": [
            {
                "name": "Z",
                "lsb": 24,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 21,
                "width": 2
            },
            {
                "name": "op2",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "A",
                "lsb": 11,
                "width": 1
            },
            {
                "name": "M",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rm",
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
                        "kind": "eq",
                        "field": "Z",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne",
                        "field": "Rm",
                        "mask": 31,
                        "lsb": 0,
                        "value": 31
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "auth-branch"
    },
    {
        "instructionId": "BRA",
        "encodingId": "BRABZ_64_branch_reg",
        "mnemonic": "BRABZ",
        "className": "Integer",
        "fileName": "bra.xml",
        "mask": 4294966303,
        "value": 3592358943,
        "bitCount": 27,
        "fields": [
            {
                "name": "Z",
                "lsb": 24,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 21,
                "width": 2
            },
            {
                "name": "op2",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "A",
                "lsb": 11,
                "width": 1
            },
            {
                "name": "M",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rm",
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
                        "kind": "eq",
                        "field": "Z",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne",
                        "field": "Rm",
                        "mask": 31,
                        "lsb": 0,
                        "value": 31
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "auth-branch"
    },
    {
        "instructionId": "BRA",
        "encodingId": "BRAA_64P_branch_reg",
        "mnemonic": "BRAA",
        "className": "Integer",
        "fileName": "bra.xml",
        "mask": 4294966272,
        "value": 3609135104,
        "bitCount": 22,
        "fields": [
            {
                "name": "Z",
                "lsb": 24,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 21,
                "width": 2
            },
            {
                "name": "op2",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "A",
                "lsb": 11,
                "width": 1
            },
            {
                "name": "M",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rm",
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
                        "kind": "eq",
                        "field": "Z",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne",
                        "field": "Rm",
                        "mask": 31,
                        "lsb": 0,
                        "value": 31
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "auth-branch"
    },
    {
        "instructionId": "BRA",
        "encodingId": "BRAB_64P_branch_reg",
        "mnemonic": "BRAB",
        "className": "Integer",
        "fileName": "bra.xml",
        "mask": 4294966272,
        "value": 3609136128,
        "bitCount": 22,
        "fields": [
            {
                "name": "Z",
                "lsb": 24,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 21,
                "width": 2
            },
            {
                "name": "op2",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "A",
                "lsb": 11,
                "width": 1
            },
            {
                "name": "M",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rm",
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
                        "kind": "eq",
                        "field": "Z",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne",
                        "field": "Rm",
                        "mask": 31,
                        "lsb": 0,
                        "value": 31
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "auth-branch"
    }
];

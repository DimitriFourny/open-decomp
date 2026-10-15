export const ENCODINGS = [
    {
        "instructionId": "BLRA",
        "encodingId": "BLRAAZ_64_branch_reg",
        "mnemonic": "BLRAAZ",
        "className": "Integer",
        "fileName": "blra.xml",
        "mask": 4294966303,
        "value": 3594455071,
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
        "instructionId": "BLRA",
        "encodingId": "BLRABZ_64_branch_reg",
        "mnemonic": "BLRABZ",
        "className": "Integer",
        "fileName": "blra.xml",
        "mask": 4294966303,
        "value": 3594456095,
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
        "instructionId": "BLRA",
        "encodingId": "BLRAA_64P_branch_reg",
        "mnemonic": "BLRAA",
        "className": "Integer",
        "fileName": "blra.xml",
        "mask": 4294966272,
        "value": 3611232256,
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
        "instructionId": "BLRA",
        "encodingId": "BLRAB_64P_branch_reg",
        "mnemonic": "BLRAB",
        "className": "Integer",
        "fileName": "blra.xml",
        "mask": 4294966272,
        "value": 3611233280,
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

export const ENCODINGS = [
    {
        "instructionId": "LDRSB_reg",
        "encodingId": "LDRSB_32BL_ldst_regoff",
        "mnemonic": "LDRSB",
        "className": "Integer",
        "fileName": "ldrsb_reg.xml",
        "mask": 4292930560,
        "value": 954230784,
        "bitCount": 16,
        "fields": [
            {
                "name": "size",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "option",
                "lsb": 13,
                "width": 3
            },
            {
                "name": "S",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "option",
                        "mask": 2,
                        "lsb": 1,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-load-store"
    },
    {
        "instructionId": "LDRSB_reg",
        "encodingId": "LDRSB_64BL_ldst_regoff",
        "mnemonic": "LDRSB",
        "className": "Integer",
        "fileName": "ldrsb_reg.xml",
        "mask": 4292930560,
        "value": 950036480,
        "bitCount": 16,
        "fields": [
            {
                "name": "size",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "option",
                "lsb": 13,
                "width": 3
            },
            {
                "name": "S",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "option",
                        "mask": 2,
                        "lsb": 1,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-load-store"
    },
    {
        "instructionId": "LDRSB_reg",
        "encodingId": "LDRSB_32B_ldst_regoff",
        "mnemonic": "LDRSB",
        "className": "Integer",
        "fileName": "ldrsb_reg.xml",
        "mask": 4292873216,
        "value": 954206208,
        "bitCount": 13,
        "fields": [
            {
                "name": "size",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "option",
                "lsb": 13,
                "width": 3
            },
            {
                "name": "S",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "option",
                        "mask": 2,
                        "lsb": 1,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-load-store"
    },
    {
        "instructionId": "LDRSB_reg",
        "encodingId": "LDRSB_64B_ldst_regoff",
        "mnemonic": "LDRSB",
        "className": "Integer",
        "fileName": "ldrsb_reg.xml",
        "mask": 4292873216,
        "value": 950011904,
        "bitCount": 13,
        "fields": [
            {
                "name": "size",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "option",
                "lsb": 13,
                "width": 3
            },
            {
                "name": "S",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "option",
                        "mask": 2,
                        "lsb": 1,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-load-store"
    }
];

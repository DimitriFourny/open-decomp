export const ENCODINGS = [
    {
        "instructionId": "FSQRT_float",
        "encodingId": "FSQRT_D_floatdp1",
        "mnemonic": "FSQRT",
        "className": "Floating-point",
        "fileName": "fsqrt_float.xml",
        "mask": 4294966272,
        "value": 509722624,
        "bitCount": 22,
        "fields": [
            {
                "name": "M",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "ftype",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "opc",
                "lsb": 15,
                "width": 2
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
        "features": [],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_FP",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "ftype",
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
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 3
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_FP16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-fp-unary"
    },
    {
        "instructionId": "FSQRT_float",
        "encodingId": "FSQRT_H_floatdp1",
        "mnemonic": "FSQRT",
        "className": "Floating-point",
        "fileName": "fsqrt_float.xml",
        "mask": 4294966272,
        "value": 518111232,
        "bitCount": 22,
        "fields": [
            {
                "name": "M",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "ftype",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "opc",
                "lsb": 15,
                "width": 2
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
        "features": [],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_FP",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "ftype",
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
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 3
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_FP16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-fp-unary"
    },
    {
        "instructionId": "FSQRT_float",
        "encodingId": "FSQRT_S_floatdp1",
        "mnemonic": "FSQRT",
        "className": "Floating-point",
        "fileName": "fsqrt_float.xml",
        "mask": 4294966272,
        "value": 505528320,
        "bitCount": 22,
        "fields": [
            {
                "name": "M",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "ftype",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "opc",
                "lsb": 15,
                "width": 2
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
        "features": [],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_FP",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "ftype",
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
                        "kind": "eq",
                        "field": "ftype",
                        "mask": 3,
                        "lsb": 0,
                        "value": 3
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_FP16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "scalar-fp-unary"
    }
];

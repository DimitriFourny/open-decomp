export const ENCODINGS = [
    {
        "instructionId": "EXTR",
        "encodingId": "EXTR_32_extract",
        "mnemonic": "EXTR",
        "className": "Integer",
        "fileName": "extr.xml",
        "mask": 4292902912,
        "value": 327155712,
        "bitCount": 12,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "op21",
                "lsb": 29,
                "width": 2
            },
            {
                "name": "N",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "o0",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "imms",
                "lsb": 10,
                "width": 6
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
                        "kind": "ne_field",
                        "field": "N",
                        "otherField": "sf"
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "eq",
                        "field": "imms",
                        "mask": 32,
                        "lsb": 5,
                        "value": 1
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "extract-register"
    },
    {
        "instructionId": "EXTR",
        "encodingId": "EXTR_64_extract",
        "mnemonic": "EXTR",
        "className": "Integer",
        "fileName": "extr.xml",
        "mask": 4292870144,
        "value": 2478833664,
        "bitCount": 11,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "op21",
                "lsb": 29,
                "width": 2
            },
            {
                "name": "N",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "o0",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "imms",
                "lsb": 10,
                "width": 6
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
                        "kind": "ne_field",
                        "field": "N",
                        "otherField": "sf"
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "eq",
                        "field": "imms",
                        "mask": 32,
                        "lsb": 5,
                        "value": 1
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "extract-register"
    }
];

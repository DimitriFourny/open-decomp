export const ENCODINGS = [
    {
        "instructionId": "ADD_addsub_ext",
        "encodingId": "ADD_32_addsub_ext",
        "mnemonic": "ADD",
        "className": "Not setting the condition flags",
        "fileName": "add_addsub_ext.xml",
        "mask": 4292870144,
        "value": 186646528,
        "bitCount": 11,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "opt",
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
                "name": "imm3",
                "lsb": 10,
                "width": 3
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
                        "kind": "eq",
                        "field": "imm3",
                        "mask": 7,
                        "lsb": 0,
                        "value": 5
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "imm3",
                        "mask": 7,
                        "lsb": 0,
                        "value": 6
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "imm3",
                        "mask": 7,
                        "lsb": 0,
                        "value": 7
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "add-sub-extended"
    },
    {
        "instructionId": "ADD_addsub_ext",
        "encodingId": "ADD_64_addsub_ext",
        "mnemonic": "ADD",
        "className": "Not setting the condition flags",
        "fileName": "add_addsub_ext.xml",
        "mask": 4292870144,
        "value": 2334130176,
        "bitCount": 11,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "opt",
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
                "name": "imm3",
                "lsb": 10,
                "width": 3
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
                        "kind": "eq",
                        "field": "imm3",
                        "mask": 7,
                        "lsb": 0,
                        "value": 5
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "imm3",
                        "mask": 7,
                        "lsb": 0,
                        "value": 6
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "imm3",
                        "mask": 7,
                        "lsb": 0,
                        "value": 7
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "add-sub-extended"
    }
];

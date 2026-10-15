export const ENCODINGS = [
    {
        "instructionId": "CMN_ADDS_addsub_ext",
        "encodingId": "CMN_ADDS_32S_addsub_ext",
        "mnemonic": "ADDS",
        "className": "Setting the condition flags",
        "fileName": "cmn_adds_addsub_ext.xml",
        "mask": 4292870175,
        "value": 723517471,
        "bitCount": 16,
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
        "canonicalEncodingId": "ADDS_32S_addsub_ext",
        "canonicalFileName": "adds_addsub_ext.xml",
        "operandFamilyId": "add-sub-extended"
    },
    {
        "instructionId": "CMN_ADDS_addsub_ext",
        "encodingId": "CMN_ADDS_64S_addsub_ext",
        "mnemonic": "ADDS",
        "className": "Setting the condition flags",
        "fileName": "cmn_adds_addsub_ext.xml",
        "mask": 4292870175,
        "value": 2871001119,
        "bitCount": 16,
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
        "canonicalEncodingId": "ADDS_64S_addsub_ext",
        "canonicalFileName": "adds_addsub_ext.xml",
        "operandFamilyId": "add-sub-extended"
    }
];

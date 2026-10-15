export const ENCODINGS = [
    {
        "instructionId": "AND_log_imm",
        "encodingId": "AND_32_log_imm",
        "mnemonic": "AND",
        "className": "Not setting the condition flags",
        "fileName": "and_log_imm.xml",
        "mask": 4290772992,
        "value": 301989888,
        "bitCount": 10,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "opc",
                "lsb": 29,
                "width": 2
            },
            {
                "name": "N",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "immr",
                "lsb": 16,
                "width": 6
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
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne",
                        "field": "N",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "logical-immediate"
    },
    {
        "instructionId": "AND_log_imm",
        "encodingId": "AND_64_log_imm",
        "mnemonic": "AND",
        "className": "Not setting the condition flags",
        "fileName": "and_log_imm.xml",
        "mask": 4286578688,
        "value": 2449473536,
        "bitCount": 9,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "opc",
                "lsb": 29,
                "width": 2
            },
            {
                "name": "N",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "immr",
                "lsb": 16,
                "width": 6
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
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne",
                        "field": "N",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "logical-immediate"
    }
];

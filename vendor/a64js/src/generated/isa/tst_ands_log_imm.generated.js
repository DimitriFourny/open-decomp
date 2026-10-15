export const ENCODINGS = [
    {
        "instructionId": "TST_ANDS_log_imm",
        "encodingId": "TST_ANDS_32S_log_imm",
        "mnemonic": "ANDS",
        "className": "Setting the condition flags",
        "fileName": "tst_ands_log_imm.xml",
        "mask": 4290773023,
        "value": 1912602655,
        "bitCount": 15,
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
        "canonicalEncodingId": "ANDS_32S_log_imm",
        "canonicalFileName": "ands_log_imm.xml",
        "operandFamilyId": "logical-immediate"
    },
    {
        "instructionId": "TST_ANDS_log_imm",
        "encodingId": "TST_ANDS_64S_log_imm",
        "mnemonic": "ANDS",
        "className": "Setting the condition flags",
        "fileName": "tst_ands_log_imm.xml",
        "mask": 4286578719,
        "value": 4060086303,
        "bitCount": 14,
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
        "canonicalEncodingId": "ANDS_64S_log_imm",
        "canonicalFileName": "ands_log_imm.xml",
        "operandFamilyId": "logical-immediate"
    }
];

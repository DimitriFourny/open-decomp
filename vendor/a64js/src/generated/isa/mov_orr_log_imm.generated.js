export const ENCODINGS = [
    {
        "instructionId": "MOV_ORR_log_imm",
        "encodingId": "MOV_ORR_32_log_imm",
        "mnemonic": "ORR",
        "className": "Not setting the condition flags",
        "fileName": "mov_orr_log_imm.xml",
        "mask": 4290773984,
        "value": 838861792,
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
        "canonicalEncodingId": "ORR_32_log_imm",
        "canonicalFileName": "orr_log_imm.xml",
        "operandFamilyId": "logical-immediate"
    },
    {
        "instructionId": "MOV_ORR_log_imm",
        "encodingId": "MOV_ORR_64_log_imm",
        "mnemonic": "ORR",
        "className": "Not setting the condition flags",
        "fileName": "mov_orr_log_imm.xml",
        "mask": 4286579680,
        "value": 2986345440,
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
        "canonicalEncodingId": "ORR_64_log_imm",
        "canonicalFileName": "orr_log_imm.xml",
        "operandFamilyId": "logical-immediate"
    }
];

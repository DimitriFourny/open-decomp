export const ENCODINGS = [
    {
        "instructionId": "MOV_ORR_log_shift",
        "encodingId": "MOV_ORR_32_log_shift",
        "mnemonic": "ORR",
        "className": "Not setting the condition flags",
        "fileName": "mov_orr_log_shift.xml",
        "mask": 4292935648,
        "value": 704644064,
        "bitCount": 22,
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
                "name": "shift",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "N",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "imm6",
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
                        "kind": "eq",
                        "field": "imm6",
                        "mask": 32,
                        "lsb": 5,
                        "value": 1
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "canonicalEncodingId": "ORR_32_log_shift",
        "canonicalFileName": "orr_log_shift.xml",
        "operandFamilyId": "mov-register-alias"
    },
    {
        "instructionId": "MOV_ORR_log_shift",
        "encodingId": "MOV_ORR_64_log_shift",
        "mnemonic": "ORR",
        "className": "Not setting the condition flags",
        "fileName": "mov_orr_log_shift.xml",
        "mask": 4292935648,
        "value": 2852127712,
        "bitCount": 22,
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
                "name": "shift",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "N",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "imm6",
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
                        "kind": "eq",
                        "field": "imm6",
                        "mask": 32,
                        "lsb": 5,
                        "value": 1
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "canonicalEncodingId": "ORR_64_log_shift",
        "canonicalFileName": "orr_log_shift.xml",
        "operandFamilyId": "mov-register-alias"
    }
];

export const ENCODINGS = [
    {
        "instructionId": "TST_ANDS_log_shift",
        "encodingId": "TST_ANDS_32_log_shift",
        "mnemonic": "ANDS",
        "className": "Setting the condition flags",
        "fileName": "tst_ands_log_shift.xml",
        "mask": 4280287263,
        "value": 1778384927,
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
        "canonicalEncodingId": "ANDS_32_log_shift",
        "canonicalFileName": "ands_log_shift.xml",
        "operandFamilyId": "logical-shifted-register"
    },
    {
        "instructionId": "TST_ANDS_log_shift",
        "encodingId": "TST_ANDS_64_log_shift",
        "mnemonic": "ANDS",
        "className": "Setting the condition flags",
        "fileName": "tst_ands_log_shift.xml",
        "mask": 4280287263,
        "value": 3925868575,
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
        "canonicalEncodingId": "ANDS_64_log_shift",
        "canonicalFileName": "ands_log_shift.xml",
        "operandFamilyId": "logical-shifted-register"
    }
];

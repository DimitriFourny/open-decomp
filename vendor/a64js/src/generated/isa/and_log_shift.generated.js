export const ENCODINGS = [
    {
        "instructionId": "AND_log_shift",
        "encodingId": "AND_32_log_shift",
        "mnemonic": "AND",
        "className": "Not setting the condition flags",
        "fileName": "and_log_shift.xml",
        "mask": 4280287232,
        "value": 167772160,
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
        "operandFamilyId": "logical-shifted-register"
    },
    {
        "instructionId": "AND_log_shift",
        "encodingId": "AND_64_log_shift",
        "mnemonic": "AND",
        "className": "Not setting the condition flags",
        "fileName": "and_log_shift.xml",
        "mask": 4280287232,
        "value": 2315255808,
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
        "operandFamilyId": "logical-shifted-register"
    }
];

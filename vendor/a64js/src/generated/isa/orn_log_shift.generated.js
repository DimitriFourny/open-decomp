export const ENCODINGS = [
    {
        "instructionId": "ORN_log_shift",
        "encodingId": "ORN_32_log_shift",
        "mnemonic": "ORN",
        "className": "Not setting the condition flags",
        "fileName": "orn_log_shift.xml",
        "mask": 4280287232,
        "value": 706740224,
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
        "instructionId": "ORN_log_shift",
        "encodingId": "ORN_64_log_shift",
        "mnemonic": "ORN",
        "className": "Not setting the condition flags",
        "fileName": "orn_log_shift.xml",
        "mask": 4280287232,
        "value": 2854223872,
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

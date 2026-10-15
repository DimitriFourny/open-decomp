export const ENCODINGS = [
    {
        "instructionId": "REV",
        "encodingId": "REV_32_dp_1src",
        "mnemonic": "REV",
        "className": "Integer",
        "fileName": "rev.xml",
        "mask": 4294966272,
        "value": 1522534400,
        "bitCount": 22,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "opcode2",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "opc",
                "lsb": 10,
                "width": 2
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
                        "field": "opc",
                        "mask": 3,
                        "lsb": 0,
                        "value": 3
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "one-source-integer"
    },
    {
        "instructionId": "REV",
        "encodingId": "REV_64_dp_1src",
        "mnemonic": "REV",
        "className": "Integer",
        "fileName": "rev.xml",
        "mask": 4294966272,
        "value": 3670019072,
        "bitCount": 22,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "opcode2",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "opc",
                "lsb": 10,
                "width": 2
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
                        "field": "opc",
                        "mask": 3,
                        "lsb": 0,
                        "value": 3
                    },
                    {
                        "kind": "eq",
                        "field": "sf",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "one-source-integer"
    }
];

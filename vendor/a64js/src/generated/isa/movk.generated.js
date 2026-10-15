export const ENCODINGS = [
    {
        "instructionId": "MOVK",
        "encodingId": "MOVK_32_movewide",
        "mnemonic": "MOVK",
        "className": "Immediate packed into 16-bit value and 2-bit shift",
        "fileName": "movk.xml",
        "mask": 4290772992,
        "value": 1920991232,
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
                "name": "hw",
                "lsb": 21,
                "width": 2
            },
            {
                "name": "imm16",
                "lsb": 5,
                "width": 16
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
                        "field": "hw",
                        "mask": 2,
                        "lsb": 1,
                        "value": 1
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "move-wide"
    },
    {
        "instructionId": "MOVK",
        "encodingId": "MOVK_64_movewide",
        "mnemonic": "MOVK",
        "className": "Immediate packed into 16-bit value and 2-bit shift",
        "fileName": "movk.xml",
        "mask": 4286578688,
        "value": 4068474880,
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
                "name": "hw",
                "lsb": 21,
                "width": 2
            },
            {
                "name": "imm16",
                "lsb": 5,
                "width": 16
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
                        "field": "hw",
                        "mask": 2,
                        "lsb": 1,
                        "value": 1
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "move-wide"
    }
];

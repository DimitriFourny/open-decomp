export const ENCODINGS = [
    {
        "instructionId": "SETF",
        "encodingId": "SETF16_only_setf",
        "mnemonic": "SETF16",
        "className": "Integer",
        "fileName": "setf.xml",
        "mask": 4294966303,
        "value": 973096973,
        "bitCount": 27,
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
                "name": "opcode2",
                "lsb": 15,
                "width": 6
            },
            {
                "name": "sz",
                "lsb": 14,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "o3",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "mask",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [
            "FEAT_FlagM"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_FlagM",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "setf"
    },
    {
        "instructionId": "SETF",
        "encodingId": "SETF8_only_setf",
        "mnemonic": "SETF8",
        "className": "Integer",
        "fileName": "setf.xml",
        "mask": 4294966303,
        "value": 973080589,
        "bitCount": 27,
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
                "name": "opcode2",
                "lsb": 15,
                "width": 6
            },
            {
                "name": "sz",
                "lsb": 14,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "o3",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "mask",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [
            "FEAT_FlagM"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_FlagM",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "setf"
    }
];

export const ENCODINGS = [
    {
        "instructionId": "XPAC",
        "encodingId": "XPACLRI_HI_hints",
        "mnemonic": "XPACLRI",
        "className": "System",
        "fileName": "xpac.xml",
        "mask": 4294967295,
        "value": 3573752063,
        "bitCount": 32,
        "fields": [
            {
                "name": "CRm",
                "lsb": 8,
                "width": 4
            },
            {
                "name": "op2",
                "lsb": 5,
                "width": 3
            }
        ],
        "features": [
            "FEAT_PAuth"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_PAuth",
                        "implemented": false
                    }
                ],
                "outcome": "nop"
            }
        ],
        "operandFamilyId": "xpac"
    },
    {
        "instructionId": "XPAC",
        "encodingId": "XPACD_64Z_dp_1src",
        "mnemonic": "XPACD",
        "className": "Integer",
        "fileName": "xpac.xml",
        "mask": 4294967264,
        "value": 3670099936,
        "bitCount": 27,
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
                "name": "D",
                "lsb": 10,
                "width": 1
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
        "features": [
            "FEAT_PAuth"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_PAuth",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "xpac"
    },
    {
        "instructionId": "XPAC",
        "encodingId": "XPACI_64Z_dp_1src",
        "mnemonic": "XPACI",
        "className": "Integer",
        "fileName": "xpac.xml",
        "mask": 4294967264,
        "value": 3670098912,
        "bitCount": 27,
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
                "name": "D",
                "lsb": 10,
                "width": 1
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
        "features": [
            "FEAT_PAuth"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_PAuth",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "xpac"
    }
];

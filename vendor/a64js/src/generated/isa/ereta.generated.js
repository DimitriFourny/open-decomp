export const ENCODINGS = [
    {
        "instructionId": "ERETA",
        "encodingId": "ERETAA_64E_branch_reg",
        "mnemonic": "ERETAA",
        "className": "Integer",
        "fileName": "ereta.xml",
        "mask": 4294967295,
        "value": 3600747519,
        "bitCount": 32,
        "fields": [
            {
                "name": "opc",
                "lsb": 21,
                "width": 4
            },
            {
                "name": "op2",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "A",
                "lsb": 11,
                "width": 1
            },
            {
                "name": "M",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "op4",
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
        "operandFamilyId": "no-operands"
    },
    {
        "instructionId": "ERETA",
        "encodingId": "ERETAB_64E_branch_reg",
        "mnemonic": "ERETAB",
        "className": "Integer",
        "fileName": "ereta.xml",
        "mask": 4294967295,
        "value": 3600748543,
        "bitCount": 32,
        "fields": [
            {
                "name": "opc",
                "lsb": 21,
                "width": 4
            },
            {
                "name": "op2",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "A",
                "lsb": 11,
                "width": 1
            },
            {
                "name": "M",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "op4",
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
        "operandFamilyId": "no-operands"
    }
];

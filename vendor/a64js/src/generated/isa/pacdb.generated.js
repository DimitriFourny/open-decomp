export const ENCODINGS = [
    {
        "instructionId": "PACDB",
        "encodingId": "PACDZB_64Z_dp_1src",
        "mnemonic": "PACDZB",
        "className": "Integer",
        "fileName": "pacdb.xml",
        "mask": 4294967264,
        "value": 3670093792,
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
                "name": "Z",
                "lsb": 13,
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
            },
            {
                "all": [
                    {
                        "kind": "ne",
                        "field": "Z",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne",
                        "field": "Rn",
                        "mask": 31,
                        "lsb": 0,
                        "value": 31
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "auth-generic"
    },
    {
        "instructionId": "PACDB",
        "encodingId": "PACDB_64P_dp_1src",
        "mnemonic": "PACDB",
        "className": "Integer",
        "fileName": "pacdb.xml",
        "mask": 4294966272,
        "value": 3670084608,
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
                "name": "Z",
                "lsb": 13,
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
            },
            {
                "all": [
                    {
                        "kind": "ne",
                        "field": "Z",
                        "mask": 1,
                        "lsb": 0,
                        "value": 0
                    },
                    {
                        "kind": "ne",
                        "field": "Rn",
                        "mask": 31,
                        "lsb": 0,
                        "value": 31
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "auth-generic"
    }
];

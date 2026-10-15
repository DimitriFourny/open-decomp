export const ENCODINGS = [
    {
        "instructionId": "luti4_mz4_ztz",
        "encodingId": "luti4_mz4_ztz_1",
        "mnemonic": "LUTI4",
        "className": "Consecutive",
        "fileName": "luti4_mz4_ztz.xml",
        "mask": 4294888451,
        "value": 3230302208,
        "bitCount": 21,
        "fields": [
            {
                "name": "i1",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "size",
                "lsb": 12,
                "width": 2
            },
            {
                "name": "opc2",
                "lsb": 10,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zd",
                "lsb": 2,
                "width": 3
            }
        ],
        "features": [
            "FEAT_SME2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 3
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-luti-luti2-mz4-ztz"
    },
    {
        "instructionId": "luti4_mz4_ztz",
        "encodingId": "luti4_mz4_ztz_4",
        "mnemonic": "LUTI4",
        "className": "Strided",
        "fileName": "luti4_mz4_ztz.xml",
        "mask": 4294888460,
        "value": 3231350784,
        "bitCount": 21,
        "fields": [
            {
                "name": "i1",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "size",
                "lsb": 12,
                "width": 2
            },
            {
                "name": "opc2",
                "lsb": 10,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "D",
                "lsb": 4,
                "width": 1
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 2
            }
        ],
        "features": [
            "FEAT_SME2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "ne",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 1
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-luti-luti2-mz4-ztz"
    }
];

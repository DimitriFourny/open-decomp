export const ENCODINGS = [
    {
        "instructionId": "luti4_mz2_ztz",
        "encodingId": "luti4_mz2_ztz_1",
        "mnemonic": "LUTI4",
        "className": "Consecutive",
        "fileName": "luti4_mz2_ztz.xml",
        "mask": 4294855681,
        "value": 3230285824,
        "bitCount": 19,
        "fields": [
            {
                "name": "i2",
                "lsb": 15,
                "width": 2
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
                "lsb": 1,
                "width": 4
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
                        "value": 3
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-luti-luti2-mz2-ztz"
    },
    {
        "instructionId": "luti4_mz2_ztz",
        "encodingId": "luti4_mz2_ztz_8",
        "mnemonic": "LUTI4",
        "className": "Strided",
        "fileName": "luti4_mz2_ztz.xml",
        "mask": 4294855688,
        "value": 3231334400,
        "bitCount": 19,
        "fields": [
            {
                "name": "i2",
                "lsb": 15,
                "width": 2
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
                "width": 3
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
                        "kind": "eq",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 2
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
        "operandFamilyId": "sme-luti-luti2-mz2-ztz"
    }
];

export const ENCODINGS = [
    {
        "instructionId": "luti2_mz4_ztz",
        "encodingId": "luti2_mz4_ztz_1",
        "mnemonic": "LUTI2",
        "className": "Consecutive",
        "fileName": "luti2_mz4_ztz.xml",
        "mask": 4294757379,
        "value": 3230433280,
        "bitCount": 20,
        "fields": [
            {
                "name": "i2",
                "lsb": 16,
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
                        "value": 3
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-luti-luti2-mz4-ztz"
    },
    {
        "instructionId": "luti2_mz4_ztz",
        "encodingId": "luti2_mz4_ztz_4",
        "mnemonic": "LUTI2",
        "className": "Strided",
        "fileName": "luti2_mz4_ztz.xml",
        "mask": 4294757388,
        "value": 3231481856,
        "bitCount": 20,
        "fields": [
            {
                "name": "i2",
                "lsb": 16,
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
        "operandFamilyId": "sme-luti-luti2-mz4-ztz"
    }
];

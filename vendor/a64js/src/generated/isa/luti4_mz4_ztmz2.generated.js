export const ENCODINGS = [
    {
        "instructionId": "luti4_mz4_ztmz2",
        "encodingId": "luti4_mz4_ztmz2_1",
        "mnemonic": "LUTI4",
        "className": "Consecutive",
        "fileName": "luti4_mz4_ztmz2.xml",
        "mask": 4294954019,
        "value": 3230334976,
        "bitCount": 23,
        "fields": [
            {
                "name": "size",
                "lsb": 12,
                "width": 2
            },
            {
                "name": "opc",
                "lsb": 10,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 6,
                "width": 4
            },
            {
                "name": "Zd",
                "lsb": 2,
                "width": 3
            }
        ],
        "features": [
            "FEAT_SME_LUTv2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_LUTv2",
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
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-fp8-luti-mixed"
    },
    {
        "instructionId": "luti4_mz4_ztmz2",
        "encodingId": "luti4_mz4_ztmz2_4",
        "mnemonic": "LUTI4",
        "className": "Strided",
        "fileName": "luti4_mz4_ztmz2.xml",
        "mask": 4294954028,
        "value": 3231383552,
        "bitCount": 23,
        "fields": [
            {
                "name": "size",
                "lsb": 12,
                "width": 2
            },
            {
                "name": "opc",
                "lsb": 10,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 6,
                "width": 4
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
            "FEAT_SME2p1 && FEAT_SME_LUTv2"
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
                        "kind": "feature",
                        "feature": "FEAT_SME_LUTv2",
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
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-fp8-luti-mixed"
    }
];

export const ENCODINGS = [
    {
        "instructionId": "uqcvtn_z_mz4",
        "encodingId": "uqcvtn_z_mz4_",
        "mnemonic": "UQCVTN",
        "className": "SME2",
        "fileName": "uqcvtn_z_mz4.xml",
        "mask": 4286577760,
        "value": 3241402464,
        "bitCount": 23,
        "fields": [
            {
                "name": "sz",
                "lsb": 23,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Zn",
                "lsb": 7,
                "width": 3
            },
            {
                "name": "N",
                "lsb": 6,
                "width": 1
            },
            {
                "name": "U",
                "lsb": 5,
                "width": 1
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
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
            }
        ],
        "operandFamilyId": "sme-narrowing-convert"
    }
];

export const ENCODINGS = [
    {
        "instructionId": "fcvtn_z8_mz4",
        "encodingId": "fcvtn_z8_mz4_",
        "mnemonic": "FCVTN",
        "className": "SME2",
        "fileName": "fcvtn_z8_mz4.xml",
        "mask": 4294966368,
        "value": 3241467936,
        "bitCount": 24,
        "fields": [
            {
                "name": "Zn",
                "lsb": 7,
                "width": 3
            },
            {
                "name": "N",
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
            "FEAT_SME2 && FEAT_FP8"
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
                        "kind": "feature",
                        "feature": "FEAT_FP8",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-fp8-narrowing-convert"
    }
];

export const ENCODINGS = [
    {
        "instructionId": "fcvtn_z8_mz2",
        "encodingId": "fcvtn_z8_mz2_h2b",
        "mnemonic": "FCVTN",
        "className": "SVE2",
        "fileName": "fcvtn_z8_mz2.xml",
        "mask": 4294966304,
        "value": 1695166464,
        "bitCount": 23,
        "fields": [
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
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "(FEAT_SVE2 || FEAT_SME2) && FEAT_FP8"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2",
                        "implemented": false
                    },
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
        "operandFamilyId": "sme-fp8-narrow-convert"
    }
];

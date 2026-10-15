export const ENCODINGS = [
    {
        "instructionId": "fmlallbb_z32_z8z8z8",
        "encodingId": "fmlallbb_z32_z8z8z8_",
        "mnemonic": "FMLALLBB",
        "className": "SVE2",
        "fileName": "fmlallbb_z32_z8z8z8.xml",
        "mask": 4292934656,
        "value": 1679853568,
        "bitCount": 17,
        "fields": [
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "TT",
                "lsb": 12,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zda",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "(FEAT_SVE2 && FEAT_FP8FMA) || FEAT_SSVE_FP8FMA"
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
                        "feature": "FEAT_SSVE_FP8FMA",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_FP8FMA",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SSVE_FP8FMA",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sdot-z-zzz"
    }
];

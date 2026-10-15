export const ENCODINGS = [
    {
        "instructionId": "fdot_z32_zz8z8",
        "encodingId": "fdot_z32_zz8z8_",
        "mnemonic": "FDOT",
        "className": "SVE2",
        "fileName": "fdot_z32_zz8z8.xml",
        "mask": 4292934656,
        "value": 1684046848,
        "bitCount": 17,
        "fields": [
            {
                "name": "op",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "o2",
                "lsb": 10,
                "width": 1
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
            "(FEAT_SVE2 && FEAT_FP8DOT4) || FEAT_SSVE_FP8DOT4"
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
                        "feature": "FEAT_SSVE_FP8DOT4",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_FP8DOT4",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SSVE_FP8DOT4",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sdot-z-zzz"
    }
];

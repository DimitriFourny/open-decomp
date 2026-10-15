export const ENCODINGS = [
    {
        "instructionId": "fdot_z_zz8z8i",
        "encodingId": "fdot_z_zz8z8i_",
        "mnemonic": "FDOT",
        "className": "SVE2",
        "fileName": "fdot_z_zz8z8i.xml",
        "mask": 4292932608,
        "value": 1679836160,
        "bitCount": 16,
        "fields": [
            {
                "name": "op",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "i3h",
                "lsb": 19,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "i3l",
                "lsb": 11,
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
            "(FEAT_SVE2 && FEAT_FP8DOT2) || FEAT_SSVE_FP8DOT2"
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
                        "feature": "FEAT_SSVE_FP8DOT2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_FP8DOT2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SSVE_FP8DOT2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sdot-z-zzz"
    }
];

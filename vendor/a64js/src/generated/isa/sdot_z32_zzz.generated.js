export const ENCODINGS = [
    {
        "instructionId": "sdot_z32_zzz",
        "encodingId": "sdot_z16_zzz_h",
        "mnemonic": "SDOT",
        "className": "8-bit to 16-bit",
        "fileName": "sdot_z32_zzz.xml",
        "mask": 4292934656,
        "value": 1145044992,
        "bitCount": 17,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "U",
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
            "FEAT_SVE2p3 || FEAT_SME2p3"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p3",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p3",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sdot-z-zzz"
    },
    {
        "instructionId": "sdot_z32_zzz",
        "encodingId": "sdot_z32_zzz_",
        "mnemonic": "SDOT",
        "className": "16-bit to 32-bit",
        "fileName": "sdot_z32_zzz.xml",
        "mask": 4292934656,
        "value": 1140901888,
        "bitCount": 17,
        "fields": [
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "U",
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
            "FEAT_SME2 || FEAT_SVE2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sdot-z-zzz"
    }
];

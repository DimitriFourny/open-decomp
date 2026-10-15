export const ENCODINGS = [
    {
        "instructionId": "udot_z32_zzzi",
        "encodingId": "udot_z32_zzzi_",
        "mnemonic": "UDOT",
        "className": "16-bit to 32-bit",
        "fileName": "udot_z32_zzzi.xml",
        "mask": 4292934656,
        "value": 1149291520,
        "bitCount": 17,
        "fields": [
            {
                "name": "i2",
                "lsb": 19,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 3
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
    },
    {
        "instructionId": "udot_z32_zzzi",
        "encodingId": "udot_z16_zzzi_h",
        "mnemonic": "UDOT",
        "className": "8-bit to 16-bit",
        "fileName": "udot_z32_zzzi.xml",
        "mask": 4288740352,
        "value": 1142948864,
        "bitCount": 16,
        "fields": [
            {
                "name": "i3h",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "i3l",
                "lsb": 19,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 3
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
    }
];

export const ENCODINGS = [
    {
        "instructionId": "ucvtf_mz_z",
        "encodingId": "ucvtf_mz_z_4",
        "mnemonic": "UCVTF",
        "className": "Four registers",
        "fileName": "ucvtf_mz_z.xml",
        "mask": 4294966371,
        "value": 3241336864,
        "bitCount": 26,
        "fields": [
            {
                "name": "Zn",
                "lsb": 7,
                "width": 3
            },
            {
                "name": "U",
                "lsb": 5,
                "width": 1
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
            }
        ],
        "operandFamilyId": "sme-int-float-convert"
    },
    {
        "instructionId": "ucvtf_mz_z",
        "encodingId": "ucvtf_mz_z_2",
        "mnemonic": "UCVTF",
        "className": "Two registers",
        "fileName": "ucvtf_mz_z.xml",
        "mask": 4294966305,
        "value": 3240288288,
        "bitCount": 24,
        "fields": [
            {
                "name": "Zn",
                "lsb": 6,
                "width": 4
            },
            {
                "name": "U",
                "lsb": 5,
                "width": 1
            },
            {
                "name": "Zd",
                "lsb": 1,
                "width": 4
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
        "operandFamilyId": "sme-int-float-convert"
    }
];

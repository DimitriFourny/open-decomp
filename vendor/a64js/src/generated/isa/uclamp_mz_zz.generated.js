export const ENCODINGS = [
    {
        "instructionId": "uclamp_mz_zz",
        "encodingId": "uclamp_mz_zz_4",
        "mnemonic": "UCLAMP",
        "className": "Four registers",
        "fileName": "uclamp_mz_zz.xml",
        "mask": 4280351747,
        "value": 3240152065,
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
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zd",
                "lsb": 2,
                "width": 3
            },
            {
                "name": "U",
                "lsb": 0,
                "width": 1
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
        "operandFamilyId": "sme-multi-vector-clamp"
    },
    {
        "instructionId": "uclamp_mz_zz",
        "encodingId": "uclamp_mz_zz_2",
        "mnemonic": "UCLAMP",
        "className": "Two registers",
        "fileName": "uclamp_mz_zz.xml",
        "mask": 4280351745,
        "value": 3240150017,
        "bitCount": 16,
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
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zd",
                "lsb": 1,
                "width": 4
            },
            {
                "name": "U",
                "lsb": 0,
                "width": 1
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
        "operandFamilyId": "sme-multi-vector-clamp"
    }
];

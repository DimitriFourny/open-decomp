export const ENCODINGS = [
    {
        "instructionId": "bfmin_mz_zzw",
        "encodingId": "bfmin_mz_zzw_4x4",
        "mnemonic": "BFMIN",
        "className": "Four registers",
        "fileName": "bfmin_mz_zzw.xml",
        "mask": 4293132259,
        "value": 3240147201,
        "bitCount": 26,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 18,
                "width": 3
            },
            {
                "name": "opc",
                "lsb": 5,
                "width": 2
            },
            {
                "name": "Zdn",
                "lsb": 2,
                "width": 3
            },
            {
                "name": "o2",
                "lsb": 0,
                "width": 1
            }
        ],
        "features": [
            "FEAT_SME2 && FEAT_SVE_B16B16"
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
                        "feature": "FEAT_SVE_B16B16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-arithmetic"
    },
    {
        "instructionId": "bfmin_mz_zzw",
        "encodingId": "bfmin_mz_zzw_2x2",
        "mnemonic": "BFMIN",
        "className": "Two registers",
        "fileName": "bfmin_mz_zzw.xml",
        "mask": 4293001185,
        "value": 3240145153,
        "bitCount": 24,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 17,
                "width": 4
            },
            {
                "name": "opc",
                "lsb": 5,
                "width": 2
            },
            {
                "name": "Zdn",
                "lsb": 1,
                "width": 4
            },
            {
                "name": "o2",
                "lsb": 0,
                "width": 1
            }
        ],
        "features": [
            "FEAT_SME2 && FEAT_SVE_B16B16"
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
                        "feature": "FEAT_SVE_B16B16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-arithmetic"
    }
];

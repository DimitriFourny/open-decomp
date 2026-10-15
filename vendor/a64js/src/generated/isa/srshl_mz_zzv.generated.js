export const ENCODINGS = [
    {
        "instructionId": "srshl_mz_zzv",
        "encodingId": "srshl_mz_zzv_4x1",
        "mnemonic": "SRSHL",
        "className": "Four registers",
        "fileName": "srshl_mz_zzv.xml",
        "mask": 4281401315,
        "value": 3240143392,
        "bitCount": 23,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "opc",
                "lsb": 5,
                "width": 3
            },
            {
                "name": "Zdn",
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
        "operandFamilyId": "sme-arithmetic"
    },
    {
        "instructionId": "srshl_mz_zzv",
        "encodingId": "srshl_mz_zzv_2x1",
        "mnemonic": "SRSHL",
        "className": "Two registers",
        "fileName": "srshl_mz_zzv.xml",
        "mask": 4281401313,
        "value": 3240141344,
        "bitCount": 22,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "opc",
                "lsb": 5,
                "width": 3
            },
            {
                "name": "Zdn",
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
        "operandFamilyId": "sme-arithmetic"
    }
];

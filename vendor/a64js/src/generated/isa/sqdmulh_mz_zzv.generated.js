export const ENCODINGS = [
    {
        "instructionId": "sqdmulh_mz_zzv",
        "encodingId": "sqdmulh_mz_zzv_4x1",
        "mnemonic": "SQDMULH",
        "className": "Four registers",
        "fileName": "sqdmulh_mz_zzv.xml",
        "mask": 4281401315,
        "value": 3240143872,
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
                "name": "Zdn",
                "lsb": 2,
                "width": 3
            },
            {
                "name": "op",
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
        "instructionId": "sqdmulh_mz_zzv",
        "encodingId": "sqdmulh_mz_zzv_2x1",
        "mnemonic": "SQDMULH",
        "className": "Two registers",
        "fileName": "sqdmulh_mz_zzv.xml",
        "mask": 4281401313,
        "value": 3240141824,
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
                "name": "Zdn",
                "lsb": 1,
                "width": 4
            },
            {
                "name": "op",
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

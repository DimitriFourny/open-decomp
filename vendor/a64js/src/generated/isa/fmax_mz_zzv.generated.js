export const ENCODINGS = [
    {
        "instructionId": "fmax_mz_zzv",
        "encodingId": "fmax_mz_zzv_4x1",
        "mnemonic": "FMAX",
        "className": "Four registers",
        "fileName": "fmax_mz_zzv.xml",
        "mask": 4281401315,
        "value": 3240143104,
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
                "name": "op",
                "lsb": 5,
                "width": 1
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
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-arithmetic"
    },
    {
        "instructionId": "fmax_mz_zzv",
        "encodingId": "fmax_mz_zzv_2x1",
        "mnemonic": "FMAX",
        "className": "Two registers",
        "fileName": "fmax_mz_zzv.xml",
        "mask": 4281401313,
        "value": 3240141056,
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
                "name": "op",
                "lsb": 5,
                "width": 1
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
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-arithmetic"
    }
];

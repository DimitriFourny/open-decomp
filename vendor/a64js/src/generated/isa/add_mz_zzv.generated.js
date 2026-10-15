export const ENCODINGS = [
    {
        "instructionId": "add_mz_zzv",
        "encodingId": "add_mz_zzv_4x1",
        "mnemonic": "ADD",
        "className": "Four registers",
        "fileName": "add_mz_zzv.xml",
        "mask": 4281401315,
        "value": 3240143616,
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
        "operandFamilyId": "sme-multi-vector-arithmetic"
    },
    {
        "instructionId": "add_mz_zzv",
        "encodingId": "add_mz_zzv_2x1",
        "mnemonic": "ADD",
        "className": "Two registers",
        "fileName": "add_mz_zzv.xml",
        "mask": 4281401313,
        "value": 3240141568,
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
        "operandFamilyId": "sme-multi-vector-arithmetic"
    }
];

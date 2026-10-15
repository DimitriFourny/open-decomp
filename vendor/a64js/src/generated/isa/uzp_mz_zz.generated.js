export const ENCODINGS = [
    {
        "instructionId": "uzp_mz_zz",
        "encodingId": "uzp_mz_zz_2q",
        "mnemonic": "UZP",
        "className": "128-bit element",
        "fileName": "uzp_mz_zz.xml",
        "mask": 4292934657,
        "value": 3240154113,
        "bitCount": 18,
        "fields": [
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
        "guardDiagnostics": [
            "MaxImplementedSVL() < 256: maximum streaming vector length is not configured; assumes the instruction is admitted by the implementation"
        ],
        "operandFamilyId": "sme-permutation"
    },
    {
        "instructionId": "uzp_mz_zz",
        "encodingId": "uzp_mz_zz_2",
        "mnemonic": "UZP",
        "className": "8-bit to 64-bit elements",
        "fileName": "uzp_mz_zz.xml",
        "mask": 4280351745,
        "value": 3240153089,
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
        "operandFamilyId": "sme-permutation"
    }
];

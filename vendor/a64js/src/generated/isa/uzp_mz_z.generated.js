export const ENCODINGS = [
    {
        "instructionId": "uzp_mz_z",
        "encodingId": "uzp_mz_z_4q",
        "mnemonic": "UZP",
        "className": "128-bit element",
        "fileName": "uzp_mz_z.xml",
        "mask": 4294966371,
        "value": 3241664514,
        "bitCount": 26,
        "fields": [
            {
                "name": "Zn",
                "lsb": 7,
                "width": 3
            },
            {
                "name": "Zd",
                "lsb": 2,
                "width": 3
            },
            {
                "name": "op",
                "lsb": 1,
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
            "MaxImplementedSVL() < 512: maximum streaming vector length is not configured; assumes the instruction is admitted by the implementation"
        ],
        "operandFamilyId": "sme-vector-group-permutation"
    },
    {
        "instructionId": "uzp_mz_z",
        "encodingId": "uzp_mz_z_4",
        "mnemonic": "UZP",
        "className": "8-bit to 64-bit elements",
        "fileName": "uzp_mz_z.xml",
        "mask": 4282383459,
        "value": 3241598978,
        "bitCount": 24,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 7,
                "width": 3
            },
            {
                "name": "Zd",
                "lsb": 2,
                "width": 3
            },
            {
                "name": "op",
                "lsb": 1,
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
        "operandFamilyId": "sme-vector-group-permutation"
    }
];

export const ENCODINGS = [
    {
        "instructionId": "f1cvtl_mz2_z8",
        "encodingId": "f1cvtl_mz2_z8_",
        "mnemonic": "F1CVTL",
        "className": "F1CVTL",
        "fileName": "f1cvtl_mz2_z8.xml",
        "mask": 4294966273,
        "value": 3240550401,
        "bitCount": 23,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
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
                "name": "L",
                "lsb": 0,
                "width": 1
            }
        ],
        "features": [
            "FEAT_SME2 && FEAT_FP8"
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
                        "feature": "FEAT_FP8",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-fp8-widening-convert"
    },
    {
        "instructionId": "f1cvtl_mz2_z8",
        "encodingId": "f2cvtl_mz2_z8_",
        "mnemonic": "F2CVTL",
        "className": "F2CVTL",
        "fileName": "f1cvtl_mz2_z8.xml",
        "mask": 4294966273,
        "value": 3248939009,
        "bitCount": 23,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
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
                "name": "L",
                "lsb": 0,
                "width": 1
            }
        ],
        "features": [
            "FEAT_SME2 && FEAT_FP8"
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
                        "feature": "FEAT_FP8",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-fp8-widening-convert"
    }
];

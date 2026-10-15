export const ENCODINGS = [
    {
        "instructionId": "f1cvt_mz2_z8",
        "encodingId": "f1cvt_mz2_z8_",
        "mnemonic": "F1CVT",
        "className": "F1CVT",
        "fileName": "f1cvt_mz2_z8.xml",
        "mask": 4294966273,
        "value": 3240550400,
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
        "instructionId": "f1cvt_mz2_z8",
        "encodingId": "f2cvt_mz2_z8_",
        "mnemonic": "F2CVT",
        "className": "F2CVT",
        "fileName": "f1cvt_mz2_z8.xml",
        "mask": 4294966273,
        "value": 3248939008,
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

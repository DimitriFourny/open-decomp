export const ENCODINGS = [
    {
        "instructionId": "bf1cvt_mz2_z8",
        "encodingId": "bf1cvt_mz2_z8_",
        "mnemonic": "BF1CVT",
        "className": "BF1CVT",
        "fileName": "bf1cvt_mz2_z8.xml",
        "mask": 4294966273,
        "value": 3244744704,
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
        "instructionId": "bf1cvt_mz2_z8",
        "encodingId": "bf2cvt_mz2_z8_",
        "mnemonic": "BF2CVT",
        "className": "BF2CVT",
        "fileName": "bf1cvt_mz2_z8.xml",
        "mask": 4294966273,
        "value": 3253133312,
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

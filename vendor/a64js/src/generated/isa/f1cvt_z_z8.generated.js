export const ENCODINGS = [
    {
        "instructionId": "f1cvt_z_z8",
        "encodingId": "f1cvt_z_z8_b2h",
        "mnemonic": "F1CVT",
        "className": "F1CVT",
        "fileName": "f1cvt_z_z8.xml",
        "mask": 4294966272,
        "value": 1695035392,
        "bitCount": 22,
        "fields": [
            {
                "name": "L",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "opc",
                "lsb": 10,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "(FEAT_SVE2 || FEAT_SME2) && FEAT_FP8"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2",
                        "implemented": false
                    },
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
        "operandFamilyId": "sve-fp8-convert"
    },
    {
        "instructionId": "f1cvt_z_z8",
        "encodingId": "f2cvt_z_z8_b2h",
        "mnemonic": "F2CVT",
        "className": "F2CVT",
        "fileName": "f1cvt_z_z8.xml",
        "mask": 4294966272,
        "value": 1695036416,
        "bitCount": 22,
        "fields": [
            {
                "name": "L",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "opc",
                "lsb": 10,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "(FEAT_SVE2 || FEAT_SME2) && FEAT_FP8"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2",
                        "implemented": false
                    },
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
        "operandFamilyId": "sve-fp8-convert"
    }
];

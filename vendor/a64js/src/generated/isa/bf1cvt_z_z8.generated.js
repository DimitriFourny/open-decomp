export const ENCODINGS = [
    {
        "instructionId": "bf1cvt_z_z8",
        "encodingId": "bf1cvt_z_z8_b2bf",
        "mnemonic": "BF1CVT",
        "className": "BF1CVT",
        "fileName": "bf1cvt_z_z8.xml",
        "mask": 4294966272,
        "value": 1695037440,
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
        "instructionId": "bf1cvt_z_z8",
        "encodingId": "bf2cvt_z_z8_b2bf",
        "mnemonic": "BF2CVT",
        "className": "BF2CVT",
        "fileName": "bf1cvt_z_z8.xml",
        "mask": 4294966272,
        "value": 1695038464,
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

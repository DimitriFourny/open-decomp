export const ENCODINGS = [
    {
        "instructionId": "bf1cvtlt_z_z8",
        "encodingId": "bf1cvtlt_z_z8_b2bf",
        "mnemonic": "BF1CVTLT",
        "className": "BF1CVTLT",
        "fileName": "bf1cvtlt_z_z8.xml",
        "mask": 4294966272,
        "value": 1695102976,
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
        "instructionId": "bf1cvtlt_z_z8",
        "encodingId": "bf2cvtlt_z_z8_b2bf",
        "mnemonic": "BF2CVTLT",
        "className": "BF2CVTLT",
        "fileName": "bf1cvtlt_z_z8.xml",
        "mask": 4294966272,
        "value": 1695104000,
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

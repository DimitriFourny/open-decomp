export const ENCODINGS = [
    {
        "instructionId": "sqrshrun_z_mz2",
        "encodingId": "sqrshrun_z_mz2_b",
        "mnemonic": "SQRSHRUN",
        "className": "8-bit",
        "fileName": "sqrshrun_z_mz2.xml",
        "mask": 4294507552,
        "value": 1168640000,
        "bitCount": 20,
        "fields": [
            {
                "name": "op0",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "imm3",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "op1",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "U",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "R",
                "lsb": 11,
                "width": 1
            },
            {
                "name": "Zn",
                "lsb": 6,
                "width": 4
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE2p3 || FEAT_SME2p3"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p3",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p3",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-two-vector-narrowing-shift"
    },
    {
        "instructionId": "sqrshrun_z_mz2",
        "encodingId": "sqrshrun_z_mz2_",
        "mnemonic": "SQRSHRUN",
        "className": "16-bit",
        "fileName": "sqrshrun_z_mz2.xml",
        "mask": 4293983264,
        "value": 1169164288,
        "bitCount": 19,
        "fields": [
            {
                "name": "op0",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "imm4",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "op1",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "U",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "R",
                "lsb": 11,
                "width": 1
            },
            {
                "name": "Zn",
                "lsb": 6,
                "width": 4
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SME2 || FEAT_SVE2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-two-vector-narrowing-shift"
    }
];

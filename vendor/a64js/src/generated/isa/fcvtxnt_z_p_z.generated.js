export const ENCODINGS = [
    {
        "instructionId": "fcvtxnt_z_p_z",
        "encodingId": "fcvtxnt_z_p_z_d2s",
        "mnemonic": "FCVTXNT",
        "className": "Double-precision to single-precision, merging",
        "fileName": "fcvtxnt_z_p_z.xml",
        "mask": 4294959104,
        "value": 1678417920,
        "bitCount": 19,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "opc2",
                "lsb": 16,
                "width": 2
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
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
            "FEAT_SVE2 || FEAT_SME"
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
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-predicated-narrowing-conversion"
    },
    {
        "instructionId": "fcvtxnt_z_p_z",
        "encodingId": "fcvtxnt_z_p_z_d2sz",
        "mnemonic": "FCVTXNT",
        "className": "Double-precision to single-precision, zeroing",
        "fileName": "fcvtxnt_z_p_z.xml",
        "mask": 4294959104,
        "value": 1677893632,
        "bitCount": 19,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "opc2",
                "lsb": 16,
                "width": 2
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
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
            "FEAT_SVE2p2 || FEAT_SME2p2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-predicated-narrowing-conversion"
    }
];

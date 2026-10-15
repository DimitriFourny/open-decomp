export const ENCODINGS = [
    {
        "instructionId": "compact_z_p_z",
        "encodingId": "compact_z_p_z_",
        "mnemonic": "COMPACT",
        "className": "Word and doubleword",
        "fileName": "compact_z_p_z.xml",
        "mask": 4290764800,
        "value": 94470144,
        "bitCount": 18,
        "fields": [
            {
                "name": "sz",
                "lsb": 22,
                "width": 1
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
            "FEAT_SVE || FEAT_SME2p2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
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
        "operandFamilyId": "sve-compact"
    },
    {
        "instructionId": "compact_z_p_z",
        "encodingId": "compact_z_p_z_s",
        "mnemonic": "COMPACT",
        "className": "Byte and halfword",
        "fileName": "compact_z_p_z.xml",
        "mask": 4290764800,
        "value": 86081536,
        "bitCount": 18,
        "fields": [
            {
                "name": "sz",
                "lsb": 22,
                "width": 1
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
        "operandFamilyId": "sve-compact"
    }
];

export const ENCODINGS = [
    {
        "instructionId": "pmov_z_pi",
        "encodingId": "pmov_z_pi_b",
        "mnemonic": "PMOV",
        "className": "Byte",
        "fileName": "pmov_z_pi.xml",
        "mask": 4294966784,
        "value": 86718464,
        "bitCount": 23,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "opc2",
                "lsb": 17,
                "width": 2
            },
            {
                "name": "Pn",
                "lsb": 5,
                "width": 4
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE2p1 || FEAT_SME2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p1",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-pmov-vector"
    },
    {
        "instructionId": "pmov_z_pi",
        "encodingId": "pmov_z_pi_h",
        "mnemonic": "PMOV",
        "className": "Halfword",
        "fileName": "pmov_z_pi.xml",
        "mask": 4294835712,
        "value": 86849536,
        "bitCount": 22,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "i1",
                "lsb": 17,
                "width": 1
            },
            {
                "name": "Pn",
                "lsb": 5,
                "width": 4
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE2p1 || FEAT_SME2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p1",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-pmov-vector"
    },
    {
        "instructionId": "pmov_z_pi",
        "encodingId": "pmov_z_pi_s",
        "mnemonic": "PMOV",
        "className": "Word",
        "fileName": "pmov_z_pi.xml",
        "mask": 4294573568,
        "value": 90781696,
        "bitCount": 21,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "i2",
                "lsb": 17,
                "width": 2
            },
            {
                "name": "Pn",
                "lsb": 5,
                "width": 4
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE2p1 || FEAT_SME2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p1",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-pmov-vector"
    },
    {
        "instructionId": "pmov_z_pi",
        "encodingId": "pmov_z_pi_d",
        "mnemonic": "PMOV",
        "className": "Doubleword",
        "fileName": "pmov_z_pi.xml",
        "mask": 4290379264,
        "value": 94976000,
        "bitCount": 20,
        "fields": [
            {
                "name": "i3h",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "i3l",
                "lsb": 17,
                "width": 2
            },
            {
                "name": "Pn",
                "lsb": 5,
                "width": 4
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE2p1 || FEAT_SME2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p1",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-pmov-vector"
    }
];

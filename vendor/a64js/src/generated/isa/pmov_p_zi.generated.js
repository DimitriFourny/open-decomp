export const ENCODINGS = [
    {
        "instructionId": "pmov_p_zi",
        "encodingId": "pmov_p_zi_b",
        "mnemonic": "PMOV",
        "className": "Byte",
        "fileName": "pmov_p_zi.xml",
        "mask": 4294966288,
        "value": 86652928,
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
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Pd",
                "lsb": 0,
                "width": 4
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
        "operandFamilyId": "sve-pmov-predicate"
    },
    {
        "instructionId": "pmov_p_zi",
        "encodingId": "pmov_p_zi_h",
        "mnemonic": "PMOV",
        "className": "Halfword",
        "fileName": "pmov_p_zi.xml",
        "mask": 4294835216,
        "value": 86784000,
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
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Pd",
                "lsb": 0,
                "width": 4
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
        "operandFamilyId": "sve-pmov-predicate"
    },
    {
        "instructionId": "pmov_p_zi",
        "encodingId": "pmov_p_zi_s",
        "mnemonic": "PMOV",
        "className": "Word",
        "fileName": "pmov_p_zi.xml",
        "mask": 4294573072,
        "value": 90716160,
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
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Pd",
                "lsb": 0,
                "width": 4
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
        "operandFamilyId": "sve-pmov-predicate"
    },
    {
        "instructionId": "pmov_p_zi",
        "encodingId": "pmov_p_zi_d",
        "mnemonic": "PMOV",
        "className": "Doubleword",
        "fileName": "pmov_p_zi.xml",
        "mask": 4290378768,
        "value": 94910464,
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
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Pd",
                "lsb": 0,
                "width": 4
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
        "operandFamilyId": "sve-pmov-predicate"
    }
];

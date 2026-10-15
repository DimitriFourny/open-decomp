export const ENCODINGS = [
    {
        "instructionId": "STGP",
        "encodingId": "STGP_64_ldstpair_off",
        "mnemonic": "STGP",
        "className": "Signed offset",
        "fileName": "stgp.xml",
        "mask": 4290772992,
        "value": 1761607680,
        "bitCount": 10,
        "fields": [
            {
                "name": "opc",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "simm7",
                "lsb": 15,
                "width": 7
            },
            {
                "name": "Rt2",
                "lsb": 10,
                "width": 5
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_MTE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_MTE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "mte-tag-pair-store"
    },
    {
        "instructionId": "STGP",
        "encodingId": "STGP_64_ldstpair_post",
        "mnemonic": "STGP",
        "className": "Post-index",
        "fileName": "stgp.xml",
        "mask": 4290772992,
        "value": 1753219072,
        "bitCount": 10,
        "fields": [
            {
                "name": "opc",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "simm7",
                "lsb": 15,
                "width": 7
            },
            {
                "name": "Rt2",
                "lsb": 10,
                "width": 5
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_MTE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_MTE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "mte-tag-pair-store"
    },
    {
        "instructionId": "STGP",
        "encodingId": "STGP_64_ldstpair_pre",
        "mnemonic": "STGP",
        "className": "Pre-index",
        "fileName": "stgp.xml",
        "mask": 4290772992,
        "value": 1769996288,
        "bitCount": 10,
        "fields": [
            {
                "name": "opc",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "simm7",
                "lsb": 15,
                "width": 7
            },
            {
                "name": "Rt2",
                "lsb": 10,
                "width": 5
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_MTE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_MTE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "mte-tag-pair-store"
    }
];

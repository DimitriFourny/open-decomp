export const ENCODINGS = [
    {
        "instructionId": "sqdmulh_z_zzi",
        "encodingId": "sqdmulh_z_zzi_d",
        "mnemonic": "SQDMULH",
        "className": "64-bit",
        "fileName": "sqdmulh_z_zzi.xml",
        "mask": 4292934656,
        "value": 1155592192,
        "bitCount": 17,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "i1",
                "lsb": 20,
                "width": 1
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "R",
                "lsb": 10,
                "width": 1
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
        "operandFamilyId": "sve-binary-indexed"
    },
    {
        "instructionId": "sqdmulh_z_zzi",
        "encodingId": "sqdmulh_z_zzi_s",
        "mnemonic": "SQDMULH",
        "className": "32-bit",
        "fileName": "sqdmulh_z_zzi.xml",
        "mask": 4292934656,
        "value": 1151397888,
        "bitCount": 17,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "i2",
                "lsb": 19,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "R",
                "lsb": 10,
                "width": 1
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
        "operandFamilyId": "sve-binary-indexed"
    },
    {
        "instructionId": "sqdmulh_z_zzi",
        "encodingId": "sqdmulh_z_zzi_h",
        "mnemonic": "SQDMULH",
        "className": "16-bit",
        "fileName": "sqdmulh_z_zzi.xml",
        "mask": 4288740352,
        "value": 1143009280,
        "bitCount": 16,
        "fields": [
            {
                "name": "i3h",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "i3l",
                "lsb": 19,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "R",
                "lsb": 10,
                "width": 1
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
        "operandFamilyId": "sve-binary-indexed"
    }
];

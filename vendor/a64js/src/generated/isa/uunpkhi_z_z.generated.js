export const ENCODINGS = [
    {
        "instructionId": "uunpkhi_z_z",
        "encodingId": "uunpkhi_z_z_",
        "mnemonic": "UUNPKHI",
        "className": "High half",
        "fileName": "uunpkhi_z_z.xml",
        "mask": 4282383360,
        "value": 87242752,
        "bitCount": 20,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "U",
                "lsb": 17,
                "width": 1
            },
            {
                "name": "H",
                "lsb": 16,
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
            "FEAT_SVE || FEAT_SME"
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
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "fexpa-z-z"
    },
    {
        "instructionId": "uunpkhi_z_z",
        "encodingId": "uunpklo_z_z_",
        "mnemonic": "UUNPKLO",
        "className": "Low half",
        "fileName": "uunpkhi_z_z.xml",
        "mask": 4282383360,
        "value": 87177216,
        "bitCount": 20,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "U",
                "lsb": 17,
                "width": 1
            },
            {
                "name": "H",
                "lsb": 16,
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
            "FEAT_SVE || FEAT_SME"
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
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "fexpa-z-z"
    }
];

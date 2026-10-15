export const ENCODINGS = [
    {
        "instructionId": "addha_za_pp_z",
        "encodingId": "addha_za_pp_z_32",
        "mnemonic": "ADDHA",
        "className": "32-bit",
        "fileName": "addha_za_pp_z.xml",
        "mask": 4294901788,
        "value": 3230662656,
        "bitCount": 19,
        "fields": [
            {
                "name": "op",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "V",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "Pm",
                "lsb": 13,
                "width": 3
            },
            {
                "name": "Pn",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "ZAda",
                "lsb": 0,
                "width": 2
            }
        ],
        "features": [
            "FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-slice-accumulator"
    },
    {
        "instructionId": "addha_za_pp_z",
        "encodingId": "addha_za_pp_z_64",
        "mnemonic": "ADDHA",
        "className": "64-bit",
        "fileName": "addha_za_pp_z.xml",
        "mask": 4294901784,
        "value": 3234856960,
        "bitCount": 18,
        "fields": [
            {
                "name": "op",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "V",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "Pm",
                "lsb": 13,
                "width": 3
            },
            {
                "name": "Pn",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "ZAda",
                "lsb": 0,
                "width": 3
            }
        ],
        "features": [
            "FEAT_SME_I16I64"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_I16I64",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-slice-accumulator"
    }
];

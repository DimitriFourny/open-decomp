export const ENCODINGS = [
    {
        "instructionId": "smops_za_pp_zz",
        "encodingId": "smops_za_pp_zz_32",
        "mnemonic": "SMOPS",
        "className": "32-bit",
        "fileName": "smops_za_pp_zz.xml",
        "mask": 4292870172,
        "value": 2692743184,
        "bitCount": 14,
        "fields": [
            {
                "name": "u0",
                "lsb": 24,
                "width": 1
            },
            {
                "name": "u1",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
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
                "name": "S",
                "lsb": 4,
                "width": 1
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
        "operandFamilyId": "sme-outer-product"
    },
    {
        "instructionId": "smops_za_pp_zz",
        "encodingId": "smops_za_pp_zz_64",
        "mnemonic": "SMOPS",
        "className": "64-bit",
        "fileName": "smops_za_pp_zz.xml",
        "mask": 4292870168,
        "value": 2696937488,
        "bitCount": 13,
        "fields": [
            {
                "name": "u0",
                "lsb": 24,
                "width": 1
            },
            {
                "name": "u1",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
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
                "name": "S",
                "lsb": 4,
                "width": 1
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
        "operandFamilyId": "sme-outer-product"
    }
];

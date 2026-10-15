export const ENCODINGS = [
    {
        "instructionId": "umops_za_pp_zz",
        "encodingId": "umops_za_pp_zz_32",
        "mnemonic": "UMOPS",
        "className": "32-bit",
        "fileName": "umops_za_pp_zz.xml",
        "mask": 4292870172,
        "value": 2711617552,
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
        "instructionId": "umops_za_pp_zz",
        "encodingId": "umops_za_pp_zz_64",
        "mnemonic": "UMOPS",
        "className": "64-bit",
        "fileName": "umops_za_pp_zz.xml",
        "mask": 4292870168,
        "value": 2715811856,
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

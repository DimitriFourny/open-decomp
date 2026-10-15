export const ENCODINGS = [
    {
        "instructionId": "addva_za_pp_z",
        "encodingId": "addva_za_pp_z_32",
        "mnemonic": "ADDVA",
        "className": "32-bit",
        "fileName": "addva_za_pp_z.xml",
        "mask": 4294901788,
        "value": 3230728192,
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
        "instructionId": "addva_za_pp_z",
        "encodingId": "addva_za_pp_z_64",
        "mnemonic": "ADDVA",
        "className": "64-bit",
        "fileName": "addva_za_pp_z.xml",
        "mask": 4294901784,
        "value": 3234922496,
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
